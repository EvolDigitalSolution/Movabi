import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ApiUrlService } from '../../../core/services/api-url.service';
import { SupabaseService } from '../../../core/services/supabase/supabase.service';

export type MarketPricingRow = Record<string, any>;

export interface MarketPricingStrategyDto extends MarketPricingRow {
  countryCode: string;
  marketCity?: string | null;
  zoneId?: string | null;
  serviceType: string;
  vehicleClass?: string | null;
  currency: string;
  busyMultiplier?: number | null;
}

export interface MarketPricingSettingsDto {
  marketPricingEnabled: boolean;
  competitorBenchmarksEnabled: boolean;
  driverProtectionEnabled: boolean;
  platformMarginProtectionEnabled: boolean;
  shadowMode: boolean;
  auditEnabled: boolean;
  defaultTargetPercent: number;
  maxDiscountPercent: number;
  benchmarkMaxAgeHours: number;
  useInternalSignals: boolean;
  version: string;
}

export interface MarketPricingSimulationInput {
  countryCode: string;
  marketCity?: string | null;
  zoneId?: string | null;
  serviceType: string;
  vehicleClass?: string | null;
  currency: string;
  distanceKm: number;
  durationMinutes: number;
  baseServiceFare: number;
  platformFeePercent: number;
  driverCommissionPercent: number;
}

export interface MarketPricingSimulationResult {
  enabled: boolean;
  shadowMode: boolean;
  adjustmentApplied: boolean;
  baseServiceFare: number;
  marketReferenceFare?: number | null;
  targetFare?: number | null;
  driverProtectionFloor: number;
  platformMarginFloor: number;
  minimumSustainableFare: number;
  benchmarkUsed: boolean;
  internalSignalsUsed: boolean;
  adjustedServiceFare: number;
  marketAdjustment: number;
  platformFeeAmount: number;
  customerTotal: number;
  driverCommissionAmount: number;
  driverPayout: number;
  strategyId?: string | null;
  fallbackReason?: string | null;
  calculationVersion: string;
}

@Injectable({
  providedIn: 'root'
})
export class AdminMarketPricingService {
  private http = inject(HttpClient);
  private apiUrl = inject(ApiUrlService);
  private supabase = inject(SupabaseService);

  private url(path: string): string {
    return this.apiUrl.getApiUrl(`/api/admin/market-pricing${path}`);
  }

  private async headers(): Promise<HttpHeaders> {
    const { data } = await this.supabase.auth.getSession();
    const token = data?.session?.access_token;
    return new HttpHeaders({
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    });
  }

  async getStrategies(filters: Record<string, string> = {}): Promise<MarketPricingRow[]> {
    const params = new URLSearchParams(filters);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.http.get<{ rows: MarketPricingRow[] }>(`${this.url('/strategies')}${query}`, { headers: await this.headers() })
      .toPromise().then(res => res?.rows ?? []);
  }

  async createStrategy(row: MarketPricingStrategyDto): Promise<MarketPricingRow> {
    return this.http.post<{ row: MarketPricingRow }>(this.url('/strategies'), row, { headers: await this.headers() })
      .toPromise().then(res => res?.row ?? row);
  }

  async updateStrategy(id: string, row: MarketPricingStrategyDto): Promise<MarketPricingRow> {
    return this.http.put<{ row: MarketPricingRow }>(this.url(`/strategies/${encodeURIComponent(id)}`), row, { headers: await this.headers() })
      .toPromise().then(res => res?.row ?? row);
  }

  async setStrategyStatus(id: string, enabled: boolean): Promise<MarketPricingRow> {
    return this.http.patch<{ row: MarketPricingRow }>(this.url(`/strategies/${encodeURIComponent(id)}/status`), { enabled }, { headers: await this.headers() })
      .toPromise().then(res => res?.row ?? {});
  }

  async deleteStrategy(id: string): Promise<void> {
    await this.http.delete(this.url(`/strategies/${encodeURIComponent(id)}`), { headers: await this.headers() }).toPromise();
  }

  async getCompetitors(filters: Record<string, string> = {}): Promise<MarketPricingRow[]> {
    const params = new URLSearchParams(filters);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.http.get<{ rows: MarketPricingRow[] }>(`${this.url('/competitors')}${query}`, { headers: await this.headers() })
      .toPromise().then(res => res?.rows ?? []);
  }

  async createCompetitor(row: MarketPricingRow): Promise<MarketPricingRow> {
    return this.http.post<{ row: MarketPricingRow }>(this.url('/competitors'), row, { headers: await this.headers() })
      .toPromise().then(res => res?.row ?? row);
  }

  async updateCompetitor(id: string, row: MarketPricingRow): Promise<MarketPricingRow> {
    return this.http.put<{ row: MarketPricingRow }>(this.url(`/competitors/${encodeURIComponent(id)}`), row, { headers: await this.headers() })
      .toPromise().then(res => res?.row ?? row);
  }

  async deleteCompetitor(id: string): Promise<void> {
    await this.http.delete(this.url(`/competitors/${encodeURIComponent(id)}`), { headers: await this.headers() }).toPromise();
  }

  async getBenchmarks(filters: Record<string, string> = {}): Promise<MarketPricingRow[]> {
    const params = new URLSearchParams(filters);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.http.get<{ rows: MarketPricingRow[] }>(`${this.url('/benchmarks')}${query}`, { headers: await this.headers() })
      .toPromise().then(res => res?.rows ?? []);
  }

  async createBenchmark(row: MarketPricingRow): Promise<MarketPricingRow> {
    return this.http.post<{ row: MarketPricingRow }>(this.url('/benchmarks'), row, { headers: await this.headers() })
      .toPromise().then(res => res?.row ?? row);
  }

  async deleteBenchmark(id: string): Promise<void> {
    await this.http.delete(this.url(`/benchmarks/${encodeURIComponent(id)}`), { headers: await this.headers() }).toPromise();
  }

  async simulate(input: MarketPricingSimulationInput): Promise<MarketPricingSimulationResult> {
    return this.http.post<{ result: MarketPricingSimulationResult }>(this.url('/simulate'), input, { headers: await this.headers() })
      .toPromise().then(res => res!.result);
  }

  async getAudit(limit = 100, offset = 0): Promise<{ rows: MarketPricingRow[]; total: number }> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return this.http.get<{ rows: MarketPricingRow[]; total: number }>(`${this.url('/audit')}?${params.toString()}`, { headers: await this.headers() })
      .toPromise().then(res => ({ rows: res?.rows ?? [], total: res?.total ?? 0 }));
  }

  async getSettings(): Promise<MarketPricingSettingsDto> {
    return this.http.get<{ settings: MarketPricingSettingsDto }>(this.url('/settings'), { headers: await this.headers() })
      .toPromise().then(res => res!.settings);
  }

  async updateSettings(partial: Partial<MarketPricingSettingsDto> & { confirmLiveApplication?: boolean }): Promise<MarketPricingSettingsDto> {
    return this.http.put<{ settings: MarketPricingSettingsDto }>(this.url('/settings'), partial, { headers: await this.headers() })
      .toPromise().then(res => res!.settings);
  }
}
