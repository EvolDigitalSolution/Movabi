import { describe, expect, it } from 'vitest';
import { CashRideBookingService, StripeCashFeeHold, CASH_FEE_HOLD_VERSION } from '../../server/services/payments/cash-ride-booking';

// Cash Ride booking, phase 2: availability/terms from the market, the card fee hold lifecycle
// (create, resume the SAME hold, verify, atomic activation), ownership and cross-provider safety.
const tenant = '11111111-1111-4111-8111-111111111111', customer = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function world(opts: { marketEnabled?: Record<string, boolean>; routes?: any[]; policy?: any; enabled?: boolean } = {}) {
  const tables: Record<string, any[]> = { cash_ride_fee_holds_v1e: [], market_payment_routes: opts.routes ?? [
    { country_code: 'GB', currency_code: 'GBP', method: 'card', provider: 'stripe', merchant_account_ref: 'stripe-platform', preferred: true, enabled: true, merchant_approved: true, adapter_ready: true, payout_approved: true, capabilities: ['authorise', 'capture', 'release', 'refund', 'retrieve'] },
    { country_code: 'NG', currency_code: 'NGN', method: 'card', provider: 'kora', merchant_account_ref: 'kora-ng', preferred: true, enabled: true, merchant_approved: true, adapter_ready: true, payout_approved: false, capabilities: ['authorise', 'capture', 'release'] },
  ] };
  const rpcCalls: { fn: string; args: any }[] = [];
  let activation = 'activated';
  function qb(table: string) {
    const f: [string, string, unknown][] = []; let patch: any = null; let single = false;
    const match = (r: any) => f.every(([op, k, v]) => op === 'is' ? (r[k] ?? null) === v : r[k] === v);
    const run = () => {
      const list = tables[table] ?? (tables[table] = []);
      const hit = list.filter(match);
      if (patch) { hit.forEach(r => Object.assign(r, patch)); return { data: hit.map(r => ({ ...r })), error: null }; }
      if (single) return { data: hit[0] ? { ...hit[0] } : null, error: null };
      return { data: hit.map(r => ({ ...r })), error: null };
    };
    const o: any = {
      select: () => o, eq: (k: string, v: unknown) => { f.push(['eq', k, v]); return o; }, is: (k: string, v: unknown) => { f.push(['is', k, v]); return o; },
      maybeSingle: () => { single = true; return o; }, update: (p: any) => { patch = p; return o; },
      insert: async (r: any) => { const list = tables[table] ?? (tables[table] = []); if (list.some(x => x.job_id === r.job_id)) return { error: { code: '23505' } }; list.push({ provider_payment_reference: null, ...r }); return { error: null }; },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return o;
  }
  const db = {
    from: qb,
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (fn === 'driver_cash_credit_market_enabled_v1e') return { data: (opts.marketEnabled ?? { 'GB/GBP': true })[args.p_country + '/' + args.p_currency] ?? false, error: null };
      if (fn === 'active_cancellation_policy') return { data: opts.policy ?? null, error: null };
      if (fn === 'activate_cash_ride_v1e') return { data: activation, error: null };
      return { data: null, error: { message: 'unexpected rpc ' + fn } };
    },
  };
  // Stateful Stripe fake (test mode semantics, no network).
  const pis = new Map<string, any>(); const creates: any[] = []; const captures: any[] = []; const cancels: any[] = [];
  const stripe: any = { paymentIntents: {
    create: async (p: any, o: any) => {
      creates.push({ p, key: o?.idempotencyKey });
      const existing = [...pis.values()].find(x => x.key === o?.idempotencyKey); if (existing) return { ...existing };
      const id = 'pi_hold' + (pis.size + 1);
      const pi = { id, key: o?.idempotencyKey, object: 'payment_intent', amount: p.amount, currency: p.currency, capture_method: p.capture_method, metadata: p.metadata, status: 'requires_payment_method', amount_capturable: 0, client_secret: id + '_secret_x' };
      pis.set(id, pi); return { ...pi };
    },
    retrieve: async (id: string) => ({ ...pis.get(id) }),
    capture: async (id: string, p: any, o: any) => { captures.push({ id, p, key: o?.idempotencyKey }); const pi = pis.get(id);
      if (pi.status !== 'requires_capture' || p.amount_to_capture > pi.amount_capturable) throw Object.assign(Error('unexpected_state'), { type: 'StripeInvalidRequestError' });
      Object.assign(pi, { status: 'succeeded', amount_received: p.amount_to_capture, amount_capturable: 0 }); return { ...pi }; },
    cancel: async (id: string, _p: any, o: any) => { cancels.push({ id, key: o?.idempotencyKey }); const pi = pis.get(id);
      if (!['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture'].includes(pi.status)) throw Object.assign(Error('unexpected_state'), { type: 'StripeInvalidRequestError' });
      pi.status = 'canceled'; return { ...pi }; },
  } };
  const svc = new CashRideBookingService({ db: db as any, holdProviders: { stripe: new StripeCashFeeHold(stripe) }, enabled: () => opts.enabled ?? true });
  const authorise = (id: string) => { const pi = pis.get(id); pi.status = 'requires_capture'; pi.amount_capturable = pi.amount; };
  return { svc, tables, rpcCalls, creates, captures, cancels, pis, authorise, setActivation: (v: string) => { activation = v; } };
}
const cashJob = (over: any = {}, holdTerms: any = {}) => ({
  id: jobId, customer_id: customer, tenant_id: tenant, country_code: 'GB', currency_code: 'GBP', status: 'requested', driver_id: null,
  payment_method: 'cash', payment_status: 'cash_due', payment_intent_id: null,
  metadata: { cash_collection_mode: 'full_customer_charge', cash_fee_hold: { version: CASH_FEE_HOLD_VERSION, provider: 'stripe', merchantAccountRef: 'stripe-platform', amountMinor: 500, currency: 'GBP', ...holdTerms } },
  ...over,
});
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return e.code; } };

describe('cash booking terms (server decision per market)', () => {
  it('GB/GBP enabled: hold = larger of no-show fee and late-cancel cap, provider from the market route', async () => {
    const w = world({ policy: { enabled: true, version: 3, fee_minor: 300, fee_cap_minor: 400 } });
    const t = await w.svc.terms({ tenantId: tenant, country: 'gb', currency: 'gbp', service: 'ride', noShowFeeMinor: 500 });
    expect(t).toMatchObject({ provider: 'stripe', merchantAccountRef: 'stripe-platform', amountMinor: 500, currency: 'GBP', lateCancelFeeMinor: 400, cancellationPolicyVersion: 3 });
    const t2 = await world({ policy: { enabled: true, version: 4, fee_minor: 800, fee_cap_minor: null } }).svc.terms({ tenantId: tenant, country: 'GB', currency: 'GBP', service: 'ride', noShowFeeMinor: 500 });
    expect(t2.amountMinor).toBe(800);
  });
  it.each([
    ['feature off', { enabled: false }, { country: 'GB', currency: 'GBP', service: 'ride' }, 'CASH_BOOKING_DISABLED'],
    ['not a ride', {}, { country: 'GB', currency: 'GBP', service: 'delivery' }, 'CASH_RIDE_ONLY'],
    ['market not enabled (NG)', {}, { country: 'NG', currency: 'NGN', service: 'ride' }, 'CASH_MARKET_NOT_ENABLED'],
    // The shared registry keeps Kora/Fincra booking routes disabled (agreed provider direction).
    ['enabled market routed to Kora: registry refuses the booking route', { marketEnabled: { 'NG/NGN': true } }, { country: 'NG', currency: 'NGN', service: 'ride' }, 'CASH_HOLD_ROUTE_UNAVAILABLE'],
    ['enabled market whose valid card route has no hold adapter (Paystack)', { marketEnabled: { 'NG/NGN': true }, routes: [{ country_code: 'NG', currency_code: 'NGN', method: 'card', provider: 'paystack', merchant_account_ref: 'paystack-ng', preferred: true, enabled: true, merchant_approved: true, adapter_ready: true, payout_approved: false, capabilities: ['authorise', 'capture', 'release'] }] }, { country: 'NG', currency: 'NGN', service: 'ride' }, 'CASH_HOLD_PROVIDER_UNAVAILABLE'],
    ['enabled market without a card route', { marketEnabled: { 'KE/KES': true } }, { country: 'KE', currency: 'KES', service: 'ride' }, 'CASH_HOLD_ROUTE_UNAVAILABLE'],
  ])('%s', async (_n, opts, input, expected) => {
    expect(await code(world(opts as any).svc.terms({ tenantId: tenant, noShowFeeMinor: 500, ...input } as any))).toBe(expected);
  });
  it('no fee terms at all means the ride cannot be secured (no zero-amount hold)', async () => {
    expect(await code(world().svc.terms({ tenantId: tenant, country: 'GB', currency: 'GBP', service: 'ride', noShowFeeMinor: 0 }))).toBe('CASH_FEE_TERMS_UNAVAILABLE');
  });
});

describe('card fee hold lifecycle', () => {
  it('creates ONE manual-capture hold for the frozen amount, resumes the same hold, then activates once authorised', async () => {
    const w = world();
    const a = await w.svc.beginHold(cashJob(), customer);
    expect(a).toMatchObject({ jobId, provider: 'stripe', amountMinor: 500, currency: 'GBP' });
    expect(a.clientSecret).toBe('pi_hold1_secret_x');
    expect(w.creates[0].p).toMatchObject({ amount: 500, currency: 'gbp', capture_method: 'manual', payment_method_types: ['card'] });
    expect(w.creates[0].key).toBe(`vaydu-cash-fee-hold:${jobId}:500:GBP`);
    expect(w.tables.cash_ride_fee_holds_v1e).toHaveLength(1);
    expect(w.tables.cash_ride_fee_holds_v1e[0]).toMatchObject({ status: 'created', provider_payment_reference: 'pi_hold1', amount_minor: 500, customer_id: customer });
    // Reload / retry: the SAME hold is resumed; nothing new is created.
    const b = await w.svc.beginHold(cashJob(), customer);
    expect(b.clientSecret).toBe(a.clientSecret); expect(w.creates).toHaveLength(1);
    // Confirming before the customer authorised is refused; no activation is attempted.
    expect(await code(w.svc.confirmHold(cashJob(), customer))).toBe('CASH_HOLD_NOT_AUTHORISED');
    expect(w.rpcCalls.some(c => c.fn === 'activate_cash_ride_v1e')).toBe(false);
    w.authorise('pi_hold1');
    expect(await w.svc.confirmHold(cashJob(), customer)).toBe('activated');
    expect(w.rpcCalls.find(c => c.fn === 'activate_cash_ride_v1e')!.args).toEqual({ p_job_id: jobId, p_customer_id: customer, p_provider: 'stripe',
      p_provider_payment_reference: 'pi_hold1', p_amount_minor: 500, p_currency: 'GBP' });
  });
  it('another customer cannot start or confirm the hold', async () => {
    const w = world();
    expect(await code(w.svc.beginHold(cashJob(), other))).toBe('CASH_JOB_NOT_FOUND');
    await w.svc.beginHold(cashJob(), customer); w.authorise('pi_hold1');
    expect(await code(w.svc.confirmHold(cashJob(), other))).toBe('CASH_JOB_NOT_FOUND');
    expect(w.creates).toHaveLength(1);
  });
  it.each([
    ['card job', { payment_method: 'card', payment_status: 'pending' }, {}, 'CASH_JOB_NOT_CASH'],
    ['cash job with a PaymentIntent', { payment_intent_id: 'pi_x' }, {}, 'CASH_JOB_NOT_CASH'],
    ['tampered hold currency', {}, { currency: 'EUR' }, 'CASH_HOLD_TERMS_INVALID'],
    ['zero hold', {}, { amountMinor: 0 }, 'CASH_HOLD_TERMS_INVALID'],
    ['already searching', { status: 'searching' }, {}, 'CASH_HOLD_NOT_NEEDED'],
    ['provider without a hold adapter (cross-provider)', {}, { provider: 'kora' }, 'CASH_HOLD_PROVIDER_UNAVAILABLE'],
  ])('refuses: %s', async (_n, over, hold, expected) => {
    const w = world();
    expect(await code(w.svc.beginHold(cashJob(over, hold), customer))).toBe(expected);
    expect(w.creates).toHaveLength(0);
  });
  it('market disabled after booking: no hold is started', async () => {
    const w = world({ marketEnabled: { 'GB/GBP': false } });
    expect(await code(w.svc.beginHold(cashJob(), customer))).toBe('CASH_MARKET_NOT_ENABLED');
    expect(w.creates).toHaveLength(0);
  });
  it('a provider hold that does not match the frozen terms is never activated', async () => {
    const w = world();
    await w.svc.beginHold(cashJob(), customer);
    const pi = w.pis.get('pi_hold1'); pi.status = 'requires_capture'; pi.amount_capturable = 400; // partial authorisation
    expect(await code(w.svc.confirmHold(cashJob(), customer))).toBe('CASH_HOLD_NOT_AUTHORISED');
    pi.amount_capturable = 500; pi.metadata = { ...pi.metadata, vaydu_cash_fee_hold: 'another-job' };
    expect(await code(w.svc.confirmHold(cashJob(), customer))).toBe('CASH_HOLD_UNCONFIRMED');
    expect(w.rpcCalls.some(c => c.fn === 'activate_cash_ride_v1e')).toBe(false);
  });
  it('activation refused by the database is reported, not treated as success; a repeat is idempotent', async () => {
    const w = world();
    await w.svc.beginHold(cashJob(), customer); w.authorise('pi_hold1');
    w.setActivation('not_activatable');
    expect(await code(w.svc.confirmHold(cashJob(), customer))).toBe('CASH_ACTIVATION_REFUSED');
    w.setActivation('already_activated');
    expect(await w.svc.confirmHold(cashJob(), customer)).toBe('already_activated');
  });
});

describe('fee hold settlement (completion, no-show, cancellation, no driver)', () => {
  async function authorisedHold() { const w = world(); await w.svc.beginHold(cashJob(), customer); w.authorise('pi_hold1'); await w.svc.confirmHold(cashJob(), customer); w.tables.cash_ride_fee_holds_v1e[0].status = 'authorized'; return w; }
  it('completion / early cancellation / no driver: releases the hold once; nothing is charged', async () => {
    const w = await authorisedHold();
    expect(await w.svc.releaseHold(jobId)).toBe('released');
    expect(w.pis.get('pi_hold1').status).toBe('canceled'); expect(w.captures).toHaveLength(0);
    expect(w.cancels).toEqual([{ id: 'pi_hold1', key: `vaydu-cash-fee-release:${jobId}` }]);
    expect(w.tables.cash_ride_fee_holds_v1e[0].status).toBe('released');
    expect(await w.svc.releaseHold(jobId)).toBe('released'); expect(w.cancels).toHaveLength(1);
    expect(await w.svc.releaseHold('ffffffff-ffff-4fff-8fff-ffffffffffff')).toBe('no_hold');
  });
  it('a hold the customer never authorised is released too', async () => {
    const w = world(); await w.svc.beginHold(cashJob(), customer);
    expect(await w.svc.releaseHold(jobId)).toBe('released'); expect(w.pis.get('pi_hold1').status).toBe('canceled');
  });
  it('no-show / late cancellation: captures exactly the fee once; a repeat does not charge again', async () => {
    const w = await authorisedHold();
    expect(await w.svc.captureFee(jobId, 250, `no-show-capture-${jobId}`)).toBe('captured');
    expect(w.captures).toEqual([{ id: 'pi_hold1', p: { amount_to_capture: 250 }, key: `no-show-capture-${jobId}` }]);
    expect(w.pis.get('pi_hold1')).toMatchObject({ status: 'succeeded', amount_received: 250 });
    expect(w.tables.cash_ride_fee_holds_v1e[0]).toMatchObject({ status: 'captured', captured_minor: 250 });
    expect(await w.svc.captureFee(jobId, 250, `no-show-capture-${jobId}`)).toBe('captured'); expect(w.captures).toHaveLength(1);
    expect(await code(w.svc.captureFee(jobId, 300, 'k'))).toBe('CASH_HOLD_CAPTURE_UNCONFIRMED');
    // A captured hold is never "released" afterwards.
    expect(await w.svc.releaseHold(jobId)).toBe('captured'); expect(w.cancels).toHaveLength(0);
  });
  it('refuses a fee above the hold, a zero fee, or an unauthorised hold', async () => {
    const w = await authorisedHold();
    expect(await code(w.svc.captureFee(jobId, 501, 'k'))).toBe('CASH_FEE_EXCEEDS_HOLD');
    expect(await code(w.svc.captureFee(jobId, 0, 'k'))).toBe('CASH_FEE_EXCEEDS_HOLD');
    const w2 = world(); await w2.svc.beginHold(cashJob(), customer);
    expect(await code(w2.svc.captureFee(jobId, 100, 'k'))).toBe('CASH_HOLD_NOT_AUTHORISED');
    expect(w.captures).toHaveLength(0); expect(w2.captures).toHaveLength(0);
  });
  it('a provider hold that already succeeded is reported, not cancelled', async () => {
    const w = await authorisedHold();
    Object.assign(w.pis.get('pi_hold1'), { status: 'succeeded', amount_received: 500 });
    expect(await code(w.svc.releaseHold(jobId))).toBe('CASH_HOLD_ALREADY_CAPTURED');
    expect(w.tables.cash_ride_fee_holds_v1e[0].status).toBe('authorized');
  });
});
