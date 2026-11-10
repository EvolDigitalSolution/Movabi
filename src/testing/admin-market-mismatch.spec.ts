import { describe, expect, it } from 'vitest';

// Admin driver list: stored market_country/market_currency + mismatch flag vs
// the market config — UNKNOWN on missing, no silent GBP.
describe('Admin driver market mismatch display', () => {
  const compute = (country: string | null, currency: string | null, marketCurrency: string | null) => {
    const storedCountry = String(country || '').toUpperCase() || 'UNKNOWN';
    const storedCurrency = String(currency || '').toUpperCase() || 'UNKNOWN';
    const market = String(marketCurrency || '').toUpperCase() || 'UNKNOWN';
    return {
      market_country: storedCountry, market_currency: storedCurrency,
      market_mismatch: storedCountry !== 'UNKNOWN' && storedCurrency !== 'UNKNOWN' && market !== 'UNKNOWN' && storedCurrency !== market
    };
  };

  it('NG/GBP shows a mismatch warning', () => {
    const r = compute('NG', 'GBP', 'NGN');
    expect(r.market_mismatch).toBe(true);
    expect(r.market_country).toBe('NG');
    expect(r.market_currency).toBe('GBP');
  });

  it('NG/NGN and GB/GBP show no warning', () => {
    expect(compute('NG', 'NGN', 'NGN').market_mismatch).toBe(false);
    expect(compute('GB', 'GBP', 'GBP').market_mismatch).toBe(false);
  });

  it('missing pair renders UNKNOWN, no silent GBP', () => {
    const r = compute(null, null, null);
    expect(r.market_country).toBe('UNKNOWN');
    expect(r.market_currency).toBe('UNKNOWN');
    expect(r.market_mismatch).toBe(false);
  });

  it('unresolvable market currency is UNKNOWN, not a mismatch', () => {
    const r = compute('NG', 'NGN', null);
    expect(r.market_mismatch).toBe(false);
    expect(r.market_currency).toBe('NGN');
  });
});
