import { it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import { driverWalletDevelopRouter } from '../../server/routes/driver-wallet-develop.routes';

// Canonical scope authority: eligibility is the reviewed+enabled
// driver_card_topup_sandbox_scopes row, NOT a hardcoded account.
const DESIGNATED = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const DESIGNATED_TENANT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const UNSCOPED = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const UNSCOPED_TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const baseEnv = () => ({
  VAYDU_DRIVER_WALLET_COHOST_DEVELOP: 'true',
  VAYDU_DEPLOYMENT_ENV: 'develop',
  NODE_ENV: 'production',
  VAYDU_DRIVER_TOPUP_API: 'true',
  VAYDU_DRIVER_WALLET_EVIDENCE_APPROVED: 'true',
  VAYDU_DRIVER_TOPUP_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_'+'test_'+'a'.repeat(24),
});

function table(value: any) {
  const res = { data: value, error: null };
  const o: any = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'or', 'order', 'limit', 'insert', 'update', 'upsert']) o[m] = () => o;
  o.maybeSingle = async () => res;
  o.single = async () => res;
  o.then = (f: any) => Promise.resolve(res).then(f);
  return o;
}

const SCOPE = { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', provider: 'stripe', merchant_account_ref: 'stripe-platform', provider_account_id: 'acct_synthetic', policy_version: 'vaydu-driver-card-5pct-wallet-v1', fee_passing_mode: 'merchant' };
const ROUTE = [{ provider: 'stripe', merchant_account_ref: 'stripe-platform', capabilities: ['collect'] }];
const FEE = { version: 'vaydu-driver-card-5pct-wallet-v1', exponent: 2, fee_basis: 'wallet', fee_basis_points: 500, fee_fixed_minor: 0, fee_cap_minor: null, rounding: 'half_up', method: 'card', active: true };

function dbFor(userId: string, tenant: string, overrides: Record<string, any> = {}) {
  const tables: Record<string, any> = {
    profiles: { id: userId, tenant_id: tenant, role: 'driver', registration_activated_at: '2026-01-01' },
    driver_card_topup_sandbox_scopes: SCOPE,
    market_payment_routes: ROUTE,
    wallet_topup_fee_schedules: FEE,
    ...overrides,
  };
  const rpcs: Record<string, any> = {
    driver_card_sandbox_enabled: true,
    driver_cash_credit_status_v1f: { driverId: userId, tenantId: tenant, country: 'GB', currency: 'GBP' },
    wallet_currency_minor_exponent: 2,
  };
  return {
    supabaseUrl: 'https://movabi-supabase-develop.apps.evolsolution.com/',
    auth: { getUser: async () => ({ data: { user: { id: userId, email: `${userId}@synthetic.test` } }, error: null }) },
    from: (t: string) => table(tables[t] ?? null),
    rpc: async (fn: string) => ({ data: rpcs[fn] ?? null, error: null }),
  } as any;
}

async function serve(db: any, env: any) {
  const app = express(); app.use(express.json());
  app.use(driverWalletDevelopRouter(db, env, () => { throw new Error('no flutterwave file'); }));
  const s = http.createServer(app);
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() };
}

it('canonical scope authority: designated scoped driver gets availability (NODE_ENV=production)', async () => {
  const { url, close } = await serve(dbFor(DESIGNATED, DESIGNATED_TENANT), baseEnv());
  const r = await fetch(`${url}/availability`, { headers: { authorization: 'Bearer x' } });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
  expect((await r.json()).currency).toBe('GBP');
  close();
});

it('unscoped driver is denied by the scope authority, not a hardcoded id', async () => {
  const { url, close } = await serve(dbFor(UNSCOPED, UNSCOPED_TENANT, { driver_card_topup_sandbox_scopes: null }), baseEnv());
  const r = await fetch(`${url}/availability`, { headers: { authorization: 'Bearer x' } });
  expect((await r.json()).code).toBe('PAYMENT_SANDBOX_REVIEW_REQUIRED');
  close();
});

it('missing/unactivated profile still fails DRIVER_NOT_ELIGIBLE', async () => {
  const { url, close } = await serve(dbFor(DESIGNATED, DESIGNATED_TENANT, { profiles: null }), baseEnv());
  const r = await fetch(`${url}/availability`, { headers: { authorization: 'Bearer x' } });
  expect((await r.json()).code).toBe('DRIVER_NOT_ELIGIBLE');
  close();
});

it('live credentials are rejected at bind time', () => {
  const env = { ...baseEnv(), STRIPE_SECRET_KEY: 'sk_'+'live_'+'a'.repeat(24) };
  expect(() => driverWalletDevelopRouter(dbFor(DESIGNATED, DESIGNATED_TENANT), env, () => { throw new Error('x'); })).toThrow('Develop wallet binding rejected');
  const env2 = { ...baseEnv(), STRIPE_SECRET_KEY_LIVE: 'sk_live_zzz' };
  expect(() => driverWalletDevelopRouter(dbFor(DESIGNATED, DESIGNATED_TENANT), env2, () => { throw new Error('x'); })).toThrow('Develop wallet binding rejected');
});

it('conflicting scope policy fails closed', async () => {
  const bad = { ...SCOPE, policy_version: 'other-version' };
  const { url, close } = await serve(dbFor(DESIGNATED, DESIGNATED_TENANT, { driver_card_topup_sandbox_scopes: bad }), baseEnv());
  const r = await fetch(`${url}/availability`, { headers: { authorization: 'Bearer x' } });
  expect((await r.json()).code).toBe('PAYMENT_SANDBOX_REVIEW_REQUIRED');
  close();
});

it('flutterwave path unchanged: stripe provider unset requires the legacy wallet file', () => {
  const env = baseEnv() as any;
  delete env.VAYDU_DRIVER_TOPUP_PROVIDER;
  env.VAYDU_DRIVER_WALLET_FILE_OWNER_UID = '0';
  let called = false;
  try { driverWalletDevelopRouter(dbFor(DESIGNATED, DESIGNATED_TENANT), env, () => { called = true; return {} as any; }); } catch { /* legacy adapter rejects stub config — the file path is still reached */ }
  expect(called).toBe(true);
});
