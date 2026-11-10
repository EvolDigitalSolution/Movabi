import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapDriverPassengerLicence, parseDriverPassengerLicenceInput } from '../../server/models/driver-passenger-licence.model';

describe('authoritative passenger licence persistence',()=>{
  it('normalises the completed GB Ride form and accepts 30 August 2026 on 7 August 2026',()=>{
    expect(parseDriverPassengerLicenceInput({councilName:' Oldham Council ',licenceNumber:' PHV/W23234 ',badgeNumber:' BADGE-23 ',expiryDate:'30/08/2026'},new Date('2026-08-07T12:00:00Z'))).toEqual({councilName:'Oldham Council',licenceNumber:'PHV/W23234',badgeNumber:'BADGE-23',expiryDate:'2026-08-30'});
  });

  it('maps the exact persisted verification-item fields into one canonical model',()=>{
    expect(mapDriverPassengerLicence({council_name:'Oldham Council',council_license_number:'PHV/W23234',taxi_badge_number:'BADGE-23',taxi_license_expiry:'2026-08-30'},new Date('2026-08-07'))).toMatchObject({councilName:'Oldham Council',licenceNumber:'PHV/W23234',badgeNumber:'BADGE-23',expiryDate:'2026-08-30',complete:true});
  });

  it('rejects expired or malformed dates without a minimum-validity window',()=>{
    expect(()=>parseDriverPassengerLicenceInput({councilName:'Oldham',licenceNumber:'1',badgeNumber:'2',expiryDate:'2026-08-06'},new Date('2026-08-07'))).toThrow('expired');
    expect(()=>parseDriverPassengerLicenceInput({councilName:'Oldham',licenceNumber:'1',badgeNumber:'2',expiryDate:'31/02/2027'})).toThrow('valid licence expiry');
  });

  it('saves licensing through an authenticated endpoint and review validates persisted data',()=>{
    const route=readFileSync('server/routes/driver-onboarding.routes.ts','utf8');
    expect(route).toContain("router.put('/passenger-licence'");
    // Batch 2C Phase B: the canonical typed columns are written alongside the
    // verification_items compatibility mirror, and reads are canonical-first.
    expect(route).toContain("const PASSENGER_LICENCE_SELECT='id,verification_items,council_name,council_license_number,taxi_badge_number,taxi_license_expiry'");
    expect(route).toContain('select(PASSENGER_LICENCE_SELECT).eq(\'id\',driverId).single()');
    expect(route).toContain('const values={...passengerLicenceColumns(licence),verification_items:serializeOnboardingItems(mirror),updated_at:new Date().toISOString()}');
    expect(route).toContain('passengerLicence=readPassengerLicence(profile)');
    expect(route).toContain('passengerLicenceColumns(parseDriverPassengerLicenceInput(');
  });

  it('does not clear stored form values when Ride is temporarily removed',()=>{
    const page=readFileSync('src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts','utf8');
    expect(page).not.toContain("councilName?.setValue('', { emitEvent: false })");
    expect(page).toContain('private_hire_vehicle_license');
    expect(page).toContain('private_hire_insurance');
  });
});
