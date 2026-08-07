import {calculateCalendarAge,CanonicalDriverProfile,mapDriverProfile,parseDriverDateOfBirth} from '../models/driver-profile.model';

export type CanonicalDriverService = 'ride' | 'delivery' | 'errand' | 'van-moving';
export type DriverOperatingVehicle = 'bicycle' | 'motorcycle' | 'car' | 'small_van' | 'large_van' | null;
export type RequirementState = 'completed' | 'missing' | 'invalid' | 'under_age' | 'under_review' | 'approved' | 'rejected' | 'not_applicable';
export interface ResolvedDriverRequirement {
  code: string; label: string; category: 'basic' | 'services' | 'vehicle' | 'documents' | 'agreement' | 'licensing';
  status: RequirementState; required: boolean; completed: boolean; blockingForSubmission: boolean; blockingForOnline: boolean;
  needsAdminReview: boolean; reason: string; services: CanonicalDriverService[];
}
export interface DriverAdminRequest { id: string; requirementCode: string; item: string; status: 'pending'|'rejected'|'approved'; publicMessage: string; submittedAt: string|null; updatedAt: string|null; resolvedAt: string|null; nextAction: string; }
export interface DriverRequirementResolution {
  selectedServices: CanonicalDriverService[]; vehicleType: DriverOperatingVehicle; automaticRequirements: ResolvedDriverRequirement[];
  adminRequests: DriverAdminRequest[]; warnings: ResolvedDriverRequirement[]; progress: { completed: number; total: number };
  overallStatus: 'not_started'|'incomplete'|'ready_to_submit'|'under_review'|'action_required'|'approved'|'paused';
  onlineEligibility: { allowed: boolean; reasons: string[] }; age: { eligible: boolean; years: number|null; minimum: number; reason: string|null };
}
export interface DriverVehicleValidation {id:string;userId:string;type:string;make:string|null;model:string|null;colour:string|null;year:number|null;registrationNumber:string|null;capacity:string|null;serviceEligibility:string[];status:string;}

export class DriverRequirementService {
  static resolve(input: { profile: Record<string, any>; canonicalProfile?:CanonicalDriverProfile; vehicle?: DriverVehicleValidation|null; authEmailConfirmed: boolean; adminRequests?: DriverAdminRequest[]; countryCode?: string|null; marketCity?: string|null; now?: Date }): DriverRequirementResolution {
    const profile=input.profile||{}, onboardingItems=this.onboardingItems(profile.verification_items), vehicle:DriverVehicleValidation=input.vehicle||{id:'',userId:'',type:'',make:null,model:null,colour:null,year:null,registrationNumber:null,capacity:null,serviceEligibility:[],status:'missing'}, now=input.now||new Date();
    const canonicalProfile=input.canonicalProfile||mapDriverProfile({id:String(profile.id||''),...profile},input.authEmailConfirmed);
    const selectedServices=this.services(profile,vehicle); const vehicleType=this.vehicle(vehicle,profile); const requirements:ResolvedDriverRequirement[]=[];
    const add=(code:string,label:string,category:ResolvedDriverRequirement['category'],ok:boolean,reason:string,services:CanonicalDriverService[]=selectedServices,invalid=false,review=false)=>requirements.push({code,label,category,status:ok?(review?'under_review':'completed'):(invalid?'invalid':'missing'),required:true,completed:ok&&!review,blockingForSubmission:!ok,blockingForOnline:!ok||review,needsAdminReview:review,reason,services});
    add('profile.full_name','Legal name','basic',this.has(canonicalProfile.fullName),'Add your full legal name.');
    add('profile.phone','Phone','basic',this.has(canonicalProfile.phone),'Add a verified contact number.');
    add('profile.address','Residential address','basic',this.has(canonicalProfile.residentialAddress),'Add your current residential address.');
    add('profile.email_verification','Email verified','basic',canonicalProfile.emailConfirmed,'Confirm your sign-in email address.');
    const age=this.age(canonicalProfile.dateOfBirth,now,18);
    requirements.push({code:'profile.date_of_birth',label:'Date of birth',category:'basic',status:age.state,required:true,completed:age.eligible,blockingForSubmission:!age.eligible,blockingForOnline:!age.eligible,needsAdminReview:false,reason:age.reason||'Date of birth confirmed.',services:[]});
    add('service.selection','Selected services','services',selectedServices.length>0,'Select at least one service.');
    add('agreement.driver_terms','Driver agreement','agreement',this.has(profile.accepted_driver_agreement_at)||profile.driver_agreement_accepted===true,'Review and accept the Driver Agreement.');
    const country=String(input.countryCode||profile.country_code||'').toUpperCase();
    if(country==='GB') add('work.right_to_work','Right to work','documents',this.has(profile.right_to_work_url||profile.right_to_work_share_code),'Provide right-to-work evidence.');

    if(selectedServices.length){
      const motor=vehicleType!==null&&vehicleType!=='bicycle'; const vehicleBased=motor||selectedServices.includes('ride')||selectedServices.includes('van-moving');
      add('vehicle.operating_method','Operating method','vehicle',vehicleType!==null,'Choose how you will provide the selected services.');
      if(vehicleBased){
        add('vehicle.make','Vehicle make','vehicle',this.has(vehicle.make),'Add the vehicle make.'); add('vehicle.model','Vehicle model','vehicle',this.has(vehicle.model),'Add the vehicle model.');
        add('vehicle.colour','Vehicle colour','vehicle',this.has(vehicle.colour),'Add the vehicle colour.'); add('vehicle.year','Vehicle year','vehicle',Number(vehicle.year)>1900,'Add a valid vehicle year.');
        add('vehicle.registration','Vehicle registration','vehicle',this.has(vehicle.registrationNumber),'Add the registration number.');
        add('document.driving_licence','Driving licence','documents',this.has(profile.driver_license_url||profile.driving_licence_url),'Upload the appropriate driving licence.');
        add('document.insurance','Vehicle insurance','documents',this.has(profile.insurance_url||profile.courier_insurance_url||profile.hire_reward_insurance_url),'Upload insurance appropriate to the selected services.');
      } else if(vehicleType==='bicycle') {
        add('vehicle.bicycle_declaration','Bicycle details','vehicle',this.has(vehicle.type)||onboardingItems.bicycle_declaration===true,'Add bicycle details or confirm your bicycle declaration.');
        add('vehicle.delivery_equipment','Delivery equipment','vehicle',onboardingItems.delivery_equipment_confirmed===true,'Confirm suitable delivery equipment.');
      }
      if(selectedServices.includes('ride')){
        add('licence.private_hire','Private-hire/council licensing','licensing',this.has(profile.private_hire_vehicle_license_url)&&this.has(profile.council_license_number),'Provide the passenger-service licensing configured for this market.',['ride']);
        add('document.private_hire_insurance','Private-hire insurance','documents',this.has(profile.private_hire_insurance_url),'Upload passenger-service insurance.',['ride']);
      }
      if(selectedServices.includes('van-moving')) add('document.goods_in_transit','Goods-in-transit cover','documents',country!=='GB'||this.has(profile.goods_in_transit_url),'Upload configured commercial or goods-in-transit cover.',['van-moving']);
    }
    const automaticCodes=new Set(requirements.map(r=>r.code));
    const adminRequests=(input.adminRequests||[]).filter((request,index,array)=>!automaticCodes.has(request.requirementCode)&&array.findIndex(item=>item.requirementCode===request.requirementCode&&item.status!=='approved')===index);
    const required=requirements.filter(r=>r.required); const completed=required.filter(r=>r.completed).length; const blockers=required.filter(r=>r.blockingForSubmission);
    const openAdmin=adminRequests.filter(r=>r.status!=='approved'); const review=profile.verification_status==='under_review'||profile.driver_review_status==='under_review'; const actionRequired=profile.verification_status==='action_required'||profile.driver_review_status==='action_required'; const approved=profile.is_verified===true||profile.verification_status==='approved'; const paused=['paused','suspended','blocked'].includes(String(profile.account_status||'').toLowerCase());
    const overallStatus=paused?'paused':approved?'approved':actionRequired||openAdmin.length||requirements.some(r=>r.status==='invalid'||r.status==='under_age'||r.status==='rejected')?'action_required':review?'under_review':!selectedServices.length?'not_started':blockers.length?'incomplete':'ready_to_submit';
    const onlineReasons=[...required.filter(r=>r.blockingForOnline).map(r=>r.reason),...openAdmin.map(r=>r.publicMessage||r.item)];
    for(const service of selectedServices){const approvals=profile.service_approval_statuses||{};if((service==='ride'||service==='van-moving')&&approvals[service]!=='approved')onlineReasons.push(`${service} approval is pending.`);}
    if(!approved)onlineReasons.push('Driver onboarding is not approved.'); if(paused)onlineReasons.push('Driver account is paused or suspended.');
    const warnings:ResolvedDriverRequirement[]=[]; if(profile.stripe_connect_status!=='connected')warnings.push({code:'payout.stripe_connect',label:'Stripe payouts',category:'documents',status:'missing',required:false,completed:false,blockingForSubmission:false,blockingForOnline:false,needsAdminReview:false,reason:'Complete Stripe Connect before receiving payouts.',services:[]});
    return {selectedServices,vehicleType,automaticRequirements:requirements,adminRequests,warnings,progress:{completed,total:required.length},overallStatus,onlineEligibility:{allowed:onlineReasons.length===0,reasons:Array.from(new Set(onlineReasons))},age};
  }
  private static services(profile:Record<string,any>,vehicle:DriverVehicleValidation):CanonicalDriverService[]{const raw=profile.driver_service_types||profile.verification_items?.driver_service_types||vehicle.serviceEligibility||[];const values=Array.isArray(raw)?raw:String(raw||'').replace(/[\[\]"]/g,'').split(',');return Array.from(new Set(values.map(v=>String(v).trim().toLowerCase()).map(v=>['van','moving','van_moving'].includes(v)?'van-moving':v).filter((v):v is CanonicalDriverService=>['ride','delivery','errand','van-moving'].includes(v))));}
  private static onboardingItems(input:unknown):Record<string,unknown>{if(!input)return{};if(typeof input==='string'){try{return this.onboardingItems(JSON.parse(input))}catch{return{}}}if(Array.isArray(input))return input.reduce<Record<string,unknown>>((items,entry)=>{if(!entry||typeof entry!=='object')return items;const row=entry as Record<string,unknown>,key=String(row.key||row.name||'').trim();if(key)items[key]=row.value==='true'?true:row.value==='false'?false:row.value;return items;},{});return typeof input==='object'?input as Record<string,unknown>:{};}
  private static vehicle(vehicle:DriverVehicleValidation,profile:Record<string,any>):DriverOperatingVehicle{const value=String(vehicle.capacity||vehicle.type||profile.operating_vehicle||'').toLowerCase();if(!value)return null;if(/bicycle|bike|cycle/.test(value))return'bicycle';if(/motorcycle|motorbike|moped|scooter/.test(value))return'motorcycle';if(/large.?van|luton|box.?van/.test(value))return'large_van';if(/small.?van|\bvan\b/.test(value))return'small_van';return'car';}
  private static age(raw:unknown,now:Date,minimum:number){if(!raw)return{eligible:false,years:null,minimum,state:'missing' as const,reason:'Add your date of birth.'};try{const iso=parseDriverDateOfBirth(raw,now),years=calculateCalendarAge(iso,now),eligible=years>=minimum;return{eligible,years,minimum,state:eligible?'completed' as const:'under_age' as const,reason:eligible?null:'You must meet the minimum driver age requirement to register.'};}catch{return{eligible:false,years:null,minimum,state:'invalid' as const,reason:'Enter a valid date of birth.'};}}
  private static has(value:unknown){return String(value??'').trim().length>0;}
}
