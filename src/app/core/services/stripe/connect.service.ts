import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { defer, firstValueFrom, Subject, switchMap, timeout } from 'rxjs';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
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
    readonly returnedToApp = new Subject<void>();

    constructor() {
        if (Capacitor.isNativePlatform()) {
            void Browser.addListener('browserFinished',()=>this.returnedToApp.next()).catch(error=>console.warn('[Connect] Browser return listener failed',error));
            void App.addListener('appStateChange', ({ isActive }) => {
                if (isActive) this.returnedToApp.next();
            }).catch(error => console.warn('[Connect] Resume listener failed', error));
        } else if (typeof window !== 'undefined') {
            window.addEventListener('focus', () => this.returnedToApp.next());
        }
    }

    prepareDashboardTab(): Window | null {
        if(Capacitor.isNativePlatform())return null;
        const tab=window.open('about:blank','_blank');
        if(!tab)throw new Error('Allow popups, then tap Stripe Payouts again.');
        try {
            tab.opener=null;
            tab.document.title='Opening Stripe';
            tab.document.body.textContent='Opening your Stripe payout dashboard…';
            return tab;
        }catch(error){tab.close();throw error;}
    }

    async openDashboard(url: string, tab: Window | null): Promise<void> {
        try {
            const parsed=new URL(url);
            if(parsed.protocol!=='https:' || parsed.username || parsed.password || !(parsed.hostname==='stripe.com'||parsed.hostname.endsWith('.stripe.com'))){
                throw new Error('Invalid Stripe dashboard URL');
            }
            if(Capacitor.isNativePlatform()){
                await Browser.open({url,windowName:'_blank'});
            }else{
                if(!tab || tab.closed)throw new Error('The Stripe tab was closed or blocked. Tap Stripe Payouts again.');
                tab.location.href=url;
                tab.focus();
            }
        }catch(error){tab?.close();throw error;}
    }

    async openOnboarding(url: string): Promise<void> {
        if (Capacitor.isNativePlatform()) {
            const { Browser } = await import('@capacitor/browser');
            await Browser.open({ url });
        } else {
            window.location.href = url;
        }
    }

    private payoutSettingsInFlightForced = false;
    private payoutSettingsInFlight: Promise<PayoutSettingsResponse> | null = null;
    private payoutSettingsCache: { value: PayoutSettingsResponse; expiresAt: number } | null = null;
    private readonly payoutSettingsCacheMs = 10_000;

    async createAccount(userId: string, email: string, tenantId?: string | null) {
        const result = await firstValueFrom(
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
        this.invalidatePayoutSettingsCache();
        return result;
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
            defer(() => this.getAuthHeaders()).pipe(
                switchMap(headers => this.http.post<{ url: string }>(
                    `${this.apiUrl}/dashboard-link`, { accountId }, { headers }
                )),
                timeout(15000)
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
        const result = await firstValueFrom(
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
        this.invalidatePayoutSettingsCache();
        return result;
    }

    getPayoutSettings(force = false): Promise<PayoutSettingsResponse> {
        if (this.payoutSettingsInFlight) {
            if (!force || this.payoutSettingsInFlightForced) return this.payoutSettingsInFlight;
            return this.payoutSettingsInFlight.catch(() => undefined)
                .then(() => this.getPayoutSettings(true));
        }
        if (!force && this.payoutSettingsCache && this.payoutSettingsCache.expiresAt > Date.now()) {
            return Promise.resolve(this.payoutSettingsCache.value);
        }

        this.payoutSettingsInFlightForced = force;
        const request = (async () => firstValueFrom(
            this.http.get<PayoutSettingsResponse>(
                `${this.apiUrl}/payout-settings`,
                { headers: await this.getAuthHeaders() }
            )
        ))().then(async value => {
            if (force && value.stripeAccountId) {
                const status = await this.refreshAccountStatus(value.stripeAccountId);
                value = {
                    ...value,
                    connectStatus: status.status,
                    chargesEnabled: status.charges_enabled === true,
                    payoutsEnabled: status.payouts_enabled === true,
                    detailsSubmitted: status.details_submitted === true,
                    requirementsCurrentlyDue: status.requirements?.currently_due || []
                };
            }
            this.payoutSettingsCache = { value, expiresAt: Date.now() + this.payoutSettingsCacheMs };
            return value;
        }).finally(() => {
            this.payoutSettingsInFlight = null;
        });
        this.payoutSettingsInFlight = request;
        return request;
    }

    invalidatePayoutSettingsCache(): void { this.payoutSettingsCache = null; }

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
