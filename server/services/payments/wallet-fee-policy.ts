import { PaymentLayerError } from './payment-contracts';

/** Approved fee policy for a provider/market/method. Server-owned, explicit,
 * never inferred. `feeBasisPoints` is a percentage of the wallet amount;
 * `feeFixedMinor` is a flat fee in the currency's minor units. Both may be
 * present, including an explicitly approved zero fee. Total basis grosses up
 * until the net exactly covers the wallet amount. */
export interface WalletFeePolicy {
  readonly version: string;
  readonly provider: string;
  readonly country: string;
  readonly currency: string;
  readonly method: string;
  readonly feeBasisPoints: number;   // 0..10000
  readonly feeFixedMinor: number;    // >= 0
  readonly exponent: number;         // 0, 2 or 3 decimals for this currency
  readonly feeBasis?: 'wallet' | 'total';
  readonly rounding?: 'half_up' | 'ceil';
  readonly feeCapMinor?: number | null;
}
export interface WalletFeeQuote {
  readonly walletAmountMinor: number;
  readonly providerFeeMinor: number;
  readonly totalChargeMinor: number;
  readonly feePolicyVersion: string;
}

const EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  NGN: 2, GHS: 2, KES: 2, ZAR: 2, USD: 2, GBP: 2, EUR: 2,
  JPY: 0, KWD: 3, BHD: 3, OMR: 3, TND: 3,
});
export function currencyExponent(currency: string): number {
  const e = EXPONENTS[currency];
  if (e === undefined) throw new PaymentLayerError('PAYMENT_CURRENCY_UNSUPPORTED', `No configured minor-unit exponent for ${currency}`);
  return e;
}
/** Exact decimal→minor conversion for any supported exponent. Rejects missing
 * values, fractions of a minor unit and unsafe amounts. */
export function toMinor(value: unknown, exponent: number): number {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 3) throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'Minor-unit exponent out of range');
  const s = typeof value === 'number' ? String(value) : String(value ?? '');
  const m = /^(\d+)(?:\.(\d{0,}))?$/.exec(s);
  if (!m) throw new PaymentLayerError('INVALID_PAYMENT_AMOUNT', 'Amount must be a non-negative decimal');
  const frac = (m[2] || '').padEnd(exponent, '0');
  if (frac.length > exponent) throw new PaymentLayerError('INVALID_PAYMENT_AMOUNT', `Amount has more than ${exponent} decimal places`);
  const minor = BigInt(m[1]) * (10n ** BigInt(exponent)) + BigInt(frac || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new PaymentLayerError('INVALID_PAYMENT_AMOUNT', 'Amount is not a safe integer in minor units');
  return Number(minor);
}

/** Quote the three frozen amounts. The provider fee is calculated from the
 * configured basis using integer arithmetic and the approved rounding. Fails closed
 * on an unapproved or internally inconsistent policy. */
export function quoteWalletTopup(walletAmountMinor: number, policy: WalletFeePolicy): WalletFeeQuote {
  if (!Number.isSafeInteger(walletAmountMinor) || walletAmountMinor <= 0)
    throw new PaymentLayerError('INVALID_PAYMENT_AMOUNT', 'A positive safe integer wallet amount in minor units is required');
  if (!policy?.version?.trim() || !policy.provider?.trim() || !policy.country || !policy.currency || !policy.method)
    throw new PaymentLayerError('PAYMENT_FEE_MISSING', 'An explicit approved fee policy version is required');
  if (!Number.isInteger(policy.exponent) || policy.exponent < 0 || policy.exponent > 3) throw new PaymentLayerError('PAYMENT_FEE_MISSING', 'Fee policy exponent is invalid');
  if (!Number.isInteger(policy.feeBasisPoints) || policy.feeBasisPoints < 0 || policy.feeBasisPoints > 10000)
    throw new PaymentLayerError('PAYMENT_FEE_MISSING', 'Fee basis points must be 0..10000');
  if (!Number.isSafeInteger(policy.feeFixedMinor) || policy.feeFixedMinor < 0)
    throw new PaymentLayerError('PAYMENT_FEE_MISSING', 'Fee fixed minor must be a non-negative safe integer');
  const basis = policy.feeBasis ?? 'wallet', rounding = policy.rounding ?? 'half_up';
  if (!['wallet','total'].includes(basis) || !['half_up','ceil'].includes(rounding) ||
      (basis === 'total' && policy.feeBasisPoints >= 10000) ||
      (policy.feeCapMinor != null && (!Number.isSafeInteger(policy.feeCapMinor) || policy.feeCapMinor < 0)))
    throw new PaymentLayerError('PAYMENT_FEE_MISSING', 'Unsupported fee policy');
  const wallet = BigInt(walletAmountMinor), max = BigInt(Number.MAX_SAFE_INTEGER);
  const fee = (amount: bigint) => {
    const numerator = amount * BigInt(policy.feeBasisPoints) + BigInt(policy.feeFixedMinor) * 10000n;
    const rounded = (numerator + (rounding === 'ceil' ? 9999n : 5000n)) / 10000n;
    return policy.feeCapMinor != null && rounded > BigInt(policy.feeCapMinor) ? BigInt(policy.feeCapMinor) : rounded;
  };
  let total = wallet;
  if (basis === 'wallet') total += fee(wallet);
  else {
    let low = wallet, high = max;
    if (high - fee(high) < wallet) throw new PaymentLayerError('INVALID_PAYMENT_AMOUNT', 'Total charge exceeds safe integer range');
    while (low < high) { const mid = (low + high) / 2n; if (mid - fee(mid) >= wallet) high = mid; else low = mid + 1n; }
    total = low;
  }
  if (total > max) throw new PaymentLayerError('INVALID_PAYMENT_AMOUNT', 'Total charge exceeds safe integer range');
  const feeMinor = Number(total - wallet), totalChargeMinor = Number(total);
  return Object.freeze({ walletAmountMinor, providerFeeMinor: feeMinor, totalChargeMinor, feePolicyVersion: policy.version });
}
