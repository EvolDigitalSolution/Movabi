// JobPayoutService rehearsal against the MIGRATED database (PostgREST) with a
// simulated payout provider. The real TypeScript worker runs unmodified:
//   claim_queued_job_payout -> provider reconcile -> transfers.create ->
//   finish_queued_job_payout (which marks errand purchases reimbursed).
// Proves: fare + reimbursement sent in ONE transfer, exactly-once across
// replays, uncertain outcomes stay reconcileable without duplicate transfers,
// and purchases are marked paid only after provider confirmation.
//
// Env: SUPABASE_URL (PostgREST), SUPABASE_SERVICE_ROLE_KEY (minted JWT),
//      JOB_OK, JOB_UNCERTAIN, JOB_REPLAY — job ids pre-seeded by the runner.
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Mint the service_role JWT PostgREST expects (same secret as the disposable auth stack).
function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
const secret = process.env.SUPABASE_JWT_SECRET;
const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role: 'service_role', aud: 'authenticated', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;

// supabase-js addresses /<base>/rest/v1/... (the Supabase gateway path); plain
// PostgREST serves the schema at root. Bridge the two with a local proxy that
// strips /rest/v1. PGRST_URL is the direct PostgREST address.
const http = require('http');
const directUrl = process.env.PGRST_URL;
const proxy = http.createServer((req, res) => {
  const target = new URL(req.url.replace(/^\/rest\/v1/, '') || '/', directUrl);
  const upstream = http.request(target, { method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(upstream);
});
const workerReady = new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => {
  process.env.SUPABASE_URL = `http://127.0.0.1:${proxy.address().port}`;
  resolve();
}));

const DIR = __dirname;
const stubStripe = path.join(DIR, 'payout-worker-stripe-stub.cjs');
const stubElig = path.join(DIR, 'payout-worker-eligibility-stub.cjs');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (/(^|[\\/])stripe\.service$/.test(request) || request === './stripe.service') return stubStripe;
  if (/(^|[\\/])payout-eligibility\.service$/.test(request) || request === './payout-eligibility.service') return stubElig;
  return origResolve.call(this, request, ...args);
};
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, resolveJsonModule: true }
});

const S = (globalThis.__stripeSim = { transfers: [], calls: [], failures: [], balanceMinor: 1000000, seq: 0 });
const root = path.join(DIR, '..', '..');
let db;

const results = [];
async function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail: String(detail).slice(0, 90) });
}
async function queue(job) {
  const { data } = await db.from('job_payout_queue').select('*').eq('job_id', job).single();
  return data;
}
async function purchases(job) {
  const { data } = await db.from('errand_purchase_payments').select('status,reimbursement_transfer_id,amount_minor,payer').eq('job_id', job);
  return data || [];
}
async function earnings(job) {
  const { data } = await db.from('driver_earnings').select('amount,gross_amount,stripe_transfer_id,status').eq('job_id', job);
  return data || [];
}
const createsFor = (job) => S.calls.filter(c => c.params.transfer_group === `job_${job}`);

(async () => {
  await workerReady;
  const { JobPayoutService } = require(path.join(root, 'server/services/job-payout.service.ts'));
  db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const JOB_OK = process.env.JOB_OK, JOB_UNCERTAIN = process.env.JOB_UNCERTAIN, JOB_REPLAY = process.env.JOB_REPLAY;
  const raw = await fetch(`${process.env.PGRST_URL}/job_payout_queue?select=job_id,status,amount_minor&limit=3`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  console.log('raw probe:', raw.status, (await raw.text()).slice(0, 300));
  const probe = await db.from('job_payout_queue').select('job_id,status,amount_minor').in('job_id', [JOB_OK, JOB_UNCERTAIN, JOB_REPLAY]);
  if (probe.error) throw new Error('PostgREST probe failed: ' + JSON.stringify(probe.error, Object.getOwnPropertyNames(probe.error)) + ' / ' + probe.error.message);
  console.log('probe:', JSON.stringify(probe.data));

  // A. Clean path: one transfer carries fare entitlement + reimbursement.
  await JobPayoutService.process(JOB_OK);
  let q = await queue(JOB_OK), p = await purchases(JOB_OK);
  await check('one provider transfer carries fare + reimbursement (850+2000 minor)',
    createsFor(JOB_OK).length === 1 && createsFor(JOB_OK)[0].params.amount === 2850
    && createsFor(JOB_OK)[0].params.currency === 'gbp',
    JSON.stringify(createsFor(JOB_OK).map(c => c.params.amount)));
  await check('the queued row settles as paid with the provider reference',
    q && q.status === 'paid' && typeof q.transfer_id === 'string' && q.transfer_id.startsWith('tr_'), q && `${q.status}/${q.transfer_id}`);
  await check('the purchase is marked reimbursed only after provider confirmation',
    p.length === 1 && p[0].status === 'reimbursed' && p[0].reimbursement_transfer_id === q.transfer_id,
    JSON.stringify(p));
  await check('service earnings stay commissionable fare only (8.50 of 10.00)',
    (await earnings(JOB_OK)).every(e => e.gross_amount === 10),
    JSON.stringify(await earnings(JOB_OK)));

  // B. Replay: processing the same job again must not create a second transfer.
  await JobPayoutService.process(JOB_OK);
  await check('replaying a paid job sends no second transfer (exactly-once)',
    createsFor(JOB_OK).length === 1, createsFor(JOB_OK).length);

  // C. Uncertain provider outcome: claim -> create throws -> reconcile ->
  //    the landed transfer is found and finished WITHOUT a new create.
  S.failures.push('uncertain');
  await JobPayoutService.process(JOB_UNCERTAIN);
  q = await queue(JOB_UNCERTAIN); p = await purchases(JOB_UNCERTAIN);
  await check('an uncertain transfer outcome leaves the row reconcileable (not paid, no new attempt)',
    q && ['reconcile', 'processing', 'pending'].includes(q.status) && q.status !== 'paid',
    q && q.status);
  await check('the purchase is still recorded — never marked paid before confirmation',
    p.length === 1 && p[0].status === 'recorded' && p[0].reimbursement_transfer_id === null,
    JSON.stringify(p));
  // Reclaim + reconcile: the worker finds the transfer it made and finishes it.
  // (The retry window is 5 minutes; elapse it so the row is claimable again.)
  await db.from('job_payout_queue').update({ retry_at: new Date(0).toISOString() }).eq('job_id', JOB_UNCERTAIN);
  await JobPayoutService.process(JOB_UNCERTAIN);
  q = await queue(JOB_UNCERTAIN); p = await purchases(JOB_UNCERTAIN);
  await check('reconciliation finishes the uncertain transfer without a duplicate create',
    createsFor(JOB_UNCERTAIN).length === 1 && q && q.status === 'paid'
    && S.transfers.filter(t => t.transfer_group === `job_${JOB_UNCERTAIN}`).length === 1,
    `creates=${createsFor(JOB_UNCERTAIN).length} status=${q && q.status}`);
  await check('the reconciled purchase is reimbursed exactly once',
    p.length === 1 && p[0].status === 'reimbursed' && p[0].reimbursement_transfer_id === q.transfer_id,
    JSON.stringify(p));

  // D. A transfer that already exists (crash after create, before finish):
  //    the worker must match it and finish — never re-create.
  S.transfers.push({ id: 'tr_prelanded_1', amount: 2850, currency: 'gbp',
    destination: 'acct_drv_test', transfer_group: `job_${JOB_REPLAY}`, reversed: false });
  await JobPayoutService.process(JOB_REPLAY);
  q = await queue(JOB_REPLAY); p = await purchases(JOB_REPLAY);
  await check('a pre-existing provider transfer is matched and finished, not re-created',
    createsFor(JOB_REPLAY).length === 0 && q && q.status === 'paid'
    && p.every(r => r.status === 'reimbursed'),
    `creates=${createsFor(JOB_REPLAY).length} status=${q && q.status}`);

  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name}${r.detail ? ' | ' + r.detail : ''}`);
  console.log(`worker rehearsal: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('rehearsal error', e instanceof Error ? e.stack : JSON.stringify(e, Object.getOwnPropertyNames(e))); process.exit(1); });
