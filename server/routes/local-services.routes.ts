import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { LocalPlaceSearchService } from '../services/local-place-search.service';

const router = Router();
const recentSearchRequests = new Map<string, number[]>();

function cleanCountry(value: unknown): string {
  const country = String(value || 'GB').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : 'GB';
}

function canonicalService(value: unknown): string {
  const slug = String(value || 'errand').trim().toLowerCase().replace(/_/g, '-');
  if (['shop', 'shopping', 'errands'].includes(slug)) return 'errand';
  if (['quick_buy', 'quick-buy'].includes(slug)) return 'quick-buy';
  if (['collect_deliver', 'collect-deliver'].includes(slug)) return 'collect-deliver';
  if (['deliver', 'package'].includes(slug)) return 'delivery';
  if (['van', 'move', 'van-moving'].includes(slug)) return 'van-moving';
  return slug || 'errand';
}

function distanceKm(latA?: number, lngA?: number, latB?: number | null, lngB?: number | null): number | null {
  if (![latA, lngA, latB, lngB].every(value => Number.isFinite(Number(value)))) return null;
  const toRad = (deg: number) => deg * Math.PI / 180;
  const earthKm = 6371;
  const dLat = toRad(Number(latB) - Number(latA));
  const dLng = toRad(Number(lngB) - Number(lngA));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(Number(latA))) * Math.cos(toRad(Number(latB))) *
    Math.sin(dLng / 2) ** 2;
  return Math.round((earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))) * 10) / 10;
}

function validateLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function rateLimit(req: Request): boolean {
  const key = String(req.ip || req.headers['x-forwarded-for'] || 'unknown');
  const now = Date.now();
  const windowMs = 60_000;
  const hits = (recentSearchRequests.get(key) || []).filter(value => now - value < windowMs);
  if (hits.length >= 30) {
    recentSearchRequests.set(key, hits);
    return false;
  }
  hits.push(now);
  recentSearchRequests.set(key, hits);
  return true;
}

async function authUserId(req: Request): Promise<string | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error) return null;
  return data.user?.id || null;
}

router.get('/categories', async (req: Request, res: Response) => {
  try {
    const countryCode = cleanCountry(req.query.countryCode);
    const serviceSlug = canonicalService(req.query.service || req.query.serviceSlug);

    const { data, error } = await supabaseAdmin
      .from('local_service_categories')
      .select('id, category_slug, category_name, category_description, icon, search_keywords, provider_types, fallback_keywords, default_search_radius_km, allow_custom_provider, display_order')
      .eq('country_code', countryCode)
      .eq('service_slug', serviceSlug)
      .eq('enabled', true)
      .order('display_order', { ascending: true })
      .order('category_name', { ascending: true });

    if (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    return res.json({
      ok: true,
      categories: (data || []).map(row => ({
        id: row.id,
        categorySlug: row.category_slug,
        categoryName: row.category_name,
        categoryDescription: row.category_description,
        icon: row.icon,
        searchKeywords: row.search_keywords || [],
        providerTypes: row.provider_types || [],
        fallbackKeywords: row.fallback_keywords || [],
        searchRadiusKm: Number(row.default_search_radius_km || 10),
        allowCustomProvider: row.allow_custom_provider !== false,
        displayOrder: Number(row.display_order || 0)
      }))
    });
  } catch (error: any) {
    console.error('[LocalServices] categories failed:', error);
    return res.status(500).json({ ok: false, error: 'Failed to load local service categories.' });
  }
});

router.get('/providers', async (req: Request, res: Response) => {
  try {
    const countryCode = cleanCountry(req.query.countryCode);
    const categoryId = String(req.query.categoryId || '').trim();
    const lat = req.query.lat === undefined ? undefined : Number(req.query.lat);
    const lng = req.query.lng === undefined ? undefined : Number(req.query.lng);

    if (!categoryId) {
      return res.status(400).json({ ok: false, error: 'categoryId is required.' });
    }

    const { data, error } = await supabaseAdmin
      .from('local_service_providers')
      .select('id, provider_name, provider_slug, logo_url, official_website, address, latitude, longitude, verified, source, display_order')
      .eq('country_code', countryCode)
      .eq('category_id', categoryId)
      .eq('enabled', true)
      .order('display_order', { ascending: true })
      .order('provider_name', { ascending: true });

    if (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    const providers = (data || []).map(row => ({
      id: row.id,
      providerName: row.provider_name,
      providerSlug: row.provider_slug,
      logoUrl: row.logo_url,
      officialWebsite: row.official_website,
      address: row.address,
      latitude: row.latitude,
      longitude: row.longitude,
      verified: row.verified === true,
      distanceKm: distanceKm(lat, lng, row.latitude, row.longitude),
      source: row.source || 'admin',
      displayOrder: Number(row.display_order || 0)
    })).sort((a, b) => {
      if (a.distanceKm !== null && b.distanceKm === null) return -1;
      if (a.distanceKm === null && b.distanceKm !== null) return 1;
      if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
      return a.displayOrder - b.displayOrder;
    });

    return res.json({ ok: true, providers });
  } catch (error: any) {
    console.error('[LocalServices] providers failed:', error);
    return res.status(500).json({ ok: false, error: 'Failed to load local service providers.' });
  }
});

router.get('/nearby', async (req: Request, res: Response) => {
  try {
    if (!rateLimit(req)) {
      return res.status(429).json({ ok: false, error: 'Too many local searches. Please try again shortly.' });
    }

    const countryCode = cleanCountry(req.query.countryCode);
    const serviceSlug = canonicalService(req.query.service || req.query.serviceSlug);
    const categorySlug = String(req.query.category || req.query.categorySlug || '').trim().toLowerCase().replace(/_/g, '-');
    const categoryId = String(req.query.categoryId || '').trim() || undefined;
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = Math.max(1, Math.min(Number(req.query.radiusKm || 10), 25));
    const searchText = String(req.query.q || req.query.searchText || '').trim().slice(0, 80);
    const limit = Math.max(1, Math.min(Number(req.query.limit || 12), 30));

    if (!categorySlug && !categoryId) {
      return res.status(400).json({ ok: false, error: 'category or categoryId is required.' });
    }
    if ((req.query.lat !== undefined || req.query.lng !== undefined) && !validateLatLng(lat, lng)) {
      return res.status(400).json({ ok: false, error: 'Valid latitude and longitude are required.' });
    }

    const effectiveCategorySlug = categorySlug || await categorySlugFromId(categoryId);
    const providers = await LocalPlaceSearchService.search({
      countryCode,
      serviceSlug,
      categorySlug: effectiveCategorySlug,
      categoryId,
      latitude: validateLatLng(lat, lng) ? lat : undefined,
      longitude: validateLatLng(lat, lng) ? lng : undefined,
      radiusKm,
      searchText,
      limit
    });

    return res.json({ ok: true, providers });
  } catch (error: any) {
    console.error('[LocalServices] nearby failed:', error);
    return res.status(500).json({ ok: false, error: 'Nearby providers are unavailable. Manual entry still works.' });
  }
});

router.get('/recent', async (req: Request, res: Response) => {
  try {
    const userId = await authUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required.' });

    const countryCode = cleanCountry(req.query.countryCode);
    const serviceSlug = canonicalService(req.query.service || req.query.serviceSlug);
    const categorySlug = String(req.query.category || req.query.categorySlug || '').trim().toLowerCase().replace(/_/g, '-');

    let query = supabaseAdmin
      .from('customer_local_service_preferences')
      .select('*')
      .eq('customer_id', userId)
      .eq('country_code', countryCode)
      .eq('service_slug', serviceSlug)
      .order('last_used_at', { ascending: false })
      .limit(8);
    if (categorySlug) query = query.eq('category_slug', categorySlug);

    const { data, error } = await query;
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, providers: (data || []).map(preferenceToProvider) });
  } catch (error: any) {
    console.error('[LocalServices] recent failed:', error);
    return res.status(500).json({ ok: false, error: 'Failed to load recent providers.' });
  }
});

router.get('/favourites', async (req: Request, res: Response) => {
  try {
    const userId = await authUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required.' });

    const { data, error } = await supabaseAdmin
      .from('customer_local_service_preferences')
      .select('*')
      .eq('customer_id', userId)
      .eq('is_favourite', true)
      .order('last_used_at', { ascending: false })
      .limit(20);
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, providers: (data || []).map(preferenceToProvider) });
  } catch (error: any) {
    console.error('[LocalServices] favourites failed:', error);
    return res.status(500).json({ ok: false, error: 'Failed to load favourite providers.' });
  }
});

router.post('/favourites', async (req: Request, res: Response) => {
  try {
    const userId = await authUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required.' });
    const payload = preferencePayload(userId, req.body || {}, true);
    const existing = await findPreference(userId, payload);
    const result = existing
      ? await supabaseAdmin.from('customer_local_service_preferences').update({ is_favourite: true, updated_at: new Date().toISOString() }).eq('id', existing.id).select('*').single()
      : await supabaseAdmin.from('customer_local_service_preferences').insert(payload).select('*').single();
    if (result.error) return res.status(400).json({ ok: false, error: result.error.message });
    return res.json({ ok: true, preference: result.data });
  } catch (error: any) {
    console.error('[LocalServices] favourite save failed:', error);
    return res.status(500).json({ ok: false, error: 'Failed to save favourite.' });
  }
});

router.delete('/favourites/:id', async (req: Request, res: Response) => {
  const userId = await authUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required.' });
  const { error } = await supabaseAdmin
    .from('customer_local_service_preferences')
    .update({ is_favourite: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('customer_id', userId);
  if (error) return res.status(400).json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

router.post('/recent', async (req: Request, res: Response) => {
  try {
    const userId = await authUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required.' });
    const payload = preferencePayload(userId, req.body || {}, false);
    const existing = await findPreference(userId, payload);
    const result = existing
      ? await supabaseAdmin
        .from('customer_local_service_preferences')
        .update({
          use_count: Number(existing.use_count || 0) + 1,
          last_used_at: new Date().toISOString(),
          provider_address: payload.provider_address,
          provider_logo_url: payload.provider_logo_url,
          latitude: payload.latitude,
          longitude: payload.longitude,
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id)
        .select('*')
        .single()
      : await supabaseAdmin.from('customer_local_service_preferences').insert(payload).select('*').single();
    if (result.error) return res.status(400).json({ ok: false, error: result.error.message });
    return res.json({ ok: true, preference: result.data });
  } catch (error: any) {
    console.error('[LocalServices] recent save failed:', error);
    return res.status(500).json({ ok: false, error: 'Failed to save recent provider.' });
  }
});

async function categorySlugFromId(categoryId?: string): Promise<string> {
  if (!categoryId) return '';
  const { data } = await supabaseAdmin
    .from('local_service_categories')
    .select('category_slug')
    .eq('id', categoryId)
    .maybeSingle();
  return String(data?.category_slug || '');
}

function preferenceToProvider(row: any) {
  return {
    id: row.id,
    preferenceId: row.id,
    providerId: row.provider_id,
    externalPlaceId: row.external_place_id,
    providerName: row.provider_name,
    providerLogoUrl: row.provider_logo_url,
    providerAddress: row.provider_address,
    providerLatitude: row.latitude,
    providerLongitude: row.longitude,
    categorySlug: row.category_slug,
    countryCode: row.country_code,
    source: row.provider_id ? 'recent' : 'manual',
    previouslyUsed: true,
    isFavourite: row.is_favourite === true,
    useCount: row.use_count || 1
  };
}

function preferencePayload(customerId: string, body: Record<string, any>, favourite: boolean) {
  const providerName = String(body.providerName || body.provider_name || '').trim();
  if (!providerName) throw new Error('Provider name is required.');
  return {
    customer_id: customerId,
    country_code: cleanCountry(body.countryCode || body.country_code),
    service_slug: canonicalService(body.serviceSlug || body.service_slug),
    category_slug: String(body.categorySlug || body.category_slug || '').trim().toLowerCase().replace(/_/g, '-'),
    provider_id: body.providerId || body.provider_id || null,
    external_place_id: body.externalPlaceId || body.external_place_id || null,
    provider_name: providerName,
    provider_address: String(body.providerAddress || body.provider_address || '').trim() || null,
    provider_logo_url: String(body.providerLogoUrl || body.provider_logo_url || '').trim() || null,
    latitude: body.providerLatitude ?? body.latitude ?? null,
    longitude: body.providerLongitude ?? body.longitude ?? null,
    is_favourite: favourite,
    last_used_at: new Date().toISOString()
  };
}

async function findPreference(customerId: string, payload: Record<string, any>): Promise<any | null> {
  let query = supabaseAdmin
    .from('customer_local_service_preferences')
    .select('id, use_count')
    .eq('customer_id', customerId)
    .eq('country_code', payload.country_code)
    .eq('service_slug', payload.service_slug)
    .eq('category_slug', payload.category_slug)
    .limit(1);
  if (payload.provider_id) query = query.eq('provider_id', payload.provider_id);
  else if (payload.external_place_id) query = query.eq('external_place_id', payload.external_place_id);
  else query = query.eq('provider_name', payload.provider_name);
  const { data } = await query.maybeSingle();
  return data || null;
}

export default router;
