import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceConfigService } from '../../server/services/marketplace-config.service';

describe('MarketplaceConfigService commission compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    MarketplaceConfigService.clearCache();
  });

  it('enables legacy commission JSON when enabled is missing', () => {
    const config = MarketplaceConfigService.normalizeCommissionSettings({
      percent: 10,
      minFee: 0,
      maxFee: 0,
      platformFeePercent: 2
    });

    expect(config.enabled).toBe(true);
    expect(config.percent).toBe(10);
    expect(config.platformFeePercent).toBe(2);
  });

  it('only disables commission when enabled is explicitly false', () => {
    expect(MarketplaceConfigService.normalizeCommissionSettings({ percent: 10 }).enabled).toBe(true);
    expect(MarketplaceConfigService.normalizeCommissionSettings({ percent: 10, enabled: false }).enabled).toBe(false);
  });

  it('does not convert a legacy 10% commission to 0%', () => {
    const config = MarketplaceConfigService.normalizeCommissionSettings({ percent: 10 });
    const effectivePercent = config.enabled === false ? 0 : config.percent;

    expect(effectivePercent).toBe(10);
  });

  it('normalizes zero min/max fees as no fee bounds', () => {
    const config = MarketplaceConfigService.normalizeCommissionSettings({
      percent: 10,
      minFee: 0,
      maxFee: 0
    });

    expect(config.minFee).toBe(0);
    expect(config.maxFee).toBeNull();
    expect(config.percent).toBe(10);
  });

  it('normalizes the legacy embedded platform fee when dedicated platform_fee is missing', async () => {
    vi.spyOn(MarketplaceConfigService, 'getRawSetting').mockImplementation(async (key) => {
      if (key === 'platform_fee') return null;
      if (key === 'commission') return { percent: 10, platformFeePercent: 2 };
      return null;
    });

    const config = await MarketplaceConfigService.getEffectivePlatformFeeConfig('ride');

    expect(config.enabled).toBe(true);
    expect(config.type).toBe('percentage');
    expect(config.percent).toBe(2);
    expect(config.source).toBe('legacy_commission.platformFeePercent');
  });
});
