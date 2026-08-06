import {describe,expect,it} from 'vitest';
import {mapDriverProfile,parseResidentialAddress} from '../../server/models/driver-profile.model';
import {DriverRequirementService} from '../../server/services/driver-requirement.service';
import {readFileSync} from 'node:fs';import {resolve} from 'node:path';
const route=readFileSync(resolve(process.cwd(),'server/routes/driver-onboarding.routes.ts'),'utf8');
const page=readFileSync(resolve(process.cwd(),'src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts'),'utf8');
const driver=readFileSync(resolve(process.cwd(),'src/app/core/services/driver/driver.service.ts'),'utf8');

const row={id:'driver-1',full_name:'Alex Driver',phone:'07000000000',date_of_birth:'1990-01-01',current_address:'Unit 15, Groundwork Building, Oldham, OL1 4AW',verification_status:'incomplete'};
const resolveAddress=(profileRow:{[key:string]:unknown},confirmed=true)=>{const canonical=mapDriverProfile(profileRow as typeof row,confirmed);return DriverRequirementService.resolve({profile:{...profileRow,driver_service_types:[]},canonicalProfile:canonical,vehicle:null,authEmailConfirmed:confirmed});};

describe('canonical residential address',()=>{
 it('normalises and accepts a valid saved address',()=>expect(parseResidentialAddress({residentialAddress:`  ${row.current_address}  `})).toBe(row.current_address));
 it.each(['','   '])('rejects empty address %j',address=>expect(()=>parseResidentialAddress({residentialAddress:address})).toThrow('valid current residential'));
 it('maps the canonical current_address column',()=>expect(mapDriverProfile(row,true).residentialAddress).toBe(row.current_address));
 it('maps legacy residential_address safely',()=>expect(mapDriverProfile({...row,current_address:null,residential_address:'10 Legacy Road'},true).residentialAddress).toBe('10 Legacy Road'));
 it('maps legacy address safely',()=>expect(mapDriverProfile({...row,current_address:null,address:'11 Old Street'},true).residentialAddress).toBe('11 Old Street'));
 it('maps legacy home_address safely',()=>expect(mapDriverProfile({...row,current_address:null,home_address:'12 Home Lane'},true).residentialAddress).toBe('12 Home Lane'));
 it('marks profile.address complete from the persisted canonical profile',()=>expect(resolveAddress(row).automaticRequirements.find(item=>item.code==='profile.address')).toMatchObject({completed:true,status:'completed'}));
 it('leaves whitespace-only persisted addresses incomplete',()=>expect(resolveAddress({...row,current_address:'   '}).automaticRequirements.find(item=>item.code==='profile.address')?.completed).toBe(false));
 it('uses Supabase Auth confirmation for email status',()=>expect(resolveAddress(row,true).automaticRequirements.find(item=>item.code==='profile.email_verification')?.completed).toBe(true));
 it('does not trust a displayed email when Auth is unconfirmed',()=>expect(resolveAddress({...row,email:'driver@example.com'},false).automaticRequirements.find(item=>item.code==='profile.email_verification')?.completed).toBe(false));
 it('Save and Continue invokes authoritative setup persistence',()=>{expect(page).toContain('(click)="saveAndContinue()"');expect(page).toContain('await this.persistCurrentSetup()');expect(page).toContain('saveCurrentProfile({residentialAddress:address');});
 it('sends residentialAddress through the authenticated profile request',()=>expect(readFileSync(resolve(process.cwd(),'src/app/core/services/driver/driver-onboarding-status.service.ts'),'utf8')).toContain("'/api/driver-onboarding/profile',input,true"));
 it('persists current_address and verifies the returned row',()=>{expect(route).toContain("profileUpdates={current_address:residentialAddress");expect(route).toContain("select('*').single()");expect(route).toContain("if(!profile.residentialAddress)throw");});
 it('logs profile persistence presence without placing the address in log metadata',()=>{expect(route).toContain("'[DriverOnboarding] profile update request'");expect(route).toContain("{userId:driverId,residentialAddressPresent:true}");});
 it('loads and saves vehicles by authenticated user_id',()=>{expect(route).toContain(".eq('user_id',driverId)");expect(route).toContain('user_id:driverId');expect(driver).toContain('this.vehicle.set(saved)');});
 it('does not use local draft state to complete requirements',()=>expect(page).toContain('automaticRequirements.find(item=>item.blockingForSubmission)'));
 it('persists profile and vehicle before review submission',()=>{const persist=page.indexOf('const latestStatus=await this.persistCurrentSetup()');const submit=page.indexOf('await this.onboardingStatus.submitForReview');expect(persist).toBeGreaterThan(0);expect(submit).toBeGreaterThan(persist);expect(page.indexOf('saveCurrentProfile({residentialAddress:address')).toBeLessThan(page.indexOf('await this.driverService.updateVehicle',page.indexOf('private async persistCurrentSetup')));});
 it('reuses one refreshed authoritative status',()=>{const method=page.slice(page.indexOf('private async persistCurrentSetup'),page.indexOf('private restoreDraft'));expect(method.match(/onboardingStatus\.refresh\(\)/g)).toHaveLength(1);expect(page).toContain('latestStatus.automaticRequirements.filter');});
 it('does not submit after persistence failure',()=>{expect(page).toContain('const latestStatus=await this.persistCurrentSetup()');expect(page).toContain('catch {');expect(page).toContain('Your changes were not submitted. Please try again.');});
 it('submits review through the authenticated backend endpoint',()=>{expect(route).toContain("router.post('/submit-review'");expect(route).toContain("'[DriverOnboarding] review resubmission blocked'");});
});
