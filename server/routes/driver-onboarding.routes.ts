import { Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../services/supabase.service';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';
import { DriverOnboardingNotificationService } from '../services/driver-onboarding-notification.service';
import { DriverRequirementService } from '../services/driver-requirement.service';
import { DriverVehicleRow, mapDriverVehicleRow, parseDriverVehicleInput } from '../models/driver-vehicle.model';
import { CANONICAL_DRIVER_PROFILE_SELECT, calculateCalendarAge, mapDriverProfile, parseDriverDateOfBirth, parseResidentialAddress } from '../models/driver-profile.model';

const router = Router();

function parseOnboardingItems(input:unknown):Record<string,unknown>{
  if(!input)return{};
  if(typeof input==='string'){try{return parseOnboardingItems(JSON.parse(input));}catch{return{};}}
  if(Array.isArray(input))return input.reduce<Record<string,unknown>>((items,entry)=>{if(!entry||typeof entry!=='object')return items;const row=entry as Record<string,unknown>;const key=String(row.key||row.name||'').trim();if(key)items[key]=row.value;return items;},{});
  return typeof input==='object'?input as Record<string,unknown>:{};
}

function serializeOnboardingItems(items:Record<string,unknown>):Array<{key:string;value:string}>{
  return Object.entries(items).filter(([key])=>key.trim().length>0).map(([key,value])=>({key,value:typeof value==='string'?value:JSON.stringify(value)}));
}

async function currentVehicle(driverId:string):Promise<DriverVehicleRow|null>{
  const{data,error}=await supabaseAdmin.from('vehicles').select('*').eq('user_id',driverId).order('created_at',{ascending:false});
  if(error)throw error;
  if((data||[]).length>1)throw Object.assign(new Error('Multiple vehicle records require Admin repair before setup can continue.'),{code:'DUPLICATE_DRIVER_VEHICLES',httpStatus:409});
  return ((data||[])[0] as DriverVehicleRow|undefined)||null;
}

async function authenticatedDriver(req: Request, res: Response): Promise<string | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) { res.status(401).json({ error: 'Authentication required.' }); return null; }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user?.id) { res.status(401).json({ error: 'Invalid or expired session.' }); return null; }
  return data.user.id;
}

router.get('/status', async (req, res) => {
  const requestId = String(req.headers['x-request-id'] || randomUUID());
  let userId: string | null = null;
  try {
    const driverId = await authenticatedDriver(req, res);
    if (!driverId) {
      console.warn('[DriverOnboarding] status failed', { userId, requestId, code: 'UNAUTHENTICATED', message: 'Authentication failed' });
      return;
    }
    userId = driverId;
    console.info('[DriverOnboarding] status request', { userId, requestId });
    const { data: profile, error } = await supabaseAdmin.from('profiles').select('*').eq('id', driverId).single();
    if (error) throw Object.assign(new Error('Driver profile lookup failed.'), { code: error.code });
    if (!profile) throw Object.assign(new Error('Driver profile not found.'), { code: 'PROFILE_NOT_FOUND', httpStatus: 404 });
    const vehicle = await currentVehicle(driverId);
    const { data: authUser, error: authUserError } = await supabaseAdmin.auth.admin.getUserById(driverId);
    if (authUserError) throw Object.assign(new Error('Driver authentication lookup failed.'), { code: authUserError.code });
    const { data: requestRows, error: requestError } = await supabaseAdmin.from('driver_onboarding_requests').select('id,requirement_code,item,public_message,status,sent_at,resolved_at,updated_at').eq('driver_id',driverId).order('created_at',{ascending:false});
    if (requestError) throw Object.assign(new Error('Driver Admin-request lookup failed.'), { code: requestError.code });
    const registrationAllowed = true;
    if (!(profile.role === 'driver' && profile.onboarding_completed)) {
      await MarketAvailabilityService.requireCapability({ countryCode: profile.country_code, marketCity: profile.market_city || profile.city, zoneId: profile.zone_id, capability: 'driver_registration', endpoint: '/api/driver-onboarding/status' });
    }
    const adminRequests=(requestRows||[]).map(row=>({id:row.id,requirementCode:row.requirement_code,item:row.item,status:row.status,publicMessage:row.public_message,submittedAt:row.sent_at,updatedAt:row.updated_at,resolvedAt:row.resolved_at,nextAction:row.status==='approved'?'No action required.':'Correct this item and resubmit it for review.'}));
    const canonicalVehicle=vehicle?mapDriverVehicleRow(vehicle):null;
    const canonicalProfile=mapDriverProfile(profile,!!authUser.user?.email_confirmed_at);
    const resolution=DriverRequirementService.resolve({profile,canonicalProfile,vehicle:canonicalVehicle,authEmailConfirmed:canonicalProfile.emailConfirmed,adminRequests,countryCode:profile.country_code,marketCity:profile.market_city||profile.city});
    const outstandingRequests=resolution.adminRequests.filter(request=>request.status!=='approved').map(request=>({id:request.id,item:request.item,status:request.status,adminMessage:request.publicMessage,submittedAt:request.submittedAt,updatedAt:request.updatedAt,nextAction:request.nextAction}));
    const stripeStatus = profile.stripe_connect_status || 'not_started';
    console.info('[DriverOnboarding] status success', { userId, requestId, overallStatus:resolution.overallStatus, outstandingRequestCount: outstandingRequests.length, stripeStatus });
    return res.json({ driverId, registrationAllowed, overallStatus:resolution.overallStatus, profile, canonicalProfile, vehicle: canonicalVehicle, outstandingRequests,
      automaticRequirements:resolution.automaticRequirements,adminRequests:resolution.adminRequests,warnings:resolution.warnings,sectionStatus:resolution.sectionStatus,progress:resolution.progress,onlineEligibility:resolution.onlineEligibility,selectedServices:resolution.selectedServices,vehicleType:resolution.vehicleType,age:resolution.age,
      submissionHistory: Array.isArray(profile.driver_review_history) ? profile.driver_review_history : [],
      stripeStatus, updatedAt: profile.updated_at || null });
  } catch (error: unknown) {
    const details: Error & { code?: string; httpStatus?: number } = error instanceof Error
      ? error as Error & { code?: string; httpStatus?: number }
      : new Error('Unknown onboarding status error');
    const code = details.code || 'ONBOARDING_STATUS_FAILED';
    console.error('[DriverOnboarding] status failed', { userId, requestId, code, message: details.message });
    if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
    return res.status(details.httpStatus || 500).json({ error: details.message || 'Unable to load driver onboarding status.', code });
  }
});

router.post('/events', async (req, res) => {
  const driverId = await authenticatedDriver(req, res); if (!driverId) return;
  const eventType = String(req.body?.eventType || '');
  if (!DriverOnboardingNotificationService.isSupported(eventType)) return res.status(400).json({ error: 'Unsupported onboarding event.' });
  const eventKey = String(req.body?.eventKey || randomUUID()).trim();
  if (!/^[a-zA-Z0-9:_-]{8,180}$/.test(eventKey)) return res.status(400).json({ error: 'Invalid event correlation key.' });
  try {
    const result = await DriverOnboardingNotificationService.enqueue(driverId, {
      eventKey, eventType, affectedItem: String(req.body?.affectedItem || 'onboarding').slice(0, 120),
      previousStatus: req.body?.previousStatus == null ? null : String(req.body.previousStatus).slice(0, 80),
      newStatus: req.body?.newStatus == null ? null : String(req.body.newStatus).slice(0, 80)
    });
    return res.status(result.duplicate ? 200 : 202).json({ accepted: true, duplicate: result.duplicate, eventId: result.id });
  } catch (error) {
    console.warn('[driver-onboarding] notification enqueue failed after persisted mutation:', error);
    return res.status(202).json({ accepted: true, notificationQueued: false });
  }
});

router.put('/profile',async(req,res)=>{const driverId=await authenticatedDriver(req,res);if(!driverId)return;try{
  const body=req.body&&typeof req.body==='object'?req.body:{};const residentialAddressPresent=typeof body.residentialAddress==='string';const dateOfBirthPresent=typeof body.dateOfBirth==='string';
  console.info('[DriverOnboarding] profile update request',{userId:driverId,residentialAddressPresent,dateOfBirthPresent});
  if(!residentialAddressPresent&&!dateOfBirthPresent)throw new Error('Provide a residential address or date of birth.');
  const profileUpdates:{current_address?:string;date_of_birth?:string;updated_at:string}={updated_at:new Date().toISOString()};
  if(residentialAddressPresent)profileUpdates.current_address=parseResidentialAddress(body);
  if(dateOfBirthPresent){profileUpdates.date_of_birth=parseDriverDateOfBirth(body.dateOfBirth);calculateCalendarAge(profileUpdates.date_of_birth);}
  console.info('[DriverOnboarding] profile update payload',{userId:driverId,keys:Object.keys(profileUpdates)});
  const{data,error}=await supabaseAdmin.from('profiles').update(profileUpdates).eq('id',driverId).select(CANONICAL_DRIVER_PROFILE_SELECT).single();if(error||!data)throw error||new Error('Profile save returned no record.');
  const{data:auth,error:authError}=await supabaseAdmin.auth.admin.getUserById(driverId);if(authError)throw authError;const profile=mapDriverProfile(data,!!auth.user?.email_confirmed_at);if(residentialAddressPresent&&!profile.residentialAddress)throw new Error('Residential address was not persisted.');if(dateOfBirthPresent&&!profile.dateOfBirth)throw new Error('Date of birth was not persisted.');
  console.info('[DriverOnboarding] profile update success',{userId:driverId,residentialAddressPresent,dateOfBirthPresent});return res.json({profile});
 }catch(error:unknown){const details=error as Error&{code?:string;details?:string;hint?:string};const message=details.message||'Unable to save driver profile.';console.error('[DriverOnboarding] profile update failed',{userId:driverId,code:details.code||'PROFILE_SAVE_FAILED',message,details:details.details||null,hint:details.hint||null});return res.status(/date of birth|valid current residential/i.test(message)?422:500).json({error:message,code:details.code||'PROFILE_SAVE_FAILED'});}});

router.put('/verification-items',async(req,res)=>{const driverId=await authenticatedDriver(req,res);if(!driverId)return;try{
  const{data:existing,error:readError}=await supabaseAdmin.from('profiles').select('id,verification_items').eq('id',driverId).single();if(readError||!existing)throw readError||Object.assign(new Error('Driver profile not found.'),{code:'PROFILE_NOT_FOUND'});
  const items={...parseOnboardingItems(existing.verification_items),bicycle_declaration:req.body?.bicycleDeclaration===true,delivery_equipment_confirmed:req.body?.deliveryEquipmentConfirmed===true};
  const{data,error}=await supabaseAdmin.from('profiles').update({verification_items:serializeOnboardingItems(items),updated_at:new Date().toISOString()}).eq('id',driverId).select('id').single();if(error||!data)throw error||new Error('Onboarding declarations save returned no record.');
  return res.json({saved:true});
 }catch(error:unknown){const details=error as Error&{code?:string;details?:string;hint?:string};console.error('[DriverOnboarding] verification items update failed',{userId:driverId,code:details.code||'VERIFICATION_ITEMS_SAVE_FAILED',message:details.message,details:details.details||null,hint:details.hint||null});return res.status(500).json({error:details.message||'Unable to save onboarding declarations.',code:details.code||'VERIFICATION_ITEMS_SAVE_FAILED'});}});

router.put('/agreement',async(req,res)=>{const driverId=await authenticatedDriver(req,res);if(!driverId)return;try{
  if(typeof req.body?.accepted!=='boolean')return res.status(422).json({error:'Agreement acceptance must be true or false.',code:'INVALID_AGREEMENT_STATE'});
  const acceptedAt=req.body.accepted?new Date().toISOString():null;
  const{data,error}=await supabaseAdmin.from('profiles').update({accepted_driver_agreement_at:acceptedAt,updated_at:new Date().toISOString()}).eq('id',driverId).select('id,accepted_driver_agreement_at').single();
  if(error||!data)throw error||new Error('Agreement save returned no record.');
  return res.json({agreement:{accepted:!!data.accepted_driver_agreement_at,acceptedAt:data.accepted_driver_agreement_at||null}});
 }catch(error:unknown){const details=error as Error&{code?:string;details?:string;hint?:string};console.error('[DriverOnboarding] agreement update failed',{userId:driverId,code:details.code||'AGREEMENT_SAVE_FAILED',message:details.message,details:details.details||null,hint:details.hint||null});return res.status(500).json({error:details.message||'Unable to save Driver Agreement.',code:details.code||'AGREEMENT_SAVE_FAILED'});}});

router.get('/vehicle',async(req,res)=>{const driverId=await authenticatedDriver(req,res);if(!driverId)return;try{const row=await currentVehicle(driverId);return res.json({vehicle:row?mapDriverVehicleRow(row):null});}catch(error:unknown){const details=error as Error&{httpStatus?:number;code?:string};return res.status(details.httpStatus||500).json({error:details.message,code:details.code||'VEHICLE_READ_FAILED'});}});

router.put('/vehicle',async(req,res)=>{const driverId=await authenticatedDriver(req,res);if(!driverId)return;try{
  const input=parseDriverVehicleInput(req.body);const existing=await currentVehicle(driverId);
  const values={user_id:driverId,type:input.vehicleType,make:input.make,model:input.model,color:input.colour,year:input.year,license_plate:input.registrationNumber,capacity:input.capacity,service_eligibility:input.serviceEligibility,updated_at:new Date().toISOString()};
  const query=existing?supabaseAdmin.from('vehicles').update(values).eq('id',existing.id):supabaseAdmin.from('vehicles').insert(values);
  const{data,error}=await query.select('*').single();if(error||!data)throw error||new Error('Vehicle save returned no record.');
  return res.json({vehicle:mapDriverVehicleRow(data as DriverVehicleRow)});
}catch(error:unknown){const details=error as Error&{httpStatus?:number;code?:string};const validation=/required|valid vehicle year/i.test(details.message);return res.status(details.httpStatus||(validation?422:500)).json({error:details.message,code:details.code||(validation?'INVALID_VEHICLE':'VEHICLE_SAVE_FAILED')});}});

router.post('/submit-review', async (req,res)=>{
  const driverId=await authenticatedDriver(req,res);if(!driverId)return;
  try{
    const{data:profile,error:profileError}=await supabaseAdmin.from('profiles').select('*').eq('id',driverId).single();if(profileError||!profile)throw profileError||new Error('Driver profile not found.');
    const vehicle=await currentVehicle(driverId);
    const{data:auth,error:authError}=await supabaseAdmin.auth.admin.getUserById(driverId);if(authError)throw authError;
    const profileInput=profile;const vehicleInput=vehicle?mapDriverVehicleRow(vehicle):null;
    const canonicalProfile=mapDriverProfile(profileInput,!!auth.user?.email_confirmed_at);
    const resolution=DriverRequirementService.resolve({profile:profileInput,canonicalProfile,vehicle:vehicleInput,authEmailConfirmed:canonicalProfile.emailConfirmed,countryCode:profileInput.country_code,marketCity:profileInput.market_city||profileInput.city});
    const blockers=resolution.automaticRequirements.filter(item=>item.blockingForSubmission);
    const{error:auditError}=await supabaseAdmin.from('driver_requirement_audit').insert({driver_id:driverId,event_type:'submission_validated',selected_services:resolution.selectedServices,requirement_codes:resolution.automaticRequirements.map(item=>item.code)});
    if(auditError)throw auditError;
    if(blockers.length){console.warn('[DriverOnboarding] review resubmission blocked',{userId:driverId,blockerCodes:blockers.map(item=>item.code)});return res.status(422).json({error:blockers[0].reason,code:'DRIVER_REQUIREMENTS_INCOMPLETE',requirements:blockers,progress:resolution.progress});}
    const submittedAt=new Date().toISOString();const submitted=req.body?.profile||{};
    const existingItems=parseOnboardingItems(profile.verification_items);
    const submittedItems=parseOnboardingItems(submitted.verification_items);
    const updates={onboarding_completed:true,role:'driver',pricing_plan:'starter',subscription_status:'inactive',full_name:String(submitted.full_name||'').trim(),phone:String(submitted.phone||'').trim(),date_of_birth:submitted.date_of_birth||null,accepted_driver_agreement_at:submitted.accepted_driver_agreement_at||null,driver_license_url:submitted.driver_license_url||null,insurance_url:submitted.insurance_url||null,right_to_work_url:submitted.right_to_work_url||null,verification_items:serializeOnboardingItems({...existingItems,...submittedItems}),verification_status:'under_review',driver_review_status:'under_review',verification_notes:null,driver_review_notes:null,verification_blockers:[],driver_review_blockers:[],is_verified:false,updated_at:submittedAt};
    const{data:updated,error:updateError}=await supabaseAdmin.from('profiles').update(updates).eq('id',driverId).select(CANONICAL_DRIVER_PROFILE_SELECT).single();if(updateError||!updated)throw updateError||new Error('Review submission did not update the driver profile.');
    return res.json({submitted:true,profile:mapDriverProfile(updated,!!auth.user?.email_confirmed_at)});
  }catch(error:unknown){const message=error instanceof Error?error.message:'Unable to validate driver submission.';return res.status(500).json({error:message,code:'DRIVER_REQUIREMENT_VALIDATION_FAILED'});}
});

export default router;
