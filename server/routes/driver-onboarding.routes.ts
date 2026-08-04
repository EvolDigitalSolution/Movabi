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
  try {
    const driverId = await authenticatedDriver(req, res); if (!driverId) return;
    const { data: profile, error } = await supabaseAdmin.from('profiles').select('*').eq('id', driverId).single();
    if (error || !profile) return res.status(404).json({ error: 'Driver profile not found.' });
    const { data: vehicle } = await supabaseAdmin.from('vehicles').select('*').eq('driver_id', driverId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    let registrationAllowed = true;
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
    return res.json({ driverId, registrationAllowed, overallStatus, profile, vehicle: vehicle || null, outstandingRequests,
      submissionHistory: Array.isArray(profile.driver_review_history) ? profile.driver_review_history : [],
      stripeStatus: profile.stripe_connect_status || 'not_started', updatedAt: profile.updated_at || null });
  } catch (error) {
    if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
    return res.status(500).json({ error: 'Unable to load driver onboarding status.' });
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
