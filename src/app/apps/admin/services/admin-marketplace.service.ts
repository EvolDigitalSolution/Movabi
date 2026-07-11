import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ApiUrlService } from '../../../core/services/api-url.service';
import { SupabaseService } from '../../../core/services/supabase/supabase.service';
import { MarketplaceSettings } from '../../../core/services/marketplace/marketplace-config.service';

export interface MarketplaceAuditLog {
  id: string;
  createdAt: string;
  userId?: string | null;
  action: string;
  eventType?: string;
  settingKey?: string;
  key?: string;
  entityType: string;
  entityId: string;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

function mapRawAuditLog(raw: Record<string, unknown>): MarketplaceAuditLog {
  const rawMetadata = raw['metadata'];
  const metadata =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : undefined;

  const prevRaw =
    metadata?.['previous'] ??
    metadata?.['old_value'] ??
    metadata?.['oldValue'] ??
    raw['old_value'] ??
    raw['oldValue'];
  const newRaw =
    metadata?.['value'] ??
    metadata?.['new_value'] ??
    metadata?.['newValue'] ??
    raw['new_value'] ??
    raw['newValue'];

  const rawKey = raw['key'];
  const rawUserId = raw['user_id'] ?? raw['userId'];

  return {
    id: String(raw['id'] ?? ''),
    createdAt: String(raw['created_at'] ?? raw['createdAt'] ?? ''),
    userId: typeof rawUserId === 'string' ? rawUserId : null,
    action: String(raw['action'] ?? ''),
    eventType:
      String((raw['event_type'] ?? raw['eventType'] ?? raw['action'] ?? '') || '') || undefined,
    settingKey:
      String(
        (raw['entity_id'] ??
          raw['entityId'] ??
          raw['setting_key'] ??
          raw['settingKey'] ??
          raw['key'] ??
          raw['config_key'] ??
          raw['configKey'] ??
          '') || ''
      ) || undefined,
    key: typeof rawKey === 'string' ? rawKey : undefined,
    entityType: String(raw['entity_type'] ?? raw['entityType'] ?? ''),
    entityId: String(raw['entity_id'] ?? raw['entityId'] ?? ''),
    previousValue: prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw) ? (prevRaw as Record<string, unknown>) : null,
    newValue: newRaw && typeof newRaw === 'object' && !Array.isArray(newRaw) ? (newRaw as Record<string, unknown>) : null,
    metadata: metadata ?? undefined
  };
}

@Injectable({
  providedIn: 'root'
})
export class AdminMarketplaceService {
  private http = inject(HttpClient);
  private apiUrl = inject(ApiUrlService);
  private supabase = inject(SupabaseService);

  private adminUrl(path: string): string {
    return this.apiUrl.getApiUrl(`/api/admin/marketplace${path}`);
  }

  private async headers(): Promise<HttpHeaders> {
    const { data } = await this.supabase.auth.getSession();
    const token = data?.session?.access_token;
    return new HttpHeaders({
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    });
  }

  async getSettings(): Promise<MarketplaceSettings> {
    return this.http.get<{ settings: MarketplaceSettings }>(this.adminUrl('/settings'), { headers: await this.headers() })
      .toPromise()
      .then(res => res?.settings ?? {} as MarketplaceSettings);
  }

  async saveSettings(settings: MarketplaceSettings): Promise<MarketplaceSettings> {
    return this.http.post<{ settings: MarketplaceSettings }>(this.adminUrl('/settings'), { settings }, { headers: await this.headers() })
      .toPromise()
      .then(res => res?.settings ?? settings);
  }

  async getAuditLogs(limit = 100, offset = 0, key?: string): Promise<MarketplaceAuditLog[]> {
    const params: Record<string, string> = { limit: String(limit), offset: String(offset) };
    if (key) params['key'] = key;
    const query = new URLSearchParams(params).toString();
    return this.http.get<{ logs: Record<string, unknown>[] }>(`${this.adminUrl('/audit-logs')}?${query}`, { headers: await this.headers() })
      .toPromise()
      .then(res => (res?.logs ?? []).map(mapRawAuditLog));
  }

  async reload(): Promise<void> {
    await this.http.post(this.adminUrl('/reload'), {}, { headers: await this.headers() }).toPromise();
  }
}
