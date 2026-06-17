import { Booking, Vehicle } from '@shared/models/booking.model';

export const mockVehicles = {
  bike: {
    id: 'vehicle-bike',
    driver_id: 'driver-bike',
    make: 'Honda',
    model: 'PCX',
    year: 2023,
    license_plate: 'BIKE1',
    color: 'Black',
    is_verified: true,
    type: 'motorcycle'
  } satisfies Vehicle,

  standardCar: {
    id: 'vehicle-car',
    driver_id: 'driver-car',
    make: 'Toyota',
    model: 'Prius',
    year: 2022,
    license_plate: 'CAR1',
    color: 'Silver',
    is_verified: true,
    type: 'car',
    capacity: '4 seats'
  } satisfies Vehicle,

  xlCar: {
    id: 'vehicle-xl',
    driver_id: 'driver-xl',
    make: 'Ford',
    model: 'Galaxy',
    year: 2021,
    license_plate: 'XL7',
    color: 'Blue',
    is_verified: true,
    type: 'xl',
    capacity: '7 seater'
  } satisfies Vehicle,

  smallVan: {
    id: 'vehicle-small-van',
    driver_id: 'driver-van',
    make: 'Ford',
    model: 'Transit Connect',
    year: 2020,
    license_plate: 'VAN1',
    color: 'White',
    is_verified: true,
    type: 'small_van',
    capacity: 'small van'
  } satisfies Vehicle,

  largeVan: {
    id: 'vehicle-large-van',
    driver_id: 'driver-large-van',
    make: 'Mercedes',
    model: 'Sprinter',
    year: 2022,
    license_plate: 'LUTON1',
    color: 'White',
    is_verified: true,
    type: 'large_van',
    capacity: 'luton large van'
  } satisfies Vehicle
};

export function mockBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'job-ride-001',
    customer_id: 'customer-001',
    driver_id: null,
    service_type_id: 'service-ride',
    service_slug: 'ride',
    status: 'requested',
    payment_status: 'pending',
    pickup_address: 'Back Skipton Street, Bolton',
    dropoff_address: 'Tonge Moor Primary Academy, Bolton',
    pickup_lat: 53.585,
    pickup_lng: -2.43,
    dropoff_lat: 53.592,
    dropoff_lng: -2.421,
    price: 3.5,
    total_price: 3.5,
    distance_km: 0.87,
    duration_minutes: 2,
    currency_code: 'GBP',
    created_at: '2026-06-17T10:00:00.000Z',
    updated_at: '2026-06-17T10:00:00.000Z',
    metadata: {},
    ...overrides
  } as Booking;
}
