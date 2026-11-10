const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Client } = require(process.env.MOVABI_PG_MODULE || 'pg');

const TENANT   = 'd0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8';
const REFERRER = '11111111-1111-4111-8111-111111111111';
const DRIVER   = '33333333-3333-4333-8333-333333333333';

let db;
let seq = 0;
const q = (sql, args = []) => db.query(sql, args);
const row = async (sql, args = []) => (await q(sql, args)).rows[0];
const val = async (sql, args = []) => { const r = (await q(sql, args)).rows[0]; return r ? r[Object.keys(r)[0]] : undefined; };
const newJob = (customer) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++seq).padStart(12, '0')}`;
const newReferee = () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++seq).padStart(12, '0')}`;

async function reset() {
  await db.query('TRUNCATE referral_driver_progress, reward_credits, referrals, campaigns, jobs CASCADE');
}

async function campaign(opts = {}) {
  const r = await q(`INSERT INTO campaigns(tenant_id, code, kind, market_code, currency_code, service_slug, audience, enabled, paused, budget_minor, qualification, referral_reward_bps, version)
    VALUES($1,$2,'referral','GB','GBP','ride','customer', true, $3, $4, $5, $6, 1) RETURNING id`,
    [TENANT, opts.code || `REF${++seq}`, opts.paused === true, opts.budget ?? 0, JSON.stringify(opts.qualification || {}), opts.bps ?? 500]);
  return r.rows[0].id;
}

async function referral(campaignId, opts = {}) {
  const r = await q(`INSERT INTO referrals(tenant_id, campaign_id, referrer_id, referee_id, status, referral_kind, reward_rate_bps, reward_cap_minor, qualifying_fare_minor, qualifying_jobs_required, qualifying_window_days, review_days)
    VALUES($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [TENANT, campaignId, opts.referrer || REFERRER, opts.referee || newReferee(),
     opts.kind || 'customer', opts.bps ?? 500, opts.cap ?? null, opts.minFare ?? null,
     opts.jobs ?? 1, opts.windowDays ?? null, opts.reviewDays ?? 0]);
  return r.rows[0].id;
}

async function job(fare = 2000, customer = newReferee(), status = 'completed', payment = 'paid') {
  const id = newJob(customer);
  await q(`INSERT INTO jobs(id, customer_id, tenant_id, driver_id, status, payment_status, currency_code, agreed_fare, total_price, price, created_at)
    VALUES($1,$2,$3,$4,$5,$6,'GBP',$7,$7,$7, now())`, [id, customer, TENANT, DRIVER, status, payment, fare]);
  return id;
}

const earn = (rid, jobId) => q('SELECT * FROM earn_referral($1,$2)', [rid, jobId]).then(r => r.rows[0]);
const rejects = async (fn, pattern) => { let e = null; try { await fn(); } catch (x) { e = x; } assert(e, 'Expected rejection'); assert.match(String(e.message || e), pattern); };

async function test(name, fn) { await reset(); await fn(); console.log('PASS ' + name); }

(async () => {
  db = new Client({ connectionString: process.env.MOVABI_TEST_DATABASE_URL });
  await db.connect();
  await db.query(fs.readFileSync(path.join(__dirname, 'fixture.sql'), 'utf8'));
  // Apply the CANONICAL referral lifecycle functions (migrations 645-647).
  await db.query(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261264500000_referral_lifecycle_pause.sql'), 'utf8'));
  await db.query(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261264600000_referral_reversal.sql'), 'utf8'));
  await db.query(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261264700000_referral_adjudication_guard.sql'), 'utf8'));

  await test('customer referral earns 5% of first qualifying completed/paid fare', async () => {
    const c = await campaign({ budget: 1000 });
    const r = await referral(c, { bps: 500 });
    const j = await job(2000);
    const earned = await earn(r, j);
    assert.equal(earned.status, 'earned');
    assert.equal(Number(earned.reward_minor), 100);       // 5% of 2000
    const credit = await row('SELECT amount_minor::bigint, withdrawable, expires_at, status FROM reward_credits WHERE source_id=$1', [r]);
    assert.equal(Number(credit.amount_minor), 100);
    assert.equal(credit.withdrawable, false);              // non-withdrawable booking credit
    assert.equal(credit.status, 'active');
    // 90-day expiry
    assert.ok(new Date(credit.expires_at) > new Date(Date.now() + 89 * 86400000));
    assert.ok(new Date(credit.expires_at) < new Date(Date.now() + 91 * 86400000));
  });

  await test('frozen rate is used after an admin edits the campaign rate', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { bps: 500 });   // frozen at link time = 500bps
    await q('UPDATE campaigns SET referral_reward_bps=1000, version=2 WHERE id=$1', [c]); // admin rate edit
    const j = await job(2000);
    const earned = await earn(r, j);
    assert.equal(Number(earned.reward_minor), 100);        // still 5%, NOT 10%
  });

  await test('pause does not block an existing referral from earning', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { bps: 500 });
    await q('UPDATE campaigns SET paused=true WHERE id=$1', [c]); // paused after acceptance
    const j = await job(2000);
    const earned = await earn(r, j);
    assert.equal(earned.status, 'earned');
    assert.equal(Number(earned.reward_minor), 100);
  });

  await test('driver referral accumulates 5% across first 20 jobs in 30 days, 7-day review', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { kind: 'driver', bps: 500, jobs: 20, windowDays: 30, reviewDays: 7 });
    let last;
    for (let i = 0; i < 20; i++) {
      const j = await job(100);
      last = await earn(r, j);
    }
    assert.equal(last.status, 'earned');
    assert.equal(Number(last.reward_minor), 100);           // 5% of 2000 cumulative
    // seven-day review window
    assert.ok(new Date(last.release_at) > new Date(Date.now() + 6 * 86400000));
    assert.ok(new Date(last.release_at) < new Date(Date.now() + 8 * 86400000));
    assert.equal(Number(await val('SELECT count(*)::int FROM referral_driver_progress WHERE referral_id=$1', [r])), 20);
  });

  await test('monthly cap is enforced', async () => {
    const c = await campaign({ budget: 1000, qualification: { max_rewards_per_month: 1 } });
    const r1 = await referral(c, { bps: 500 });
    await earn(r1, await job(2000));
    const r2 = await referral(c, { bps: 500 });
    const j2 = await job(2000);
    await rejects(() => earn(r2, j2), /monthly_cap_reached/);
  });

  await test('budget is atomic: second earn cannot overspend', async () => {
    const c = await campaign({ bps: 500, budget: 100 });    // budget = 100, reward = 100
    const r1 = await referral(c, { bps: 500 });
    await earn(r1, await job(2000));
    assert.equal(Number(await val('SELECT spent_minor::bigint FROM campaigns WHERE id=$1', [c])), 100);
    const r2 = await referral(c, { bps: 500 });
    const j2 = await job(2000);
    await rejects(() => earn(r2, j2), /campaign_budget_exhausted/);
    assert.equal(Number(await val('SELECT spent_minor::bigint FROM campaigns WHERE id=$1', [c])), 100);
  });

  await test('replay is idempotent (no duplicate credit)', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { bps: 500 });
    const j = await job(2000);
    await earn(r, j);
    await earn(r, j);
    assert.equal((await val('SELECT count(*)::int FROM reward_credits WHERE source_id=$1', [r])), 1);
    assert.equal(Number(await val('SELECT spent_minor::bigint FROM campaigns WHERE id=$1', [c])), 100);
  });

  await test('disabled campaign preserves an existing referral obligation', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { bps: 500 });
    await q('UPDATE campaigns SET enabled=false WHERE id=$1', [c]); // disable after acceptance
    const earned = await earn(r, await job(2000));
    assert.equal(earned.status, 'earned');           // obligation preserved
    assert.equal(Number(earned.reward_minor), 100);
    assert.equal(Number(await val('SELECT spent_minor::bigint FROM campaigns WHERE id=$1', [c])), 100);
  });

  await test('reverse a customer referral reverses its credit and is idempotent', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { bps: 500 });
    await earn(r, await job(2000));
    const credit = await row('SELECT id, status, amount_minor::bigint FROM reward_credits WHERE source_id=$1', [r]);
    assert.equal(credit.status, 'active');
    assert.equal(Number(await val('SELECT reward_credit_available($1)', [credit.id])), 100);

    const rev = await q('SELECT * FROM reverse_referral_reward($1)', [r]).then(x => x.rows[0]);
    assert.equal(rev.status, 'reversed');
    assert.equal((await val('SELECT status FROM reward_credits WHERE id=$1', [credit.id])), 'reversed');
    // spendable balance is now zero: apply rejects a non-active credit
    const bj = await job(2000, REFERRER);
    await rejects(() => q('SELECT * FROM apply_reward_credit($1,$2,100)', [credit.id, bj]), /credit_not_active/);
    // duplicate reversal is idempotent (no extra credit)
    const rev2 = await q('SELECT * FROM reverse_referral_reward($1)', [r]).then(x => x.rows[0]);
    assert.equal(rev2.status, 'reversed');
    assert.equal((await val('SELECT count(*)::int FROM reward_credits WHERE source_id=$1', [r])), 1);
  });

  await test('reverse preserves already-used credit history without extra credit', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { bps: 500 });
    await earn(r, await job(2000));
    const credit = await row('SELECT id FROM reward_credits WHERE source_id=$1', [r]);
    const bj = await job(2000, REFERRER);
    await q('SELECT * FROM apply_reward_credit($1,$2,100)', [credit.id, bj]);
    await q('SELECT * FROM settle_reward_credit_spend($1)', [bj]);
    assert.equal((await val('SELECT status FROM reward_credits WHERE id=$1', [credit.id])), 'used');

    await q('SELECT * FROM reverse_referral_reward($1)', [r]);
    assert.equal((await val('SELECT status FROM reward_credits WHERE id=$1', [credit.id])), 'reversed');
    // historical spending is preserved (not deleted) and no extra credit is created
    assert.equal((await val('SELECT count(*)::int FROM reward_credit_spends WHERE credit_id=$1', [credit.id])), 1);
    assert.equal((await val('SELECT status FROM reward_credit_spends WHERE credit_id=$1', [credit.id])), 'spent');
    assert.equal((await val('SELECT count(*)::int FROM reward_credits WHERE source_id=$1', [r])), 1);
  });

  await test('driver reward cannot release before 7 days, then releases and reverses', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { kind: 'driver', bps: 500, jobs: 1, reviewDays: 7 });
    await earn(r, await job(2000));
    assert.equal((await val('SELECT status FROM referrals WHERE id=$1', [r])), 'earned');
    // before the review window, release_referral_rewards must not release
    assert.equal(Number(await val('SELECT release_referral_rewards()')), 0);
    assert.equal((await val('SELECT status FROM referrals WHERE id=$1', [r])), 'earned');
    // force release_at into the past and release
    await q("UPDATE referrals SET release_at=now()-interval '1 second' WHERE id=$1", [r]);
    assert.equal(Number(await val('SELECT release_referral_rewards()')), 1);
    assert.equal((await val('SELECT status FROM referrals WHERE id=$1', [r])), 'released');
    const credit = await row("SELECT id, status FROM reward_credits WHERE source_id=$1 AND source='driver_referral'", [r]);
    assert.equal(credit.status, 'active');
    await q('SELECT * FROM reverse_referral_reward($1)', [r]);
    assert.equal((await val('SELECT status FROM referrals WHERE id=$1', [r])), 'reversed');
    assert.equal((await val('SELECT status FROM reward_credits WHERE id=$1', [credit.id])), 'reversed');
  });

  await test('job 21 does not create a second reward', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { kind: 'driver', bps: 500, jobs: 20, reviewDays: 7 });
    for (let i = 0; i < 20; i++) await earn(r, await job(100));
    const before = await row('SELECT status, reward_minor::bigint FROM referrals WHERE id=$1', [r]);
    const after = await earn(r, await job(100)); // 21st job
    assert.equal(after.status, 'earned');
    assert.equal(Number(after.reward_minor), Number(before.reward_minor)); // unchanged
    assert.equal((await val('SELECT count(*)::int FROM referral_driver_progress WHERE referral_id=$1', [r])), 21);
    assert.equal((await val('SELECT count(*)::int FROM reward_credits WHERE source_id=$1', [r])), 0); // driver credit only on release
  });

  await test('jobs outside the 30-day window are rejected', async () => {
    const c = await campaign({ bps: 500, budget: 1000 });
    const r = await referral(c, { kind: 'driver', bps: 500, jobs: 20, windowDays: 30, reviewDays: 7 });
    // first job activates the window 31 days ago
    const firstJob = newJob(newReferee());
    await q(`INSERT INTO jobs(id,customer_id,tenant_id,driver_id,status,payment_status,currency_code,agreed_fare,total_price,price,created_at)
      VALUES($1,$2,$3,$4,'completed','paid','GBP',100,100,100, now()-interval '31 days')`, [firstJob, newReferee(), TENANT, DRIVER]);
    await earn(r, firstJob);
    // a job now is beyond activated_at + 30 days -> rejected
    const late = await job(100);
    const rejected = await earn(r, late);
    assert.equal(rejected.status, 'rejected');
  });

  await test('caller/access audit: referral RPCs are server-only', async () => {
    const rows = await q(`SELECT p.proname,
        has_function_privilege('anon',p.oid,'EXECUTE') AS a,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS u,
        has_function_privilege('service_role',p.oid,'EXECUTE') AS s
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN
        ('earn_referral','reverse_referral_reward','release_referral_rewards','campaign_spend','referral_monthly_count')`);
    assert.equal(rows.rows.length, 5);
    for (const x of rows.rows) {
      assert.equal(x.a, false, x.proname + ' anon');
      assert.equal(x.u, false, x.proname + ' authenticated');
      assert.equal(x.s, true, x.proname + ' service_role');
    }
  });

  console.log('REFERRAL_LIFECYCLE_TESTS=PASS');
  await db.end();
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { try { await db.end(); } catch {} });
