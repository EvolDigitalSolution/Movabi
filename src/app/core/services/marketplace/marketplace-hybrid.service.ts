import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { ApiUrlService } from '../api-url.service';
import { MarketplaceConfigService, MarketplaceHybridNegotiationSettings } from './marketplace-config.service';
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

    private getHybridSettings() {
        return this.config.settingsSignal()?.hybridNegotiation;
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
        return this.getHybridSettings() ?? this.defaultSettings();
    }

    private currentMarketplaceSettings() {
        return this.config.settingsSignal() ?? this.config.defaultSettings();
    }

    isEnabled(): boolean {
        return this.isHybridEnabledForUser(this.userId);
    }

    isServiceEnabled(serviceSlug: string, distanceKm?: number | null): boolean {
        const settings = this.settings();
        const allSettings = this.currentMarketplaceSettings();
        const emergency = allSettings.emergencyControls ?? {};
        const enabledServices = settings.enabledServices?.length
            ? settings.enabledServices
            : DEFAULT_HYBRID_ENABLED_SERVICES;
        const canonical = this.canonicalServiceSlug(serviceSlug);

        if (!allSettings.marketplaceEnabled || emergency.disableMarketplaceGlobally || emergency.forceNormalBookingFlow || emergency.disableHybridNegotiation) {
            return false;
        }

        if (emergency.disableByService?.[canonical]) {
            return false;
        }

        const serviceRules = allSettings.serviceRules ?? {};
        const rule = serviceRules[canonical] || (canonical === 'errand' ? serviceRules['shop'] : undefined);
        if (rule && (rule.enabled === false || rule.marketplaceEnabled === false || rule.negotiationEnabled === false)) {
            return false;
        }

        const canonicalList = enabledServices.map((s: string) => this.canonicalServiceSlug(s));
        if (!canonicalList.includes(canonical)) {
            return false;
        }
        if (canonical === 'ride' && distanceKm !== undefined && distanceKm !== null && distanceKm < settings.rideMinimumDistanceKm) {
            return false;
        }
        return true;
    }

    isHybridEnabledForUser(
        userId: string | null | undefined,
        serviceSlug?: string | null,
        distanceKm?: number | null
    ): boolean {
        if (!userId) {
            console.log('[HybridMarketplace] disabled: no user id');
            return false;
        }

        const settings = this.settings();
        const allSettings = this.currentMarketplaceSettings();
        const emergency = allSettings.emergencyControls ?? {};

        if (!allSettings.marketplaceEnabled) {
            console.log('[HybridMarketplace] disabled: marketplace disabled');
            return false;
        }

        if (emergency.disableMarketplaceGlobally || emergency.forceNormalBookingFlow || emergency.disableHybridNegotiation) {
            console.log('[HybridMarketplace] disabled: emergency override');
            return false;
        }

        if (!settings.enabled) {
            console.log('[HybridMarketplace] disabled: hybrid disabled');
            return false;
        }

        if (serviceSlug !== undefined && serviceSlug !== null && !this.isServiceEnabled(serviceSlug, distanceKm)) {
            console.log('[HybridMarketplace] disabled: service disabled');
            return false;
        }

        console.log('[HybridMarketplace] enabled');
        return true;
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

    async createCustomerOffer(jobId: string, customerId: string, amount: number, suggestedFare: number): Promise<MarketplaceNegotiationSession> {
        const expiresAt = new Date(Date.now() + this.getNegotiationTimeoutSeconds() * 1000).toISOString();
        const { data, error } = await this.supabase
            .from('marketplace_negotiation_sessions')
            .insert({
                job_id: jobId,
                customer_id: customerId,
                status: 'open',
                suggested_fare: suggestedFare,
                customer_offer: amount,
                driver_counter_offer: null,
                agreed_fare: null,
                round_count: 1,
                attempt_count: 0,
                expires_at: expiresAt
            } as any)
            .select()
            .single();

        if (error) throw error;
        const session = data as MarketplaceNegotiationSession;

        await this.addEvent({
            session_id: session.id,
            job_id: jobId,
            proposed_by: customerId,
            proposed_by_role: 'customer',
            event_type: 'customer_offer',
            amount,
            message: 'Customer offer',
            round_number: 1
        });

        await this.notify({ action: 'notify_drivers', jobId });
        return session;
    }

    async claimSession(jobId: string, driverId: string): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('claim_marketplace_negotiation', {
            p_job_id: jobId,
            p_driver_id: driverId
        });

        if (error) throw error;
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

        if (error) throw error;
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

    async driverCounterOffer(sessionId: string, amount: number, message?: string): Promise<MarketplaceNegotiationSession> {
        const userId = this.userId;
        if (!userId) throw new Error('Authentication required');

        const session = await this.getSessionById(sessionId);
        if (!session) throw new Error('Session not found');

        const nextRound = (session.round_count || 0) + 1;
        if (nextRound > this.getMaxRounds()) {
            throw new Error('Maximum negotiation rounds reached');
        }

        const { data, error } = await this.supabase
            .from('marketplace_negotiation_sessions')
            .update({
                driver_counter_offer: amount,
                status: 'negotiating',
                round_count: nextRound,
                expires_at: new Date(Date.now() + this.getNegotiationTimeoutSeconds() * 1000).toISOString(),
                updated_at: new Date().toISOString()
            } as any)
            .eq('id', sessionId)
            .select()
            .single();

        if (error) throw error;

        await this.addEvent({
            session_id: sessionId,
            job_id: session.job_id,
            proposed_by: userId,
            proposed_by_role: 'driver',
            event_type: 'driver_counter',
            amount,
            message: message || 'Driver counter offer',
            round_number: nextRound
        });

        await this.notify({
            action: 'notify',
            jobId: session.job_id,
            recipientUserId: session.customer_id,
            title: 'Driver counter offer',
            body: `A driver has countered with ${this.formatCurrency(amount)}. Open the app to review.`,
            data: { action: 'driver_counter', amount }
        });

        return data as MarketplaceNegotiationSession;
    }

    async customerCounterOffer(sessionId: string, amount: number): Promise<MarketplaceNegotiationSession> {
        const userId = this.userId;
        if (!userId) throw new Error('Authentication required');

        const session = await this.getSessionById(sessionId);
        if (!session) throw new Error('Session not found');

        const nextRound = (session.round_count || 0) + 1;
        if (nextRound > this.getMaxRounds()) {
            throw new Error('Maximum negotiation rounds reached');
        }

        const { data, error } = await this.supabase
            .from('marketplace_negotiation_sessions')
            .update({
                customer_offer: amount,
                status: 'negotiating',
                round_count: nextRound,
                expires_at: new Date(Date.now() + this.getNegotiationTimeoutSeconds() * 1000).toISOString(),
                updated_at: new Date().toISOString()
            } as any)
            .eq('id', sessionId)
            .select()
            .single();

        if (error) throw error;

        await this.addEvent({
            session_id: sessionId,
            job_id: session.job_id,
            proposed_by: userId,
            proposed_by_role: 'customer',
            event_type: 'customer_offer',
            amount,
            message: 'Customer counter offer',
            round_number: nextRound
        });

        await this.notify({
            action: 'notify',
            jobId: session.job_id,
            recipientUserId: session.active_driver_id,
            title: 'Customer counter offer',
            body: 'The customer has sent a new counter offer. Open the app to review.',
            data: { action: 'customer_counter', amount }
        });

        return data as MarketplaceNegotiationSession;
    }

    async acceptDriverCounter(sessionId: string, amount: number): Promise<MarketplaceNegotiationSession> {
        const userId = this.userId;
        if (!userId) throw new Error('Authentication required');

        const session = await this.getSessionById(sessionId);
        if (!session) throw new Error('Session not found');

        return this.lockFare(session.job_id, session.active_driver_id || '', amount);
    }

    async acceptCustomerOffer(sessionId: string): Promise<MarketplaceNegotiationSession> {
        const session = await this.getSessionById(sessionId);
        if (!session) throw new Error('Session not found');

        const amount = session.customer_offer ?? session.suggested_fare;
        return this.lockFare(session.job_id, session.active_driver_id || '', amount);
    }

    async customerDecline(sessionId: string): Promise<MarketplaceNegotiationSession> {
        const userId = this.userId;
        if (!userId) throw new Error('Authentication required');

        const session = await this.getSessionById(sessionId);
        if (!session) throw new Error('Session not found');

        const { data, error } = await this.supabase
            .from('marketplace_negotiation_sessions')
            .update({
                status: 'customer_declined',
                active_driver_id: null,
                updated_at: new Date().toISOString()
            } as any)
            .eq('id', sessionId)
            .select()
            .single();

        if (error) throw error;

        await this.addEvent({
            session_id: sessionId,
            job_id: session.job_id,
            proposed_by: userId,
            proposed_by_role: 'customer',
            event_type: 'customer_decline',
            amount: null,
            message: 'Customer declined',
            round_number: session.round_count
        });

        return data as MarketplaceNegotiationSession;
    }

    private formatCurrency(amount: number): string {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount);
    }

    private async notify(payload: { action: 'notify_drivers'; jobId: string; } | { action: 'notify'; jobId: string; recipientUserId: string | null; title: string; body: string; data?: Record<string, any>; }): Promise<void> {
        const token = this.auth.session()?.access_token;
        if (!token) return;

        if (payload.action === 'notify' && !payload.recipientUserId) return;

        try {
            await fetch(this.apiUrl.getApiUrl('/booking/notify-hybrid'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });
        } catch (error) {
            console.warn('[MarketplaceHybridService] notify failed', error);
        }
    }

    async addEvent(event: Omit<MarketplaceNegotiationEvent, 'id' | 'created_at'>): Promise<void> {
        const { error } = await this.supabase
            .from('marketplace_negotiation_events')
            .insert(event as any);

        if (error) throw error;
    }

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
