import type Stripe from 'stripe';
import { PaymentLayerError } from './payment-contracts';
import { loadDatabasePaymentPolicies } from './market-payment-store';
import { selectMarketPayment } from './market-payment-registry';

/**
 * Cash Ride booking (pilot markets only). The customer pays the driver in cash; the booking is
 * secured by an on-session card HOLD (manual-capture authorisation) for its fee terms: the larger
 * of the disclosed no-show fee and the market's late-cancellation cap. The hold provider comes
 * from the market's card payment route; a provider is usable only if it has a hold adapter.
 * Nothing here charges a card: capture/release belong to completion, no-show and cancellation.
 */
export const CASH_FEE_HOLD_VERSION = 'cash-fee-hold-v1';
const fail = (code: string, message = 'Cash booking unavailable'): never => { throw new PaymentLayerError(code, message); };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const minor = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export interface CashFeeHoldInput { jobId: string; customerId: string; merchantAccountRef: string; amountMinor: number; currency: string; }
/** Provider boundary: each provider implements its own authorisation hold. */
export interface CashFeeHoldProvider {
  readonly provider: string;
  /** Creates (idempotently per job/amount/currency) the hold the customer must authorise on-session. */
  create(input: CashFeeHoldInput): Promise<{ reference: string; clientSecret: string }>;
  /** Re-issues the client secret of the SAME hold, only while it still needs the customer. */
  resume(reference: string, input: CashFeeHoldInput): Promise<{ clientSecret: string }>;
  /** Throws unless the hold is exactly this job's, authorised and fully capturable. */
  verifyAuthorised(reference: string, input: CashFeeHoldInput): Promise<void>;
  /** Captures exactly amountMinor (<= the hold) once; the rest of the authorisation is released. */
  capture(reference: string, input: CashFeeHoldInput, amountMinor: number, idempotencyKey: string): Promise<void>;
  /** Releases an uncaptured hold so nothing can be charged later. */
  release(reference: string, input: CashFeeHoldInput): Promise<void>;
  /** Read-only: the hold's provider intent after capture, only if it is exactly this job's hold. */
  inspectCaptured?(reference: string, input: CashFeeHoldInput): Promise<unknown>;
}

export class StripeCashFeeHold implements CashFeeHoldProvider {
  readonly provider = 'stripe';
  constructor(private readonly stripe: Stripe) {}
  private matches(pi: Stripe.PaymentIntent, input: CashFeeHoldInput) {
    return pi.amount === input.amountMinor && pi.currency === input.currency.toLowerCase() && pi.capture_method === 'manual'
      && pi.metadata?.vaydu_cash_fee_hold === input.jobId && pi.metadata?.vaydu_customer === input.customerId
      && pi.metadata?.vaydu_merchant === input.merchantAccountRef && pi.metadata?.vaydu_hold_version === CASH_FEE_HOLD_VERSION;
  }
  async create(input: CashFeeHoldInput) {
    const pi = await this.stripe.paymentIntents.create({
      amount: input.amountMinor, currency: input.currency.toLowerCase(), capture_method: 'manual', payment_method_types: ['card'],
      metadata: { vaydu_cash_fee_hold: input.jobId, vaydu_customer: input.customerId, vaydu_merchant: input.merchantAccountRef, vaydu_hold_version: CASH_FEE_HOLD_VERSION },
    }, { idempotencyKey: `vaydu-cash-fee-hold:${input.jobId}:${input.amountMinor}:${input.currency}` });
    if (!this.matches(pi, input) || typeof pi.client_secret !== 'string' || !pi.client_secret.startsWith(pi.id + '_secret_')) fail('CASH_HOLD_UNCONFIRMED', 'Card hold needs reconciliation');
    return { reference: pi.id, clientSecret: pi.client_secret! };
  }
  async resume(reference: string, input: CashFeeHoldInput) {
    const pi = await this.stripe.paymentIntents.retrieve(reference);
    if (!this.matches(pi, input)) fail('CASH_HOLD_UNCONFIRMED', 'Card hold needs reconciliation');
    if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status) || typeof pi.client_secret !== 'string')
      fail('CASH_HOLD_NOT_RESUMABLE', 'This card hold cannot be continued');
    return { clientSecret: pi.client_secret! };
  }
  async verifyAuthorised(reference: string, input: CashFeeHoldInput) {
    const pi = await this.stripe.paymentIntents.retrieve(reference);
    if (!this.matches(pi, input)) fail('CASH_HOLD_UNCONFIRMED', 'Card hold needs reconciliation');
    if (pi.status !== 'requires_capture' || pi.amount_capturable !== input.amountMinor) fail('CASH_HOLD_NOT_AUTHORISED', 'The card hold has not been authorised');
  }
  async capture(reference: string, input: CashFeeHoldInput, amountMinor: number, idempotencyKey: string) {
    let pi = await this.stripe.paymentIntents.retrieve(reference);
    if (!this.matches(pi, input)) fail('CASH_HOLD_UNCONFIRMED', 'Card hold needs reconciliation');
    if (pi.status === 'requires_capture') {
      pi = await this.stripe.paymentIntents.capture(reference, { amount_to_capture: amountMinor }, { idempotencyKey });
    }
    // A repeat after a lost response finds the same capture; any other amount needs review.
    if (pi.status !== 'succeeded' || pi.amount_received !== amountMinor) fail('CASH_HOLD_CAPTURE_UNCONFIRMED', 'Fee capture requires reconciliation');
  }
  async inspectCaptured(reference: string, input: CashFeeHoldInput) {
    const pi = await this.stripe.paymentIntents.retrieve(reference);
    if (!this.matches(pi, input) || pi.status !== 'succeeded') fail('CASH_HOLD_CAPTURE_UNCONFIRMED', 'Fee capture requires reconciliation');
    return pi;
  }
  async release(reference: string, input: CashFeeHoldInput) {
    let pi = await this.stripe.paymentIntents.retrieve(reference);
    if (!this.matches(pi, input)) fail('CASH_HOLD_UNCONFIRMED', 'Card hold needs reconciliation');
    if (pi.status === 'canceled') return;
    if (pi.status === 'succeeded' || pi.status === 'processing') fail('CASH_HOLD_ALREADY_CAPTURED', 'The card hold was already captured');
    pi = await this.stripe.paymentIntents.cancel(reference, { cancellation_reason: 'abandoned' }, { idempotencyKey: `vaydu-cash-fee-release:${input.jobId}` });
    if (pi.status !== 'canceled') fail('CASH_HOLD_RELEASE_UNCONFIRMED', 'Hold release requires reconciliation');
  }
}

/** NG flow: the fee exposure is reserved in the customer's wallet (no card provider).
 * All balance movement is atomic and idempotent inside the DB functions; this
 * adapter only maps the hold contract. */
export class WalletCashFeeHold implements CashFeeHoldProvider {
  readonly provider = 'customer_wallet';
  constructor(private readonly db: CashBookingDeps['db']) {}
  private async call(fn: string, args: Record<string, unknown>) {
    const r = await this.db.rpc(fn, args);
    if (r.error) {
      const code = String(r.error.code || '');
      if (code === 'WH004') fail('CASH_WALLET_INSUFFICIENT', 'Your wallet balance cannot cover the cash fee reservation');
      if (code === 'WH003') fail('CASH_WALLET_MISSING', 'A wallet in this currency is required for a cash ride');
      fail('CASH_HOLD_UNCONFIRMED', 'Wallet reservation needs reconciliation');
    }
    return r.data;
  }
  async create(input: CashFeeHoldInput) {
    const ref = await this.call('cash_wallet_reserve_hold', { p_job_id: input.jobId, p_customer_id: input.customerId, p_amount_minor: input.amountMinor, p_currency: input.currency });
    if (typeof ref !== 'string' || ref !== 'wres:' + input.jobId) fail('CASH_HOLD_UNCONFIRMED', 'Wallet reservation needs reconciliation');
    return { reference: ref, clientSecret: 'wres-client:' + ref };
  }
  async resume(reference: string, input: CashFeeHoldInput) {
    if (reference !== 'wres:' + input.jobId) fail('CASH_HOLD_UNCONFIRMED', 'Wallet reservation needs reconciliation');
    const status = await this.call('cash_wallet_hold_status', { p_job_id: input.jobId });
    if (status !== 'reserved') fail('CASH_HOLD_NOT_RESUMABLE', 'This wallet reservation cannot be continued');
    return { clientSecret: 'wres-client:' + reference };
  }
  async verifyAuthorised(reference: string, input: CashFeeHoldInput) {
    if (reference !== 'wres:' + input.jobId) fail('CASH_HOLD_UNCONFIRMED', 'Wallet reservation needs reconciliation');
    const status = await this.call('cash_wallet_hold_status', { p_job_id: input.jobId });
    if (status !== 'reserved') fail('CASH_HOLD_NOT_AUTHORISED', 'The wallet fee reservation is not in place');
  }
  async capture(reference: string, input: CashFeeHoldInput, amountMinor: number, _idempotencyKey: string) {
    if (reference !== 'wres:' + input.jobId) fail('CASH_HOLD_UNCONFIRMED', 'Wallet reservation needs reconciliation');
    await this.call('cash_wallet_capture_hold', { p_job_id: input.jobId, p_reference: reference, p_amount_minor: amountMinor });
    if (await this.call('cash_wallet_hold_status', { p_job_id: input.jobId }) !== 'captured') fail('CASH_HOLD_CAPTURE_UNCONFIRMED', 'Fee capture requires reconciliation');
  }
  async inspectCaptured(reference: string, input: CashFeeHoldInput) {
    if (reference !== 'wres:' + input.jobId || await this.call('cash_wallet_hold_status', { p_job_id: input.jobId }) !== 'captured')
      fail('CASH_HOLD_CAPTURE_UNCONFIRMED', 'Fee capture requires reconciliation');
    return { provider: 'customer_wallet', reference, status: 'captured' };
  }
  async release(reference: string, input: CashFeeHoldInput) {
    if (reference !== 'wres:' + input.jobId) fail('CASH_HOLD_UNCONFIRMED', 'Wallet reservation needs reconciliation');
    await this.call('cash_wallet_release_hold', { p_job_id: input.jobId, p_reference: reference });
    const status = await this.call('cash_wallet_hold_status', { p_job_id: input.jobId });
    if (status !== 'released' && status !== 'captured') fail('CASH_HOLD_RELEASE_UNCONFIRMED', 'Hold release requires reconciliation');
  }
}

export interface CashBookingTerms {
  available: true; version: string; provider: string; merchantAccountRef: string; amountMinor: number; currency: string;
  noShowFeeMinor: number; lateCancelFeeMinor: number; cancellationPolicyVersion: number | null;
}
export interface CashBookingDeps {
  db: { rpc(fn: string, args: Record<string, unknown>): Promise<{ data: any; error: any }>; from(table: string): any };
  holdProviders: Record<string, CashFeeHoldProvider>;
  enabled: () => boolean;
}

export class CashRideBookingService {
  constructor(private readonly deps: CashBookingDeps) {}

  /** Server decision for one booking: pilot market, Ride, hold route and frozen fee terms. */
  async terms(input: { tenantId: string; country: string; currency: string; service: string; noShowFeeMinor: number }): Promise<CashBookingTerms> {
    if (!this.deps.enabled()) fail('CASH_BOOKING_DISABLED', 'Cash booking is not enabled');
    if (input.service !== 'ride') fail('CASH_RIDE_ONLY', 'Cash is available for rides only');
    const country = String(input.country || '').toUpperCase(), currency = String(input.currency || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency) || !uuid(input.tenantId) || !minor(input.noShowFeeMinor)) fail('CASH_MARKET_UNAVAILABLE');
    const enabled = await this.deps.db.rpc('driver_cash_credit_market_enabled_v1e', { p_country: country, p_currency: currency });
    if (enabled.error || enabled.data !== true) fail('CASH_MARKET_NOT_ENABLED', 'Cash rides are not available in this market');
    // Market-specific security: card_hold keeps the on-session card hold;
    // wallet_reservation (NG) secures the exposure from the customer's wallet instead.
    const modeRow = await this.deps.db.rpc('cash_market_security_mode_v1e', { p_country: country, p_currency: currency });
    const mode = modeRow.error ? 'card_hold' : String(modeRow.data || 'card_hold');
    let route: { provider: string; merchantAccountRef: string };
    if (mode === 'wallet_reservation') {
      if (!this.deps.holdProviders['customer_wallet']) fail('CASH_HOLD_PROVIDER_UNAVAILABLE', 'Wallet reservation is not available in this market');
      route = { provider: 'customer_wallet', merchantAccountRef: 'customer-wallet:' + country + '/' + currency };
    } else {
      try {
        route = selectMarketPayment({ countryCode: country, currency, paymentEnabled: true },
          await loadDatabasePaymentPolicies(this.deps.db, { country, currency, method: 'card' } as any), 'card', ['authorise', 'capture', 'release']);
      } catch { return fail('CASH_HOLD_ROUTE_UNAVAILABLE', 'A card hold is not available in this market'); }
      if (!this.deps.holdProviders[route.provider]) fail('CASH_HOLD_PROVIDER_UNAVAILABLE', 'A card hold is not available in this market');
    }
    const policy = await this.deps.db.rpc('active_cancellation_policy', { p_tenant: input.tenantId, p_market: country });
    if (policy.error) fail('CASH_FEE_TERMS_UNAVAILABLE', 'Cancellation terms could not be loaded');
    const p = Array.isArray(policy.data) ? policy.data[0] : policy.data;
    const lateCancel = p?.enabled ? Number(p.fee_cap_minor ?? p.fee_minor ?? 0) : 0;
    if (!minor(lateCancel)) fail('CASH_FEE_TERMS_UNAVAILABLE', 'Cancellation terms are invalid');
    const amountMinor = Math.max(input.noShowFeeMinor, lateCancel);
    if (amountMinor <= 0) fail('CASH_FEE_TERMS_UNAVAILABLE', 'No fee terms apply, so a cash ride cannot be secured');
    return { available: true, version: CASH_FEE_HOLD_VERSION, provider: route.provider, merchantAccountRef: route.merchantAccountRef, amountMinor, currency,
      noShowFeeMinor: input.noShowFeeMinor, lateCancelFeeMinor: lateCancel, cancellationPolicyVersion: p?.enabled ? Number(p.version) : null };
  }

  /** Frozen hold terms of a cash job, validated against the job itself. */
  private frozen(job: any, customerId: string): CashFeeHoldInput & { provider: string } {
    const t = job?.metadata?.cash_fee_hold;
    if (!job || job.customer_id !== customerId) fail('CASH_JOB_NOT_FOUND', 'Booking not found');
    if (job.payment_method !== 'cash' || job.payment_status !== 'cash_due' || job.metadata?.cash_collection_mode !== 'full_customer_charge' || job.payment_intent_id)
      fail('CASH_JOB_NOT_CASH', 'This booking is not a cash ride');
    if (!t || t.version !== CASH_FEE_HOLD_VERSION || typeof t.provider !== 'string' || typeof t.merchantAccountRef !== 'string' || !t.merchantAccountRef
      || !minor(t.amountMinor) || t.amountMinor <= 0 || t.currency !== String(job.currency_code || '').toUpperCase()) fail('CASH_HOLD_TERMS_INVALID', 'Card hold terms need review');
    return { jobId: job.id, customerId, provider: t.provider, merchantAccountRef: t.merchantAccountRef, amountMinor: t.amountMinor, currency: t.currency };
  }
  private holdProvider(provider: string) { return this.deps.holdProviders[provider] ?? fail('CASH_HOLD_PROVIDER_UNAVAILABLE', 'A card hold is not available'); }

  /** Starts (or continues) the card hold for a cash ride. Never charges. */
  async beginHold(job: any, customerId: string): Promise<{ jobId: string; provider: string; clientSecret: string; amountMinor: number; currency: string }> {
    const f = this.frozen(job, customerId);
    if (job.status !== 'requested' || job.driver_id) fail('CASH_HOLD_NOT_NEEDED', 'This booking is already active');
    const enabled = await this.deps.db.rpc('driver_cash_credit_market_enabled_v1e', { p_country: job.country_code, p_currency: job.currency_code });
    if (enabled.error || enabled.data !== true) fail('CASH_MARKET_NOT_ENABLED', 'Cash rides are not available in this market');
    const adapter = this.holdProvider(f.provider);
    const row = { job_id: f.jobId, tenant_id: job.tenant_id, customer_id: customerId, provider: f.provider, merchant_account_ref: f.merchantAccountRef,
      amount_minor: f.amountMinor, currency_code: f.currency, fee_terms: job.metadata.cash_fee_hold, status: 'created' };
    const inserted = await this.deps.db.from('cash_ride_fee_holds_v1e').insert(row);
    if (inserted.error && inserted.error.code !== '23505') fail('CASH_HOLD_UNAVAILABLE', 'Card hold could not be started');
    const current = await this.deps.db.from('cash_ride_fee_holds_v1e').select('*').eq('job_id', f.jobId).maybeSingle();
    const h = current.data;
    if (current.error || !h || h.customer_id !== customerId || h.provider !== f.provider || h.amount_minor !== f.amountMinor || h.currency_code !== f.currency)
      fail('CASH_HOLD_UNCONFIRMED', 'Card hold needs reconciliation');
    if (h.status !== 'created') fail('CASH_HOLD_NOT_NEEDED', 'The card hold is already ' + h.status);
    if (h.provider_payment_reference) {
      const resumed = await adapter.resume(h.provider_payment_reference, f);
      return { jobId: f.jobId, provider: f.provider, clientSecret: resumed.clientSecret, amountMinor: f.amountMinor, currency: f.currency };
    }
    const created = await adapter.create(f);
    const bound = await this.deps.db.from('cash_ride_fee_holds_v1e').update({ provider_payment_reference: created.reference, updated_at: new Date().toISOString() })
      .eq('job_id', f.jobId).eq('status', 'created').is('provider_payment_reference', null).select('job_id');
    if (bound.error) fail('CASH_HOLD_UNCONFIRMED', 'Card hold needs reconciliation');
    if (!Array.isArray(bound.data) || bound.data.length !== 1) {
      // A concurrent request bound the same idempotent provider hold first; it must be this one.
      const again = await this.deps.db.from('cash_ride_fee_holds_v1e').select('provider_payment_reference,status').eq('job_id', f.jobId).maybeSingle();
      if (again.error || again.data?.provider_payment_reference !== created.reference) fail('CASH_HOLD_UNCONFIRMED', 'Card hold needs reconciliation');
    }
    return { jobId: f.jobId, provider: f.provider, clientSecret: created.clientSecret, amountMinor: f.amountMinor, currency: f.currency };
  }

  private async holdRow(jobId: string) {
    const r = await this.deps.db.from('cash_ride_fee_holds_v1e').select('*').eq('job_id', jobId).maybeSingle();
    if (r.error) fail('CASH_HOLD_UNAVAILABLE', 'Card hold could not be loaded');
    return r.data as any;
  }
  private holdInput(h: any): CashFeeHoldInput {
    return { jobId: h.job_id, customerId: h.customer_id, merchantAccountRef: h.merchant_account_ref, amountMinor: Number(h.amount_minor), currency: h.currency_code };
  }
  /** Releases a cash ride's fee hold (completion, early cancellation, no driver). Idempotent. */
  async releaseHold(jobId: string): Promise<'no_hold' | 'released' | 'captured'> {
    const h = await this.holdRow(jobId);
    if (!h) return 'no_hold';
    if (h.status === 'released' || h.status === 'captured') return h.status;
    if (h.provider_payment_reference) await this.holdProvider(h.provider).release(h.provider_payment_reference, this.holdInput(h));
    const u = await this.deps.db.from('cash_ride_fee_holds_v1e').update({ status: 'released', updated_at: new Date().toISOString() })
      .eq('job_id', jobId).eq('status', h.status).select('job_id');
    if (u.error) fail('CASH_HOLD_RELEASE_UNCONFIRMED', 'Hold release requires reconciliation');
    return 'released';
  }
  /** Captures a no-show / late-cancellation fee from the authorised hold, once. */
  async captureFee(jobId: string, amountMinor: number, idempotencyKey: string): Promise<'captured'> {
    const h = await this.holdRow(jobId);
    if (!h) fail('CASH_HOLD_NOT_STARTED', 'No card hold secures this ride');
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > Number(h.amount_minor)) fail('CASH_FEE_EXCEEDS_HOLD', 'Fee exceeds the card hold');
    if (h.status === 'captured') {
      if (Number(h.captured_minor) !== amountMinor) fail('CASH_HOLD_CAPTURE_UNCONFIRMED', 'A different fee was already captured');
      return 'captured';
    }
    if (h.status !== 'authorized' || !h.provider_payment_reference) fail('CASH_HOLD_NOT_AUTHORISED', 'The card hold is not authorised');
    await this.holdProvider(h.provider).capture(h.provider_payment_reference, this.holdInput(h), amountMinor, idempotencyKey);
    const u = await this.deps.db.from('cash_ride_fee_holds_v1e').update({ status: 'captured', captured_minor: amountMinor, updated_at: new Date().toISOString() })
      .eq('job_id', jobId).eq('status', 'authorized').select('job_id');
    if (u.error) fail('CASH_HOLD_CAPTURE_UNCONFIRMED', 'Fee capture requires reconciliation');
    return 'captured';
  }

  /** The captured hold intent (provider-verified, read-only) so the collection can be booked. */
  async capturedFeeIntent(jobId: string): Promise<unknown> {
    const h = await this.holdRow(jobId);
    if (!h || h.status !== 'captured' || !h.provider_payment_reference) fail('CASH_HOLD_CAPTURE_UNCONFIRMED', 'No captured hold for this ride');
    const provider = this.holdProvider(h.provider);
    if (!provider.inspectCaptured) fail('CASH_HOLD_CAPTURE_UNCONFIRMED', 'Provider cannot confirm the capture');
    return provider.inspectCaptured!(h.provider_payment_reference, this.holdInput(h));
  }

  /** Verifies the authorised hold at the provider, then activates the ride atomically. */
  async confirmHold(job: any, customerId: string): Promise<'activated' | 'already_activated'> {
    const f = this.frozen(job, customerId);
    const current = await this.deps.db.from('cash_ride_fee_holds_v1e').select('*').eq('job_id', f.jobId).maybeSingle();
    const h = current.data;
    if (current.error || !h || !h.provider_payment_reference) fail('CASH_HOLD_NOT_STARTED', 'The card hold has not been started');
    await this.holdProvider(f.provider).verifyAuthorised(h.provider_payment_reference, f);
    const r = await this.deps.db.rpc('activate_cash_ride_v1e', { p_job_id: f.jobId, p_customer_id: customerId, p_provider: f.provider,
      p_provider_payment_reference: h.provider_payment_reference, p_amount_minor: f.amountMinor, p_currency: f.currency });
    if (r.error) fail('CASH_ACTIVATION_UNCONFIRMED', 'The ride could not be activated');
    if (r.data === 'activated' || r.data === 'already_activated') return r.data;
    return fail('CASH_ACTIVATION_REFUSED', 'This cash ride cannot be activated (' + String(r.data) + ')');
  }
}
