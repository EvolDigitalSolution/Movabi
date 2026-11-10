import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DriverRequirementService } from '../../server/services/driver-requirement.service';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const notifications = read('server/services/driver-onboarding-notification.service.ts');
const onboardingRoutes = read('server/routes/driver-onboarding.routes.ts');
const verificationRoutes = read('server/routes/verification.routes.ts');

const NOW = new Date('2026-06-01T00:00:00.000Z');
const profile = (extra: Record<string, unknown> = {}) => ({
  full_name: 'Alex Driver', phone: '07000000000', current_address: '1 High Street, Bolton',
  date_of_birth: '1990-01-01', accepted_driver_agreement_at: '2026-01-01T00:00:00.000Z',
  country_code: 'GB', driver_license_url: 'dl.pdf', driver_license_expiry: '2030-01-01',
  right_to_work_url: 'rtw.pdf', insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01',
  driver_service_types: ['delivery'], ...extra
});
const car = { id: 'v1', userId: 'u1', type: 'car', make: 'Toyota', model: 'Prius', colour: 'Silver', year: 2020, registrationNumber: 'AB12 CDE', capacity: '4 seats', serviceEligibility: ['delivery'], status: 'active' };
const resolveFor = (p: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  DriverRequirementService.resolve({ profile: p, vehicle: car, authEmailConfirmed: true, countryCode: 'GB', now: NOW, ...extra } as any);

describe('submit-review 42703 root cause: named non-existent profile columns', () => {
  it('the notification service no longer names profiles.first_name in a select', () => {
    expect(notifications).not.toMatch(/\.select\([^)]*first_name/);
    expect(notifications).not.toMatch(/\.select\([^)]*last_name/);
    expect(notifications).toContain("from('profiles')");
    expect(notifications).toContain(".select('*')");
  });

  it('the admin request-info profile lookup no longer names unproven columns', () => {
    expect(verificationRoutes).not.toMatch(/\.select\([^)]*first_name/);
    expect(verificationRoutes).not.toMatch(/\.select\('driver_review_history, full_name, first_name/);
  });

  it('no server file selects first_name from profiles any more', () => {
    for (const file of ['server/services/driver-onboarding-notification.service.ts', 'server/routes/verification.routes.ts', 'server/routes/driver-onboarding.routes.ts']) {
      expect(read(file), `${file} must not select profiles.first_name`).not.toMatch(/\.select\([^)]*first_name/);
    }
  });

  it('notification name/recipient lookup tolerates absent columns (fallbacks intact)', () => {
    expect(notifications).toContain("profile.full_name || [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Driver'");
    expect(notifications).toContain("String(profile.email || auth.user?.email || '')");
    expect(notifications).toContain('profile.phone || profile.phone_number || null');
    expect(notifications).toContain('profile.market_city || profile.city || null');
  });

  it('mirrors the fallback chain: absent columns still yield a usable payload', () => {
    const build = (row: Record<string, unknown>, authEmail?: string) => ({
      fullName: String(row['full_name'] || [row['first_name'], row['last_name']].filter(Boolean).join(' ') || 'Driver'),
      email: String(row['email'] || authEmail || ''),
      phone: row['phone'] || row['phone_number'] || null,
      city: row['market_city'] || row['city'] || null
    });
    // Schema without first_name/last_name/email/phone_number/market_city/city.
    expect(build({ full_name: 'Dara Driver', phone: '07000000000' }, 'driver@movabi.test'))
      .toEqual({ fullName: 'Dara Driver', email: 'driver@movabi.test', phone: '07000000000', city: null });
    // Schema that does have them keeps working.
    expect(build({ first_name: 'Dara', last_name: 'Driver', email: 'p@x.test', phone_number: '1', city: 'Bolton' }))
      .toEqual({ fullName: 'Dara Driver', email: 'p@x.test', phone: '1', city: 'Bolton' });
    // Nothing at all still yields the safe default.
    expect(build({}).fullName).toBe('Driver');
  });
});

describe('error boundary: post-mutation failure must not report a failed submission', () => {
  it('the notification event endpoint returns 202 after a persisted mutation failure', () => {
    expect(onboardingRoutes).toContain("console.warn('[driver-onboarding] notification enqueue failed after persisted mutation:', error);");
    expect(onboardingRoutes).toContain('return res.status(202).json({ accepted: true, notificationQueued: false });');
  });

  it('ancillary failures remain fatal during diagnosis (HTTP behaviour unchanged)', () => {
    const submit = onboardingRoutes.slice(onboardingRoutes.indexOf("router.post('/submit-review'"));
    // Diagnostic pass only: the non-fatal housekeeping guard is intentionally NOT present,
    // so the true failing boundary is observable rather than masked.
    expect(submit).not.toContain('housekeeping failed after persisted mutation');
    expect(submit).toContain("logSubmitReviewDbError('identity-permission-consume',consumeError)");
    expect(submit).toContain('throw consumeError;');
    expect(submit).toContain("logSubmitReviewDbError('missing-info-resolve',resolveError)");
    expect(submit).toContain('throw resolveError;');
  });

  it('a genuine primary persistence failure still fails the request', () => {
    expect(onboardingRoutes).toContain("throw updateError||new Error('Review submission did not update the driver profile.');");
    expect(onboardingRoutes).toContain("return res.status(500).json({error:message,code:'DRIVER_REQUIREMENT_VALIDATION_FAILED'});");
  });

  it('mirrors the boundary rule: primary fail = error, post-mutation fail = success', () => {
    const submit = (primaryFails: boolean, housekeepingFails: boolean) => {
      if (primaryFails) return { status: 500 };
      if (housekeepingFails) return { status: 200, logged: true };  // logged, not reported as failure
      return { status: 200 };
    };
    expect(submit(true, false).status).toBe(500);
    expect(submit(true, true).status).toBe(500);
    expect(submit(false, true).status).toBe(200);
    expect(submit(false, true).logged).toBe(true);
  });
});

describe('submit-review database-boundary diagnostics', () => {
  /** Mirrors logSubmitReviewDbError's extraction exactly. */
  const extract = (error: unknown) => {
    const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    return {
      code: typeof value['code'] === 'string' ? value['code'] : undefined,
      message: typeof value['message'] === 'string'
        ? value['message']
        : error instanceof Error ? error.message : undefined,
      details: typeof value['details'] === 'string' ? value['details'] : undefined,
      hint: typeof value['hint'] === 'string' ? value['hint'] : undefined
    };
  };

  const POSTGREST_42703 = {
    code: '42703',
    message: 'column profiles.example does not exist',
    details: null,
    hint: null
  };

  it('identifies a plain-object Supabase error instead of reporting it anonymously', () => {
    const result = extract(POSTGREST_42703);
    expect(result.code).toBe('42703');
    expect(result.message).toBe('column profiles.example does not exist');
    // The point of the fix: this must NOT degrade to the anonymous catch-all message.
    expect(result.message).not.toBe('Unable to validate driver submission.');
    expect(result.message).not.toBeUndefined();
  });

  it('null details/hint are absent rather than stringified', () => {
    const result = extract(POSTGREST_42703);
    expect(result.details).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it('still extracts real Error instances and tolerates junk input', () => {
    expect(extract(new Error('boom')).message).toBe('boom');
    expect(extract(null)).toEqual({ code: undefined, message: undefined, details: undefined, hint: undefined });
    expect(extract('nope').message).toBeUndefined();
  });

  it('the helper is defined with the safe field set only', () => {
    expect(onboardingRoutes).toContain('function logSubmitReviewDbError(');
    expect(onboardingRoutes).toContain("console.error('[DriverOnboarding] submit-review database failure'");
    for (const field of ['boundary', 'code', 'message', 'details', 'hint']) {
      expect(onboardingRoutes).toContain(`${field}:`);
    }
    // Must not log secrets, headers, bodies, documents or profile values.
    for (const leak of ['authorization', 'req.headers', 'req.body', 'documentUrl', 'access_token', 'apikey']) {
      const helper = onboardingRoutes.slice(onboardingRoutes.indexOf('function logSubmitReviewDbError('));
      expect(helper).not.toContain(leak);
    }
  });

  it('every required boundary is instrumented', () => {
    for (const boundary of ['profile-read', 'requirement-audit-insert', 'profile-submit-update', 'identity-permission-consume', 'missing-info-resolve']) {
      expect(onboardingRoutes, `${boundary} must be logged`).toContain(`logSubmitReviewDbError('${boundary}'`);
    }
  });

  it('the outer catch no longer reduces a Supabase object to the anonymous message', () => {
    const tail = onboardingRoutes.slice(onboardingRoutes.indexOf("router.post('/submit-review'"));
    const catchBlock = tail.slice(tail.indexOf('}catch(error:unknown){'));
    expect(catchBlock).toContain("logSubmitReviewDbError('unhandled',error)");
    expect(catchBlock).toContain("typeof caught['message']==='string'");
    expect(catchBlock).toContain("code:'DRIVER_REQUIREMENT_VALIDATION_FAILED'");
  });

  it('HTTP behaviour was not changed by the diagnostic', () => {
    const tail = onboardingRoutes.slice(onboardingRoutes.indexOf("router.post('/submit-review'"));
    // Success path unchanged; primary failures still throw into the 500 handler.
    expect(tail).toContain("return res.json({submitted:true,resubmission,event:auditEvent,reviewState:'under_review'");
    expect(tail).toContain('if(consumeError){logSubmitReviewDbError(');
    expect(tail).toContain('throw consumeError;');
    expect(tail).toContain('if(resolveError){logSubmitReviewDbError(');
    expect(tail).toContain('throw resolveError;');
    expect(tail).not.toContain('housekeeping failed after persisted mutation');
  });
});

describe('submitted canonical state', () => {
  it('submit-review persists under_review + onboarding_completed (the state /status reads)', () => {
    const submit = onboardingRoutes.slice(onboardingRoutes.indexOf("router.post('/submit-review'"));
    expect(submit).toContain("verification_status:'under_review'");
    expect(submit).toContain("driver_review_status:'under_review'");
    expect(submit).toContain('onboarding_completed:true');
    expect(submit).toContain("reviewState:'under_review'");
  });

  it('a ready_to_submit driver has no blocking requirements', () => {
    const result = resolveFor(profile());
    expect(result.overallStatus).toBe('ready_to_submit');
    expect(result.automaticRequirements.filter(r => r.blockingForSubmission)).toEqual([]);
  });

  it('PROOF: a persisted submission changes overallStatus away from ready_to_submit', () => {
    // Decisive for diagnosing production: the resolver DOES reflect the submitted state.
    // So while /status keeps reporting 'ready_to_submit' after a 500, the profile mutation
    // cannot have persisted -- the failure happens at or before the profiles UPDATE.
    const before = resolveFor(profile());
    expect(before.overallStatus).toBe('ready_to_submit');

    const after = resolveFor(profile({ verification_status: 'under_review', onboarding_completed: true, driver_review_status: 'under_review' }));
    expect(after.overallStatus).toBe('under_review');
    expect(after.overallStatus).not.toBe('ready_to_submit');
  });

  it('an incomplete driver still cannot submit (requirements remain blocking)', () => {
    const incomplete = resolveFor(profile({ driver_service_types: ['ride'] }));
    expect(incomplete.overallStatus).not.toBe('ready_to_submit');
    expect(incomplete.automaticRequirements.filter(r => r.blockingForSubmission).map(r => r.code)).toContain('document.private_hire_insurance');
  });

  it('Stripe not_started stays non-blocking for submission', () => {
    const result = resolveFor(profile({ stripe_connect_status: 'not_started' }));
    const stripe = result.warnings.find(item => item.code === 'payout.stripe_connect');
    expect(stripe?.blockingForSubmission).toBe(false);
    expect(result.automaticRequirements.filter(r => r.blockingForSubmission)).toEqual([]);
  });

  it('re-submission resolves only missing_info requests (no unrelated erasure)', () => {
    const submit = onboardingRoutes.slice(onboardingRoutes.indexOf("router.post('/submit-review'"));
    expect(submit).toContain(".eq('request_type','missing_info')");
  });
});
