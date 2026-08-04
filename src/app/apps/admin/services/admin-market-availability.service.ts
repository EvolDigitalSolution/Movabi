import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiUrlService } from '../../../core/services/api-url.service';
import { SupabaseService } from '../../../core/services/supabase/supabase.service';

export type MarketLaunchStatus =
    | 'disabled'
    | 'coming_soon'
    | 'driver_onboarding'
    | 'customer_beta'
    | 'live'
    | 'paused';

/** Exact snake_case row returned by GET /api/markets/admin. */
export interface MarketAvailabilityRow {
    id: string;
    country_code: string;
    market_city: string | null;
    zone_id: string | null;
    launch_status: MarketLaunchStatus;
    customer_app_enabled: boolean;
    customer_registration_enabled: boolean;
    driver_registration_enabled: boolean;
    driver_online_enabled: boolean;
    quote_enabled: boolean;
    booking_enabled: boolean;
    payment_enabled: boolean;
    waiting_list_enabled: boolean;
    supported_currency: string | null;
    timezone: string | null;
    unavailable_title: string | null;
    unavailable_message: string | null;
    valid_from: string | null;
    valid_until: string | null;
    enabled: boolean;
    created_at: string;
    updated_at: string;
}

/** Editable fields; timestamps are owned by the backend. An id means update. */
export type MarketAvailabilityForm = Omit<MarketAvailabilityRow, 'id' | 'created_at' | 'updated_at'> & {
    id?: string;
};

@Injectable({ providedIn: 'root' })
export class AdminMarketAvailabilityService {
    private http = inject(HttpClient);
    private api = inject(ApiUrlService);
    private supabase = inject(SupabaseService);

    private async headers(): Promise<HttpHeaders> {
        const { data } = await this.supabase.auth.getSession();
        return new HttpHeaders({
            'Content-Type': 'application/json',
            ...(data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {})
        });
    }

    async list(): Promise<MarketAvailabilityRow[]> {
        return firstValueFrom(this.http.get<MarketAvailabilityRow[]>(
            this.api.getApiUrl('/api/markets/admin'),
            { headers: await this.headers() }
        ));
    }

    async save(form: MarketAvailabilityForm): Promise<MarketAvailabilityRow> {
        if (form.id) {
            const { id, ...payload } = form;
            return firstValueFrom(this.http.put<MarketAvailabilityRow>(
                this.api.getApiUrl(`/api/markets/admin/${encodeURIComponent(id)}`),
                payload,
                { headers: await this.headers() }
            ));
        }

        return firstValueFrom(this.http.post<MarketAvailabilityRow>(
            this.api.getApiUrl('/api/markets/admin'),
            form,
            { headers: await this.headers() }
        ));
    }
}
