// Connected sandbox journey: REAL Express routers + real GoTrue auth + real
// PostgREST/DB functions, with provider HTTP boundaries simulated (stripe
// package, kora payout adapter, payout-eligibility). One customer-funded
// errand ends in a driver wallet credit and a confirmed sandbox withdrawal.
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
const secret = process.env.SUPABASE_JWT_SECRET;
const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role: 'service_role', aud: 'authenticated', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;

// Bridge supabase-js paths: /rest/v1 -> PostgREST, /auth/v1 -> GoTrue.
// The payout sandbox guard requires SUPABASE_URL to literally be the develop
// kong origin, so the harness binds the local bridge to :8000 and resolves
// that hostname to loopback — the same env value production code reads.
const http = require('http');
const dns = require('dns');
const origLookup = dns.lookup;
dns.lookup = function (host, options, cb) {
  if (host === 'movabi-develop-kong') {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options && options.all) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
    return cb(null, '127.0.0.1', 4);
  }
  return origLookup.call(this, host, options, cb);
};
const pgrst = process.env.PGRST_URL, gotrue = process.env.GOTRUE_URL;
const proxy = http.createServer((req, res) => {
  const target = req.url.startsWith('/auth/v1')
    ? new URL(req.url.replace(/^\/auth\/v1/, '') || '/', gotrue)
    : new URL(req.url.replace(/^\/rest\/v1/, '') || '/', pgrst);
  const upstream = http.request(target, { method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode, up.headers); up.pipe(res);
  });
  upstream.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(upstream);
});
const ready = new Promise((resolve) => proxy.listen(8000, '127.0.0.1', () => {
  process.env.SUPABASE_URL = 'http://movabi-develop-kong:8000/'; resolve();
}));

const DIR = __dirname;
const stubStripe = path.join(DIR, 'payout-worker-stripe-stub.cjs');
const stubElig = path.join(DIR, 'payout-worker-eligibility-stub.cjs');
const stubFlw = path.join(DIR, 'payout-worker-flw-stub.cjs');
const stubKora = path.join(DIR, 'payout-worker-kora-stub.cjs');
// Simulated Stripe HTTP client for the customer collection adapter.
const stripeSim = (globalThis.__stripeSimJourney = { payments: new Map(), seq: 0 });
const fakeStripeModule = path.join(DIR, 'journey-stripe-sim.cjs');
require('fs').writeFileSync(fakeStripeModule, `
const sim=(globalThis.__stripeSimJourney||={payments:new Map(),seq:0});
class FakeStripe{
 constructor(){this.balance={retrieve:async()=>({issuing:{available:[]}})};this.accounts={retrieve:async()=>({id:'acct_ng_journey_1'})};
  this.checkout={sessions:{list:async()=>({data:[],has_more:false}),retrieve:async()=>({}),expire:async()=>({})}};
  this.paymentIntents={
   create:async(params,opts)=>{const pi={id:'pi_journey_'+(++sim.seq),livemode:false,amount:params.amount,currency:params.currency,metadata:{...params.metadata},client_secret:'pi_journey_secret_'+sim.seq,status:'requires_payment_method'};sim.payments.set(pi.id,pi);return pi;},
   retrieve:async(id)=>{const pi=sim.payments.get(id);if(!pi)throw new Error('unknown pi '+id);return {...pi,status:'succeeded',amount_received:pi.amount,latest_charge:{id:'ch_1',paid:true,captured:true,refunded:false,amount_refunded:0,amount:pi.amount,currency:pi.currency,payment_method_details:{type:'card'},balance_transaction:{id:'txn_1',fee:0,net:pi.amount,currency:pi.currency}}};},
   search:async()=>({data:[]}),cancel:async()=>({status:'canceled'})};
  this.transfers={create:async()=>({id:'tr_journey_x'}),list:async()=>({data:[]})};
}}
module.exports=FakeStripe;module.exports.default=FakeStripe;`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'stripe' || /(^|[\\/])stripe$/.test(request)) return fakeStripeModule;
  if (/(^|[\\/])stripe\.service$/.test(request) || request === './stripe.service') return stubStripe;
  if (/(^|[\\/])payout-eligibility\.service$/.test(request) || request === './payout-eligibility.service') return stubElig;
  if (/(^|[\\/])flutterwave-driver-payout$/.test(request)) return stubFlw;
  if (/(^|[\\/])kora-driver-payout$/.test(request)) return stubKora;
  return origResolve.call(this, request, ...args);
};
require('ts-node').register({ transpileOnly: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, resolveJsonModule: true } });

const root = path.join(DIR, '..', '..');
const TENANT = '11111111-1111-4111-8111-111111111111';
let DRIVER = null; // assigned from the id GoTrue actually issues
const steps = [];
function step(name, cond, detail = '') { steps.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + String(detail).slice(0, 100) : ''}`); }

(async () => {
  await ready;
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const must = async (label, q) => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await q;
        if (r.error) throw new Error(`${r.error.message} (${r.error.code || ''})`);
        return r.data;
      } catch (e) {
        if (i === 2) throw new Error(`${label}: ${e && e.message}${e && e.cause ? ' cause=' + JSON.stringify(e.cause, Object.getOwnPropertyNames(e.cause)) : ''}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  };

  // Real GoTrue users: customer + the sandbox-bound driver.
  const admin = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
  const mk = async (id, email) => {
    const r = await fetch(`${gotrue}/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ id, email, password: 'journey-pass-1', email_confirm: true }) });
    const u = await r.json(); if (!r.ok) throw new Error('gotrue admin ' + JSON.stringify(u));
    const s = await fetch(`${gotrue}/token?grant_type=password`, { method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'journey-pass-1' }) });
    const t = await s.json(); if (!s.ok) throw new Error('gotrue token ' + JSON.stringify(t));
    return { id: u.id, jwt: t.access_token };
  };
  const customer = await mk(crypto.randomUUID(), 'journey-customer@test.dev');
  const driverUser = await mk(crypto.randomUUID(), 'journey-driver@test.dev');
  DRIVER = driverUser.id;
  const driverJwt = driverUser.jwt;
  await must('customer profile', db.from('profiles').upsert({ id: customer.id, tenant_id: TENANT, role: 'customer', country_code: 'NG', registration_country_code: 'NG', registration_activated_at: new Date().toISOString() }));
  await must('driver profile', db.from('profiles').upsert({ id: DRIVER, tenant_id: TENANT, role: 'driver', country_code: 'NG', registration_country_code: 'NG', registration_activated_at: new Date().toISOString() }));
  // Driver-bound fixtures need the profile row the auth trigger just created.
  await must('driver account', db.from('driver_payment_accounts').insert({ id: 'aaaaaaaa-0000-4000-8000-0000000000aa', driver_id: DRIVER, tenant_id: TENANT,
    country_code: 'NG', currency_code: 'NGN', provider: 'kora', merchant_account_ref: 'kora_merchant_ng', state: 'completed',
    beneficiary_id: '0123456789', bank_code: '044', last4: '6789', fingerprint: 'a'.repeat(64) }));
  await must('market reset', db.from('driver_payout_markets').delete().eq('country_code', 'NG').eq('currency_code', 'NGN'));
  await must('payout market', db.from('driver_payout_markets').insert({ country_code: 'NG', currency_code: 'NGN', provider: 'kora', merchant_account_ref: 'kora_merchant_ng',
    enabled: true, merchant_approved: true, adapter_ready: true, capability_verified_at: new Date().toISOString(), capability_evidence_ref: 'cap-evidence-1',
    merchant_mode: 'test', sandbox_driver_id: DRIVER, sandbox_tenant_id: TENANT }));
  step('real GoTrue users created and authenticated', !!customer.jwt && !!driverJwt, `${customer.id}/${DRIVER}`);

  // Mount the REAL routers exactly as server/index.ts mounts them.
  const express = require('express'); const bodyParser = require('body-parser');
  const app = express(); app.use(bodyParser.json());
  app.use('/api/wallet', require(path.join(root, 'server/routes/wallet.routes.ts')).default);
  app.use('/api/booking', require(path.join(root, 'server/routes/booking.routes.ts')).default);
  app.use('/api/driver-withdrawals', require(path.join(root, 'server/routes/driver-withdrawal.routes.ts')).default);
  app.use('/api/driver-payment-account', require(path.join(root, 'server/routes/driver-payment-account.routes.ts')).driverPaymentAccountRouter());
  app.use('/api/market-safety', require(path.join(root, 'server/routes/market-safety.routes.ts')).default);
  Object.assign(process.env, {
    NODE_ENV: 'test', VAYDU_DEPLOYMENT_ENV: 'develop', VAYDU_DRIVER_PAYOUT_SANDBOX: 'true', VAYDU_DRIVER_PAYOUT_TRANSFERS: 'true',
    FLUTTERWAVE_PAYOUT_MERCHANT_REF: 'flw_merchant_ng', FLUTTERWAVE_TEST_SECRET_KEY: 'FLWSECK_TEST-journey',
    FLUTTERWAVE_PAYOUT_WEBHOOK_SECRET: 'whsec-journey-0123456789abcdef01234567',
    FLUTTERWAVE_PAYOUT_CALLBACK_URL: 'https://movabi-develop.apps.evolsolution.com/api/driver-payment-account/webhook',
    KORA_PAYOUT_MERCHANT_REF: 'kora_merchant_ng', KORA_TEST_SECRET_KEY: 'sk_test_journey_kora',
    VAYDU_DRIVER_PAYOUT_CALLBACK_APPROVED: 'true', DRIVER_PAYOUT_FINGERPRINT_KEY: 'journey-fingerprint-key',
    STRIPE_SECRET_KEY: 'sk_test_journey', VAYDU_TOPUP_CALLBACK_URL: 'https://movabi-develop.apps.evolsolution.com/wallet-return'
  });
  const api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)); });
  const call = (method, url, jwt, body) => fetch(api + url, { method, headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  // The signup trigger provisioned the wallet in the platform default currency
  // before registration resolved the market; align it to the market currency.
  await must('wallet currency', db.from('wallets').update({ currency_code: 'NGN' }).eq('user_id', customer.id));
  // 1. Customer top-up: setup -> readiness -> quote -> confirmed checkout -> verify.
  const setup = await call('POST', '/api/wallet/setup', customer.jwt, {});
  step('customer wallet setup through the real route', setup.status === 200 && !!setup.body, `${setup.status} ${JSON.stringify(setup.body).slice(0, 90)}`);
  const rd = await call('GET', '/api/wallet/topup-readiness', customer.jwt);
  step('top-up readiness reports collection submittable', rd.status === 200 && rd.body.canSubmit === true, `${rd.status} ${JSON.stringify(rd.body).slice(0, 120)}`);
  const topupKey = crypto.randomUUID();
  const quote = await call('POST', '/api/wallet/collection/checkout', customer.jwt, { amountMinor: 50000, idempotencyKey: topupKey });
  const bound = await db.from('wallet_topup_attempts').select('provider_account_id').eq('id', quote.body.attemptId).single();
  step('provider account is bound from the trusted market route at freeze', bound.data?.provider_account_id === 'acct_ng_journey_1', `bound=${bound.data && bound.data.provider_account_id}`);
  const checkout = await call('POST', '/api/wallet/collection/checkout', customer.jwt, { amountMinor: 50000, idempotencyKey: topupKey, confirmedTotalMinor: quote.body.totalChargeMinor });
  step('confirmed checkout submits through the real route + adapter', checkout.status === 200 && checkout.body.kind === 'checkout', `${checkout.status} ${JSON.stringify(checkout.body).slice(0, 80)}`);
  const verify = await call('POST', '/api/wallet/collection/verify', customer.jwt, { attemptId: checkout.body.attemptId });
  step('verify credits the customer booking wallet once', verify.status === 200 && /^[0-9a-f-]{36}$/.test(verify.body.creditedEventId || ''), `${verify.status} ${verify.body && verify.body.creditedEventId}`);
  const bal = await call('GET', `/api/wallet/balance?userId=${customer.id}`, customer.jwt);
  step('wallet balance reflects the credited top-up', bal.status === 200 && Number(bal.body?.available_balance) >= 500, `balance=${JSON.stringify(bal.body)}`);

  // 2. Customer-funded errand: seed the job bound to the real customer, pay it
  //    from the wallet through the real route.
  const job = crypto.randomUUID();
  await must('job insert', db.from('jobs').insert({ id: job, tenant_id: TENANT, customer_id: customer.id, pickup_address: 'a', dropoff_address: 'b',
    scheduled_time: new Date().toISOString(), service_type_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd02', payment_status: 'pending',
    country_code: 'NG', currency_code: 'NGN', status: 'pending', total_price: 400,
    metadata: { quote_id: crypto.randomUUID(), quote_expires_at: new Date(Date.now() + 600000).toISOString() },
    fare_breakdown: { serviceFareBeforePlatformFee: 400, platformFeeAmount: 0, customerCharge: 400, commissionFee: 0, driverNetEarnings: 400, calculationVersion: 'journey-v1' } }));
  await must('errand details', db.from('errand_details').insert({ job_id: job, items_list: [], estimated_budget: 0 }));
  const pay = await call('POST', '/api/wallet/pay-job', customer.jwt, { userId: customer.id, jobId: job, currency: 'NGN', tenantId: TENANT });
  step('wallet funds the errand through the real pay-job route', pay.status === 200 && pay.body.success === true, `${pay.status} ${JSON.stringify(pay.body).slice(0, 90)}`);

  // 3. Driver opts into wallet settlement via the policy route, is assigned,
  //    then completes with the stamped PIN.
  const sm = await call('POST', '/api/driver-payment-account/settlement-method', driverJwt, { method: 'wallet' });
  step('driver settlement preference is server-policy wallet', sm.status === 200 && sm.body.settlementMethod === 'wallet', `${sm.status}`);
  await must('driver assignment', db.from('jobs').update({ driver_id: DRIVER, accepted_driver_id: DRIVER, status: 'in_progress' }).eq('id', job));
  // Real completion PIN: the secret stamped at assignment lives in
  // job_completion_secrets; the driver submits the customer's PIN.
  const secret = await db.from('job_completion_secrets').select('completion_pin').eq('job_id', job).maybeSingle();
  const jobRow = await db.from('jobs').select('metadata').eq('id', job).single();
  const pin = secret.data?.completion_pin || jobRow.data?.metadata?.completion_pin || null;
  const done = await call('POST', '/api/booking/complete', driverJwt, { jobId: job, completionPin: pin });
  step('completion succeeds through the real route with the stamped PIN', done.status === 200, `${done.status} ${JSON.stringify(done.body).slice(0, 90)}`);
  const { JobPayoutService } = require(path.join(root, 'server/services/job-payout.service.ts'));
  await JobPayoutService.process(job);
  const bal1 = await db.rpc('driver_earnings_wallet_balance', { p_driver: DRIVER, p_tenant: TENANT, p_currency: 'NGN' });
  const q = await db.from('job_payout_queue').select('status,transfer_id').eq('job_id', job).single();
  const earned = Number(bal1.data);
  step('driver earnings credited to the wallet ledger once (no provider transfer)', earned > 0 && q.data?.status === 'paid' && q.data.transfer_id === `wallet:${job}`, `balance=${bal1.data} ref=${q.data && q.data.transfer_id}`);

  // 4. Withdrawal through the real route + real worker, provider simulated.
  const withdrawMinor = Math.floor(earned / 2);
  const wr = await call('POST', '/api/driver-withdrawals', driverJwt, { amountMinor: withdrawMinor });
  step('withdrawal request reserves held funds (202)', wr.status === 202 && wr.body.status === 'processing', `${wr.status} ${JSON.stringify(wr.body)}`);
  const { DriverWithdrawalService } = require(path.join(root, 'server/services/driver-withdrawal.service.ts'));
  // The route already kicks the worker asynchronously; poll for the durable
  // reconcile state rather than racing the in-flight lease.
  const until = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 250)); } return v; };
  await DriverWithdrawalService.process(wr.body.id).catch(() => {});
  let w = await until(async () => { const r = await db.from('driver_withdrawals').select('status,provider_transfer_id').eq('id', wr.body.id).single(); return r.data && r.data.status === 'reconcile' ? r.data : null; });
  step('submission marks reconcile-required, never paid', w && w.status === 'reconcile', `${w && w.status}`);
  await db.from('driver_withdrawals').update({ retry_at: new Date(0).toISOString() }).eq('id', wr.body.id);
  await DriverWithdrawalService.process(wr.body.id).catch(() => {});
  w = await until(async () => { const r = await db.from('driver_withdrawals').select('status,provider_transfer_id').eq('id', wr.body.id).single(); return r.data && r.data.status === 'paid' ? r.data : null; });
  step('verified provider transfer settles held funds to paid_out once', w && w.status === 'paid' && !!w.provider_transfer_id, `${w && w.status}/${w && w.provider_transfer_id}`);
  const bal2 = await db.rpc('driver_earnings_wallet_balance', { p_driver: DRIVER, p_tenant: TENANT, p_currency: 'NGN' });
  step('remaining earnings stay spendable; settled funds are bank-paid', Number(bal2.data) === earned - withdrawMinor, `balance=${bal2.data} expected=${earned - withdrawMinor}`);

  const failed = steps.filter(s => !s.ok);
  console.log(`connected journey: ${steps.length - failed.length}/${steps.length} steps passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('journey error', e instanceof Error ? e.stack : JSON.stringify(e, Object.getOwnPropertyNames(e))); process.exit(1); });
