"""Synthetic, network-isolated PostgreSQL checks; no credentials or provider calls."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import time
import uuid

ROOT=Path(__file__).resolve().parent.parent
NAME='vaydu-payout-test-'+uuid.uuid4().hex[:8]
def docker(*args,stdin=None):
    p=subprocess.run(['docker',*args],input=stdin,text=True,capture_output=True,timeout=90)
    if p.returncode: raise RuntimeError(p.stderr)
    return p.stdout.strip()
def sql(text):
    return docker('exec','-i',NAME,'psql','-U','postgres','-d','movabi_develop','-X','-qAt','-v','ON_ERROR_STOP=1',stdin=text)
def file(path):return sql((ROOT/path).read_text(encoding='utf-8'))
def main():
    try:
        docker('run','--detach','--rm','--network','none','--name',NAME,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=movabi_develop','postgres:15')
        for _ in range(40):
            try: sql('SELECT 1;');break
            except RuntimeError:time.sleep(.5)
        file('scripts/check-driver-payment-account-fixture.sql')
        source=(ROOT/'supabase/migrations/20261241000000_driver_settlement_claim.sql').read_text(encoding='utf-8')
        sql(source[source.index('CREATE OR REPLACE FUNCTION public.record_job_settlement('):])
        file('supabase/migrations/20261242000000_completion_payout_outbox.sql')
        file('supabase/migrations/20261023230000_market_payment_routes.sql')
        sql("INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref) VALUES('GH','GHS','card','kora','deliberate-override');")
        file('supabase/migrations/20261253900000_flutterwave_market_provider_prerequisite.sql')
        file('supabase/migrations/20261254600000_driver_payment_accounts_sandbox.sql')
        file('supabase/migrations/20261254700000_flutterwave_payout_outbox.sql')
        file('scripts/check-driver-payment-account-assert.sql')
        claim="SELECT public.claim_flutterwave_job_submission(job_id,token,'vaydu-'||job_id||'_PMCK') FROM public.job_payout_queue;"
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(lambda _:sql(claim),range(2)))
        assert sorted(results)==['f','t'],results
        assert sql(claim)=='f'
        finish="SELECT public.finish_flutterwave_job_payout(job_id,token,'vaydu-'||job_id||'_PMCK','12',1.25) FROM public.job_payout_queue;"
        assert sql(finish)=='t'
        assert sql(finish)=='t' # duplicate callback is idempotent
        assert sql("SELECT count(*)||':'||min(status)||':'||min(payout_provider)||':'||min(payout_transfer_id)||':'||count(stripe_transfer_id) FROM public.driver_earnings;")=='1:paid:flutterwave:12:0'
        assert sql("SELECT count(*) FROM public.claim_queued_job_payout('44444444-4444-4444-8444-444444444444');")=='0'
        assert sql("SELECT has_table_privilege('authenticated','public.driver_payment_accounts','SELECT') OR has_table_privilege('anon','public.flutterwave_job_submissions','SELECT');")=='f'
        sql("""DO $$ BEGIN
          BEGIN UPDATE public.job_payout_queue SET amount_minor=1;RAISE EXCEPTION 'Mutable terms accepted';
          EXCEPTION WHEN OTHERS THEN IF SQLERRM='Mutable terms accepted' THEN RAISE;END IF;END;
          BEGIN UPDATE public.driver_payment_accounts SET bank_code='999';RAISE EXCEPTION 'Mutable account accepted';
          EXCEPTION WHEN OTHERS THEN IF SQLERRM='Mutable account accepted' THEN RAISE;END IF;END;
        END $$;""")
        sql("""INSERT INTO public.profiles VALUES('66666666-6666-4666-8666-666666666666','22222222-2222-4222-8222-222222222222','driver','GB','GB',now());
          INSERT INTO public.jobs(id,driver_id,tenant_id,country_code,currency_code,status,payment_status,payment_method)
          VALUES('55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666','22222222-2222-4222-8222-222222222222','GB','GBP','in_progress','paid','card');
          SELECT id FROM public.complete_job_with_pending_payout('55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666',
          '{"total":105,"payout":100,"platformFee":5,"commission":0,"commissionRate":0,"amountMinor":10000,"currency":"GBP","country":"GB","destination":"acct_synthetic"}',
          '{"completion_pin_verified_at":"synthetic-only"}');
          SELECT job_id FROM public.claim_queued_job_payout('55555555-5555-4555-8555-555555555555');""")
        assert sql("SELECT public.finish_queued_job_payout(job_id,token,'tr_synthetic') FROM public.job_payout_queue WHERE currency='gbp';")=='t'
        assert sql("SELECT status||':'||stripe_transfer_id||':'||coalesce(payout_transfer_id,'none') FROM public.driver_earnings WHERE job_id='55555555-5555-4555-8555-555555555555';")=='paid:tr_synthetic:none'
        file('scripts/check-collection-subaccount-fixture.sql')
        file('supabase/migrations/20261254800000_flutterwave_collection_subaccounts.sql')
        file('supabase/migrations/20261254900000_flutterwave_booking_split_authority.sql')
        # Configure only synthetic NG scope, then race the immutable creation claim.
        setup_sql=(ROOT/'scripts/check-collection-subaccount-split.sql').read_text(encoding='utf-8')
        sql(setup_sql[:setup_sql.index('CREATE FUNCTION public.synthetic_split_plan')])
        creation="SELECT count(*) FROM public.claim_driver_collection_subaccount('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','synthetic-merchant',repeat('b',64),repeat('c',64),'bank','6789');"
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(lambda _:sql(creation),range(2)))
        assert sorted(results)==['0','1'],results
        sql("UPDATE public.driver_collection_subaccounts SET state='completed',subaccount_id='RS_SPLIT',provider_numeric_id='8',verification='retrieved';")
        file('scripts/check-collection-subaccount-split.sql')
        split_claim="SELECT public.claim_flutterwave_split_submission('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88888888-8888-4888-8888-888888888888');"
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(lambda _:sql(split_claim),range(2)))
        assert sorted(results)==['f','t'],results
        assert sql("SELECT public.confirm_flutterwave_split_collection('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88888888-8888-4888-8888-888888888888','77');")=='t'
        assert sql("SELECT status FROM public.driver_earnings WHERE job_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';")=='pending'
        evidence='{"batchId":"9","transactionId":"77","reference":"vaydu-split-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","subaccountId":"RS_SPLIT","driverMinor":880000}'
        finish_split="SELECT public.finish_flutterwave_split_settlement('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77','"+evidence+"'::jsonb);"
        assert sql(finish_split)=='t'
        assert sql(finish_split)=='t'
        assert sql("SELECT count(*)||':'||min(status)||':'||sum(amount) FROM public.driver_earnings WHERE job_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';")=='1:paid:8800.0000000000000000'
        assert sql("SELECT count(*) FROM public.job_payout_queue WHERE job_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';")=='0'
        assert sql("SELECT has_table_privilege('authenticated','public.driver_collection_subaccounts','SELECT');")=='f'
        print('PASS: collection setup claim concurrency, frozen fare, cancellation/refund/no-show guards, single split settlement and no transfer queue')
        print('PASS: actual outbox migration, defaults/override preservation, setup isolation, concurrent unique submission, immutable terms/destination, single earnings settlement, duplicate completion, private grants, unchanged Stripe SQL completion')
    finally:
        subprocess.run(['docker','rm','-f',NAME],capture_output=True,timeout=30)
if __name__=='__main__':main()
