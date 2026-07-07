import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SupabaseService } from '../supabase/supabase.service';
import { ApiUrlService } from '../api-url.service';

export interface FareNegotiation {
    id: string;
    job_id: string;
    proposed_by: string;
    proposed_by_role: 'customer' | 'driver' | 'system';
    amount: number;
    message?: string;
    status: 'pending' | 'accepted' | 'rejected' | 'countered' | 'expired';
    counter_to_negotiation_id?: string | null;
    round_number: number;
    created_at: string;
    updated_at: string;
    expires_at?: string | null;
}

export interface NegotiationCreatePayload {
    jobId: string;
    amount: number;
    message?: string;
    proposedByRole?: 'customer' | 'driver';
    counterToNegotiationId?: string | null;
}

export interface NegotiationResponsePayload {
    negotiationId: string;
    amount: number;
    message?: string;
}

@Injectable({
    providedIn: 'root'
})
export class MarketplaceNegotiationService {
    private supabase = inject(SupabaseService);
    private http = inject(HttpClient);
    private apiUrlService = inject(ApiUrlService);

    async createNegotiation(payload: NegotiationCreatePayload): Promise<FareNegotiation> {
        const url = this.apiUrlService.getApiUrl('/api/booking/negotiation');
        const result = await firstValueFrom(
            this.http.post<{ negotiation: FareNegotiation }>(url, {
                jobId: payload.jobId,
                amount: payload.amount,
                message: payload.message,
                proposedByRole: payload.proposedByRole || 'customer',
                counterToNegotiationId: payload.counterToNegotiationId || null
            })
        );
        return result.negotiation;
    }

    async getNegotiations(jobId: string): Promise<FareNegotiation[]> {
        const { data, error } = await this.supabase
            .from('fare_negotiations')
            .select('*')
            .eq('job_id', jobId)
            .order('created_at', { ascending: true });

        if (error) throw error;
        return (data || []) as FareNegotiation[];
    }

    async acceptNegotiation(negotiationId: string): Promise<FareNegotiation> {
        const url = this.apiUrlService.getApiUrl(`/api/booking/negotiation/${negotiationId}/accept`);
        const result = await firstValueFrom(
            this.http.post<{ negotiation: FareNegotiation }>(url, {})
        );
        return result.negotiation;
    }

    async counterNegotiation(payload: NegotiationResponsePayload): Promise<FareNegotiation> {
        const url = this.apiUrlService.getApiUrl(`/api/booking/negotiation/${payload.negotiationId}/counter`);
        const result = await firstValueFrom(
            this.http.post<{ negotiation: FareNegotiation }>(url, {
                amount: payload.amount,
                message: payload.message
            })
        );
        return result.negotiation;
    }

    async lockAgreedFare(jobId: string, amount: number): Promise<void> {
        const { error } = await this.supabase
            .from('jobs')
            .update({
                agreed_fare: amount,
                status: 'fare_agreed',
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId);

        if (error) throw error;
    }

    async driverAcceptOffer(jobId: string): Promise<FareNegotiation> {
        const url = this.apiUrlService.getApiUrl(`/api/booking/negotiation/${jobId}/driver-accept`);
        const result = await firstValueFrom(
            this.http.post<{ negotiation: FareNegotiation }>(url, {})
        );
        return result.negotiation;
    }

    async driverCounterOffer(jobId: string, amount: number, message?: string): Promise<FareNegotiation> {
        const url = this.apiUrlService.getApiUrl(`/api/booking/negotiation/${jobId}/driver-counter`);
        const result = await firstValueFrom(
            this.http.post<{ negotiation: FareNegotiation }>(url, { amount, message })
        );
        return result.negotiation;
    }
}
