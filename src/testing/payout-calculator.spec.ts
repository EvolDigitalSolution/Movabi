import { describe, expect, it } from 'vitest';
import { calculatePayoutBreakdown } from '../../server/services/payout-calculator';

describe('calculatePayoutBreakdown', () => {
  it('calculates starter driver payout with platform service fee and commission', () => {
    const result = calculatePayoutBreakdown(100, 'starter', 15);

    expect(result).toEqual({
      total_price: 100,
      base_fare: 90,
      service_fee: 10,
      commission_fee: 13.5,
      commission_rate_used: 15,
      platform_fee: 23.5,
      driver_payout: 76.5,
      pricing_plan_used: 'starter'
    });
  });

  it('keeps pro drivers commission-free while retaining customer service fee', () => {
    const result = calculatePayoutBreakdown(50, 'pro', 15);

    expect(result.service_fee).toBe(5);
    expect(result.commission_fee).toBe(0);
    expect(result.platform_fee).toBe(5);
    expect(result.driver_payout).toBe(45);
  });

  it('handles boundary amounts safely', () => {
    expect(calculatePayoutBreakdown(-10, 'starter').driver_payout).toBe(0);
    expect(calculatePayoutBreakdown(Number.NaN, 'starter').platform_fee).toBe(0);
    expect(calculatePayoutBreakdown(10.005, 'starter', Number.NaN).total_price).toBe(10.01);
  });
});
