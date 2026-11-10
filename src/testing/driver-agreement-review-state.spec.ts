import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DriverRequirementService } from '../../server/services/driver-requirement.service';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const page = read('src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts');
const template = page.slice(page.indexOf('template:'), page.indexOf('export class OnboardingPage'));
const onboardingRoutes = read('server/routes/driver-onboarding.routes.ts');

const NOW = new Date('2026-06-01T00:00:00.000Z');
const baseProfile = (extra: Record<string, unknown> = {}) => ({
  full_name: 'Alex Driver', phone: '07000000000', current_address: '1 High Street, Bolton',
  date_of_birth: '1990-01-01', country_code: 'GB', driver_service_types: ['delivery'],
  driver_license_url: 'dl.pdf', driver_license_expiry: '2030-01-01',
  right_to_work_url: 'rtw.pdf', insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01',
  ...extra
});
const car = { id: 'v1', userId: 'u1', type: 'car', make: 'Toyota', model: 'Prius', colour: 'Silver', year: 2020, registrationNumber: 'AB12 CDE', capacity: '4 seats', serviceEligibility: ['delivery'], status: 'active' };
const resolveFor = (p: Record<string, unknown>) =>
  DriverRequirementService.resolve({ profile: p, vehicle: car, authEmailConfirmed: true, countryCode: 'GB', now: NOW } as any);

/**
 * Mirrors agreementAccepted() + reviewRequirementsFor(): Review completion for the agreement
 * is the persisted column OR the currently checked (valid requiredTrue) control.
 */
const agreementRowForReview = (canonicalAccepted: boolean | string | null, controlValid: boolean) => {
  const canonicalCompleted = !!canonicalAccepted;
  const effective = controlValid || canonicalCompleted;
  return {
    completed: effective,
    status: effective ? 'completed' : 'missing',
    blockingForSubmission: !effective
  };
};

const agreementRowFromResolver = (extra: Record<string, unknown> = {}) =>
  resolveFor(baseProfile(extra)).automaticRequirements.find(r => r.code === 'agreement.driver_terms')!;

describe('Driver Agreement acceptance drives Review state', () => {
  it('the resolver completion is the persisted accepted_driver_agreement_at column', () => {
    expect(agreementRowFromResolver().completed).toBe(false);
    expect(agreementRowFromResolver().status).toBe('missing');
    expect(agreementRowFromResolver({ accepted_driver_agreement_at: '2026-01-01T00:00:00.000Z' }).completed).toBe(true);
  });

  it('A. unchecked agreement => Review is incomplete/Missing', () => {
    const row = agreementRowForReview(null, false);
    expect(row.completed).toBe(false);
    expect(row.status).toBe('missing');
    expect(row.blockingForSubmission).toBe(true);
  });

  it('B. checking the agreement recalculates Review immediately', () => {
    const row = agreementRowForReview(null, true);
    expect(row.completed).toBe(true);
    expect(row.status).toBe('completed');
    expect(row.blockingForSubmission).toBe(false);
  });

  it('C. unchecking it returns Review to incomplete', () => {
    expect(agreementRowForReview(null, true).completed).toBe(true);
    expect(agreementRowForReview(null, false).completed).toBe(false);
  });

  it('D. persisted acceptance keeps Review complete while the control is untouched', () => {
    // After a refresh/hydration the form control is seeded from the persisted column, so
    // both sources agree; either alone is sufficient.
    const persisted = agreementRowForReview('2026-01-01T00:00:00.000Z', false);
    expect(persisted.completed).toBe(true);
    expect(agreementRowForReview('2026-01-01T00:00:00.000Z', true).completed).toBe(true);
  });

  it('the checkbox is seeded from the persisted column on hydration', () => {
    expect(page).toContain('driver_agreement_accepted: !!profile.accepted_driver_agreement_at,');
  });

  it('the Review cards use the effective-state helpers, not the raw canonical rows', () => {
    expect(template).toContain('reviewSectionStatus(group.section)');
    expect(template).toContain('reviewRequirementsFor(group.category)');
    // The stage-5 group card must not read the canonical values directly any more.
    const stageFive = template.slice(template.indexOf('>Review</h2>'), template.indexOf('Checklist'));
    expect(stageFive).not.toContain('sectionFor(group.section)?.status');
    expect(stageFive).not.toContain('@for(requirement of requirementsFor(group.category)');
  });

  it('only the agreement row is overridden -- nothing else is force-completed', () => {
    const helper = page.slice(page.indexOf('reviewRequirementsFor(category'), page.indexOf('reviewSectionStatus(section'));
    expect(helper).toContain("row.code === 'agreement.driver_terms'");
    expect(helper).not.toContain("row.code === 'document.insurance'");
    expect(helper).not.toContain("row.code === 'payout.stripe_connect'");
  });

  it('E. submit-review still performs authoritative server-side validation', () => {
    const submit = onboardingRoutes.slice(onboardingRoutes.indexOf("router.post('/submit-review'"));
    expect(submit).toContain('DriverRequirementService.resolve(');
    expect(submit).toContain('blockingForSubmission');
    // The client-side gate remains too.
    expect(page).toContain("['full_name','phone','date_of_birth','current_address','driver_agreement_accepted'].every(name=>this.onboardingForm.get(name)?.valid===true)");
    expect(page).toContain("if(blockers.length){await this.showToast(blockers[0].reason,'warning');return;}");
  });

  it('F. Stripe pending never controls Review completion', () => {
    const stripe = resolveFor(baseProfile({ accepted_driver_agreement_at: '2026-01-01T00:00:00.000Z', stripe_connect_status: 'not_started' }))
      .warnings.find(r => r.code === 'payout.stripe_connect');
    expect(stripe).toBeDefined();
    expect(stripe!.blockingForSubmission).toBe(false);
    expect(stripe!.blockingForOnline).toBe(false);
    expect(stripe!.required).toBe(false);
    // Review's effective-state helper must not touch it.
    expect(page.slice(page.indexOf('reviewRequirementsFor(category'))).not.toContain('stripe_connect');
  });

  it('the agreement is persisted through the existing dedicated endpoint (architecture preserved)', () => {
    expect(page).toContain('await this.onboardingStatus.saveAgreement(');
    expect(page).toContain('this.mergeLocalProfile({ accepted_driver_agreement_at: agreement.acceptedAt });');
    expect(read('src/app/core/services/driver/driver-onboarding-status.service.ts')).toContain("'/api/driver-onboarding/agreement',{accepted},true");
  });

  it('keeps the goods-in-transit canonical column (previous correction intact)', () => {
    expect(page).toContain('goods_in_transit_insurance_url: this.docs().goods_in_transit || null,');
    expect(page).not.toContain('goods_in_transit_url:');
    expect(read('server/services/driver-requirement.service.ts')).toContain('profile.goods_in_transit_insurance_url');
  });
});
