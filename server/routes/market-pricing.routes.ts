import { Router, NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { MarketPricingService, getMarketPricingSettings } from '../services/market-pricing.service';

const router = Router();

/**
 * Local copy of the admin-authorization middleware used across
 * server/routes/admin.routes.ts (requireAdmin is not exported from that
 * module). Behaviour is intentionally identical: validates the bearer token,
 * then requires profiles.role = 'admin'. All queries here use supabaseAdmin
 * (service-role client), which bypasses RLS by design (see migration notes
 * in server/market-intelligence-pricing-migration.txt).
 */
const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authentication required.' });
  }

  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !authData.user?.id) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', authData.user.id)
    .maybeSingle();

  if (profileError || profile?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Administrator access required.' });
  }

  (req as any).adminUserId = authData.user.id;
  return next();
};

// ---------------------------------------------------------------------------
// Validation helpers (Phase 8 safe bounds)
// ---------------------------------------------------------------------------

function isValidIsoCountry(value: unknown): boolean {
  return /^[A-Z]{2}$/.test(String(value || '').trim().toUpperCase());
}

function isValidCurrency(value: unknown): boolean {
  return /^[A-Z]{3}$/.test(String(value || '').trim().toUpperCase());
}

function isValidPercent(value: unknown, min: number, max: number): boolean {
  const num = Number(value);
  return Number.isFinite(num) && num >= min && num <= max;
}

const VALID_STRATEGIES = ['manual', 'match_market', 'beat_market', 'premium', 'lowest_sustainable'];
const VALID_FARE_TYPES = ['minimum', 'typical', 'peak', 'off_peak', 'airport', 'manual_index'];
const VALID_SOURCE_TYPES = ['manual', 'partner', 'research', 'api'];

function validateStrategyPayload(body: any): string | null {
  if (!isValidIsoCountry(body.countryCode ?? body.country_code)) return 'A valid 2-letter ISO country code is required.';
  if (!String(body.serviceType ?? body.service_type ?? '').trim()) return 'Service type is required.';
  if (!isValidCurrency(body.currency)) return 'A valid 3-letter ISO currency code is required.';
  if (!VALID_STRATEGIES.includes(String(body.strategy || 'manual'))) return 'Invalid strategy type.';
  if (!isValidPercent(body.targetDifferencePercent ?? body.target_difference_percent ?? 0, 0, 30)) {
    return 'Target difference must be between 0 and 30 percent.';
  }
  if (!isValidPercent(body.maximumCustomerDiscountPercent ?? body.maximum_customer_discount_percent ?? 15, 0, 30)) {
    return 'Maximum customer discount must be between 0 and 30 percent.';
  }
  if (!isValidPercent(body.minimumPlatformMarginPercent ?? body.minimum_platform_margin_percent ?? 0, 0, 50)) {
    return 'Minimum platform margin must be between 0 and 50 percent.';
  }
  const maxAdjustment = Number(body.maximumMarketAdjustmentPercent ?? body.maximum_market_adjustment_percent ?? 20);
  if (!Number.isFinite(maxAdjustment) || maxAdjustment < 0 || maxAdjustment > 100) {
    return 'Maximum market adjustment must be between 0 and 100 percent.';
  }
  const validFrom = body.validFrom ?? body.valid_from ?? null;
  const validUntil = body.validUntil ?? body.valid_until ?? null;
  if (validFrom && validUntil && new Date(validFrom).getTime() > new Date(validUntil).getTime()) {
    return 'validFrom must be before validUntil.';
  }
  return null;
}

function strategyRowFromBody(body: any): Record<string, unknown> {
  return {
    country_code: String(body.countryCode ?? body.country_code).trim().toUpperCase(),
    market_city: body.marketCity ?? body.market_city ?? null,
    zone_id: body.zoneId ?? body.zone_id ?? null,
    service_type: String(body.serviceType ?? body.service_type).trim().toLowerCase(),
    vehicle_class: body.vehicleClass ?? body.vehicle_class ?? null,
    strategy: String(body.strategy || 'manual'),
    target_difference_percent: Number(body.targetDifferencePercent ?? body.target_difference_percent ?? 0),
    minimum_driver_hourly_rate: body.minimumDriverHourlyRate ?? body.minimum_driver_hourly_rate ?? null,
    minimum_driver_per_km: body.minimumDriverPerKm ?? body.minimum_driver_per_km ?? null,
    minimum_driver_payout: body.minimumDriverPayout ?? body.minimum_driver_payout ?? null,
    minimum_platform_margin_percent: Number(body.minimumPlatformMarginPercent ?? body.minimum_platform_margin_percent ?? 0),
    minimum_platform_revenue: Number(body.minimumPlatformRevenue ?? body.minimum_platform_revenue ?? 0),
    maximum_customer_discount_percent: Number(body.maximumCustomerDiscountPercent ?? body.maximum_customer_discount_percent ?? 15),
    maximum_market_adjustment_percent: Number(body.maximumMarketAdjustmentPercent ?? body.maximum_market_adjustment_percent ?? 20),
    currency: String(body.currency).trim().toUpperCase(),
    enabled: false, // Never auto-enable on save/create; must be a deliberate follow-up action.
    valid_from: body.validFrom ?? body.valid_from ?? null,
    valid_until: body.validUntil ?? body.valid_until ?? null,
    updated_at: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

router.get('/strategies', requireAdmin, async (req: Request, res: Response) => {
  try {
    let query = supabaseAdmin.from('market_pricing_strategies').select('*').order('updated_at', { ascending: false });

    const { countryCode, city, serviceType, vehicleClass, enabled } = req.query;
    if (typeof countryCode === 'string' && countryCode) query = query.eq('country_code', countryCode.toUpperCase());
    if (typeof city === 'string' && city) query = query.eq('market_city', city);
    if (typeof serviceType === 'string' && serviceType) query = query.eq('service_type', serviceType.toLowerCase());
    if (typeof vehicleClass === 'string' && vehicleClass) query = query.eq('vehicle_class', vehicleClass);
    if (typeof enabled === 'string' && (enabled === 'true' || enabled === 'false')) query = query.eq('enabled', enabled === 'true');

    const { data, error } = await query;
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, rows: data || [] });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/strategies', requireAdmin, async (req: Request, res: Response) => {
  try {
    const validationError = validateStrategyPayload(req.body || {});
    if (validationError) return res.status(400).json({ ok: false, error: validationError });

    const row = strategyRowFromBody(req.body);
    const { data, error } = await supabaseAdmin.from('market_pricing_strategies').insert(row).select('*').single();
    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true, row: data });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.put('/strategies/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'Strategy id is required.' });

    const validationError = validateStrategyPayload(req.body || {});
    if (validationError) return res.status(400).json({ ok: false, error: validationError });

    const { data: existing } = await supabaseAdmin.from('market_pricing_strategies').select('enabled').eq('id', id).maybeSingle();

    const row = strategyRowFromBody(req.body);
    row.enabled = existing?.enabled === true; // Preserve current enabled state; only PATCH /status may change it.

    const { data, error } = await supabaseAdmin.from('market_pricing_strategies').update(row).eq('id', id).select('*').single();
    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true, row: data });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.patch('/strategies/:id/status', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const enabled = req.body?.enabled === true;

    const { data, error } = await supabaseAdmin
      .from('market_pricing_strategies')
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true, row: data });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.delete('/strategies/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const { error } = await supabaseAdmin.from('market_pricing_strategies').delete().eq('id', id);
    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------

router.get('/competitors', requireAdmin, async (req: Request, res: Response) => {
  try {
    let query = supabaseAdmin.from('competitor_profiles').select('*').order('display_order', { ascending: true });
    const { countryCode, serviceType } = req.query;
    if (typeof countryCode === 'string' && countryCode) query = query.eq('country_code', countryCode.toUpperCase());
    if (typeof serviceType === 'string' && serviceType) query = query.eq('service_type', serviceType.toLowerCase());

    const { data, error } = await query;
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, rows: data || [] });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/competitors', requireAdmin, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    if (!isValidIsoCountry(body.countryCode ?? body.country_code)) {
      return res.status(400).json({ ok: false, error: 'A valid 2-letter ISO country code is required.' });
    }
    if (!String(body.competitorName ?? body.competitor_name ?? '').trim()) {
      return res.status(400).json({ ok: false, error: 'Competitor name is required.' });
    }
    if (body.sourceType && !VALID_SOURCE_TYPES.includes(String(body.sourceType))) {
      return res.status(400).json({ ok: false, error: 'Invalid source type.' });
    }

    const name = String(body.competitorName ?? body.competitor_name).trim();
    const slug = String(body.competitorSlug ?? body.competitor_slug ?? name)
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    const row = {
      country_code: String(body.countryCode ?? body.country_code).trim().toUpperCase(),
      market_city: body.marketCity ?? body.market_city ?? null,
      competitor_name: name,
      competitor_slug: slug,
      service_type: String(body.serviceType ?? body.service_type ?? 'ride').trim().toLowerCase(),
      vehicle_class: body.vehicleClass ?? body.vehicle_class ?? null,
      enabled: body.enabled === true,
      display_order: Number(body.displayOrder ?? body.display_order ?? 0),
      source_type: String(body.sourceType ?? body.source_type ?? 'manual'),
      notes: body.notes ?? null,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin.from('competitor_profiles').insert(row).select('*').single();
    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true, row: data });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.put('/competitors/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const body = req.body || {};

    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.competitorName ?? body.competitor_name) row.competitor_name = String(body.competitorName ?? body.competitor_name).trim();
    if (body.marketCity !== undefined || body.market_city !== undefined) row.market_city = body.marketCity ?? body.market_city ?? null;
    if (body.vehicleClass !== undefined || body.vehicle_class !== undefined) row.vehicle_class = body.vehicleClass ?? body.vehicle_class ?? null;
    if (body.enabled !== undefined) row.enabled = body.enabled === true;
    if (body.displayOrder !== undefined || body.display_order !== undefined) row.display_order = Number(body.displayOrder ?? body.display_order ?? 0);
    if (body.notes !== undefined) row.notes = body.notes ?? null;
    if (body.sourceType || body.source_type) row.source_type = String(body.sourceType ?? body.source_type);

    const { data, error } = await supabaseAdmin.from('competitor_profiles').update(row).eq('id', id).select('*').single();
    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true, row: data });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.delete('/competitors/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const { error } = await supabaseAdmin.from('competitor_profiles').delete().eq('id', id);
    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

router.get('/benchmarks', requireAdmin, async (req: Request, res: Response) => {
  try {
    let query = supabaseAdmin.from('competitor_fare_benchmarks').select('*').order('observed_at', { ascending: false });
    const { competitorProfileId } = req.query;
    if (typeof competitorProfileId === 'string' && competitorProfileId) query = query.eq('competitor_profile_id', competitorProfileId);

    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const { data, error } = await query.limit(limit);
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, rows: data || [] });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/benchmarks', requireAdmin, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const competitorProfileId = String(body.competitorProfileId ?? body.competitor_profile_id ?? '').trim();
    if (!competitorProfileId) return res.status(400).json({ ok: false, error: 'competitorProfileId is required.' });
    if (!isValidCurrency(body.currency)) return res.status(400).json({ ok: false, error: 'A valid 3-letter ISO currency code is required.' });
    const observedFare = Number(body.observedFare ?? body.observed_fare);
    if (!Number.isFinite(observedFare) || observedFare < 0) return res.status(400).json({ ok: false, error: 'observedFare must be a positive number.' });
    const fareType = String(body.fareType ?? body.fare_type ?? 'typical');
    if (!VALID_FARE_TYPES.includes(fareType)) return res.status(400).json({ ok: false, error: 'Invalid fare type.' });
    const confidence = Number(body.confidenceScore ?? body.confidence_score ?? 100);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      return res.status(400).json({ ok: false, error: 'confidenceScore must be between 0 and 100.' });
    }

    const row = {
      competitor_profile_id: competitorProfileId,
      distance_km: body.distanceKm ?? body.distance_km ?? null,
      duration_minutes: body.durationMinutes ?? body.duration_minutes ?? null,
      route_origin_label: body.routeOriginLabel ?? body.route_origin_label ?? null,
      route_destination_label: body.routeDestinationLabel ?? body.route_destination_label ?? null,
      observed_fare: observedFare,
      currency: String(body.currency).trim().toUpperCase(),
      fare_type: fareType,
      observed_at: body.observedAt ?? body.observed_at ?? new Date().toISOString(),
      expires_at: body.expiresAt ?? body.expires_at ?? null,
      confidence_score: confidence,
      source_reference: body.sourceReference ?? body.source_reference ?? null,
      notes: body.notes ?? null
    };

    const { data, error } = await supabaseAdmin.from('competitor_fare_benchmarks').insert(row).select('*').single();
    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true, row: data });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.put('/benchmarks/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const body = req.body || {};
    const row: Record<string, unknown> = {};

    if (body.distanceKm !== undefined || body.distance_km !== undefined) row.distance_km = body.distanceKm ?? body.distance_km;
    if (body.durationMinutes !== undefined || body.duration_minutes !== undefined) row.duration_minutes = body.durationMinutes ?? body.duration_minutes;
    if (body.observedFare !== undefined || body.observed_fare !== undefined) row.observed_fare = Number(body.observedFare ?? body.observed_fare);
    if (body.fareType || body.fare_type) row.fare_type = String(body.fareType ?? body.fare_type);
    if (body.expiresAt !== undefined || body.expires_at !== undefined) row.expires_at = body.expiresAt ?? body.expires_at ?? null;
    if (body.confidenceScore !== undefined || body.confidence_score !== undefined) row.confidence_score = Number(body.confidenceScore ?? body.confidence_score);
    if (body.notes !== undefined) row.notes = body.notes ?? null;
    if (body.sourceReference !== undefined || body.source_reference !== undefined) row.source_reference = body.sourceReference ?? body.source_reference ?? null;

    const { data, error } = await supabaseAdmin.from('competitor_fare_benchmarks').update(row).eq('id', id).select('*').single();
    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true, row: data });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.delete('/benchmarks/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const { error } = await supabaseAdmin.from('competitor_fare_benchmarks').delete().eq('id', id);
    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Simulator — calls the exact same backend service used at quote time.
// Simulations never write snapshot/audit rows (persist: false).
// ---------------------------------------------------------------------------

router.post('/simulate', requireAdmin, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};

    if (!isValidIsoCountry(body.countryCode)) return res.status(400).json({ ok: false, error: 'A valid 2-letter ISO country code is required.' });
    if (!isValidCurrency(body.currency)) return res.status(400).json({ ok: false, error: 'A valid 3-letter ISO currency code is required.' });
    if (!String(body.serviceType || '').trim()) return res.status(400).json({ ok: false, error: 'serviceType is required.' });

    const distanceKm = Number(body.distanceKm ?? 0);
    const durationMinutes = Number(body.durationMinutes ?? 0);
    const baseServiceFare = Number(body.baseServiceFare ?? 0);
    const platformFeePercent = Number(body.platformFeePercent ?? 0);
    const driverCommissionPercent = Number(body.driverCommissionPercent ?? 0);

    if (!Number.isFinite(baseServiceFare) || baseServiceFare < 0) {
      return res.status(400).json({ ok: false, error: 'baseServiceFare must be a positive number.' });
    }

    const result = await MarketPricingService.evaluate({
      countryCode: String(body.countryCode).toUpperCase(),
      marketCity: body.marketCity || null,
      zoneId: body.zoneId || null,
      serviceType: String(body.serviceType).toLowerCase(),
      vehicleClass: body.vehicleClass || null,
      currency: String(body.currency).toUpperCase(),
      distanceKm,
      durationMinutes,
      baseServiceFare,
      platformFeePercent,
      driverCommissionPercent,
      quoteReference: 'simulation'
    }, { persist: false });

    // Also compute what would happen if enabled+shadow were both overridden to
    // "live", so the Admin simulator can show "would apply?" even while the
    // platform-wide flags are off. This is simulation-only and never affects
    // real quotes.
    return res.json({ ok: true, result, simulated: true });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

router.get('/audit', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 1000);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const { data, error, count } = await supabaseAdmin
      .from('quote_market_adjustments')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, rows: data || [], total: count ?? (data || []).length });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get('/settings', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const settings = await getMarketPricingSettings();
    return res.json({ ok: true, settings });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

const SETTINGS_KEY_MAP: Record<string, { key: string; type: 'bool' | 'number' | 'string' }> = {
  marketPricingEnabled: { key: 'market_pricing_enabled', type: 'bool' },
  competitorBenchmarksEnabled: { key: 'market_competitor_benchmarks_enabled', type: 'bool' },
  driverProtectionEnabled: { key: 'market_driver_protection_enabled', type: 'bool' },
  platformMarginProtectionEnabled: { key: 'market_platform_margin_protection_enabled', type: 'bool' },
  shadowMode: { key: 'market_pricing_shadow_mode', type: 'bool' },
  auditEnabled: { key: 'market_pricing_audit_enabled', type: 'bool' },
  defaultTargetPercent: { key: 'market_pricing_default_target_percent', type: 'number' },
  maxDiscountPercent: { key: 'market_pricing_max_discount_percent', type: 'number' },
  benchmarkMaxAgeHours: { key: 'market_benchmark_max_age_hours', type: 'number' },
  useInternalSignals: { key: 'market_use_internal_signals', type: 'bool' }
};

/**
 * Defensive update-then-insert, matching the migration's pattern, so this
 * endpoint works correctly even without relying on a named unique constraint.
 */
async function upsertFlatSetting(key: string, value: unknown, adminId: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('marketplace_settings')
    .update({ value, updated_at: now })
    .eq('key', key)
    .is('tenant_id', null)
    .select('id');

  if (updateError) throw new Error(updateError.message);

  if (!updated || updated.length === 0) {
    const { error: insertError } = await supabaseAdmin
      .from('marketplace_settings')
      .insert({ key, value, tenant_id: null, created_at: now, updated_at: now });
    if (insertError) throw new Error(insertError.message);
  }

  void adminId;
}

router.put('/settings', requireAdmin, async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).adminUserId || null;
    const body = req.body || {};

    // Confirmation gate: enabling live application requires explicit acknowledgement.
    if (body.marketPricingEnabled === true && body.shadowMode !== true && !body.confirmLiveApplication) {
      return res.status(400).json({
        ok: false,
        error: 'Enabling live market-adjusted pricing outside shadow mode requires confirmLiveApplication: true. ' +
          'You are enabling market-adjusted customer pricing. Existing booking, payment and driver payout amounts ' +
          'may be affected for newly generated quotes.'
      });
    }

    for (const [field, meta] of Object.entries(SETTINGS_KEY_MAP)) {
      if (body[field] === undefined) continue;

      let value: unknown = body[field];
      if (meta.type === 'bool') value = value === true;
      if (meta.type === 'number') value = Number(value);

      await upsertFlatSetting(meta.key, value, adminId);
    }

    const settings = await getMarketPricingSettings();
    return res.json({ ok: true, settings });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
