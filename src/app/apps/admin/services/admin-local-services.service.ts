import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiUrlService } from '../../../core/services/api-url.service';
import { SupabaseService } from '../../../core/services/supabase/supabase.service';

export interface AdminLocalServiceCategory {
  id?: string;
  country_code: string;
  service_slug: string;
  category_slug: string;
  category_name: string;
  category_description?: string | null;
  icon?: string | null;
  search_keywords?: string[];
  provider_types?: string[];
  fallback_keywords?: string[];
  default_search_radius_km?: number;
  allow_custom_provider?: boolean;
  display_order?: number;
  enabled?: boolean;
}

export interface AdminLocalServiceProvider {
  id?: string;
  country_code: string;
  category_id: string;
  provider_name: string;
  provider_slug: string;
  provider_description?: string | null;
  logo_url?: string | null;
  official_website?: string | null;
  external_place_id?: string | null;
  search_keywords?: string[];
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  source?: string | null;
  verified?: boolean;
  enabled?: boolean;
  display_order?: number;
  category?: AdminLocalServiceCategory;
}

export interface AdminLocalPlaceSearchRequest {
  countryCode: string;
  serviceSlug: string;
  categorySlug: string;
  categoryId?: string;
  q?: string;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class AdminLocalServicesService {
  private http = inject(HttpClient);
  private apiUrl = inject(ApiUrlService);
  private supabase = inject(SupabaseService);

  private async headers(): Promise<HttpHeaders> {
    const { data } = await this.supabase.auth.getSession();
    const token = data?.session?.access_token;
    return new HttpHeaders({
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    });
  }

  async getCategories(filters: { countryCode?: string; serviceSlug?: string; enabled?: boolean } = {}): Promise<AdminLocalServiceCategory[]> {
    let params = new HttpParams();
    if (filters.countryCode) params = params.set('countryCode', filters.countryCode);
    if (filters.serviceSlug) params = params.set('serviceSlug', filters.serviceSlug);
    if (filters.enabled !== undefined) params = params.set('enabled', String(filters.enabled));
    const response = await firstValueFrom(
      this.http.get<{ categories?: AdminLocalServiceCategory[] }>(
        this.apiUrl.getApiUrl('/api/admin/local-services/categories'),
        { headers: await this.headers(), params }
      )
    );
    return response.categories || [];
  }

  async saveCategory(category: AdminLocalServiceCategory): Promise<AdminLocalServiceCategory> {
    const url = category.id
      ? this.apiUrl.getApiUrl(`/api/admin/local-services/categories/${category.id}`)
      : this.apiUrl.getApiUrl('/api/admin/local-services/categories');
    const headers = await this.headers();
    const response = await firstValueFrom(
      category.id
        ? this.http.put<{ category?: AdminLocalServiceCategory }>(url, category, { headers })
        : this.http.post<{ category?: AdminLocalServiceCategory }>(url, category, { headers })
    );
    return response.category || category;
  }

  async disableCategory(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(this.apiUrl.getApiUrl(`/api/admin/local-services/categories/${id}`), { headers: await this.headers() }));
  }

  async getProviders(filters: { countryCode?: string; categoryId?: string; enabled?: boolean } = {}): Promise<AdminLocalServiceProvider[]> {
    let params = new HttpParams();
    if (filters.countryCode) params = params.set('countryCode', filters.countryCode);
    if (filters.categoryId) params = params.set('categoryId', filters.categoryId);
    if (filters.enabled !== undefined) params = params.set('enabled', String(filters.enabled));
    const response = await firstValueFrom(
      this.http.get<{ providers?: AdminLocalServiceProvider[] }>(
        this.apiUrl.getApiUrl('/api/admin/local-services/providers'),
        { headers: await this.headers(), params }
      )
    );
    return response.providers || [];
  }

  async saveProvider(provider: AdminLocalServiceProvider): Promise<AdminLocalServiceProvider> {
    const url = provider.id
      ? this.apiUrl.getApiUrl(`/api/admin/local-services/providers/${provider.id}`)
      : this.apiUrl.getApiUrl('/api/admin/local-services/providers');
    const headers = await this.headers();
    const response = await firstValueFrom(
      provider.id
        ? this.http.put<{ provider?: AdminLocalServiceProvider }>(url, provider, { headers })
        : this.http.post<{ provider?: AdminLocalServiceProvider }>(url, provider, { headers })
    );
    return response.provider || provider;
  }

  async disableProvider(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(this.apiUrl.getApiUrl(`/api/admin/local-services/providers/${id}`), { headers: await this.headers() }));
  }

  async searchExternalProviders(request: AdminLocalPlaceSearchRequest): Promise<AdminLocalServiceProvider[]> {
    const response = await firstValueFrom(
      this.http.post<{ providers?: AdminLocalServiceProvider[] }>(
        this.apiUrl.getApiUrl('/api/admin/local-services/search-external'),
        request,
        { headers: await this.headers() }
      )
    );
    return response.providers || [];
  }

  async importProvider(provider: Partial<AdminLocalServiceProvider>): Promise<AdminLocalServiceProvider> {
    const response = await firstValueFrom(
      this.http.post<{ provider?: AdminLocalServiceProvider }>(
        this.apiUrl.getApiUrl('/api/admin/local-services/import-provider'),
        provider,
        { headers: await this.headers() }
      )
    );
    if (!response.provider) throw new Error('Provider import did not return a provider.');
    return response.provider;
  }

  async resolveProviderBrand(providerId: string): Promise<AdminLocalServiceProvider> {
    const response = await firstValueFrom(
      this.http.post<{ provider?: AdminLocalServiceProvider }>(
        this.apiUrl.getApiUrl(`/api/admin/local-services/providers/${providerId}/resolve-brand`),
        {},
        { headers: await this.headers() }
      )
    );
    if (!response.provider) throw new Error('Brand resolution did not return a provider.');
    return response.provider;
  }

  async verifyProvider(providerId: string, verified = true): Promise<AdminLocalServiceProvider> {
    const response = await firstValueFrom(
      this.http.post<{ provider?: AdminLocalServiceProvider }>(
        this.apiUrl.getApiUrl(`/api/admin/local-services/providers/${providerId}/verify`),
        { verified },
        { headers: await this.headers() }
      )
    );
    if (!response.provider) throw new Error('Provider verification did not return a provider.');
    return response.provider;
  }
}
