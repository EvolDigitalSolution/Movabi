import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiUrlService } from '../api-url.service';

export interface StripeConnectStatusResponse {
    stripe_account_id: string;
    onboarding_complete: boolean;
    payouts_enabled: boolean;
    charges_enabled: boolean;
    details_submitted?: boolean;
    status: 'not_started' | 'pending' | 'restricted' | 'enabled' | 'connected';
    requirements?: {
        currently_due?: string[];
        eventually_due?: string[];
        past_due?: string[];
        pending_verification?: string[];
        disabled_reason?: string | null;
    };
}

@Injectable({
    providedIn: 'root'
})
export class ConnectService {
    private http = inject(HttpClient);
    private apiUrlService = inject(ApiUrlService);
    private apiUrl = this.apiUrlService.getApiUrl('/api/connect');

    async createAccount(userId: string, email: string, tenantId?: string | null) {
        return firstValueFrom(
            this.http.post<{ stripe_account_id: string; status?: StripeConnectStatusResponse }>(
                `${this.apiUrl}/create-account`,
                {
                    userId,
                    email,
                    tenantId: tenantId || null
                }
            )
        );
    }

    async getOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string) {
        return firstValueFrom(
            this.http.post<{ url: string }>(`${this.apiUrl}/onboarding-link`, {
                accountId,
                returnUrl,
                refreshUrl
            })
        );
    }

    async getDashboardLink(accountId: string) {
        return firstValueFrom(
            this.http.post<{ url: string }>(`${this.apiUrl}/dashboard-link`, {
                accountId
            })
        );
    }

    async getAccountStatus(accountId: string) {
        return firstValueFrom(
            this.http.get<StripeConnectStatusResponse>(
                `${this.apiUrl}/account-status/${accountId}`
            )
        );
    }

    async refreshAccountStatus(accountId: string, userId?: string) {
        return firstValueFrom(
            this.http.post<StripeConnectStatusResponse>(
                `${this.apiUrl}/refresh-account-status`,
                {
                    accountId,
                    userId
                }
            )
        );
    }
}