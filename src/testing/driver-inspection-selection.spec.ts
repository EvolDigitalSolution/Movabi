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
