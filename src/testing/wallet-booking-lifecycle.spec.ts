import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (file: string) => fs.readFileSync(file, 'utf8');
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
function policies() {
  const source = read('src/app/core/services/booking/booking.service.ts');
  const start = source.indexOf('    getBookingLifecycleState(');
  const end = source.indexOf('    async getServiceTypes()', start);
  return vm.runInNewContext(compile('class Policies {\n' + source.slice(start, end) + '\n}\nnew Policies()'));
}
function loadModule(file: string, dependencies: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  vm.runInNewContext(compile(read(file)), {
    exports, require: (name: string) => {
      if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
      return dependencies[name];
    }, console: { log() {}, warn() {}, error() {} }, Date, Set, Math
  });
  return exports;
}

describe('wallet booking routing', () => {
  for (const status of ['cancelled', 'canceled', 'expired', 'failed', 'no_driver_found']) {
    it(`${status} stays visible and cannot reopen Marketplace`, () => {
      const p = policies();
      const job = { status, payment_method: 'wallet', payment_status: 'cancelled' };
      expect(p.getBookingLifecycleState(job)).toBe('cancelled');
      expect(p.isVisibleActivityBooking(job)).toBe(true);
      expect(p.isPendingMarketplaceBooking(job)).toBe(false);
    });
  }
  for (const status of ['pending', 'requested', 'pending_fare_confirmation', 'negotiating', 'fare_agreed', 'searching']) {
    it(`funded ${status} goes to tracking`, () => {
      const p = policies(); const job = { status, payment_status: 'wallet_funded' };
      expect(p.getBookingLifecycleState(job)).toBe('paid_ready_for_dispatch');
      expect(p.isPendingMarketplaceBooking(job)).toBe(false);
    });
  }
  it('unpaid negotiation remains in Marketplace', () => {
    const p = policies();
    expect(p.isPendingMarketplaceBooking({ status: 'pending_fare_confirmation', payment_status: 'pending' })).toBe(true);
    expect(p.isPendingMarketplaceBooking({ status: 'fare_agreed', payment_status: 'pending' })).toBe(true);
  });
});

describe('authoritative shopping budget', () => {
  function authority(funding: any, details: any, error?: any) {
    const db = { from: (table: string) => {
      const chain: any = { select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: table === 'errand_funding' ? funding : details, error: table === 'errand_funding' ? error : null }) };
      return chain;
    } };
    return loadModule('server/services/payment-authority.service.ts', { './supabase.service': { supabaseAdmin: db } }).PaymentAuthorityService;
  }
  const job = { status: 'requested', total_price: 10, service_type: { slug: 'errand' }, currency_code: 'GBP' };
  it('funded total is not counted as item budget again', async () => {
    const a = await authority({ item_budget: 20, amount_reserved: 30, status: 'reserved' }, { estimated_budget: 20 }).resolve(job);
    expect(a.totalAuthorisationMajor).toBe(30);
    expect(a.serviceFareMajor).toBe(10);
    expect(a.itemBudgetMajor).toBe(20);
  });
  it('preserves pending legacy item budget', async () => {
    expect((await authority({ amount_reserved: 20, status: 'pending' }, {}).resolve(job)).totalAuthorisationMajor).toBe(30);
  });
  it('uses details for legacy funded rows without budget fields', async () => {
    expect((await authority({ amount_reserved: 30, status: 'reserved' }, { estimated_budget: 20 }).resolve(job)).totalAuthorisationMajor).toBe(30);
  });
  it('budget lookup failure cannot silently undercharge', async () => {
    await expect(authority(null, null, { message: 'Database unavailable' }).resolve(job)).rejects.toThrow('Unable to verify');
  });
});

describe('wallet API activation', () => {
  async function run({ actor = 'customer', data = { status: 'paid' } as any, error = null as any } = {}) {
    const routes: Record<string, any> = {}; const rpcCalls: any[] = []; const notifications: any[] = [];
    const job = { id: 'job', customer_id: 'customer', tenant_id: 'tenant', payment_status: 'pending', total_price: 30,
      currency_code: 'GBP', status: 'searching', driver_id: null, metadata: { quote_id: 'quote', quote_expires_at: new Date(Date.now() + 60000).toISOString() }, fare_breakdown: { calculationVersion: 'fixture' } };
    const db = { auth: { getUser: async () => ({ data: { user: { id: actor } } }) }, rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args }); return { data, error };
    }, from: () => { const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: job, error: null }) }; return chain; } };
    const dependencies = {
      express: { Router: () => ({ get() {}, post: (path: string, fn: any) => routes[path] = fn }) },
      '../services/supabase.service': { supabaseAdmin: db },
      '../services/payment-authority.service': { PaymentAuthorityService: { resolve: async () => ({ totalAuthorisationMajor: 30 }) } },
      '../services/issuing-capacity.service': { IssuingCapacityService: { assertAvailable: async () => {} } },
      '../services/dispatch.service': { dispatchService: { notifyNearbyDrivers: async (...args: any[]) => notifications.push(args) } },
      '../services/market-availability.service': { MarketAvailabilityService: { requireCapability: async () => {} }, MarketAvailabilityError: class extends Error {} }
    };
    loadModule('server/routes/wallet.routes.ts', dependencies);
    const response: any = { code: 200, body: null, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    await routes['/pay-job']({ auth: { user: { id: actor } }, body: { userId: 'customer', jobId: 'job', amount: 99999 } }, response);
    return { response, rpcCalls, notifications };
  }
  it('derives amount on server and announces committed activation', async () => {
    const r = await run(); expect(r.response.code).toBe(200);
    expect(r.rpcCalls[0].args.p_amount).toBe(30); expect(r.notifications).toHaveLength(1);
  });
  it('another customer cannot reserve funds', async () => {
    const r = await run({ actor: 'other' }); expect(r.response.code).toBe(403); expect(r.rpcCalls).toHaveLength(0);
  });
  it('failed activation is not announced as searching', async () => {
    const r = await run({ error: { message: 'agreement_lost' } }); expect(r.response.code).toBe(400); expect(r.notifications).toHaveLength(0);
  });
  it('repeat payment does not send another notification', async () => {
    const r = await run({ data: { status: 'already_paid' } }); expect(r.response.code).toBe(200); expect(r.notifications).toHaveLength(0);
  });
});
