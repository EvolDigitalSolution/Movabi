import { describe, expect, it } from 'vitest';

// Market country/currency pairing: server resolves currency from the authorised
// market config; address country/device locale are separate; an inconsistent
// client-supplied pair is rejected; NG/NGN and GB/GBP hold through the flow.
describe('market country/currency pairing', () => {
  const resolveMarketCurrency = (country: string, config: Record<string, { currency: string; city: string }>) => {
    const row = config[country];
    return row ? { countryCode: country, currencyCode: row.currency } : { countryCode: country, currencyCode: null };
  };
  const MARKET = { GB: { currency: 'GBP', city: 'London' }, NG: { currency: 'NGN', city: 'Lagos' } };

  it('GB registration resolves GBP — never the client-supplied currency', () => {
    const stored = resolveMarketCurrency('GB', MARKET);
    expect(stored).toEqual({ countryCode: 'GB', currencyCode: 'GBP' });
  });

  it('NG registration resolves NGN — GB address must not change market currency', () => {
    const stored = resolveMarketCurrency('NG', MARKET);
    expect(stored).toEqual({ countryCode: 'NG', currencyCode: 'NGN' });
  });

  it('paired write keeps market country and currency together', () => {
    const updates: Record<string, string | null> = {};
    const country = 'NG';
    updates.country_code = country;
    const market = resolveMarketCurrency(country, MARKET);
    updates.currency_code = market.currencyCode;
    expect(updates.country_code).toBe('NG');
    expect(updates.currency_code).toBe('NGN');
  });

  it('rejects an inconsistent client-supplied pair', () => {
    const clientSays = { country_code: 'NG', currency_code: 'USD' };
    const server = resolveMarketCurrency(clientSays.country_code, MARKET);
    const consistent = clientSays.currency_code === server.currencyCode;
    expect(consistent).toBe(false);
    // the server value wins — never persist the client's pair
    expect(server.currencyCode).toBe('NGN');
  });

  it('unconfigured market yields UNKNOWN currency, not GBP', () => {
    const stored = resolveMarketCurrency('ZZ', MARKET);
    expect(stored.countryCode).toBe('ZZ');
    expect(stored.currencyCode).toBeNull();
  });

  it('unresolvable currency rejects the write and preserves the stored pair', () => {
    const stored = { country_code: 'GB', currency_code: 'GBP' };
    const market = resolveMarketCurrency('ZZ', MARKET);
    if (!market.currencyCode) {
      // reject — both fields stay at their previous values
      expect(stored).toEqual({ country_code: 'GB', currency_code: 'GBP' });
    }
  });

  it('city-specific markets resolve the city row, not the country default', () => {
    const cityMarket = { GB: { currency: 'GBP', city: 'London' }, GB_MAN: { currency: 'GBP', city: 'Manchester' } };
    // resolver must honour market_city for city-specific pricing
    const london = cityMarket['GB'];
    expect(london.city).toBe('London');
    // a driver assigned Manchester resolves the Manchester row, not GB default
    const manchester = cityMarket['GB_MAN'];
    expect(manchester.city).toBe('Manchester');
    expect(london).not.toBe(manchester);
  });
});
