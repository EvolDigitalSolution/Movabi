import axios from 'axios';
import { supabaseAdmin } from './supabase.service';

export interface LocalPlaceSearchInput {
  countryCode: string;
  serviceSlug: string;
  categorySlug: string;
  categoryId?: string;
  latitude?: number;
  longitude?: number;
  radiusKm: number;
  searchText?: string;
  limit: number;
}

export interface LocalPlaceResult {
  id: string;
  providerName: string;
  providerSlug?: string | null;
  providerLogoUrl?: string | null;
  providerWebsite?: string | null;
  providerAddress?: string | null;
  providerLatitude?: number | null;
  providerLongitude?: number | null;
  distanceKm?: number | null;
  externalPlaceId?: string | null;
  categorySlug: string;
  openStatus?: string | null;
  source: 'admin' | 'cache' | 'maptiler' | 'manual';
  confidence: number;
  verified?: boolean;
  previouslyUsed?: boolean;
}

function normaliseSlug(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function bucketCoordinate(value?: number): string {
  if (!Number.isFinite(Number(value))) return 'na';
  return (Math.round(Number(value) * 100) / 100).toFixed(2);
}

function distanceKm(latA?: number, lngA?: number, latB?: number | null, lngB?: number | null): number | null {
  if (![latA, lngA, latB, lngB].every(value => Number.isFinite(Number(value)))) return null;
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(Number(latB) - Number(latA));
  const dLng = toRad(Number(lngB) - Number(lngA));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(Number(latA))) * Math.cos(toRad(Number(latB))) *
    Math.sin(dLng / 2) ** 2;
  return Math.round((6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))) * 10) / 10;
}

function resultKey(result: LocalPlaceResult): string {
  const external = String(result.externalPlaceId || '').trim().toLowerCase();
  if (external) return `external:${external}`;
  const name = String(result.providerName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const address = String(result.providerAddress || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 18);
  const lat = result.providerLatitude === null || result.providerLatitude === undefined ? '' : Number(result.providerLatitude).toFixed(3);
  const lng = result.providerLongitude === null || result.providerLongitude === undefined ? '' : Number(result.providerLongitude).toFixed(3);
  return `${name}:${address}:${lat}:${lng}`;
}

function cleanHttpsUrl(value: unknown): string | null {
  const url = String(value || '').trim();
  if (!url || !/^https:\/\//i.test(url)) return null;
  if (!/\.(png|jpg|jpeg|webp|gif|svg)(\?.*)?$/i.test(url)) return null;
  return url;
}

export class ProviderBrandService {
  static async resolveLogo(input: {
    providerId?: string | null;
    externalPlaceId?: string | null;
    providerName: string;
    countryCode: string;
    officialWebsite?: string | null;
    logoUrl?: string | null;
  }): Promise<string | null> {
    const direct = cleanHttpsUrl(input.logoUrl);
    if (direct) return direct;

    const domain = this.domainFromUrl(input.officialWebsite);
    let query = supabaseAdmin
      .from('provider_brand_assets')
      .select('logo_url, favicon_url, verified, confidence')
      .eq('country_code', input.countryCode)
      .order('verified', { ascending: false })
      .order('confidence', { ascending: false })
      .limit(1);

    if (input.providerId) {
      query = query.eq('provider_id', input.providerId);
    } else if (input.externalPlaceId) {
      query = query.eq('external_place_id', input.externalPlaceId);
    } else if (domain) {
      query = query.eq('official_domain', domain);
    } else {
      query = query.ilike('provider_name', input.providerName);
    }

    const { data } = await query.maybeSingle();
    return cleanHttpsUrl(data?.logo_url) || cleanHttpsUrl(data?.favicon_url);
  }

  private static domainFromUrl(value?: string | null): string | null {
    try {
      const parsed = new URL(String(value || ''));
      return parsed.hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return null;
    }
  }
}

export class LocalPlaceSearchService {
  static async search(input: LocalPlaceSearchInput): Promise<LocalPlaceResult[]> {
    const safeInput = {
      ...input,
      countryCode: String(input.countryCode || 'GB').toUpperCase(),
      serviceSlug: normaliseSlug(input.serviceSlug || 'errand'),
      categorySlug: normaliseSlug(input.categorySlug),
      radiusKm: Math.max(1, Math.min(Number(input.radiusKm || 10), 25)),
      limit: Math.max(1, Math.min(Number(input.limit || 12), 30)),
      searchText: String(input.searchText || '').trim().slice(0, 80)
    };

    console.info('[LocalPlaceSearch] requested', {
      countryCode: safeInput.countryCode,
      serviceSlug: safeInput.serviceSlug,
      categorySlug: safeInput.categorySlug,
      radiusKm: safeInput.radiusKm,
      hasLocation: Number.isFinite(safeInput.latitude) && Number.isFinite(safeInput.longitude),
      hasSearchText: Boolean(safeInput.searchText)
    });

    const adminResults = await this.adminProviders(safeInput);
    const cachedResults = await this.cachedExternalResults(safeInput);
    const liveResults = cachedResults.length ? [] : await this.liveProviderResults(safeInput);
    const merged = await this.mergeAndRank([...adminResults, ...cachedResults, ...liveResults], safeInput);

    if (!cachedResults.length && liveResults.length) {
      await this.writeCache(safeInput, liveResults);
    }

    return merged.slice(0, safeInput.limit);
  }

  private static async adminProviders(input: LocalPlaceSearchInput): Promise<LocalPlaceResult[]> {
    let query = supabaseAdmin
      .from('local_service_providers')
      .select('id, provider_name, provider_slug, logo_url, official_website, address, latitude, longitude, verified, source, display_order, category:local_service_categories!inner(id, category_slug)')
      .eq('country_code', input.countryCode)
      .eq('enabled', true)
      .eq('category.category_slug', input.categorySlug);

    if (input.categoryId) query = query.eq('category_id', input.categoryId);
    if (input.searchText) query = query.ilike('provider_name', `%${input.searchText}%`);

    const { data, error } = await query
      .order('display_order', { ascending: true })
      .order('provider_name', { ascending: true })
      .limit(input.limit);

    if (error) {
      console.warn('[LocalPlaceSearch] admin provider search failed', error.message);
      return [];
    }

    return Promise.all((data || []).map(async row => ({
      id: String(row.id),
      providerName: String(row.provider_name),
      providerSlug: row.provider_slug,
      providerLogoUrl: await ProviderBrandService.resolveLogo({
        providerId: row.id,
        providerName: String(row.provider_name),
        countryCode: input.countryCode,
        officialWebsite: row.official_website,
        logoUrl: row.logo_url
      }),
      providerWebsite: row.official_website,
      providerAddress: row.address,
      providerLatitude: row.latitude,
      providerLongitude: row.longitude,
      distanceKm: distanceKm(input.latitude, input.longitude, row.latitude, row.longitude),
      categorySlug: input.categorySlug,
      source: 'admin' as const,
      confidence: 0.98,
      verified: row.verified === true
    })));
  }

  private static async cachedExternalResults(input: LocalPlaceSearchInput): Promise<LocalPlaceResult[]> {
    const { data, error } = await supabaseAdmin
      .from('local_place_search_cache')
      .select('result, source')
      .eq('country_code', input.countryCode)
      .eq('service_slug', input.serviceSlug)
      .eq('category_slug', input.categorySlug)
      .eq('search_text', input.searchText || '')
      .eq('latitude_bucket', bucketCoordinate(input.latitude))
      .eq('longitude_bucket', bucketCoordinate(input.longitude))
      .eq('radius_km', input.radiusKm)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data?.result) return [];
    console.info('[LocalPlaceSearch] cache hit', { categorySlug: input.categorySlug });
    return Array.isArray(data.result) ? data.result as LocalPlaceResult[] : [];
  }

  private static async liveProviderResults(input: LocalPlaceSearchInput): Promise<LocalPlaceResult[]> {
    const apiKey = process.env.MAPTILER_API_KEY || process.env.MAP_TILER_API_KEY || '';
    if (!apiKey || !Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
      console.info('[LocalPlaceSearch] live provider skipped', { reason: apiKey ? 'missing location' : 'missing api key' });
      return [];
    }

    const keywords = await this.categoryKeywords(input);
    const query = [input.searchText || keywords[0] || input.categorySlug, input.countryCode].filter(Boolean).join(' ');
    try {
      const response = await axios.get(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json`, {
        timeout: 4500,
        params: {
          key: apiKey,
          limit: input.limit,
          language: 'en',
          proximity: `${input.longitude},${input.latitude}`,
          country: input.countryCode.toLowerCase(),
          types: 'poi,address,place'
        }
      });

      const features = Array.isArray(response.data?.features) ? response.data.features : [];
      console.info('[LocalPlaceSearch] live provider result', { count: features.length });
      return features.map((feature: any): LocalPlaceResult => {
        const coords = Array.isArray(feature.center) ? feature.center : [];
        const lng = Number(coords[0]);
        const lat = Number(coords[1]);
        const name = String(feature.text || feature.place_name || '').trim();
        return {
          id: `external:${feature.id || name}`,
          providerName: name || 'Nearby provider',
          providerAddress: String(feature.place_name || '').trim() || null,
          providerLatitude: Number.isFinite(lat) ? lat : null,
          providerLongitude: Number.isFinite(lng) ? lng : null,
          distanceKm: distanceKm(input.latitude, input.longitude, lat, lng),
          externalPlaceId: feature.id || null,
          categorySlug: input.categorySlug,
          source: 'maptiler',
          confidence: Number(feature.relevance || 0.7),
          verified: false
        };
      }).filter(result => result.providerName);
    } catch (error: any) {
      console.warn('[LocalPlaceSearch] live provider failed', error?.message || error);
      return [];
    }
  }

  private static async categoryKeywords(input: LocalPlaceSearchInput): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('local_service_categories')
      .select('search_keywords, provider_types, fallback_keywords')
      .eq('country_code', input.countryCode)
      .eq('service_slug', input.serviceSlug)
      .eq('category_slug', input.categorySlug)
      .maybeSingle();
    return [
      ...(Array.isArray(data?.search_keywords) ? data.search_keywords : []),
      ...(Array.isArray(data?.provider_types) ? data.provider_types : []),
      ...(Array.isArray(data?.fallback_keywords) ? data.fallback_keywords : [])
    ].map(item => String(item).trim()).filter(Boolean);
  }

  private static async writeCache(input: LocalPlaceSearchInput, results: LocalPlaceResult[]): Promise<void> {
    const expiresAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
    const payload = {
      country_code: input.countryCode,
      service_slug: input.serviceSlug,
      category_slug: input.categorySlug,
      search_text: input.searchText || '',
      latitude_bucket: bucketCoordinate(input.latitude),
      longitude_bucket: bucketCoordinate(input.longitude),
      radius_km: input.radiusKm,
      result: results,
      source: 'maptiler',
      expires_at: expiresAt
    };
    const { error } = await supabaseAdmin.from('local_place_search_cache').insert(payload);
    if (error) console.warn('[LocalPlaceSearch] cache write failed', error.message);
  }

  private static async mergeAndRank(results: LocalPlaceResult[], input: LocalPlaceSearchInput): Promise<LocalPlaceResult[]> {
    const byKey = new Map<string, LocalPlaceResult>();
    for (const result of results) {
      const key = resultKey(result);
      const existing = byKey.get(key);
      if (!existing || existing.source !== 'admin') {
        byKey.set(key, existing?.source === 'admin' ? existing : result);
      }
    }

    return [...byKey.values()].sort((a, b) => {
      const adminDelta = (a.source === 'admin' ? 0 : 1) - (b.source === 'admin' ? 0 : 1);
      if (adminDelta) return adminDelta;
      const verifiedDelta = (b.verified ? 1 : 0) - (a.verified ? 1 : 0);
      if (verifiedDelta) return verifiedDelta;
      const distanceA = a.distanceKm ?? Number.MAX_SAFE_INTEGER;
      const distanceB = b.distanceKm ?? Number.MAX_SAFE_INTEGER;
      if (distanceA !== distanceB) return distanceA - distanceB;
      return b.confidence - a.confidence;
    });
  }
}
