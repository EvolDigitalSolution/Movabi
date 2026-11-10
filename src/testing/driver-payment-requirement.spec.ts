import { describe, expect, it } from 'vitest';
import { DriverRequirementService } from '../../server/services/driver-requirement.service';

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'driver-1',
  role: 'driver',
  country_code: 'NG',
  registration_country_code: 'NG',
  full_name: 'Test Driver',
  phone: '+2348000000000',
  residential_address: '1 Test Street',
  date_of_birth: '1990-01-01',
  accepted_driver_agreement_at: '2026-01-01T00:00:00Z',
  driver_service_types: ['delivery'],
  verification_items: '{}',
  ...over,
});

const resolve = (paymentAccount: unknown, over: Record<string, unknown> = {}) =>
  DriverRequirementService.resolve({
    profile: profile(over),
    authEmailConfirmed: true,
    countryCode: String(over['registration_country_code'] ?? over['country_code'] ?? 'NG'),
    paymentAccount: paymentAccount as never,
  });

const payment = (result: ReturnType<typeof resolve>) =>
  result.automaticRequirements.find(row => row.code === 'payout.payment_account');

describe('GB keeps the existing Stripe Connect path', () => {
  it('requires a verified payment account while retaining the Stripe path', () => {
    const result = resolve(undefined, { country_code: 'GB', registration_country_code: 'GB' });
    expect(payment(result)?.required).toBe(true);
    expect(payment(result)?.blockingForSubmission).toBe(true);
    expect(result.warnings.some(row => row.code === 'payout.stripe_connect')).toBe(true);
  });

  it('does not mistake a local connected mirror for server-verified readiness', () => {
    const result = resolve(undefined, { country_code: 'GB', registration_country_code: 'GB', stripe_connect_status: 'connected' });
    expect(result.warnings.some(row => row.code === 'payout.stripe_connect')).toBe(false);
    expect(payment(result)?.completed).toBe(false);
  });
  it('accepts existing server-verified Stripe readiness without using Flutterwave',()=>{
    const result=resolve({provider:'stripe',state:'completed',available:true},{country_code:'GB',registration_country_code:'GB'});
    expect(payment(result)?.completed).toBe(true);
    expect(payment(resolve({provider:'flutterwave',state:'completed',available:true},{country_code:'GB',registration_country_code:'GB'}))?.completed).toBe(false);
  });
});

describe('NG requires a server-verified Flutterwave payment account', () => {
  it('completes only when the server reports completed', () => {
    const result = resolve({ provider: 'flutterwave', state: 'completed', available: true });
    const row = payment(result);
    expect(row?.completed).toBe(true);
    expect(row?.blockingForSubmission).toBe(false);
    expect(row?.blockingForOnline).toBe(false);
    expect(row?.status).toBe('completed');
  });

  it('blocks submission before setup starts', () => {
    const result = resolve({ provider: 'flutterwave', state: 'not_started', available: true });
    const row = payment(result);
    expect(row?.required).toBe(true);
    expect(row?.blockingForSubmission).toBe(true);
    expect(row?.blockingForOnline).toBe(true);
    expect(row?.reason).toMatch(/Set up your payment account/i);
  });

  it('blocks while setup is in progress', () => {
    const row = payment(resolve({ provider: 'flutterwave', state: 'in_progress', available: true }));
    expect(row?.blockingForSubmission).toBe(true);
    expect(row?.reason).toMatch(/in progress/i);
  });

  it('flags action required for review after a failed verification', () => {
    const row = payment(resolve({ provider: 'flutterwave', state: 'action_required', available: true }));
    expect(row?.blockingForSubmission).toBe(true);
    expect(row?.needsAdminReview).toBe(true);
  });

  it('blocks with the honest market message when no provider is approved', () => {
    const row = payment(resolve({ provider: null, state: 'unavailable', available: false }));
    expect(row?.blockingForSubmission).toBe(true);
    expect(row?.reason).toBe('Payment account setup is not available in your market yet.');
  });

  it('fails closed when the payment state could not be read at all', () => {
    const row = payment(resolve(undefined));
    expect(row?.blockingForSubmission).toBe(true);
    expect(row?.reason).toBe('Payment account setup is not available in your market yet.');
  });

  it('surfaces the payment blocker in documents progress and online reasons', () => {
    const result = resolve({ provider: 'flutterwave', state: 'not_started', available: true });
    expect(result.sectionStatus.documents.status).not.toBe('complete');
    expect(result.onlineEligibility.reasons.some(reason => /payment account/i.test(reason))).toBe(true);
    expect(result.progress.percentage).toBeLessThan(100);
  });

  it('completion means destination verification, not identity or KYC', () => {
    const row = payment(resolve({ provider: 'flutterwave', state: 'completed', available: true }));
    expect(row?.reason).toMatch(/destination verified/i);
    expect(row?.reason).not.toMatch(/identity|KYC|ownership/i);
  });

  it('payment completion does not complete separate identity requirements', () => {
    const result = resolve(
      { provider: 'flutterwave', state: 'completed', available: true },
      { date_of_birth: null, residential_address: null },
    );
    expect(result.automaticRequirements.find(row => row.code === 'profile.date_of_birth')?.completed).toBe(false);
    expect(result.automaticRequirements.find(row => row.code === 'profile.address')?.completed).toBe(false);
    expect(payment(result)?.completed).toBe(true);
  });

  it('does not mark the payment requirement complete from a non-completed state', () => {
    for (const state of ['not_started', 'in_progress', 'action_required', 'reconciliation_required', 'unavailable']) {
      const row = payment(resolve({ provider: 'flutterwave', state, available: state !== 'unavailable' }));
      expect(row?.completed).toBe(false);
      expect(row?.blockingForSubmission).toBe(true);
    }
  });
  it('does not complete NG from a disabled or different provider result',()=>{
    expect(payment(resolve({provider:'flutterwave',state:'completed',available:false}))?.completed).toBe(false);
    expect(payment(resolve({provider:'stripe',state:'completed',available:true}))?.completed).toBe(false);
  });
});
