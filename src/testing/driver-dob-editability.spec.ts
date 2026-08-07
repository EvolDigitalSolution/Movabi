import{describe,expect,it}from'vitest';
import{readFileSync}from'node:fs';import{resolve}from'node:path';
import{DriverIdentityEditabilityService}from'../../server/services/driver-identity-editability.service';
const route=readFileSync(resolve(process.cwd(),'server/routes/driver-onboarding.routes.ts'),'utf8');
const setup=readFileSync(resolve(process.cwd(),'src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts'),'utf8');
const settings=readFileSync(resolve(process.cwd(),'src/app/apps/mobile/features/driver/settings.page.ts'),'utf8');
const verification=readFileSync(resolve(process.cwd(),'server/routes/verification.routes.ts'),'utf8');

describe('driver DOB identity editability',()=>{
 it('allows an unsubmitted draft driver',()=>expect(DriverIdentityEditabilityService.resolve({onboarding_completed:false,verification_status:'incomplete'}).dateOfBirthEditable).toBe(true));
 it.each(['pending','under_review','approved','action_required','paused','rejected'])('locks %s state',status=>expect(DriverIdentityEditabilityService.resolve({onboarding_completed:true,verification_status:status}).dateOfBirthEditable).toBe(false));
 it('unlocks only an approved unconsumed Admin correction',()=>{expect(DriverIdentityEditabilityService.resolve({onboarding_completed:true,verification_status:'action_required'},[{request_type:'identity_correction',status:'approved',permission_consumed_at:null}]).dateOfBirthEditable).toBe(true);expect(DriverIdentityEditabilityService.resolve({onboarding_completed:true},[{request_type:'identity_correction',status:'approved',permission_consumed_at:'2026-08-07'}]).dateOfBirthEditable).toBe(false);});
 it('rejects direct locked DOB changes with the stable code',()=>{expect(route).toContain("res.status(403).json({code:'DOB_CHANGE_NOT_ALLOWED'");expect(route).toContain('DriverIdentityEditabilityService.resolve(identityProfile,correctionRows||[])');});
 it('does not accept a replacement DOB in a correction request',()=>{const correction=route.slice(route.indexOf("router.post('/dob-correction-request'"),route.indexOf("router.put('/verification-items'"));expect(correction).not.toContain('req.body?.dateOfBirth');expect(correction).toContain("request_type:'identity_correction'");});
 it('renders no date input in locked Settings or Setup branches',()=>{expect(settings).toContain('@if (dateOfBirthEditable()) {<label');expect(settings).toContain('Locked identity information');expect(setup).toContain('@if(dateOfBirthEditable()){<input id="date_of_birth"');});
 it('omits DOB from Settings save when locked',()=>{expect(settings).toContain("if(!this.dateOfBirthEditable())throw new Error('Date of birth is locked.')");expect(settings).toContain('saveCurrentProfile({dateOfBirth:this.dateOfBirthDraft()})');});
 it('records request, grant, rejection and changed-date audits',()=>{expect(route).toContain("event_type:'dob_correction_requested'");expect(route).toContain("event_type:'dob_changed'");expect(verification).toContain("approved?'dob_correction_granted':'dob_correction_rejected'");});
 it('consumes correction permission on resubmission',()=>expect(route).toContain('permission_consumed_at:submittedAt'));
});
