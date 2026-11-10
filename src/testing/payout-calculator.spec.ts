import { describe, expect, it } from 'vitest';
import { calculatePayoutBreakdown } from '../../server/services/payout-calculator';

describe('calculatePayoutBreakdown', () => {
  it('calculates starter driver payout with platform service fee and commission', () => {
    const result = calculatePayoutBreakdown(100, 'starter', 8, 12);

    expect(result).toEqual({
      total_price: 100,
      base_fare: 88,
      service_fee: 12,
      commission_fee: 7.04,
      commission_rate_used: 8,
      platform_fee: 19.04,
      driver_payout: 80.96,
      pricing_plan_used: 'starter'
    });
  });

  it('keeps pro drivers commission-free while retaining customer service fee', () => {
    const result = calculatePayoutBreakdown(50, 'pro', 8, 12);

    expect(result.service_fee).toBe(6);
    expect(result.commission_fee).toBe(0);
    expect(result.platform_fee).toBe(6);
    expect(result.driver_payout).toBe(44);
  });

  it('handles boundary amounts safely', () => {
    expect(calculatePayoutBreakdown(-10, 'starter', 0).driver_payout).toBe(0);
    expect(calculatePayoutBreakdown(Number.NaN, 'starter', 0).platform_fee).toBe(0);
    expect(calculatePayoutBreakdown(10.005, 'starter', Number.NaN).total_price).toBe(10.01);
  });
});
