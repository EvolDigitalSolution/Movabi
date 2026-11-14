import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: {} }));
import { MarketplaceConfigService } from '../../server/services/marketplace-config.service';
import { PricingService } from '../../server/services/pricing.service';

/**
 * Area 4b / P8 (2026-11-14): surge for GB only. dynamic_pricing.markets.GB is used ONLY for GB quotes and
 * never inherits tenant-level values; other markets keep the tenant-level setting exactly as before.
 */
const GB_ENTRY = { enabled: true, maxSurge: 1.5, maxMultiplier: 1.5, demandSupplyEnabled: true, trafficEnabled: false, timeOfDayEnabled: false,
  weatherEnabled: false, trafficMultiplier: 1, weatherMultiplier: 1, demandMultiplier: 1, fuelMultiplier: 1 };
let raw: any = null;
let n = 0;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(MarketplaceConfigService, 'getRawSetting').mockImplementation(async () => raw);
});
const cfg = (country: string) => MarketplaceConfigService.getEffectiveDynamicPricingConfig('ride', { countryCode: country, currencyCode: 'GBP' }, null, `tenant-${++n}`);

describe('per-market dynamic pricing', () => {
  it('GB uses its own entry: on, max 1.5, demand/supply on, traffic off', async () => {
    raw = { enabled: false, markets: { GB: GB_ENTRY } };
    const c = await cfg('GB');
    expect(c).toMatchObject({ enabled: true, maxSurge: 1.5, maxMultiplier: 1.5, demandSupplyEnabled: true, trafficEnabled: false, source: 'marketplace_settings_market' });
  });
  it('NG (same tenant, no entry) keeps the tenant-level setting: still off', async () => {
    raw = { enabled: false, markets: { GB: GB_ENTRY } };
    const c = await cfg('NG');
    expect(c.enabled).toBe(false);
    expect(c.source).toBe('marketplace_settings');
  });
  it('tenant-level values never leak into the GB entry (traffic stays off, max stays 1.5)', async () => {
    raw = { enabled: true, trafficEnabled: true, trafficMultiplier: 1.4, maxSurge: 3, timeOfDayEnabled: true, markets: { GB: GB_ENTRY } };
    const gb = await cfg('GB');
    expect(gb).toMatchObject({ trafficEnabled: false, trafficMultiplier: 1, maxSurge: 1.5, timeOfDayEnabled: false });
    const ng = await cfg('NG');
    expect(ng).toMatchObject({ enabled: true, trafficEnabled: true, maxSurge: 3 });
  });
  it('a missing or malformed entry falls back to the tenant-level setting', async () => {
    for (const markets of [undefined, null, [], { GB: 'on' }, { gb: GB_ENTRY }]) {
      raw = { enabled: false, markets };
      expect((await cfg('GB')).enabled).toBe(false);
    }
  });
  it('no setting at all: safe default (off)', async () => {
    raw = null;
    expect((await cfg('GB'))).toMatchObject({ enabled: false, maxSurge: 1, source: 'safe_zero_default' });
  });
});

describe('surge is capped at the GB maximum (1.5)', () => {
  const s = { ...GB_ENTRY, minimumDemandRatio: 0, shortTripMaxMultiplier: 1, shortTripMaxAmount: 0 } as any;
  it('no demand or balanced supply: no surge', () => {
    expect(PricingService.getSurgeMultiplier(0, 5, s)).toBe(1);
  });
  it('high demand never exceeds 1.5; no supply gives exactly 1.5', () => {
    expect(PricingService.getSurgeMultiplier(50, 1, s)).toBe(1.5);
    expect(PricingService.getSurgeMultiplier(5, 0, s)).toBe(1.5);
    const mid = PricingService.getSurgeMultiplier(3, 2, s);
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThanOrEqual(1.5);
  });
});
