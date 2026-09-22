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
    profile: Record<string, unknown>; canonicalProfile: CanonicalDriverProfile; passengerLicence:DriverPassengerLicence; vehicle: DriverVehicle | null;
    outstandingRequests: DriverOutstandingRequest[]; submissionHistory: unknown[];
    stripeStatus: string; updatedAt: string | null;
    automaticRequirements: DriverAutomaticRequirement[]; adminRequests: DriverAdminRequest[]; warnings: DriverAutomaticRequirement[];
    progress: { completed: number; total: number; percentage:number }; sectionStatus:DriverSetupSectionStatus; onlineEligibility: { allowed: boolean; reasons: string[] };
    selectedServices: Array<'ride'|'delivery'|'errand'|'van-moving'>; vehicleType: string|null;
    age: { eligible: boolean; years: number|null; minimum: number; reason: string|null };
    identityEditability:{dateOfBirthEditable:boolean;reason:string|null};
}
export type DriverSetupSectionState='not_applicable'|'incomplete'|'complete'|'action_required'|'under_review';
export interface DriverSetupSection {applicable:boolean;status:DriverSetupSectionState;}
export interface DriverSetupSectionStatus {basicDetails:DriverSetupSection;services:DriverSetupSection;operatingMethod:DriverSetupSection;vehicle:DriverSetupSection;documents:DriverSetupSection;serviceLicensing:DriverSetupSection;agreement:DriverSetupSection;review:DriverSetupSection;}
export interface CanonicalDriverProfile {id:string;fullName:string|null;phone:string|null;dateOfBirth:string|null;residentialAddress:string|null;emailConfirmed:boolean;verificationStatus:string|null;}
export type DriverOnboardingService = 'ride' | 'delivery' | 'errand' | 'van-moving';
/**
 * Batch 2C Phase B — the canonical eligibility verdict returned by the
 * authenticated endpoint. `authority` states which engine produced it and
 * whether the database trigger is enforcing, so no caller can mistake the
 * mirror for active database enforcement.
 */
export interface DriverEligibilityVerdict {
    driverId: string;
    service: DriverOnboardingService | null;
    resolved: boolean;
    eligible: boolean;
    blockingCodes: string[];
    advisoryCodes: string[];
    authority: { evaluatedBy: string; sqlAuthority: string; enforced: boolean };
}export interface DriverPassengerLicence {councilName:string|null;licenceNumber:string|null;badgeNumber:string|null;expiryDate:string|null;status:string|null;complete:boolean;}
export interface DriverVehicle { id:string;userId:string;type:string;make:string|null;model:string|null;colour:string|null;year:number|null;registrationNumber:string|null;capacity:string|null;serviceEligibility:string[];status:string; }
export interface DriverAutomaticRequirement { code:string;label:string;category:'basic'|'services'|'vehicle'|'documents'|'agreement'|'licensing';status:string;required:boolean;completed:boolean;blockingForSubmission:boolean;blockingForOnline:boolean;needsAdminReview:boolean;reason:string;services:string[]; }
export interface DriverAdminRequest { id:string;requirementCode:string;requestType?:string|null;item:string;status:'pending'|'rejected'|'approved';publicMessage:string;submittedAt:string|null;updatedAt:string|null;resolvedAt:string|null;nextAction:string; }
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

    async submitForReview(profile:Record<string,unknown>):Promise<void>{await this.authenticatedPost('/api/driver-onboarding/submit-review',{profile},true);}

    /**
     * Batch 2C Phase B — server-authoritative resubmission.
     *
     * The client sends ONLY the resubmission flag: no status, no blockers, no
     * notes and no driver id. The endpoint derives the driver from the session,
     * re-validates the requirements server-side and applies the server-defined
     * review state. A driver who still has blockers is refused with 422 and the
     * blocker list instead of being written into a client-chosen state.
     */
    async resubmitForReview():Promise<void>{
        await this.authenticatedPost('/api/driver-onboarding/submit-review',{resubmission:true},true);
        await this.refresh();
    }

    /**
     * Batch 2C Phase B — canonical eligibility verdict for a service.
     *
     * Read-only: the server loads the driver from the session, evaluates the
     * Phase A rule model and returns blocking/advisory CODES. The client can
     * supply the service name and nothing else, and no verdict can be submitted.
     */
    async eligibility(service: DriverOnboardingService):Promise<DriverEligibilityVerdict>{
        const token=await this.accessToken();
        return await firstValueFrom(this.http.get<DriverEligibilityVerdict>(
            this.api.getApiUrl('/api/driver-onboarding/eligibility'),
            {headers:this.headers(token),params:{service}}
        ));
    }
    async saveCurrentProfile(input:{residentialAddress?:string;dateOfBirth?:string}):Promise<CanonicalDriverProfile>{
        const result=await this.authenticatedPut<{profile:CanonicalDriverProfile}>('/api/driver-onboarding/profile',input,true);
        this.state.update(snapshot=>snapshot?{...snapshot,canonicalProfile:result.profile,profile:{...snapshot.profile,current_address:result.profile.residentialAddress,date_of_birth:result.profile.dateOfBirth}}:snapshot);
        return result.profile;
    }
    async saveVerificationItems(input:{bicycleDeclaration:boolean;deliveryEquipmentConfirmed:boolean}):Promise<void>{await this.authenticatedPut<{saved:true}>('/api/driver-onboarding/verification-items',input,true);}
    async savePassengerLicence(input:{councilName:string;licenceNumber:string;badgeNumber:string;expiryDate:string}):Promise<DriverPassengerLicence>{
        const result=await this.authenticatedPut<{passengerLicence:DriverPassengerLicence}>('/api/driver-onboarding/passenger-licence',input,true);
        this.state.update(snapshot=>snapshot?{...snapshot,passengerLicence:result.passengerLicence}:snapshot);
        return result.passengerLicence;
    }
    async saveAgreement(accepted:boolean):Promise<{accepted:boolean;acceptedAt:string|null}>{return this.authenticatedPut<{agreement:{accepted:boolean;acceptedAt:string|null}}>('/api/driver-onboarding/agreement',{accepted},true).then(result=>result.agreement);}
    async requestDobCorrection(reason:string):Promise<void>{await this.authenticatedPost('/api/driver-onboarding/dob-correction-request',{reason},true);await this.refresh();}

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
