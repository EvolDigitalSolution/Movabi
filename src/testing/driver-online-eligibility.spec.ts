import {describe,expect,it} from 'vitest';
import {DriverOnlineEligibilityService} from '../../server/services/driver-online-eligibility.service';
import {DriverRequirementService} from '../../server/services/driver-requirement.service';

const vehicle={id:'vehicle-1',userId:'driver-1',type:'car',make:'Ford',model:'Fiesta',colour:'Green',year:2026,registrationNumber:'NH1 4G',capacity:'standard',serviceEligibility:['delivery'],status:'saved'};
const profile=(extra:{[key:string]:unknown}={})=>({full_name:'Alex Driver',phone:'07000000000',current_address:'1 High Street',date_of_birth:'1990-01-01',accepted_driver_agreement_at:'2026-01-01',country_code:'GB',right_to_work_url:'right.pdf',driver_service_types:['delivery'],driver_license_url:'lic.pdf',insurance_url:'ins.pdf',verification_status:'approved',is_verified:true,service_approval_statuses:{delivery:'approved'},stripe_connect_status:'connected',...extra});
const evaluate=(extra:{[key:string]:unknown}={},market={allowed:true,code:null as string|null},vehiclePresent=true)=>{const p=profile(extra);const requirements=DriverRequirementService.resolve({profile:p,vehicle:vehiclePresent?vehicle:null,authEmailConfirmed:true,now:new Date('2026-08-06')});return DriverOnlineEligibilityService.evaluate({profile:p,market,requirements,vehiclePresent});};

describe('authoritative Go Online eligibility',()=>{
 it('returns onboarding incomplete in a live GB market',()=>expect(evaluate({is_verified:false,verification_status:'incomplete',accepted_driver_agreement_at:null}).code).toBe('DRIVER_ONBOARDING_INCOMPLETE'));
 it('returns under review in a live GB market',()=>expect(evaluate({is_verified:false,verification_status:'under_review'}).code).toBe('DRIVER_UNDER_REVIEW'));
 it('returns action required in a live GB market',()=>expect(evaluate({is_verified:false,verification_status:'action_required'}).code).toBe('DRIVER_ACTION_REQUIRED'));
 it('does not let a live market mask onboarding blockers',()=>expect(evaluate({is_verified:false,verification_status:'incomplete',phone:null}).allowed).toBe(false));
 it('returns location unresolved before onboarding checks',()=>expect(evaluate({is_verified:false},{allowed:false,code:'MARKET_LOCATION_UNRESOLVED'}).code).toBe('MARKET_LOCATION_UNRESOLVED'));
 it('returns paused for a paused GB market',()=>expect(evaluate({}, {allowed:false,code:'MARKET_PAUSED'}).code).toBe('MARKET_PAUSED'));
 it('returns market not live for an unknown market',()=>expect(evaluate({}, {allowed:false,code:'MARKET_NOT_CONFIGURED'}).code).toBe('MARKET_NOT_LIVE'));
 it('returns vehicle required for an otherwise approved driver',()=>expect(evaluate({}, {allowed:true,code:null},false).code).toBe('VEHICLE_REQUIRED'));
 it('returns Stripe setup incomplete after driver requirements pass',()=>expect(evaluate({stripe_connect_status:'pending'}).code).toBe('STRIPE_SETUP_INCOMPLETE'));
 it('allows an eligible approved driver',()=>expect(evaluate()).toMatchObject({allowed:true,code:'ALLOWED'}));
});
