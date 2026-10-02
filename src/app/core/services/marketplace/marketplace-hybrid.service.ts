import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { acquisitionErrorMessage } from '../compliance/acquisition-error';
import { AuthService } from '../auth/auth.service';
import { ApiUrlService } from '../api-url.service';
import {
    MarketplaceConfigService,
    MarketplaceEffectiveHybridStatus,
    MarketplaceHybridNegotiationSettings
} from './marketplace-config.service';
import {
    DEFAULT_HYBRID_ENABLED,
    DEFAULT_HYBRID_ENABLED_SERVICES,
    DEFAULT_HYBRID_MAX_ROUNDS,
    DEFAULT_HYBRID_TIMEOUT_SECONDS,
    DEFAULT_HYBRID_CLAIM_TIMEOUT_SECONDS,
    DEFAULT_HYBRID_MAX_DRIVER_ATTEMPTS,
    DEFAULT_HYBRID_RIDE_MINIMUM_KM,
    DEFAULT_HYBRID_MAKE_OFFER_ENABLED,
    DEFAULT_HYBRID_ACCEPT_FARE_ENABLED
} from './marketplace-hybrid.constants';

export interface MarketplaceNegotiationSession {
    id: string;
    job_id: string;
    customer_id: string;
    active_driver_id: string | null;
    status: 'open' | 'driver_claimed' | 'negotiating' | 'fare_agreed' | 'driver_declined' | 'customer_declined' | 'released' | 'expired' | 'payment_pending' | 'paid';
    suggested_fare: number;
    customer_offer: number | null;
    driver_counter_offer: number | null;
    agreed_fare: number | null;
    round_count: number;
    attempt_count: number;
    claimed_at: string | null;
    expires_at: string;
    payment_deadline: string | null;
    created_at: string;
    updated_at: string;
}

export interface MarketplaceNegotiationEvent {
    id: string;
    session_id: string;
    job_id: string;
    proposed_by: string;
    proposed_by_role: 'customer' | 'driver' | 'system';
    event_type: string;
    amount: number | null;
    message: string | null;
    round_number: number;
    created_at: string;
}

export interface HybridOpportunity {
    session_id: string;
    job_id: string;
    customer_id: string;
    suggested_fare: number;
    customer_offer: number | null;
    distance_km: number | null;
    eta_seconds: number | null;
    service_name: string;
    service_slug: string;
    pickup_address: string;
    dropoff_address: string | null;
}

@Injectable({
    providedIn: 'root'
})
export class MarketplaceHybridService {
    private supabase = inject(SupabaseService);
    private auth = inject(AuthService);
    private apiUrl = inject(ApiUrlService);
    private config = inject(MarketplaceConfigService);
    private effectiveStatusCache = new Map<string, MarketplaceEffectiveHybridStatus>();

    private rpc(name: string, args?: Record<string, unknown>) {
        return this.supabase.rpc(name, args);
    }

    private get userId() {
        return this.auth.currentUser()?.id;
    }

    constructor() {
        // Ensure DB-backed marketplace settings are loaded.
        if (!this.config.settingsSignal()) {
            this.config.loadSettings().catch(() => undefined);
        }
    }

    async loadSettings(): Promise<MarketplaceHybridNegotiationSettings> {
        const settings = await this.config.loadSettings();
        return settings.hybridNegotiation;
    }

    private canonicalServiceSlug(slug: string): string {
        const raw = String(slug || '').trim().toLowerCase().replace(/[-\s]/g, '_');
        if (['shop', 'shopping', 'errands', 'errand'].includes(raw)) return 'errand';
        if (['courier', 'parcel', 'package', 'delivery'].includes(raw)) return 'delivery';
        if (['van', 'moving', 'move', 'van_moving', 'van-moving', 'van moving'].includes(raw)) return 'van-moving';
        if (['ride', 'rides'].includes(raw)) return 'ride';
        return raw;
    }

    private defaultSettings() {
        return {
            enabled: DEFAULT_HYBRID_ENABLED,
            maxRounds: DEFAULT_HYBRID_MAX_ROUNDS,
            timeoutSeconds: DEFAULT_HYBRID_TIMEOUT_SECONDS,
            maxDriverAttempts: DEFAULT_HYBRID_MAX_DRIVER_ATTEMPTS,
            claimTimeoutSeconds: DEFAULT_HYBRID_CLAIM_TIMEOUT_SECONDS,
            enabledServices: DEFAULT_HYBRID_ENABLED_SERVICES,
            rideMinimumDistanceKm: DEFAULT_HYBRID_RIDE_MINIMUM_KM,
            makeOfferEnabled: DEFAULT_HYBRID_MAKE_OFFER_ENABLED,
            acceptFareEnabled: DEFAULT_HYBRID_ACCEPT_FARE_ENABLED
        };
    }

    private settings() {
        return this.config.settingsSignal()?.hybridNegotiation ?? this.defaultSettings();
    }

    async getEffectiveHybridStatus(serviceSlug: string): Promise<MarketplaceEffectiveHybridStatus> {
        const canonical = this.canonicalServiceSlug(serviceSlug);
        const status = await this.config.getEffectiveHybridStatus(canonical);
        this.effectiveStatusCache.set(canonical, status);
        return status;
    }

    isMakeOfferEnabled(): boolean {
        return this.settings().makeOfferEnabled ?? DEFAULT_HYBRID_MAKE_OFFER_ENABLED;
    }

    isAcceptFareEnabled(): boolean {
        return this.settings().acceptFareEnabled ?? DEFAULT_HYBRID_ACCEPT_FARE_ENABLED;
    }

    isLongDistanceRide(distanceKm: number): boolean {
        return distanceKm >= this.settings().rideMinimumDistanceKm;
    }

    getNegotiationTimeoutSeconds(): number {
        return this.settings().timeoutSeconds ?? DEFAULT_HYBRID_TIMEOUT_SECONDS;
    }

    getClaimTimeoutSeconds(): number {
        return this.settings().claimTimeoutSeconds ?? DEFAULT_HYBRID_CLAIM_TIMEOUT_SECONDS;
    }

    getMaxRounds(): number {
        return this.settings().maxRounds ?? DEFAULT_HYBRID_MAX_ROUNDS;
    }

    getMaxDriverAttempts(): number {
        return this.settings().maxDriverAttempts ?? DEFAULT_HYBRID_MAX_DRIVER_ATTEMPTS;
    }

    async getSessionByJob(jobId: string): Promise<MarketplaceNegotiationSession | null> {
        const { data, error } = await this.supabase
            .from('marketplace_negotiation_sessions')
            .select('*')
            .eq('job_id', jobId)
            .maybeSingle();

        if (error) throw error;
        return (data as MarketplaceNegotiationSession | null) ?? null;
    }

    async getSessionById(sessionId: string): Promise<MarketplaceNegotiationSession | null> {
        const { data, error } = await this.supabase
            .from('marketplace_negotiation_sessions')
            .select('*')
            .eq('id', sessionId)
            .maybeSingle();

        if (error) throw error;
        return (data as MarketplaceNegotiationSession | null) ?? null;
    }

    async getSessionEvents(sessionId: string): Promise<MarketplaceNegotiationEvent[]> {
        const { data, error } = await this.supabase
            .from('marketplace_negotiation_events')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

        if (error) throw error;
        return (data as MarketplaceNegotiationEvent[] | null) ?? [];
    }

    /**
     * Patch 1A — driver claimed-session RECOVERY.
     *
     * Once a driver claims a session the RPC sets `active_driver_id`, and
     * fetch_hybrid_opportunities filters on `active_driver_id IS NULL`, so the session
     * correctly leaves the unclaimed opportunity pool. Previously nothing queried the
     * driver's OWN claims, so a successful claim followed by a navigation/render failure
     * left the driver with no way back — the negotiation appeared lost.
     *
     * This lookup is authorised by the EXISTING participant SELECT policy
     * (hybrid_sessions_owner_or_driver: customer_id = auth.uid() OR
     * active_driver_id = auth.uid()), so no new RLS is required and no arbitrary id is
     * trusted from the client. Only genuinely ACTIVE driver states are returned;
     * released/expired/terminal sessions are excluded.
     */
    async getActiveDriverSessions(): Promise<MarketplaceNegotiationSession[]> {
        const userId = this.auth.currentUser()?.id;
        if (!userId) return [];

        const { data, error } = await this.supabase
            .from('marketplace_negotiation_sessions')
            .select('*')
            .eq('active_driver_id', userId)
            .in('status', ['driver_claimed', 'negotiating'])
            .order('updated_at', { ascending: false });

        if (error) throw error;

        // Expiry is enforced in the database by the cleanup service, but a session can be
        // past its window before cleanup runs — never surface one as recoverable.
        const now = Date.now();
        return ((data as MarketplaceNegotiationSession[] | null) ?? []).filter((session) => {
            const expiresAt = Date.parse(String(session?.expires_at ?? ''));
            return !Number.isFinite(expiresAt) || expiresAt > now;
        });
    }

    /**
     * Patch 1A — session creation is now DB-AUTHORITATIVE.
     *
     * Previously this performed a direct client INSERT supplying customer_id,
     * suggested_fare, round_count and expires_at itself. A repeat click surfaced
     * a raw 23505 from the job_id UNIQUE constraint, and the client was trusted
     * for identity and reference fare.
     *
     * `create_customer_offer` now derives identity from auth.uid(), the
     * reference fare from the persisted job, the expiry from the configured
     * timeout, and returns a controlled domain error for a duplicate
     * outstanding offer. `customerId`/`suggestedFare` are no longer accepted,
     * because neither may be supplied as authority by the client.
     */
    async createCustomerOffer(jobId: string, amount: number): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('create_customer_offer', {
            p_job_id: jobId,
            p_amount: amount
        });

        if (error) throw new Error(acquisitionErrorMessage(error, 'This offer could not be sent.'));
        const session = data as MarketplaceNegotiationSession;

        // Notification stays BEST-EFFORT and only after the authoritative mutation.
        await this.notify({ action: 'notify_drivers', jobId });
        return session;
    }

    async claimSession(jobId: string, driverId: string): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('claim_marketplace_negotiation', {
            p_job_id: jobId,
            p_driver_id: driverId
        });

        if (error) throw new Error(acquisitionErrorMessage(error, 'This job is no longer available to claim.'));
        const session = data as MarketplaceNegotiationSession;

        if (session?.customer_id) {
            await this.notify({
                action: 'notify',
                jobId,
                recipientUserId: session.customer_id,
                title: 'A driver is negotiating',
                body: 'A driver has started negotiating your fare. Open the app to review.',
                data: { action: 'driver_claimed' }
            });
        }

        return session;
    }

    async releaseSession(jobId: string, driverId: string, reason: 'pass' | 'decline' | 'timeout' | 'offline' | 'incompatible'): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('release_marketplace_negotiation', {
            p_job_id: jobId,
            p_driver_id: driverId,
            p_reason: reason
        });

        if (error) throw error;
        const session = data as MarketplaceNegotiationSession;

        await this.notify({ action: 'notify_drivers', jobId });
        return session;
    }

    async lockFare(jobId: string, driverId: string, amount: number): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('lock_marketplace_fare', {
            p_job_id: jobId,
            p_driver_id: driverId,
            p_amount: amount
        });

        if (error) throw new Error(acquisitionErrorMessage(error, 'This fare could not be locked.'));
        const session = data as MarketplaceNegotiationSession;

        if (session?.customer_id) {
            await this.notify({
                action: 'notify',
                jobId,
                recipientUserId: session.customer_id,
                title: 'Fare agreed!',
                body: 'Your fare has been agreed. Complete payment to confirm your booking.',
                data: { action: 'fare_agreed' }
            });
        }

        return session;
    }

    /**
     * Patch 1A — driver counter is now DB-AUTHORITATIVE.
     * The RPC derives the actor from auth.uid() and requires it to equal the
     * session's active_driver_id, enforces turn (the live proposal must be the
     * customer's), expiry and the configured maxRounds, and writes the session
     * mutation and the `driver_counter` event atomically.
     *
     * `message` is retained only for call-site compatibility; the authoritative
     * event is owned by the RPC and is no longer client-supplied.
     */
    async driverCounterOffer(sessionId: string, amount: number, message?: string): Promise<MarketplaceNegotiationSession> {
        void message;
        const { data, error } = await this.rpc('driver_counter_offer', {
            p_session_id: sessionId,
            p_amount: amount
        });

        if (error) throw new Error(acquisitionErrorMessage(error, 'This counter-offer could not be sent.'));
        const session = data as MarketplaceNegotiationSession;

        if (session?.customer_id) {
            await this.notify({
                action: 'notify',
                jobId: session.job_id,
                recipientUserId: session.customer_id,
                title: 'Driver counter offer',
                body: `A driver has countered with ${this.formatCurrency(amount)}. Open the app to review.`,
                data: { action: 'driver_counter', amount }
            });
        }

        return session;
    }

    /**
     * Patch 1A — customer counter is now DB-AUTHORITATIVE.
     * The RPC requires the live proposal to belong to the DRIVER, so a customer
     * cannot counter twice consecutively, and enforces expiry and maxRounds.
     */
    async customerCounterOffer(sessionId: string, amount: number): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('customer_counter_offer', {
            p_session_id: sessionId,
            p_amount: amount
        });

        if (error) throw new Error(acquisitionErrorMessage(error, 'This counter-offer could not be sent.'));
        const session = data as MarketplaceNegotiationSession;

        if (session?.active_driver_id) {
            await this.notify({
                action: 'notify',
                jobId: session.job_id,
                recipientUserId: session.active_driver_id,
                title: 'Customer counter offer',
                body: 'The customer has sent a new counter offer. Open the app to review.',
                data: { action: 'customer_counter', amount }
            });
        }

        return session;
    }

    /**
     * Patch 1A — AUTHORITY INVERSION FIXED.
     *
     * This previously called `lockFare(session.job_id, session.active_driver_id, amount)`,
     * i.e. the CUSTOMER invoked the DRIVER-authority `lock_marketplace_fare` RPC while
     * passing the driver's UUID. The RPC's precondition was satisfied because it compared
     * active_driver_id to the id the caller had just supplied, so a customer obtained
     * driver authority by supplying a driver UUID.
     *
     * Now the customer calls a CUSTOMER-authority transition whose actor is auth.uid()
     * and whose agreed fare is read from the persisted session.driver_counter_offer —
     * no amount and no driver id is accepted from the client.
     */
    async acceptDriverCounter(sessionId: string): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('customer_accept_driver_counter', {
            p_session_id: sessionId
        });

        if (error) throw new Error(acquisitionErrorMessage(error, 'This counter-offer could not be accepted.'));
        const session = data as MarketplaceNegotiationSession;

        await this.notifyFareAgreed(session);
        return session;
    }

    /**
     * Patch 1A — driver accepts the customer's live offer.
     * Actor = auth.uid(), which the RPC requires to equal active_driver_id; the agreed
     * fare is read from the persisted session.customer_offer, never from the client.
     */
    async acceptCustomerOffer(sessionId: string): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('driver_accept_customer_offer', {
            p_session_id: sessionId
        });

        if (error) throw new Error(acquisitionErrorMessage(error, 'This offer could not be accepted.'));
        const session = data as MarketplaceNegotiationSession;

        await this.notifyFareAgreed(session);
        return session;
    }

    /** Best-effort customer notification after an authoritative agreement. */
    private async notifyFareAgreed(session: MarketplaceNegotiationSession | null | undefined): Promise<void> {
        if (!session?.customer_id) return;
        await this.notify({
            action: 'notify',
            jobId: session.job_id,
            recipientUserId: session.customer_id,
            title: 'Fare agreed!',
            body: 'Your fare has been agreed. Complete payment to confirm your booking.',
            data: { action: 'fare_agreed' }
        });
    }

    /**
     * Patch 1A — CUSTOMER CANCEL OFFER (terminal withdrawal before agreement).
     * Replaces the previous direct client UPDATE that rewrote status and
     * active_driver_id itself. Reuses event_type='customer_decline' with the
     * exact message 'Customer cancelled offer' — no new event taxonomy.
     */
    async customerCancelOffer(sessionId: string): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('customer_cancel_offer', {
            p_session_id: sessionId
        });

        if (error) throw new Error(acquisitionErrorMessage(error, 'This offer could not be cancelled.'));
        return data as MarketplaceNegotiationSession;
    }

    /**
     * Patch 1A — CUSTOMER DECLINE DRIVER COUNTER.
     * NOT a cancellation: the booking stays alive and the request is released back to
     * the opportunity pool with the customer's own offer retained. Distinguished from
     * cancel by the RPC invoked, the exact message, and the resulting session status.
     */
    async customerDeclineCounter(sessionId: string): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('customer_decline_counter', {
            p_session_id: sessionId
        });

        if (error) throw new Error(acquisitionErrorMessage(error, 'This counter-offer could not be declined.'));
        return data as MarketplaceNegotiationSession;
    }

    private formatCurrency(amount: number): string {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount);
    }

    /**
     * Fire a hybrid negotiation notification.
     *
     * ROUTE: must be `/api/booking/notify-hybrid`. `environment.apiUrl` is
     * `https://movabi-api.apps.evolsolution.com` with NO `/api` suffix, and
     * getApiUrl only concatenates, so a path of `/booking/notify-hybrid`
     * resolves to `.../booking/notify-hybrid` and misses the Express mount
     * `app.use('/api/booking', bookingRoutes)`. That returned a 404 which this
     * method previously discarded.
     *
     * FAILURE SEMANTICS: notification is a SECONDARY side effect. Every caller
     * has already committed its negotiation mutation (claim / counter / lockFare
     * / release) before calling this, so a delivery failure must never be
     * reported as a failure of that mutation. Non-2xx responses and transport
     * errors are therefore surfaced DIAGNOSTICALLY via console.error/warn and
     * swallowed deliberately - this method must not reject, or callers would
     * convert a successful negotiation into a user-visible "accept failed".
     *
     * No retries here by design.
     */
    private async notify(payload: { action: 'notify_drivers'; jobId: string; } | { action: 'notify'; jobId: string; recipientUserId: string | null; title: string; body: string; data?: Record<string, any>; }): Promise<void> {
        const token = this.auth.session()?.access_token;
        if (!token) return;

        if (payload.action === 'notify' && !payload.recipientUserId) return;

        const url = this.apiUrl.getApiUrl('/api/booking/notify-hybrid');

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            // A 404/500 resolves normally, so it must be checked explicitly.
            if (!response.ok) {
                let detail = '';
                try {
                    detail = (await response.text()).slice(0, 300);
                } catch {
                    detail = '(response body unreadable)';
                }

                console.error(
                    `[MarketplaceHybridService] notify failed: HTTP ${response.status} ${response.statusText} ` +
                    `for ${payload.action} on ${url}${detail ? ` - ${detail}` : ''}`
                );
            }
        } catch (error) {
            // Transport-level failure only; the negotiation mutation stands.
            console.warn('[MarketplaceHybridService] notify request failed', { url, action: payload.action, error });
        }
    }

    // Patch 1A: the direct-client event writer (`addEvent`) was REMOVED. Every
    // negotiation event is now written inside an authoritative SECURITY DEFINER
    // transition, so no client-side event INSERT path remains. The matching
    // `hybrid_events_participants_insert` RLS policy is dropped in
    // 20261231000000_negotiation_lifecycle_authority.sql.

    async fetchHybridOpportunities(driverId: string): Promise<HybridOpportunity[]> {
        const { data, error } = await this.supabase
            .rpc('fetch_hybrid_opportunities', { p_driver_id: driverId });

        if (error) throw error;
        return (data as HybridOpportunity[] | null) ?? [];
    }

    subscribeToSession(sessionId: string, callback: (payload: any) => void) {
        return this.supabase
            .channel(`hybrid-session-${sessionId}`)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'marketplace_negotiation_sessions',
                filter: `id=eq.${sessionId}`
            }, callback)
            .subscribe();
    }

    subscribeToEvents(sessionId: string, callback: (payload: any) => void) {
        return this.supabase
            .channel(`hybrid-events-${sessionId}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'marketplace_negotiation_events',
                filter: `session_id=eq.${sessionId}`
            }, callback)
            .subscribe();
    }
}
