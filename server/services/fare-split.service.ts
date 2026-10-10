import type { PlatformFeeSettings } from './marketplace-config.service';

/**
 * Single authoritative fare split.
 *
 * POLICY (owner-approved):
 *   C  = complete agreed customer service charge.
 *   P  = configured platform fee calculated INSIDE C (never added on top after agreement).
 *   D  = configured driver commission calculated on (C − P).
 *   driver entitlement = C − P − D.
 *   Movabi gross revenue = P + D.
 *   Pro driver commission D = 0.
 *
 * The customer charge C is the INCLUSIVE total already quoted today
 * (base service fare + platform fee); this module consolidates that arithmetic,
 * applies configured limits BEFORE commission, rejects configurations that would
 * produce a non-positive driver entitlement, and freezes the result as a
 * versioned snapshot so capture/settlement never recompute from live config.
 *
 * Money is carried in major units (e.g. GBP pounds) through the split and
 * converted to minor units only at the currency boundary (Stripe / earnings),
 * using an ISO-4217 exponent so zero/three-decimal currencies are handled.
 */

export const FARE_SPLIT_POLICY_VERSION = 'fare-split-v1';

export interface FareSplitSnapshot {
  policyVersion: string;
  baseServiceFare: number;
  customerCharge: number;
  platformFeeAmount: number;
  driverBase: number;
  driverCommissionAmount: number;
  driverEntitlement: number;
  grossRevenue: number;
  currency: string;
  isPro: boolean;
  commissionPercent: number;
  platformFeeType: PlatformFeeSettings['type'];
  platformFeePercent: number;
  platformFeeFixed: number;
}

export class FareSplitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FareSplitValidationError';
  }
}

export class HistoricalFareReconciliationRequired extends Error {
  constructor(message = 'This job predates the fare-split policy snapshot and requires explicit reconciliation.') {
    super(message);
    this.name = 'HistoricalFareReconciliationRequired';
  }
}

export class FareSplitService {
  static readonly POLICY_VERSION = FARE_SPLIT_POLICY_VERSION;

  private static readonly ZERO_DECIMAL = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF',
    'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'
  ]);

  private static readonly THREE_DECIMAL = new Set([
    'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'
  ]);

  /** ISO-4217 minor-unit exponent for a currency (default 2). */
  static currencyExponent(currency: string): number {
    const code = String(currency || 'GBP').trim().toUpperCase();
    if (this.ZERO_DECIMAL.has(code)) return 0;
    if (this.THREE_DECIMAL.has(code)) return 3;
    return 2;
  }

  /** Round a major-unit money value to the currency's precision. */
  static roundMoney(value: number, currency = 'GBP'): number {
    const factor = Math.pow(10, this.currencyExponent(currency));
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  /** Convert major units to integer minor units (pence). */
  static toMinor(major: number, currency = 'GBP'): number {
    const exp = this.currencyExponent(currency);
    return Math.round(this.roundMoney(major, currency) * Math.pow(10, exp));
  }

  /** Convert integer minor units back to major units. */
  static fromMinor(minor: number, currency = 'GBP'): number {
    const exp = this.currencyExponent(currency);
    return this.roundMoney(minor / Math.pow(10, exp), currency);
  }

  /**
   * The configured platform fee, computed INSIDE the customer charge, with
   * configured limits applied (min/max clamp) before any commission is derived.
   */
  static computePlatformFee(baseServiceFare: number, settings: PlatformFeeSettings): number {
    if (!settings?.enabled) return 0;

    let raw = 0;
    switch (settings.type) {
      case 'fixed':
        raw = Number(settings.fixedAmount || 0);
        break;
      case 'fixed_plus_percentage':
        raw = Number(settings.fixedAmount || 0) + baseServiceFare * (Number(settings.percent || 0) / 100);
        break;
      case 'percentage':
      default:
        raw = baseServiceFare * (Number(settings.percent || 0) / 100);
        break;
    }

    let fee = this.roundMoney(Math.max(0, raw));
    const minFee = Number.isFinite(Number(settings.minFee)) ? Math.max(0, Number(settings.minFee)) : 0;

    // `Number(null) === 0`, so null/undefined/'' must be treated as "no cap",
    // not as a zero cap (which would clamp every fee to 0).
    const maxFeeValue = settings.maxFee as unknown;
    const maxFee =
      maxFeeValue === null || maxFeeValue === undefined || maxFeeValue === ''
        ? null
        : Number.isFinite(Number(maxFeeValue))
          ? Number(maxFeeValue)
          : null;

    if (minFee > 0) fee = Math.max(fee, this.roundMoney(minFee));
    if (maxFee !== null && maxFee >= 0) fee = Math.min(fee, this.roundMoney(maxFee));

    return fee;
  }

  /**
   * Compute the authoritative split. Throws FareSplitValidationError for
   * invalid configuration or a non-positive driver entitlement.
   */
  static compute(input: {
    baseServiceFare: number;
    currency: string;
    platformFee: PlatformFeeSettings;
    driverCommissionPercent: number;
    isPro: boolean;
    policyVersion?: string;
  }): FareSplitSnapshot {
    const base = Number(input.baseServiceFare);
    const currency = String(input.currency || 'GBP').trim().toUpperCase() || 'GBP';
    const platformFee: PlatformFeeSettings = input.platformFee || {
      enabled: false,
      type: 'percentage',
      percent: 0,
      fixedAmount: 0,
      minFee: 0,
      maxFee: null,
      applyToServices: [],
      source: 'none',
      configVersion: null
    };

    if (!Number.isFinite(base) || base <= 0) {
      throw new FareSplitValidationError('The base service fare must be a positive amount.');
    }

    if (platformFee.enabled && (!Number.isFinite(Number(platformFee.percent)) || Number(platformFee.percent) < 0)) {
      throw new FareSplitValidationError('Platform fee percentage is invalid.');
    }
    if (platformFee.enabled && (!Number.isFinite(Number(platformFee.fixedAmount)) || Number(platformFee.fixedAmount) < 0)) {
      throw new FareSplitValidationError('Platform fee fixed amount is invalid.');
    }

    const platformFeeAmount = this.computePlatformFee(base, platformFee);

    // C = base + P (the inclusive total the customer agrees to); P is inside C.
    const customerCharge = this.roundMoney(base + platformFeeAmount, currency);
    // Driver base = C − P (== the base service fare by construction).
    const driverBase = this.roundMoney(customerCharge - platformFeeAmount, currency);

    const commissionPercent = input.isPro ? 0 : Number(input.driverCommissionPercent || 0);
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent >= 100) {
      throw new FareSplitValidationError(`Invalid driver commission rate: ${input.driverCommissionPercent}`);
    }

    const driverCommissionAmount = this.roundMoney(driverBase * commissionPercent / 100, currency);
    const driverEntitlement = this.roundMoney(driverBase - driverCommissionAmount, currency);
    const grossRevenue = this.roundMoney(platformFeeAmount + driverCommissionAmount, currency);

    if (driverEntitlement <= 0) {
      throw new FareSplitValidationError(
        'Configured fees produce a non-positive driver entitlement; refusing to create this fare.'
      );
    }

    return {
      policyVersion: input.policyVersion || this.POLICY_VERSION,
      baseServiceFare: this.roundMoney(base, currency),
      customerCharge,
      platformFeeAmount,
      driverBase,
      driverCommissionAmount,
      driverEntitlement,
      grossRevenue,
      currency,
      isPro: !!input.isPro,
      commissionPercent: this.roundMoney(commissionPercent, currency),
      platformFeeType: platformFee.type,
      platformFeePercent: Number(platformFee.percent || 0),
      platformFeeFixed: Number(platformFee.fixedAmount || 0)
    };
  }

  /** A percentage-only platform fee wrapper for callers that only carry a percent. */
  static percentageFee(percent: number, currency = 'GBP'): PlatformFeeSettings {
    return {
      enabled: Number(percent) > 0,
      type: 'percentage',
      percent: Math.max(0, Number(percent) || 0),
      fixedAmount: 0,
      minFee: 0,
      maxFee: null,
      applyToServices: [],
      source: 'percentage_input',
      configVersion: null
    };
  }

  /**
   * Recover a frozen snapshot from a persisted `fare_breakdown` JSONB object.
   *
   * Two accepted shapes (both were frozen at quote time — never recomputed from
   * live config here):
   *   1. the consolidated policy snapshot (`policyVersion` present);
   *   2. the legacy quote breakdown (`serviceFareBeforePlatformFee` +
   *      `platformFeeAmount`/`platformFee` + `commissionFee` +
   *      `driverNetEarnings`/`driverPayout`).
   *
   * If neither carries any monetary signal the job is historical/ambiguous and
   * settlement refuses (HistoricalFareReconciliationRequired) rather than
   * inventing a new entitlement.
   */
  static fromSnapshot(raw: unknown, currencyFallback = 'GBP'): FareSplitSnapshot {
    const b = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
    const currency = String(b['currency'] || currencyFallback).toUpperCase();
    const num = (key: string, fallback = 0): number => {
      const v = Number(b[key]);
      return Number.isFinite(v) ? v : fallback;
    };

    if (typeof b['policyVersion'] === 'string' && b['policyVersion'].length > 0) {
      return {
        policyVersion: b['policyVersion'] as string,
        baseServiceFare: num('baseServiceFare', num('driverBase', 0)),
        customerCharge: num('customerCharge', 0),
        platformFeeAmount: num('platformFeeAmount', 0),
        driverBase: num('driverBase', 0),
        driverCommissionAmount: num('driverCommissionAmount', 0),
        driverEntitlement: num('driverEntitlement', 0),
        grossRevenue: num('grossRevenue', 0),
        currency,
        isPro: b['isPro'] === true,
        commissionPercent: num('commissionPercent', 0),
        platformFeeType: (b['platformFeeType'] as PlatformFeeSettings['type']) || 'percentage',
        platformFeePercent: num('platformFeePercent', 0),
        platformFeeFixed: num('platformFeeFixed', 0)
      };
    }

    // Legacy quote breakdown — reconstruct strictly from PERSISTED quote numbers.
    const driverBase = num('serviceFareBeforePlatformFee', num('driverGrossEarnings', 0));
    const platformFeeAmount = num('platformFeeAmount', num('platformFee', 0));
    // Both historical serializers must retain the agreed money, never live config.
    const legacyMoney = (keys: string[], fallback: number): number => {
      const values = keys.filter(key => b[key] !== undefined && b[key] !== null).map(key => Number(b[key]));
      if (values.some(value => !Number.isFinite(value) || value < 0) ||
          values.some(value => Math.abs(value - values[0]) > 0.000001)) {
        throw new HistoricalFareReconciliationRequired('Conflicting or invalid historical fare amounts.');
      }
      return values.length ? values[0] : fallback;
    };
    const commissionFee = legacyMoney(['commissionFee', 'commissionAmount'], 0);
    const customerCharge = num('customerCharge', num('total', num('serviceFare', driverBase + platformFeeAmount)));
    const driverEntitlement = legacyMoney(['driverEntitlement', 'driverNetEarnings', 'driverPayout'], this.roundMoney(driverBase - commissionFee, currency));
    const tolerance = 0.000001;
    if (commissionFee > driverBase || Math.abs(driverBase - commissionFee - driverEntitlement) > tolerance ||
        Math.abs(customerCharge - driverBase - platformFeeAmount) > tolerance) {
      throw new HistoricalFareReconciliationRequired('Historical fare amounts do not reconcile.');
    }

    if (driverBase <= 0 && platformFeeAmount <= 0 && customerCharge <= 0) {
      throw new HistoricalFareReconciliationRequired();
    }

    return {
      policyVersion: 'legacy-quote-v0',
      baseServiceFare: driverBase,
      customerCharge,
      platformFeeAmount,
      driverBase,
      driverCommissionAmount: commissionFee,
      driverEntitlement,
      grossRevenue: this.roundMoney(platformFeeAmount + commissionFee, currency),
      currency,
      isPro: b['isPro'] === true,
      commissionPercent: num('commissionPercent', num('commission_rate_used', 0)),
      platformFeeType: (b['platformFeeType'] as PlatformFeeSettings['type']) || 'percentage',
      platformFeePercent: num('platformFeePercent', 0),
      platformFeeFixed: num('platformFeeFixed', 0)
    };
  }
}
