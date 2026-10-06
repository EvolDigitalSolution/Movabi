/**
 * Ride no-show — policy math + flag/scope (FINAL policy).
 * feeMinor = min(500, floor(agreedFareMinor / 2)); 80/20 driver/platform split.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/services/stripe.service', () => ({ stripe: {} }));
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: {} }));

import { NoShowService, NO_SHOW_POLICY_VERSION, NO_SHOW_GRACE_MINUTES } from '../../server/services/no-show.service';

describe('no-show fee policy', () => {
  it('£3.50 ride → £1.75 fee: driver £1.40, Movabi £0.35', () => {
    const s = NoShowService.computeNoShowSplit(350, 'GBP');
    expect(s.feeMinor).toBe(175);
    expect(s.driverShareMinor).toBe(140);
    expect(s.platformShareMinor).toBe(35);
  });

  it('£8 ride → £4 fee: driver £3.20, Movabi £0.80', () => {
    const s = NoShowService.computeNoShowSplit(800, 'GBP');
    expect(s.feeMinor).toBe(400);
    expect(s.driverShareMinor).toBe(320);
    expect(s.platformShareMinor).toBe(80);
  });

  it('£30 ride → £5 fee (capped): driver £4, Movabi £1', () => {
    const s = NoShowService.computeNoShowSplit(3000, 'GBP');
    expect(s.feeMinor).toBe(500);
    expect(s.driverShareMinor).toBe(400);
    expect(s.platformShareMinor).toBe(100);
  });

  it('caps the fee at £5 (500 minor)', () => {
    expect(NoShowService.computeNoShowSplit(5000, 'GBP').feeMinor).toBe(500);
    expect(NoShowService.computeNoShowSplit(1100, 'GBP').feeMinor).toBe(500); // 50% = 550 -> capped
  });

  it('uses floor() for 50% — odd-penny fares round DOWN', () => {
    expect(NoShowService.computeNoShowSplit(351, 'GBP').feeMinor).toBe(175); // floor(175.5)
    expect(NoShowService.computeNoShowSplit(101, 'GBP').feeMinor).toBe(50);  // floor(50.5)
  });

  it('the 80/20 identity always holds exactly (driver + platform == fee)', () => {
    for (const fare of [1, 50, 99, 100, 101, 351, 500, 999, 1000, 1100, 3000, 5000]) {
      const s = NoShowService.computeNoShowSplit(fare, 'GBP');
      expect(s.driverShareMinor + s.platformShareMinor).toBe(s.feeMinor);
    }
  });

  it('never charges more than the full fare', () => {
    expect(NoShowService.computeNoShowSplit(1, 'GBP').feeMinor).toBe(0); // floor(0.5)=0
    expect(NoShowService.computeNoShowSplit(100, 'GBP').feeMinor).toBe(50);
  });

  it('carries the policy version', () => {
    expect(NoShowService.computeNoShowSplit(800, 'GBP').policyVersion).toBe(NO_SHOW_POLICY_VERSION);
  });
});

describe('feature flag + scope', () => {
  it('defaults OFF', () => {
    expect(NoShowService.isEnabled(undefined)).toBe(false);
    expect(NoShowService.isEnabled(null)).toBe(false);
    expect(NoShowService.isEnabled({ noShowEnabled: false })).toBe(false);
    expect(NoShowService.isEnabled({ noShowEnabled: true })).toBe(true);
  });

  it('UK/GBP only', () => {
    expect(NoShowService.isSupported('GB', 'GBP')).toBe(true);
    expect(NoShowService.isSupported('gb', 'gbp')).toBe(true);
    expect(NoShowService.isSupported('US', 'USD')).toBe(false);
    expect(NoShowService.isSupported('GB', 'USD')).toBe(false);
    expect(NoShowService.isSupported(null, null)).toBe(false);
  });

  it('grace deadline is 5 minutes after arrival', () => {
    const t = '2026-10-05T12:00:00.000Z';
    expect(new Date(NoShowService.graceUntil(t)).getTime() - new Date(t).getTime()).toBe(NO_SHOW_GRACE_MINUTES * 60_000);
  });

  it('reads the disclosed split from a frozen breakdown', () => {
    const split = NoShowService.splitFromBreakdown({
      noShowPolicyVersion: NO_SHOW_POLICY_VERSION,
      noShowFeeMinor: 400,
      noShowDriverShareMinor: 320,
      noShowPlatformShareMinor: 80,
      currency: 'GBP'
    });
    expect(split?.feeMinor).toBe(400);
    expect(split?.driverShareMinor).toBe(320);
    expect(split?.platformShareMinor).toBe(80);

    // A booking without the disclosure returns null (never charged).
    expect(NoShowService.splitFromBreakdown({})).toBeNull();
    expect(NoShowService.splitFromBreakdown(null)).toBeNull();
  });
});
