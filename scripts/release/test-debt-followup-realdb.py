"""P3 transaction checks on an owned, network-isolated PostgreSQL container.

Loads the four existing table definitions byte-for-byte from the committed live schema;
their PK constraints are also read from that schema. Never connects to a host database.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import re
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
NAME = 'vaydu-p3-test-' + uuid.uuid4().hex[:10]
owned = False


def docker(*args, sql=None, check=True):
    p = subprocess.run(['docker', *args], input=sql, text=True, capture_output=True)
    if check and p.returncode:
        raise RuntimeError(p.stderr or p.stdout or f'Docker exited {p.returncode}')
    return p


def query(sql, check=True):
    return docker('exec', '-i', NAME, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
                  '-v', 'ON_ERROR_STOP=1', '-qAt', sql=sql, check=check)


def passed(name):
    print('PASS: ' + name, flush=True)


try:
    docker('run', '-d', '--name', NAME, '--network', 'none',
           '-e', 'POSTGRES_PASSWORD=disposable-p3-test', 'postgres:16.15')
    owned = True
    for _ in range(100):
        if query('select 1', check=False).returncode == 0:
            break
        time.sleep(0.2)
    else:
        raise RuntimeError('Disposable PostgreSQL did not become ready')
    baseline = (ROOT / 'supabase/baseline/develop_live_public_schema_20261112.sql').read_bytes().decode()
    fixture = 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;\n'
    for name in ['customer_receivables', 'notifications', 'audit_logs']:
        match = re.search(r'CREATE TABLE public\.' + name + r' \(.*?\n\);', baseline, re.S)
        assert match, name
        fixture += match.group() + '\n'
        match = re.search(r'ALTER TABLE ONLY public\.' + name + r'\s+ADD CONSTRAINT \w+ PRIMARY KEY \(id\);', baseline)
        assert match, name + ' primary key'
        fixture += match.group() + '\n'
    query(fixture)
    query((ROOT / 'supabase/migrations/20261270300000_overdue_debt_followup.sql').read_text())
    query("""
    INSERT INTO debt_followup_scopes VALUES
      ('00000000-0000-4000-8000-000000000001','GB','GBP',true),
      ('00000000-0000-4000-8000-000000000002','GB','GBP',false);
    BEGIN;
    INSERT INTO customer_receivables(id,tenant_id,customer_id,currency_code,market_code,amount_minor,reason,status,created_at,review_required)
    SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      CASE WHEN n=8 THEN '00000000-0000-4000-8000-000000000002' ELSE '00000000-0000-4000-8000-000000000001' END::uuid,
      '00000000-0000-4000-8000-000000000003'::uuid,
      CASE WHEN n=7 THEN 'USD' ELSE 'GBP' END,
      CASE WHEN n=6 THEN 'NG' WHEN n=9 THEN NULL ELSE 'GB' END,
      300,'cancellation_fee',CASE WHEN n=4 THEN 'disputed' WHEN n=5 THEN 'paid' ELSE 'open' END,
      now()-CASE WHEN n=1 THEN interval '23 hours 59 minutes' WHEN n=2 THEN interval '24 hours'
        WHEN n IN(3,4,5) THEN interval '30 days' ELSE interval '2 days' END,n=10
    FROM generate_series(1,10) n;
    CREATE TEMP TABLE financial_before AS SELECT id,to_jsonb(r)-'review_required' AS row FROM customer_receivables r;
    DO $$ DECLARE result jsonb; BEGIN
      result:=process_overdue_customer_debts();
      IF result<> '{"reminders":3,"reviews":2}'::jsonb THEN RAISE EXCEPTION 'wrong first batch %',result; END IF;
      IF (SELECT count(*) FROM notifications)<>3 THEN RAISE EXCEPTION 'wrong inbox count'; END IF;
      IF (SELECT count(*) FROM customer_debt_followups WHERE action='review_30d')<>2 THEN RAISE EXCEPTION 'wrong review count'; END IF;
      IF EXISTS(SELECT 1 FROM notifications WHERE user_id<>'00000000-0000-4000-8000-000000000003'
        OR route<>'/customer/wallet' OR body NOT LIKE '%No interest or late fee%') THEN RAISE EXCEPTION 'wrong recipient/terms'; END IF;
      IF EXISTS(SELECT 1 FROM customer_debt_followups WHERE receivable_id::text IN
        ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000005',
         '10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000007',
         '10000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000009')) THEN RAISE EXCEPTION 'scope/age/status leak'; END IF;
      IF EXISTS(SELECT 1 FROM customer_debt_followups WHERE receivable_id='10000000-0000-4000-8000-000000000004' AND action='reminder_24h') THEN RAISE EXCEPTION 'chased disputed debt'; END IF;
      IF (SELECT count(*) FROM customer_receivables WHERE review_required)<>3 THEN RAISE EXCEPTION 'review flag lost'; END IF;
      IF EXISTS(SELECT 1 FROM customer_receivables r JOIN financial_before b USING(id)
        WHERE to_jsonb(r)-'review_required'<>b.row) THEN RAISE EXCEPTION 'financial data changed'; END IF;
      IF process_overdue_customer_debts()<>'{"reminders":0,"reviews":0}'::jsonb THEN RAISE EXCEPTION 'retry duplicated actions'; END IF;
    END $$;
    COMMIT;
    """)
    passed('24-hour/30-day boundaries, dispute/paid exclusions, tenant/market/currency scopes, deduplication and unchanged financial data')
    query("""
    INSERT INTO customer_receivables(id,tenant_id,customer_id,currency_code,market_code,amount_minor,reason,created_at)
      VALUES('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000003','GBP','GB',300,'cancellation_fee',now()-interval '2 days');
    CREATE FUNCTION reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected inbox failure'; END $$;
    CREATE TRIGGER reject_notification BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION reject_notification();
    DO $$ BEGIN
      BEGIN PERFORM process_overdue_customer_debts(); RAISE EXCEPTION 'failure not raised';
      EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'injected inbox failure' THEN RAISE; END IF; END;
      IF EXISTS(SELECT 1 FROM customer_debt_followups WHERE receivable_id='20000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'action survived failed inbox transaction'; END IF;
    END $$;
    DROP TRIGGER reject_notification ON notifications;
    DO $$ BEGIN IF process_overdue_customer_debts()<>'{"reminders":1,"reviews":0}'::jsonb THEN RAISE EXCEPTION 'retry lost reminder'; END IF; END $$;
    """)
    passed('inbox failure rolls back deduplication atomically; retry delivers exactly once')
    query("""
    INSERT INTO customer_receivables(id,tenant_id,customer_id,currency_code,market_code,amount_minor,reason,created_at)
    SELECT ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000003','GBP','GB',300,'cancellation_fee',now()-interval '2 days'
    FROM generate_series(1,20) n;
    """)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: json.loads(query('select process_overdue_customer_debts(7)').stdout), range(4)))
    assert sum(r['reminders'] for r in results) == 20, results
    assert query("select count(*) from customer_debt_followups where receivable_id::text like '30000000-%'").stdout.strip() == '20'
    assert query("select count(*) from notifications where metadata->>'receivable_id' like '30000000-%'").stdout.strip() == '20'
    passed('four concurrent workers, 20 debts: exactly 20 durable reminders and 20 deduplication rows')
    for role in ['anon', 'authenticated']:
        assert query(f'SET ROLE {role}; SELECT process_overdue_customer_debts()', check=False).returncode != 0
        assert query(f'SET ROLE {role}; SELECT * FROM customer_debt_followups', check=False).returncode != 0
    assert query('SET ROLE service_role; SELECT process_overdue_customer_debts()').returncode == 0
    for limit in ['NULL', '0', '1001']:
        assert query(f'SELECT process_overdue_customer_debts({limit})', check=False).returncode != 0
    assert query("INSERT INTO debt_followup_scopes VALUES('00000000-0000-4000-8000-000000000004','NG','NGN',true)", check=False).returncode != 0
    passed('public roles cannot read/call; service_role can call; invalid batches and non-GB scopes rejected')
    print('P3_REALDB_OK', flush=True)
finally:
    if owned:
        docker('rm', '-f', NAME, check=False)
