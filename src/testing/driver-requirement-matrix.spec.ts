import { describe, expect, it } from 'vitest';
import { DriverRequirementService, type DriverAdminRequest, type DriverVehicleValidation } from '../../server/services/driver-requirement.service';
import { mapDriverVehicleRow } from '../../server/models/driver-vehicle.model';

/**
 * Driver KYC requirement MATRIX — cross-surface consistency regressions.
 *
 * The single canonical resolver is DriverRequirementService.resolve(). It is now
 * the source of truth for the Driver Setup status, submit-review, go-online AND
 * the admin review blocker list, so these invariants prove the driver, the
 * mobile form, the admin list and the acquisition mirrors cannot drift apart on
 * the requirements that used to disagree (passenger licensing, private-hire
 * documents, goods-in-transit cover and explicit admin requests).
 */

const profile = (overrides: Record<string, unknown> = {}) => ({
    id: 'driver-1',
    full_name: 'Alex Driver',
    phone: '07000000000',
    current_address: '1 High Street',
    date_of_birth: '1990-01-01',
    accepted_driver_agreement_at: '2026-01-01',
    country_code: 'GB',
    right_to_work_url: 'right.pdf',
    driver_license_url: 'dl.pdf',
    insurance_url: 'ins.pdf',
    driver_service_types: ['delivery'],
    verification_items: { bicycle_declaration: true, delivery_equipment_confirmed: true },
    ...overrides
});

const car: DriverVehicleValidation = {
    id: 'car-1', userId: 'driver-1', type: 'car', make: 'Ford', model: 'Focus',
    colour: 'Blue', year: 2020, registrationNumber: 'AB12 CDE',
    capacity: 'standard', serviceEligibility: ['delivery'], status: 'saved'
};

const smallVan = (): DriverVehicleValidation => ({ ...car, id: 'van-1', type: 'van', capacity: 'small_van', serviceEligibility: ['van-moving'] });

const resolve = (
    p = profile(),
    v: DriverVehicleValidation | null = car,
    requests: DriverAdminRequest[] = []
) => DriverRequirementService.resolve({
    profile: p,
    vehicle: v,
    authEmailConfirmed: true,
    adminRequests: requests,
    countryCode: p.country_code || null,
    now: new Date('2026-08-04')
});

const rideReadyProfile = () => profile({
    driver_service_types: ['ride'],
    council_name: 'Oldham Council',
    council_license_number: 'PHV/1',
    taxi_badge_number: 'BADGE-1',
    taxi_license_expiry: '2030-01-01',
    private_hire_vehicle_license_url: 'phv-vehicle.pdf',
    private_hire_insurance_url: 'phv-insurance.pdf'
});

describe('driver requirement matrix — goods-in-transit cover (van-moving)', () => {
    it('1. goods-in-transit is satisfiable via the canonical goods_in_transit_url column', () => {
        const result = resolve(
            profile({ driver_service_types: ['van-moving'], goods_in_transit_url: 'git.pdf' }),
            smallVan()
        );
        const git = result.automaticRequirements.find(r => r.code === 'document.goods_in_transit');
        expect(git).toBeDefined();
        expect(git?.completed).toBe(true);
        expect(git?.blockingForSubmission).toBe(false);
    });

    it('2. goods-in-transit blocks GB van-moving when the canonical column is absent', () => {
        const result = resolve(
            profile({ driver_service_types: ['van-moving'], goods_in_transit_url: null }),
            smallVan()
        );
        const git = result.automaticRequirements.find(r => r.code === 'document.goods_in_transit');
        expect(git?.blockingForSubmission).toBe(true);
    });
});

describe('driver requirement matrix — ride cannot substitute generic documents', () => {
    it('3. ride still requires private-hire insurance even when generic insurance is present', () => {
        const result = resolve(profile({
            driver_service_types: ['ride'],
            council_name: 'Oldham Council',
            council_license_number: 'PHV/1',
            taxi_badge_number: 'BADGE-1',
            taxi_license_expiry: '2030-01-01',
            private_hire_vehicle_license_url: 'phv-vehicle.pdf',
            insurance_url: 'generic-insurance.pdf',
            private_hire_insurance_url: null
        }));
        const phvInsurance = result.automaticRequirements.find(r => r.code === 'document.private_hire_insurance');
        expect(phvInsurance?.blockingForSubmission).toBe(true);
    });

    it('4. ride requires the private-hire vehicle licence, not just council details', () => {
        const result = resolve(profile({
            driver_service_types: ['ride'],
            council_name: 'Oldham Council',
            council_license_number: 'PHV/1',
            taxi_badge_number: 'BADGE-1',
            taxi_license_expiry: '2030-01-01',
            private_hire_vehicle_license_url: null,
            private_hire_insurance_url: 'phv-insurance.pdf'
        }));
        const phvVehicle = result.automaticRequirements.find(r => r.code === 'document.private_hire_vehicle_license');
        expect(phvVehicle?.blockingForSubmission).toBe(true);
    });
});

describe('driver requirement matrix — canonical passenger licensing', () => {
    it('5. licence.private_hire completes only when all four canonical fields are present and unexpired', () => {
        const ready = resolve(rideReadyProfile());
        expect(ready.automaticRequirements.find(r => r.code === 'licence.private_hire')?.completed).toBe(true);

        // An expired licence fails even with every other field present.
        const expired = resolve({ ...rideReadyProfile(), taxi_license_expiry: '2026-08-01' });
        expect(expired.automaticRequirements.find(r => r.code === 'licence.private_hire')?.blockingForSubmission).toBe(true);

        // A missing badge fails the combined requirement.
        const noBadge = resolve({ ...rideReadyProfile(), taxi_badge_number: null });
        expect(noBadge.automaticRequirements.find(r => r.code === 'licence.private_hire')?.blockingForSubmission).toBe(true);
    });
});

describe('driver requirement matrix — admin and mobile share one resolver', () => {
    it('6. the same canonical resolution drives both the admin review list and the driver status', () => {
        // The admin list maps its raw vehicle row exactly as the /status endpoint
        // does (mapDriverVehicleRow) and resolves with the same service, so the
        // blockers it reports are byte-identical to the driver's own status.
        const rawVehicleRow = { id: 'car-1', user_id: 'driver-1', type: 'car', make: 'Ford', model: 'Focus', color: 'Blue', year: 2020, license_plate: 'AB12 CDE', capacity: 'standard', service_eligibility: ['delivery'], status: 'saved' };
        const adminView = DriverRequirementService.resolve({
            profile: profile(),
            vehicle: mapDriverVehicleRow(rawVehicleRow as any),
            authEmailConfirmed: true,
            adminRequests: [],
            countryCode: 'GB',
            now: new Date('2026-08-04')
        });
        const driverView = resolve();

        expect(adminView.automaticRequirements.map(r => r.code))
            .toEqual(driverView.automaticRequirements.map(r => r.code));
        expect(adminView.overallStatus).toBe(driverView.overallStatus);
    });
});

describe('driver requirement matrix — explicit admin requests vs setup gaps', () => {
    const missingInfoRequest = (): DriverAdminRequest => ({
        id: 'req-missing-info',
        requirementCode: 'admin.missing_info',
        requestType: 'missing_info',
        item: 'Upload a clearer licence photo',
        status: 'pending',
        publicMessage: 'Please re-upload a clearer photo of your licence.',
        submittedAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        resolvedAt: null,
        nextAction: 'Correct this item and resubmit it for review.'
    });

    it('7. an explicit admin request surfaces as an adminRequest (and thus in Outstanding Requests)', () => {
        const result = resolve(profile(), car, [missingInfoRequest()]);
        expect(result.adminRequests.map(r => r.requirementCode)).toContain('admin.missing_info');
    });

    it('8. "no outstanding requests" means no explicit admin requests, not KYC-complete', () => {
        // A driver with genuine setup gaps but no explicit admin request has an
        // empty adminRequests list — so "No outstanding requests" is correct even
        // though automaticRequirements still carry blockers.
        const incomplete = profile({ driver_service_types: ['ride'] });
        const result = resolve(incomplete, car, []);

        expect(result.adminRequests).toEqual([]);
        expect(result.automaticRequirements.some(r => r.blockingForSubmission)).toBe(true);
    });
});
