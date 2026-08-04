import { Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../services/supabase.service';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';
import { DriverOnboardingNotificationService } from '../services/driver-onboarding-notification.service';

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
    const registrationAllowed = true;
    if (!(profile.role === 'driver' && profile.onboarding_completed)) {
      await MarketAvailabilityService.requireCapability({ countryCode: profile.country_code, marketCity: profile.market_city || profile.city, zoneId: profile.zone_id, capability: 'driver_registration', endpoint: '/api/driver-onboarding/status' });
    }
    const overallStatus = profile.is_verified === true || profile.verification_status === 'approved' ? 'approved'
      : profile.verification_status === 'action_required' || profile.driver_review_status === 'action_required' ? 'rejected'
      : profile.onboarding_completed ? 'pending' : 'draft';
    const blockers = Array.isArray(profile.driver_review_blockers) ? profile.driver_review_blockers
      : Array.isArray(profile.verification_blockers) ? profile.verification_blockers : [];
    const outstandingRequests = blockers.map((item: unknown, index: number) => ({
      id: `${driverId}:${index}`, item: String(item), status: overallStatus === 'rejected' ? 'rejected' : 'pending',
      adminMessage: String(profile.driver_review_notes || profile.verification_notes || ''),
      submittedAt: profile.driver_review_sent_at || profile.updated_at || null,
      updatedAt: profile.updated_at || null,
      nextAction: overallStatus === 'rejected' ? 'Update this item and resubmit it for review.' : 'Wait for Admin review.'
    }));
    if (overallStatus === 'approved' && !outstandingRequests.length) outstandingRequests.push({
      id: `${driverId}:approved`, item: 'Driver onboarding', status: 'approved', adminMessage: '',
      submittedAt: profile.updated_at || null, updatedAt: profile.updated_at || null, nextAction: 'No action required.'
    });
    const stripeStatus = profile.stripe_connect_status || 'not_started';
    console.info('[DriverOnboarding] status success', { userId, requestId, overallStatus, outstandingRequestCount: outstandingRequests.length, stripeStatus });
    return res.json({ driverId, registrationAllowed, overallStatus, profile, vehicle: vehicle || null, outstandingRequests,
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

export default router;
