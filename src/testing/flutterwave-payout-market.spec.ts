import { describe, expect, it } from 'vitest';
import { payoutMarketReady, payoutTransfersEnabled, FlutterwaveDriverPayout } from '../../server/services/payments/flutterwave-driver-payout';

const market = (over: Record<string, unknown> = {}) => ({
  country_code: 'NG',
  currency_code: 'NGN',
  provider: 'flutterwave',
  merchant_account_ref: 'flw-ng-merchant',
  enabled: true,
  merchant_approved: true,
  adapter_ready: true,
  capability_verified_at: '2026-10-28T00:00:00Z',
  capability_evidence_ref: 'evidence-1',
  merchant_mode: 'test',
  ...over,
});

describe('Flutterwave payout market readiness', () => {
  it('accepts only the fully verified NG/NGN test configuration', () => {
    expect(payoutMarketReady(market())).toBe(true);
  });

  it('rejects an unapproved or disabled market', () => {
    expect(payoutMarketReady(market({ enabled: false }))).toBe(false);
    expect(payoutMarketReady(market({ merchant_approved: false }))).toBe(false);
    expect(payoutMarketReady(market({ adapter_ready: false }))).toBe(false);
  });

  it('rejects unverified capability evidence and live mode', () => {
    expect(payoutMarketReady(market({ capability_verified_at: null }))).toBe(false);
    expect(payoutMarketReady(market({ capability_evidence_ref: null }))).toBe(false);
    expect(payoutMarketReady(market({ merchant_mode: 'live' }))).toBe(false);
  });

  it('does not assume Flutterwave for other countries, currencies or providers', () => {
    expect(payoutMarketReady(market({ country_code: 'GB', currency_code: 'GBP' }))).toBe(false);
    expect(payoutMarketReady(market({ country_code: 'GH', currency_code: 'GHS' }))).toBe(false);
    expect(payoutMarketReady(market({ country_code: 'KE', currency_code: 'KES' }))).toBe(false);
    expect(payoutMarketReady(market({ provider: 'stripe' }))).toBe(false);
    expect(payoutMarketReady(null)).toBe(false);
  });
});

describe('account setup is separated from money movement', () => {
  it('transfers stay disabled unless the separate explicit flag is set', () => {
    expect(payoutTransfersEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(payoutTransfersEnabled({ VAYDU_DRIVER_PAYOUT_SANDBOX: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(payoutTransfersEnabled({ VAYDU_DRIVER_PAYOUT_TRANSFERS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('a setup-only adapter refuses to submit a transfer (no network call)', async () => {
    const adapter = new FlutterwaveDriverPayout('FLWSECK_TEST-synthetic', 'k'.repeat(32));
    await expect(adapter.submit({
      reference: 'vaydu-synthetic_PMCK',
      amountMinor: 100,
      currency: 'NGN',
      beneficiary: { id: '1', bank_code: '044', last4: '1234', fingerprint: 'f'.repeat(64) },
    })).rejects.toThrow(/transfers are disabled/i);
  });
});
