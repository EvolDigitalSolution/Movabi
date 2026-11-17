import { PaymentLayerError } from './payment-contracts';
import type { DriverCardTopupAdapter, DriverCardAdapterResolver } from './driver-card-topup-contracts';

/**
 * Customer booking-wallet collection. Mirrors DriverWalletTopupService but for
 * destination_account_purpose='customer_credit': the credited balance is what
 * pay_job_from_wallet reserves for errand fare + shopping budget. Gated by
 * customerWalletTopupReadiness semantics (same tables, fail-closed) — not the
 * driver sandbox scope. Fee policy is pinned to an approved customer schedule.
 */
export interface CustomerTopupDb {
  authGetUser(token: string): Promise<{ id: string; email?: string; email_confirmed_at?: string | null } | null>;
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  from(table: string): any;
}
export interface CustomerTopupConfig {
  callbackUrl(): string;
}
export const CUSTOMER_CARD_FEE_VERSION = 'vaydu-customer-card-0fee-test-v1';
export const CUSTOMER_CARD_FEE_LABEL = 'No card fee';
export function assertApprovedCustomerFee(policy: any): void {
  if (!policy || policy.version !== CUSTOMER_CARD_FEE_VERSION || policy.fee_basis !== 'wallet' ||
      Number(policy.fee_basis_points) !== 0 || Number(policy.fee_fixed_minor) !== 0 || policy.fee_cap_minor != null ||
      policy.rounding !== 'half_up' || !policy.approved_by || !policy.approved_at || policy.active !== true)
    throw new PaymentLayerError('PAYMENT_FEE_MISSING', 'Approved customer card fee schedule is unavailable');
}
const fail = (code: string): never => { throw new PaymentLayerError(code, 'Wallet top-up unavailable'); };
function minor(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const n = BigInt(value);
    if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n);
  }
  return fail('TOPUP_TERMS_UNAVAILABLE');
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export class CustomerWalletCollectionService {
  constructor(private readonly db: CustomerTopupDb, private readonly config: CustomerTopupConfig, private readonly adapters: DriverCardTopupAdapter | DriverCardAdapterResolver) {}

  private adapter(provider: string, merchant: string): DriverCardTopupAdapter {
    const adapter = typeof this.adapters === 'function' ? this.adapters(provider, merchant) : this.adapters;
    if (adapter.provider !== provider) return fail('PAYMENT_PROVIDER_NOT_READY');
    return adapter;
  }
  private async principal(token: string) {
    const user = await this.db.authGetUser(token);
    if (!user || !uuid(user.id) || !user.email_confirmed_at) return fail('AUTHENTICATION_REQUIRED');
    const profile = await this.db.from('profiles').select('id,tenant_id,role,registration_activated_at,registration_country_code,registration_market_city').eq('id', user.id).maybeSingle();
    if (profile.error || !profile.data || profile.data.id !== user.id || profile.data.role !== 'customer' || !uuid(profile.data.tenant_id)
        || !profile.data.registration_activated_at || !/^[A-Z]{2}$/.test(String(profile.data.registration_country_code || ''))) return fail('CUSTOMER_NOT_ELIGIBLE');
    return { id: user.id, tenant: profile.data.tenant_id as string, email: user.email || '', country: profile.data.registration_country_code as string, city: profile.data.registration_market_city };
  }
  /** Same market/route resolution as customerWalletTopupReadiness, returning the
   * single eligible route's merchant binding. Fails closed. */
  private async market(owner: { id: string; tenant: string; country: string; city: unknown }) {
    const now = Date.now();
    const city = (v: any) => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : '';
    const rows = await this.db.from('market_availability').select('country_code,supported_currency,enabled,launch_status,customer_app_enabled,market_city,zone_id,valid_from,valid_until').eq('country_code', owner.country);
    if (rows.error || !Array.isArray(rows.data)) return fail('MARKET_UNAVAILABLE');
    const current = (r: any) => {
      if (!r || r.country_code !== owner.country || r.enabled !== true || (r.zone_id != null && String(r.zone_id).trim() !== '')) return false;
      return (!r.valid_from || Date.parse(r.valid_from) <= now) && (!r.valid_until || Date.parse(r.valid_until) > now);
    };
    const scoped = rows.data.filter(current);
    const c = city(owner.city);
    const matches = c ? scoped.filter((r: any) => city(r.market_city) === c) : [];
    const markets = matches.length ? matches : scoped.filter((r: any) => city(r.market_city) === '');
    if (markets.length !== 1 || markets[0].launch_status !== 'live' || markets[0].customer_app_enabled !== true || !/^[A-Z]{3}$/.test(markets[0].supported_currency)) return fail('MARKET_UNAVAILABLE');
    const currency = markets[0].supported_currency as string;
    const wallet = await this.db.from('wallets').select('id,user_id,currency_code').eq('user_id', owner.id).maybeSingle();
    if (wallet.error || !wallet.data || wallet.data.currency_code !== currency) return fail('WALLET_NOT_READY');
    const config = await this.db.from('wallet_collection_config').select('key,value').in('key', ['enabled', 'max_amount_minor_' + currency]);
    if (config.error || !Array.isArray(config.data)) return fail('COLLECTION_DISABLED');
    const value = (k: string) => config.data.filter((x: any) => x.key === k)[0]?.value;
    if (value('enabled') !== 'true') return fail('COLLECTION_DISABLED');
    const limit = value('max_amount_minor_' + currency);
    if (typeof limit !== 'string' || !/^[1-9][0-9]{0,18}$/.test(limit)) return fail('COLLECTION_DISABLED');
    const routes = await this.db.from('market_payment_routes').select('provider,merchant_account_ref,capabilities')
      .eq('country_code', owner.country).eq('currency_code', currency).eq('method', 'card')
      .eq('preferred', true).eq('enabled', true).eq('merchant_approved', true).eq('adapter_ready', true);
    if (routes.error || !Array.isArray(routes.data) || routes.data.length !== 1) return fail('PAYMENT_MARKET_UNAVAILABLE');
    const route = routes.data[0];
    if (typeof route.provider !== 'string' || !['stripe', 'kora', 'fincra'].includes(route.provider)
        || typeof route.merchant_account_ref !== 'string' || !route.merchant_account_ref.trim()
        || !Array.isArray(route.capabilities) || !route.capabilities.includes('collect')) return fail('PAYMENT_PROVIDER_NOT_READY');
    try {
      const callback = new URL(this.config.callbackUrl());
      if ((callback.protocol !== 'https:' && !(callback.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname))) || callback.username || callback.password || callback.hash) return fail('PAYMENT_CALLBACK_UNAVAILABLE');
    } catch { return fail('PAYMENT_CALLBACK_UNAVAILABLE'); }
    this.adapter(route.provider, route.merchant_account_ref);
    return { country: owner.country, currency, merchant: route.merchant_account_ref as string, provider: route.provider as string, maxAmountMinor: minor(limit) };
  }
  private async attempt(id: string, owner: string, tenant: string) {
    const q = await this.db.from('wallet_topup_attempts').select('id,owner_id,tenant_id,country_code,currency_code,payment_provider,merchant_account_ref,provider_reference,amount_minor,provider_fee_minor,total_charge_minor,fee_policy_version,fee_exponent,destination_account_purpose,status,provider_account_id').eq('id', id).eq('owner_id', owner).eq('tenant_id', tenant).maybeSingle();
    const a = q.data;
    if (q.error || !a || a.id !== id || a.owner_id !== owner || a.tenant_id !== tenant || typeof a.payment_provider !== 'string' || a.destination_account_purpose !== 'customer_credit' || !/^[A-Z]{3}$/.test(a.currency_code) || typeof a.merchant_account_ref !== 'string' || !a.merchant_account_ref.trim() || !a.fee_policy_version || !Number.isInteger(a.fee_exponent) || a.fee_exponent < 0 || a.fee_exponent > 3) return fail('TOPUP_NOT_AVAILABLE');
    const credit = minor(a.amount_minor), fee = minor(a.provider_fee_minor), total = minor(a.total_charge_minor);
    if (credit <= 0 || !Number.isSafeInteger(credit + fee) || credit + fee !== total) return fail('TOPUP_TERMS_UNAVAILABLE');
    return { ...a, credit, fee, total };
  }
  async createCheckout(token: string, input: { amountMinor: number; idempotencyKey: string; confirmedTotalMinor?: number }) {
    const user = await this.principal(token);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !uuid(input.idempotencyKey) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) return fail('INVALID_PAYMENT_INPUT');
    const m = await this.market(user);
    if (input.amountMinor > m.maxAmountMinor) return fail('TOPUP_AMOUNT_LIMIT');
    const policy = await this.db.from('wallet_topup_fee_schedules').select('*').eq('provider', m.provider).eq('country_code', m.country).eq('currency_code', m.currency).eq('method', 'card').eq('active', true).maybeSingle();
    if (policy.error || !policy.data) return fail('PAYMENT_FEE_MISSING');
    assertApprovedCustomerFee(policy.data);
    const attemptId = await this.db.rpc<string>('initiate_wallet_topup', { p_attempt_key: `customer-topup:${user.id}:${input.idempotencyKey}`, p_tenant_id: user.tenant, p_owner_id: user.id, p_country_code: m.country, p_currency_code: m.currency, p_amount_minor: input.amountMinor, p_destination_account_purpose: 'customer_credit', p_payment_provider: m.provider, p_merchant_account_ref: m.merchant, p_provider_idempotency_identity: input.idempotencyKey });
    if (!uuid(attemptId)) return fail('TOPUP_RESULT_UNCONFIRMED');
    await this.db.rpc('freeze_wallet_topup_fee', { p_attempt_id: attemptId, p_fee_policy_version: policy.data.version });
    const a = await this.attempt(attemptId, user.id, user.tenant);
    if (a.currency_code !== m.currency || a.country_code !== m.country || a.merchant_account_ref !== m.merchant || a.credit !== input.amountMinor) return fail('TOPUP_TERMS_UNAVAILABLE');
    const quote = { attemptId, walletAmountMinor: a.credit, feeMinor: a.fee, totalChargeMinor: a.total, currency: a.currency_code, exponent: a.fee_exponent, feePolicyVersion: a.fee_policy_version, feeLabel: CUSTOMER_CARD_FEE_LABEL, provider: a.payment_provider };
    if (input.confirmedTotalMinor === undefined) return { kind: 'quote' as const, ...quote };
    if (!Number.isSafeInteger(input.confirmedTotalMinor) || input.confirmedTotalMinor !== a.total) return fail('TOPUP_QUOTE_MISMATCH');
    const adapter = this.adapter(a.payment_provider, a.merchant_account_ref);
    try { await adapter.preflight({ reference: attemptId, merchantAccountRef: a.merchant_account_ref, currency: a.currency_code, amountMinor: a.total, exponent: a.fee_exponent, providerAccountId: a.provider_account_id ?? undefined, walletAmountMinor: a.credit, feeMinor: a.fee, email: user.email, redirectUrl: this.config.callbackUrl() }); }
    catch (error) { if (error instanceof PaymentLayerError && error.code === 'PAYMENT_CHECKOUT_TOTAL_MISMATCH') throw error; throw new PaymentLayerError('PAYMENT_PREFLIGHT_UNAVAILABLE', 'Provider check failed; no checkout submitted'); }
    const claimed = await this.db.rpc<boolean>('claim_wallet_topup_submission', { p_attempt_id: attemptId });
    if (claimed !== true) return fail('PAYMENT_RECONCILIATION_REQUIRED');
    try {
      const checkout = await adapter.createCheckout({ reference: attemptId, merchantAccountRef: a.merchant_account_ref, currency: a.currency_code, amountMinor: a.total, exponent: a.fee_exponent, providerAccountId: a.provider_account_id ?? undefined, walletAmountMinor: a.credit, feeMinor: a.fee, email: user.email, redirectUrl: this.config.callbackUrl() });
      if (checkout.providerReference !== attemptId) return fail('TOPUP_RESULT_UNCONFIRMED');
      await this.db.rpc('record_wallet_topup_provider_reference', { p_attempt_id: attemptId, p_provider_reference: checkout.providerReference });
      return { kind: 'checkout' as const, ...quote, checkoutUrl: checkout.checkoutUrl, clientSecret: checkout.clientSecret };
    } catch (error) {
      try { await this.db.rpc('mark_wallet_topup_uncertain', { p_attempt_id: attemptId, p_reason: 'submission or reference binding requires reconciliation' }); } catch { /* durable claim remains */ }
      throw error;
    }
  }
  async verify(token: string, attemptId: string): Promise<{ creditedEventId: string }> {
    const user = await this.principal(token);
    if (!uuid(attemptId)) return fail('INVALID_PAYMENT_INPUT');
    const a = await this.attempt(attemptId, user.id, user.tenant);
    const reference = a.provider_reference || attemptId;
    if (reference !== attemptId) return fail('TOPUP_TERMS_UNAVAILABLE');
    const verified = await this.adapter(a.payment_provider, a.merchant_account_ref).verify({ reference, merchantAccountRef: a.merchant_account_ref, currency: a.currency_code, amountMinor: a.total, exponent: a.fee_exponent, providerAccountId: a.provider_account_id ?? undefined });
    if (verified.reference !== reference || verified.merchantAccountRef !== a.merchant_account_ref || verified.currency !== a.currency_code || verified.chargedAmountMinor !== a.total || verified.finalStatus !== 'succeeded') return fail('PAYMENT_RESPONSE_UNCONFIRMED');
    let event: unknown;
    try {
      if (!a.provider_reference) await this.db.rpc('record_wallet_topup_provider_reference', { p_attempt_id: attemptId, p_provider_reference: reference });
      event = await this.db.rpc<string>('confirm_wallet_topup_with_total', { p_attempt_id: attemptId, p_verified_provider_reference: reference, p_verified_merchant_account_ref: a.merchant_account_ref, p_verified_currency: a.currency_code, p_verified_total_minor: a.total, p_final_status: 'succeeded' });
    } catch { return fail('PAYMENT_RECEIVED_CREDIT_PENDING'); }
    if (!uuid(event)) return fail('PAYMENT_RECEIVED_CREDIT_PENDING');
    return { creditedEventId: event };
  }
}
