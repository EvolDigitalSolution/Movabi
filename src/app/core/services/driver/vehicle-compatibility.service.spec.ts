import { describe, expect, it } from 'vitest';
import { VehicleCompatibilityService } from './vehicle-compatibility.service';
import { mockBooking, mockVehicles } from '../../../../testing/mock-data';

describe('VehicleCompatibilityService', () => {
  const service = new VehicleCompatibilityService();

  it('matches ride jobs to standard and XL cars', () => {
    const ride = mockBooking({ service_slug: 'ride', metadata: { service_vehicle_class: 'standard' } });

    expect(service.isCompatible(ride, mockVehicles.standardCar)).toBe(true);
    expect(service.isCompatible(ride, mockVehicles.xlCar)).toBe(true);
    expect(service.isCompatible(ride, mockVehicles.bike)).toBe(false);
  });

  it('prevents bike drivers from accepting car delivery requests', () => {
    const delivery = mockBooking({
      service_slug: 'delivery',
      metadata: { delivery_details: { vehicleClass: 'car' } }
    });

    expect(service.getRequiredVehicleClass(delivery)).toBe('car');
    expect(service.isCompatible(delivery, mockVehicles.bike)).toBe(false);
    expect(service.isCompatible(delivery, mockVehicles.standardCar)).toBe(true);
  });

  it('supports realistic van and 7-seater boundaries', () => {
    const smallMove = mockBooking({ service_slug: 'van-moving', metadata: { vehicle_class: 'small_van' } });
    const largeMove = mockBooking({ service_slug: 'van-moving', metadata: { vehicle_class: 'large_van' } });
    const sevenSeatRide = mockBooking({ service_slug: 'ride', metadata: { vehicle_class: '7 seater' } });

    expect(service.isCompatible(smallMove, mockVehicles.smallVan)).toBe(true);
    expect(service.isCompatible(largeMove, mockVehicles.smallVan)).toBe(false);
    expect(service.isCompatible(largeMove, mockVehicles.largeVan)).toBe(true);
    expect(service.getRequiredVehicleClass(sevenSeatRide)).toBe('minibus');
    expect(service.isCompatible(sevenSeatRide, mockVehicles.xlCar)).toBe(true);
  });

  it('defaults services safely when metadata is missing or malformed', () => {
    expect(service.getRequiredVehicleClass(mockBooking({ service_slug: 'delivery', metadata: '{bad json' }))).toBe('car');
    expect(service.getRequiredVehicleClass(mockBooking({ service_slug: 'unknown', metadata: null }))).toBe('standard');
    expect(service.isCompatible(null, mockVehicles.standardCar)).toBe(false);
  });
});
