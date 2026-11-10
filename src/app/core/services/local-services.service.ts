import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiUrlService } from './api-url.service';
import { SupabaseService } from './supabase/supabase.service';

export interface LocalServiceCategory {
  id: string;
  categorySlug: string;
  categoryName: string;
  categoryDescription?: string | null;
  icon?: string | null;
  searchKeywords: string[];
  providerTypes?: string[];
  fallbackKeywords?: string[];
  searchRadiusKm: number;
  allowCustomProvider: boolean;
  displayOrder: number;
}

export interface LocalServiceProvider {
  id: string;
  preferenceId?: string | null;
  providerId?: string | null;
  providerName: string;
  providerSlug?: string | null;
  categorySlug?: string | null;
  providerLogoUrl?: string | null;
  logoUrl?: string | null;
  officialWebsite?: string | null;
  providerWebsite?: string | null;
  address?: string | null;
  providerAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  providerLatitude?: number | null;
  providerLongitude?: number | null;
  verified: boolean;
  distanceKm?: number | null;
  externalPlaceId?: string | null;
  openStatus?: string | null;
  confidence?: number | null;
  source?: string | null;
  previouslyUsed?: boolean;
  isFavourite?: boolean;
  useCount?: number;
}

export interface LocalServiceSelection {
  categoryId?: string | null;
  categorySlug?: string | null;
  categoryName?: string | null;
  providerId?: string | null;
  externalPlaceId?: string | null;
  providerName?: string | null;
  providerLogoUrl?: string | null;
  providerWebsite?: string | null;
  providerAddress?: string | null;
  providerLatitude?: number | null;
  providerLongitude?: number | null;
  distanceKm?: number | null;
  openStatus?: string | null;
  countryCode?: string | null;
  serviceSlug?: string | null;
  source?: string | null;
  verified?: boolean | null;
  selectedAt?: string | null;
}

@Injectable({ providedIn: 'root' })
export class LocalServicesService {
  private http = inject(HttpClient);
  private apiUrl = inject(ApiUrlService);
  private supabase = inject(SupabaseService);
  private categoryCache = new Map<string, { expiresAt: number; value: LocalServiceCategory[] }>();
  private providerCache = new Map<string, { expiresAt: number; value: LocalServiceProvider[] }>();
  private ttlMs = 3 * 60 * 1000;

  async getCategories(countryCode: string, serviceSlug: string): Promise<LocalServiceCategory[]> {
    const key = `${countryCode.toUpperCase()}:${serviceSlug}`;
    const cached = this.categoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const params = new HttpParams()
      .set('countryCode', countryCode.toUpperCase())
      .set('service', serviceSlug);
    const response = await firstValueFrom(
      this.http.get<{ categories?: LocalServiceCategory[] }>(
        this.apiUrl.getApiUrl('/api/local-services/categories'),
        { params }
      )
    );
    const value = response.categories || [];
    this.categoryCache.set(key, { expiresAt: Date.now() + this.ttlMs, value });
    return value;
  }

  async getProviders(
    countryCode: string,
    categoryId: string,
    location?: { lat?: number | null; lng?: number | null }
  ): Promise<LocalServiceProvider[]> {
    const key = `${countryCode.toUpperCase()}:${categoryId}:${location?.lat || ''}:${location?.lng || ''}`;
    const cached = this.providerCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let params = new HttpParams()
      .set('countryCode', countryCode.toUpperCase())
      .set('categoryId', categoryId);
    if (Number.isFinite(Number(location?.lat)) && Number.isFinite(Number(location?.lng))) {
      params = params.set('lat', String(location?.lat)).set('lng', String(location?.lng));
    }

    const response = await firstValueFrom(
      this.http.get<{ providers?: LocalServiceProvider[] }>(
        this.apiUrl.getApiUrl('/api/local-services/providers'),
        { params }
      )
    );
    const value = response.providers || [];
    this.providerCache.set(key, { expiresAt: Date.now() + this.ttlMs, value });
    return value;
  }

  async searchNearby(input: {
    countryCode: string;
    serviceSlug: string;
    categorySlug: string;
    categoryId?: string | null;
    location?: { lat?: number | null; lng?: number | null } | null;
    radiusKm?: number;
    searchText?: string;
    limit?: number;
  }): Promise<LocalServiceProvider[]> {
    let params = new HttpParams()
      .set('countryCode', input.countryCode.toUpperCase())
      .set('service', input.serviceSlug)
      .set('category', input.categorySlug)
      .set('radiusKm', String(input.radiusKm || 10))
      .set('limit', String(input.limit || 12));
    if (input.categoryId) params = params.set('categoryId', input.categoryId);
    if (input.searchText) params = params.set('q', input.searchText);
    if (Number.isFinite(Number(input.location?.lat)) && Number.isFinite(Number(input.location?.lng))) {
      params = params.set('lat', String(input.location?.lat)).set('lng', String(input.location?.lng));
    }

    const response = await firstValueFrom(
      this.http.get<{ providers?: LocalServiceProvider[] }>(
        this.apiUrl.getApiUrl('/api/local-services/nearby'),
        { params }
      )
    );
    return response.providers || [];
  }

  async getRecent(input: { countryCode: string; serviceSlug: string; categorySlug?: string | null }): Promise<LocalServiceProvider[]> {
    let params = new HttpParams()
      .set('countryCode', input.countryCode.toUpperCase())
      .set('service', input.serviceSlug);
    if (input.categorySlug) params = params.set('category', input.categorySlug);
    const response = await firstValueFrom(
      this.http.get<{ providers?: LocalServiceProvider[] }>(
        this.apiUrl.getApiUrl('/api/local-services/recent'),
        { params, headers: await this.authHeaders() }
      )
    );
    return response.providers || [];
  }

  async getFavourites(): Promise<LocalServiceProvider[]> {
    const response = await firstValueFrom(
      this.http.get<{ providers?: LocalServiceProvider[] }>(
        this.apiUrl.getApiUrl('/api/local-services/favourites'),
        { headers: await this.authHeaders() }
      )
    );
    return response.providers || [];
  }

  async saveFavourite(selection: LocalServiceSelection): Promise<void> {
    await firstValueFrom(
      this.http.post(
        this.apiUrl.getApiUrl('/api/local-services/favourites'),
        selection,
        { headers: await this.authHeaders() }
      )
    );
  }

  async removeFavourite(preferenceId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(
        this.apiUrl.getApiUrl(`/api/local-services/favourites/${preferenceId}`),
        { headers: await this.authHeaders() }
      )
    );
  }

  async saveRecent(selection: LocalServiceSelection): Promise<void> {
    await firstValueFrom(
      this.http.post(
        this.apiUrl.getApiUrl('/api/local-services/recent'),
        selection,
        { headers: await this.authHeaders() }
      )
    );
  }

  clearCache(): void {
    this.categoryCache.clear();
    this.providerCache.clear();
  }

  private async authHeaders(): Promise<HttpHeaders> {
    const { data } = await this.supabase.auth.getSession();
    const token = data?.session?.access_token;
    let headers = new HttpHeaders();
    if (token) headers = headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }
}
