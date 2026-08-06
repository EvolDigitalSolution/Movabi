import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiUrlService } from '../api-url.service';
import { SupabaseService } from '../supabase/supabase.service';

export type DriverOnboardingItemStatus = 'pending' | 'approved' | 'rejected';
export interface DriverOutstandingRequest {
    id: string; item: string; status: DriverOnboardingItemStatus; adminMessage: string;
    submittedAt: string | null; updatedAt: string | null; nextAction: string;
}
export interface DriverOnboardingStatus {
    driverId: string; registrationAllowed: boolean; overallStatus: 'not_started'|'incomplete'|'ready_to_submit'|'under_review'|'action_required'|'approved'|'paused';
    profile: Record<string, unknown>; canonicalProfile: CanonicalDriverProfile; vehicle: DriverVehicle | null;
    outstandingRequests: DriverOutstandingRequest[]; submissionHistory: unknown[];
    stripeStatus: string; updatedAt: string | null;
    automaticRequirements: DriverAutomaticRequirement[]; adminRequests: DriverAdminRequest[]; warnings: DriverAutomaticRequirement[];
    progress: { completed: number; total: number }; onlineEligibility: { allowed: boolean; reasons: string[] };
    selectedServices: Array<'ride'|'delivery'|'errand'|'van-moving'>; vehicleType: string|null;
    age: { eligible: boolean; years: number|null; minimum: number; reason: string|null };
}
export interface CanonicalDriverProfile {id:string;fullName:string|null;phone:string|null;dateOfBirth:string|null;residentialAddress:string|null;emailConfirmed:boolean;verificationStatus:string|null;}
export interface DriverVehicle { id:string;userId:string;type:string;make:string|null;model:string|null;colour:string|null;year:number|null;registrationNumber:string|null;capacity:string|null;serviceEligibility:string[];status:string; }
export interface DriverAutomaticRequirement { code:string;label:string;category:'basic'|'services'|'vehicle'|'documents'|'agreement'|'licensing';status:string;required:boolean;completed:boolean;blockingForSubmission:boolean;blockingForOnline:boolean;needsAdminReview:boolean;reason:string;services:string[]; }
export interface DriverAdminRequest { id:string;requirementCode:string;item:string;status:'pending'|'rejected'|'approved';publicMessage:string;submittedAt:string|null;updatedAt:string|null;resolvedAt:string|null;nextAction:string; }
export type DriverOnboardingEventType =
    | 'driver_registration_started' | 'driver_onboarding_submitted' | 'driver_vehicle_submitted'
    | 'driver_vehicle_updated' | 'driver_document_uploaded' | 'driver_document_replaced'
    | 'driver_document_resubmitted' | 'driver_stripe_connected' | 'driver_profile_updated_for_review';

@Injectable({ providedIn: 'root' })
export class DriverOnboardingStatusService {
    private http = inject(HttpClient);
    private api = inject(ApiUrlService);
    private supabase = inject(SupabaseService);
    readonly state = signal<DriverOnboardingStatus | null>(null);
    readonly loading = signal(false);
    readonly error = signal<string | null>(null);
    private inFlight: Promise<DriverOnboardingStatus> | null = null;
    private registrationStartRecorded = false;

    refresh(): Promise<DriverOnboardingStatus> {
        if (this.inFlight) return this.inFlight;
        this.loading.set(true); this.error.set(null);
        this.inFlight = this.authenticatedGet(true).then(status => { this.state.set(status); return status; })
            .catch((error: unknown) => { const message = error instanceof Error ? error.message : 'Unable to load onboarding status.'; this.error.set(message); throw error; })
            .finally(() => { this.loading.set(false); this.inFlight = null; });
        return this.inFlight;
    }

    async recordEvent(eventType: DriverOnboardingEventType, affectedItem: string, previousStatus?: string | null, newStatus?: string | null): Promise<void> {
        const eventKey = `${eventType}:${crypto.randomUUID()}`;
        try {
            await this.authenticatedPost('/api/driver-onboarding/events', { eventKey, eventType, affectedItem, previousStatus, newStatus }, true);
        } catch (error) {
            console.warn('[DriverOnboardingStatus] Admin notification could not be queued; onboarding mutation remains saved.', error);
        }
    }

    async recordRegistrationStartOnce(): Promise<void> {
        const status = this.state();
        if (!status || status.overallStatus !== 'not_started' || this.registrationStartRecorded) return;
        this.registrationStartRecorded = true;
        try {
            await this.authenticatedPost('/api/driver-onboarding/events', {
                eventKey: `registration:${status.driverId}`, eventType: 'driver_registration_started',
                affectedItem: 'driver_registration', previousStatus: null, newStatus: 'draft'
            }, true);
        } catch (error) {
            this.registrationStartRecorded = false;
            console.warn('[DriverOnboardingStatus] Registration-start notification could not be queued.', error);
        }
    }

    async validateSubmission(profile:Record<string,unknown>,vehicle:Record<string,unknown>):Promise<void>{await this.authenticatedPost('/api/driver-onboarding/validate-submission',{profile,vehicle},true);}
    async saveResidentialAddress(residentialAddress:string):Promise<CanonicalDriverProfile>{return this.authenticatedPut<{profile:CanonicalDriverProfile}>('/api/driver-onboarding/profile',{residentialAddress},true).then(result=>result.profile);}

    private async authenticatedGet(allowRefresh: boolean): Promise<DriverOnboardingStatus> {
        const token = await this.accessToken();
        try {
            return await firstValueFrom(this.http.get<DriverOnboardingStatus>(this.api.getApiUrl('/api/driver-onboarding/status'), { headers: this.headers(token) }));
        } catch (error) {
            if (allowRefresh && error instanceof HttpErrorResponse && error.status === 401) {
                const { data, error: refreshError } = await this.supabase.auth.refreshSession();
                if (refreshError || !data.session?.access_token) throw new Error('Your session expired. Please sign in again.');
                return this.authenticatedGet(false);
            }
            if (error instanceof HttpErrorResponse && error.status === 401) throw new Error('Your session expired. Please sign in again.');
            throw error;
        }
    }

    private async authenticatedPost(path: string, body: object, allowRefresh: boolean): Promise<void> {
        const token = await this.accessToken();
        try { await firstValueFrom(this.http.post(this.api.getApiUrl(path), body, { headers: this.headers(token) })); }
        catch (error) {
            if (allowRefresh && error instanceof HttpErrorResponse && error.status === 401) {
                const { data, error: refreshError } = await this.supabase.auth.refreshSession();
                if (refreshError || !data.session?.access_token) throw new Error('Your session expired. Please sign in again.');
                return this.authenticatedPost(path, body, false);
            }
            throw error;
        }
    }
    private async authenticatedPut<T>(path:string,body:object,allowRefresh:boolean):Promise<T>{const token=await this.accessToken();try{return await firstValueFrom(this.http.put<T>(this.api.getApiUrl(path),body,{headers:this.headers(token)}));}catch(error){if(allowRefresh&&error instanceof HttpErrorResponse&&error.status===401){const{data,error:refreshError}=await this.supabase.auth.refreshSession();if(refreshError||!data.session?.access_token)throw new Error('Your session expired. Please sign in again.');return this.authenticatedPut<T>(path,body,false);}if(error instanceof HttpErrorResponse){const detail=error.error as {error?:unknown}|null;throw new Error(String(detail?.error||'Profile could not be saved. Please retry.'));}throw error;}}
    private async accessToken(): Promise<string> { const { data } = await this.supabase.auth.getSession(); if (!data.session?.access_token) throw new Error('Please sign in again.'); return data.session.access_token; }
    private headers(token: string): HttpHeaders { return new HttpHeaders({ Authorization: `Bearer ${token}` }); }
}
