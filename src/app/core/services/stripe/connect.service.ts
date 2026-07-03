import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { ApiUrlService } from '../api-url.service';
import { SupabaseService } from '../supabase/supabase.service';

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

export interface PayoutSettingsResponse {
    ok: boolean;
    stripeAccountId: string | null;
    connectStatus: 'not_started' | 'pending' | 'restricted' | 'enabled' | 'connected';
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    requirementsCurrentlyDue: string[];
}

type ConnectPlatform = 'web' | 'android' | 'ios' | 'native';

@Injectable({
    providedIn: 'root'
})
export class ConnectService {
    private http = inject(HttpClient);
    private apiUrlService = inject(ApiUrlService);
    private supabase = inject(SupabaseService);

    private apiUrl = this.apiUrlService.getApiUrl('/api/connect');

    async createAccount(userId: string, email: string, tenantId?: string | null) {
        return firstValueFrom(
            this.http.post<{ stripe_account_id: string; status?: StripeConnectStatusResponse }>(
                `${this.apiUrl}/create-account`,
                {
                    userId,
                    email,
                    tenantId: tenantId || null
                },
                {
                    headers: await this.getAuthHeaders()
                }
            )
        );
    }

    async getOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string, platform = this.getConnectPlatform()) {
        return firstValueFrom(
            this.http.post<{ url: string }>(
                `${this.apiUrl}/onboarding-link`,
                {
                    accountId,
                    platform,
                    returnUrl,
                    refreshUrl
                },
                {
                    headers: await this.getAuthHeaders()
                }
            )
        );
    }

    getConnectPlatform(): ConnectPlatform {
        try {
            const platform = Capacitor.getPlatform();

            if (platform === 'android' || platform === 'ios') {
                return platform;
            }
        } catch {
            // Capacitor may be unavailable in web tests.
        }

        return 'web';
    }

    async getDashboardLink(accountId: string) {
        return firstValueFrom(
            this.http.post<{ url: string }>(
                `${this.apiUrl}/dashboard-link`,
                {
                    accountId
                },
                {
                    headers: await this.getAuthHeaders()
                }
            )
        );
    }

    async getAccountStatus(accountId: string) {
        return firstValueFrom(
            this.http.get<StripeConnectStatusResponse>(
                `${this.apiUrl}/account-status/${accountId}`,
                {
                    headers: await this.getAuthHeaders()
                }
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
                },
                {
                    headers: await this.getAuthHeaders()
                }
            )
        );
    }

    async getPayoutSettings() {
        return firstValueFrom(
            this.http.get<PayoutSettingsResponse>(
                `${this.apiUrl}/payout-settings`,
                {
                    headers: await this.getAuthHeaders()
                }
            )
        );
    }

    private async getAuthHeaders(): Promise<HttpHeaders> {
        const token = await this.getAccessToken();

        let headers = new HttpHeaders({
            'Content-Type': 'application/json'
        });

        if (token) {
            headers = headers.set('Authorization', `Bearer ${token}`);
        }

        return headers;
    }

    private async getAccessToken(): Promise<string | null> {
        try {
            // Use the Supabase client to get the current session
            const { data, error } = await this.supabase.client.auth.getSession();
            
            if (error) {
                console.warn('[Connect] Failed to get session:', error.message);
                return null;
            }

            const token = data?.session?.access_token;
            
            if (token) {
                return token;
            }

            console.warn('[Connect] No active session found');
            return null;
        } catch (error) {
            console.warn('[ConnectService] Unable to read Supabase session token:', error);
        }

        return this.getAccessTokenFromLocalStorage();
    }

    private getAccessTokenFromLocalStorage(): string | null {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;

                const value = localStorage.getItem(key);
                if (!value) continue;

                if (!key.includes('supabase') && !key.includes('auth-token')) {
                    continue;
                }

                try {
                    const parsed = JSON.parse(value);

                    const token =
                        parsed?.access_token ||
                        parsed?.currentSession?.access_token ||
                        parsed?.session?.access_token ||
                        parsed?.data?.session?.access_token;

                    if (token) return token;
                } catch {
                    // Ignore non-JSON storage values
                }
            }
        } catch {
            return null;
        }

        return null;
    }
}
