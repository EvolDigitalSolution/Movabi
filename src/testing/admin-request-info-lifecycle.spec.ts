import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DriverRequirementService } from '../../server/services/driver-requirement.service';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const verification = read('server/routes/verification.routes.ts');
const onboardingRoutes = read('server/routes/driver-onboarding.routes.ts');
const page = read('src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts');
const template = page.slice(page.indexOf('template:'), page.indexOf('export class OnboardingPage'));
const pageFlat = page.replace(/\s+/g, ' ');

const ADMIN_REQUEST = {
  id: 'req-1', requirementCode: 'admin.missing_info', requestType: 'missing_info', item: 'Insurance document',
  status: 'pending' as const, publicMessage: 'Upload a clearer insurance certificate.',
  submittedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
  resolvedAt: null, nextAction: 'Correct this item and resubmit it for review.'
};

const resolveRequirements = (adminRequests: typeof ADMIN_REQUEST[] = []) => DriverRequirementService.resolve({
  profile: { full_name: 'Alex Driver', phone: '+447123456789', current_address: '1 High Street', date_of_birth: '1990-01-01', accepted_driver_agreement_at: '2026-01-01T00:00:00.000Z', country_code: 'GB', driver_service_types: [] },
  vehicle: null, authEmailConfirmed: true, adminRequests, countryCode: 'GB'
} as any);

describe('admin request-info persistence path', () => {
  it('reconciles the admin request into driver_onboarding_requests', () => {
    expect(verification).toContain(".from('driver_onboarding_requests')");
    expect(verification).toContain("requirement_code: 'admin.missing_info'");
    expect(verification).toContain("request_type: 'missing_info'");
    expect(verification).toContain("status: 'pending'");
  });

  it('retains the legacy profile columns and review history', () => {
    expect(verification).toContain('driver_review_status:');
    expect(verification).toContain('driver_review_notes:');
    expect(verification).toContain('driver_review_blockers:');
    expect(verification).toContain('driver_review_history: [...previousHistory, historyEntry].slice(-20)');
    expect(verification).toContain('verification_blockers: selectedBlockers');
  });

  it('does not create a duplicate active request', () => {
    // Deterministic single-row lookup: `.maybeSingle()` errors on >1 row and used to
    // fall through to an INSERT that tripped the partial unique index.
    expect(verification).toContain(".eq('requirement_code', 'admin.missing_info')");
    expect(verification).toContain(".in('status', ['pending', 'rejected'])");
    expect(verification).toContain(".order('created_at', { ascending: false })");
    expect(verification).toContain('.limit(1)');
    expect(verification).toContain('const existingOpenRequest = existingOpenRequests?.[0] ?? null;');
    expect(verification).not.toContain("await supabase\n      .from('driver_onboarding_requests')\n      .select('id')\n      .eq('driver_id', driverId)\n      .eq('requirement_code', 'admin.missing_info')\n      .in('status', ['pending', 'rejected'])\n      .maybeSingle();");
  });

  it('updates the existing open request instead of inserting a second one', () => {
    const block = verification.slice(verification.indexOf("const existingOpenRequest"), verification.indexOf('await NotificationService'));
    expect(block).toContain('if (existingOpenRequest) {');
    expect(block).toContain(".update(requestPatch)");
    expect(block).toContain('} else {');
    expect(block.indexOf('.insert(')).toBeGreaterThan(block.indexOf('} else {'));
  });

  it('propagates lookup failures instead of silently inserting', () => {
    expect(verification).toContain('if (existingOpenError) throw existingOpenError;');
  });

  it('scopes resubmission resolution to missing_info so unrelated requests survive', () => {
    expect(onboardingRoutes).toContain(".eq('request_type','missing_info')");
    expect(onboardingRoutes).toContain(".in('status',['pending','rejected'])");
    // An identity-correction request is permission-consumed only when approved.
    expect(onboardingRoutes).toContain(".eq('request_type','identity_correction')");
    expect(onboardingRoutes).toContain(".eq('status','approved')");
    expect(onboardingRoutes).toContain(".is('permission_consumed_at',null)");
  });

  it('exposes the request to the driver through /status without a reload hack', () => {
    expect(onboardingRoutes).toContain("from('driver_onboarding_requests')");
    expect(onboardingRoutes).toContain('adminRequests:visibleRequests');
    expect(onboardingRoutes).toContain('outstandingRequests=visibleRequests.filter(request=>request.status!==\'approved\')');
  });

  it('keeps identity-correction requests visible alongside the automatic requirements', () => {
    expect(onboardingRoutes).toContain("request.requestType==='identity_correction'");
  });
});

describe('admin requests reach the canonical resolver and the right stage', () => {
  it('surfaces an admin.missing_info request as a structured adminRequest', () => {
    const resolution = resolveRequirements([ADMIN_REQUEST]);
    expect(resolution.adminRequests.map(item => item.id)).toContain('req-1');
  });

  it('does not invent a requirement for a question-wide admin request', () => {
    const baseline = resolveRequirements().automaticRequirements.map(item => item.code).sort();
    const withRequest = resolveRequirements([ADMIN_REQUEST]).automaticRequirements.map(item => item.code).sort();
    expect(withRequest).toEqual(baseline);
  });

  it('does not duplicate an admin request whose code collides with an automatic requirement', () => {
    const colliding = { ...ADMIN_REQUEST, id: 'req-2', requirementCode: 'profile.phone' };
    const resolution = resolveRequirements([colliding]);
    // The resolver keeps a single voice: the automatic requirement already reports it.
    expect(resolution.adminRequests.map(item => item.id)).not.toContain('req-2');
    expect(resolution.automaticRequirements.some(item => item.code === 'profile.phone')).toBe(true);
  });

  it('maps a canonical requirement code to the stage that owns it', () => {
    expect(page).toContain('private static readonly STAGE_REQUIREMENT_CODES: string[][] = [');
    // Stage 1 owns the profile identity requirements (a DOB correction lands here).
    expect(pageFlat).toContain("['profile.full_name', 'profile.phone', 'profile.address', 'profile.date_of_birth', 'profile.email_verification']");
    expect(page).toContain('requestStages(request: { requirementCode?: string | null }): number[]');
    expect(page).toContain('return index >= 0 ? [index + 1] : [];');
  });

  it('treats a question-wide request as visible on every stage', () => {
    const method = page.slice(page.indexOf('adminRequestsForStage(stage: number)'), page.indexOf('currentStageAdminRequests() {'));
    expect(method).toContain("return stages.length === 0 || stages.includes(stage);");
    // Approved requests are never surfaced.
    const open = page.slice(page.indexOf('openAdminRequests()'), page.indexOf('adminRequestsForStage(stage: number)'));
    expect(open).toContain("filter(request => request.status !== 'approved')");
  });

  it('Review aggregates every open request, including ones owned by an earlier stage', () => {
    const method = page.slice(page.indexOf('currentStageAdminRequests() {'), page.indexOf('getStripeBadgeText(): string {'));
    expect(method).toContain('if (this.stage() === this.stages.length) return this.openAdminRequests();');
    expect(method).toContain('return this.adminRequestsForStage(this.stage());');
  });

  it('renders the admin request in the relevant stage and in Review', () => {
    expect(template).toContain('@if (currentStageAdminRequests().length)');
    expect(template).toContain('data-stage-admin-request');
    expect(template).toContain('{{request.publicMessage || request.item}}');
    // Stage 1 and Stage 5 both surface it; the global Information Requests feed stays.
    expect(template.indexOf('data-stage-admin-request')).toBeLessThan(template.indexOf('Profile Photo'));
    expect(template).toContain('Information Requests');
    expect(template).toContain('Review');
  });

  it('drives the resume stage from the same code map so the two cannot drift', () => {
    const derive = page.slice(page.indexOf('private deriveStageFromCanonicalState'), page.indexOf('getStripeBadgeText(): string {'));
    expect(derive).toContain('OnboardingPage.STAGE_REQUIREMENT_CODES.length');
    expect(derive).toContain('OnboardingPage.STAGE_REQUIREMENT_CODES[index].some(');
  });
});

describe('admin approval keeps using the canonical resolver', () => {
  const verificationFlat = verification.replace(/\s+/g, ' ');

  it('manual-approve still re-checks canonical requirements before approving', () => {
    expect(verification).toContain('DriverRequirementService.resolve(');
    expect(verification).toContain('DRIVER_REQUIREMENTS_INCOMPLETE');
    expect(verificationFlat).toContain('blockingForSubmission');
  });

  it('request-info never approves or verifies a driver', () => {
    const handler = verification.slice(verification.indexOf("router.post('/drivers/:driverId/request-info'"), verification.indexOf('router.', verification.indexOf("router.post('/drivers/:driverId/request-info'") + 10));
    expect(handler).not.toContain("is_verified: true");
    expect(handler).not.toContain("verification_status: 'approved'");
    expect(handler).not.toContain("driver_review_status: 'approved'");
  });
});
