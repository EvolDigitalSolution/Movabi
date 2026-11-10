/**
 * Fare-split authority — the single source of the customer-charge split.
 *
 * POLICY: C = complete agreed customer charge; P = configured platform fee
 * inside C; D = driver commission on (C − P); driver entitlement = C − P − D;
 * Movabi gross revenue = P + D; Pro driver D = 0.
 *
 * These tests exercise the real computation (not file contents) so rounding,
 * fee modes, limits, invalid-configuration rejection and currency exponents
 * are all verified against the implementation.
 */
import { describe, expect, it } from 'vitest';
import {
  FareSplitService,
  FareSplitValidationError,
  HistoricalFareReconciliationRequired,
  FARE_SPLIT_POLICY_VERSION
} from '../../server/services/fare-split.service';

const pct = (percent: number) => FareSplitService.percentageFee(percent);

const settings = (partial: Record<string, unknown>) => ({
  enabled: true,
  type: 'percentage',
  percent: 0,
  fixedAmount: 0,
  minFee: 0,
  maxFee: null,
  applyToServices: [],
  source: 'test',
  configVersion: null,
  ...partial
});

describe('standard/pro split', () => {
  it('standard: C = P + D + entitlement, revenue = P + D', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 100,
      currency: 'GBP',
      platformFee: settings({ percent: 10 }),
      driverCommissionPercent: 15,
      isPro: false
    });
    expect(s.customerCharge).toBe(110);      // 100 + 10
    expect(s.platformFeeAmount).toBe(10);
    expect(s.driverBase).toBe(100);          // C − P
    expect(s.driverCommissionAmount).toBe(15);
    expect(s.driverEntitlement).toBe(85);    // 100 − 15
    expect(s.grossRevenue).toBe(25);         // 10 + 15
    expect(s.policyVersion).toBe(FARE_SPLIT_POLICY_VERSION);
  });

  it('pro: commission D = 0', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 100,
      currency: 'GBP',
      platformFee: settings({ percent: 10 }),
      driverCommissionPercent: 15,
      isPro: true
    });
    expect(s.driverCommissionAmount).toBe(0);
    expect(s.driverEntitlement).toBe(100);
    expect(s.grossRevenue).toBe(10);
    expect(s.isPro).toBe(true);
  });

  it('entitlement + revenue always equals the customer charge', () => {
    for (const [base, pf, dc, pro] of [
      [100, 0, 0, false],
      [57.35, 8, 12, false],
      [100, 10, 15, false],
      [100, 10, 15, true]
    ] as const) {
      const s = FareSplitService.compute({
        baseServiceFare: base, currency: 'GBP',
        platformFee: settings({ percent: pf }),
        driverCommissionPercent: dc, isPro: pro
      });
      expect(FareSplitService.roundMoney(s.driverEntitlement + s.grossRevenue, 'GBP'))
        .toBe(s.customerCharge);
    }
  });
});

describe('platform fee modes (fixed / percentage / combined)', () => {
  it('percentage', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP',
      platformFee: settings({ type: 'percentage', percent: 5 }),
      driverCommissionPercent: 0, isPro: false
    });
    expect(s.platformFeeAmount).toBe(5);
    expect(s.customerCharge).toBe(105);
  });

  it('fixed', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP',
      platformFee: settings({ type: 'fixed', fixedAmount: 3.5 }),
      driverCommissionPercent: 0, isPro: false
    });
    expect(s.platformFeeAmount).toBe(3.5);
    expect(s.customerCharge).toBe(103.5);
  });

  it('fixed_plus_percentage', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP',
      platformFee: settings({ type: 'fixed_plus_percentage', fixedAmount: 2, percent: 5 }),
      driverCommissionPercent: 0, isPro: false
    });
    expect(s.platformFeeAmount).toBe(7);       // 2 + 5
    expect(s.customerCharge).toBe(107);
  });

  it('disabled platform fee is zero', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP',
      platformFee: settings({ enabled: false, percent: 20 }),
      driverCommissionPercent: 0, isPro: false
    });
    expect(s.platformFeeAmount).toBe(0);
  });
});

describe('fee limits and rounding', () => {
  it('min fee raises a tiny platform fee to the floor', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP',
      platformFee: settings({ percent: 0.5, minFee: 2 }),
      driverCommissionPercent: 0, isPro: false
    });
    expect(s.platformFeeAmount).toBe(2);
  });

  it('max fee caps the platform fee', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP',
      platformFee: settings({ percent: 50, maxFee: 20 }),
      driverCommissionPercent: 0, isPro: false
    });
    expect(s.platformFeeAmount).toBe(20);
    expect(s.customerCharge).toBe(120);
  });

  it('limits are applied before commission is derived', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP',
      platformFee: settings({ percent: 50, maxFee: 20 }),
      driverCommissionPercent: 10, isPro: false
    });
    // driverBase = 120 − 20 = 100; commission on 100.
    expect(s.driverCommissionAmount).toBe(10);
    expect(s.driverEntitlement).toBe(90);
  });

  it('rounds to the currency precision (2dp GBP)', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 10.115, currency: 'GBP',
      platformFee: settings({ percent: 33.3 }),
      driverCommissionPercent: 12.5, isPro: false
    });
    // platformFee = 10.115 * 0.333 ≈ 3.368 → 3.37; C = 13.485 → 13.49
    expect(s.platformFeeAmount).toBe(3.37);
    expect(s.customerCharge).toBe(13.49);
    expect(s.driverBase).toBe(10.12);
  });
});

describe('invalid configuration rejection', () => {
  it('rejects a non-positive base service fare', () => {
    expect(() => FareSplitService.compute({
      baseServiceFare: 0, currency: 'GBP', platformFee: settings({}), driverCommissionPercent: 0, isPro: false
    })).toThrow(FareSplitValidationError);
  });

  it('rejects a commission rate >= 100', () => {
    expect(() => FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP', platformFee: settings({}), driverCommissionPercent: 100, isPro: false
    })).toThrow(FareSplitValidationError);
  });

  it('rejects a negative platform fee percent', () => {
    expect(() => FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP', platformFee: settings({ percent: -1 }), driverCommissionPercent: 0, isPro: false
    })).toThrow(FareSplitValidationError);
  });

  it('a large fixed fee raises the customer charge but never reduces the driver below the base', () => {
    // P is added INSIDE C (C = base + P), so the driver base is unchanged and
    // a fixed fee cannot zero the driver entitlement — only commission/base can.
    const s = FareSplitService.compute({
      baseServiceFare: 100, currency: 'GBP',
      platformFee: settings({ type: 'fixed', fixedAmount: 101 }),
      driverCommissionPercent: 0, isPro: false
    });
    expect(s.platformFeeAmount).toBe(101);
    expect(s.customerCharge).toBe(201);
    expect(s.driverBase).toBe(100);
    expect(s.driverEntitlement).toBe(100);
  });
});

describe('currency-aware minor arithmetic', () => {
  it('uses 2dp exponent for GBP', () => {
    expect(FareSplitService.currencyExponent('GBP')).toBe(2);
    expect(FareSplitService.toMinor(12.34, 'GBP')).toBe(1234);
    expect(FareSplitService.fromMinor(1234, 'GBP')).toBe(12.34);
  });

  it('uses 0dp exponent for JPY', () => {
    expect(FareSplitService.currencyExponent('JPY')).toBe(0);
    expect(FareSplitService.toMinor(1000, 'JPY')).toBe(1000);
  });

  it('uses 3dp exponent for BHD', () => {
    expect(FareSplitService.currencyExponent('BHD')).toBe(3);
    expect(FareSplitService.toMinor(1.234, 'BHD')).toBe(1234);
  });

  it('round-trips major → minor → major', () => {
    const s = FareSplitService.compute({
      baseServiceFare: 42.42, currency: 'GBP', platformFee: settings({ percent: 8 }), driverCommissionPercent: 11, isPro: false
    });
    const minor = FareSplitService.toMinor(s.driverEntitlement, s.currency);
    expect(Number.isInteger(minor)).toBe(true);
    expect(FareSplitService.fromMinor(minor, s.currency)).toBe(s.driverEntitlement);
  });
});

describe('snapshot recovery', () => {
  it('reads the consolidated snapshot', () => {
    const s = FareSplitService.fromSnapshot({
      policyVersion: FARE_SPLIT_POLICY_VERSION,
      baseServiceFare: 100, customerCharge: 110, platformFeeAmount: 10,
      driverBase: 100, driverCommissionAmount: 15, driverEntitlement: 85,
      grossRevenue: 25, currency: 'GBP', isPro: false, commissionPercent: 15
    });
    expect(s.driverEntitlement).toBe(85);
    expect(s.platformFeeAmount).toBe(10);
    expect(s.grossRevenue).toBe(25);
  });

  it('reconstructs the legacy quote breakdown from PERSISTED numbers', () => {
    const s = FareSplitService.fromSnapshot({
      serviceFareBeforePlatformFee: 90,
      platformFeeAmount: 10,
      commissionFee: 13.5,
      driverNetEarnings: 76.5
    }, 'GBP');
    expect(s.driverBase).toBe(90);
    expect(s.platformFeeAmount).toBe(10);
    expect(s.driverCommissionAmount).toBe(13.5);
    expect(s.driverEntitlement).toBe(76.5);
    expect(s.grossRevenue).toBe(23.5);
  });

  it('rejects an empty/ambiguous snapshot for reconciliation', () => {
    expect(() => FareSplitService.fromSnapshot({}, 'GBP')).toThrow(HistoricalFareReconciliationRequired);
    expect(() => FareSplitService.fromSnapshot(null, 'GBP')).toThrow(HistoricalFareReconciliationRequired);
  });
});

describe('legacy marketplace commission aliases',()=>{
 const quote={total:7.07,serviceFareBeforePlatformFee:6.93,platformFeeAmount:0.14,commissionAmount:0.69,commissionPercent:10,driverPayout:6.24};
 it('preserves the stored 10 percent commission and net driver payout',()=>{
  const split=FareSplitService.fromSnapshot(quote,'GBP');
  expect(split.driverEntitlement).toBe(6.24);expect(split.driverCommissionAmount).toBe(0.69);expect(split.grossRevenue).toBe(0.83);
 });
 it('rejects conflicting commission aliases',()=>expect(()=>FareSplitService.fromSnapshot({...quote,commissionFee:0},'GBP')).toThrow(HistoricalFareReconciliationRequired));
 it('rejects conflicting payout aliases',()=>expect(()=>FareSplitService.fromSnapshot({...quote,driverNetEarnings:6.93},'GBP')).toThrow(HistoricalFareReconciliationRequired));
 it('rejects an inconsistent stored payout',()=>expect(()=>FareSplitService.fromSnapshot({...quote,driverPayout:6.93},'GBP')).toThrow(HistoricalFareReconciliationRequired));
 it('retains explicit zero commission without inventing a new rate',()=>expect(FareSplitService.fromSnapshot({...quote,commissionAmount:0,driverPayout:6.93},'GBP').driverCommissionAmount).toBe(0));
});
