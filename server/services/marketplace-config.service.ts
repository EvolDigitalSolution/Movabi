import { supabaseAdmin } from './supabase.service';

export interface CommissionSettings {
  percent: number;
  minFee: number;
  maxFee: number | null;
  platformFeePercent: number;
}

export interface DynamicPricingSettings {
  enabled: boolean;
  maxSurge: number;
  trafficMultiplier: number;
  weatherMultiplier: number;
  demandMultiplier: number;
  fuelMultiplier: number;
  supplyScarcityMultiplier: number;
  rainMultiplier: number;
  floodMultiplier: number;
  peakMultiplier: number;
  airportSurcharge: number;
  publicHolidayMultiplier: number;
  eventMultiplier: number;
  nearbyDriverDiscount: number;
  minimumFare: number;
  maximumFareCap: number;
  nightMultiplier: number;
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
  enabledServices: string[];
  defaultServices: string[];
}

export interface BiddingSettings {
  enabled: boolean;
  enabledServices: string[];
  timeoutSeconds: number;
  maxBids: number;
  defaultServices: string[];
  minBid: number;
  maxBidPercentageAboveSuggestedFare: number;
  customerCanChooseDriver: boolean;
  showDriverEta: boolean;
  showDriverRating: boolean;
  showCompletedTrips: boolean;
  autoExpireUnsuccessfulBids: boolean;
}

export interface SmartMatchingSettings {
  enabled: boolean;
  maxDistanceKm: number;
  searchBatchSize: number;
  driverClaimBatchSize: number;
  ratingWeight: number;
  completionWeight: number;
  distanceWeight: number;
  responseWeight: number;
  etaWeight: number;
  acceptanceRateWeight: number;
  cancellationRateWeight: number;
  responseTimeWeight: number;
  vehicleCompatibilityWeight: number;
  idleTimeWeight: number;
  repeatCustomerBonus: number;
  driverTierBonus: number;
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
  eligibleServices?: string[];
  rideMinimumDistanceKm: number;
  rideMode: 'disabled' | 'long_distance_only' | 'all_rides';
  makeOfferEnabled: boolean;
  acceptFareEnabled: boolean;
  allowCustomerCounterOffer: boolean;
  allowDriverCounterOffer: boolean;
  allowCustomerTryAnotherDriver: boolean;
  autoReleaseOnTimeout: boolean;
  autoReleaseOnDriverOffline: boolean;
  paymentDeadlineAfterFareAgreement: number;
  assignNegotiatingDriverAfterPayment: boolean;
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

export interface ServiceRule {
  enabled: boolean;
  marketplaceEnabled: boolean;
  negotiationEnabled: boolean;
  biddingEnabled: boolean;
  dynamicPricingEnabled: boolean;
  smartMatchingEnabled: boolean;
  minimumDistanceKm: number;
  maximumDistanceKm: number;
  minimumFare: number;
  maximumFare: number;
  paymentBeforeDispatch: boolean;
  allowScheduledJobs: boolean;
  allowMultiStop: boolean;
  allowHourlyBooking: boolean;
}

export type ServiceRules = Record<string, Partial<ServiceRule>>;

export interface EffectiveHybridStatus {
  enabled: boolean;
  reason: string | null;
  marketplaceEnabled: boolean;
  hybridEnabled: boolean;
  serviceMarketplaceEnabled: boolean;
  serviceNegotiationEnabled: boolean;
  emergencyDisabled: boolean;
  canonicalServiceSlug: string;
}

export interface PaymentRules {
  cardEnabled: boolean;
  walletEnabled: boolean;
  cashEnabled: boolean;
  manualCaptureEnabled: boolean;
  paymentBeforeDispatch: boolean;
  paymentDeadlineAfterFareAgreement: number;
  itemBudgetReservationEnabled: boolean;
  itemBudgetMaximum: number;
  refundReleaseTimeout: number;
  duplicatePaymentIntentProtection: boolean;
  allowedPaymentStatusesForDispatch: string[];
}

export interface NotificationRule {
  pushEnabled: boolean;
  inAppEnabled: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  repeatInterval: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export interface NotificationRules {
  customer: Record<string, NotificationRule>;
  driver: Record<string, NotificationRule>;
}

export interface DriverRules {
  minimumDriverRating: number;
  minimumCompletedTrips: number;
  requiredVerificationStatus: string;
  requireActiveVehicle: boolean;
  requireStripeConnected: boolean;
  requireSufficientWallet: boolean;
  maximumActiveNegotiations: number;
  maximumActiveJobs: number;
  cooldownAfterDeclineSeconds: number;
  autoSuspendAfterRepeatedCancellations: number;
  allowFavouriteRepeatDrivers: boolean;
}

export interface MarketplaceDraftRules {
  enabled: boolean;
  pendingFareTtlMinutes: number;
  fareAgreedUnpaidTtlMinutes: number;
  negotiationIdleTtlMinutes: number;
  cleanupIntervalMinutes: number;
  deleteExpiredDrafts: boolean;
}

export interface EmergencyControls {
  disableMarketplaceGlobally: boolean;
  disableMakeOffer: boolean;
  disableHybridNegotiation: boolean;
  disableBidding: boolean;
  disableDynamicPricing: boolean;
  disableByService: Record<string, boolean>;
  forceAcceptFareOnly: boolean;
  forceNormalBookingFlow: boolean;
  disableCardPayments: boolean;
  disableWalletPayments: boolean;
}

export class MarketplaceConfigService {
  private static cache: Map<string, { value: unknown; expiresAt: number }> = new Map();
  private static readonly CACHE_TTL_MS = 30_000; // 30 seconds
  private static lastKnownCommission: Map<string, CommissionSettings> = new Map();

  static getCommissionFallbackPercent(): number {
    const env = process.env.MARKETPLACE_COMMISSION_FALLBACK_PERCENT;
    const parsed = env ? Number(env) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
  }

  private static getLastKnownCommission(tenantId: string | null): CommissionSettings | undefined {
    return this.lastKnownCommission.get(this.cacheKey(tenantId, 'commission'));
  }

  private static setLastKnownCommission(tenantId: string | null, value: CommissionSettings): void {
    this.lastKnownCommission.set(this.cacheKey(tenantId, 'commission'), value);
  }

  static invalidateCache(): void {
    this.cache.clear();
  }

  static clearCache(): void {
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

  private static parseEnabledValue(value: unknown, fallback = true): boolean {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'enabled', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'disabled', 'off'].includes(normalized)) return false;
      return fallback;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if ('enabled' in record) return this.parseEnabledValue(record['enabled'], fallback);
      if ('marketplaceEnabled' in record) return this.parseEnabledValue(record['marketplaceEnabled'], fallback);
      if ('value' in record) return this.parseEnabledValue(record['value'], fallback);
    }
    return fallback;
  }

  private static isJsonObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private static serviceRuleFor(
    serviceRules: ServiceRules,
    serviceTypeSlug: string | null | undefined
  ): Partial<ServiceRule> | null {
    if (!serviceTypeSlug) return null;
    const canonical = this.canonicalServiceSlug(serviceTypeSlug);
    return serviceRules[canonical] || (canonical === 'errand' ? serviceRules['shop'] : null) || null;
  }

  private static getServiceBlockReason(
    serviceTypeSlug: string,
    marketplaceEnabled: boolean,
    hybrid: HybridNegotiationSettings,
    serviceRules: ServiceRules,
    emergency: EmergencyControls
  ): string | null {
    const canonical = this.canonicalServiceSlug(serviceTypeSlug);
    if (emergency.disableMarketplaceGlobally || emergency.forceNormalBookingFlow) return 'Emergency override';
    if (!marketplaceEnabled) return 'Global disabled';
    if (emergency.disableHybridNegotiation) return 'Emergency override';
    if (!hybrid.enabled) return 'Hybrid disabled';
    if (emergency.disableByService?.[canonical]) return 'Emergency override';

    const rule = this.serviceRuleFor(serviceRules, canonical);
    if (!rule || rule.enabled === false || rule.marketplaceEnabled === false || rule.negotiationEnabled === false) {
      return 'Service disabled';
    }

    if (!this.isHybridServiceEnabled(hybrid, canonical)) return 'Hybrid disabled';
    return null;
  }

  static async getRawSetting(
    key: string,
    tenantId: string | null = null
  ): Promise<unknown | null> {
    if (tenantId) {
      const { data: tenantRow, error: tenantError } = await supabaseAdmin
        .from('marketplace_settings')
        .select('value')
        .eq('key', key)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (tenantError) {
        console.warn(`[MarketplaceConfig] getRawSetting tenant error for ${key}:`, tenantError.message);
      }

      if (tenantRow?.value !== undefined) {
        return tenantRow.value ?? null;
      }
    }

    const { data, error } = await supabaseAdmin
      .from('marketplace_settings')
      .select('value')
      .eq('key', key)
      .is('tenant_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn(`[MarketplaceConfig] getRawSetting error for ${key}:`, error.message);
      return null;
    }

    return data?.value ?? null;
  }

  private static async loadRawSettingForResolver(
    key: string,
    tenantId: string | null = null
  ): Promise<{ value: unknown | null; found: boolean; error: string | null }> {
    if (tenantId) {
      const { data: tenantRow, error: tenantError } = await supabaseAdmin
        .from('marketplace_settings')
        .select('value')
        .eq('key', key)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (tenantError) {
        console.warn(`[MarketplaceConfig] effective hybrid resolver failed loading tenant key ${key}:`, tenantError.message);
        return { value: null, found: false, error: tenantError.message };
      }

      if (tenantRow?.value !== undefined) {
        return { value: tenantRow.value ?? null, found: true, error: null };
      }
    }

    const { data, error } = await supabaseAdmin
      .from('marketplace_settings')
      .select('value')
      .eq('key', key)
      .is('tenant_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn(`[MarketplaceConfig] effective hybrid resolver failed loading global key ${key}:`, error.message);
      return { value: null, found: false, error: error.message };
    }

    return { value: data?.value ?? null, found: data?.value !== undefined, error: null };
  }

  static async getSetting<T>(
    key: string,
    tenantId: string | null = null,
    defaultValue: Partial<T> | null = null
  ): Promise<T | null> {
    const cached = this.getCached<T>(tenantId, key);
    if (cached !== undefined) {
      return cached;
    }

    const raw = await this.getRawSetting(key, tenantId);
    if (!this.isJsonObject(raw)) {
      return defaultValue as T;
    }

    const value = { ...(defaultValue ?? {}), ...raw } as unknown as T;
    this.setCached(tenantId, key, value);
    return value;
  }

  static async getCommissionSettings(tenantId: string | null = null): Promise<CommissionSettings> {
    const fallbackPercent = this.getCommissionFallbackPercent();
    const defaults: CommissionSettings = {
      percent: fallbackPercent,
      minFee: 0,
      maxFee: null,
      platformFeePercent: 0
    };

    const raw = await this.getRawSetting('commission', tenantId);

    if (this.isJsonObject(raw)) {
      const value = { ...defaults, ...raw } as CommissionSettings;
      const maxFee = value.maxFee === null || value.maxFee === undefined ? null : Number(value.maxFee);
      const settings: CommissionSettings = {
        percent: Number(value.percent ?? fallbackPercent),
        minFee: Number(value.minFee ?? 0),
        maxFee,
        platformFeePercent: Number(value.platformFeePercent ?? 0)
      };
      this.setCached(tenantId, 'commission', settings);
      this.setLastKnownCommission(tenantId, settings);
      return settings;
    }

    const lastKnown = this.getLastKnownCommission(tenantId);
    if (lastKnown) {
      console.warn(`[MarketplaceConfig] commission fallback used: last-known-good value`, { tenantId, ...lastKnown });
      return lastKnown;
    }

    const fallbackSettings: CommissionSettings = {
      percent: fallbackPercent,
      minFee: 0,
      maxFee: null,
      platformFeePercent: 0
    };
    console.warn(`[MarketplaceConfig] commission fallback used: environment fallback ${fallbackPercent}%`, { tenantId, ...fallbackSettings });
    return fallbackSettings;
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
      supplyScarcityMultiplier: 1,
      rainMultiplier: 1,
      floodMultiplier: 1,
      peakMultiplier: 1.15,
      airportSurcharge: 0,
      publicHolidayMultiplier: 1,
      eventMultiplier: 1,
      nearbyDriverDiscount: 1,
      minimumFare: 0,
      maximumFareCap: 0,
      nightMultiplier: 1.25,
      timeOfDayEnabled: true,
      demandSupplyEnabled: true
    });

    const asAny = raw as any;
    return {
      enabled: Boolean(raw?.enabled ?? true),
      maxSurge: Number(raw?.maxSurge ?? 3.0),
      trafficMultiplier: Number(asAny?.trafficMultiplier ?? 1),
      weatherMultiplier: Number(asAny?.weatherMultiplier ?? 1),
      demandMultiplier: Number(asAny?.demandMultiplier ?? 1),
      fuelMultiplier: Number(asAny?.fuelMultiplier ?? 1),
      supplyScarcityMultiplier: Number(asAny?.supplyScarcityMultiplier ?? 1),
      rainMultiplier: Number(asAny?.rainMultiplier ?? 1),
      floodMultiplier: Number(asAny?.floodMultiplier ?? 1),
      peakMultiplier: Number(asAny?.peakMultiplier ?? 1),
      airportSurcharge: Number(asAny?.airportSurcharge ?? 0),
      publicHolidayMultiplier: Number(asAny?.publicHolidayMultiplier ?? 1),
      eventMultiplier: Number(asAny?.eventMultiplier ?? 1),
      nearbyDriverDiscount: Number(asAny?.nearbyDriverDiscount ?? 1),
      minimumFare: Number(asAny?.minimumFare ?? 0),
      maximumFareCap: Number(asAny?.maximumFareCap ?? 0),
      nightMultiplier: Number(asAny?.nightMultiplier ?? 1.25),
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
      minServices: ['errand', 'delivery', 'van-moving'],
      enabledServices: ['errand', 'delivery', 'van-moving'],
      defaultServices: ['errand', 'delivery', 'van-moving']
    });

    const asAny = raw as any;
    const enabledServices = Array.isArray(asAny?.enabledServices)
      ? (asAny.enabledServices as string[])
      : (Array.isArray(asAny?.minServices) ? (asAny.minServices as string[]) : ['errand', 'delivery', 'van-moving']);

    return {
      enabled: Boolean(raw?.enabled ?? true),
      timeoutSeconds: Number(raw?.timeoutSeconds ?? 120),
      maxRounds: Number(raw?.maxRounds ?? 3),
      minServices: Array.isArray(raw?.minServices) ? (raw.minServices as string[]) : enabledServices,
      enabledServices,
      defaultServices: Array.isArray(asAny?.defaultServices) ? (asAny.defaultServices as string[]) : enabledServices
    };
  }

  static async getBiddingSettings(tenantId: string | null = null): Promise<BiddingSettings> {
    const raw = await this.getSetting<BiddingSettings>('bidding', tenantId, {
      enabled: false,
      enabledServices: ['van', 'van_moving'],
      timeoutSeconds: 300,
      maxBids: 10,
      defaultServices: ['van', 'van_moving'],
      minBid: 0,
      maxBidPercentageAboveSuggestedFare: 50,
      customerCanChooseDriver: false,
      showDriverEta: false,
      showDriverRating: false,
      showCompletedTrips: false,
      autoExpireUnsuccessfulBids: true
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
      defaultServices: Array.isArray(asAny?.defaultServices) ? (asAny.defaultServices as string[]) : enabledServices,
      minBid: Number(asAny?.minBid ?? 0),
      maxBidPercentageAboveSuggestedFare: Number(asAny?.maxBidPercentageAboveSuggestedFare ?? 50),
      customerCanChooseDriver: Boolean(asAny?.customerCanChooseDriver ?? false),
      showDriverEta: Boolean(asAny?.showDriverEta ?? false),
      showDriverRating: Boolean(asAny?.showDriverRating ?? false),
      showCompletedTrips: Boolean(asAny?.showCompletedTrips ?? false),
      autoExpireUnsuccessfulBids: asAny?.autoExpireUnsuccessfulBids !== undefined ? Boolean(asAny.autoExpireUnsuccessfulBids) : true
    };
  }

  static async getSmartMatchingSettings(
    tenantId: string | null = null
  ): Promise<SmartMatchingSettings> {
    const raw = await this.getSetting<SmartMatchingSettings>('smart_matching', tenantId, {
      enabled: true,
      maxDistanceKm: 10,
      searchBatchSize: 50,
      driverClaimBatchSize: 5,
      ratingWeight: 0.25,
      completionWeight: 0.35,
      distanceWeight: 0.30,
      responseWeight: 0.10,
      etaWeight: 0.0,
      acceptanceRateWeight: 0.0,
      cancellationRateWeight: 0.0,
      responseTimeWeight: 0.0,
      vehicleCompatibilityWeight: 0.0,
      idleTimeWeight: 0.0,
      repeatCustomerBonus: 0,
      driverTierBonus: 0
    });

    const asAny = raw as any;
    return {
      enabled: Boolean(raw?.enabled ?? true),
      maxDistanceKm: Number(raw?.maxDistanceKm ?? 10),
      searchBatchSize: Number(asAny?.searchBatchSize ?? 50),
      driverClaimBatchSize: Number(asAny?.driverClaimBatchSize ?? 5),
      ratingWeight: Number(raw?.ratingWeight ?? 0.25),
      completionWeight: Number(raw?.completionWeight ?? 0.35),
      distanceWeight: Number(raw?.distanceWeight ?? 0.30),
      responseWeight: Number(raw?.responseWeight ?? 0.10),
      etaWeight: Number(asAny?.etaWeight ?? 0),
      acceptanceRateWeight: Number(asAny?.acceptanceRateWeight ?? 0),
      cancellationRateWeight: Number(asAny?.cancellationRateWeight ?? 0),
      responseTimeWeight: Number(asAny?.responseTimeWeight ?? 0),
      vehicleCompatibilityWeight: Number(asAny?.vehicleCompatibilityWeight ?? 0),
      idleTimeWeight: Number(asAny?.idleTimeWeight ?? 0),
      repeatCustomerBonus: Number(asAny?.repeatCustomerBonus ?? 0),
      driverTierBonus: Number(asAny?.driverTierBonus ?? 0)
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
      rideMode: 'long_distance_only' as const,
      makeOfferEnabled: true,
      acceptFareEnabled: true,
      allowCustomerCounterOffer: true,
      allowDriverCounterOffer: true,
      allowCustomerTryAnotherDriver: true,
      autoReleaseOnTimeout: true,
      autoReleaseOnDriverOffline: true,
      paymentDeadlineAfterFareAgreement: 300,
      assignNegotiatingDriverAfterPayment: true
    });

    const asAny = raw as any;
    const enabledServices = Array.isArray(asAny?.enabledServices)
      ? (asAny.enabledServices as string[])
      : (Array.isArray(asAny?.eligibleServices) ? (asAny.eligibleServices as string[]) : ['shop', 'errand']);

    const rideMode = ['disabled', 'long_distance_only', 'all_rides'].includes(String(asAny?.rideMode))
      ? (String(asAny.rideMode) as 'disabled' | 'long_distance_only' | 'all_rides')
      : 'long_distance_only';

    return {
      enabled: Boolean(asAny?.enabled ?? false),
      maxRounds: Number(asAny?.maxRounds ?? 3),
      timeoutSeconds: Number(asAny?.timeoutSeconds ?? 120),
      maxDriverAttempts: Number(asAny?.maxDriverAttempts ?? 5),
      claimTimeoutSeconds: Number(asAny?.claimTimeoutSeconds ?? 60),
      enabledServices,
      eligibleServices: Array.isArray(asAny?.eligibleServices) ? (asAny.eligibleServices as string[]) : enabledServices,
      rideMinimumDistanceKm: Number(asAny?.rideMinimumDistanceKm ?? asAny?.longDistanceRideKm ?? 30),
      rideMode,
      makeOfferEnabled: asAny?.makeOfferEnabled !== undefined ? Boolean(asAny.makeOfferEnabled) : true,
      acceptFareEnabled: asAny?.acceptFareEnabled !== undefined ? Boolean(asAny.acceptFareEnabled) : true,
      allowCustomerCounterOffer: asAny?.allowCustomerCounterOffer !== undefined ? Boolean(asAny.allowCustomerCounterOffer) : true,
      allowDriverCounterOffer: asAny?.allowDriverCounterOffer !== undefined ? Boolean(asAny.allowDriverCounterOffer) : true,
      allowCustomerTryAnotherDriver: asAny?.allowCustomerTryAnotherDriver !== undefined ? Boolean(asAny.allowCustomerTryAnotherDriver) : true,
      autoReleaseOnTimeout: asAny?.autoReleaseOnTimeout !== undefined ? Boolean(asAny.autoReleaseOnTimeout) : true,
      autoReleaseOnDriverOffline: asAny?.autoReleaseOnDriverOffline !== undefined ? Boolean(asAny.autoReleaseOnDriverOffline) : true,
      paymentDeadlineAfterFareAgreement: Number(asAny?.paymentDeadlineAfterFareAgreement ?? 300),
      assignNegotiatingDriverAfterPayment: asAny?.assignNegotiatingDriverAfterPayment !== undefined ? Boolean(asAny.assignNegotiatingDriverAfterPayment) : true
    };
  }

  static async getMarketplaceEnabled(tenantId: string | null = null): Promise<boolean> {
    try {
      let enabled = true;
      const rawMarketplaceEnabled = await this.getRawSetting('marketplace_enabled', tenantId);

      if (rawMarketplaceEnabled !== null) {
        enabled = this.parseEnabledValue(rawMarketplaceEnabled, true);
      } else {
        const { data, error } = await supabaseAdmin
          .from('system_configs')
          .select('value')
          .eq('key', 'marketplace_enabled')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) {
          console.warn('[MarketplaceConfig] getMarketplaceEnabled system_configs fallback error:', error.message);
        }

        const systemEnabled = data?.value ?? true;
        enabled = this.parseEnabledValue(systemEnabled, true);
      }

      const emergency = await this.getEmergencyControls(tenantId);
      return enabled && !emergency.disableMarketplaceGlobally && !emergency.forceNormalBookingFlow;
    } catch (err) {
      console.warn('[MarketplaceConfig] getMarketplaceEnabled failed:', err);
      return true;
    }
  }

  static async getFlags(tenantId: string | null = null): Promise<MarketplaceFlags> {
    const [marketplaceEnabled, dynamic, negotiation, bidding, smart, hybrid] = await Promise.all([
      this.getMarketplaceEnabled(tenantId),
      this.getDynamicPricingSettings(tenantId),
      this.getNegotiationSettings(tenantId),
      this.getBiddingSettings(tenantId),
      this.getSmartMatchingSettings(tenantId),
      this.getHybridNegotiationSettings(tenantId)
    ]);

    const emergency = await this.getEmergencyControls(tenantId);

    return {
      marketplaceEnabled,
      dynamicPricingEnabled: dynamic.enabled && !emergency.disableDynamicPricing,
      negotiationEnabled: negotiation.enabled,
      hybridNegotiationEnabled: marketplaceEnabled && hybrid.enabled && !emergency.disableHybridNegotiation && !emergency.forceNormalBookingFlow,
      biddingEnabled: bidding.enabled && !emergency.disableBidding,
      smartMatchingEnabled: smart.enabled
    };
  }

  static async getServiceRules(tenantId: string | null = null): Promise<ServiceRules> {
    const raw = await this.getSetting<ServiceRules>('service_rules', tenantId, {
      errand: { enabled: true, marketplaceEnabled: true, negotiationEnabled: true, biddingEnabled: false, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 100, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: true, allowMultiStop: true, allowHourlyBooking: false },
      shop: { enabled: true, marketplaceEnabled: true, negotiationEnabled: true, biddingEnabled: false, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 100, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: false, allowMultiStop: false, allowHourlyBooking: false },
      delivery: { enabled: true, marketplaceEnabled: true, negotiationEnabled: true, biddingEnabled: false, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 100, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: false, allowMultiStop: true, allowHourlyBooking: false },
      'van-moving': { enabled: true, marketplaceEnabled: true, negotiationEnabled: true, biddingEnabled: true, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 200, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: true, allowMultiStop: true, allowHourlyBooking: true },
      ride: { enabled: true, marketplaceEnabled: true, negotiationEnabled: false, biddingEnabled: false, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 100, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: true, allowMultiStop: true, allowHourlyBooking: false }
    });
    return raw ?? {};
  }

  static async getPaymentRules(tenantId: string | null = null): Promise<PaymentRules> {
    const raw = await this.getSetting<PaymentRules>('payment_rules', tenantId, {
      cardEnabled: true,
      walletEnabled: true,
      cashEnabled: false,
      manualCaptureEnabled: true,
      paymentBeforeDispatch: true,
      paymentDeadlineAfterFareAgreement: 300,
      itemBudgetReservationEnabled: true,
      itemBudgetMaximum: 500,
      refundReleaseTimeout: 86400,
      duplicatePaymentIntentProtection: true,
      allowedPaymentStatusesForDispatch: ['succeeded', 'requires_capture', 'authorized']
    });
    return raw as PaymentRules;
  }

  static async getNotificationRules(tenantId: string | null = null): Promise<NotificationRules> {
    const raw = await this.getSetting<NotificationRules>('notification_rules', tenantId, {
      customer: {},
      driver: {}
    });
    return raw as NotificationRules;
  }

  static async getDriverRules(tenantId: string | null = null): Promise<DriverRules> {
    const raw = await this.getSetting<DriverRules>('driver_rules', tenantId, {
      minimumDriverRating: 4.0,
      minimumCompletedTrips: 0,
      requiredVerificationStatus: 'verified',
      requireActiveVehicle: true,
      requireStripeConnected: true,
      requireSufficientWallet: false,
      maximumActiveNegotiations: 5,
      maximumActiveJobs: 1,
      cooldownAfterDeclineSeconds: 0,
      autoSuspendAfterRepeatedCancellations: 0,
      allowFavouriteRepeatDrivers: true
    });
    return raw as DriverRules;
  }

  static async getEmergencyControls(tenantId: string | null = null): Promise<EmergencyControls> {
    const raw = await this.getSetting<EmergencyControls>('emergency_controls', tenantId, {
      disableMarketplaceGlobally: false,
      disableMakeOffer: false,
      disableHybridNegotiation: false,
      disableBidding: false,
      disableDynamicPricing: false,
      disableByService: {},
      forceAcceptFareOnly: false,
      forceNormalBookingFlow: false,
      disableCardPayments: false,
      disableWalletPayments: false
    });
    return raw as EmergencyControls;
  }

  static async getMarketplaceDraftRules(tenantId: string | null = null): Promise<MarketplaceDraftRules> {
    const raw = await this.getSetting<MarketplaceDraftRules>('marketplace_draft_rules', tenantId, {
      enabled: true,
      pendingFareTtlMinutes: 30,
      fareAgreedUnpaidTtlMinutes: 30,
      negotiationIdleTtlMinutes: 15,
      cleanupIntervalMinutes: 10,
      deleteExpiredDrafts: false
    });

    const settings = raw as MarketplaceDraftRules;
    return {
      enabled: settings?.enabled !== false,
      pendingFareTtlMinutes: Number(settings?.pendingFareTtlMinutes ?? 30),
      fareAgreedUnpaidTtlMinutes: Number(settings?.fareAgreedUnpaidTtlMinutes ?? 30),
      negotiationIdleTtlMinutes: Number(settings?.negotiationIdleTtlMinutes ?? 15),
      cleanupIntervalMinutes: Number(settings?.cleanupIntervalMinutes ?? 10),
      deleteExpiredDrafts: Boolean(settings?.deleteExpiredDrafts ?? false)
    };
  }

  static async getAllSettings(tenantId: string | null = null): Promise<Record<string, unknown>> {
    const [commission, dynamicPricing, negotiation, hybridNegotiation, bidding, smartMatching, serviceRules, paymentRules, notificationRules, driverRules, emergencyControls, marketplaceDraftRules, marketplaceEnabled] = await Promise.all([
      this.getCommissionSettings(tenantId),
      this.getDynamicPricingSettings(tenantId),
      this.getNegotiationSettings(tenantId),
      this.getHybridNegotiationSettings(tenantId),
      this.getBiddingSettings(tenantId),
      this.getSmartMatchingSettings(tenantId),
      this.getServiceRules(tenantId),
      this.getPaymentRules(tenantId),
      this.getNotificationRules(tenantId),
      this.getDriverRules(tenantId),
      this.getEmergencyControls(tenantId),
      this.getMarketplaceDraftRules(tenantId),
      this.getMarketplaceEnabled(tenantId)
    ]);
    const effectiveStatus = this.buildEffectiveMarketplaceStatus(
      marketplaceEnabled,
      hybridNegotiation,
      serviceRules,
      emergencyControls
    );

    return {
      commission,
      dynamicPricing,
      negotiation,
      hybridNegotiation,
      bidding,
      smartMatching,
      serviceRules,
      paymentRules,
      notificationRules,
      driverRules,
      emergencyControls,
      marketplaceDraftRules,
      marketplaceEnabled,
      effectiveStatus
    };
  }

  private static buildEffectiveMarketplaceStatus(
    marketplaceEnabled: boolean,
    hybrid: HybridNegotiationSettings,
    serviceRules: ServiceRules,
    emergency: EmergencyControls
  ): Record<string, unknown> {
    const globalReason = emergency.disableMarketplaceGlobally || emergency.forceNormalBookingFlow
      ? 'Emergency override'
      : (!marketplaceEnabled ? 'Global disabled' : null);
    const hybridReason = globalReason
      || (emergency.disableHybridNegotiation ? 'Emergency override' : null)
      || (!hybrid.enabled ? 'Hybrid disabled' : null);

    const service = (slug: string) => {
      const reason = this.getServiceBlockReason(slug, marketplaceEnabled, hybrid, serviceRules, emergency);
      return { enabled: !reason, reason };
    };

    return {
      globalMarketplace: { enabled: marketplaceEnabled && !globalReason, reason: globalReason },
      hybridNegotiation: { enabled: !hybridReason, reason: hybridReason },
      services: {
        shopErrand: service('errand'),
        delivery: service('delivery'),
        vanMove: service('van-moving'),
        ride: service('ride')
      }
    };
  }

  static async setSetting<T>(
    key: string,
    value: T,
    tenantId: string | null = null,
    adminId?: string
  ): Promise<T> {
    const existingRow = await this.getSettingRow(key, tenantId);
    const existing = (existingRow?.value as Record<string, unknown> | null) ?? null;
    const cleanValue = key === 'marketplace_enabled'
      ? { enabled: this.parseEnabledValue(value, true) }
      : this.toJsonSafe(value);
    const merged = (key === 'marketplace_enabled'
      ? { ...(this.isJsonObject(existing) ? existing : {}), ...(cleanValue as Record<string, unknown>) }
      : this.deepMerge(existing ?? {}, cleanValue)) as T;
    const now = new Date().toISOString();

    if (existingRow?.id) {
      const { error: updateError } = await supabaseAdmin
        .from('marketplace_settings')
        .update({ value: merged, updated_at: now })
        .eq('id', existingRow.id);

      if (updateError) {
        console.error(`[MarketplaceConfig] setSetting update error for ${key}:`, updateError.message);
        throw new Error(`Unable to save marketplace setting ${key}: ${updateError.message}`);
      }
    } else {
      const { error: insertError } = await supabaseAdmin
        .from('marketplace_settings')
        .insert({
          tenant_id: tenantId,
          key,
          value: merged,
          created_at: now,
          updated_at: now
        });

      if (insertError) {
        if (insertError.code === '23505') {
          const retryRow = await this.getSettingRow(key, tenantId);
          if (retryRow?.id) {
            const retryExisting = (retryRow.value as Record<string, unknown> | null) ?? null;
            const retryMerged = (key === 'marketplace_enabled'
              ? { ...(this.isJsonObject(retryExisting) ? retryExisting : {}), ...(cleanValue as Record<string, unknown>) }
              : this.deepMerge(retryExisting ?? {}, cleanValue)) as T;
            const { error: retryError } = await supabaseAdmin
              .from('marketplace_settings')
              .update({ value: retryMerged, updated_at: now })
              .eq('id', retryRow.id);

            if (retryError) {
              console.error(`[MarketplaceConfig] setSetting retry update error for ${key}:`, retryError.message);
              throw new Error(`Unable to save marketplace setting ${key}: ${retryError.message}`);
            }

            this.cache.delete(this.cacheKey(tenantId, key));
            try {
              const { AuditService } = await import('./audit.service');
              await AuditService.log({
                userId: adminId,
                action: 'admin_marketplace_setting_updated',
                entityType: 'marketplace_settings',
                entityId: key,
                metadata: { previous: retryExisting, value: retryMerged, tenantId, updatedAt: now }
              });
            } catch (error: any) {
              console.warn(`[MarketplaceConfig] audit log failed for ${key}:`, error?.message || error);
            }
            return retryMerged;
          }
        }

        console.error(`[MarketplaceConfig] setSetting insert error for ${key}:`, insertError.message);
        throw new Error(`Unable to save marketplace setting ${key}: ${insertError.message}`);
      }
    }

    this.cache.delete(this.cacheKey(tenantId, key));

    try {
      const { AuditService } = await import('./audit.service');
      await AuditService.log({
        userId: adminId,
        action: 'admin_marketplace_setting_updated',
        entityType: 'marketplace_settings',
        entityId: key,
        metadata: { previous: existing, value: merged, tenantId, updatedAt: now }
      });
    } catch (error: any) {
      console.warn(`[MarketplaceConfig] audit log failed for ${key}:`, error?.message || error);
    }

    return merged;
  }

  private static async getSettingRow(
    key: string,
    tenantId: string | null
  ): Promise<{ id: string; value: unknown } | null> {
    let query = supabaseAdmin
      .from('marketplace_settings')
      .select('id, value')
      .eq('key', key)
      .order('created_at', { ascending: false })
      .limit(1);

    query = tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null);

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.warn(`[MarketplaceConfig] getSettingRow error for ${key}:`, error.message);
      return null;
    }

    return data as { id: string; value: unknown } | null;
  }

  static async setSettings(
    settings: Record<string, unknown>,
    tenantId: string | null = null,
    adminId?: string
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    for (const [camelKey, value] of Object.entries(settings)) {
      const key = this.camelToSnake(camelKey);
      const normalizedValue = key === 'marketplace_enabled'
        ? { enabled: this.parseEnabledValue(value, true) }
        : value;
      const merged = await this.setSetting(key, normalizedValue, tenantId, adminId);
      result[camelKey] = merged;
    }

    this.invalidateCache();
    return result;
  }

  private static toJsonSafe<T>(value: T): T {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      throw new Error('Marketplace setting values must be valid JSON.');
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.toJsonSafe(entry)) as T;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      result[key] = this.toJsonSafe(entry);
    }

    return result as T;
  }

  static async getAuditLogs(limit = 100, offset = 0, key?: string | null): Promise<unknown[]> {
    let query = supabaseAdmin
      .from('audit_logs')
      .select('*')
      .eq('entity_type', 'marketplace_settings')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (key) {
      query = query.eq('entity_id', key);
    }

    const { data, error } = await query;

    if (error) {
      console.warn('[MarketplaceConfig] getAuditLogs error:', error.message);
      return [];
    }

    return data ?? [];
  }

  private static camelToSnake(value: string): string {
    return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  private static deepMerge(target: any, source: any): any {
    if (source === null || source === undefined) return target;
    if (Array.isArray(source)) return source;
    if (typeof source !== 'object') return source;
    if (target === null || target === undefined || typeof target !== 'object' || Array.isArray(target)) {
      target = {};
    }

    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] === undefined) continue;
      result[key] = this.deepMerge(result[key], source[key]);
    }
    return result;
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

  static async getEffectiveHybridStatus(
    serviceSlug: string | null | undefined,
    tenantId: string | null = null
  ): Promise<EffectiveHybridStatus> {
    const canonicalServiceSlug = this.canonicalServiceSlug(serviceSlug || '');
    const [marketplaceRow, hybridRow, serviceRulesRow, emergencyRow] = await Promise.all([
      this.loadRawSettingForResolver('marketplace_enabled', tenantId),
      this.loadRawSettingForResolver('hybrid_negotiation', tenantId),
      this.loadRawSettingForResolver('service_rules', tenantId),
      this.loadRawSettingForResolver('emergency_controls', tenantId)
    ]);

    const failedKey = [
      ['marketplace_enabled', marketplaceRow],
      ['hybrid_negotiation', hybridRow],
      ['service_rules', serviceRulesRow],
      ['emergency_controls', emergencyRow]
    ].find(([, row]) => Boolean((row as { error: string | null }).error));

    if (failedKey) {
      console.warn(`[MarketplaceConfig] effective hybrid status config load failed for ${failedKey[0]}:`, (failedKey[1] as { error: string | null }).error);
      return {
        enabled: false,
        reason: 'config load failed',
        marketplaceEnabled: false,
        hybridEnabled: false,
        serviceMarketplaceEnabled: false,
        serviceNegotiationEnabled: false,
        emergencyDisabled: false,
        canonicalServiceSlug
      };
    }

    const marketplaceEnabled = this.parseEnabledValue(marketplaceRow.value, false);
    const hybridDefaults: HybridNegotiationSettings = {
      enabled: false,
      maxRounds: 3,
      timeoutSeconds: 120,
      maxDriverAttempts: 5,
      claimTimeoutSeconds: 60,
      enabledServices: ['shop', 'errand'],
      eligibleServices: ['shop', 'errand'],
      rideMinimumDistanceKm: 30,
      rideMode: 'long_distance_only',
      makeOfferEnabled: true,
      acceptFareEnabled: true,
      allowCustomerCounterOffer: true,
      allowDriverCounterOffer: true,
      allowCustomerTryAnotherDriver: true,
      autoReleaseOnTimeout: true,
      autoReleaseOnDriverOffline: true,
      paymentDeadlineAfterFareAgreement: 300,
      assignNegotiatingDriverAfterPayment: true
    };
    const rawHybrid = this.isJsonObject(hybridRow.value) ? hybridRow.value : {};
    const hybrid = { ...hybridDefaults, ...rawHybrid } as HybridNegotiationSettings;
    const enabledServices = Array.isArray((rawHybrid as any).enabledServices)
      ? ((rawHybrid as any).enabledServices as string[])
      : (Array.isArray((rawHybrid as any).eligibleServices) ? ((rawHybrid as any).eligibleServices as string[]) : hybridDefaults.enabledServices);
    hybrid.enabledServices = enabledServices;
    hybrid.eligibleServices = Array.isArray((rawHybrid as any).eligibleServices) ? ((rawHybrid as any).eligibleServices as string[]) : enabledServices;
    hybrid.enabled = this.parseEnabledValue((rawHybrid as any).enabled, hybridDefaults.enabled);

    const serviceDefaults: ServiceRules = {
      errand: { enabled: true, marketplaceEnabled: true, negotiationEnabled: true, biddingEnabled: false, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 100, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: true, allowMultiStop: true, allowHourlyBooking: false },
      shop: { enabled: true, marketplaceEnabled: true, negotiationEnabled: true, biddingEnabled: false, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 100, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: false, allowMultiStop: false, allowHourlyBooking: false },
      delivery: { enabled: true, marketplaceEnabled: true, negotiationEnabled: true, biddingEnabled: false, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 100, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: false, allowMultiStop: true, allowHourlyBooking: false },
      'van-moving': { enabled: true, marketplaceEnabled: true, negotiationEnabled: true, biddingEnabled: true, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 200, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: true, allowMultiStop: true, allowHourlyBooking: true },
      ride: { enabled: true, marketplaceEnabled: true, negotiationEnabled: false, biddingEnabled: false, dynamicPricingEnabled: true, smartMatchingEnabled: true, minimumDistanceKm: 0, maximumDistanceKm: 100, minimumFare: 0, maximumFare: 0, paymentBeforeDispatch: false, allowScheduledJobs: true, allowMultiStop: true, allowHourlyBooking: false }
    };
    const serviceRules = this.isJsonObject(serviceRulesRow.value)
      ? ({ ...serviceDefaults, ...(serviceRulesRow.value as ServiceRules) } as ServiceRules)
      : serviceDefaults;

    const emergencyDefaults: EmergencyControls = {
      disableMarketplaceGlobally: false,
      disableMakeOffer: false,
      disableHybridNegotiation: false,
      disableBidding: false,
      disableDynamicPricing: false,
      disableByService: {},
      forceAcceptFareOnly: false,
      forceNormalBookingFlow: false,
      disableCardPayments: false,
      disableWalletPayments: false
    };
    const emergency = this.isJsonObject(emergencyRow.value)
      ? ({ ...emergencyDefaults, ...(emergencyRow.value as unknown as Partial<EmergencyControls>) } as EmergencyControls)
      : emergencyDefaults;

    const serviceRule = this.serviceRuleFor(serviceRules, canonicalServiceSlug);
    const serviceExists = Boolean(serviceRule);
    const serviceMarketplaceEnabled = Boolean(serviceRule) && serviceRule?.enabled !== false && serviceRule?.marketplaceEnabled !== false;
    const serviceNegotiationEnabled = Boolean(serviceRule) && serviceRule?.negotiationEnabled !== false;
    const hybridServiceEnabled = this.isHybridServiceEnabled(hybrid, canonicalServiceSlug);
    const emergencyDisabled = Boolean(
      emergency.disableMarketplaceGlobally ||
      emergency.disableHybridNegotiation ||
      emergency.forceNormalBookingFlow ||
      emergency.disableByService?.[canonicalServiceSlug]
    );

    let reason: string | null = null;
    if (!marketplaceEnabled) reason = 'marketplace disabled';
    else if (emergencyDisabled) reason = 'emergency override';
    else if (!hybrid.enabled) reason = 'hybrid disabled';
    else if (!serviceExists || !serviceMarketplaceEnabled || !serviceNegotiationEnabled || !hybridServiceEnabled) reason = 'service disabled';

    return {
      enabled: reason === null,
      reason,
      marketplaceEnabled,
      hybridEnabled: Boolean(hybrid.enabled),
      serviceMarketplaceEnabled,
      serviceNegotiationEnabled,
      emergencyDisabled,
      canonicalServiceSlug
    };
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
      console.warn('[MarketplaceConfig] commission override lookup error, falling back to base commission from marketplace_settings:', error.message);
      return base.percent;
    }

    if (!overrides || overrides.length === 0) {
      console.warn('[MarketplaceConfig] no active commission overrides, using base commission from marketplace_settings:', base.percent);
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
      console.warn('[MarketplaceConfig] no matching commission override, using base commission from marketplace_settings:', base.percent);
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
    const raw = String(slug || '').trim().toLowerCase().replace(/[\s_]+/g, '-');

    if (['shop', 'shopping', 'errands', 'errand'].includes(raw)) return 'errand';
    if (['courier', 'parcel', 'package', 'package-delivery', 'deliver', 'delivery'].includes(raw)) return 'delivery';
    if (['van', 'moving', 'move', 'van-moving'].includes(raw)) return 'van-moving';
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
    const [hybridStatus, bidding] = await Promise.all([
      this.getEffectiveHybridStatus(serviceTypeSlug, tenantId),
      this.shouldEnableBidding(serviceTypeSlug, tenantId)
    ]);

    return { negotiation: hybridStatus.enabled, bidding };
  }
}
