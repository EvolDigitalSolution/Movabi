import { supabaseAdmin } from './supabase.service';

export interface CommissionSettings {
  percent: number;
  minFee: number;
  maxFee: number | null;
}

export interface DynamicPricingSettings {
  enabled: boolean;
  maxSurge: number;
  trafficMultiplier: number;
  weatherMultiplier: number;
  demandMultiplier: number;
  fuelMultiplier: number;
  timeOfDayEnabled: boolean;
  demandSupplyEnabled: boolean;
  weatherEnabled?: boolean;
  trafficEnabled?: boolean;
  eventMultiplierEnabled?: boolean;
}

export interface NegotiationSettings {
  enabled: boolean;
  timeoutSeconds: number;
  maxRounds: number;
  minServices: string[];
}

export interface BiddingSettings {
  enabled: boolean;
  enabledServices: string[];
  timeoutSeconds: number;
  maxBids: number;
  defaultServices: string[];
}

export interface SmartMatchingSettings {
  enabled: boolean;
  maxDistanceKm: number;
  ratingWeight: number;
  completionWeight: number;
  distanceWeight: number;
  responseWeight: number;
}

export interface MarketplaceFlags {
  marketplaceEnabled: boolean;
  negotiationEnabled: boolean;
  hybridNegotiationEnabled: boolean;
  biddingEnabled: boolean;
  dynamicPricingEnabled: boolean;
  smartMatchingEnabled: boolean;
}

export interface HybridNegotiationSettings {
  enabled: boolean;
  maxRounds: number;
  timeoutSeconds: number;
  maxDriverAttempts: number;
  claimTimeoutSeconds: number;
  enabledServices: string[];
  rideMinimumDistanceKm: number;
  makeOfferEnabled: boolean;
  acceptFareEnabled: boolean;
  allowlist?: string[];
}

export interface CommissionOverride {
  id?: string;
  tenant_id: string | null;
  service_type_slug: string | null;
  city_zone: string | null;
  driver_tier: string | null;
  promotion_period_id: string | null;
  commission_percent: number;
  platform_fee_percent: number;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

export class MarketplaceConfigService {
  static readonly DEFAULT_COMMISSION_PERCENT = 5;
  private static cache: Map<string, { value: unknown; expiresAt: number }> = new Map();
  private static readonly CACHE_TTL_MS = 30_000; // 30 seconds

  static invalidateCache(): void {
    this.cache.clear();
  }

  private static cacheKey(tenantId: string | null, key: string): string {
    return `${tenantId ?? 'global'}:${key}`;
  }

  private static getCached<T>(tenantId: string | null, key: string): T | undefined {
    const entry = this.cache.get(this.cacheKey(tenantId, key));
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value as T;
    }
    return undefined;
  }

  private static setCached<T>(tenantId: string | null, key: string, value: T): void {
    this.cache.set(this.cacheKey(tenantId, key), {
      value,
      expiresAt: Date.now() + this.CACHE_TTL_MS
    });
  }

  static async getRawSetting(
    key: string,
    tenantId: string | null = null
  ): Promise<Record<string, unknown> | null> {
    const query = supabaseAdmin
      .from('marketplace_settings')
      .select('value')
      .eq('key', key)
      .limit(1);

    if (tenantId) {
      query.or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
    } else {
      query.is('tenant_id', null);
    }

    const { data, error } = await query.single();

    if (error) {
      console.warn(`[MarketplaceConfig] getRawSetting error for ${key}:`, error.message);
      return null;
    }

    return (data?.value as Record<string, unknown>) ?? null;
  }

  static async getSetting<T>(
    key: string,
    tenantId: string | null = null,
    defaultValue: T | null = null
  ): Promise<T | null> {
    const cached = this.getCached<T>(tenantId, key);
    if (cached !== undefined) {
      return cached;
    }

    const raw = await this.getRawSetting(key, tenantId);
    if (!raw) {
      return defaultValue;
    }

    const value = raw as unknown as T;
    this.setCached(tenantId, key, value);
    return value;
  }

  static async getCommissionSettings(tenantId: string | null = null): Promise<CommissionSettings> {
    const raw = await this.getSetting<CommissionSettings>('commission', tenantId, {
      percent: MarketplaceConfigService.DEFAULT_COMMISSION_PERCENT,
      minFee: 0,
      maxFee: null
    });

    return {
      percent: Number(raw?.percent ?? MarketplaceConfigService.DEFAULT_COMMISSION_PERCENT),
      minFee: Number(raw?.minFee ?? 0),
      maxFee: raw?.maxFee === undefined ? null : Number(raw.maxFee)
    };
  }

  static async getDynamicPricingSettings(
    tenantId: string | null = null
  ): Promise<DynamicPricingSettings> {
    const raw = await this.getSetting<DynamicPricingSettings>('dynamic_pricing', tenantId, {
      enabled: true,
      maxSurge: 3.0,
      trafficMultiplier: 1,
      weatherMultiplier: 1,
      demandMultiplier: 1,
      fuelMultiplier: 1,
      timeOfDayEnabled: true,
      demandSupplyEnabled: true
    });

    return {
      enabled: Boolean(raw?.enabled ?? true),
      maxSurge: Number(raw?.maxSurge ?? 3.0),
      trafficMultiplier: Number((raw as any)?.trafficMultiplier ?? 1),
      weatherMultiplier: Number((raw as any)?.weatherMultiplier ?? 1),
      demandMultiplier: Number((raw as any)?.demandMultiplier ?? 1),
      fuelMultiplier: Number((raw as any)?.fuelMultiplier ?? 1),
      timeOfDayEnabled: Boolean(raw?.timeOfDayEnabled ?? true),
      demandSupplyEnabled: Boolean(raw?.demandSupplyEnabled ?? true),
      weatherEnabled: Boolean(raw?.weatherEnabled ?? false),
      trafficEnabled: Boolean(raw?.trafficEnabled ?? false),
      eventMultiplierEnabled: Boolean(raw?.eventMultiplierEnabled ?? false)
    };
  }

  static async getNegotiationSettings(tenantId: string | null = null): Promise<NegotiationSettings> {
    const raw = await this.getSetting<NegotiationSettings>('negotiation', tenantId, {
      enabled: true,
      timeoutSeconds: 120,
      maxRounds: 3,
      minServices: ['errand', 'delivery', 'van-moving']
    });

    return {
      enabled: Boolean(raw?.enabled ?? true),
      timeoutSeconds: Number(raw?.timeoutSeconds ?? 120),
      maxRounds: Number(raw?.maxRounds ?? 3),
      minServices: Array.isArray(raw?.minServices) ? (raw.minServices as string[]) : ['errand', 'delivery', 'van-moving']
    };
  }

  static async getBiddingSettings(tenantId: string | null = null): Promise<BiddingSettings> {
    const raw = await this.getSetting<BiddingSettings>('bidding', tenantId, {
      enabled: false,
      enabledServices: ['van', 'van_moving'],
      timeoutSeconds: 300,
      maxBids: 10,
      defaultServices: ['van', 'van_moving']
    });

    const asAny = raw as any;
    const enabledServices = Array.isArray(asAny?.enabledServices)
      ? (asAny.enabledServices as string[])
      : (Array.isArray(asAny?.defaultServices) ? (asAny.defaultServices as string[]) : ['van', 'van_moving']);

    return {
      enabled: Boolean(raw?.enabled ?? false),
      enabledServices,
      timeoutSeconds: Number(raw?.timeoutSeconds ?? 300),
      maxBids: Number(raw?.maxBids ?? 10),
      defaultServices: Array.isArray(raw?.defaultServices) ? (raw.defaultServices as string[]) : enabledServices
    };
  }

  static async getSmartMatchingSettings(
    tenantId: string | null = null
  ): Promise<SmartMatchingSettings> {
    const raw = await this.getSetting<SmartMatchingSettings>('smart_matching', tenantId, {
      enabled: true,
      maxDistanceKm: 10,
      ratingWeight: 0.25,
      completionWeight: 0.35,
      distanceWeight: 0.30,
      responseWeight: 0.10
    });

    return {
      enabled: Boolean(raw?.enabled ?? true),
      maxDistanceKm: Number(raw?.maxDistanceKm ?? 10),
      ratingWeight: Number(raw?.ratingWeight ?? 0.25),
      completionWeight: Number(raw?.completionWeight ?? 0.35),
      distanceWeight: Number(raw?.distanceWeight ?? 0.30),
      responseWeight: Number(raw?.responseWeight ?? 0.10)
    };
  }

  static async getHybridNegotiationSettings(tenantId: string | null = null): Promise<HybridNegotiationSettings> {
    const raw = await this.getSetting<HybridNegotiationSettings>('hybrid_negotiation', tenantId, {
      enabled: false,
      maxRounds: 3,
      timeoutSeconds: 120,
      maxDriverAttempts: 5,
      claimTimeoutSeconds: 60,
      enabledServices: ['shop', 'errand'],
      rideMinimumDistanceKm: 30,
      makeOfferEnabled: true,
      acceptFareEnabled: true,
      allowlist: []
    });

    const asAny = raw as any;
    return {
      enabled: Boolean(asAny?.enabled ?? false),
      maxRounds: Number(asAny?.maxRounds ?? 3),
      timeoutSeconds: Number(asAny?.timeoutSeconds ?? 120),
      maxDriverAttempts: Number(asAny?.maxDriverAttempts ?? 5),
      claimTimeoutSeconds: Number(asAny?.claimTimeoutSeconds ?? 60),
      enabledServices: Array.isArray(asAny?.enabledServices)
        ? (asAny.enabledServices as string[])
        : (Array.isArray(asAny?.eligibleServices) ? (asAny.eligibleServices as string[]) : ['shop', 'errand']),
      rideMinimumDistanceKm: Number(asAny?.rideMinimumDistanceKm ?? asAny?.longDistanceRideKm ?? 30),
      makeOfferEnabled: asAny?.makeOfferEnabled !== undefined ? Boolean(asAny.makeOfferEnabled) : true,
      acceptFareEnabled: asAny?.acceptFareEnabled !== undefined ? Boolean(asAny.acceptFareEnabled) : true,
      allowlist: Array.isArray(asAny?.allowlist) ? (asAny.allowlist as string[]) : []
    };
  }

  static async getFlags(tenantId: string | null = null): Promise<MarketplaceFlags> {
    const [commission, dynamic, negotiation, bidding, smart, hybrid] = await Promise.all([
      this.getCommissionSettings(tenantId),
      this.getDynamicPricingSettings(tenantId),
      this.getNegotiationSettings(tenantId),
      this.getBiddingSettings(tenantId),
      this.getSmartMatchingSettings(tenantId),
      this.getHybridNegotiationSettings(tenantId)
    ]);

    return {
      marketplaceEnabled: commission.percent >= 0,
      dynamicPricingEnabled: dynamic.enabled,
      negotiationEnabled: negotiation.enabled,
      hybridNegotiationEnabled: hybrid.enabled,
      biddingEnabled: bidding.enabled,
      smartMatchingEnabled: smart.enabled
    };
  }

  static isHybridServiceEnabled(
    settings: HybridNegotiationSettings,
    serviceTypeSlug: string | null | undefined,
    distanceKm?: number | null
  ): boolean {
    if (!serviceTypeSlug) return false;
    const canonical = this.canonicalServiceSlug(serviceTypeSlug);
    const enabled = settings.enabledServices.map((s) => this.canonicalServiceSlug(s));
    if (!enabled.includes(canonical)) return false;
    if (canonical === 'ride' && distanceKm !== undefined && distanceKm !== null && distanceKm < settings.rideMinimumDistanceKm) {
      return false;
    }
    return true;
  }

  static async isHybridEnabledForUser(
    userId: string | null | undefined,
    serviceTypeSlug?: string | null,
    distanceKm?: number | null,
    tenantId: string | null = null
  ): Promise<boolean> {
    if (!userId) {
      console.log('[HybridMarketplace] disabled for normal user: no user id');
      return false;
    }

    const settings = await this.getHybridNegotiationSettings(tenantId);
    const allowlist = settings.allowlist || [];

    if (!settings.enabled && !allowlist.includes(userId)) {
      console.log(`[HybridMarketplace] disabled for normal user ${userId}`);
      return false;
    }

    if (serviceTypeSlug !== undefined && serviceTypeSlug !== null && !this.isHybridServiceEnabled(settings, serviceTypeSlug, distanceKm)) {
      console.log(`[HybridMarketplace] disabled for normal user ${userId}: service ${serviceTypeSlug} not enabled`);
      return false;
    }

    console.log(`[HybridMarketplace] enabled for test user ${userId}`);
    return true;
  }

  static async getEffectiveCommissionPercent(
    serviceTypeSlug: string | null,
    cityZone: string | null,
    driverTier: string | null,
    tenantId: string | null = null
  ): Promise<number> {
    const base = await this.getCommissionSettings(tenantId);

    const now = new Date().toISOString();
    let query = supabaseAdmin
      .from('marketplace_commission_overrides')
      .select('*')
      .eq('is_active', true)
      .or('starts_at.is.null,starts_at.lte.' + now)
      .or('ends_at.is.null,ends_at.gte.' + now);

    if (tenantId) {
      query = query.or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
    } else {
      query = query.is('tenant_id', null);
    }

    const { data: overrides, error } = await query;

    if (error) {
      console.warn('[MarketplaceConfig] commission override lookup error:', error.message);
      return base.percent;
    }

    if (!overrides || overrides.length === 0) {
      return base.percent;
    }

    const matches = (overrides as CommissionOverride[]).filter(o => {
      const tenantMatch = o.tenant_id === null || o.tenant_id === tenantId;
      const serviceMatch = o.service_type_slug === null || o.service_type_slug === serviceTypeSlug;
      const zoneMatch = o.city_zone === null || o.city_zone === cityZone;
      const tierMatch = o.driver_tier === null || o.driver_tier === driverTier;
      const timeMatch =
        (o.starts_at === null || o.starts_at <= now) &&
        (o.ends_at === null || o.ends_at >= now);
      return tenantMatch && serviceMatch && zoneMatch && tierMatch && timeMatch;
    });

    if (matches.length === 0) {
      return base.percent;
    }

    // Pick the most specific override (most matching dimensions)
    const scored = matches.map(o => ({
      ...o,
      score: Number(o.service_type_slug !== null) + Number(o.city_zone !== null) + Number(o.driver_tier !== null)
    }));

    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0];

    return winner?.commission_percent ?? base.percent;
  }

  private static canonicalServiceSlug(slug: string): string {
    const raw = String(slug || '').trim().toLowerCase();

    if (['shop', 'shopping', 'errands', 'errand'].includes(raw)) return 'errand';
    if (['courier', 'parcel', 'package', 'delivery'].includes(raw)) return 'delivery';
    if (['van', 'moving', 'move', 'van-moving', 'van_moving', 'van moving'].includes(raw)) return 'van-moving';
    if (['ride', 'rides'].includes(raw)) return 'ride';

    return raw;
  }

  static async shouldEnableNegotiation(
    serviceTypeSlug: string,
    tenantId: string | null = null
  ): Promise<boolean> {
    const settings = await this.getNegotiationSettings(tenantId);
    const canonical = this.canonicalServiceSlug(serviceTypeSlug);
    return settings.enabled && settings.minServices.some(s => this.canonicalServiceSlug(s) === canonical);
  }

  static async shouldEnableBidding(
    serviceTypeSlug: string,
    tenantId: string | null = null
  ): Promise<boolean> {
    const settings = await this.getBiddingSettings(tenantId);
    const canonical = this.canonicalServiceSlug(serviceTypeSlug);
    const services = settings.enabledServices?.length ? settings.enabledServices : settings.defaultServices;
    return settings.enabled && services.some(s => this.canonicalServiceSlug(s) === canonical);
  }

  static async determineJobModes(
    serviceTypeSlug: string,
    tenantId: string | null = null
  ): Promise<{ negotiation: boolean; bidding: boolean }> {
    const [negotiation, bidding] = await Promise.all([
      this.shouldEnableNegotiation(serviceTypeSlug, tenantId),
      this.shouldEnableBidding(serviceTypeSlug, tenantId)
    ]);

    return { negotiation, bidding };
  }
}
