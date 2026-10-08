import { describe, expect, it } from 'vitest';
import { goodsVehicleMatches, matchesVehicleCapacity } from '../app/shared/utils/goods-vehicle-compatibility';
import { VehicleCompatibilityService } from '../app/core/services/driver/vehicle-compatibility.service';

describe('goods minimum vehicle capacity', () => {
    const frontend = new VehicleCompatibilityService();
    for (const service of ['delivery', 'errand']) {
        for (const [required, type, allowed] of [
            ['bike', 'bike', true], ['bike', 'car', true], ['bike', 'small_van', true],
            ['car', 'bike', false], ['car', 'car', true], ['car', 'small_van', true],
            ['small_van', 'car', false], ['small_van', 'small_van', true],
            ['small_van', 'large_van', true], ['large_van', 'small_van', false]
        ] as const) {
            it(`${service}: ${type} for ${required} = ${allowed}`, () => {
                const job = { service_slug: service, metadata: { service_vehicle_class: required } };
                const vehicle = { type, capacity: 'standard' };
                expect(goodsVehicleMatches(job, vehicle)).toBe(allowed);
                expect(frontend.isCompatible(job as any, vehicle as any)).toBe(allowed);
                expect(matchesVehicleCapacity(service, frontend.getRequiredVehicleClass(job as any),
                    frontend.getDriverCapabilities(vehicle as any))).toBe(allowed);
            });
        }
    }
    it('keeps passenger vehicle matching strict', () => {
        expect(matchesVehicleCapacity('ride', 'bike', ['car', 'standard'])).toBe(false);
        expect(matchesVehicleCapacity('ride', 'xl', ['car', 'standard'])).toBe(false);
        expect(matchesVehicleCapacity('van-moving', 'small_van', ['large_van'])).toBe(false);
    });
    it('fails closed for missing or unknown dispatch vehicles', () => {
        const job = { service_slug: 'errand', metadata: { service_vehicle_class: 'bike' } };
        expect(goodsVehicleMatches(job, null)).toBe(false);
        expect(goodsVehicleMatches(job, { type: 'unknown' })).toBe(false);
    });
});
