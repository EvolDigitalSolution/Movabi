/**
 * Vehicle inspection in the canonical readiness response (2026-11-13). The review screen showed
 * "Vehicle / Bicycle requirements: Complete" with no inspection images, because readiness never looked
 * at the saved photos. Now readiness reports two separate rows from the photos saved for the CURRENT
 * vehicle revision: Inspection photos (upload completion) and Inspection review (admin approval).
 * Both block submission and going online, as the submission RPC already required approved photos.
 */
import {describe,expect,it} from 'vitest';
import {DriverRequirementService} from '../../server/services/driver-requirement.service';
import {inspectionProgress,type InspectionEvidence} from '../../server/services/driver-inspection-progress';

const MOTOR=['front','rear','dashboard','seats_interior','left_side','right_side'];
const BIKE=['front','rear','side'];
const ev=(photos:Array<[string,string]>,{bike=false,vehicle=true}={}):InspectionEvidence=>({vehicle,bike,requiredSlots:bike?BIKE:MOTOR,photos:photos.map(([slot,status])=>({slot,status}))});
const all=(status:string,slots=MOTOR)=>slots.map(s=>[s,status] as [string,string]);

describe('inspection progress from saved photos',()=>{
  it('zero images: every slot missing, nothing complete',()=>{
    const p=inspectionProgress(ev([]));
    expect(p).toMatchObject({required:6,uploaded:0,approved:0,uploadsComplete:false,approvalComplete:false});
    expect(p.missing).toEqual(MOTOR);
  });
  it('partial uploads: counts only the slots with a saved photo',()=>{
    const p=inspectionProgress(ev([['front','under_review'],['rear','uploaded'],['dashboard','approved']]));
    expect(p).toMatchObject({uploaded:3,approved:1,uploadsComplete:false,approvalComplete:false});
    expect(p.missing).toEqual(['seats_interior','left_side','right_side']);
  });
  it('removed images never count: replaced rows and unknown statuses are ignored',()=>{
    const p=inspectionProgress(ev([...all('approved').filter(([s])=>s!=='left_side'),['left_side','replaced'],['right_side','deleted']]));
    expect(p.uploadsComplete).toBe(false);
    expect(p.missing).toEqual(['left_side']);
    expect(p.slots.right_side).toBe('approved');
  });
  it('a rejected photo must be replaced: not uploaded, not approved',()=>{
    const p=inspectionProgress(ev([...all('approved').filter(([s])=>s!=='rear'),['rear','rejected']]));
    expect(p).toMatchObject({uploadsComplete:false,approvalComplete:false,rejected:['rear']});
  });
  it('a newer upload for a rejected slot counts (best current photo per slot)',()=>{
    const p=inspectionProgress(ev([...all('approved').filter(([s])=>s!=='rear'),['rear','rejected'],['rear','under_review']]));
    expect(p).toMatchObject({uploadsComplete:true,approvalComplete:false,awaitingReview:['rear']});
  });
  it('all required images present: upload complete, approval separate until an admin approves each',()=>{
    expect(inspectionProgress(ev(all('under_review')))).toMatchObject({uploadsComplete:true,approvalComplete:false,uploaded:6,approved:0});
    expect(inspectionProgress(ev(all('approved')))).toMatchObject({uploadsComplete:true,approvalComplete:true});
  });
  it('bicycle exemption preserved: three slots (front, rear, side), not six',()=>{
    expect(inspectionProgress(ev(all('approved',BIKE),{bike:true}))).toMatchObject({required:3,approvalComplete:true});
    expect(inspectionProgress(ev([['front','approved']],{bike:true})).missing).toEqual(['rear','side']);
  });
  it('no saved vehicle: nothing can count, even with stray photos',()=>{
    expect(inspectionProgress(ev(all('approved'),{vehicle:false}))).toMatchObject({uploadsComplete:false,approvalComplete:false});
  });
});

// ---------------------------------------------------------------- readiness rows and sections
const car={id:'v1',userId:'d1',type:'car',subtype:null,make:'Ford',model:'Focus',colour:'Red',year:2020,registrationNumber:'AB12CDE',capacity:'standard',serviceEligibility:['delivery'],status:'saved'};
const bicycle={id:'v2',userId:'d1',type:'bike',subtype:'pedal_bicycle',make:'Trek',model:'FX',colour:'Black',year:2022,registrationNumber:null,capacity:'bike',serviceEligibility:['delivery'],status:'saved'};
const profile=(over:Record<string,unknown>={})=>({id:'d1',role:'driver',country_code:'GB',full_name:'A Driver',phone:'07000000000',date_of_birth:'1990-01-01',current_address:'1 High Street, Bolton BL1 1AA',
  driver_service_types:['delivery'],accepted_driver_agreement_at:'2026-01-01',driver_license_url:'x',insurance_url:'x',driver_license_expiry:'2030-01-01',insurance_expiry:'2030-01-01',right_to_work_url:'x',
  verification_items:[{key:'delivery_equipment_confirmed',value:'true'},{key:'bicycle_declaration',value:'true'}],...over});
const paid={provider:'stripe',state:'completed' as const,available:true,reason:null};
const resolve=(inspection:InspectionEvidence|undefined,vehicle:any=car)=>DriverRequirementService.resolve({profile:profile(),vehicle,authEmailConfirmed:true,countryCode:'GB',paymentAccount:paid,inspection});
const row=(r:ReturnType<typeof resolve>,code:string)=>r.automaticRequirements.find(x=>x.code===code);

describe('readiness: vehicle details and vehicle inspection are separate',()=>{
  it('zero images: vehicle details can be complete while inspection says "Missing photos" and blocks submission',()=>{
    const r=resolve(ev([]));
    expect(r.sectionStatus.vehicle.status).toBe('complete');
    expect(r.sectionStatus.inspection).toEqual({applicable:true,status:'incomplete'});
    expect(row(r,'vehicle.inspection_photos')).toMatchObject({category:'inspection',status:'missing',completed:false,blockingForSubmission:true,blockingForOnline:true});
    expect(row(r,'vehicle.inspection_photos')!.reason).toBe('Missing photos: front, rear, dashboard, seats interior, left side, right side (0 of 6 uploaded).');
    expect(row(r,'vehicle.inspection_review')).toMatchObject({status:'missing',blockingForSubmission:true});
    expect(r.overallStatus).not.toBe('ready_to_submit');
  });
  it('partial uploads: still missing photos, with the count',()=>{
    const r=resolve(ev([['front','under_review'],['rear','under_review'],['dashboard','under_review']]));
    expect(row(r,'vehicle.inspection_photos')!.reason).toBe('Missing photos: seats interior, left side, right side (3 of 6 uploaded).');
    expect(r.sectionStatus.inspection!.status).toBe('incomplete');
  });
  it('removed image: a replaced photo drops the slot back to missing',()=>{
    const r=resolve(ev([...all('under_review').filter(([s])=>s!=='front'),['front','replaced']]));
    expect(row(r,'vehicle.inspection_photos')).toMatchObject({status:'missing',completed:false});
    expect(row(r,'vehicle.inspection_photos')!.reason).toContain('Missing photos: front (5 of 6 uploaded)');
  });
  it('rejected photo: action required, with the slot to replace',()=>{
    const r=resolve(ev([...all('approved').filter(([s])=>s!=='rear'),['rear','rejected']]));
    expect(row(r,'vehicle.inspection_photos')).toMatchObject({status:'rejected',reason:'Replace rejected photos: rear.'});
    expect(r.sectionStatus.inspection!.status).toBe('action_required');
  });
  it('all images uploaded: upload complete, admin review pending and still blocking',()=>{
    const r=resolve(ev(all('under_review')));
    expect(row(r,'vehicle.inspection_photos')).toMatchObject({status:'completed',completed:true,blockingForSubmission:false});
    expect(row(r,'vehicle.inspection_review')).toMatchObject({status:'under_review',completed:false,needsAdminReview:true,blockingForSubmission:true,blockingForOnline:true});
    expect(r.sectionStatus.inspection!.status).toBe('under_review');
  });
  it('all images approved: both rows complete, the section is complete, nothing blocks',()=>{
    const r=resolve(ev(all('approved')));
    expect(row(r,'vehicle.inspection_review')).toMatchObject({status:'approved',completed:true,blockingForSubmission:false,blockingForOnline:false});
    expect(r.sectionStatus.inspection!.status).toBe('complete');
    expect(r.automaticRequirements.filter(x=>x.category==='inspection'&&x.blockingForSubmission)).toEqual([]);
  });
  it('bicycle: three photos, the evidence replaces the old profile-flag row, and no motor-vehicle items',()=>{
    const r=resolve(ev([['front','approved']],{bike:true}),bicycle);
    expect(row(r,'document.bike_inspection')).toBeUndefined();
    expect(row(r,'vehicle.inspection_photos')!.reason).toBe('Missing photos: rear, side (1 of 3 uploaded).');
    const codes=r.automaticRequirements.map(x=>x.code);
    for(const code of ['vehicle.registration','document.driving_licence','document.insurance'])expect(codes).not.toContain(code);
    expect(row(resolve(ev(all('approved',BIKE),{bike:true}),bicycle),'vehicle.inspection_review')!.completed).toBe(true);
  });
  it('callers that pass no evidence keep the previous behaviour (no inspection section)',()=>{
    const r=resolve(undefined);
    expect(row(r,'vehicle.inspection_photos')).toBeUndefined();
    expect(r.sectionStatus.inspection).toEqual({applicable:false,status:'not_applicable'});
  });
  it('no saved vehicle: inspection asks for the vehicle first',()=>{
    const r=resolve(ev([],{vehicle:false}),null);
    expect(row(r,'vehicle.inspection_photos')!.reason).toBe('Save your vehicle first, then upload the inspection photos.');
  });
});
