import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ApiUrlService } from '../../../core/services/api-url.service';
import { SupabaseService } from '../../../core/services/supabase/supabase.service';

export type GlobalAiPricingTable =
  | 'markets'
  | 'zones'
  | 'serviceRules'
  | 'waitingRules'
  | 'calendarEvents'
  | 'audits';

export type GlobalAiRow = Record<string, any>;

@Injectable({
  providedIn: 'root'
})
export class AdminGlobalAiPricingService {
  private http = inject(HttpClient);
  private apiUrl = inject(ApiUrlService);
  private supabase = inject(SupabaseService);

  private adminUrl(path: string): string {
    return this.apiUrl.getApiUrl(`/api/admin/pricing/global-ai${path}`);
  }

  private async headers(): Promise<HttpHeaders> {
    const { data } = await this.supabase.auth.getSession();
    const token = data?.session?.access_token;
    return new HttpHeaders({
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    });
  }

  async getRows(table: GlobalAiPricingTable, options: { countryCode?: string; limit?: number } = {}): Promise<GlobalAiRow[]> {
    const params = new URLSearchParams();
    if (options.countryCode) params.set('countryCode', options.countryCode.toUpperCase());
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString() ? `?${params.toString()}` : '';

    return this.http
      .get<{ rows: GlobalAiRow[] }>(`${this.adminUrl(`/${table}`)}${query}`, { headers: await this.headers() })
      .toPromise()
      .then((res) => res?.rows ?? []);
  }

  async saveRow(table: Exclude<GlobalAiPricingTable, 'audits'>, row: GlobalAiRow): Promise<GlobalAiRow> {
    return this.http
      .post<{ row: GlobalAiRow }>(this.adminUrl(`/${table}`), { row }, { headers: await this.headers() })
      .toPromise()
      .then((res) => res?.row ?? row);
  }

  async deleteRow(table: Exclude<GlobalAiPricingTable, 'audits'>, id: string): Promise<void> {
    await this.http
      .delete(this.adminUrl(`/${table}/${encodeURIComponent(id)}`), { headers: await this.headers() })
      .toPromise();
  }
}
