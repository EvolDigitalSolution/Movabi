import { type MarketPaymentPolicy, type PaymentCapability, PaymentLayerError, type PaymentRoute, validateRoute } from './payment-contracts';

/** Configuration is server owned. Published provider coverage is not merchant approval. */
export interface MarketPaymentRoute extends MarketPaymentPolicy {
  readonly methods: readonly string[];
  readonly adapterReady: boolean;
  readonly payoutApproved: boolean;
}
const supported = new Set(['authorise','capture','release','refund','retrieve','payout','collect']);
export function paymentPolicies(raw: string | undefined): readonly MarketPaymentRoute[] {
  if (!raw?.trim()) return Object.freeze([]);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new PaymentLayerError('INVALID_PAYMENT_CONFIG','Payment routes must be valid JSON'); }
  if (!Array.isArray(parsed)) throw new PaymentLayerError('INVALID_PAYMENT_CONFIG','Payment routes must be an array');
  const seen = new Set<string>();
  return Object.freeze(parsed.map(p => {
    validateRoute(p);
    // Providers are gated on enabled/merchant-approved/adapter-ready + required
    // capability — never hardcoded by continent or retired status. Kora/Fincra
    // have no booking hold/capture adapter yet and must stay disabled.
    if ((p.provider === 'kora' || p.provider === 'fincra') &&
        (p.enabled || p.adapterReady || p.payoutApproved || (!Array.isArray(p.capabilities) || p.capabilities.length)))
      throw new PaymentLayerError('PAYMENT_PROVIDER_NOT_READY','Kora and Fincra booking routes must remain disabled');
    // Collection routing cannot authorize bank payouts; those use driver_payout_markets.
    if (p.provider === 'flutterwave' && (p.payoutApproved || (Array.isArray(p.capabilities) && p.capabilities.some(c => c === 'capture' || c === 'authorise'))))
      throw new PaymentLayerError('PAYMENT_PROVIDER_NOT_READY','Flutterwave collection routes cannot authorize booking holds or bank payouts');
    if (![p.enabled,p.merchantApproved,p.adapterReady,p.payoutApproved].every(v=>typeof v==='boolean')
      || !Array.isArray(p.methods) || !p.methods.length || p.methods.some(v=>typeof v!=='string'||!v.trim())
      || !Array.isArray(p.capabilities) || p.capabilities.some(v=>!supported.has(v)))
      throw new PaymentLayerError('INVALID_PAYMENT_CONFIG','Payment route capabilities and approvals must be explicit');
    const key = JSON.stringify([p.country,p.currency,p.provider,p.merchantAccountRef]);
    if (seen.has(key)) throw new PaymentLayerError('INVALID_PAYMENT_CONFIG','Duplicate payment route');
    seen.add(key);
    return Object.freeze({...p, methods:Object.freeze([...p.methods]),capabilities:Object.freeze([...p.capabilities])});
  }));
}
export function selectMarketPayment(market: {countryCode: string|null;currency: string|null;paymentEnabled:boolean},
 policies: readonly MarketPaymentRoute[], method: string, required: readonly PaymentCapability[]): PaymentRoute {
  if (!market.paymentEnabled || !market.countryCode || !market.currency)
    throw new PaymentLayerError('PAYMENT_MARKET_UNAVAILABLE','Payments are not available for this service location');
  const matching = policies.filter(p=>p.enabled && p.country===market.countryCode && p.currency===market.currency && p.methods.includes(method));
  if (matching.length!==1) throw new PaymentLayerError('PAYMENT_MARKET_UNAVAILABLE','Exactly one payment route must be configured for this method');
  const p=matching[0];
  if (!p.merchantApproved || !p.adapterReady || (required.includes('payout')&&!p.payoutApproved))
    throw new PaymentLayerError('PAYMENT_PROVIDER_NOT_READY','This merchant payment capability is not ready');
  if (!required.length || required.some(c=>!p.capabilities.includes(c)))
    throw new PaymentLayerError('PAYMENT_CAPABILITY_UNAVAILABLE','The selected method does not support this payment flow');
  return Object.freeze({provider:p.provider,merchantAccountRef:p.merchantAccountRef,country:p.country,currency:p.currency});
}
