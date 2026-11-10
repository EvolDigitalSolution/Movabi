import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { goodsVehicleMatches, matchesVehicleCapacity } from '../app/shared/utils/goods-vehicle-compatibility';

const route = readFileSync(resolve(process.cwd(), 'server/routes/booking.routes.ts'), 'utf8');

const bikeJob = (service: string) => ({ service_slug: service, metadata: { service_vehicle_class: 'bike' } });
const persistedBikeJob = (service: string) => ({ service_slug: service, fulfilment_category: 'bike', fulfilment_subtype: 'pedal_bicycle' });
const carVehicle = { type: 'car', capacity: 'standard' };
const vanVehicle = { type: 'small_van', capacity: 'small_van' };
const bikeVehicle = { type: 'bike', capacity: 'standard', vehicle_subtype: 'pedal_bicycle' };
const motorcycle = { type: 'motorcycle', capacity: 'standard', vehicle_subtype: 'motorcycle' };

describe('bike category isolation — Car/Van cannot acquire Bike jobs', () => {
    it('rejects a car driver for a bike errand in the canonical utility', () => {
        expect(goodsVehicleMatches(bikeJob('errand'), carVehicle)).toBe(false);
        expect(matchesVehicleCapacity('errand', 'bike', ['car', 'standard'])).toBe(false);
    });

    it('rejects a van driver for a bike delivery in the canonical utility', () => {
        expect(goodsVehicleMatches(bikeJob('delivery'), vanVehicle)).toBe(false);
        expect(matchesVehicleCapacity('delivery', 'bike', ['small_van', 'car'])).toBe(false);
    });

    it('accepts a bike driver for a bike job in the canonical utility', () => {
        expect(goodsVehicleMatches(bikeJob('delivery'), bikeVehicle)).toBe(true);
        expect(goodsVehicleMatches(bikeJob('errand'), bikeVehicle)).toBe(true);
    });

    it('preserves existing Car and Van flows unchanged', () => {
        const carErrand = { service_slug: 'errand', metadata: { service_vehicle_class: 'car' } };
        const vanMove = { service_slug: 'delivery', metadata: { service_vehicle_class: 'small_van' } };
        expect(goodsVehicleMatches(carErrand, carVehicle)).toBe(true);
        expect(goodsVehicleMatches(vanMove, vanVehicle)).toBe(true);
        expect(goodsVehicleMatches(vanMove, { type: 'large_van', capacity: 'large_van' })).toBe(true);
    });

    it('persists and trusts fulfilment_category over metadata', () => {
        expect(goodsVehicleMatches(persistedBikeJob('delivery'), carVehicle)).toBe(false);
        expect(goodsVehicleMatches(persistedBikeJob('delivery'), bikeVehicle)).toBe(true);
        expect(goodsVehicleMatches({ ...persistedBikeJob('errand'), fulfilment_category: 'car' }, carVehicle)).toBe(true);
    });

    it('rejects mismatched bike subtypes', () => {
        const pedalOnly = { service_slug: 'delivery', fulfilment_category: 'bike', fulfilment_subtype: 'pedal_bicycle' };
        const needsMotorcycle = { service_slug: 'delivery', fulfilment_category: 'bike', fulfilment_subtype: 'motorcycle' };
        expect(goodsVehicleMatches(pedalOnly, motorcycle)).toBe(false);
        expect(goodsVehicleMatches(needsMotorcycle, motorcycle)).toBe(true);
        expect(goodsVehicleMatches(needsMotorcycle, bikeVehicle)).toBe(false);
    });

    it('enforces bike-only matching in the accept route server-side', () => {
        expect(route).toContain('requiredVehicleClass(job)');
        expect(route).toContain('getDriverVehicle(driverId)');
        expect(route).toContain('matchesVehicleCapacity');
        expect(route).toContain('bikeSubtypeCompatible(job, vehicle)');
        expect(route).not.toContain('req.body.vehicleClass');
        expect(route).not.toContain('req.body.fulfilmentCategory');
    });

    it('persists fulfilment category in the create allow-list', () => {
        expect(route).toContain("'fulfilment_category', 'fulfilment_subtype'");
        expect(route).toContain('INVALID_FULFILMENT_CATEGORY');
    });

    it('keeps dispatch eligibility guarded by the same canonical utility', () => {
        const dispatch = readFileSync(resolve(process.cwd(), 'server/services/dispatch.service.ts'), 'utf8');
        expect(dispatch).toContain('goodsVehicleMatches(job, vehicleRowsByUser.get(driver.id))');
    });
});
