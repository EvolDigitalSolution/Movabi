import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import {
    HYBRID_MARKETPLACE_ENABLED,
    HYBRID_ELIGIBLE_SERVICES,
    HYBRID_MAX_ROUNDS,
    HYBRID_NEGOTIATION_TIMEOUT_SECONDS,
    HYBRID_MAX_DRIVER_ATTEMPTS,
    HYBRID_LONG_DISTANCE_RIDE_KM
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

    private rpc(name: string, args?: Record<string, unknown>) {
        return this.supabase.rpc(name, args);
    }

    private get userId() {
        return this.auth.currentUser()?.id;
    }

    isEnabled(): boolean {
        return HYBRID_MARKETPLACE_ENABLED;
    }

    isServiceEligible(serviceSlug: string): boolean {
        if (!HYBRID_MARKETPLACE_ENABLED) return false;
        const slug = String(serviceSlug || '').toLowerCase().replace(/[-\s]/g, '_');
        return HYBRID_ELIGIBLE_SERVICES.includes(slug);
    }

    isLongDistanceRide(distanceKm: number): boolean {
        return distanceKm >= HYBRID_LONG_DISTANCE_RIDE_KM;
    }

    getNegotiationTimeoutSeconds(): number {
        return HYBRID_NEGOTIATION_TIMEOUT_SECONDS;
    }

    getMaxRounds(): number {
        return HYBRID_MAX_ROUNDS;
    }

    getMaxDriverAttempts(): number {
        return HYBRID_MAX_DRIVER_ATTEMPTS;
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
        const expiresAt = new Date(Date.now() + HYBRID_NEGOTIATION_TIMEOUT_SECONDS * 1000).toISOString();
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

        return session;
    }

    async claimSession(jobId: string, driverId: string): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('claim_marketplace_negotiation', {
            p_job_id: jobId,
            p_driver_id: driverId
        });

        if (error) throw error;
        return data as MarketplaceNegotiationSession;
    }

    async releaseSession(jobId: string, driverId: string, reason: 'pass' | 'decline' | 'timeout' | 'offline' | 'incompatible'): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('release_marketplace_negotiation', {
            p_job_id: jobId,
            p_driver_id: driverId,
            p_reason: reason
        });

        if (error) throw error;
        return data as MarketplaceNegotiationSession;
    }

    async lockFare(jobId: string, driverId: string, amount: number): Promise<MarketplaceNegotiationSession> {
        const { data, error } = await this.rpc('lock_marketplace_fare', {
            p_job_id: jobId,
            p_driver_id: driverId,
            p_amount: amount
        });

        if (error) throw error;
        return data as MarketplaceNegotiationSession;
    }

    async driverCounterOffer(sessionId: string, amount: number, message?: string): Promise<MarketplaceNegotiationSession> {
        const userId = this.userId;
        if (!userId) throw new Error('Authentication required');

        const session = await this.getSessionById(sessionId);
        if (!session) throw new Error('Session not found');

        const nextRound = (session.round_count || 0) + 1;
        if (nextRound > HYBRID_MAX_ROUNDS) {
            throw new Error('Maximum negotiation rounds reached');
        }

        const { data, error } = await this.supabase
            .from('marketplace_negotiation_sessions')
            .update({
                driver_counter_offer: amount,
                status: 'negotiating',
                round_count: nextRound,
                expires_at: new Date(Date.now() + HYBRID_NEGOTIATION_TIMEOUT_SECONDS * 1000).toISOString(),
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

        return data as MarketplaceNegotiationSession;
    }

    async customerCounterOffer(sessionId: string, amount: number): Promise<MarketplaceNegotiationSession> {
        const userId = this.userId;
        if (!userId) throw new Error('Authentication required');

        const session = await this.getSessionById(sessionId);
        if (!session) throw new Error('Session not found');

        const nextRound = (session.round_count || 0) + 1;
        if (nextRound > HYBRID_MAX_ROUNDS) {
            throw new Error('Maximum negotiation rounds reached');
        }

        const { data, error } = await this.supabase
            .from('marketplace_negotiation_sessions')
            .update({
                customer_offer: amount,
                status: 'negotiating',
                round_count: nextRound,
                expires_at: new Date(Date.now() + HYBRID_NEGOTIATION_TIMEOUT_SECONDS * 1000).toISOString(),
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
