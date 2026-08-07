import { describe, expect, it } from 'vitest';
import { DriverRequirementService, type DriverAdminRequest } from '../../server/services/driver-requirement.service';

const profile = (overrides: Record<string, unknown> = {}) => ({
  full_name: 'Alex Driver', phone: '07000000000', current_address: '1 High Street',
  date_of_birth: '1990-01-01', accepted_driver_agreement_at: '2026-01-01',
  country_code: 'GB', right_to_work_url: 'right.pdf', driver_service_types: ['delivery'],
  verification_items: { bicycle_declaration: true, delivery_equipment_confirmed: true }, ...overrides
});
const bicycle = { id:'bike-1',userId:'driver-1',type:'bike',make:null,model:null,colour:null,year:null,registrationNumber:null,capacity:'bike',serviceEligibility:['delivery'],status:'saved' };
const car = { id:'car-1',userId:'driver-1',type:'car',make:'Ford',model:'Focus',colour:'Blue',year:2020,registrationNumber:'AB12 CDE',capacity:'standard',serviceEligibility:['delivery'],status:'saved' };
const resolve = (p = profile(), v: Record<string, unknown> = bicycle, requests: DriverAdminRequest[] = []) =>
  DriverRequirementService.resolve({ profile: p, vehicle: v, authEmailConfirmed: true, adminRequests: requests, now: new Date('2026-08-04') });

describe('authoritative driver requirement resolution', () => {
  it('does not require car fields or motor insurance for a bicycle courier', () => {
    const codes = resolve().automaticRequirements.map(item => item.code);
    expect(codes).toContain('vehicle.bicycle_declaration');
    expect(codes).not.toContain('vehicle.make');
    expect(codes).not.toContain('document.insurance');
  });

  it('requires motor vehicle identity, licence and insurance for car delivery', () => {
    const codes = resolve(profile({ driver_license_url: null, insurance_url: null }), car).automaticRequirements.filter(item => item.blockingForSubmission).map(item => item.code);
    expect(codes).toEqual(expect.arrayContaining(['document.driving_licence', 'document.insurance']));
  });

  it('adds passenger licensing only when Ride is selected', () => {
    expect(resolve(profile({ driver_service_types: ['delivery'] }), car).automaticRequirements.some(item => item.code === 'licence.private_hire')).toBe(false);
    expect(resolve(profile({ driver_service_types: ['delivery', 'ride'] }), car).automaticRequirements.some(item => item.code === 'licence.private_hire')).toBe(true);
  });

  it('adds goods-in-transit cover for GB van moving', () => {
    expect(resolve(profile({ driver_service_types: ['van-moving'] }), { ...car, type: 'small_van',capacity:'small_van' }).automaticRequirements.some(item => item.code === 'document.goods_in_transit')).toBe(true);
  });

  it('does not invent vehicle fields before service selection', () => {
    const codes = DriverRequirementService.resolve({profile:profile({driver_service_types:[]}),vehicle:null,authEmailConfirmed:true}).automaticRequirements.map(item => item.code);
    expect(codes).not.toContain('vehicle.make');
    expect(codes).not.toContain('vehicle.operating_method');
  });

  it('uses Supabase Auth confirmation rather than email text presence', () => {
    const result = DriverRequirementService.resolve({ profile: profile({ email: 'a@example.com' }), vehicle: bicycle, authEmailConfirmed: false });
    expect(result.automaticRequirements.find(item => item.code === 'profile.email_verification')?.completed).toBe(false);
  });

  it.each(['2030-01-01', '2010-01-01', 'not-a-date'])('rejects invalid or under-age DOB %s', date => {
    expect(resolve(profile({ date_of_birth: date })).automaticRequirements.find(item => item.code === 'profile.date_of_birth')?.blockingForSubmission).toBe(true);
  });

  it('keeps Stripe outside submission blockers', () => {
    const result = resolve(profile({ stripe_connect_status: 'pending' }));
    expect(result.warnings.map(item => item.code)).toContain('payout.stripe_connect');
    expect(result.automaticRequirements.map(item => item.code)).not.toContain('payout.stripe_connect');
  });

  it('deduplicates Admin requests and removes automatic requirement duplicates', () => {
    const base = { id: '1', item: 'Extra photo', status: 'pending' as const, publicMessage: 'Upload it', submittedAt: null, updatedAt: null, resolvedAt: null, nextAction: 'Upload' };
    const result = resolve(profile(), bicycle, [
      { ...base, requirementCode: 'profile.phone' },
      { ...base, requirementCode: 'admin.extra_photo' },
      { ...base, id: '2', requirementCode: 'admin.extra_photo' }
    ]);
    expect(result.adminRequests.map(item => item.requirementCode)).toEqual(['admin.extra_photo']);
  });

  it('separates approved onboarding from service online eligibility', () => {
    const result = resolve(profile({ is_verified: true, verification_status: 'approved', driver_service_types: ['ride'], service_approval_statuses: { ride: 'pending' }, private_hire_vehicle_license_url: 'phv.pdf', council_license_number: 'C1', private_hire_insurance_url: 'hire.pdf', driver_license_url: 'lic.pdf', insurance_url: 'ins.pdf' }), car);
    expect(result.overallStatus).toBe('approved');
    expect(result.onlineEligibility.allowed).toBe(false);
    expect(result.onlineEligibility.reasons).toContain('ride approval is pending.');
  });

  it('returns stable progress counts from unique canonical requirements', () => {
    const result = resolve();
    expect(result.progress.total).toBe(Object.values(result.sectionStatus).filter(section=>section.applicable).length);
    expect(result.progress.completed).toBeLessThanOrEqual(result.progress.total);
    expect(result.progress.percentage).toBe(Math.round(result.progress.completed/result.progress.total*100));
  });

  it.each([
    ['delivery',false],['errand',false],['shop',false],['van-moving',false],['ride',true]
  ] as const)('%s resolves service licensing applicability to %s',(service,applicable)=>{
    const result=resolve(profile({driver_service_types:[service],private_hire_vehicle_license_url:'phv.pdf',council_license_number:'C1',private_hire_insurance_url:'hire.pdf'}),car);
    expect(result.sectionStatus.serviceLicensing).toMatchObject({applicable,status:applicable?'complete':'not_applicable'});
  });

  it('canonicalises Shop and Deliver aliases before applicability',()=>{
    expect(resolve(profile({driver_service_types:['shop','deliver']}),car).selectedServices).toEqual(['errand','delivery']);
  });

  it('excludes not-applicable licensing from progress',()=>{
    const result=resolve(profile({driver_service_types:['delivery']}),car);
    expect(result.sectionStatus.serviceLicensing).toEqual({applicable:false,status:'not_applicable'});
    expect(Object.values(result.sectionStatus).filter(section=>section.applicable)).toHaveLength(result.progress.total);
  });

  it('uses only persisted agreement acceptance',()=>{
    expect(resolve(profile({accepted_driver_agreement_at:null,driver_agreement_accepted:true}),car).sectionStatus.agreement.status).toBe('incomplete');
    expect(resolve(profile({accepted_driver_agreement_at:'2026-08-07T10:00:00Z'}),car).sectionStatus.agreement.status).toBe('complete');
  });
});
