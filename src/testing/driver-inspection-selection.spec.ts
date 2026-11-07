import { describe, expect, it } from 'vitest';
import * as api from '../../server/shared/driver-requirements.engine';
import * as mobile from '../app/shared/verification/driver-requirements.engine';

for (const [surface, engine] of [['API', api], ['Mobile', mobile]] as const) {
    describe(surface + ' vehicle requirement selection', () => {
        const driver = { driver_service_types: ['ride'] };
        const requirements = (capacity: string, saved: string[], draft?: string[]) =>
            engine.getDriverRequirements({ countryCode:'GB', driver,
                vehicle:{ capacity, service_eligibility:saved }, selectedServices:draft })
                .filter(item => item.required).map(item => item.key);

        it('uses draft services in place of the saved Ride selection', () => {
            expect(requirements('standard',['ride'],['ride'])).toContain('private_hire_vehicle_license');
            expect(requirements('bike',['ride'],['errand','delivery'])).not.toContain('private_hire_vehicle_license');
            expect(requirements('standard',['delivery'],['ride'])).toContain('private_hire_vehicle_license');
            expect(requirements('small_van',['delivery'],['van'])).toContain('goods_in_transit');
        });

        it('uses the saved vehicle services after reload and keeps incompatible documents out', () => {
            expect(requirements('bike',['errand','delivery'])).not.toContain('private_hire_vehicle_license');
            expect(requirements('small_van',['van'])).toContain('goods_in_transit');
            const incompatible = requirements('bike',['ride']);
            expect(incompatible).toContain('service_ride_not_allowed');
            expect(incompatible).not.toContain('private_hire_vehicle_license');
        });
    });
}

describe('server submission blockers', () => {
    it('names missing private hire documents and accepts the complete applicable set', () => {
        const input = {
            countryCode: 'GB',
            vehicle: {capacity:'standard', service_eligibility:['ride'], make:'Test',
                model:'Car', color:'Blue', year:2025, license_plate:'TEST01'},
            driver: {full_name:'Test Driver', email:'test@example.invalid', phone:'0123456789',
                date_of_birth:'1980-01-01', driver_license_url:'licence.pdf', insurance_url:'insurance.pdf',
                council_name:'Test Council', council_license_number:'123', taxi_badge_number:'456',
                taxi_license_expiry:'2099-01-01', stripe_connect_status:'enabled'}
        };
        expect(api.getBlockingRequirements(input).map(item => item.key)).toEqual(['private_hire_vehicle_license']);
        expect(api.getBlockingRequirements({...input,
            driver:{...input.driver, private_hire_vehicle_license_url:'private-hire.pdf'}})).toEqual([]);
    });
});

import { canReviewInspection, inspectionSlots } from '../../server/shared/driver-inspection';

describe('inspection access and applicable slots', () => {
    it('allows only an admin in the same assigned tenant', () => {
        const driver = {tenant_id:'tenant-a'};
        expect(canReviewInspection({role:'admin',tenant_id:'tenant-a'}, driver)).toBe(true);
        expect(canReviewInspection({role:'admin',tenant_id:'tenant-b'}, driver)).toBe(false);
        expect(canReviewInspection({role:'driver',tenant_id:'tenant-a'}, driver)).toBe(false);
        expect(canReviewInspection({role:'admin'}, {})).toBe(false);
    });
    it('switches between Bike and motor photo requirements', () => {
        expect(inspectionSlots(true)).toEqual(['front','rear','side']);
        expect(inspectionSlots(false)).toContain('seats_interior');
        expect(inspectionSlots(false)).not.toContain('side');
    });
});
