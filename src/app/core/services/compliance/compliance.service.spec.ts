import { describe, expect, it } from 'vitest';
import { ComplianceService } from './compliance.service';
import { ServiceTypeEnum } from '@shared/models/booking.model';

describe('ComplianceService', () => {
  const service = new ComplianceService();

  it('handles missing customer profiles without crashing', () => {
    const result = service.canCustomerBook(null);

    expect(result.allowed).toBe(false);
    expect(result.missing.map((item) => item.key)).toContain('full_name');
    expect(result.missing.map((item) => item.key)).toContain('phone');
  });

  it('allows complete customer profile checks without requiring payment while browsing', () => {
    const result = service.canCustomerBook({
      full_name: 'Ada Customer',
      email: 'ada@example.com',
      email_verified: true,
      phone: '07123456789',
      accepted_terms_at: new Date().toISOString(),
      accepted_privacy_at: new Date().toISOString(),
      country_code: 'GB'
    });

    expect(result.allowed).toBe(true);
  });

  it('keeps legacy approved drivers as warnings for newly introduced profile fields', () => {
    const missing = service.getDriverMissingRequirements(
      {
        role: 'driver',
        is_verified: true,
        verification_status: 'approved',
        email: 'driver@example.com',
        phone: '07123456789',
        country_code: 'GB'
      },
      { type: 'car', make: 'Ford', model: 'Focus', color: 'Blue', license_plate: 'AB12 CDE' },
      null,
      ServiceTypeEnum.DELIVERY
    );

    expect(missing.some((item) => item.severity === 'blocker')).toBe(false);
    expect(missing.some((item) => item.severity === 'warning')).toBe(true);
  });

  it('blocks expired driver insurance for service acceptance', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const result = service.canDriverAcceptService(
      {
        role: 'driver',
        full_name: 'Driver One',
        email: 'driver@example.com',
        email_verified: true,
        phone: '07123456789',
        accepted_terms_at: new Date().toISOString(),
        accepted_privacy_at: new Date().toISOString(),
        accepted_driver_agreement_at: new Date().toISOString(),
        date_of_birth: '1990-01-01',
        current_address: '1 Road Street',
        stripe_connect_status: 'connected',
        country_code: 'GB'
      },
      { type: 'car', make: 'Ford', model: 'Focus', color: 'Blue', license_plate: 'AB12 CDE' },
      {
        avatar_url: 'avatar.png',
        live_selfie_url: 'selfie.png',
        driver_license_url: 'licence.png',
        insurance_url: 'insurance.png',
        insurance_expiry: yesterday,
        right_to_work_share_code: 'ABC123',
        courier_insurance_url: 'courier.png'
      },
      ServiceTypeEnum.ERRAND
    );

    expect(result.allowed).toBe(false);
    expect(result.missing.some((item) => item.key === 'insurance_expiry' && item.status === 'expired')).toBe(true);
  });

  it('does not require private hire fields for car drivers who only select errand and delivery', () => {
    const result = service.canDriverAcceptService(
      {
        role: 'driver',
        full_name: 'Driver One',
        email: 'driver@example.com',
        email_verified: true,
        phone: '07123456789',
        accepted_terms_at: new Date().toISOString(),
        accepted_privacy_at: new Date().toISOString(),
        accepted_driver_agreement_at: new Date().toISOString(),
        date_of_birth: '1990-01-01',
        current_address: '1 Road Street',
        stripe_connect_status: 'connected',
        country_code: 'GB',
        verification_items: [{ key: 'driver_service_types', value: '["errand","delivery"]' }]
      },
      { type: 'car', make: 'Ford', model: 'Focus', color: 'Blue', license_plate: 'AB12 CDE', service_eligibility: ['errand', 'delivery'] },
      {
        avatar_url: 'avatar.png',
        live_selfie_url: 'selfie.png',
        driver_license_url: 'licence.png',
        insurance_url: 'insurance.png',
        right_to_work_share_code: 'ABC123',
        courier_insurance_url: 'courier.png'
      },
      ServiceTypeEnum.ERRAND
    );

    expect(result.missing.some((item) => item.key.includes('private_hire') || item.key.includes('council'))).toBe(false);
  });

  it('blocks ride jobs when ride is not in selected services', () => {
    const result = service.canDriverAcceptService(
      {
        role: 'driver',
        is_verified: true,
        verification_status: 'approved',
        email: 'driver@example.com',
        phone: '07123456789',
        country_code: 'GB'
      },
      { type: 'car', make: 'Ford', model: 'Focus', color: 'Blue', license_plate: 'AB12 CDE', service_eligibility: ['errand', 'delivery'] },
      null,
      ServiceTypeEnum.RIDE
    );

    expect(result.allowed).toBe(false);
    expect(result.missing.some((item) => item.key === 'service_ride')).toBe(true);
  });

  it('does not leak GB council taxi rules into US ride checks', () => {
    const result = service.canDriverAcceptService(
      {
        role: 'driver',
        full_name: 'Driver Two',
        email: 'driver2@example.com',
        email_verified: true,
        phone: '5551234567',
        accepted_terms_at: new Date().toISOString(),
        accepted_privacy_at: new Date().toISOString(),
        accepted_driver_agreement_at: new Date().toISOString(),
        date_of_birth: '1990-01-01',
        current_address: '1 Main Street',
        stripe_connect_status: 'connected',
        country_code: 'US',
        verification_items: [{ key: 'driver_service_types', value: '["ride"]' }]
      },
      { type: 'car', make: 'Toyota', model: 'Camry', color: 'Black', license_plate: 'ABC 123', service_eligibility: ['ride'] },
      {
        avatar_url: 'avatar.png',
        live_selfie_url: 'selfie.png',
        driver_license_url: 'licence.png',
        insurance_url: 'insurance.png',
        ride_insurance_url: 'ride.png',
        background_check_status: 'approved'
      },
      ServiceTypeEnum.RIDE
    );

    expect(result.missing.some((item) => item.key.includes('council') || item.key.includes('private_hire'))).toBe(false);
  });
});
