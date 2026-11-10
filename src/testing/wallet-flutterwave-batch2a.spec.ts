import { describe, expect, it } from 'vitest';
import { currencyExponent, quoteWalletTopup, toMinor } from '../../server/services/payments/wallet-fee-policy';

describe('Batch 2A fee policy (pure, no network)', () => {
  it('quotes wallet + fee + total with exact minor arithmetic', () => {
    const q = quoteWalletTopup(10000, { version: 'v1', provider: 'flutterwave', country: 'NG', currency: 'NGN', method: 'card', feeBasisPoints: 150, feeFixedMinor: 0, exponent: 2 });
    expect(q.walletAmountMinor).toBe(10000);
    expect(q.providerFeeMinor).toBe(150);
    expect(q.totalChargeMinor).toBe(10150);
  });

  it('rounds percentage fee half-up and freezes policy version', () => {
    const q = quoteWalletTopup(333, { version: 'v2', provider: 'flutterwave', country: 'NG', currency: 'NGN', method: 'card', feeBasisPoints: 150, feeFixedMinor: 0, exponent: 2 });
    expect(q.providerFeeMinor).toBe(Math.round((333 * 150) / 10000));
    expect(q.feePolicyVersion).toBe('v2');
  });

  it('supports an explicitly configured zero fee', () => {
    expect(quoteWalletTopup(1000, { version: 'v1', provider: 'flutterwave', country: 'NG', currency: 'NGN', method: 'card', feeBasisPoints: 0, feeFixedMinor: 0, exponent: 2 }).providerFeeMinor).toBe(0);
  });

  it('converts 0/2/3-decimal currencies exactly and rejects fractional minor', () => {
    expect(toMinor('1500', 0)).toBe(1500);
    expect(toMinor('12.34', 2)).toBe(1234);
    expect(toMinor('1.234', 3)).toBe(1234);
    expect(() => toMinor('1.2345', 3)).toThrow();
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });
});
