import { describe, expect, it } from 'vitest';
import { DriverRequirementService, type DriverVehicleValidation } from '../../server/services/driver-requirement.service';
import { DriverOnlineEligibilityService } from '../../server/services/driver-online-eligibility.service';
import { mapDriverProfile } from '../../server/models/driver-profile.model';

const NOW = new Date('2026-08-04');

const profile = (overrides: Record<string, unknown> = {}) => ({
    id: 'driver-1',
    full_name: 'Alex Driver',
    phone: '07000000000',
    current_address: '1 High Street',
    date_of_birth: '1990-01-01',
    accepted_driver_agreement_at: '2026-01-01',
    country_code: 'GB',
    right_to_work_url: 'rtw.pdf',
    driver_license_url: 'dl.pdf',
    driver_license_expiry: '2030-01-01',
    insurance_url: 'ins.pdf',
    insurance_expiry: '2030-01-01',
    driver_service_types: ['delivery'],
    verification_items: { bicycle_declaration: true, delivery_equipment_confirmed: true },
    ...overrides
});

const car: DriverVehicleValidation = {
    id: 'car-1', userId: 'driver-1', type: 'car', make: 'Ford', model: 'Focus',
    colour: 'Blue', year: 2020, registrationNumber: 'AB12 CDE',
    capacity: 'standard', serviceEligibility: ['delivery'], status: 'saved'
};

const resolve = (p = profile(), v: DriverVehicleValidation | null = car) =>
    DriverRequirementService.resolve({ profile: p, vehicle: v, authEmailConfirmed: true, now: NOW });

const find = (p: ReturnType<typeof resolve>, code: string) =>
    p.automaticRequirements.find((requirement) => requirement.code === code);

const online = (p: ReturnType<typeof resolve>) =>
    DriverOnlineEligibilityService.evaluate({
        profile: { account_status: 'active', stripe_connect_status: 'connected' },
        market: { allowed: true, code: null },
        requirements: p,
        vehiclePresent: true,
        locationPermission: true
    });

describe('canonical document expiry', () => {
    it('A. driving licence: valid / today / expiring soon / expired boundaries', () => {
        expect(find(resolve(), 'document.driving_licence')?.status).toBe('completed');
        expect(find(resolve(profile({ driver_license_expiry: '2026-08-04' })), 'document.driving_licence')?.status).toBe('completed');
        expect(find(resolve(profile({ driver_license_expiry: '2026-08-05' })), 'document.driving_licence')?.expiringSoon).toBe(true);
        expect(find(resolve(profile({ driver_license_expiry: '2026-08-05' })), 'document.driving_licence')?.blockingForSubmission).toBe(false);
        const expired = find(resolve(profile({ driver_license_expiry: '2026-08-03' })), 'document.driving_licence');
        expect(expired?.status).toBe('expired');
        expect(expired?.blockingForSubmission).toBe(true);
        expect(expired?.blockingForOnline).toBe(true);
    });

    it('B. insurance: same expiry boundaries', () => {
        expect(find(resolve(), 'document.insurance')?.status).toBe('completed');
        expect(find(resolve(profile({ insurance_expiry: '2026-08-04' })), 'document.insurance')?.status).toBe('completed');
        expect(find(resolve(profile({ insurance_expiry: '2026-08-06' })), 'document.insurance')?.expiringSoon).toBe(true);
        expect(find(resolve(profile({ insurance_expiry: '2026-08-02' })), 'document.insurance')?.status).toBe('expired');
    });

    it('C. passenger licence: incomplete -> missing, expired -> expired, soon -> completed + warning', () => {
        const rideBase = {
            driver_service_types: ['ride'],
            council_name: 'Oldham Council',
            council_license_number: 'C1',
            taxi_badge_number: 'B1',
            private_hire_vehicle_license_url: 'phv.pdf',
            private_hire_insurance_url: 'phi.pdf'
        };

        expect(find(resolve(profile({ driver_service_types: ['ride'] })), 'licence.private_hire')?.status).toBe('missing');

        const expired = find(resolve(profile({ ...rideBase, taxi_license_expiry: '2026-08-03' })), 'licence.private_hire');
        expect(expired?.status).toBe('expired');
        expect(expired?.blockingForSubmission).toBe(true);
        expect(expired?.reason).toContain('expired');

        const soon = find(resolve(profile({ ...rideBase, taxi_license_expiry: '2026-08-10' })), 'licence.private_hire');
        expect(soon?.status).toBe('completed');
        expect(soon?.expiringSoon).toBe(true);
        expect(soon?.blockingForSubmission).toBe(false);
    });

    it('D. private-hire vehicle licence: expired -> expired for Ride', () => {
        const ride = profile({
            driver_service_types: ['ride'],
            council_name: 'Oldham Council',
            council_license_number: 'C1',
            taxi_badge_number: 'B1',
            taxi_license_expiry: '2030-01-01',
            private_hire_vehicle_license_url: 'phv.pdf',
            vehicle_license_expiry: '2026-08-03',
            private_hire_insurance_url: 'phi.pdf'
        });
        expect(find(resolve(ride), 'document.private_hire_vehicle_license')?.status).toBe('expired');
    });

    it('E. goods in transit: expired -> expired for van-moving (GB)', () => {
        const van = profile({
            driver_service_types: ['van-moving'],
            goods_in_transit_insurance_url: 'git.pdf',
            goods_in_transit_insurance_expiry: '2026-08-03'
        });
        const smallVan = { ...car, type: 'van', capacity: 'small_van', serviceEligibility: ['van-moving'] };
        expect(find(resolve(van, smallVan), 'document.goods_in_transit')?.status).toBe('expired');
    });

    it('F. applicability: an expired ride-only requirement does not appear for delivery', () => {
        const delivery = profile();
        expect(find(resolve(delivery), 'document.private_hire_vehicle_license')).toBeUndefined();
        expect(find(resolve(delivery), 'licence.private_hire')).toBeUndefined();
    });
});

describe('go-online enforcement', () => {
    it('G. an expired mandatory document returns REQUIRED_DOCUMENTS_EXPIRED', () => {
        const result = online(resolve(profile({ driver_license_expiry: '2026-08-02' })));
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('REQUIRED_DOCUMENTS_EXPIRED');
    });

    it('expiring soon does NOT block go-online', () => {
        const result = online(resolve(profile({ driver_license_expiry: '2026-08-10' })));
        expect(result.code).not.toBe('REQUIRED_DOCUMENTS_EXPIRED');
        expect(result.code).not.toBe('DRIVER_ACTION_REQUIRED');
    });
});

describe('profile field satisfaction', () => {
    it('H. address precedence: current_address > address_line1 > home_address', () => {
        expect(mapDriverProfile({ id: '1', current_address: 'A' }, true).residentialAddress).toBe('A');
        expect(mapDriverProfile({ id: '1', address_line1: 'B' }, true).residentialAddress).toBe('B');
        expect(mapDriverProfile({ id: '1', home_address: 'C' }, true).residentialAddress).toBe('C');
        expect(mapDriverProfile({ id: '1' }, true).residentialAddress).toBeNull();
        expect(mapDriverProfile({ id: '1', current_address: '', address_line1: 'B' }, true).residentialAddress).toBe('B');
    });

    it('I. driver agreement: accepted_driver_agreement_at satisfies (not boolean)', () => {
        expect(find(resolve(), 'agreement.driver_terms')?.status).toBe('completed');
        expect(find(resolve(profile({ accepted_driver_agreement_at: null, driver_agreement_accepted: true })), 'agreement.driver_terms')?.status).toBe('missing');
    });

    it('J. right to work: URL or share code satisfies; both absent -> missing for GB', () => {
        expect(find(resolve(), 'work.right_to_work')?.status).toBe('completed');
        expect(find(resolve(profile({ right_to_work_url: null, right_to_work_share_code: 'RTW-1' })), 'work.right_to_work')?.status).toBe('completed');
        expect(find(resolve(profile({ right_to_work_url: null, right_to_work_share_code: null })), 'work.right_to_work')?.status).toBe('missing');
    });

    it('K. stale-blocker regression: satisfied address/agreement/RTW produce no canonical blockers', () => {
        const result = resolve();
        const blockers = result.automaticRequirements.filter((requirement) => requirement.blockingForSubmission).map((requirement) => requirement.code);
        expect(blockers).not.toContain('profile.address');
        expect(blockers).not.toContain('agreement.driver_terms');
        expect(blockers).not.toContain('work.right_to_work');
    });
});

describe('docs summary source states', () => {
    it('L. canonical document states drive the badge (expired / missing / under_review / expiring soon / complete)', () => {
        const expired = resolve(profile({ driver_license_expiry: '2026-08-02' }));
        expect(find(expired, 'document.driving_licence')?.status).toBe('expired');

        const missing = resolve(profile({ driver_license_url: null, insurance_url: null }));
        expect(find(missing, 'document.driving_licence')?.status).toBe('missing');

        const soon = resolve(profile({ driver_license_expiry: '2026-08-06' }));
        expect(find(soon, 'document.driving_licence')?.expiringSoon).toBe(true);

        const complete = resolve();
        expect(find(complete, 'document.driving_licence')?.status).toBe('completed');
        expect(find(complete, 'document.insurance')?.status).toBe('completed');
    });
});

describe('overallStatus precedence (historical approval vs current eligibility)', () => {
    it('a historically-approved driver with a current action-required flag reports action_required, not approved', () => {
        const result = resolve(profile({
            is_verified: true,
            verification_status: 'action_required',
            driver_review_status: 'action_required'
        }));
        expect(result.overallStatus).toBe('action_required');
    });

    it('an approved driver with no action-required flag reports approved', () => {
        const result = resolve(profile({ is_verified: true, verification_status: 'approved' }));
        expect(result.overallStatus).toBe('approved');
    });

    it('a previously-approved driver with a newly-expired requirement reports action_required', () => {
        const result = resolve(profile({
            is_verified: true,
            verification_status: 'approved',
            driver_license_expiry: '2026-08-02'
        }));
        expect(result.overallStatus).toBe('action_required');
        expect(find(result, 'document.driving_licence')?.status).toBe('expired');
    });

    it('progress still counts completed sections, independent of the account action-required flag', () => {
        const result = resolve(profile({
            is_verified: true,
            verification_status: 'action_required',
            driver_review_status: 'action_required'
        }));
        // No canonical requirement is blocking, so all applicable sections complete.
        expect(result.automaticRequirements.filter((requirement) => requirement.blockingForSubmission)).toHaveLength(0);
    });
});
