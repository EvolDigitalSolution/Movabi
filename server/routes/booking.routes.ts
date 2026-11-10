import {DriverPaymentAccountService,sandboxDestinationProvider} from '../services/driver-payment-account.service';
import { cashRideAcquisitionApproved, mapCashCreditError, isCashRide } from '../services/driver-cash-credit';
import {assertDriverJobMarket} from '../services/driver-market-scope';
import earlyStopRoutes from './early-stop.routes';
import { DriverEarningsPreviewService } from '../services/driver-earnings-preview.service';
import { customerDisplayName } from '../../src/app/shared/utils/customer-display';
import { matchesVehicleCapacity } from '../../src/app/shared/utils/goods-vehicle-compatibility';
import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { FraudService } from '../services/fraud.service';
import { NotificationService } from '../services/notification.service';
import { LogisticsService } from '../services/logistics.service';
import { IssuingService } from '../services/issuing.service';
import { PricingService } from '../services/pricing.service';
import { MarketplaceConfigService } from '../services/marketplace-config.service';
import { DispatchService } from '../services/dispatch.service';
import { stripe } from '../services/stripe.service';
import { rateLimit } from 'express-rate-limit';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';
import { mapDriverAcquisitionError } from '../services/driver-eligibility.service';
import { isDriverEligibleForService, toCanonicalDriverService } from '../services/driver-service-eligibility';
import { PayoutEligibilityService } from '../services/payout-eligibility.service';
import { NoShowService, NO_SHOW_ARRIVAL_MAX_DISTANCE_M, NO_SHOW_ARRIVAL_MAX_LOCATION_AGE_MS } from '../services/no-show.service';

const router = Router();
router.use('/early-stop', earlyStopRoutes);

router.get('/:jobId/nearby-availability', rateLimit({windowMs:60000,limit:15}), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control','private, no-store');
    const userId = await requireAuthenticatedUser(req,res);
    if (!userId) return;
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.jobId || ''))) return res.status(400).json({error:'Valid booking required'});
    try {
        const job = await getJob(String(req.params.jobId));
        if (job.customer_id !== userId) return res.status(403).json({error:'Booking unavailable'});
        if (job.driver_id || job.accepted_driver_id || !['requested','searching'].includes(String(job.status))) return res.status(409).json({error:'Search has ended'});
        const service = Array.isArray(job.service_type) ? job.service_type[0] : job.service_type;
        const snapshot = await new DispatchService().customerAvailability({...job,service_slug:service?.slug || job.service_slug} as any);
        return res.json(snapshot);
    } catch { return res.status(503).json({error:'Nearby availability is temporarily unavailable'}); }
});



router.post('/driver-earnings-preview', async (req: Request, res: Response) => {
    const driverId = await requireAuthenticatedUser(req, res);
    if (!driverId) return;
    const jobId = String(req.body?.jobId || '');
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return res.status(400).json({ error: 'Valid jobId required' });
    try {
        const proposed = req.body?.amount === undefined ? undefined : Number(req.body.amount);
        const preview = await DriverEarningsPreviewService.preview(driverId, jobId, proposed);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json(preview);
    } catch (error: any) {
        const message = String(error?.message || '');
        if (message === 'Agreed fare is below the protected booking minimum') {
            return res.status(409).json({ code: 'FARE_BELOW_MINIMUM', error: 'This offer is below the protected booking minimum. Review or increase the offer.' });
        }
        if (message === 'Request unavailable') {
            return res.status(409).json({ code: 'REQUEST_UNAVAILABLE', error: 'This request is no longer available.' });
        }
        console.warn('[DriverEarningsPreview] calculation unavailable', { jobId, reason: message });
        return res.status(409).json({ code: 'EARNINGS_UNAVAILABLE', error: 'Earnings preview unavailable. Please refresh the request.' });
    }
});

/**
 * Live congestion indicator for the job's route — green/amber/red with a
 * timestamp and an explicit unavailable state. Indicates road congestion,
 * not physical traffic-light signals.
 */
router.get('/:jobId/traffic', rateLimit({windowMs:60000,limit:15}), async (req: Request, res: Response) => {
    try {
        const userId = await getAuthUserId(req);
        if (!userId) return res.status(401).json({ error: 'Authentication required.' });
        const jobId = req.params.jobId;
        const { data: job } = await supabaseAdmin.from('jobs').select('id,customer_id,driver_id,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng').eq('id', jobId).maybeSingle();
        if (!job || (job.customer_id !== userId && job.driver_id !== userId)) return res.status(404).json({ error: 'Job not found.' });
        const { mapsV23 } = await import('../services/maps-v23');
        const route = await mapsV23.route({ lat: Number(job.pickup_lat), lng: Number(job.pickup_lng) }, { lat: Number(job.dropoff_lat), lng: Number(job.dropoff_lng) });
        const ratio = (route as any).congestionRatio ?? null;
        if (ratio == null) return res.json({ level: 'unavailable', ratio: null, observedAt: new Date().toISOString(), text: 'Live congestion data is temporarily unavailable.' });
        const level = ratio < 1.15 ? 'green' : ratio < 1.4 ? 'amber' : 'red';
        const text = level === 'green' ? 'Light congestion on the route.'
            : level === 'amber' ? 'Moderate congestion — allow extra time.'
            : 'Heavy congestion — significant delays expected.';
        return res.json({ level, ratio, observedAt: new Date().toISOString(), text });
    } catch {
        return res.json({ level: 'unavailable', ratio: null, observedAt: new Date().toISOString(), text: 'Live congestion data is temporarily unavailable.' });
    }
});

/**
 * Cancellation-fee preview: the applicable fee BEFORE the customer confirms.
 * Job-recorded fee wins; otherwise the active market policy supplies it.
 */
router.get('/:jobId/cancel-preview', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { data: job } = await supabaseAdmin.from('jobs').select('id,customer_id,driver_id,tenant_id,country_code,currency_code,cancellation_fee,price,total_price').eq('id', req.params.jobId).maybeSingle();
        if (!job || (job.customer_id !== userId && job.driver_id !== userId)) return res.status(404).json({ error: 'Job not found.' });
        const jobFeeMajor = Number(job.cancellation_fee || 0);
        const { data: policy } = await supabaseAdmin.rpc('active_cancellation_policy', { p_tenant: job.tenant_id, p_market: String(job.country_code || '') });
        const policyFeeMinor = (policy as any)?.enabled ? Number((policy as any).fee_minor || 0) : 0;
        const capped = (policy as any)?.fee_cap_minor != null ? Math.min(policyFeeMinor, Number((policy as any).fee_cap_minor)) : policyFeeMinor;
        return res.json({
            feeMinor: jobFeeMajor > 0 ? Math.round(jobFeeMajor * 100) : capped,
            source: jobFeeMajor > 0 ? 'booking' : (policy ? 'policy' : 'none'),
            policyVersion: (policy as any)?.version ?? null,
            graceSeconds: (policy as any)?.grace_seconds ?? null,
            driverAssigned: !!job.driver_id,
            currency: job.currency_code
        });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not preview the cancellation.' });
    }
});

/**
 * Customer debt: open receivables for the caller (never wallet credit).
 */
router.get('/debts', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { data, error } = await supabaseAdmin
            .from('customer_receivables')
            .select('id,job_id,currency_code,amount_minor,reason,status,policy_version,created_at')
            .eq('customer_id', userId)
            .in('status', ['open', 'disputed'])
            .order('created_at', { ascending: false });
        if (error) throw error;
        const { data: total } = await supabaseAdmin.rpc('customer_open_debt_minor', { p_customer: userId });
        return res.json({ debts: data || [], totalMinor: Number(total || 0) });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not read debts.' });
    }
});

/** Dispute an open receivable; keeps it visible but flagged for review. */
router.post('/debts/:id/dispute', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const reason = String(req.body?.reason || '').trim();
        if (reason.length < 10) return res.status(422).json({ error: 'Explain why this charge is wrong (10+ characters).', code: 'INVALID_DISPUTE_REASON' });
        const { data, error } = await supabaseAdmin
            .from('customer_receivables')
            .update({ status: 'disputed', dispute_reason: reason })
            .eq('id', req.params.id)
            .eq('customer_id', userId)
            .eq('status', 'open')
            .select('id,status')
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ error: 'Debt is not open or does not belong to you.', code: 'DEBT_NOT_OPEN' });
        return res.json({ success: true, dispute: data });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not dispute the debt.' });
    }
});

/**
 * Repay an open receivable through the existing verified Stripe intent path.
 * The webhook marks it paid only on a real payment_intent.succeeded event —
 * this route never marks payment success itself.
 */
router.post('/debts/:id/repay', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { data: debt, error } = await supabaseAdmin
            .from('customer_receivables')
            .select('id,tenant_id,customer_id,currency_code,amount_minor,reason,status')
            .eq('id', req.params.id)
            .eq('customer_id', userId)
            .eq('status', 'open')
            .maybeSingle();
        if (error) throw error;
        if (!debt) return res.status(409).json({ error: 'Debt is not open or does not belong to you.', code: 'DEBT_NOT_OPEN' });
        const { stripe } = await import('../services/stripe.service');
        const intent = await stripe.paymentIntents.create({
            amount: Number(debt.amount_minor),
            currency: String(debt.currency_code).toLowerCase(),
            metadata: { purpose: 'debt_repayment', receivable_id: debt.id, customer_id: userId }
        }, { idempotencyKey: `debt-repay:${debt.id}` });
        return res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not create the repayment.' });
    }
});

/**
 * Referral endpoints: the caller creates their own referral link for a
 * campaign and reads their own referral status — never another user's.
 */
/** Enabled referral campaigns the caller can use (market-scoped discovery). */
router.get('/referrals/available', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { data, error } = await supabaseAdmin
            .from('campaigns')
            .select('id,code,market_code,currency_code,service_slug,audience,value_type,value')
            .eq('kind', 'referral')
            .eq('enabled', true);
        if (error) throw error;
        return res.json({ campaigns: data || [] });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not list referral campaigns.' });
    }
});

router.post('/referrals/link', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const campaignId = String(req.body?.campaignId || '').trim();
        if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
        const { data: campaign } = await supabaseAdmin
            .from('campaigns')
            .select('id,code,kind,enabled,valid_from,valid_until')
            .eq('id', campaignId)
            .maybeSingle();
        if (!campaign || !campaign.enabled || campaign.kind !== 'referral') {
            return res.status(404).json({ error: 'Referral campaign is not available.', code: 'CAMPAIGN_UNAVAILABLE' });
        }
        return res.json({ code: campaign.code, referrerId: userId });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not create the referral link.' });
    }
});

router.get('/referrals/mine', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { data, error } = await supabaseAdmin
            .from('referrals')
            .select('id,campaign_id,status,reward_minor,created_at')
            .or(`referrer_id.eq.${userId},referee_id.eq.${userId}`)
            .order('created_at', { ascending: false });
        if (error) throw error;
        return res.json({ referrals: data || [] });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not read referrals.' });
    }
});

/** Record a referral at signup: the code resolves to a campaign; self-referral rejected server-side. */
router.post('/referrals/redeem', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const code = String(req.body?.code || '').trim().toUpperCase();
        const referrerId = String(req.body?.referrerId || '').trim();
        if (!code || !referrerId) return res.status(400).json({ error: 'code and referrerId are required' });
        if (referrerId === userId) return res.status(409).json({ error: 'You cannot refer yourself.', code: 'SELF_REFERRAL' });
        const { data: campaign } = await supabaseAdmin
            .from('campaigns')
            .select('id,tenant_id,enabled,paused,kind,referral_reward_bps')
            .eq('code', code)
            .eq('kind', 'referral')
            .maybeSingle();
        if (!campaign || !campaign.enabled || campaign.paused) return res.status(404).json({ error: 'Referral code is not active.', code: 'CAMPAIGN_UNAVAILABLE' });
        // Freeze the rate on the referral at link time so a later admin rate
        // edit never retroactively changes this referral's reward.
        const { data, error } = await supabaseAdmin
            .from('referrals')
            .insert({ tenant_id: campaign.tenant_id, campaign_id: campaign.id, referrer_id: referrerId, referee_id: userId, status: 'pending', reward_rate_bps: Number(campaign.referral_reward_bps ?? 500) })
            .select('id,status')
            .single();
        if (error) {
            if (String(error.code || '') === '23505') return res.status(409).json({ error: 'This referral was already recorded.', code: 'REFERRAL_EXISTS' });
            throw error;
        }
        return res.status(201).json({ referral: data });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not record the referral.' });
    }
});

/**
 * Apply a customer discount code to a quote: server-validated campaign
 * scope/cap/budget; the discount is frozen to the quote reference so the
 * booking can't claim a different amount later.
 */
router.post('/campaigns/apply', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const code = String(req.body?.code || '').trim().toUpperCase();
        const quote = String(req.body?.quoteReference || '').trim();
        if (!code || !quote) {
            return res.status(400).json({ error: 'code and quoteReference are required' });
        }
        // Server derives the eligible service fare from the authoritative
        // quote — never trust a browser amount for discounts or margins.
        const { data: q } = await supabaseAdmin
            .from('quote_market_adjustments')
            .select('quote_reference,customer_id,protected_fare_snapshot')
            .eq('quote_reference', quote)
            .eq('customer_id', userId)
            .maybeSingle();
        const eligibleMinor = Number(q?.protected_fare_snapshot?.driverBase ?? 0);
        if (!q || !Number.isFinite(eligibleMinor) || eligibleMinor <= 0) {
            return res.status(404).json({ error: 'Quote not found.', code: 'QUOTE_NOT_FOUND' });
        }
        const { data: campaign } = await supabaseAdmin
            .from('campaigns')
            .select('id,tenant_id,enabled,kind')
            .eq('code', code)
            .eq('kind', 'customer_discount')
            .maybeSingle();
        if (!campaign || !campaign.enabled) return res.status(404).json({ error: 'Discount code is not active.', code: 'CAMPAIGN_UNAVAILABLE' });
        const { data: applied, error } = await supabaseAdmin.rpc('apply_campaign_discount', {
            p_campaign: campaign.id, p_customer: userId, p_quote: quote, p_fare_minor: Math.round(eligibleMinor)
        });
        if (error) {
            const msg = String(error.message || '');
            const status = msg.includes('cap_reached') ? 409 : msg.includes('budget') ? 409 : 422;
            return res.status(status).json({ error: msg, code: 'DISCOUNT_REJECTED' });
        }
        return res.json({ discountMinor: applied.discount_minor, campaignId: campaign.id, quoteReference: quote });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not apply the discount.' });
    }
});

/**
 * Remove an applied-but-unconsumed discount from a quote: releases the
 * application and refunds campaign budget. Removing a non-existent
 * application is a no-op (idempotent client retry safe).
 */
router.post('/campaigns/remove', async (req: Request, res: Response) => {
    try {
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const campaignId = String(req.body?.campaignId || '').trim();
        const quote = String(req.body?.quoteReference || '').trim();
        if (!campaignId || !quote) return res.status(400).json({ error: 'campaignId and quoteReference are required' });
        const { data: removed } = await supabaseAdmin.rpc('cancel_campaign_application', {
            p_campaign: campaignId, p_customer: userId, p_quote: quote
        });
        return res.json({ removed: !!removed });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not remove the discount.' });
    }
});

router.get('/:jobId/customer', async (req: Request, res: Response) => {
    const userId = await getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { data: job, error } = await supabaseAdmin.from('jobs')
        .select('customer_id,driver_id').eq('id', String(req.params.jobId)).maybeSingle();
    if (error || !job || job.driver_id !== userId) return res.status(403).json({ error: 'Assigned driver access required' });
    const { data: customer, error: profileError } = await supabaseAdmin.from('profiles')
        .select('*').eq('id', job.customer_id).maybeSingle();
    if (profileError || !customer) return res.status(503).json({ error: 'Customer details are temporarily unavailable' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ customer: { full_name: customerDisplayName(customer),
        avatar_url: customer.avatar_url || null, phone: customer.phone || customer.phone_number || null } });
});

const capturedStatuses = ['paid', 'captured', 'succeeded'];
const cancellableStripeStatuses = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture'];
const bookingCreateLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

async function getAuthUserId(req: Request): Promise<string | null> {
    const existing = (req as any).user?.id || (req as any).auth?.user?.id;
    if (existing) return String(existing);

    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user?.id) {
        console.warn('[BookingRoutes] auth token decode failed:', error?.message || 'No user on token');
        return null;
    }

    return data.user.id;
}

/**
 * Fail closed before a driver can acquire paid work: the driver must be in the
 * approved internal cash-Ride credit cohort or the existing payout scope.
 * Disabled pilots retain the existing checks. This never changes login.
 * Returns false after writing the 403 response.
 */
async function requirePayoutEligible(driverId: string, res: Response, job:any): Promise<boolean> {
    try {
        await assertDriverJobMarket(supabaseAdmin,driverId,job);
        if (await cashRideAcquisitionApproved(supabaseAdmin,driverId,job)) return true;
        if(String(job.country_code).toUpperCase()==='NG'){
            if(job.metadata?.driver_settlement_method!=='transfer')throw new Error('Booking settlement method/timing must be approved before acquiring paid work.');
            const payout=await new DriverPaymentAccountService(supabaseAdmin,sandboxDestinationProvider).ready(driverId);
            if(String(job.currency_code).toUpperCase()!==payout.currency)throw new Error('Payout currency mismatch');
        }else await PayoutEligibilityService.assertEligible(driverId);
        return true;
    } catch (error: any) {
        const cashFailure = mapCashCreditError(error);
        if (cashFailure) { res.status(cashFailure.status).json(cashFailure); return false; }
        if (error?.code === 'CASH_CREDIT_UNAVAILABLE') { res.status(503).json({code:error.code,error:'Cash credit status temporarily unavailable.'}); return false; }
        res.status(403).json({
            error: error?.message || 'Driver is not eligible to accept paid work.',
            code: error?.code || 'PAYOUT_INELIGIBLE'
        });
        return false;
    }
}

/**
 * Batch 2C Phase B.1 — admin predicate for the booking mutation routes.
 * Fails closed: any lookup error means "not an admin".
 */
async function isAdminUser(userId: string | null): Promise<boolean> {
    if (!userId) return false;
    const { data, error } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle();
    if (error) {
        console.error('[BookingRoutes] admin lookup failed:', error);
        return false;
    }
    return String(data?.role || '') === 'admin';
}

/**
 * Batch 2C Phase B.1 — true when the authenticated user is a participant in the
 * job: its customer, its assigned driver, or the driver who confirmed it.
 */
function isJobParticipant(job: any, userId: string): boolean {
    const id = String(userId || '');
    if (!id) return false;
    return String(job?.customer_id || '') === id
        || String(job?.driver_id || '') === id
        || String(job?.accepted_driver_id || '') === id;
}

/**
 * Batch 2C Phase B.1 — resolve the caller for a booking mutation route.
 *
 * Returns the authenticated id, or null after writing the response, so callers
 * can `if (!userId) return;`. Never trusts a client-supplied identity.
 */
const BLOCKED_ACCOUNT_STATUSES = new Set(['suspended', 'banned', 'disabled', 'closed']);

async function requireAuthenticatedUser(req: Request, res: Response): Promise<string | null> {
    const userId = await getAuthUserId(req);
    if (!userId) {
        res.status(401).json({ error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });
        return null;
    }
    // Suspension enforcement: eligibility gates protect dispatch/acceptance,
    // but every other protected route previously trusted the JWT alone — a
    // suspended driver (or customer) kept access until token expiry. Check
    // the authoritative account_status on each call.
    const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('account_status')
        .eq('id', userId)
        .maybeSingle();
    if (profile && BLOCKED_ACCOUNT_STATUSES.has(String(profile.account_status || '').toLowerCase())) {
        res.status(403).json({ error: 'This account is not currently active.', code: 'ACCOUNT_SUSPENDED' });
        return null;
    }
    return userId;
}

/**
 * Batch 2C Phase B.1 — ownership fields a booking CREATE may never accept.
 *
 * A new booking belongs to its customer and to nobody else. Ownership is an
 * ACQUISITION performed later by a trusted server action or an ownership RPC, so
 * these keys are rejected outright (fail closed) rather than silently dropped.
 */
const BOOKING_OWNERSHIP_FIELDS = [
    'driver_id',
    'accepted_driver_id',
    'accepted_at',
    'assigned_at',
    'driver_assigned_at',
    'dispatch_started_at'
] as const;

/**
 * Batch 2C Phase B.1 — explicit allow-list of fields a client may create a
 * booking with.
 *
 * The route previously forwarded an arbitrary client object into `insert()`,
 * forcing only `customer_id`. Anything not listed here is dropped and logged, so
 * an unexpected key can never reach the insert statement. The list is the union
 * of the fields the shipping client sends
 * (`BookingService.createBooking` / `JobService.toJobsPayload`) and the fields
 * this route derives itself.
 */
const CREATABLE_BOOKING_FIELDS = new Set<string>([
    // identity / lifecycle (the route forces these itself)
    'customer_id', 'tenant_id', 'service_type_id', 'status', 'payment_status',
    'is_draft', 'expires_at', 'expired_at', 'expiry_reason', 'scheduled_time',
    'quote_id', 'agreed_fare', 'bid_mode_enabled', 'negotiation_mode_enabled',
    // geography
    'pickup_address', 'pickup_lat', 'pickup_lng',
    'dropoff_address', 'dropoff_lat', 'dropoff_lng',
    'country_code', 'currency_code', 'currency_symbol',
    // fare (the route overwrites these from the verified quote)
    'price', 'total_price', 'estimated_price', 'distance_km', 'estimated_distance_km',
    'distance_meters', 'duration_seconds', 'estimated_duration',
    'platform_fee', 'driver_payout', 'tax_amount',
    'surge_multiplier', 'dynamic_pricing_multiplier',
    'base_fare_used', 'price_per_km_used', 'commission_rate_used', 'pricing_plan_used',
    'regional_pricing_rule_id', 'fare_breakdown', 'marketplace_flags',
    // fulfilment category (customer-selected, server-validated)
    'fulfilment_category', 'fulfilment_subtype',
    // free-form
    'metadata'
]);

router.post('/create', bookingCreateLimiter, async (req: Request, res: Response) => {
    try {
        const userId = await getAuthUserId(req);
        if (!userId) return res.status(401).json({ error: 'Authentication required' });
        const payload = { ...(req.body?.booking || {}) } as Record<string, any>;
        if (payload.customer_id && String(payload.customer_id) !== userId) return res.status(403).json({ error: 'Cannot create a booking for another customer' });

        // Batch 2C Phase B.1: a create can never carry ownership. Presence of the
        // key is an attempt, even when the value is null or blank.
        const attemptedOwnership = BOOKING_OWNERSHIP_FIELDS.filter(field =>
            Object.prototype.hasOwnProperty.call(payload, field));
        if (attemptedOwnership.length) {
            console.warn('[BookingRoutes] booking create rejected ownership fields', { userId, fields: attemptedOwnership });
            return res.status(400).json({
                error: 'A new booking cannot be created with driver ownership fields.',
                code: 'OWNERSHIP_FIELD_NOT_ALLOWED',
                fields: attemptedOwnership
            });
        }
        // Open-debt gate: only when the market's cancellation policy is enabled
        // and sets a threshold — never blocks on unconfigured policy.
        try {
            const tenantId = String(payload.tenant_id || '').trim();
            const market = String(payload.country_code || payload.market_code || '').toUpperCase();
            if (tenantId && market) {
                const { data: policy } = await supabaseAdmin.rpc('active_cancellation_policy', { p_tenant: tenantId, p_market: market });
                const threshold = Number((policy as any)?.debt_threshold_minor || 0);
                if ((policy as any)?.enabled && threshold > 0) {
                    const { data: debt } = await supabaseAdmin.rpc('customer_open_debt_minor', { p_customer: userId });
                    if (Number(debt || 0) >= threshold) {
                        return res.status(409).json({
                            error: 'You have outstanding charges to resolve before booking.',
                            code: 'OUTSTANDING_DEBT',
                            debtMinor: Number(debt || 0)
                        });
                    }
                }
            }
        } catch (gateErr) {
            // A gate lookup failure must not silently allow or block — log and
            // continue; financial writes elsewhere remain authoritative.
            console.warn('[BookingRoutes] debt gate lookup failed:', (gateErr as Error)?.message);
        }
        const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
        const breakdown = payload.fare_breakdown && typeof payload.fare_breakdown === 'object' ? payload.fare_breakdown : {};
        const quoteReference = String(payload.quote_id || metadata.quote_id || breakdown.quoteId || '').trim();
        const quoteExpiresAt = String(metadata.quote_expires_at || breakdown.quoteExpiresAt || '').trim();
        const quoteVersion = String(breakdown.calculationVersion || breakdown.marketPricingVersion || '').trim();
        if (!quoteReference || !quoteVersion || !quoteExpiresAt || !Number.isFinite(Date.parse(quoteExpiresAt)) || Date.parse(quoteExpiresAt) <= Date.now()) return res.status(409).json({ error: 'A current versioned backend quote is required', code: 'QUOTE_EXPIRED' });
        const { data: existing } = await supabaseAdmin.from('jobs').select('*, service_type:service_types(*)').eq('quote_id', quoteReference).eq('customer_id', userId).maybeSingle();
        if (existing) {
            if (['expired','cancelled','canceled','failed','no_driver_found'].includes(String(existing.status))) return res.status(409).json({error:'This quote was already used by an ended booking. Get a new quote.',code:'QUOTE_ALREADY_USED'});
            return res.status(200).json(existing);
        }
        const { data: quoteAudit, error: quoteError } = await supabaseAdmin.from('quote_market_adjustments').select('quote_reference,country_code,market_city,zone_id,service_type,currency,returned_customer_fare,strategy_version,protected_fare_snapshot,fulfilment_snapshot').eq('quote_reference', quoteReference).maybeSingle();
        if (quoteError || !quoteAudit) return res.status(409).json({ error: 'Authoritative quote could not be verified', code: 'QUOTE_NOT_VERIFIED' });
        const requestedService = String(metadata.service_slug || metadata.service_type || '').trim().toLowerCase();
        const canonicalService = ['shop','shopping','errands'].includes(requestedService) ? 'errand' : ['deliver','courier','parcel'].includes(requestedService) ? 'delivery' : ['van','move','moving'].includes(requestedService) ? 'van-moving' : requestedService;
        if (canonicalService && canonicalService !== String(quoteAudit.service_type)) return res.status(409).json({ error: 'Quote service does not match booking', code: 'QUOTE_INPUT_CHANGED' });
        const quotedFare = Number(quoteAudit.returned_customer_fare);
        const submittedServiceFare = Number(breakdown.customerServiceTotal ?? payload.total_price ?? payload.price);
        if (!Number.isFinite(quotedFare) || !Number.isFinite(submittedServiceFare) || Math.abs(quotedFare - submittedServiceFare) > 0.01) return res.status(409).json({ error: 'Quoted fare changed; customer acceptance is required', code: 'QUOTE_INPUT_CHANGED' });
        if(quoteAudit.protected_fare_snapshot){
            // Preserve UI quote identifiers, but all financial terms and the subscription
            // commission marker come from the server audit, never the submitted form.
            payload.fare_breakdown={...breakdown,...quoteAudit.protected_fare_snapshot};
            payload.driver_payout=quoteAudit.protected_fare_snapshot.driverEntitlement;
            payload.platform_fee=quoteAudit.protected_fare_snapshot.platformFeeAmount;
            payload.commission_rate_used=quoteAudit.protected_fare_snapshot.commissionPercent;
            payload.pricing_plan_used='starter';
        }else if(breakdown.driverCommissionPolicy){
            const legacyBreakdown={...breakdown};delete legacyBreakdown.driverCommissionPolicy;
            payload.fare_breakdown=legacyBreakdown;
        }
        // Validate customer-selected fulfilment category; unknown historical rows stay null.
        const category = String(payload.fulfilment_category || '').trim().toLowerCase();
        const subtype = String(payload.fulfilment_subtype || '').trim().toLowerCase();
        if (category && !['bike', 'car', 'small_van'].includes(category)) {
            return res.status(400).json({ error: 'Unrecognised fulfilment category.', code: 'INVALID_FULFILMENT_CATEGORY' });
        }
        if (category === 'bike' && subtype && !['pedal_bicycle', 'e_bike', 'motorcycle', 'moped'].includes(subtype)) {
            return res.status(400).json({ error: 'Unrecognised bike subtype.', code: 'INVALID_BIKE_SUBTYPE' });
        }

        // Quote snapshot is the source of truth for fulfilment. Customer fields must match it.
        const quoteSnapshot = quoteAudit?.fulfilment_snapshot || null;
        if (category === 'bike') {
            if (!quoteSnapshot) {
                return res.status(409).json({ error: 'This quote does not include a bike fulfilment snapshot. Please get a new quote.', code: 'QUOTE_FULFILMENT_NOT_FROZEN' });
            }
            if (String(quoteSnapshot.category || '').toLowerCase() !== category) {
                return res.status(409).json({ error: 'Fulfilment category does not match the quote. Please get a new quote.', code: 'QUOTE_FULFILMENT_MISMATCH' });
            }
            if (String(quoteSnapshot.service_type || '').toLowerCase() !== canonicalService) {
                return res.status(409).json({ error: 'Quote service does not match booking.', code: 'QUOTE_INPUT_CHANGED' });
            }
            const packageSize = String(payload.metadata?.package_size || '').trim().toLowerCase();
            if (packageSize && packageSize !== String(quoteSnapshot.package_size || '').toLowerCase()) {
                return res.status(409).json({ error: 'Package size does not match the quote. Please get a new quote.', code: 'QUOTE_PACKAGE_SIZE_CHANGED' });
            }
            if (!quoteSnapshot.bike_limits) {
                return res.status(409).json({ error: 'Bike deliveries are not configured for this market.', code: 'BIKE_LIMITS_NOT_CONFIGURED' });
            }
            if (quoteSnapshot.bike_available === false) {
                return res.status(409).json({ error: String(quoteSnapshot.bike_unavailable_reason || 'No bike courier is available for this parcel size.'), code: 'BIKE_UNAVAILABLE' });
            }
            const allowed = Array.isArray(quoteSnapshot.allowed_subtypes) ? quoteSnapshot.allowed_subtypes : [];
            if (subtype && !allowed.includes(subtype)) {
                return res.status(409).json({ error: 'Selected bike subtype is not available for this quote.', code: 'BIKE_SUBTYPE_NOT_AVAILABLE' });
            }
        }

        payload.fulfilment_snapshot = quoteSnapshot;
        payload.price = quotedFare; payload.total_price = quotedFare; payload.estimated_price = quotedFare;
        payload.country_code = quoteAudit.country_code || payload.country_code;
        payload.currency_code = quoteAudit.currency || payload.currency_code;
        await MarketAvailabilityService.requireCapability({ countryCode: payload.country_code || metadata.country_code,
            marketCity: payload.market_city || metadata.market_city || metadata.pickup_city, zoneId: payload.zone_id || metadata.zone_id,
            capability: 'booking', endpoint: '/api/booking/create' });
        payload.customer_id = userId;
        // Batch 2C Phase B.1: build the insert payload from the allow-list only,
        // so no unlisted client key can reach the insert statement.
        const insertPayload: Record<string, unknown> = {};
        const droppedFields: string[] = [];
        for (const [key, value] of Object.entries(payload)) {
            if (CREATABLE_BOOKING_FIELDS.has(key)) insertPayload[key] = value;
            else droppedFields.push(key);
        }
        if (droppedFields.length) {
            console.warn('[BookingRoutes] booking create dropped non-creatable fields', { userId, droppedFields });
        }
        insertPayload.fulfilment_snapshot = quoteSnapshot;
        // Freeze any applied campaign discount into the fare snapshot. The
        // claim must match a server-side application for this quote+customer;
        // platform-funded discounts reduce the platform share only, never the
        // agreed driver earnings.
        const claimedDiscount = Number(metadata.discount_minor || breakdown.discountMinor || 0);
        if (claimedDiscount > 0) {
            const { data: applied } = await supabaseAdmin
                .from('campaign_discount_applications')
                .select('id,discount_minor,campaign_id,status')
                .eq('customer_id', userId)
                .eq('quote_reference', quoteReference)
                .eq('status', 'applied')
                .maybeSingle();
            if (!applied || Number(applied.discount_minor) !== claimedDiscount) {
                return res.status(409).json({ error: 'The claimed discount does not match a valid application for this quote.', code: 'DISCOUNT_MISMATCH' });
            }
            insertPayload.metadata = { ...(insertPayload.metadata as Record<string, unknown> || {}), discount_minor: claimedDiscount, campaign_id: applied.campaign_id, discount_source: 'campaign', platform_funded: true };
            await supabaseAdmin
                .from('campaign_discount_applications')
                .update({ status: 'consumed' })
                .eq('id', applied.id);
        }
        insertPayload.customer_id = userId;
        // C2: negotiation/bidding modes, draft/expiry and agreed_fare are
        // server-derived from the authoritative marketplace configuration and
        // never trusted from the client. Resolver failure fails closed to direct
        // checkout.
        try {
            const modes = await MarketplaceConfigService.determineJobModes(canonicalService);
            insertPayload.negotiation_mode_enabled = modes.negotiation;
            insertPayload.bid_mode_enabled = modes.bidding;
            insertPayload.status = modes.negotiation ? 'pending_fare_confirmation' : 'requested';
            insertPayload.is_draft = modes.negotiation;
            insertPayload.expires_at = modes.negotiation ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;
        } catch (modeError) {
            console.error('[BookingRoutes] marketplace mode resolution failed; failing closed to direct checkout:', modeError);
            insertPayload.negotiation_mode_enabled = false;
            insertPayload.bid_mode_enabled = false;
            insertPayload.status = 'requested';
            insertPayload.is_draft = false;
            insertPayload.expires_at = null;
        }
        insertPayload.agreed_fare = null;
        // Authoritative customer no-show disclosure: enabled server-side, computed
        // from the AUTHORITATIVE quoted fare, never a client-supplied version/fee.
        // Direct-checkout UK/GBP rides require explicit acknowledgement; the
        // disclosed snapshot is persisted so later config changes cannot alter it.
        const noShowConfig = await NoShowService.getEnabledConfig();
        const isRide = canonicalService === 'ride';
        const isUkGbp = String(payload.country_code || quoteAudit.country_code || '').toUpperCase() === 'GB'
            && String(payload.currency_code || quoteAudit.currency || '').toUpperCase() === 'GBP';
        const isDirectCheckout = insertPayload.status !== 'pending_fare_confirmation';

        if (noShowConfig.noShowEnabled && isRide && isUkGbp && isDirectCheckout) {
            if (metadata.no_show_acknowledged !== true || metadata.no_show_policy_version !== 'ride-no-show-v2') {
                return res.status(409).json({
                    error: 'The no-show policy must be acknowledged before booking.',
                    code: 'NO_SHOW_ACKNOWLEDGEMENT_REQUIRED'
                });
            }
            const noShow = NoShowService.computeCurrentNoShowSplit(
                Math.round(quotedFare * 100),
                String(payload.currency_code || quoteAudit.currency || 'GBP')
            );
            const existingBreakdown = (insertPayload.fare_breakdown && typeof insertPayload.fare_breakdown === 'object')
                ? insertPayload.fare_breakdown
                : {};
            insertPayload.fare_breakdown = {
                ...existingBreakdown,
                noShowPolicyVersion: noShow.policyVersion,
                noShowFeeMinor: noShow.feeMinor,
                noShowDriverShareMinor: noShow.driverShareMinor,
                noShowPlatformShareMinor: noShow.platformShareMinor
            };
        }
        // C2 final-release closure: the client is NEVER authoritative for payment
        // state or monetary breakdown. A fresh booking always starts 'pending';
        // a forged payment_status='paid' (or a client commission/payout snapshot)
        // must never reach the insert.
        insertPayload.payment_status = 'pending';
        insertPayload.commission_rate_used = null;
        insertPayload.platform_fee = null;
        insertPayload.driver_payout = null;
        insertPayload.tax_amount = null;
        // Snapshot server policy; client metadata cannot disable verification.
        const pinPolicy = await MarketplaceConfigService.getRawSetting('completion_pin_policy',
            typeof insertPayload.tenant_id === 'string' ? insertPayload.tenant_id : null);
        const pinRequired = !(pinPolicy && typeof pinPolicy === 'object' &&
            'enabled' in pinPolicy && pinPolicy.enabled === false);
        const safeMetadata = { ...(insertPayload.metadata as Record<string, unknown> || {}) };
        delete safeMetadata.completion_pin;
        delete safeMetadata.service_completion_pin;
        delete safeMetadata.delivery_pin;
        insertPayload.metadata = { ...safeMetadata, completion_pin_required: pinRequired,
            completion_pin_policy_version: 'backend-v1' };
        // Reward-credit claim rides INSIDE the job insert via metadata —
        // the reserve_job_reward_credit trigger calls apply_reward_credit in
        // the same transaction, so a failed reservation rolls back the
        // booking (no orphan, no dispatchable-without-credit state). The
        // eligible payable is derived server-side: customerCharge minus any
        // platform-funded discount; the spend can never exceed what remains
        // payable electronically.
        const claimedCredit = String(metadata.reward_credit_id || '').trim();
        if (claimedCredit) {
            insertPayload.metadata = { ...(insertPayload.metadata as Record<string, unknown> || {}), reward_credit_id: claimedCredit };
        }

        const { data, error } = await supabaseAdmin.from('jobs').insert(insertPayload).select('*, service_type:service_types(*)').single();
        if (error) {
            const msg = String(error.message || '');
            const code = msg.includes('credit_expired') ? 'CREDIT_EXPIRED'
                : msg.includes('credit_exhausted') ? 'CREDIT_EXHAUSTED'
                : msg.includes('mismatch') ? 'CREDIT_SCOPE_MISMATCH'
                : msg.includes('credit_not_active') ? 'CREDIT_NOT_ACTIVE' : undefined;
            return res.status(code ? 409 : 400).json({ error: msg, code: code || error.code });
        }

        // Release closure: mint the completion PIN SERVER-side and store it in the
        // customer-only secret table (never in jobs.metadata). The PIN is returned
        // to the customer here; the driver has no read path to it.
        const completionPin = pinRequired ? String(1000 + Math.floor(Math.random() * 9000)) : null;
        if (pinRequired) {
        const { error: secretError } = await supabaseAdmin.from('job_completion_secrets').insert({
            job_id: data.id,
            completion_pin: completionPin
        });
        if (secretError) {
            console.error('[BookingRoutes] failed to store completion secret:', secretError);
            return res.status(500).json({ error: 'Failed to store booking completion secret' });
        }

        }
        return res.status(201).json({ ...data, completion_pin: completionPin });
    } catch (error) {
        if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Booking creation failed' });
    }
});

function normalise(value: unknown): string {
    return String(value || '').toLowerCase().trim();
}

async function getJob(jobId: string) {
    const { data, error } = await supabaseAdmin
        .from('jobs')
        .select('*, service_type:service_types(slug)')
        .eq('id', jobId)
        .single();

    if (error || !data) {
        throw new Error('Job not found');
    }

    return data;
}

async function refreshDriverRating(driverId: string | null | undefined) {
    if (!driverId) return null;

    const { data: ratings, error } = await supabaseAdmin
        .from('ratings')
        .select('score')
        .eq('driver_id', driverId);

    if (error) {
        console.error('[BookingRoutes] rating aggregate failed:', error);
        return null;
    }

    const scores = (ratings || [])
        .map((row: any) => Number(row.score))
        .filter((score: number) => Number.isFinite(score) && score >= 1 && score <= 5);

    if (!scores.length) return null;

    const average = Math.round((scores.reduce((sum: number, score: number) => sum + score, 0) / scores.length) * 10) / 10;
    const updatedAt = new Date().toISOString();
    const payloads: Record<string, unknown>[] = [
        { rating: average, driver_rating: average, review_count: scores.length, updated_at: updatedAt },
        { rating: average, driver_rating: average, updated_at: updatedAt },
        { rating: average, review_count: scores.length, updated_at: updatedAt },
        { rating: average, updated_at: updatedAt },
        { driver_rating: average, updated_at: updatedAt }
    ];

    for (const payload of payloads) {
        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update(payload)
            .eq('id', driverId);

        if (!updateError) {
            return { average, count: scores.length };
        }

        if (updateError.code !== '42703') {
            console.error('[BookingRoutes] driver rating update failed:', updateError);
            return null;
        }
    }

    return null;
}

/**
 * Batch 2B (N12) — detect ONLY the single-active-job invariant violation.
 *
 * Deliberately narrow. `MB001` is the dedicated SQLSTATE raised by the
 * acquisition RPCs for "driver already has an active job", and it is used for
 * nothing else. A raw `23505` is accepted only when the message or details name
 * the invariant index, so an unrelated unique violation (or the Batch 2A
 * "job already owned by another driver" 23505) can never be reported as
 * "driver busy".
 */
function isDriverBusyViolation(error: unknown): boolean {
    const candidate = error as { code?: string; message?: string; details?: string } | null;

    if (!candidate) return false;
    if (candidate.code === 'MB001') return true;
    if (candidate.code !== '23505') return false;

    const text = `${candidate.message ?? ''} ${candidate.details ?? ''}`;
    return text.includes('idx_jobs_one_active_per_driver');
}

async function getDriverVehicle(driverId: string) {
    const { data, error } = await supabaseAdmin
        .from('vehicles')
        .select('*')
        .eq('user_id', driverId)
        .maybeSingle();

    if (error) {
        console.error('[BookingRoutes] vehicle lookup failed:', error);
        return null;
    }

    return data;
}

function parseMetadata(value: unknown): Record<string, any> {
    if (!value) return {};
    if (typeof value === 'object') return value as Record<string, any>;

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    return {};
}

function requiredVehicleClass(job: any): 'bike' | 'standard' | 'xl' | 'car' | 'small_van' | 'large_van' | 'minibus' {
    const persisted = normalise(job?.fulfilment_category || '');
    if (['bike', 'car', 'small_van', 'large_van', 'minibus', 'standard', 'xl'].includes(persisted)) {
        if (persisted === 'bike') return 'bike';
        if (persisted === 'car') return 'car';
        if (persisted === 'small_van') return 'small_van';
        if (persisted === 'large_van') return 'large_van';
        if (persisted === 'minibus') return 'minibus';
        if (persisted === 'standard') return 'standard';
        if (persisted === 'xl') return 'xl';
    }

    const metadata = parseMetadata(job?.metadata);
    const serviceSlug = normalise(job?.service_slug || job?.service_type?.slug);
    const raw = normalise(
        metadata.service_vehicle_class ||
        metadata.vehicle_class ||
        metadata.vehicleClass ||
        metadata.ride_details?.vehicle_class ||
        metadata.delivery_details?.vehicleClass ||
        metadata.errand_details?.vehicleClass
    );

    if (raw.includes('bike') || raw.includes('motorcycle') || raw.includes('scooter')) return 'bike';
    if (raw.includes('minibus') || raw.includes('7 seater') || raw.includes('7-seater')) return 'minibus';
    if (raw.includes('xl') || raw.includes('7')) return 'xl';
    if (raw.includes('large_van') || raw.includes('large van') || raw.includes('luton')) return 'large_van';
    if (raw.includes('small_van') || raw.includes('small van') || raw.includes('van')) return 'small_van';
    if (raw.includes('standard')) return 'standard';
    if (raw.includes('car')) return 'car';
    if (serviceSlug.includes('van') || serviceSlug.includes('moving')) return 'small_van';
    if (serviceSlug.includes('delivery') || serviceSlug.includes('errand')) return 'car';
    return 'standard';
}

function driverCapabilities(vehicle: any): string[] {
    if (!vehicle) return [];

    const combined = normalise(`${vehicle.type || ''} ${vehicle.capacity || ''} ${vehicle.service_class || ''}`);

    if (combined.includes('bike') || combined.includes('motorcycle') || combined.includes('scooter')) return ['bike'];
    if (combined.includes('minibus') || combined.includes('7 seater') || combined.includes('7-seater') || combined.includes('xl') || combined.includes('7')) return ['standard', 'xl', 'minibus', 'car'];
    if (combined.includes('large_van') || combined.includes('large van') || combined.includes('luton')) return ['standard', 'xl', 'car', 'small_van', 'large_van'];
    if (combined.includes('small_van') || combined.includes('small van') || combined.includes('van')) return ['standard', 'car', 'small_van'];
    return ['standard', 'car'];
}

function bikeSubtypeFromVehicle(vehicle: any): string | null {
    if (!vehicle) return null;
    const sub = normalise(String(vehicle.vehicle_subtype || ''));
    if (sub) return sub;
    const type = normalise(`${vehicle.type || ''} ${vehicle.capacity || ''} ${vehicle.service_class || ''}`);
    if (type.includes('pedal_bicycle') || type.includes('pedal bicycle')) return 'pedal_bicycle';
    if (type.includes('e_bike') || type.includes('e-bike') || type.includes('electric bike')) return 'e_bike';
    if (type.includes('motorcycle')) return 'motorcycle';
    if (type.includes('moped')) return 'moped';
    if (type.includes('bike') && !type.includes('motor')) return 'pedal_bicycle';
    return null;
}

function bikeSubtypeCompatible(job: any, vehicle: any): boolean {
    const requiredSubtype = normalise(String(job?.fulfilment_subtype || ''));
    if (!requiredSubtype) return true;

    const actualSubtype = bikeSubtypeFromVehicle(vehicle);
    if (!actualSubtype) return false;

    if (requiredSubtype === actualSubtype) return true;

    const compatible = {
        'pedal_bicycle': ['pedal_bicycle'],
        'e_bike': ['e_bike'],
        'motorcycle': ['motorcycle', 'moped'],
        'moped': ['moped', 'motorcycle']
    } as Record<string, string[]>;

    return (compatible[requiredSubtype] || []).includes(actualSubtype);
}

function vehicleLabel(value: string): string {
    switch (value) {
        case 'bike':
            return 'Bike';
        case 'xl':
            return 'XL car';
        case 'minibus':
            return '7 seater';
        case 'small_van':
            return 'Small van';
        case 'large_van':
            return 'Large van';
        case 'car':
        case 'standard':
            return 'Car';
        default:
            return 'Vehicle';
    }
}

async function captureJobPaymentOnlyWhenCompleted(jobId: string) {
    const job = await getJob(jobId);

    if (job.status !== 'completed') {
        throw new Error('Cannot capture payment: job not completed');
    }

    if (job.payment_method !== 'card' || !job.payment_intent_id) {
        await supabaseAdmin
            .from('jobs')
            .update({ payment_status: job.payment_status || 'paid' })
            .eq('id', jobId);

        return null;
    }

    if (capturedStatuses.includes(normalise(job.payment_status))) {
        return null;
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(job.payment_intent_id);

    if (paymentIntent.status === 'succeeded') {
        await supabaseAdmin
            .from('jobs')
            .update({ payment_status: 'paid' })
            .eq('id', jobId);

        return paymentIntent;
    }

    if (paymentIntent.status !== 'requires_capture') {
        throw new Error(`Cannot capture payment in Stripe status: ${paymentIntent.status}`);
    }

    const captured = await stripe.paymentIntents.capture(job.payment_intent_id);

    await supabaseAdmin
        .from('jobs')
        .update({ payment_status: 'paid' })
        .eq('id', jobId);

    return captured;
}

async function releaseWalletReservation(jobId: string, reason: string) {
    const { error } = await supabaseAdmin.rpc('release_job_wallet_reservation', {
        p_job_id: jobId,
        p_reason: reason
    });

    if (error) {
        console.error(`[BookingRoutes] Wallet release failed for ${jobId}:`, error);
        await supabaseAdmin
            .from('jobs')
            .update({ payment_status: 'requires_review' })
            .eq('id', jobId);
    }
}

async function hasProtectedErrandSpend(jobId: string): Promise<boolean> {
    const [{ data: details }, { data: spendControl }] = await Promise.all([
        supabaseAdmin
            .from('errand_details')
            .select('actual_spending, receipt_url')
            .eq('job_id', jobId)
            .maybeSingle(),
        supabaseAdmin
            .from('job_issuing_spend_controls')
            .select('amount_authorized, amount_captured, status')
            .eq('job_id', jobId)
            .maybeSingle()
    ]);

    return Number((details as any)?.actual_spending || 0) > 0 ||
        !!(details as any)?.receipt_url ||
        Number((spendControl as any)?.amount_authorized || 0) > 0 ||
        Number((spendControl as any)?.amount_captured || 0) > 0;
}

async function logJobEvent(jobId: string, eventType: string, actorId: string | null, notes: string, metadata: Record<string, unknown>) {
    const { error } = await supabaseAdmin
        .from('job_events')
        .insert({
            job_id: jobId,
            event_type: eventType,
            actor_id: actorId,
            actor_role: actorId ? 'driver' : 'system',
            notes,
            metadata
        });

    if (error) {
        console.warn('[BookingRoutes] failed to log job event:', error);
    }
}

/**
 * Accept/assign a job.
 * Payment is NOT captured here.
 *
 * Batch 2C Phase B (ownership hardening): this route used to take `driverId`
 * straight from the request body and perform NO authentication at all, so any
 * caller could assign an arbitrary driver — or themselves — to any acceptable
 * job. The driver is now derived from the authenticated session and the body can
 * no longer name one.
 */
router.post('/accept', async (req: Request, res: Response) => {
    try {
        const { jobId } = req.body;

        const driverId = await getAuthUserId(req);
        if (!driverId) {
            return res.status(401).json({ error: 'Authentication required.' });
        }

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }
        if (req.body?.driverId && String(req.body.driverId) !== driverId) {
            return res.status(403).json({
                error: 'A job can only be accepted for the authenticated driver.',
                code: 'DRIVER_IDENTITY_MISMATCH'
            });
        }

        const job = await getJob(jobId);
        const vehicle = await getDriverVehicle(driverId);
        const required = requiredVehicleClass(job);
        const capabilities = driverCapabilities(vehicle);

        if (!matchesVehicleCapacity(job.service_type?.slug || job.service_slug, required, capabilities)) {
            return res.status(400).json({
                error: `This request needs ${vehicleLabel(required)}. Please update your saved vehicle before accepting.`,
                code: 'VEHICLE_CLASS_MISMATCH'
            });
        }

        if (required === 'bike' && !bikeSubtypeCompatible(job, vehicle)) {
            return res.status(400).json({
                error: 'This bike job requires a different courier vehicle type.',
                code: 'BIKE_SUBTYPE_MISMATCH'
            });
        }

        // Preserve payout checks; only an approved, enabled cash-Ride cohort uses internal credit.
        if (!(await requirePayoutEligible(driverId, res, job))) return;

        if (!LogisticsService.isValidBookingTransition(job.status, 'accepted')) {
            return res.status(400).json({
                error: `Invalid transition from ${job.status} to accepted`
            });
        }

        const { data: assigned, error: rpcError } = await supabaseAdmin.rpc('assign_driver_to_job', {
            p_job_id: jobId,
            p_driver_id: driverId
        });

        if (rpcError || !assigned) {
            // Batch 2C Phase B: MB002 (compliance) and MB001 (busy) are mapped
            // explicitly; everything else keeps the pre-existing generic failure
            // and is NEVER reported as a success.
            const acquisitionFailure = mapDriverAcquisitionError(rpcError);
            if (acquisitionFailure) {
                return res.status(acquisitionFailure.status).json({
                    error: acquisitionFailure.error,
                    code: acquisitionFailure.code,
                    ...(acquisitionFailure.blocking ? { blocking: acquisitionFailure.blocking } : {})
                });
            }
            return res.status(400).json({
                error: 'Failed to accept job. It may have been taken or cancelled.'
            });
        }
        try { await supabaseAdmin.rpc('close_driver_offer', { p_job: jobId, p_driver: driverId, p_event: 'accepted' }); } catch { /* event recording must not break acceptance */ }

        let paymentStatus = job.payment_status || 'pending';

        if (job.payment_method === 'card' && job.payment_intent_id) {
            try {
                const pi = await stripe.paymentIntents.retrieve(job.payment_intent_id);
                paymentStatus = pi.status === 'requires_capture' ? 'authorized' : paymentStatus;
            } catch {
                paymentStatus = job.payment_status || 'pending';
            }
        }

        await supabaseAdmin
            .from('jobs')
            .update({ payment_status: paymentStatus })
            .eq('id', jobId);

        if (job.customer_id) {
            await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'assigned');
        }

        return res.json({
            success: true,
            message: 'Job assigned. Payment remains authorized until completion.'
        });
    } catch (error: any) {
        console.error('Accept job error:', error);
        return res.status(500).json({ error: error.message || 'Failed to accept job' });
    }
});

/**
 * Server-authoritative arrival (ride pickup). Records an immutable server
 * timestamp + grace deadline. Repeated arrival never resets the timer.
 */
router.post('/arrive', async (req: Request, res: Response) => {
    try {
        if (!(await NoShowService.getEnabledConfig()).noShowEnabled) {
            // Explicit, machine-readable disabled signal. Clients must NOT treat a
            // bare 404 (wrong route, proxy, typo) as "feature disabled".
            return res.status(404).json({ error: 'Not found', code: 'NO_SHOW_DISABLED' });
        }

        const driverId = await requireAuthenticatedUser(req, res);
        if (!driverId) return;
        const { jobId, lat, lng, measuredAt } = req.body || {};

        if (!jobId) return res.status(400).json({ error: 'jobId required' });

        const job = await getJob(jobId);
        if (String(job.driver_id || '') !== driverId) {
            return res.status(403).json({ error: 'Only the assigned driver can mark arrival.', code: 'NOT_ASSIGNED_DRIVER' });
        }

        // UK/GBP ride pickup only.
        if (!NoShowService.isSupported(job.country_code, job.currency_code)) {
            return res.status(400).json({ error: 'No-show arrival is not supported for this booking.', code: 'NO_SHOW_SCOPE_UNSUPPORTED' });
        }
        if (!['ride', 'delivery'].includes(String(job.service_type?.slug || job.service_slug || '').toLowerCase())) {
            return res.status(400).json({ error: 'No-show arrival is ride-pickup only.', code: 'NO_SHOW_SCOPE_UNSUPPORTED' });
        }

        // Location measurement freshness. Server now() is NOT location freshness:
        // the client must timestamp its measurement and we reject stale or future
        // evidence. Client coordinates/timestamps remain SPOOFABLE supporting
        // evidence, not proof — the server arrival timestamp is the authority.
        const measuredMs = Date.parse(String(measuredAt || ''));
        const nowMs = Date.now();
        if (!Number.isFinite(measuredMs)
            || (nowMs - measuredMs) > NO_SHOW_ARRIVAL_MAX_LOCATION_AGE_MS
            || measuredMs > nowMs + 60_000) {
            return res.status(400).json({ error: 'Location measurement is stale or invalid.', code: 'ARRIVAL_LOCATION_STALE' });
        }

        // Conservative proximity default: the driver must be within 200m of the
        // server-known pickup.
        const distanceKm = LogisticsService.calculateDistance(
            Number(lat), Number(lng),
            Number(job.pickup_lat), Number(job.pickup_lng)
        );
        if (!Number.isFinite(distanceKm) || distanceKm > (NO_SHOW_ARRIVAL_MAX_DISTANCE_M / 1000)) {
            return res.status(400).json({ error: 'Driver location is not near the pickup.', code: 'ARRIVAL_LOCATION_INVALID' });
        }

        const arrived = await NoShowService.recordArrival(String(jobId), driverId, job.fare_breakdown);
        if (!arrived) {
            return res.status(400).json({ error: 'Arrival is not allowed in the current booking state.', code: 'ARRIVAL_INVALID_STATE' });
        }

        if (job.customer_id) {
            await NotificationService.notifyJobStatusUpdate(job.customer_id, String(jobId), 'driver_arrived');
        }

        // Surface the frozen, server-computed no-show terms so the driver UI shows
        // the authoritative fee and compensation (never re-derived client-side).
        const noShowTerms = NoShowService.splitFromBreakdown(job.fare_breakdown);

        return res.json({
            success: true,
            arrived_at: arrived.no_show_arrived_at,
            grace_until: arrived.no_show_grace_until,
            no_show: noShowTerms ? {
                policyVersion: noShowTerms.policyVersion,
                feeMinor: noShowTerms.feeMinor,
                driverShareMinor: noShowTerms.driverShareMinor,
                platformShareMinor: noShowTerms.platformShareMinor,
                currency: noShowTerms.currency,
                graceSeconds: NoShowService.graceMinutesFor(job.fare_breakdown) * 60
            } : null
        });
    } catch (error: any) {
        console.error('[BookingRoutes] arrive error:', error);
        return res.status(500).json({ error: error.message || 'Failed to mark arrival' });
    }
});

/**
 * Customer no-show finalise (ride pickup). Server-verified grace expiry, then a
 * terminal cancellation + money movement via NoShowService.
 */
router.post('/no-show', async (req: Request, res: Response) => {
    try {
        if (!(await NoShowService.getEnabledConfig()).noShowEnabled) {
            return res.status(404).json({ error: 'Not found', code: 'NO_SHOW_DISABLED' });
        }

        const driverId = await requireAuthenticatedUser(req, res);
        if (!driverId) return;
        const { jobId, reason, contactAttempted, confirmed } = req.body || {};

        if (!jobId) return res.status(400).json({ error: 'jobId required' });
        if (!reason || String(reason).trim().length < 3) return res.status(400).json({ error: 'A cancellation reason is required.' });
        if (confirmed !== true) return res.status(400).json({ error: 'Driver must confirm the no-show.', code: 'NO_SHOW_CONFIRMATION_REQUIRED' });

        const job = await getJob(jobId);
        if (String(job.driver_id || '') !== driverId) {
            return res.status(403).json({ error: 'Only the assigned driver can mark a no-show.', code: 'NOT_ASSIGNED_DRIVER' });
        }

        const finalized = await NoShowService.finalizeNoShow(String(jobId), driverId, String(reason), Boolean(contactAttempted));

        return res.json({ success: true, no_show_status: finalized.no_show_status });
    } catch (error: any) {
        console.error('[BookingRoutes] no-show error:', error);
        const status = /eligible/i.test(error.message) ? 400 : 500;
        return res.status(status).json({ error: error.message || 'Failed to finalise no-show' });
    }
});

/**
 * Complete a job.
 * Status is marked completed first, then payment capture is allowed.
 */
router.post('/complete', async (req: Request, res: Response) => {
    try {
        const { jobId, completionPin } = req.body || {};

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }

        // Completion moves money. Authenticate first and derive the driver from
        // the token: driverId supplied in the request body is never trusted.
        const authUserId = await getAuthUserId(req);

        if (!authUserId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const job = await getJob(jobId);
        const assignedDriverId = job.driver_id || job.accepted_driver_id;

        if (!assignedDriverId || String(assignedDriverId) !== authUserId) {
            return res.status(403).json({ error: 'Only the assigned driver can complete this request' });
        }

        // Delegate to the canonical completion path so ownership, completion PIN,
        // Stripe capture, driver transfer and earnings stay in one place.
        const wasAlreadyCompleted = String(job.status || '').toLowerCase() === 'completed';
        const completed = await LogisticsService.completeJob(jobId, completionPin || null, authUserId);

        // Only announce the transition. An idempotent repeat of an already-completed
        // job (or a resume) must not re-notify the customer and driver.
        if (!wasAlreadyCompleted) {
            if (job.customer_id) {
                await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'completed');
            }

            await NotificationService.notifyJobStatusUpdate(String(assignedDriverId), jobId, 'completed');
        }

        return res.json({
            success: true,
            message: 'Job completed and payment captured.',
            data: completed
        });
    } catch (error: any) {
        console.error('Complete job error:', error);
        const message = String(error?.message || 'Failed to complete job');
        const status = /only the assigned driver/i.test(message)
            ? 403
            : /pin|required|incorrect/i.test(message)
                ? 400
                : /capture|transfer/i.test(message)
                    ? 402
                    : 500;
        return res.status(status).json({ error: message });
    }
});

/**
 * Cancel booking.
 * If payment has not been captured, cancel the authorization.
 * If driver was assigned and cancellation fee exists, capture only that fee.
 */
router.post('/cancel', async (req: Request, res: Response) => {
    try {
        // Batch 2C Phase B.1: this route was unauthenticated, so anyone who knew
        // a job id could cancel somebody else's booking.
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { jobId, reason } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }

        const job = await getJob(jobId);

        // Only a participant (customer or assigned driver) or an admin may cancel.
        if (!isJobParticipant(job, userId) && !(await isAdminUser(userId))) {
            return res.status(403).json({ error: 'You cannot cancel this booking.', code: 'NOT_A_PARTICIPANT' });
        }
        if (req.body?.customerId && String(req.body.customerId) !== String(job.customer_id || '')) {
            return res.status(403).json({ error: 'Customer identity mismatch.', code: 'IDENTITY_MISMATCH' });
        }

        if (!['cancelled', 'canceled'].includes(String(job.status)) && !LogisticsService.isValidBookingTransition(job.status, 'cancelled')) {
            return res.status(400).json({
                error: `Cannot cancel job in status: ${job.status}`
            });
        }

        const paymentStatus = normalise(job.payment_status);

        if (capturedStatuses.includes(paymentStatus)) {
            return res.status(409).json({
                error: 'This booking already has captured payment. Refund/admin review is required.'
            });
        }

        const { data: cancelled, error: rpcError } = await supabaseAdmin.rpc('cancel_job_safely', {
            p_job_id: jobId,
            p_reason: reason || 'User cancelled'
        });

        if (rpcError || !cancelled) {
            if (rpcError) {
                console.error('[BookingRoutes] cancel_job_safely failed:', rpcError);
            }

            return res.status(400).json({
                error: rpcError?.message || 'Failed to cancel job. It may have already been completed or cancelled.'
            });
        }

        if (job.customer_id) {
            await FraudService.trackCancellation(job.customer_id);
        }

        // A cancellation fee that could not be charged through the payment
        // intent (cash jobs, no intent, or authorisation already released)
        // becomes an explicit receivable — never faked as payment success.
        // Idempotent per (job, reason); duplicate cancels reuse the row.
        try {
            const feeMajor = Number(job.cancellation_fee || 0);
            const canChargeCard = job.payment_method === 'card' && job.payment_intent_id;
            if (feeMajor > 0 && job.customer_id && !canChargeCard) {
                const { data: policy } = await supabaseAdmin.rpc('active_cancellation_policy', {
                    p_tenant: job.tenant_id, p_market: String(job.country_code || '')
                });
                await supabaseAdmin.rpc('record_customer_receivable', {
                    p_tenant: job.tenant_id, p_customer: job.customer_id, p_job: jobId,
                    p_currency: String(job.currency_code || 'GBP').toUpperCase(),
                    p_amount: Math.round(feeMajor * 100), p_reason: 'cancellation_fee',
                    p_policy_version: (policy as any)?.version ?? null
                });
            }
        } catch (debtErr) {
            console.warn('[BookingRoutes] receivable recording failed (cancel still succeeded):', (debtErr as Error)?.message);
        }

        if (job.payment_method === 'card' && job.payment_intent_id) {
            try {
                const pi = await stripe.paymentIntents.retrieve(job.payment_intent_id);

                if (pi.status === 'succeeded') {
                    await supabaseAdmin
                        .from('jobs')
                        .update({ payment_status: 'requires_refund' })
                        .eq('id', jobId);
                } else if (pi.status === 'requires_capture') {
                    const driverAssigned = !!job.driver_id;
                    const cancellationFeeMajor = Number(job.cancellation_fee || 0);
                    const totalMajor = Number(job.price || job.total_price || 0);
                    const amountToCapture = Math.min(
                        Math.round(cancellationFeeMajor * 100),
                        Math.round(totalMajor * 100)
                    );

                    if (driverAssigned && amountToCapture > 0) {
                        await stripe.paymentIntents.capture(job.payment_intent_id, {
                            amount_to_capture: amountToCapture
                        });

                        await supabaseAdmin
                            .from('jobs')
                            .update({ payment_status: 'paid' })
                            .eq('id', jobId);
                    } else {
                        await stripe.paymentIntents.cancel(job.payment_intent_id);

                        await supabaseAdmin
                            .from('jobs')
                            .update({ payment_status: 'cancelled' })
                            .eq('id', jobId);
                    }
                } else if (cancellableStripeStatuses.includes(pi.status)) {
                    await stripe.paymentIntents.cancel(job.payment_intent_id);

                    await supabaseAdmin
                        .from('jobs')
                        .update({ payment_status: 'cancelled' })
                        .eq('id', jobId);
                } else {
                    await supabaseAdmin
                        .from('jobs')
                        .update({ payment_status: pi.status === 'canceled' ? 'cancelled' : 'requires_review' })
                        .eq('id', jobId);
                }
            } catch (stripeError: any) {
                console.error('Stripe cancel/capture error:', stripeError);

                await supabaseAdmin
                    .from('jobs')
                    .update({ payment_status: 'requires_review' })
                    .eq('id', jobId);
            }
        } else if (job.payment_method === 'wallet' || job.payment_status === 'wallet_funded') {
            await releaseWalletReservation(jobId, reason || 'Booking cancelled before completion');
        } else {
            await supabaseAdmin
                .from('jobs')
                .update({ payment_status: 'cancelled' })
                .eq('id', jobId);
        }

        if (job.customer_id) {
            await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'cancelled');
        }

        if (job.driver_id) {
            await NotificationService.notifyJobStatusUpdate(job.driver_id, jobId, 'cancelled');
        }

        return res.json({ success: true });
    } catch (error: any) {
        console.error('Cancel booking error:', error);
        return res.status(500).json({ error: error.message || 'Failed to cancel booking' });
    }
});

/**
 * Driver cannot continue.
 * If no protected spend exists, put the job back into driver search without releasing customer funds.
 * If spend/card activity exists, keep the assignment trail and move it to review for admin handoff.
 */
router.post('/driver-unable', async (req: Request, res: Response) => {
    try {
        // Batch 2C Phase B.1: the caller identity was taken from the request body,
        // so anyone could force a handoff, freeze the assigned driver's issuing
        // card and release the job.
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { jobId, driverId, reason } = req.body || {};

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }
        if (driverId && String(driverId) !== userId) {
            return res.status(403).json({ error: 'You can only hand off your own job.', code: 'DRIVER_IDENTITY_MISMATCH' });
        }

        const job = await getJob(jobId);

        // The authenticated caller must BE the assigned driver.
        if (String(job.driver_id || '') !== userId) {
            return res.status(403).json({ error: 'This driver is not assigned to the job', code: 'NOT_ASSIGNED_DRIVER' });
        }

        if (['completed', 'settled', 'cancelled'].includes(normalise(job.status))) {
            return res.status(400).json({ error: `Cannot hand off a job in status: ${job.status}` });
        }

        // The acting driver is the authenticated caller, never the request body.
        const actingDriverId = userId;

        const reasonText = String(reason || 'Driver cannot continue').trim().slice(0, 500);
        const hasSpend = await hasProtectedErrandSpend(jobId);
        const metadata = parseMetadata(job.metadata);
        const handoffHistory = Array.isArray(metadata.driver_handoff_history)
            ? metadata.driver_handoff_history
            : [];
        const handoffEntry = {
            driver_id: actingDriverId,
            reason: reasonText,
            previous_status: job.status,
            created_at: new Date().toISOString()
        };
        const nextMetadata = {
            ...metadata,
            driver_handoff_history: [handoffEntry, ...handoffHistory].slice(0, 10),
            last_driver_handoff: handoffEntry
        };

        try {
            await IssuingService.freezeDriverCard(actingDriverId, `Driver handoff: ${reasonText}`);
        } catch (freezeError) {
            console.warn('[BookingRoutes] failed to freeze issuing card during handoff:', freezeError);
        }

        if (hasSpend) {
            const { error } = await supabaseAdmin
                .from('jobs')
                .update({
                    status: 'requires_review',
                    no_driver_reason: `Driver cannot continue after spend/card activity: ${reasonText}`,
                    metadata: nextMetadata,
                    updated_at: new Date().toISOString()
                })
                .eq('id', jobId);

            if (error) throw error;

            await logJobEvent(jobId, 'driver_handoff_review_required', actingDriverId, reasonText, {
                previous_status: job.status,
                has_protected_spend: true
            });

            if (job.customer_id) {
                await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'requires_review');
            }

            return res.json({
                success: true,
                mode: 'review',
                message: 'This request has spend activity, so Vaydu support will review and hand it off safely.'
            });
        }

        // Persist exclusion BEFORE releasing the job so it cannot return to
        // the same driver after refresh or on another device.
        const decline = await supabaseAdmin.from('driver_job_declines').upsert({
            driver_id: actingDriverId, job_id: jobId, reason: 'driver_handoff',
            created_at: new Date().toISOString()
        }, { onConflict: 'driver_id,job_id' });
        if (decline.error) throw decline.error;
        try { await supabaseAdmin.rpc('close_driver_offer', { p_job: jobId, p_driver: actingDriverId, p_event: 'declined' }); } catch { /* event recording must not break decline */ }

        const { error } = await supabaseAdmin
            .from('jobs')
            .update({
                status: 'searching',
                driver_id: null,
                accepted_driver_id: null,
                accepted_at: null,
                no_show_arrived_at: null,
                no_show_grace_until: null,
                dispatch_started_at: new Date().toISOString(),
                driver_search_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                dispatch_attempts: Number(job.dispatch_attempts || 0) + 1,
                no_driver_reason: `Previous driver could not continue: ${reasonText}`,
                metadata: nextMetadata,
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
            // Close the TOCTOU window with the pre-check above: a job that reached a
            // terminal state (e.g. a customer no-show) after the read must never be
            // blindly re-released back into the driver pool.
            .not('status', 'in', '(cancelled,completed,settled)');

        if (error) throw error;

        await logJobEvent(jobId, 'driver_handoff_requeued', actingDriverId, reasonText, {
            previous_status: job.status,
            has_protected_spend: false
        });

        if (job.customer_id) {
            await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'searching');
        }

        return res.json({
            success: true,
            mode: 'requeued',
            message: 'The request has been returned to nearby drivers.'
        });
    } catch (error: any) {
        console.error('Driver unable handoff error:', error);
        return res.status(500).json({ error: error.message || 'Failed to hand off request' });
    }
});

router.post('/rate', async (req: Request, res: Response) => {
    try {
        const { jobId, score, comment } = req.body || {};
        const customerId = await getAuthUserId(req);
        if (!customerId) return res.status(401).json({ error: 'Authentication required' });
        const ratingScore = Number(score);
        if (String(comment || '').length > 2000) return res.status(400).json({ error: 'Review must be 2000 characters or fewer' });

        if (!jobId || !customerId) {
            return res.status(400).json({ error: 'jobId required' });
        }

        if (!Number.isInteger(ratingScore) || ratingScore < 1 || ratingScore > 5) {
            return res.status(400).json({ error: 'score must be an integer between 1 and 5' });
        }

        const job = await getJob(jobId);

        if (job.customer_id !== customerId) {
            return res.status(403).json({ error: 'You can only rate your own completed booking' });
        }

        if (!['completed', 'settled'].includes(job.status)) {
            return res.status(400).json({ error: 'Only completed bookings can be rated' });
        }

        const basePayload = {
            customer_id: customerId,
            driver_id: job.driver_id || null,
            score: ratingScore,
            comment: String(comment || '').trim() || null
        };

        const saveRating = async (
            payload: Record<string, unknown>,
            keyColumn: 'job_id' | 'booking_id'
        ) => {
            const existing = await supabaseAdmin
                .from('ratings')
                .select('id')
                .eq(keyColumn, jobId)
                .eq('customer_id', customerId)
                .maybeSingle();

            if (existing.error && existing.error.code !== 'PGRST116') {
                return { data: null, error: existing.error };
            }

            if (existing.data?.id) {
                return await supabaseAdmin
                    .from('ratings')
                    .update(payload)
                    .eq('id', existing.data.id)
                    .select('*')
                    .single();
            }

            return await supabaseAdmin
                .from('ratings')
                .insert(payload)
                .select('*')
                .single();
        };

        let result = await saveRating({
            ...basePayload,
            job_id: jobId,
            booking_id: jobId
        }, 'job_id');

        if (result.error) {
            const message = String(result.error.message || '');

            if (result.error.code === '42703' && message.includes('booking_id')) {
                result = await saveRating({
                    ...basePayload,
                    job_id: jobId,
                }, 'job_id');
            } else if (result.error.code === '42703' && message.includes('job_id')) {
                result = await saveRating({
                    ...basePayload,
                    booking_id: jobId,
                }, 'booking_id');
            }
        }

        if (result.error) {
            console.error('[BookingRoutes] rate failed:', result.error);
            return res.status(400).json({
                error: result.error.message,
                code: result.error.code,
                details: result.error.details,
                hint: result.error.hint
            });
        }

        const driverRating = await refreshDriverRating(job.driver_id);

        return res.json({ success: true, rating: result.data, driverRating });
    } catch (error: any) {
        console.error('Rate booking error:', error);
        return res.status(500).json({ error: error.message || 'Failed to rate booking' });
    }
});

/**
 * Record that a driver has declined/passed on a job.
 * Dispatch will not re-notify the same driver for the same job.
 */
/**
 * Authenticated driver offer/cancellation metrics for the calling driver.
 * Read-only; null rates when data is insufficient — never penalties.
 */
router.get('/offer-metrics', async (req: Request, res: Response) => {
    try {
        const driverId = await requireAuthenticatedUser(req, res);
        if (!driverId) return;
        const periodDays = Math.min(90, Math.max(1, Number(req.query.days) || 30));
        const { reportDriverOfferMetrics } = await import('../services/driver-offer-metrics.service');
        return res.json(await reportDriverOfferMetrics(driverId, periodDays));
    } catch (error: any) {
        console.error('[BookingRoutes] offer-metrics error:', error);
        return res.status(500).json({ error: error.message || 'Failed to report metrics' });
    }
});

router.get('/driver-declines', async (req: Request, res: Response) => {
    try {
        const driverId = await requireAuthenticatedUser(req, res);
        if (!driverId) return;
        const ids: string[] = [];
        for (let offset = 0; ; offset += 1000) {
            const result = await supabaseAdmin.from('driver_job_declines')
                .select('job_id').eq('driver_id', driverId).order('job_id').range(offset, offset + 999);
            if (result.error) throw result.error;
            for (const row of result.data || []) ids.push(String(row.job_id));
            if (!result.data || result.data.length < 1000) break;
        }
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ jobIds: ids });
    } catch {
        return res.status(503).json({ error: 'Driver request history unavailable. Please retry.' });
    }
});

router.post('/decline-job', async (req: Request, res: Response) => {
    try {
        // Batch 2C Phase B.1: unauthenticated, and the declined driver id came
        // from the body, so anyone could suppress offers for any driver.
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { driverId, jobId, reason } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }
        if (driverId && String(driverId) !== userId) {
            return res.status(403).json({ error: 'You can only decline a job for yourself.', code: 'DRIVER_IDENTITY_MISMATCH' });
        }

        const { error: insertError } = await supabaseAdmin
            .from('driver_job_declines')
            .upsert({
                driver_id: userId,
                job_id: jobId,
                reason: reason || 'driver_declined',
                created_at: new Date().toISOString()
            }, { onConflict: 'driver_id,job_id' });

        if (insertError) {
            console.error('[BookingRoutes] decline-job failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to record decline' });
        }

        return res.json({ success: true, declined: true });
    } catch (error: any) {
        console.error('[BookingRoutes] decline-job error:', error);
        return res.status(500).json({ error: error.message || 'Failed to decline job' });
    }
});

/**
 * Authenticated driver acknowledgement of offer delivery.
 * Distinct from push/send success — only this establishes receipt.
 * The driver can only ack an offer addressed to them; expired offers reject.
 */
router.post('/offer-ack', async (req: Request, res: Response) => {
    try {
        const driverId = await requireAuthenticatedUser(req, res);
        if (!driverId) return;
        const { jobId, offerKey } = req.body;
        if (!jobId || !offerKey) {
            return res.status(400).json({ error: 'jobId and offerKey are required' });
        }
        const { data, error } = await supabaseAdmin.rpc('acknowledge_driver_offer_for', {
            p_job: jobId, p_driver: driverId, p_offer_key: offerKey
        });
        if (error) {
            const msg = String(error.message || '');
            const status = msg.includes('offer_not_for_driver') ? 403
                : msg.includes('offer_expired') ? 410
                : msg.includes('offer_job_missing') ? 404 : 500;
            return res.status(status).json({ error: msg, code: status === 500 ? 'ACK_FAILED' : msg });
        }
        return res.json({ success: true, acknowledged: true, event: data?.event || 'acknowledged' });
    } catch (error: any) {
        console.error('[BookingRoutes] offer-ack error:', error);
        return res.status(500).json({ error: error.message || 'Failed to acknowledge offer' });
    }
});

/**
 * Send a customer push notification for a job status change.
 * The job status itself is saved by the caller; this endpoint only triggers
 * the push via the existing notification service so it works when the app is
 * in the background.
 */
const NOTIFIABLE_JOB_STATUSES = new Set([
    'searching', 'requested', 'pending', 'pending_fare_confirmation', 'negotiating',
    'assigned', 'accepted', 'driver_arrived', 'arrived', 'in_progress', 'started',
    'picked_up', 'collected', 'delivered', 'completed', 'cancelled', 'requires_review',
    'no_driver_found', 'expired'
]);

router.post('/notify-status', async (req: Request, res: Response) => {
    try {
        // Batch 2C Phase B.1: unauthenticated, so anyone could push an arbitrary
        // status string to any job's customer.
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { jobId, status } = req.body;

        if (!jobId || !status) {
            return res.status(400).json({ error: 'jobId and status are required' });
        }
        // Only canonical statuses may be announced: no free text may reach a push.
        if (!NOTIFIABLE_JOB_STATUSES.has(normalise(status))) {
            return res.status(400).json({ error: 'Unknown job status.', code: 'UNKNOWN_JOB_STATUS' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('customer_id,driver_id,accepted_driver_id')
            .eq('id', jobId)
            .single();

        if (jobError || !job?.customer_id) {
            console.warn('[BookingRoutes] notify-status: job or customer not found', jobError);
            return res.status(404).json({ error: 'Job or customer not found' });
        }

        if (!isJobParticipant(job, userId) && !(await isAdminUser(userId))) {
            return res.status(403).json({ error: 'You are not a participant in this booking.', code: 'NOT_A_PARTICIPANT' });
        }

        await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, status);

        return res.json({ success: true, notified: true });
    } catch (error: any) {
        console.error('[BookingRoutes] notify-status error:', error);
        return res.status(500).json({ error: error.message || 'Failed to send status notification' });
    }
});

/**
 * Create a fare negotiation for a job.
 */
router.post('/negotiation', async (req: Request, res: Response) => {
    try {
        const { jobId, amount, message, proposedByRole, counterToNegotiationId } = req.body;

        if (!jobId || !amount || isNaN(Number(amount))) {
            return res.status(400).json({ error: 'jobId and amount are required' });
        }

        const userId = await getAuthUserId(req);
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const role = String(proposedByRole || 'customer');
        if (!['customer', 'driver'].includes(role)) {
            return res.status(400).json({ error: 'proposedByRole must be customer or driver' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('customer_id, driver_id, status')
            .eq('id', jobId)
            .single();

        if (jobError || !job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const isParticipant =
            (role === 'customer' && job.customer_id === userId) ||
            (role === 'driver' && job.driver_id === userId);

        if (!isParticipant) {
            return res.status(403).json({ error: 'Only the customer or assigned driver can negotiate' });
        }

        const round = counterToNegotiationId ? 2 : 1;

        const { data: negotiation, error: insertError } = await supabaseAdmin
            .from('fare_negotiations')
            .insert({
                job_id: jobId,
                proposed_by: userId,
                proposed_by_role: role,
                amount: Number(amount),
                message: message || null,
                counter_to_negotiation_id: counterToNegotiationId || null,
                round_number: round,
                status: 'pending'
            })
            .select('*')
            .single();

        if (insertError) {
            console.error('[BookingRoutes] negotiation create failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to create negotiation' });
        }

        await supabaseAdmin
            .from('jobs')
            .update({
                status: role === 'customer' ? 'negotiating' : 'pending_fare_confirmation',
                negotiated_fare: Number(amount),
                negotiation_deadline: new Date(Date.now() + 120000).toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId);

        return res.json({ success: true, negotiation });
    } catch (error: any) {
        console.error('[BookingRoutes] negotiation create error:', error);
        return res.status(500).json({ error: error.message || 'Failed to create negotiation' });
    }
});

/**
 * Accept a fare negotiation and lock the agreed fare.
 */
/**
 * Customer accepts a driver's fare offer (legacy negotiation accept).
 *
 * Batch 2C Phase B.1: this handler used to perform a bare `.update({status,
 * agreed_fare, driver_id})` with no status predicate, no ownership predicate, no
 * row lock and no transaction, so a customer participant could force
 * `fare_agreed` with `driver_id = NULL`, could reassign the job from driver A to
 * driver B, and was told `{ success: true }` either way.
 *
 * It is now a thin trusted wrapper around the atomic
 * `public.accept_driver_offer(uuid, uuid)`:
 *   * the server authorises the CALLER as a job participant,
 *   * the DRIVER is derived server-side from the negotiation row (never from the
 *     request body), so a NULL driver can no longer be written,
 *   * the RPC locks the job, validates the negotiation status and the ownership
 *     transition, refuses A -> B, and raises unless the row actually moved.
 * Post-commit pricing is secondary work: it can never turn a committed
 * acceptance into a reported failure.
 */
router.post('/negotiation/:id/accept', async (req: Request, res: Response) => {
    try {
        const negotiationId = req.params.id;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required', code: 'AUTHENTICATION_REQUIRED' });
        }

        const { data: negotiation, error: fetchError } = await supabaseAdmin
            .from('fare_negotiations')
            .select('*, job:jobs(id, customer_id, driver_id)')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found' });
        }

        const job = (negotiation as any).job;
        // Release closure: this endpoint is the CUSTOMER accepting a driver
        // offer. Only the customer may invoke it; a driver must not self-accept
        // their own offer through the customer-authority path.
        if (job?.customer_id !== userId) {
            return res.status(403).json({ error: 'Only the customer can accept this negotiation', code: 'NOT_A_PARTICIPANT' });
        }

        const { data: fullJob, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('*')
            .eq('id', negotiation.job_id)
            .single();

        if (jobError || !fullJob) {
            return res.status(404).json({ error: 'Job not found' });
        }
        const fullMetadata = fullJob.metadata && typeof fullJob.metadata === 'object' ? fullJob.metadata : {};
        await MarketAvailabilityService.requireCapability({ countryCode: fullJob.country_code || fullMetadata.country_code,
            marketCity: fullJob.market_city || fullMetadata.market_city || fullMetadata.pickup_city, zoneId: fullJob.zone_id || fullMetadata.zone_id,
            capability: 'booking', endpoint: '/api/booking/negotiation/accept' });

        // The accepted driver is derived SERVER-SIDE from the negotiation row.
        // A customer cannot accept an offer into a job with no driver.
        const acceptedDriverId = (negotiation as any).proposed_by_role === 'driver'
            ? String((negotiation as any).proposed_by || '')
            : String(fullJob.driver_id || '');

        if (!acceptedDriverId) {
            return res.status(409).json({
                error: 'There is no driver offer to accept for this job.',
                code: 'NO_DRIVER_OFFER_TO_ACCEPT'
            });
        }

        // Defence in depth: re-check the accepted driver's CURRENT service-specific
        // eligibility immediately before acquisition. Dispatch already filtered the
        // candidate set, but a pending offer can survive until the driver becomes
        // ineligible. We reuse the canonical helper (no duplicated rule logic).
        const canonicalService = toCanonicalDriverService(fullJob.service_slug);
        if (canonicalService) {
            const { data: driverProfile, error: driverProfileError } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', acceptedDriverId)
                .maybeSingle();
            if (driverProfileError || !driverProfile) {
                return res.status(409).json({ error: 'The selected driver is no longer available.', code: 'DRIVER_NO_LONGER_AVAILABLE' });
            }

            const { data: driverVehicles, error: driverVehicleError } = await supabaseAdmin
                .from('vehicles')
                .select('*')
                .eq('user_id', acceptedDriverId)
                .order('created_at', { ascending: false })
                .limit(1);
            if (driverVehicleError) {
                return res.status(409).json({ error: 'The selected driver is no longer available.', code: 'DRIVER_NO_LONGER_AVAILABLE' });
            }
            const driverVehicle = (driverVehicles || [])[0] || null;

            if (!isDriverEligibleForService(driverProfile, driverVehicle, canonicalService)) {
                return res.status(409).json({ error: 'The selected driver is no longer eligible for this service.', code: 'DRIVER_NO_LONGER_ELIGIBLE' });
            }
        }

        if (fullJob.payment_method === 'cash') {
            const cashJob = await getJob(negotiation.job_id);
            if (isCashRide(cashJob) && !(await requirePayoutEligible(acceptedDriverId,res,cashJob))) return;
        }

        const { data: accepted, error: acceptError } = await supabaseAdmin.rpc('accept_driver_offer', {
            p_job_id: negotiation.job_id,
            p_driver_id: acceptedDriverId
        });

        if (acceptError) {
            const acquisitionFailure = mapDriverAcquisitionError(acceptError);
            if (acquisitionFailure) {
                return res.status(acquisitionFailure.status).json({
                    error: acquisitionFailure.error,
                    code: acquisitionFailure.code,
                    ...(acquisitionFailure.blocking ? { blocking: acquisitionFailure.blocking } : {})
                });
            }

            const sqlState = String(acceptError.code || '');
            if (sqlState === '23505') {
                return res.status(409).json({ error: 'This job is already owned by another driver.', code: 'JOB_ALREADY_OWNED' });
            }
            if (sqlState === '23514') {
                return res.status(409).json({ error: 'This offer is no longer available.', code: 'OFFER_NO_LONGER_AVAILABLE' });
            }
            if (sqlState === 'P0002') {
                return res.status(404).json({ error: 'No pending driver offer found', code: 'OFFER_NOT_FOUND' });
            }
            if (sqlState === '22023') {
                return res.status(400).json({ error: 'Offer amount is not valid', code: 'INVALID_OFFER_AMOUNT' });
            }
            if (sqlState === '42501') {
                return res.status(403).json({ error: 'You cannot accept this offer.', code: 'NOT_ALLOWED' });
            }

            console.error('[BookingRoutes] negotiation accept RPC failed:', acceptError);
            return res.status(500).json({ error: 'Failed to accept negotiation' });
        }

        // ------------------------------------------------------------------
        // OWNERSHIP IS COMMITTED AT THIS POINT. Everything below is SECONDARY:
        // a pricing or notification problem must never report the committed
        // acceptance as failed, and must never write ownership again.
        // ------------------------------------------------------------------
        const agreedFare = Number((accepted as any)?.agreed_fare ?? negotiation.amount);
        let pricingPending = false;
        try {
            const fareUpdate = PricingService.applyAgreedFare(fullJob, agreedFare);
            const { error: pricingError } = await supabaseAdmin
                .from('jobs')
                .update({ ...fareUpdate, updated_at: new Date().toISOString() })
                .eq('id', negotiation.job_id)
                .eq('driver_id', acceptedDriverId)
                .eq('status', 'fare_agreed');

            if (pricingError) {
                pricingPending = true;
                console.error('[BookingRoutes] negotiation accept pricing refresh failed (ownership already committed):', pricingError);
            }
        } catch (pricingException) {
            pricingPending = true;
            console.error('[BookingRoutes] negotiation accept pricing refresh threw (ownership already committed):', pricingException);
        }

        return res.json({
            success: true,
            ownershipCommitted: true,
            pricingPending,
            negotiation: { ...negotiation, status: 'accepted' }
        });
    } catch (error: any) {
        console.error('[BookingRoutes] negotiation accept error:', error);
        if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
        return res.status(500).json({ error: error.message || 'Failed to accept negotiation' });
    }
});

/**
 * Driver accepts the customer's current offer for a job.
 * Finds the latest pending customer negotiation, accepts it, assigns the
 * driver, and locks the agreed fare.
 */
router.post('/negotiation/:jobId/driver-accept', async (req: Request, res: Response) => {
    try {
        const jobId = req.params.jobId;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('*')
            .eq('id', jobId)
            .single();

        if (jobError || !job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        const jobMetadata = job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
        await MarketAvailabilityService.requireCapability({ countryCode: job.country_code || jobMetadata.country_code,
            marketCity: job.market_city || jobMetadata.market_city || jobMetadata.pickup_city, zoneId: job.zone_id || jobMetadata.zone_id,
            capability: 'booking', endpoint: '/api/booking/negotiation/driver-accept' });

        // Preserve payout checks; only an approved, enabled cash-Ride cohort uses internal credit.
        if (!(await requirePayoutEligible(userId, res, job))) return;

        if (!job.negotiation_mode_enabled) {
            return res.status(400).json({ error: 'Job is not in negotiation mode' });
        }

        // ------------------------------------------------------------------
        // ATOMIC acceptance (N35).
        //
        // The previous implementation performed SELECT -> UPDATE
        // fare_negotiations -> UPDATE jobs with no transaction, no row lock and
        // no conditional predicate, so two concurrent drivers could both mark
        // the offer accepted and both overwrite jobs.driver_id while both
        // received { success: true }.
        //
        // accept_fare_negotiation now owns the whole ownership decision in one
        // transaction: it locks the job row FOR UPDATE (serialising racers),
        // locks the newest pending customer offer FOR UPDATE, guards on job
        // status and existing ownership, then writes both tables. Exactly one
        // caller can commit.
        //
        // Driver identity is the server-derived authenticated user. The request
        // body can never influence it.
        // ------------------------------------------------------------------
        const { data: acceptResult, error: acceptError } = await supabaseAdmin.rpc('accept_fare_negotiation', {
            p_job_id: jobId,
            p_driver_id: userId
        });

        if (acceptError) {
            // Map the RPC's deterministic SQLSTATEs without leaking SQL internals.
            const sqlState = String(acceptError.code || '');

            // Batch 2C Phase B — the acquisition error contract. COMPLIANCE (MB002)
            // is checked BEFORE busy (MB001): a driver who is both ineligible and
            // busy must be told the actionable compliance reason, matching the
            // precedence the acquisition RPCs themselves use.
            const acquisitionFailure = mapDriverAcquisitionError(acceptError);
            if (acquisitionFailure) {
                return res.status(acquisitionFailure.status).json({
                    error: acquisitionFailure.error,
                    code: acquisitionFailure.code,
                    ...(acquisitionFailure.blocking ? { blocking: acquisitionFailure.blocking } : {})
                });
            }

            if (sqlState === '23505') {
                // Lost race: a different driver already owns this job.
                return res.status(409).json({
                    error: 'This offer has already been accepted by another driver.',
                    code: 'OFFER_ALREADY_ACCEPTED'
                });
            }

            if (sqlState === '23514') {
                // Stale state: job moved on, or the offer stopped being pending.
                return res.status(409).json({
                    error: 'This offer is no longer available.',
                    code: 'OFFER_NO_LONGER_AVAILABLE'
                });
            }

            if (sqlState === 'P0002') {
                // Job or pending customer offer not found.
                return res.status(404).json({ error: 'No pending customer offer found' });
            }

            if (sqlState === '22023') {
                return res.status(400).json({ error: acceptError.message || 'Offer cannot be accepted' });
            }

            console.error('[BookingRoutes] driver-accept RPC failed:', acceptError);
            return res.status(500).json({ error: 'Failed to accept offer' });
        }

        // The RPC returns the negotiation row and the agreed fare. Ownership and
        // status are ALREADY COMMITTED at this point.
        const result = (acceptResult || {}) as {
            agreed_fare?: number | string;
            negotiation?: Record<string, unknown>;
        };

        const agreedFare = Number(result.agreed_fare ?? 0);

        // Batch 2C Phase B.1 — this used to be a hard 500.
        //
        // Ownership has already moved inside the RPC's transaction, so reporting
        // a failure here told the driver their acceptance had failed when it had
        // in fact succeeded. That is worse than the pricing gap it was guarding:
        // the driver retries, the retry is correctly refused as already-owned,
        // and the job is left in a state the driver believes they do not own.
        //
        // An unusable negotiated amount is therefore classified as SECONDARY
        // work: the response reports the committed ownership accurately, flags
        // that the derived pricing still needs to be completed, and never claims
        // the acceptance failed. The raw amount is never used to write pricing.
        const pricingPending = !Number.isFinite(agreedFare) || agreedFare <= 0;
        if (pricingPending) {
            console.error('[BookingRoutes] driver-accept committed ownership but returned no usable agreed fare; pricing deferred:', acceptResult);
        }

        const negotiation = result.negotiation || {
            job_id: jobId,
            amount: Number.isFinite(agreedFare) ? agreedFare : null,
            proposed_by_role: 'customer',
            status: 'accepted'
        };

        // ------------------------------------------------------------------
        // Derived pricing only. applyAgreedFare is the single source of truth for
        // the scaled fare breakdown and is intentionally NOT duplicated in SQL.
        //
        // The write is ownership-guarded so it can never undo the RPC: it only
        // matches when THIS driver owns the job and it is still fare_agreed. If
        // the guard matches nothing the atomic claim already succeeded, so the
        // pricing refresh is reported diagnostically rather than failing the
        // acceptance the driver has legitimately won.
        // ------------------------------------------------------------------
        let derivedPricingPending = pricingPending;
        try {
            if (pricingPending) {
                // No usable amount: skip the derived write entirely rather than
                // persisting a fabricated fare. Ownership stays committed.
                throw new Error('negotiated amount unavailable; derived pricing deferred');
            }
            const fareUpdate = PricingService.applyAgreedFare(job, agreedFare);

            const { error: pricingError } = await supabaseAdmin
                .from('jobs')
                .update({ ...fareUpdate, updated_at: new Date().toISOString() })
                .eq('id', jobId)
                .eq('driver_id', userId)
                .eq('status', 'fare_agreed');

            if (pricingError) {
                derivedPricingPending = true;
                console.error('[BookingRoutes] driver-accept pricing refresh failed (ownership already committed):', pricingError);
            }
        } catch (pricingException) {
            // Never convert a committed win into a client-visible failure.
            derivedPricingPending = true;
            console.error('[BookingRoutes] driver-accept pricing refresh threw (ownership already committed):', pricingException);
        }

        // Notify only after the atomic acquisition succeeded. The winner notifies;
        // a loser returned above and never reaches this line.
        try {
            await NotificationService.notifyJobStatusUpdate(String(job.customer_id), String(jobId), 'accepted');
        } catch (notifyError) {
            // Secondary work: a push failure must not repaint a committed win.
            console.error('[BookingRoutes] driver-accept notify failed (ownership already committed):', notifyError);
        }

        return res.json({
            success: true,
            ownershipCommitted: true,
            pricingPending: derivedPricingPending,
            negotiation: { ...negotiation, status: 'accepted' }
        });
    } catch (error: any) {
        console.error('[BookingRoutes] driver-accept negotiation error:', error);
        if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
        return res.status(500).json({ error: error.message || 'Failed to accept offer' });
    }
});

/**
 * Driver counters the customer's current offer with a new amount.
 */
router.post('/negotiation/:jobId/driver-counter', async (req: Request, res: Response) => {
    try {
        const jobId = req.params.jobId;
        const { amount, message } = req.body;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!amount || isNaN(Number(amount))) {
            return res.status(400).json({ error: 'amount is required' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('id, customer_id, status, negotiation_mode_enabled')
            .eq('id', jobId)
            .single();

        if (jobError || !job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // Release closure: a driver counter-offer must come from a driver, never
        // the job's own customer (who would otherwise be able to fabricate a
        // "driver" counter-offer against their own negotiation).
        if (String(job.customer_id) === String(userId)) {
            return res.status(403).json({ error: 'Customers cannot submit a driver counter-offer' });
        }

        if (!job.negotiation_mode_enabled) {
            return res.status(400).json({ error: 'Job is not in negotiation mode' });
        }

        const { data: negotiations, error: fetchError } = await supabaseAdmin
            .from('fare_negotiations')
            .select('*')
            .eq('job_id', jobId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1);

        if (fetchError) throw fetchError;

        const latestNegotiation = negotiations?.[0];

        const { data: counter, error: insertError } = await supabaseAdmin
            .from('fare_negotiations')
            .insert({
                job_id: jobId,
                proposed_by: userId,
                proposed_by_role: 'driver',
                amount: Number(amount),
                message: message || null,
                counter_to_negotiation_id: latestNegotiation?.id || null,
                round_number: (latestNegotiation?.round_number || 1) + 1,
                status: 'pending'
            })
            .select('*')
            .single();

        if (insertError) {
            console.error('[BookingRoutes] driver counter failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to counter offer' });
        }

        if (latestNegotiation) {
            await supabaseAdmin
                .from('fare_negotiations')
                .update({ status: 'countered', updated_at: new Date().toISOString() })
                .eq('id', latestNegotiation.id);
        }

        await supabaseAdmin
            .from('jobs')
            .update({
                status: 'pending_fare_confirmation',
                negotiated_fare: Number(amount),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId);

        // Notify customer about the counter offer
        await NotificationService.notifyNegotiationCounter(String(job.customer_id), String(jobId), Number(amount));

        return res.json({ success: true, negotiation: counter });
    } catch (error: any) {
        console.error('[BookingRoutes] driver counter error:', error);
        return res.status(500).json({ error: error.message || 'Failed to counter offer' });
    }
});

/**
 * Customer submits a new offer for a job in negotiation mode.
 */
router.post('/negotiation/:jobId/customer-offer', async (req: Request, res: Response) => {
    try {
        console.log('[BookingRoutes] customer-offer route hit', req.params.jobId);
        const jobId = req.params.jobId;
        const { amount, message } = req.body;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!amount || isNaN(Number(amount))) {
            return res.status(400).json({ error: 'amount is required' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('id, customer_id, status, negotiation_mode_enabled, tenant_id, city_id, pickup_lat, pickup_lng, service_slug, driver_id')
            .eq('id', jobId)
            .single();

        console.log('[BookingRoutes] customer-offer auth/job', {
            authUserId: userId,
            jobId,
            jobCustomerId: job?.customer_id,
            serviceClient: 'supabaseAdmin',
            queryError: null
        });

        if (jobError || !job) {
            console.warn('[BookingRoutes] customer-offer job fetch failed', {
                authUserId: userId,
                jobId,
                serviceClient: 'supabaseAdmin',
                queryError: jobError
            });
            return res.status(404).json({ error: 'Job not found' });
        }

        if (job.customer_id !== userId) {
            return res.status(403).json({ error: 'Only the customer can make an offer for this job' });
        }

        if (!job.negotiation_mode_enabled) {
            return res.status(400).json({ error: 'Job is not in negotiation mode' });
        }

        const status = String(job.status || '').toLowerCase();
        if (!['pending_fare_confirmation', 'negotiating'].includes(status)) {
            return res.status(400).json({ error: 'Job is not open for negotiation' });
        }

        const { data: negotiations, error: fetchError } = await supabaseAdmin
            .from('fare_negotiations')
            .select('*')
            .eq('job_id', jobId)
            .order('created_at', { ascending: false })
            .limit(1);

        if (fetchError) throw fetchError;

        const latestNegotiation = negotiations?.[0];

        const { data: negotiation, error: insertError } = await supabaseAdmin
            .from('fare_negotiations')
            .insert({
                job_id: jobId,
                proposed_by: userId,
                proposed_by_role: 'customer',
                amount: Number(amount),
                message: message || null,
                counter_to_negotiation_id: latestNegotiation?.id || null,
                round_number: (latestNegotiation?.round_number || 1) + 1,
                status: 'pending'
            })
            .select('*')
            .single();

        if (insertError) {
            console.error('[BookingRoutes] customer offer failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to create offer' });
        }

        if (latestNegotiation?.status === 'pending') {
            await supabaseAdmin
                .from('fare_negotiations')
                .update({ status: 'countered', updated_at: new Date().toISOString() })
                .eq('id', latestNegotiation.id);
        }

        await supabaseAdmin
            .from('jobs')
            .update({
                status: 'negotiating',
                negotiated_fare: Number(amount),
                negotiation_deadline: new Date(Date.now() + 120000).toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId);

        // Alert nearby drivers so they can see the updated offer
        try {
            await new DispatchService().notifyNearbyDrivers({
                ...job,
                status: 'negotiating',
                negotiated_fare: Number(amount),
                negotiation_deadline: new Date(Date.now() + 120000).toISOString()
            } as any, job.tenant_id, job.city_id);
        } catch (notifyError) {
            console.warn('[BookingRoutes] customer offer driver notification failed:', notifyError);
        }

        return res.json({ success: true, negotiation });
    } catch (error: any) {
        console.error('[BookingRoutes] customer offer error:', error);
        return res.status(500).json({ error: error.message || 'Failed to create offer' });
    }
});

/**
 * Send a push notification for a hybrid marketplace event.
 * Used by the frontend hybrid service because some RPC flows run directly
 * against Supabase and cannot trigger server-side dispatch.
 */
router.post('/notify-hybrid', async (req: Request, res: Response) => {
    try {
        const userId = await getAuthUserId(req);
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { action, jobId, recipientUserId, title, body, type = 'booking_update', data } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }

        if (action === 'notify_drivers') {
            const { data: job, error: jobError } = await supabaseAdmin
                .from('jobs')
                .select('*, service_type:service_types(*)')
                .eq('id', jobId)
                .single();

            if (jobError || !job) {
                return res.status(404).json({ error: 'Job not found' });
            }

            try {
                await new DispatchService().notifyNearbyDrivers(job, job.tenant_id, job.city_id);
            } catch (notifyError) {
                console.warn('[BookingRoutes] notify-hybrid driver dispatch failed:', notifyError);
            }

            return res.json({ success: true });
        }

        if (!recipientUserId || !title || !body) {
            return res.status(400).json({ error: 'recipientUserId, title and body are required' });
        }

        await NotificationService.sendNotification({
            userId: recipientUserId,
            title,
            body,
            type,
            data: { jobId, ...data }
        });

        return res.json({ success: true });
    } catch (error: any) {
        console.error('[BookingRoutes] notify-hybrid error:', error);
        return res.status(500).json({ error: error.message || 'Failed to send notification' });
    }
});

/**
 * Counter a fare negotiation with a new offer.
 */
router.post('/negotiation/:id/counter', async (req: Request, res: Response) => {
    try {
        const negotiationId = req.params.id;
        const { amount, message } = req.body;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!amount || isNaN(Number(amount))) {
            return res.status(400).json({ error: 'amount is required' });
        }

        const { data: negotiation, error: fetchError } = await supabaseAdmin
            .from('fare_negotiations')
            .select('*, job:jobs(id, customer_id, driver_id)')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found' });
        }

        const job = (negotiation as any).job;
        const isParticipant = job.customer_id === userId || job.driver_id === userId;
        if (!isParticipant) {
            return res.status(403).json({ error: 'Only participants can counter this negotiation' });
        }

        const counterRole = job.customer_id === userId ? 'customer' : 'driver';

        const { data: counter, error: insertError } = await supabaseAdmin
            .from('fare_negotiations')
            .insert({
                job_id: negotiation.job_id,
                proposed_by: userId,
                proposed_by_role: counterRole,
                amount: Number(amount),
                message: message || null,
                counter_to_negotiation_id: negotiationId,
                round_number: (negotiation.round_number || 1) + 1,
                status: 'pending'
            })
            .select('*')
            .single();

        if (insertError) {
            console.error('[BookingRoutes] negotiation counter failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to counter negotiation' });
        }

        await supabaseAdmin
            .from('fare_negotiations')
            .update({ status: 'countered', updated_at: new Date().toISOString() })
            .eq('id', negotiationId);

        await supabaseAdmin
            .from('jobs')
            .update({
                status: 'negotiating',
                negotiated_fare: Number(amount),
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiation.job_id);

        return res.json({ success: true, negotiation: counter });
    } catch (error: any) {
        console.error('[BookingRoutes] negotiation counter error:', error);
        return res.status(500).json({ error: error.message || 'Failed to counter negotiation' });
    }
});

export default router;
