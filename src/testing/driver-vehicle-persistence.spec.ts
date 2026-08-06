import { describe, expect, it } from 'vitest';
import { mapDriverVehicleRow, parseDriverVehicleInput } from '../../server/models/driver-vehicle.model';
import { DriverRequirementService } from '../../server/services/driver-requirement.service';

const savedRow = {
  id: 'vehicle-1', user_id: 'driver-1', type: 'car', make: 'Ford', model: 'Fiesta', color: 'Green',
  year: '2026', license_plate: 'NH1 4G', capacity: 'standard', service_eligibility: ['delivery'], status: 'saved'
};
const completeProfile = {
  full_name: 'Alex Driver', phone: '07000000000', current_address: '1 High Street', date_of_birth: '1990-01-01',
  accepted_driver_agreement_at: '2026-01-01', country_code: 'GB', right_to_work_url: 'right.pdf',
  driver_service_types: ['delivery'], driver_license_url: 'licence.pdf', insurance_url: 'insurance.pdf'
};

describe('driver vehicle API boundary', () => {
  it('normalises API aliases and a string year', () => {
    expect(parseDriverVehicleInput({ vehicleType:'car', make:' Ford ', model:' Fiesta ', colour:' Green ', year:'2026', licensePlate:'NH1 4G', serviceEligibility:['delivery'] }))
      .toMatchObject({ make:'Ford', model:'Fiesta', colour:'Green', year:2026, registrationNumber:'NH1 4G' });
  });

  it('accepts color and registration_number aliases', () => {
    expect(parseDriverVehicleInput({ type:'car', make:'Ford', model:'Fiesta', color:'Green', vehicle_year:2026, registration_number:'nh1 4g' }))
      .toMatchObject({ colour:'Green', registrationNumber:'nh1 4g' });
  });

  it('rejects invalid years without weakening validation', () => {
    expect(() => parseDriverVehicleInput({ type:'car', make:'Ford', model:'Fiesta', color:'Green', year:'bad', license_plate:'NH1 4G' })).toThrow('valid vehicle year');
  });

  it('maps database snake_case explicitly to the canonical API model', () => {
    expect(mapDriverVehicleRow(savedRow)).toMatchObject({ driverId:'driver-1', colour:'Green', year:2026, registrationNumber:'NH1 4G' });
  });

  it('preserves registration display spaces and case', () => {
    expect(mapDriverVehicleRow(savedRow).registrationNumber).toBe('NH1 4G');
  });

  it('marks all five persisted vehicle fields complete', () => {
    const result=DriverRequirementService.resolve({profile:completeProfile,vehicle:savedRow,authEmailConfirmed:true,now:new Date('2026-08-05')});
    const required=['vehicle.make','vehicle.model','vehicle.colour','vehicle.year','vehicle.registration'];
    expect(result.automaticRequirements.filter(item=>required.includes(item.code)).map(item=>[item.code,item.completed]))
      .toEqual(required.map(code=>[code,true]));
  });

  it('does not complete fields from empty persisted values', () => {
    const result=DriverRequirementService.resolve({profile:completeProfile,vehicle:{...savedRow,make:''},authEmailConfirmed:true});
    expect(result.automaticRequirements.find(item=>item.code==='vehicle.make')?.completed).toBe(false);
  });
});
