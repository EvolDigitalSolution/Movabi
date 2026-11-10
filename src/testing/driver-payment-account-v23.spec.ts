import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { driverWalletPayoutState } from '../../server/services/booking-payment-context';

const read = (p: string) => readFileSync(p, 'utf8');
const ONBOARDING = read('src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts');
const DASHBOARD = read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');
const SETTINGS = read('src/app/apps/mobile/features/driver/settings.page.ts');
const EARNINGS = read('src/app/apps/mobile/features/driver/earnings/earnings.page.ts');

describe('payment-account status from the backend capability flag', () => {
  it('no provider / unsupported market → unavailable, no setup action', () => {
    const s = driverWalletPayoutState(false, null);
    expect(s.payoutIntegrationAvailable).toBe(false);
    expect(s.payoutAvailable).toBe(false);
    expect(s.status).toBe('Payout setup pending');
  });

  it('configured + connected → completed/available', () => {
    const s = driverWalletPayoutState(true, { eligible: true });
    expect(s.payoutIntegrationAvailable).toBe(true);
    expect(s.payoutAvailable).toBe(true);
    expect(s.status).toBe('Payout account connected');
  });

  it('configured, not started → setup available', () => {
    const s = driverWalletPayoutState(true, { code: 'NO_STRIPE_ACCOUNT', reason: 'Start setup' });
    expect(s.payoutIntegrationAvailable).toBe(true);
    expect(s.payoutAvailable).toBe(false);
    expect(s.status).toBe('Payout setup required');
  });

  it('configured, in progress → setup available', () => {
    const s = driverWalletPayoutState(true, { code: 'ACCOUNT_NOT_READY', reason: 'More info needed' });
    expect(s.payoutIntegrationAvailable).toBe(true);
    expect(s.payoutAvailable).toBe(false);
  });

  it('unverifiable / mismatch → action required, setup not offered', () => {
    for (const code of ['ACCOUNT_UNVERIFIABLE', 'PAYOUT_ACCOUNT_OWNER_MISMATCH', 'PAYOUT_COUNTRY_UNSUPPORTED']) {
      const s = driverWalletPayoutState(true, { code });
      expect(s.payoutIntegrationAvailable).toBe(false);
      expect(s.payoutAvailable).toBe(false);
    }
  });
});

describe('driver-facing wording is provider-neutral and status-correct', () => {
  it('no provider name appears in ordinary driver headings/labels', () => {
    for (const src of [ONBOARDING, DASHBOARD, SETTINGS, EARNINGS]) {
      expect(src).not.toContain('Kora payouts');
      expect(src).not.toContain('Stripe Connect');
      expect(src).not.toContain('Set Up Payouts');
    }
  });

  it('onboarding uses Payment account heading and exact unavailable wording', () => {
    expect(ONBOARDING).toContain('Payment account');
    expect(ONBOARDING).toContain('Payment account setup is not available in your market yet.');
    expect(ONBOARDING).toContain('Set up payment account');
    expect(ONBOARDING).toContain('Continue setup');
  });

  it('onboarding offers no setup button when setup is unavailable', () => {
    expect(ONBOARDING).toContain("paymentAccountStatus() === 'unavailable'");
    // The unavailable branch must not contain the setup action.
    const start = ONBOARDING.indexOf("paymentAccountStatus() === 'unavailable'");
    const branch = ONBOARDING.slice(start, ONBOARDING.indexOf('}', start));
    expect(branch).not.toContain('setupPayouts()');
  });

  it('settings hides the setup action when the capability is unavailable', () => {
    expect(SETTINGS).toContain("payoutContext.wallet()?.payoutIntegrationAvailable !== true");
    expect(SETTINGS).toContain('Payment account setup is not available in your market yet.');
  });

  it('status reflects not started / in progress / completed / unavailable', () => {
    expect(ONBOARDING).toContain("'not_started'");
    expect(ONBOARDING).toContain("'in_progress'");
    expect(ONBOARDING).toContain("'completed'");
    expect(ONBOARDING).toContain("'unavailable'");
  });

  it('the setup action still requires the real provider capability (no silent Kora fallback)', () => {
    expect(ONBOARDING).toContain('requireStripePayoutMarket');
    // Provider is only used for the actual host flow, never for the setup status.
    expect(ONBOARDING).toContain('payoutIntegrationAvailable');
  });
});
