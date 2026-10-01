import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const customer = read('src/app/apps/mobile/features/customer/onboarding/onboarding.page.ts');
const driverOnboarding = read('src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts');
const authRoutes = read('server/routes/auth.routes.ts');

/**
 * Mirrors the live phone control rule exactly:
 *   phone: ['', [Validators.required, Validators.minLength(7)]]
 * `required` rejects the empty string; `minLength(7)` requires at least 7 characters.
 */
const phoneValid = (value: unknown): boolean => {
  const text = String(value ?? '');
  if (text.length === 0) return false;
  return text.length >= 7;
};

describe('customer onboarding no longer fakes phone verification', () => {
  it('A. contains no Math.random OTP generation', () => {
    expect(customer).not.toContain('Math.random');
    expect(customer).not.toContain('generateOtp');
  });

  it('B. contains no client-held expected OTP or sent flag', () => {
    expect(customer).not.toContain('expectedOtp');
    expect(customer).not.toContain('otpSent');
    // No OTP form control or OTP-specific validators remain.
    expect(customer).not.toContain('formControlName="otp"');
    expect(customer).not.toMatch(/'otp'|\botp:/);
    expect(customer).not.toContain('/^\\d{6}$/');
    expect(customer).not.toContain('one-time-code');
  });

  it('C. no user-facing text claims verification or exposes the stub', () => {
    for (const forbidden of [
      'test account',
      'Connect an SMS provider',
      'SMS provider',
      'Verification code sent',
      'Verification code',
      'Code not recognised',
      'Enter the code sent to your phone',
      'Verify & Continue',
      'Send Verification Code',
      'Phone verified',
      'Verification complete'
    ]) {
      expect(customer, `"${forbidden}" must be gone`).not.toContain(forbidden);
    }
  });

  it('C2. the button describes the real action, not verification', () => {
    expect(customer).toContain('Finish setup');
    expect(customer).not.toMatch(/Verify|verification code/i);
  });

  it('D. phone remains required with the existing validation', () => {
    expect(customer).toContain("phone: ['', [Validators.required, Validators.minLength(7)]]");

    expect(phoneValid('')).toBe(false);
    expect(phoneValid(undefined)).toBe(false);
    expect(phoneValid('123')).toBe(false);
    expect(phoneValid('123456')).toBe(false);
    expect(phoneValid('1234567')).toBe(true);
    expect(phoneValid('+447700900123')).toBe(true);
  });

  it('D2. phone collection copy is honest and present', () => {
    expect(customer).toContain('<span>Phone number</span>');
    expect(customer).toContain('Add a phone number so drivers and MOVABI can contact you about your bookings when needed.');
  });

  it('E. a valid phone completes onboarding with no OTP step in the path', () => {
    // The only gate before persistence is overall form validity -- there is no OTP branch.
    expect(customer).toContain('if (this.profileForm.invalid) {');
    const completion = customer.slice(customer.indexOf('async finishOnboarding'), customer.indexOf('private async showSetupAlert'));
    expect(completion).not.toMatch(/otp|Otp|OTP/);
    expect(completion.indexOf('this.profileForm.invalid')).toBeLessThan(completion.indexOf('updateProfile('));
    // Exactly one interactive gate, and it is the form validity check.
    expect(completion.match(/markAllAsTouched\(\)/g)).toHaveLength(1);
  });

  it('F. completion still persists the required customer fields', () => {
    const completion = customer.slice(customer.indexOf('updateProfile('), customer.indexOf('this.authService.onboardingCompleted'));
    expect(completion).toContain('onboarding_completed: true');
    expect(completion).toContain("role: 'customer'");
    expect(completion).toContain("full_name: String(this.profileForm.value.fullName || '').trim()");
    expect(completion).toContain("phone: String(this.profileForm.value.phone || '').trim()");
    // Navigation and local auth state unchanged.
    expect(customer).toContain("await this.router.navigateByUrl('/customer', { replaceUrl: true });");
    expect(customer).toContain('this.authService.onboardingCompleted.set(true);');
    expect(customer).toContain("this.authService.userRole.set('customer');");
  });

  it('G. no verified-state column is written by the client', () => {
    for (const column of ['phone_verified', 'phone_verified_at', 'phone_verification_supported', 'phone_confirmed_at']) {
      expect(customer, `${column} must not be written`).not.toContain(column);
    }
  });

  it('no dead OTP styling or helper remains', () => {
    expect(customer).not.toContain('.otp-note');
    expect(customer).toContain('.field-hint');
    // showSetupAlert is still legitimately used for the validation message.
    expect(customer).toContain("await this.showSetupAlert('Details needed'");
  });
});

describe('scope containment', () => {
  it('H. driver onboarding is unaffected by this change', () => {
    expect(driverOnboarding).not.toContain('Math.random');
    expect(driverOnboarding).not.toContain('generateOtp');
    // Driver phone authority stays presence-only; no verification requirement introduced.
    expect(driverOnboarding).not.toContain('phone_verified');
  });

  it('I. the existing registration EMAIL OTP system is intact', () => {
    expect(authRoutes).toContain("router.post('/registration-otp/send'");
    expect(authRoutes).toContain("router.post('/registration-otp/verify'");
    expect(authRoutes).toContain("router.post('/registration-otp/status'");
    expect(authRoutes).toContain('const OTP_TTL_MS = 10 * 60 * 1000;');
    expect(authRoutes).toContain('otpLimiter');
    expect(authRoutes).toContain("from('registration_otps')");
    // Email delivery, not SMS -- unchanged by this patch.
    expect(authRoutes).toContain('EmailService.sendRegistrationOtp');
  });

  it('no server, schema or Stripe surface was touched by the client fix', () => {
    expect(customer).not.toContain('stripe');
    expect(customer).not.toContain('goods_in_transit');
  });
});
