import { Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../services/supabase.service';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';
import { DriverOnboardingNotificationService } from '../services/driver-onboarding-notification.service';
import { DriverRequirementService } from '../services/driver-requirement.service';

const router = Router();

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
    const { data: vehicle, error: vehicleError } = await supabaseAdmin.from('vehicles').select('*').eq('driver_id', driverId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (vehicleError) throw Object.assign(new Error('Driver vehicle lookup failed.'), { code: vehicleError.code });
    const { data: authUser, error: authUserError } = await supabaseAdmin.auth.admin.getUserById(driverId);
    if (authUserError) throw Object.assign(new Error('Driver authentication lookup failed.'), { code: authUserError.code });
    const { data: requestRows, error: requestError } = await supabaseAdmin.from('driver_onboarding_requests').select('id,requirement_code,item,public_message,status,sent_at,resolved_at,updated_at').eq('driver_id',driverId).order('created_at',{ascending:false});
    if (requestError) throw Object.assign(new Error('Driver Admin-request lookup failed.'), { code: requestError.code });
    const registrationAllowed = true;
    if (!(profile.role === 'driver' && profile.onboarding_completed)) {
      await MarketAvailabilityService.requireCapability({ countryCode: profile.country_code, marketCity: profile.market_city || profile.city, zoneId: profile.zone_id, capability: 'driver_registration', endpoint: '/api/driver-onboarding/status' });
    }
    const adminRequests=(requestRows||[]).map(row=>({id:row.id,requirementCode:row.requirement_code,item:row.item,status:row.status,publicMessage:row.public_message,submittedAt:row.sent_at,updatedAt:row.updated_at,resolvedAt:row.resolved_at,nextAction:row.status==='approved'?'No action required.':'Correct this item and resubmit it for review.'}));
    const resolution=DriverRequirementService.resolve({profile,vehicle:vehicle||null,authEmailConfirmed:!!authUser.user?.email_confirmed_at,adminRequests,countryCode:profile.country_code,marketCity:profile.market_city||profile.city});
    const outstandingRequests=resolution.adminRequests.filter(request=>request.status!=='approved').map(request=>({id:request.id,item:request.item,status:request.status,adminMessage:request.publicMessage,submittedAt:request.submittedAt,updatedAt:request.updatedAt,nextAction:request.nextAction}));
    const stripeStatus = profile.stripe_connect_status || 'not_started';
    console.info('[DriverOnboarding] status success', { userId, requestId, overallStatus:resolution.overallStatus, outstandingRequestCount: outstandingRequests.length, stripeStatus });
    return res.json({ driverId, registrationAllowed, overallStatus:resolution.overallStatus, profile, vehicle: vehicle || null, outstandingRequests,
      automaticRequirements:resolution.automaticRequirements,adminRequests:resolution.adminRequests,warnings:resolution.warnings,progress:resolution.progress,onlineEligibility:resolution.onlineEligibility,selectedServices:resolution.selectedServices,vehicleType:resolution.vehicleType,age:resolution.age,
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

router.post('/validate-submission', async (req,res)=>{
  const driverId=await authenticatedDriver(req,res);if(!driverId)return;
  try{
    const{data:profile,error:profileError}=await supabaseAdmin.from('profiles').select('*').eq('id',driverId).single();if(profileError||!profile)throw profileError||new Error('Driver profile not found.');
    const{data:vehicle,error:vehicleError}=await supabaseAdmin.from('vehicles').select('*').eq('driver_id',driverId).order('created_at',{ascending:false}).limit(1).maybeSingle();if(vehicleError)throw vehicleError;
    const{data:auth,error:authError}=await supabaseAdmin.auth.admin.getUserById(driverId);if(authError)throw authError;
    const profileInput={...profile,...(req.body?.profile||{})};const vehicleInput={...(vehicle||{}),...(req.body?.vehicle||{})};
    const resolution=DriverRequirementService.resolve({profile:profileInput,vehicle:vehicleInput,authEmailConfirmed:!!auth.user?.email_confirmed_at,countryCode:profileInput.country_code,marketCity:profileInput.market_city||profileInput.city});
    const blockers=resolution.automaticRequirements.filter(item=>item.blockingForSubmission);
    const{error:auditError}=await supabaseAdmin.from('driver_requirement_audit').insert({driver_id:driverId,event_type:'submission_validated',selected_services:resolution.selectedServices,requirement_codes:resolution.automaticRequirements.map(item=>item.code)});
    if(auditError)throw auditError;
    if(blockers.length)return res.status(422).json({error:blockers[0].reason,code:'DRIVER_REQUIREMENTS_INCOMPLETE',requirements:blockers,progress:resolution.progress});
    return res.json({valid:true,resolution});
  }catch(error:unknown){const message=error instanceof Error?error.message:'Unable to validate driver submission.';return res.status(500).json({error:message,code:'DRIVER_REQUIREMENT_VALIDATION_FAILED'});}
});

export default router;
