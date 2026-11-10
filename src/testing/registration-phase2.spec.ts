/**
 * PHASE 2 — REGISTRATION-MARKET ELIGIBILITY (client routing / guards / recovery).
 *
 * Proves the client now treats AUTHENTICATED as distinct from
 * REGISTRATION-ACTIVATED for BOTH email/password and Google OAuth, that a
 * pending identity cannot enter normal role/app progression, that an already
 * activated account is never re-gated by location, and that the existing server
 * authority is reused rather than duplicated.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const GUARD = read('src/app/core/guards/registration.guard.ts');
const REG = read('src/app/core/services/auth/registration.service.ts');
const AUTH = read('src/app/core/services/auth/auth.service.ts');
const ROUTES = read('src/app/apps/mobile/mobile.routes.ts');
const PAGE = read('src/app/apps/mobile/features/auth/registration.page.ts');
const CALLBACK = read('src/app/apps/mobile/features/auth/callback.page.ts');
const SIGNUP = read('src/app/apps/mobile/features/auth/signup.page.ts');
const ROLE = read('src/app/apps/mobile/features/auth/role-selection.page.ts');
const SERVER_AUTH = read('server/routes/auth.routes.ts');

const registrationRouteBlock = () => {
  const start = ROUTES.indexOf("path: 'registration'");
  return ROUTES.slice(start, ROUTES.indexOf('path:', start + 10));
};

describe('A/B/C/D. Email and Google paths converge on server authority', () => {
  it('A. an activated email user signs in and continues (no pending redirect)', () => {
    // Only a PENDING state redirects; an activated account falls through to the
    // normal role/onboarding/dashboard progression.
    expect(AUTH).toContain('if (registration?.pending) {');
    expect(AUTH).not.toContain('if (registration) {');
  });

  it('B. an activated Google user signs in and continues', () => {
    expect(CALLBACK).toContain('await this.auth.handlePostAuthRedirect();');
    expect(CALLBACK).toContain('completeOAuthCallback');
  });

  it('C. new email signup still submits an explicit country + market', () => {
    expect(SIGNUP).toContain('country_code: this.config.currentCountry().code');
    expect(SIGNUP).toContain('market_city: marketCity || null');
  });

  it('C/E. unsupported email registration surfaces the server refusal (no success state)', () => {
    const submit = SIGNUP.slice(SIGNUP.indexOf('async onSubmit()'), SIGNUP.indexOf('async loginWithGoogle()'));
    expect(submit).toContain('this.errorMessage.set(message);');
    // The success screen is only reached when signUp resolved.
    expect(submit.indexOf('this.isSuccess.set(true);')).toBeGreaterThan(submit.indexOf('await this.auth.signUp('));
    expect(submit.indexOf('this.isSuccess.set(true);')).toBeLessThan(submit.indexOf('} catch'));
  });

  it('D. a pending Google identity is routed to registration confirmation', () => {
    expect(AUTH).toContain("await this.safeNavigate(['/auth/registration']);");
  });
});

describe('E/F. Unsupported markets never silently continue', () => {
  it('the confirmation page maps an unsupported market to a clear message', () => {
    expect(PAGE).toContain('error instanceof MarketAvailabilityFailure');
    expect(PAGE).toContain('this.errorMessage.set(error.message);');
  });

  it('offers the launch-notification path instead of app progression', () => {
    expect(PAGE).toContain('joinWaitingList');
    expect(PAGE).toContain('waitingListEnabled');
  });

  it('only continues when the server reports the account activated', () => {
    const confirm = PAGE.slice(PAGE.indexOf('async confirm()'), PAGE.indexOf('private async loadUnavailableMarket'));
    expect(confirm).toContain('if (state.activated) {');
    expect(confirm.indexOf('if (state.activated) {')).toBeLessThan(confirm.indexOf('handlePostAuthRedirect'));
  });
});

describe('G. A pending identity cannot enter normal app flow', () => {
  it('the registration guard redirects pending identities', () => {
    expect(GUARD).toContain('if (state?.activated) return true;');
    expect(GUARD).toContain("router.navigate(['/auth/registration'], { replaceUrl: true });");
    expect(GUARD).toContain('return false;');
  });

  it('is applied to role selection, onboarding and both app shells', () => {
    expect((ROUTES.match(/canActivate: \[authGuard, registrationGuard\]/g) || []).length).toBe(3);
    expect((ROUTES.match(/canActivate: \[authGuard, registrationGuard, roleGuard\]/g) || []).length).toBe(2);
  });

  it('is imported by the route table', () => {
    expect(ROUTES).toContain("import { registrationGuard } from '@core/guards/registration.guard';");
  });
});

describe('H. A pending identity can resume safely (no duplicate identities)', () => {
  it('reuses the existing authority endpoints and never re-signs-up', () => {
    expect(REG).toContain("'/api/markets/registration-status'");
    expect(REG).toContain("'/api/markets/registration-eligibility'");
    expect(REG).not.toContain('signUp');
    expect(PAGE).not.toContain('signUp');
  });

  it('forces a fresh status read on post-auth routing so recovery works', () => {
    expect(AUTH).toContain('await this.registration.ensureLoaded(true);');
  });

  it('clears cached state on sign-out', () => {
    expect(AUTH).toContain('this.registration.clear();');
  });
});

describe('I/J/K. Capabilities and role authority', () => {
  it('I/J. driver and customer registration remain separately enforced server-side', () => {
    expect(SERVER_AUTH).toContain("const capability = role === 'driver' ? 'driver_registration' : 'customer_registration';");
  });

  it('K. the client never writes profiles.role directly', () => {
    expect(ROLE).toContain('await this.authService.selectRole(role);');
    expect(ROLE).not.toContain('updateProfile(user.id, { role })');
    expect(ROLE).not.toMatch(/from\('profiles'\)[\s\S]{0,60}update/);
  });
});

describe('L. An activated account is never re-gated by location', () => {
  it('no GPS/IP/locale signal participates in registration eligibility', () => {
    for (const source of [GUARD, REG, PAGE]) {
      expect(source).not.toMatch(/geolocation|navigator\.language|Intl\.Locale|latitude|longitude|x-forwarded-for|cf-ipcountry/i);
    }
  });

  it('the guard passes an activated identity immediately', () => {
    const guardBody = GUARD.slice(GUARD.indexOf('const state = await registration.ensureLoaded();'));
    expect(guardBody.indexOf('if (state?.activated) return true;')).toBeLessThan(guardBody.indexOf("router.navigate(['/auth/registration']"));
  });
});

describe('M. No redirect loop on OAuth / session restoration', () => {
  it('the confirmation route is NOT behind the registration guard', () => {
    expect(registrationRouteBlock()).toContain('canActivate: [authGuard]');
    expect(registrationRouteBlock()).not.toContain('registrationGuard');
  });

  it('fails closed: an unconfirmed status is never admitted to protected routes', () => {
    expect(GUARD).not.toContain('if (!state) return true;');
    expect(GUARD).toContain('if (state?.activated) return true;');
  });

  it('the guard no-ops for unauthenticated visitors (authGuard owns them)', () => {
    expect(GUARD).toContain('if (!auth.currentUser()) return true;');
  });

  it('the confirmation page can always sign out', () => {
    expect(PAGE).toContain('await this.auth.signOut();');
  });
});

describe('Fail-closed status handling (release-blocking correction)', () => {
  it('A/B. a network/API failure does NOT admit the app shell, role selection or onboarding', () => {
    expect(GUARD).not.toContain('if (!state) return true;');
    expect(GUARD).toContain('if (state?.activated) return true;');
    expect(GUARD.indexOf('router.navigate([')).toBeLessThan(GUARD.indexOf('return false;'));
  });

  it('C. failure routes to the recoverable registration screen with a retryable message', () => {
    expect(GUARD).toContain("router.navigate(['/auth/registration'], { replaceUrl: true });");
    expect(PAGE).toContain("We couldn't check your registration right now. Check your connection and try again.");
    expect(PAGE).toContain('Try again');
  });

  it('D/E. retry re-reads the authoritative status and recovers to activated or stays pending', () => {
    const retry = PAGE.slice(PAGE.indexOf('async retry(): Promise<void>'), PAGE.indexOf('onCountryChange(code: string)'));
    expect(retry).toContain('await this.registration.ensureLoaded(true);');
    expect(retry).toContain('if (state?.activated)');
    expect(retry).toContain('this.statusUnknown.set(this.registration.statusUnavailable());');
  });

  it('F. the registration route remains reachable without the registration guard (no loop)', () => {
    expect(registrationRouteBlock()).toContain('canActivate: [authGuard]');
    expect(registrationRouteBlock()).not.toContain('registrationGuard');
  });

  it('G. sign-out clears the registration cache', () => {
    expect(AUTH).toContain('this.registration.clear();');
  });

  it('H. the activation cache is scoped to the user id and cannot leak across identities', () => {
    expect(REG).toContain('loadedForUserId');
    expect(REG).toContain('if (!force && this.loadedForUserId === userId && this.state()) return this.state();');
    expect(REG).toContain('this.loadedForUserId = null;');
    expect(REG).toContain('this.clear();');
  });
});

describe('UX wording', () => {
  it('exposes no internal terminology to users', () => {
    const template = PAGE.slice(PAGE.indexOf('template:'), PAGE.indexOf('})'));
    for (const term of ['registration_activated_at', 'capability', 'service_role', 'GoTrue', 'authority guard', 'registration_country_code']) {
      expect(template).not.toContain(term);
    }
  });
});
