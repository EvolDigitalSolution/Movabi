import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DriverRequirementService } from '../../server/services/driver-requirement.service';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const page = read('src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts');
const template = page.slice(page.indexOf('template:'), page.indexOf('export class OnboardingPage'));
const statusService = read('src/app/core/services/driver/driver-onboarding-status.service.ts');

const NOW = new Date('2026-06-01T00:00:00.000Z');

const baseProfile = (extra: Record<string, unknown> = {}) => ({
    full_name: 'Alex Driver',
    phone: '+447123456789',
    current_address: '1 High Street, Bolton',
    date_of_birth: '1990-01-01',
    accepted_driver_agreement_at: '2026-01-01T00:00:00.000Z',
    country_code: 'GB',
    driver_license_url: 'dl.pdf',
    driver_license_expiry: '2030-01-01',
    insurance_url: 'ins.pdf',
    insurance_expiry: '2030-01-01',
    right_to_work_url: 'rtw.pdf',
    ...extra
});

const car = (services: string[]) => ({
    id: 'v1', userId: 'u1', type: 'car', make: 'Toyota', model: 'Prius', colour: 'Silver',
    year: 2020, registrationNumber: 'AB12 CDE', capacity: '4 seats', serviceEligibility: services, status: 'active'
});

const bicycle = () => ({
    id: 'v2', userId: 'u1', type: 'bicycle', make: null, model: null, colour: null, year: null,
    registrationNumber: null, capacity: 'bicycle', serviceEligibility: ['delivery'], status: 'active'
});

const resolveFor = (profile: Record<string, unknown>, vehicle: any) =>
    DriverRequirementService.resolve({
        profile, vehicle, authEmailConfirmed: true,
        countryCode: String(profile['country_code'] || 'GB'), now: NOW
    } as any);

const blockingCodes = (profile: Record<string, unknown>, vehicle: any) =>
    resolveFor(profile, vehicle).automaticRequirements.filter(r => r.blockingForSubmission).map(r => r.code).sort();

describe('five-stage progressive onboarding structure', () => {
    it('defines the five stages in the required order', () => {
        const stages = page.slice(page.indexOf('readonly stages = ['), page.indexOf('stage = signal(1)'));
        for (const [id, label] of [[1, 'About you'], [2, 'Identity'], [3, 'Driving & work eligibility'], [4, 'Vehicle & insurance'], [5, 'Review & submit']] as const) {
            expect(stages, `stage ${id}`).toContain(`id: ${id}, label: '${label}'`);
        }
    });

    it('shows one stage at a time rather than the whole form', () => {
        expect(template).toContain('@if (stage() === 1) {');
        expect(template).toContain('@if (stage() === 4) {');
        expect(template).toContain('@if (stage() === 5) {');
        expect(template).toContain("stage() === 2 || stage() === 3 || stage() === 4");
    });

    it('renders a five-step progress indicator with Back and Continue', () => {
        expect(template).toContain('@for(item of stages;track item.id)');
        expect(template).toContain('Stage {{stage()}} of {{stages.length}}');
        expect(template).toContain('(click)="backStage()"');
        expect(template).toContain('(click)="advanceStage()"');
        expect(template).toContain('(click)="goToStage(item.id)"');
        expect(page).toContain('backStage(): void');
        expect(page).toContain('async advanceStage(): Promise<void>');
        expect(page).toContain('goToStage(id: number): void');
    });

    it('keeps Admin action-required information visible', () => {
        // Outstanding Requests are rendered outside every stage block, so an
        // action_required driver sees them on whichever stage they are on.
        const outstanding = template.indexOf('Outstanding Requests');
        const firstStage = template.indexOf('@if (stage() === 1) {');
        expect(outstanding).toBeGreaterThan(-1);
        expect(outstanding).toBeLessThan(firstStage);
    });
});

describe('stage-specific persistence has no artificial dependencies', () => {
    it('Stage 1 saves profile data only and never touches the vehicle', () => {
        const stage1 = page.slice(page.indexOf('private async saveAboutYouStage'), page.indexOf('private restoreStage'));
        expect(stage1).toContain('saveCurrentProfile');
        expect(stage1).not.toContain('updateVehicle');
        expect(stage1).not.toContain('vehicleFields');
        expect(stage1).not.toContain('saveVerificationItems');
        expect(stage1).not.toContain('saveAgreement');
    });

    it('Stage 1 validates only its own fields (address/phone/name/DOB)', () => {
        const stage1 = page.slice(page.indexOf('private async saveAboutYouStage'), page.indexOf('private restoreStage'));
        expect(stage1).toContain("if (address.length < 5) throw new Error('A valid residential address is required.')");
        expect(stage1).not.toMatch(/make|license_plate|taxi_badge/);
    });

    it('saveStage dispatches per stage without cross-stage requirements', () => {
        const saveStage = page.slice(page.indexOf('private async saveStage(stage: number)'), page.indexOf('private async saveAboutYouStage'));
        expect(saveStage).toContain('if (stage === 1) { await this.saveAboutYouStage(); return; }');
        expect(saveStage).toContain('if (stage === 3) {');
        expect(saveStage).toContain('if (stage === 4) {');
        // Vehicle validation lives only in stage 4.
        expect(saveStage.indexOf('vehicleFields')).toBeGreaterThan(saveStage.indexOf('if (stage === 4) {'));
    });

    it('the full save is composed from the same per-stage saves', () => {
        const persist = page.slice(page.indexOf('private async persistCurrentSetup'), page.indexOf('private async saveAllStagesLenient'));
        expect(persist).toContain('await this.saveAboutYouStage();');
        expect(persist).toContain('await this.saveStage(4);');
        expect(persist).toContain('await this.saveStage(3);');
        expect(persist).toContain('await this.saveStage(5);');
    });

    it('"Save and Continue Later" persists Stage 1 even when later stages are incomplete', () => {
        expect(page).toContain('const everythingSaved = await this.saveAllStagesLenient();');
        const lenient = page.slice(page.indexOf('private async saveAllStagesLenient'), page.indexOf('private async persistPassengerLicenceIfSupplied'));
        expect(lenient.indexOf('await this.saveAboutYouStage();')).toBeLessThan(lenient.indexOf('await this.saveStage(stage)'));
    });
});

describe('canonical visibility replaces local-only rules', () => {
    it('right-to-work is gated by the canonical requirement', () => {
        expect(template).toContain("@if (stage() === 3 && requirementVisible('work.right_to_work'))");
    });

    it('private-hire licensing is gated by the canonical licence requirement', () => {
        expect(template).toContain("stage() === 3 && requirementVisible('licence.private_hire')");
    });

    it('PHV vehicle licence and PHV insurance are gated by their canonical codes', () => {
        expect(template).toContain("stage() === 4 && requirementVisible('document.private_hire_vehicle_license')");
        expect(template).toContain("stage() === 4 && requirementVisible('document.private_hire_insurance')");
    });

    it('goods-in-transit is gated by its canonical code, not a local country rule', () => {
        expect(template).toContain("stage() === 4 && requirementVisible('document.goods_in_transit')");
        expect(template).not.toContain('@if (requiresGoodsInTransit()) {');
    });

    it('the Review stage renders canonical automaticRequirements with the four status words', () => {
        expect(template).toContain('@for(requirement of requirementsFor(group.category);track requirement.code)');
        expect(page).toContain('reviewRequirements()');
        expect(page).toContain("if (requirement.status === 'under_review') return 'Under review';");
        expect(page).toContain("if (requirement.completed) return 'Complete';");
        expect(page).toContain("if (requirement.status === 'missing') return 'Missing';");
        expect(page).toContain("return 'Action required';");
    });

    it('no local requirement rule is introduced in the page', () => {
        // Visibility and completion must both come from the canonical payload.
        expect(page).toContain('requirementVisible(code: string): boolean');
        expect(page).toContain('this.onboardingStatus.state()?.automaticRequirements');
        expect(page).not.toContain('this.isRequirementCompleteLocally');
    });
});

describe('resume behaviour', () => {
    it('restores the drafted stage, otherwise derives it from canonical state', () => {
        expect(page).toContain("private readonly stageKey = 'driver_onboarding_stage_v1';");
        expect(page).toContain('this.restoreStage();');
        expect(page).toContain('this.deriveStageFromCanonicalState()');
    });

    it('derives the earliest stage with an outstanding canonical requirement', () => {
        const derive = page.slice(page.indexOf('private deriveStageFromCanonicalState'), page.indexOf('getStripeBadgeText(): string {'));
        expect(derive).toContain("return !!requirement && requirement.blockingForSubmission;");
        expect(derive).toContain('if (outstanding) return index + 1;');
        expect(derive).toContain('return this.stages.length;');
        // Stage 1 owns the profile requirements.
        expect(derive).toContain("['profile.full_name', 'profile.phone', 'profile.address', 'profile.date_of_birth', 'profile.email_verification']");
    });

    it('keeps the existing local draft mechanism intact', () => {
        expect(page).toContain("private readonly draftKey = 'driver_onboarding_draft_v2';");
        expect(page).toContain('this.restoreDraft();');
        expect(page).toContain('this.saveDraft();');
    });

    it('allows returning to an earlier stage without clearing later data', () => {
        const back = page.slice(page.indexOf('backStage(): void'), page.indexOf('async advanceStage'));
        expect(back).not.toContain('clearDraft');
        expect(back).not.toContain('reset');
        expect(back).toContain('this.persistStage();');
    });
});

describe('canonical eligibility is unchanged by the redesign (presentation only)', () => {
    const completeGbDelivery = () => baseProfile({ driver_service_types: ['delivery'] });

    it('GB delivery: complete driver has no blockers', () => {
        expect(blockingCodes(completeGbDelivery(), car(['delivery']))).toEqual([]);
        expect(resolveFor(completeGbDelivery(), car(['delivery'])).overallStatus).toBe('ready_to_submit');
    });

    it('GB delivery: missing documents block exactly the expected codes', () => {
        const profile = baseProfile({ driver_service_types: ['delivery'], driver_license_url: null, insurance_url: null, right_to_work_url: null });
        expect(blockingCodes(profile, car(['delivery']))).toEqual([
            'document.driving_licence', 'document.insurance', 'work.right_to_work'
        ]);
    });

    it('NG delivery: right-to-work is not required', () => {
        const profile = baseProfile({ country_code: 'NG', driver_service_types: ['delivery'], right_to_work_url: null });
        expect(blockingCodes(profile, car(['delivery']))).toEqual([]);
    });

    it('GB ride: passenger licensing, PHV vehicle licence and PHV insurance are required', () => {
        const profile = baseProfile({ driver_service_types: ['ride'] });
        expect(blockingCodes(profile, car(['ride']))).toEqual([
            'document.private_hire_insurance', 'document.private_hire_vehicle_license', 'licence.private_hire'
        ]);
    });

    it('GB ride: complete council detail clears the licensing blocker', () => {
        const profile = baseProfile({
            driver_service_types: ['ride'], council_name: 'Oldham Council', council_license_number: 'C1',
            taxi_badge_number: 'B-1', taxi_license_expiry: '2030-01-01',
            private_hire_vehicle_license_url: 'phv.pdf', private_hire_insurance_url: 'phi.pdf'
        });
        expect(blockingCodes(profile, car(['ride']))).toEqual([]);
    });

    it('non-ride services never require PHV evidence', () => {
        for (const service of ['delivery']) {
            const codes = blockingCodes(baseProfile({ driver_service_types: [service] }), car([service]));
            expect(codes.some(code => code.includes('private_hire'))).toBe(false);
        }
    });

    it('GB van-moving requires goods-in-transit; NG van-moving does not', () => {
        const gb = baseProfile({ driver_service_types: ['van-moving'] });
        expect(blockingCodes(gb, car(['van-moving']))).toContain('document.goods_in_transit');

        const ng = baseProfile({ country_code: 'NG', driver_service_types: ['van-moving'] });
        expect(blockingCodes(ng, car(['van-moving']))).not.toContain('document.goods_in_transit');
    });

    it('bicycle: declaration follows the vehicle type, equipment must be confirmed, no registration needed', () => {
        const profile = baseProfile({ driver_service_types: ['delivery'] });

        // No persisted vehicle type -> declaration and equipment both outstanding.
        expect(blockingCodes(profile, { ...bicycle(), type: '' })).toEqual(['vehicle.bicycle_declaration', 'vehicle.delivery_equipment']);

        // A persisted bicycle type satisfies the declaration; only equipment remains.
        expect(blockingCodes(profile, bicycle())).toEqual(['vehicle.delivery_equipment']);

        const confirmed = baseProfile({
            driver_service_types: ['delivery'],
            verification_items: [{ key: 'delivery_equipment_confirmed', value: 'true' }]
        });
        expect(blockingCodes(confirmed, bicycle())).toEqual([]);
    });

    it('Stripe pending stays non-blocking for submission', () => {
        const profile = baseProfile({ driver_service_types: ['delivery'], stripe_connect_status: 'pending' });
        const result = resolveFor(profile, car(['delivery']));
        expect(blockingCodes(profile, car(['delivery']))).toEqual([]);
        expect(result.warnings.find(item => item.code === 'payout.stripe_connect')?.blockingForSubmission).toBe(false);
    });
});

describe('vehicle re-save is idempotent for an existing vehicle', () => {
    const getCanonicalPlateSource = () => {
        const start = page.indexOf('private getCanonicalPlate');
        return page.slice(start, page.indexOf('private async refreshVehicleForValidation'));
    };

    it('a blank stored plate must not discard the plate the driver typed', () => {
        // Regression: `?? fallback` kept a stored '' and blocked the re-save with
        // "Add the vehicle registration plate before submitting."
        const source = getCanonicalPlateSource();
        expect(source).toContain("const fromVehicle = String(vehicle?.license_plate ?? '').trim();");
        expect(source).toContain('if (fromVehicle) return fromVehicle;');
        expect(source).toContain("return String(fallback ?? '').trim();");
        expect(source).not.toContain('vehicle?.license_plate ?? fallback');
    });

    it('mirrors the production rule: blank stored plate falls back, stored plate wins otherwise', () => {
        const canonicalPlate = (vehicle: { license_plate?: string | null } | null, fallback?: unknown) => {
            const fromVehicle = String(vehicle?.license_plate ?? '').trim();
            if (fromVehicle) return fromVehicle;
            return String(fallback ?? '').trim();
        };

        // Existing vehicle with a blank plate column (the failing condition).
        expect(canonicalPlate({ license_plate: '' }, 'AB12 CDE')).toBe('AB12 CDE');
        expect(canonicalPlate({ license_plate: '   ' }, 'AB12 CDE')).toBe('AB12 CDE');
        // Existing vehicle with a real plate stays authoritative.
        expect(canonicalPlate({ license_plate: 'XY34 ZZZ' }, 'AB12 CDE')).toBe('XY34 ZZZ');
        // No vehicle at all: the driver's plate is used.
        expect(canonicalPlate(null, 'AB12 CDE')).toBe('AB12 CDE');
        // Nothing anywhere still yields empty, so required-field validation still fires.
        expect(canonicalPlate(null, undefined)).toBe('');
        expect(canonicalPlate({ license_plate: '' }, '')).toBe('');
    });

    it('the registration requirement is still enforced after the fallback change', () => {
        // The guard that rejects a genuinely missing plate is untouched.
        const build = page.slice(page.indexOf('private buildVehiclePayload'), page.indexOf('private parseVerificationItems'));
        expect(build).toContain('if (registrationRequired && (!plate || plate.length === 0))');
        expect(build).toContain("throw new Error('Add the vehicle registration plate before submitting.');");
    });
});

describe('submission semantics stay server-owned', () => {
    it('submission still goes through the canonical submit-review endpoint', () => {
        expect(page).toContain('await this.onboardingStatus.submitForReview(');
        expect(statusService).toContain("'/api/driver-onboarding/submit-review',{profile},true");
    });

    it('submission stays blocked while canonical blockers remain', () => {
        expect(page).toContain('const latestStatus=await this.persistCurrentSetup();');
        expect(page).toContain('const blockers=latestStatus.automaticRequirements.filter(requirement=>requirement.blockingForSubmission);');
        expect(page).toContain("if(blockers.length){await this.showToast(blockers[0].reason,'warning');return;}");
    });

    it('uploading evidence never sets a verified state', () => {
        expect(page).not.toContain('is_verified: true');
        expect(page).not.toContain("status: 'approved'");
        expect(page).not.toContain('verified: true');
    });

    it('does not introduce OCR/DVS or a selfie column', () => {
        expect(page.toLowerCase()).not.toContain('ocr');
        expect(page.toLowerCase()).not.toContain('dvs');
        expect(page).not.toContain('live_selfie_url:');
    });
});
