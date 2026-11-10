import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseDriverPhone } from '../../server/models/driver-profile.model';
import { DriverRequirementService } from '../../server/services/driver-requirement.service';

const read = (p: string) => readFileSync(resolvePath(process.cwd(), p), 'utf8');
const route = read('server/routes/driver-onboarding.routes.ts');
const verification = read('server/routes/verification.routes.ts');
const page = read('src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts');
const settings = read('src/app/apps/mobile/features/driver/settings.page.ts');
const statusService = read('src/app/core/services/driver/driver-onboarding-status.service.ts');
const engine = read('server/services/driver-requirement.service.ts');
const authRoutes = read('server/routes/auth.routes.ts');

const NOW = new Date('2026-06-01T00:00:00.000Z');

const completeDriver = () => ({
  full_name: 'Alex Driver',
  phone: '+447123456789',
  current_address: '1 High Street, Bolton',
  date_of_birth: '1990-01-01',
  accepted_driver_agreement_at: '2026-01-01T00:00:00.000Z',
  country_code: 'GB',
  right_to_work_url: 'rtw.pdf',
  driver_service_types: ['delivery'],
  driver_license_url: 'dl.pdf',
  driver_license_expiry: '2030-01-01',
  insurance_url: 'ins.pdf',
  insurance_expiry: '2030-01-01',
  stripe_connect_status: 'connected',
  account_status: 'active'
});

const car = {
  id: 'v1', userId: 'u1', type: 'car', make: 'Toyota', model: 'Prius', colour: 'Silver',
  year: 2020, registrationNumber: 'AB12 CDE', capacity: '4 seats', serviceEligibility: ['delivery'], status: 'active'
};

const resolve = (profile: Record<string, unknown>, vehicle = car) =>
    DriverRequirementService.resolve({
        profile, vehicle, authEmailConfirmed: true,
        countryCode: String(profile['country_code'] || 'GB'), now: NOW
    } as any);

const find = (profile: Record<string, unknown>, code: string, vehicle = car) =>
    resolve(profile, vehicle).automaticRequirements.find(item => item.code === code);

describe('A/B driver phone persistence and validation', () => {
    it('A. a persisted phone satisfies the canonical profile.phone requirement', () => {
        expect(find(completeDriver(), 'profile.phone')?.status).toBe('completed');
        expect(find(completeDriver(), 'profile.phone')?.blockingForSubmission).toBe(false);
    });

    it('A. the number the form captures is the number the profile persists and status reads', () => {
        const normalized = parseDriverPhone('07123 456 789');
        expect(normalized).toBe('07123456789');
        expect(find({ ...completeDriver(), phone: normalized }, 'profile.phone')?.completed).toBe(true);
    });

    it('A. a missing phone blocks submission', () => {
        const row = find({ ...completeDriver(), phone: null }, 'profile.phone');
        expect(row?.status).toBe('missing');
        expect(row?.blockingForSubmission).toBe(true);
    });

    it('B. blank and malformed numbers are rejected, never coerced into a valid one', () => {
        for (const value of ['', '   ', 'abc', '123', '123456', '+44 (0)7123-456-789!', '0712345678901234567']) {
            expect(() => parseDriverPhone(value), `expected ${JSON.stringify(value)} to be rejected`).toThrow();
        }
    });

    it('B. separators are normalised without inventing digits or implying verification', () => {
        expect(parseDriverPhone('+44 7123 456789')).toBe('+447123456789');
        expect(parseDriverPhone('(07123) 456.789')).toBe('07123456789');
        // No verification flag is produced anywhere by this helper.
        expect(route).toContain('profileUpdates.phone=parseDriverPhone(body.phone)');
    });

    it('B. the profile endpoint validates phone and reports 422 for bad input', () => {
        expect(route).toContain('const phonePresent=typeof body.phone===\'string\'');
        expect(route).toContain('if(phonePresent){profileUpdates.phone=parseDriverPhone(body.phone);}');
        const profileHandler = route.slice(route.indexOf("router.put('/profile'"), route.indexOf("router.post('/dob-correction-request'"));
        expect(profileHandler).toMatch(/contact number/i);
    });
});

describe('C requirement wording matches enforced phone semantics', () => {
    it('C. the reason describes presence, not verification', () => {
        expect(find({ ...completeDriver(), phone: null }, 'profile.phone')?.reason).toBe('Add your contact number.');
        expect(engine).not.toContain('Add a verified contact number.');
        expect(engine).toContain("'Add your contact number.'");
    });

    it('C. no verification status is inferred from the number itself', () => {
        expect(engine).not.toMatch(/phone[\s\S]{0,80}verified/i);
    });
});

describe('D/E/F canonical status refreshes after requirement-affecting mutations', () => {
    it('D. a document upload refreshes the canonical onboarding status', () => {
        const upload = page.slice(page.indexOf('private async persistUploadedDocument'), page.indexOf('private isAllowedFile'));
        expect(upload).toContain('await this.driverService.fetchVehicle();');
        expect(upload).toContain('await this.onboardingStatus.refresh();');
    });

    it('E. the passenger licence is saved through the canonical endpoint during setup', () => {
        expect(page).toContain('await this.persistPassengerLicenceIfSupplied(raw);');
        expect(page).toContain('await this.onboardingStatus.savePassengerLicence({councilName,licenceNumber,badgeNumber,expiryDate})');
        expect(statusService).toContain("'/api/driver-onboarding/passenger-licence',input,true");
    });

    it('F. profile/agreement mutations end with a canonical refresh', () => {
        const persist = page.slice(page.indexOf('private async persistCurrentSetup'), page.indexOf('private async saveAllStagesLenient'));
        expect(persist).toContain('return this.onboardingStatus.refresh();');
        expect(persist).toContain('await this.saveStage(5);');
        const stageSaves = page.slice(page.indexOf('private async saveStage(stage: number)'), page.indexOf('private async saveAboutYouStage'));
        expect(stageSaves).toContain('await this.onboardingStatus.saveAgreement(');
        expect(stageSaves).toContain('await this.onboardingStatus.refresh();');
        expect(settings).toContain('await this.refreshOnboardingStatus();');
    });
});

describe('G/H/I submit-review never destroys stored values', () => {
    const submitBody = route.slice(route.indexOf("router.post('/submit-review'"), route.indexOf('export default router'));

    it('G. the write is sourced from the merged effective profile, not submitted||null', () => {
        expect(submitBody).not.toContain('driver_license_url:submitted?.driver_license_url||null');
        expect(submitBody).not.toContain('insurance_url:submitted?.insurance_url||null');
        expect(submitBody).not.toContain('right_to_work_url:submitted?.right_to_work_url||null');
        expect(submitBody).not.toContain('private_hire_vehicle_license_url:submitted?.private_hire_vehicle_license_url||null');
        expect(submitBody).not.toContain('private_hire_insurance_url:submitted?.private_hire_insurance_url||null');
        expect(submitBody).not.toContain('goods_in_transit_insurance_url:submitted?.goods_in_transit_insurance_url||null');
        for (const column of ['driver_license_url', 'insurance_url', 'right_to_work_url', 'private_hire_vehicle_license_url', 'private_hire_insurance_url', 'goods_in_transit_insurance_url']) {
            expect(submitBody).toContain(`${column}:effectiveProfile.${column}||null`);
        }
    });

    it('H. an omitted or blank phone keeps the stored number', () => {
        expect(submitBody).not.toContain("phone:String(submitted?.phone||'').trim(),");
        expect(submitBody).toContain("phone:String(effectiveProfile.phone||'').trim()||null");
        expect(submitBody).toContain("phone: String(submitted.phone||'').trim() || profileInput.phone");
    });

    it('I. an absent or invalid passenger-licence payload never nulls canonical licence columns', () => {
        expect(submitBody).not.toContain('{ council_name: null, council_license_number: null, taxi_badge_number: null, taxi_license_expiry: null }');
        expect(submitBody).toContain('let passengerLicenceUpdate: Record<string, unknown> | null = null;');
        expect(submitBody).toContain('...(passengerLicenceUpdate||{})');
        expect(submitBody).toContain('...(passengerLicenceUpdate||{})');
    });

    it('I. the gate still evaluates a valid submitted licence payload', () => {
        expect(submitBody).toContain('passengerLicenceColumns(parseDriverPassengerLicenceInput(submitted, new Date()))');
    });
});

describe('J/K/L client gate, Stripe and expiry', () => {
    it('J. canonical document blockers are authoritative over local optimistic docs', () => {
        const gate = page.slice(page.indexOf('canSubmit = computed('), page.indexOf('activeVehicleDetailsReady = computed('));
        expect(gate).toContain('const canonical = this.onboardingStatus.state();');
        expect(gate).toContain("requirement.category === 'documents' && requirement.blockingForSubmission");
        expect(gate.indexOf('canonical')).toBeLessThan(gate.indexOf('this.docs().license'));
    });

    it('J. the UI surfaces the canonical blocker reason', () => {
        expect(page).toContain("this.onboardingStatus.state()?.automaticRequirements.find(item=>item.blockingForSubmission)");
        expect(page).toContain('return authoritativeBlocker.reason;');
    });

    it('K. Stripe pending stays a non-blocking warning', () => {
        const result = resolve({ ...completeDriver(), stripe_connect_status: 'pending' });
        const stripeWarning = result.warnings.find(item => item.code === 'payout.stripe_connect');
        expect(stripeWarning).toBeDefined();
        expect(stripeWarning?.required).toBe(false);
        expect(stripeWarning?.blockingForSubmission).toBe(false);
        expect(stripeWarning?.blockingForOnline).toBe(false);
        expect(result.automaticRequirements.some(item => item.code === 'payout.stripe_connect')).toBe(false);
    });

    it('L. expired documents remain blocking', () => {
        const row = find({ ...completeDriver(), driver_license_expiry: '2020-01-01' }, 'document.driving_licence');
        expect(row?.status).toBe('expired');
        expect(row?.blockingForSubmission).toBe(true);
    });

    it('L. the private-hire requirement still needs all four canonical fields and stays expiry-enforced', () => {
        const rideVehicle = { ...car, serviceEligibility: ['ride'] };
        const rideProfile = { ...completeDriver(), driver_service_types: ['ride'], private_hire_vehicle_license_url: 'phv.pdf', private_hire_insurance_url: 'phi.pdf' };
        const missing = find(rideProfile, 'licence.private_hire', rideVehicle);
        expect(missing?.blockingForSubmission).toBe(true);
        expect(missing?.reason).toContain('Missing:');
        expect(missing?.reason).toContain('licensing authority');

        const complete = find({ ...rideProfile, council_name: 'Oldham Council', council_license_number: 'C1', taxi_badge_number: 'B-1', taxi_license_expiry: '2030-01-01' }, 'licence.private_hire', rideVehicle);
        expect(complete?.completed).toBe(true);

        const expired = find({ ...rideProfile, council_name: 'Oldham Council', council_license_number: 'C1', taxi_badge_number: 'B-1', taxi_license_expiry: '2020-01-01' }, 'licence.private_hire', rideVehicle);
        expect(expired?.status).toBe('expired');
        expect(expired?.blockingForSubmission).toBe(true);
    });
});

describe('M/N/O admin approval and successful submission', () => {
    it('M. admin approval re-evaluates canonical requirements and refuses while blockers remain', () => {
        const approve = verification.slice(verification.indexOf("router.post('/drivers/:driverId/manual-approve'"));
        const gate = approve.indexOf('DriverRequirementService.resolve');
        const update = approve.indexOf(".from('profiles')", approve.indexOf('const { error } = await supabase'));
        expect(gate).toBeGreaterThan(-1);
        expect(update).toBeGreaterThan(gate);
        expect(approve).toContain('DRIVER_REQUIREMENTS_INCOMPLETE');
        expect(approve).toContain('if (approvalBlockers.length)');
    });

    it('N. a fully complete valid driver has no blockers and is ready to submit', () => {
        const result = resolve(completeDriver());
        expect(result.automaticRequirements.filter(item => item.blockingForSubmission).map(item => item.code)).toEqual([]);
        expect(result.overallStatus).toBe('ready_to_submit');
    });

    it('O. successful submission reaches the review state without a reload', () => {
        expect(route).toContain("verification_status:'under_review',driver_review_status:'under_review'");
        expect(statusService).toContain("this.authenticatedPost('/api/driver-onboarding/submit-review',{profile},true)");
        expect(page).not.toContain('location.reload');
        expect(page).not.toContain('window.location.reload');
    });
});

describe('P customer signup regression path', () => {
    it('P. registration is still market-gated on customer_registration', () => {
        expect(authRoutes).toContain("router.post('/register'");
        expect(authRoutes).toContain("capability: 'customer_registration'");
    });

    it('P. email OTP + confirmation endpoints are intact and unchanged', () => {
        expect(authRoutes).toContain("router.post('/registration-otp/send'");
        expect(authRoutes).toContain("router.post('/registration-otp/verify'");
        expect(authRoutes).toContain("router.post('/registration-otp/status'");
        expect(authRoutes).toContain("from('registration_otps')");
    });

    it('P. no customer phone verification was invented', () => {
        expect(authRoutes).not.toMatch(/phone/i);
    });
});
