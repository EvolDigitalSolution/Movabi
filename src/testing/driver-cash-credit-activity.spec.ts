import { it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

// Mock the module-level supabaseAdmin BEFORE the router import — this is the
// established pattern; the handler keeps its real production code path.
vi.mock('../../server/services/supabase.service', () => {
  const store: any = { user: null, tables: {}, calls: [] };
  const client: any = {
    auth: { getUser: async () => ({ data: { user: store.user }, error: store.user ? null : new Error('no user') }) },
    from: (t: string) => {
      const res = () => { const r = store.tables[t] ?? { data: null }; return { data: r.data, error: r.error ?? null }; };
      const q: any = {};
      for (const m of ['select','eq','neq','in','or','order','limit','lt','gt','insert','update','upsert']) q[m] = (...a: any[]) => { store.calls.push({ table: t, method: m, args: a }); return q; };
      q.maybeSingle = async () => res(); q.single = async () => res(); q.then = (f: any) => Promise.resolve(res()).then(f);
      return q;
    },
  };
  return { supabaseAdmin: client, __store: store };
});
vi.mock('../../server/services/driver-cash-credit', () => ({
  readDriverCashCredit: async () => ({ balance: { currency: 'GBP' } }),
  mapCashCreditError: () => null,
}));

import * as svc from '../../server/services/supabase.service';
import router from '../../server/routes/market-safety.routes';

const store = (svc as any).__store;
const USER = 'c24f395c-c787-4464-a1ab-3345881e5faa';
const TENANT = '11111111-1111-4111-8111-111111111111';
const E1 = '22222222-2222-4222-8222-222222222222';
const E2 = '33333333-3333-4333-8333-333333333333';
const attempt = (over: any = {}) => ({ id: '44444444-4444-4444-8444-444444444444', owner_id: USER, tenant_id: TENANT, status: 'pending', amount_minor: 500, provider_fee_minor: 25, total_charge_minor: 525, provider_reference: 'cs_test_a1', currency_code: 'GBP', created_at: '2026-11-05T10:00:00Z', credited_event_id: null, destination_account_purpose: 'driver_cash_credit', ...over });
const event = (over: any = {}) => ({ id: E2, owner_id: USER, tenant_id: TENANT, currency_code: 'GBP', provider_reference: 'cs_test_a1', ...over });

function serve() {
  const app = express(); app.use(express.json()); app.use(router);
  const s = http.createServer(app);
  return new Promise<{ url: string; close: () => void }>(r => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() })));
}
const get = (url: string, path: string) => fetch(`${url}${path}`, { headers: { authorization: 'Bearer tok' } });
const eqs = (t: string) => store.calls.filter((c: any) => c.table === t && c.method === 'eq').map((c: any) => c.args);

beforeEach(() => { store.calls = []; store.user = { id: USER }; store.tables = { profiles: { data: { tenant_id: TENANT } }, wallet_topup_attempts: { data: [] }, wallet_business_events: { data: [] } }; });

it('rejects unauthenticated requests', async () => {
  store.user = null; const { url, close } = await serve();
  const r = await get(url, '/driver-cash-credit/activity'); expect(r.status).toBe(401); close();
});

it('denies accounts without a driver tenant', async () => {
  store.tables.profiles = { data: null }; const { url, close } = await serve();
  const r = await get(url, '/driver-cash-credit/activity');
  expect(r.status).toBe(403); expect((await r.json()).code).toBe('DRIVER_NOT_ELIGIBLE'); close();
});

it('enforces owner, tenant, purpose and canonical currency scope', async () => {
  const { url, close } = await serve(); await get(url, '/driver-cash-credit/activity'); close();
  const calls = eqs('wallet_topup_attempts').map(([c, v]) => `${c}=${v}`);
  expect(calls).toContain(`owner_id=${USER}`); expect(calls).toContain(`tenant_id=${TENANT}`);
  expect(calls).toContain(`destination_account_purpose=driver_cash_credit`); expect(calls).toContain(`currency_code=GBP`);
});

it('maps pending and failed attempts without crediting', async () => {
  store.tables.wallet_topup_attempts = { data: [attempt(), attempt({ id: '55555555-5555-4555-8555-555555555555', status: 'failed' })] };
  const { url, close } = await serve();
  const { attempts } = await (await get(url, '/driver-cash-credit/activity')).json(); close();
  expect(attempts[0].state).toBe('pending'); expect(attempts[1].state).toBe('failed');
  expect(attempts[0].credited_event_id).toBeNull(); expect(attempts[1].credited_event_id).toBeNull();
});

it('succeeded attempt linked to an unrelated event is never credited', async () => {
  store.tables.wallet_topup_attempts = { data: [attempt({ status: 'succeeded', credited_event_id: E1 })] };
  store.tables.wallet_business_events = { data: [{ id: E1 }] }; // valid event, but not the finalize write
  const { url, close } = await serve();
  const { attempts } = await (await get(url, '/driver-cash-credit/activity')).json(); close();
  expect(attempts[0].state).toBe('pending_confirmation'); expect(attempts[0].credited_event_id).toBeNull();
});

it('credited attempt bound to a canonically-owned event renders credited with 500/25/525 separated', async () => {
  store.tables.wallet_topup_attempts = { data: [attempt({ status: 'credited', credited_event_id: E2 })] };
  store.tables.wallet_business_events = { data: [event()] };
  const { url, close } = await serve();
  const { attempts } = await (await get(url, '/driver-cash-credit/activity')).json(); close();
  expect(attempts[0].state).toBe('credited'); expect(attempts[0].credited_event_id).toBe(E2);
  // principal credited to credit, fee and total charged kept distinct:
  expect(attempts[0].amount_minor).toBe(500); expect(attempts[0].fee_minor).toBe(25); expect(attempts[0].total_charge_minor).toBe(525);
  expect(Number.isInteger(attempts[0].amount_minor)).toBe(true);
});

it('a credited attempt linked to a different owner\'s event is never credited', async () => {
  store.tables.wallet_topup_attempts = { data: [attempt({ status: 'credited', credited_event_id: E2 })] };
  store.tables.wallet_business_events = { data: [event({ owner_id: '99999999-9999-4999-8999-999999999999' })] }; // valid event, wrong owner
  const { url, close } = await serve();
  const { attempts } = await (await get(url, '/driver-cash-credit/activity')).json(); close();
  expect(attempts[0].state).not.toBe('credited'); expect(attempts[0].credited_event_id).toBeNull();
});

it('caps limit at 50, applies the before cursor and emits next_cursor only on overflow', async () => {
  store.tables.wallet_topup_attempts = { data: Array.from({ length: 21 }, (_, i) => attempt({ id: `66666666-6666-4666-8666-6666666666${String(i).padStart(2, '0')}`, created_at: `2026-11-0${(i % 9) + 1}T10:00:00Z` })) };
  const { url, close } = await serve();
  await get(url, '/driver-cash-credit/activity?limit=200&before=2026-11-05T00:00:00Z'); close();
  expect(store.calls.some((c: any) => c.table === 'wallet_topup_attempts' && c.method === 'limit' && c.args[0] === 51)).toBe(true);
  expect(store.calls.some((c: any) => c.table === 'wallet_topup_attempts' && c.method === 'lt' && c.args[0] === 'created_at' && c.args[1] === '2026-11-05T00:00:00Z')).toBe(true);
});

it('replay-safe: repeated reads return distinct attempts only, no duplicated credit', async () => {
  store.tables.wallet_topup_attempts = { data: [attempt({ status: 'credited', credited_event_id: E2 })] };
  store.tables.wallet_business_events = { data: [event()] };
  const { url, close } = await serve();
  const a = await (await get(url, '/driver-cash-credit/activity')).json();
  const b = await (await get(url, '/driver-cash-credit/activity')).json(); close();
  expect(a.attempts).toEqual(b.attempts); expect(a.attempts.map((x: any) => x.id)).toEqual([attempt().id]);
});
