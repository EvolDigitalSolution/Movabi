const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Client } = require(process.env.MOVABI_PG_MODULE || 'pg');

const TENANT   = 'd0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const DRIVER   = '33333333-3333-4333-8333-333333333333';
const ADMIN    = '99999999-9999-4999-8999-999999999999';
const JOB      = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const MARKET   = 'GB';

let db;
const q = (sql, args = []) => db.query(sql, args);
const row = async (sql, args = []) => (await q(sql, args)).rows[0];
const val = async (sql, args = []) => { const r = (await q(sql, args)).rows[0]; return r ? r[Object.keys(r)[0]] : undefined; };

async function reset() {
  await db.query('TRUNCATE cancellation_compensation_events, driver_earnings, customer_receivables, cancellation_policies, jobs CASCADE');
  await q("INSERT INTO market_availability(id,country_code,supported_currency,enabled) VALUES($1,'GB','GBP',true) ON CONFLICT (id) DO NOTHING", ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  // Publish the synthetic 80% / on_collection policy, then activate it.
  const p = await q("SELECT * FROM publish_cancellation_policy($1,$2,1000,5000,300,500,NULL,80,$3)", [TENANT, MARKET, ADMIN]);
  await q('UPDATE cancellation_policies SET enabled=true WHERE id=$1', [p.rows[0].id]);
  // Seed the cancelled booking that owns the fee and driver.
  await q("INSERT INTO jobs(id,customer_id,tenant_id,driver_id,status,country_code,currency_code) VALUES($1,$2,$3,$4,'cancelled','GB','GBP')", [JOB, CUSTOMER, TENANT, DRIVER]);
}

async function recordReceivable(amount = 500, policyVersion = 1) {
  const r = await q("SELECT * FROM record_customer_receivable($1,$2,$3,'GBP',$4,'cancellation_fee',$5)",
    [TENANT, CUSTOMER, JOB, amount, policyVersion]);
  return r.rows[0];
}

const settle = (receivable, collected, ref, merchant = 'acct_test', env = 'test') =>
  q('SELECT settle_cancellation_compensation($1,$2,$3,$4,$5,$6) AS result',
    [receivable, collected, ref, 'stripe', merchant, env]).then(r => r.rows[0].result);

const reverse = (receivable, refund, ref, merchant = 'acct_test', env = 'test') =>
  q('SELECT reverse_cancellation_compensation($1,$2,$3,$4,$5,$6) AS result',
    [receivable, refund, ref, 'stripe', merchant, env]).then(r => r.rows[0].result);

async function earnings() {
  return row('SELECT amount::float8 AS amount, platform_fee::float8 AS platform_fee, gross_amount::float8 AS gross, status, settlement_purpose, settled_at, stripe_transfer_id FROM driver_earnings WHERE job_id=$1', [JOB]);
}

async function test(name, fn) { await reset(); await fn(); console.log('PASS ' + name); }

(async () => {
  db = new Client({ connectionString: process.env.MOVABI_TEST_DATABASE_URL });
  await db.connect();
  await db.query(fs.readFileSync(path.join(__dirname, 'fixture.sql'), 'utf8'));
  // Canonical migrations — not a copied scripts/.../migration.sql — are applied and tested.
  await db.query(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261264000000_cancellation_compensation.sql'), 'utf8'));
  await db.query(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261264100000_cancellation_compensation_earnings.sql'), 'utf8'));
  await db.query(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261264200000_cancellation_compensation_acceptance.sql'), 'utf8'));
  // Drift guard: the local copy must byte-match the canonical 640 migration.
  assert.equal(
    fs.readFileSync(path.join(__dirname, 'migration.sql'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261264000000_cancellation_compensation.sql'), 'utf8'),
    'scripts/cancellation-compensation/migration.sql drifted from the canonical 640 migration');

  await test('collected fee lands in canonical driver earnings (80/20)', async () => {
    const r = await recordReceivable(500);
    const result = await settle(r.id, 500, 'pi_collect_1');
    assert.equal(result.status, 'settled');
    assert.equal(Number(result.driver_compensation_minor), 400);
    assert.equal(Number(result.platform_share_minor), 100);

    const e = await earnings();
    assert.equal(e.amount, 4.00);           // driver compensation, major units
    assert.equal(e.platform_fee, 1.00);     // platform share
    assert.equal(e.gross, 5.00);            // collected fee
    assert.equal(e.status, 'pending');      // payable, canonical earnings state
    assert.equal(e.settlement_purpose, 'cancellation_compensation');

    const recv = await row('SELECT status, review_required, collected_minor::bigint, compensation_minor::bigint, platform_share_minor::bigint, driver_id, market_code FROM customer_receivables WHERE id=$1', [r.id]);
    assert.equal(recv.status, 'paid');
    assert.equal(recv.review_required, false);
    assert.equal(Number(recv.collected_minor), 500);
    assert.equal(Number(recv.compensation_minor), 400);
    assert.equal(Number(recv.platform_share_minor), 100);
    assert.equal(recv.driver_id, DRIVER);
    assert.equal(recv.market_code, 'GB');
  });

  await test('duplicate collection is idempotent (no double settlement)', async () => {
    const r = await recordReceivable(500);
    await settle(r.id, 500, 'pi_collect_2');
    const again = await settle(r.id, 500, 'pi_collect_2');
    assert.equal(again.status, 'already_settled');
    assert.equal((await val('SELECT count(*)::int FROM driver_earnings')), 1);
    assert.equal((await val("SELECT count(*)::int FROM cancellation_compensation_events WHERE kind='collection'")), 1);
    const e = await earnings();
    assert.equal(e.amount, 4.00);
  });

  await test('unpaid fee yields no spendable compensation', async () => {
    await recordReceivable(500); // never collected
    assert.equal((await val('SELECT count(*)::int FROM driver_earnings')), 0);
    assert.equal((await val('SELECT count(*)::int FROM cancellation_compensation_events')), 0);
    assert.equal((await val("SELECT status FROM customer_receivables WHERE job_id=$1", [JOB])), 'open');
  });

  await test('missing policy version routes to review, never re-prices on active policy', async () => {
    const r = await recordReceivable(500, null); // historical fee, no frozen version
    const result = await settle(r.id, 500, 'pi_collect_3');
    assert.equal(result.status, 'review_required');
    assert.equal(Number(result.driver_compensation_minor), 0);
    assert.equal((await val('SELECT count(*)::int FROM driver_earnings')), 0);
    const recv = await row('SELECT status, review_required, collected_minor::bigint FROM customer_receivables WHERE id=$1', [r.id]);
    assert.equal(recv.status, 'paid');           // the fee WAS collected
    assert.equal(recv.review_required, true);    // ...but compensation is ambiguous
    assert.equal(Number(recv.collected_minor), 500);
  });

  await test('over-collection beyond the charged fee is rejected', async () => {
    const r = await recordReceivable(500);
    await assert.rejects(() => settle(r.id, 600, 'pi_collect_4'), /exceeds the charged fee/);
    assert.equal((await val('SELECT count(*)::int FROM driver_earnings')), 0);
  });

  await test('full refund reverses compensation with a linked adjustment', async () => {
    const r = await recordReceivable(500);
    const settled = await settle(r.id, 500, 'pi_collect_5');
    const rev = await reverse(r.id, 500, 're_refund_1');
    assert.equal(rev.status, 'reversed');
    assert.equal(Number(rev.driver_compensation_minor), 0);

    const e = await earnings();
    assert.equal(e.amount, 0);
    assert.equal(e.platform_fee, 0);
    assert.equal(e.gross, 0);

    const events = await q("SELECT kind, linked_event_id, compensation_delta_minor::bigint FROM cancellation_compensation_events WHERE receivable_id=$1 ORDER BY created_at, id", [r.id]);
    assert.equal(events.rows.length, 2);
    assert.equal(events.rows[0].kind, 'collection');
    assert.equal(events.rows[1].kind, 'refund');
    assert.equal(events.rows[1].linked_event_id, settled.event_id); // linked adjustment
    assert.equal(Number(events.rows[1].compensation_delta_minor), -400);
  });

  await test('partial collection and partial refund stay cumulative and bounded', async () => {
    const r = await recordReceivable(500);
    const s1 = await settle(r.id, 300, 'pi_collect_6');
    assert.equal(Number(s1.driver_compensation_minor), 240); // 80% of 300
    assert.equal(Number(s1.platform_share_minor), 60);

    const rv1 = await reverse(r.id, 100, 're_refund_2');
    assert.equal(Number(rv1.driver_compensation_minor), 160); // 80% of (300-100)
    assert.equal(Number(rv1.platform_share_minor), 40);

    const e1 = await earnings();
    assert.equal(e1.amount, 1.60);
    assert.equal(e1.gross, 2.00);

    await reverse(r.id, 200, 're_refund_3');
    const e2 = await earnings();
    assert.equal(e2.amount, 0); // net collected now 0
    assert.equal(e2.gross, 0);

    // Refunding more than was collected is refused.
    await assert.rejects(() => reverse(r.id, 1, 're_refund_4'), /Refund exceeds the collected amount/);
  });

  await test('dedupe is bound to provider+merchant+environment, not reference alone', async () => {
    const r = await recordReceivable(2000);
    await settle(r.id, 500, 'pi_same_ref', 'acct_A', 'test');
    await settle(r.id, 500, 'pi_same_ref', 'acct_B', 'test');   // different merchant -> distinct
    await settle(r.id, 500, 'pi_same_ref', 'acct_A', 'live');   // different environment -> distinct
    const again = await settle(r.id, 500, 'pi_same_ref', 'acct_A', 'test'); // same triple -> replay
    assert.equal(again.status, 'already_settled');
    assert.equal((await val("SELECT count(*)::int FROM cancellation_compensation_events WHERE provider_reference='pi_same_ref'")), 3);
    assert.equal(Number(await val('SELECT compensation_minor::bigint FROM customer_receivables WHERE id=$1', [r.id])), 1200); // 80% of 1500 collected
  });

  await test('settle failure is atomic and a retry completes compensation', async () => {
    const r = await recordReceivable(500);
    await assert.rejects(() => settle(r.id, 600, 'pi_retry_1'), /exceeds the charged fee/);
    assert.equal((await val('SELECT status FROM customer_receivables WHERE id=$1', [r.id])), 'open'); // nothing recorded
    assert.equal((await val('SELECT count(*)::int FROM driver_earnings')), 0);
    const ok = await settle(r.id, 500, 'pi_retry_1');
    assert.equal(ok.status, 'settled');
    assert.equal(Number(ok.driver_compensation_minor), 400);
    assert.equal((await val('SELECT status FROM customer_receivables WHERE id=$1', [r.id])), 'paid');
  });

  await test('refund after payout preserves paid history and records a linked recovery', async () => {
    const r = await recordReceivable(500);
    const settled = await settle(r.id, 500, 'pi_paid_1');
    await q("UPDATE driver_earnings SET status='paid', stripe_transfer_id='tr_1' WHERE job_id=$1", [JOB]);
    const before = await earnings();
    assert.equal(before.status, 'paid');
    assert.equal(Number(before.amount), 4.00);

    const rev = await reverse(r.id, 200, 're_paid_1');
    assert.equal(rev.status, 'reversed');
    assert.equal(rev.recovery_required, true);

    const after = await earnings();
    assert.equal(after.status, 'paid');           // paid history preserved
    assert.equal(Number(after.amount), 4.00);     // NOT edited
    assert.equal(after.stripe_transfer_id, 'tr_1');

    const ev = await row("SELECT kind, recovery_required, linked_event_id, compensation_delta_minor::bigint FROM cancellation_compensation_events WHERE provider_reference='re_paid_1'");
    assert.equal(ev.kind, 'refund');
    assert.equal(ev.recovery_required, true);     // linked recovery adjustment
    assert.equal(ev.linked_event_id, settled.event_id);
    assert.equal(Number(ev.compensation_delta_minor), -160); // recover 80% of the 200 refund
  });

  await test('minor->major conversion is exponent-aware for 0/2/3-decimal currencies', async () => {
    assert.equal(Number((await row('SELECT public.minor_to_major(400,$1) AS v', ['JPY'])).v), 400);   // 0-decimal
    assert.equal(Number((await row('SELECT public.minor_to_major(400,$1) AS v', ['GBP'])).v), 4);     // 2-decimal
    assert.equal(Number((await row('SELECT public.minor_to_major(400,$1) AS v', ['KWD'])).v), 0.4);   // 3-decimal
  });

  await test('three-decimal currency (KWD) compensation is stored precisely', async () => {
    await q("SELECT * FROM publish_cancellation_policy($1,'KW',1000,5000,300,500,NULL,80,$2)", [TENANT, ADMIN]);
    await q("UPDATE cancellation_policies SET enabled=true WHERE market_code='KW'");
    const kwJob = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
    await q("INSERT INTO jobs(id,customer_id,tenant_id,driver_id,status,country_code,currency_code) VALUES($1,$2,$3,$4,'cancelled','KW','KWD')", [kwJob, CUSTOMER, TENANT, DRIVER]);
    const r = await row("SELECT * FROM record_customer_receivable($1,$2,$3,'KWD',500,'cancellation_fee',1)", [TENANT, CUSTOMER, kwJob]);
    const result = await settle(r.id, 500, 'pi_kwd_1');
    assert.equal(Number(result.driver_compensation_minor), 400);
    const e = await row('SELECT amount::numeric AS amount, gross_amount::numeric AS gross FROM driver_earnings WHERE job_id=$1', [kwJob]);
    assert.equal(Number(e.amount), 0.4);   // 400 minor KWD = 0.400 (not 4.00)
    assert.equal(Number(e.gross), 0.5);    // 500 minor KWD = 0.500
  });

  await test('payout queries distinguish compensation by settlement_purpose and status', async () => {
    const r = await recordReceivable(500);
    await settle(r.id, 500, 'pi_payout_q');
    // logistics.hasDriverEarnings treats only status='paid' as a settled money tail.
    assert.equal((await val("SELECT count(*)::int FROM driver_earnings WHERE job_id=$1 AND status='paid'", [JOB])), 0);
    assert.equal((await val("SELECT count(*)::int FROM driver_earnings WHERE job_id=$1 AND settlement_purpose='cancellation_compensation' AND status='pending'", [JOB])), 1);
    // After payout the same query recognises the row as settled.
    await q("UPDATE driver_earnings SET status='paid' WHERE job_id=$1", [JOB]);
    assert.equal((await val("SELECT count(*)::int FROM driver_earnings WHERE job_id=$1 AND status='paid'", [JOB])), 1);
  });

  await test('server-only: clients cannot execute the compensation RPCs', async () => {
    const r = await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS ident,
        has_function_privilege('anon',p.oid,'EXECUTE') AS a,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS u,
        has_function_privilege('service_role',p.oid,'EXECUTE') AS s
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('settle_cancellation_compensation','reverse_cancellation_compensation','record_customer_receivable')`);
    assert.equal(r.rows.length, 3);
    for (const x of r.rows) {
      assert.equal(x.a, false, x.proname);
      assert.equal(x.u, false, x.proname);
      assert.equal(x.s, true, x.proname);
    }
  });

  console.log('CANCELLATION_COMPENSATION_TESTS=PASS');
  await db.end();
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { try { await db.end(); } catch {} });
