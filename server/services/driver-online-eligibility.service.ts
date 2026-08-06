import { DriverRequirementResolution } from './driver-requirement.service';

export type DriverOnlineEligibilityCode='ACCOUNT_SUSPENDED'|'MARKET_LOCATION_UNRESOLVED'|'MARKET_PAUSED'|'MARKET_NOT_LIVE'|'DRIVER_ONBOARDING_INCOMPLETE'|'DRIVER_ACTION_REQUIRED'|'DRIVER_UNDER_REVIEW'|'NO_APPROVED_SERVICE'|'VEHICLE_REQUIRED'|'VEHICLE_NOT_APPROVED'|'REQUIRED_DOCUMENTS_MISSING'|'REQUIRED_DOCUMENTS_EXPIRED'|'INSURANCE_REQUIRED'|'STRIPE_SETUP_INCOMPLETE'|'LOCATION_PERMISSION_REQUIRED'|'ALLOWED';
export interface DriverOnlineEligibilityResult{allowed:boolean;code:DriverOnlineEligibilityCode;title:string;message:string;action:string|null;blockers:string[];}
const deny=(code:DriverOnlineEligibilityCode,title:string,message:string,action:string,blockers:string[]=[]):DriverOnlineEligibilityResult=>({allowed:false,code,title,message,action,blockers});

export class DriverOnlineEligibilityService{
 static evaluate(input:{profile:{[key:string]:unknown};market:{allowed:boolean;code:string|null};requirements:DriverRequirementResolution;vehiclePresent:boolean;locationPermission?:boolean}):DriverOnlineEligibilityResult{
  const{profile,market,requirements}=input;const account=String(profile['account_status']||'active').toLowerCase();
  if(['suspended','blocked','paused'].includes(account))return deny('ACCOUNT_SUSPENDED','Account unavailable','Your driver account is suspended. Contact support for help.','CONTACT_SUPPORT');
  if(market.code==='MARKET_LOCATION_UNRESOLVED')return deny('MARKET_LOCATION_UNRESOLVED','Confirm your operating location','Allow location access or choose the area where you want to work.','SET_LOCATION');
  if(market.code==='MARKET_PAUSED')return deny('MARKET_PAUSED','Driver services temporarily paused','Going online is temporarily unavailable in this area.','TRY_AGAIN_LATER');
  if(!market.allowed)return deny('MARKET_NOT_LIVE','Movabi is not available here yet','Driver services have not launched in this area.','CHANGE_OPERATING_AREA');
  if(requirements.overallStatus==='action_required')return deny('DRIVER_ACTION_REQUIRED','Action required','Update the requested information and resubmit your application.','VIEW_OUTSTANDING_REQUESTS',requirements.onlineEligibility.reasons);
  if(requirements.overallStatus==='under_review')return deny('DRIVER_UNDER_REVIEW','Application under review','Your driver application is being reviewed. No action is required right now.','VIEW_STATUS',requirements.onlineEligibility.reasons);
  if(['not_started','incomplete','ready_to_submit'].includes(requirements.overallStatus))return deny('DRIVER_ONBOARDING_INCOMPLETE','Complete your driver setup','Finish the remaining onboarding steps before going online.','OPEN_DRIVER_SETUP',requirements.onlineEligibility.reasons);
  if(!requirements.selectedServices.length)return deny('NO_APPROVED_SERVICE','No approved service','Select a service and complete its requirements before going online.','MANAGE_SERVICES');
  if(!input.vehiclePresent)return deny('VEHICLE_REQUIRED','Vehicle details required','Add the vehicle or bicycle you will use for your selected services.','ADD_VEHICLE');
  const blockers=requirements.automaticRequirements.filter(item=>item.blockingForOnline);
  if(blockers.some(item=>String(item.status)==='expired'))return deny('REQUIRED_DOCUMENTS_EXPIRED','Document expired','Replace the expired document before going online.','UPDATE_DOCUMENTS',blockers.map(item=>item.reason));
  if(blockers.some(item=>item.code.includes('insurance')))return deny('INSURANCE_REQUIRED','Insurance required','Add valid insurance for the selected service and vehicle.','UPLOAD_INSURANCE',blockers.map(item=>item.reason));
  if(blockers.some(item=>item.category==='documents'))return deny('REQUIRED_DOCUMENTS_MISSING','Documents required','Upload the outstanding documents before going online.','UPLOAD_DOCUMENTS',blockers.map(item=>item.reason));
  if(profile['stripe_connect_status']!=='connected')return deny('STRIPE_SETUP_INCOMPLETE','Complete payout setup','Finish Stripe Connect so you can receive payouts.','CONTINUE_STRIPE_SETUP');
  if(input.locationPermission===false)return deny('LOCATION_PERMISSION_REQUIRED','Location permission required','Allow location access before going online.','SET_LOCATION');
  return{allowed:true,code:'ALLOWED',title:'Ready to go online',message:'You can now accept jobs.',action:null,blockers:[]};
 }
}
