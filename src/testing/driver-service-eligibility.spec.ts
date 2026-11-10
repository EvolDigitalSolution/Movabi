import { describe, expect, it } from 'vitest';
import { isDriverEligibleForService, toCanonicalDriverService } from '../../server/services/driver-service-eligibility';

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
    driver_service_types: ['ride', 'delivery'],
    is_verified: true,
    verification_status: 'approved',
    ...overrides
});

const car = {
    id: 'car-1', user_id: 'driver-1', type: 'car', make: 'Ford', model: 'Focus',
    color: 'Blue', year: 2020, license_plate: 'AB12 CDE',
    capacity: 'standard', service_eligibility: ['ride', 'delivery'], status: 'saved'
};

describe('toCanonicalDriverService', () => {
    it('maps job slugs to the frozen taxonomy', () => {
        expect(toCanonicalDriverService('ride')).toBe('ride');
        expect(toCanonicalDriverService('delivery')).toBe('delivery');
        expect(toCanonicalDriverService('errand')).toBe('errand');
        expect(toCanonicalDriverService('van-moving')).toBe('van-moving');
        expect(toCanonicalDriverService('moving')).toBe('van-moving');
        expect(toCanonicalDriverService('shop')).toBe('errand');
        expect(toCanonicalDriverService(null)).toBeNull();
    });
});

describe('isDriverEligibleForService', () => {
    it('1. an eligible online driver remains matchable', () => {
        expect(isDriverEligibleForService(profile(), car, 'delivery', true, NOW)).toBe(true);

        const rideReady = profile({
            council_name: 'Oldham', council_license_number: 'C1', taxi_badge_number: 'B1',
            taxi_license_expiry: '2030-01-01', private_hire_vehicle_license_url: 'phv.pdf',
            private_hire_insurance_url: 'phi.pdf'
        });
        expect(isDriverEligibleForService(rideReady, car, 'ride', true, NOW)).toBe(true);
    });

    it('2. an expired driving licence excludes new motor work', () => {
        expect(isDriverEligibleForService(profile({ driver_license_expiry: '2026-08-03' }), car, 'delivery', true, NOW)).toBe(false);
    });

    it('3. expired insurance excludes new motor work', () => {
        expect(isDriverEligibleForService(profile({ insurance_expiry: '2026-08-02' }), car, 'ride', true, NOW)).toBe(false);
    });

    it('4. an expiring-soon document remains eligible', () => {
        expect(isDriverEligibleForService(profile({ driver_license_expiry: '2026-08-10' }), car, 'delivery', true, NOW)).toBe(true);
    });

    it('5. absent historical expiry preserves compatibility', () => {
        expect(isDriverEligibleForService(profile({ driver_license_expiry: null, insurance_expiry: null }), car, 'delivery', true, NOW)).toBe(true);
    });

    it('6. a Ride-only expired requirement excludes Ride only', () => {
        const rideOnly = profile({
            council_name: 'Oldham', council_license_number: 'C1', taxi_badge_number: 'B1',
            taxi_license_expiry: '2026-08-03', private_hire_vehicle_license_url: 'phv.pdf',
            private_hire_insurance_url: 'phi.pdf'
        });
        expect(isDriverEligibleForService(rideOnly, car, 'ride', true, NOW)).toBe(false);
        expect(isDriverEligibleForService(rideOnly, car, 'delivery', true, NOW)).toBe(true);
    });

    it('7. a missing applicable requirement excludes', () => {
        expect(isDriverEligibleForService(profile({ driver_license_url: null }), car, 'delivery', true, NOW)).toBe(false);
    });

    it('8. an account under review (not approved) is excluded', () => {
        expect(isDriverEligibleForService(profile({ is_verified: false, verification_status: 'under_review' }), car, 'delivery', true, NOW)).toBe(false);
    });

    it('9. a suspended account is excluded', () => {
        expect(isDriverEligibleForService(profile({ account_status: 'suspended' }), car, 'delivery', true, NOW)).toBe(false);
    });

    it('10. historical approval + current action-required is excluded (not treated as approved)', () => {
        expect(isDriverEligibleForService(profile({ is_verified: true, verification_status: 'action_required', driver_review_status: 'action_required' }), car, 'delivery', true, NOW)).toBe(false);
    });
});
