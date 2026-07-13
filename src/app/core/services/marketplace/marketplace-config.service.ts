import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';

export interface MarketplaceCommissionSettings {
  percent: number;
  minFee: number;
  maxFee: number | null;
  platformFeePercent?: number;
}

export interface MarketplaceDynamicPricingSettings {
  enabled: boolean;
  maxSurge: number;
  trafficMultiplier: number;
  weatherMultiplier: number;
  demandMultiplier: number;
  fuelMultiplier: number;
  supplyScarcityMultiplier?: number;
  rainMultiplier?: number;
  floodMultiplier?: number;
  peakMultiplier?: number;
  airportSurcharge?: number;
  publicHolidayMultiplier?: number;
  eventMultiplier?: number;
  nearbyDriverDiscount?: number;
  minimumFare?: number;
  maximumFareCap?: number;
  nightMultiplier?: number;
  timeOfDayEnabled: boolean;
  demandSupplyEnabled: boolean;
  weatherEnabled: boolean;
  trafficEnabled: boolean;
  eventMultiplierEnabled: boolean;
}

export interface MarketplaceNegotiationSettings {
  enabled: boolean;
  timeoutSeconds: number;
  maxRounds: number;
  minServices: string[];
  enabledServices?: string[];
  defaultServices?: string[];
}

export interface MarketplaceBiddingSettings {
  enabled: boolean;
  enabledServices: string[];
  timeoutSeconds: number;
  maxBids: number;
  defaultServices: string[];
  minBid?: number;
  maxBidPercentageAboveSuggestedFare?: number;
  customerCanChooseDriver?: boolean;
  showDriverEta?: boolean;
  showDriverRating?: boolean;
  showCompletedTrips?: boolean;
  autoExpireUnsuccessfulBids?: boolean;
}

export interface MarketplaceSmartMatchingSettings {
  enabled: boolean;
  maxDistanceKm: number;
  ratingWeight: number;
  completionWeight: number;
  distanceWeight: number;
  responseWeight: number;
  searchBatchSize?: number;
  driverClaimBatchSize?: number;
  etaWeight?: number;
  acceptanceRateWeight?: number;
  cancellationRateWeight?: number;
  responseTimeWeight?: number;
  vehicleCompatibilityWeight?: number;
  idleTimeWeight?: number;
  repeatCustomerBonus?: number;
  driverTierBonus?: number;
}

export interface MarketplaceHybridNegotiationSettings {
  enabled: boolean;
  maxRounds: number;
  timeoutSeconds: number;
  maxDriverAttempts: number;
  claimTimeoutSeconds: number;
  enabledServices: string[];
  eligibleServices?: string[];
  rideMinimumDistanceKm: number;
  rideMode?: 'disabled' | 'long_distance_only' | 'all_rides';
  makeOfferEnabled: boolean;
  acceptFareEnabled: boolean;
  allowCustomerCounterOffer?: boolean;
  allowDriverCounterOffer?: boolean;
  allowCustomerTryAnotherDriver?: boolean;
  autoReleaseOnTimeout?: boolean;
  autoReleaseOnDriverOffline?: boolean;
  paymentDeadlineAfterFareAgreement?: number;
  assignNegotiatingDriverAfterPayment?: boolean;
}

export interface MarketplaceServiceRule {
  enabled?: boolean;
  marketplaceEnabled?: boolean;
  negotiationEnabled?: boolean;
  biddingEnabled?: boolean;
  dynamicPricingEnabled?: boolean;
  smartMatchingEnabled?: boolean;
  minimumDistanceKm?: number;
  maximumDistanceKm?: number;
  minimumFare?: number;
  maximumFare?: number;
  paymentBeforeDispatch?: boolean;
  allowScheduledJobs?: boolean;
  allowMultiStop?: boolean;
  allowHourlyBooking?: boolean;
}

export type MarketplaceServiceRules = Record<string, Partial<MarketplaceServiceRule>>;

export interface MarketplacePaymentRules {
  cardEnabled?: boolean;
  walletEnabled?: boolean;
  cashEnabled?: boolean;
  manualCaptureEnabled?: boolean;
  paymentBeforeDispatch?: boolean;
  paymentDeadlineAfterFareAgreement?: number;
  itemBudgetReservationEnabled?: boolean;
  itemBudgetMaximum?: number;
  refundReleaseTimeout?: number;
  duplicatePaymentIntentProtection?: boolean;
  allowedPaymentStatusesForDispatch?: string[];
}

export interface MarketplaceNotificationRule {
  pushEnabled?: boolean;
  inAppEnabled?: boolean;
  soundEnabled?: boolean;
  vibrationEnabled?: boolean;
  repeatInterval?: number;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

export interface MarketplaceNotificationRules {
  customer?: Record<string, MarketplaceNotificationRule>;
  driver?: Record<string, MarketplaceNotificationRule>;
}

export interface MarketplaceDriverRules {
  minimumDriverRating?: number;
  minimumCompletedTrips?: number;
  requiredVerificationStatus?: string;
  requireActiveVehicle?: boolean;
  requireStripeConnected?: boolean;
  requireSufficientWallet?: boolean;
  maximumActiveNegotiations?: number;
  maximumActiveJobs?: number;
  cooldownAfterDeclineSeconds?: number;
  autoSuspendAfterRepeatedCancellations?: number;
  allowFavouriteRepeatDrivers?: boolean;
}

export interface MarketplaceEmergencyControls {
  disableMarketplaceGlobally?: boolean;
  disableMakeOffer?: boolean;
  disableHybridNegotiation?: boolean;
  disableBidding?: boolean;
  disableDynamicPricing?: boolean;
  disableByService?: Record<string, boolean>;
  forceAcceptFareOnly?: boolean;
  forceNormalBookingFlow?: boolean;
  disableCardPayments?: boolean;
  disableWalletPayments?: boolean;
}

export interface MarketplaceDraftRules {
  enabled?: boolean;
  pendingFareTtlMinutes?: number;
  fareAgreedUnpaidTtlMinutes?: number;
  negotiationIdleTtlMinutes?: number;
  cleanupIntervalMinutes?: number;
  deleteExpiredDrafts?: boolean;
}

export interface MarketplaceCommissionOverride {
  id?: string;
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

export interface MarketplaceSettings {
  commission: MarketplaceCommissionSettings;
  dynamicPricing: MarketplaceDynamicPricingSettings;
  negotiation: MarketplaceNegotiationSettings;
  hybridNegotiation: MarketplaceHybridNegotiationSettings;
  bidding: MarketplaceBiddingSettings;
  smartMatching: MarketplaceSmartMatchingSettings;
  serviceRules?: MarketplaceServiceRules;
  paymentRules?: MarketplacePaymentRules;
  notificationRules?: MarketplaceNotificationRules;
  driverRules?: MarketplaceDriverRules;
  emergencyControls?: MarketplaceEmergencyControls;
  marketplaceDraftRules?: MarketplaceDraftRules;
  marketplaceEnabled?: boolean;
  effectiveStatus?: Record<string, unknown>;
}

@Injectable({
  providedIn: 'root'
})
export class MarketplaceConfigService {
  private supabase = inject(SupabaseService);

  private readonly settings = signal<MarketplaceSettings | null>(null);
  private readonly overrides = signal<MarketplaceCommissionOverride[]>([]);
  private readonly loading = signal(false);

  readonly settingsSignal = this.settings.asReadonly();
  readonly overridesSignal = this.overrides.asReadonly();
  readonly loadingSignal = this.loading.asReadonly();

  parseMarketplaceEnabled(value: unknown, fallback = true): boolean {
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
      if ('enabled' in record) return this.parseMarketplaceEnabled(record['enabled'], fallback);
      if ('marketplaceEnabled' in record) return this.parseMarketplaceEnabled(record['marketplaceEnabled'], fallback);
      if ('value' in record) return this.parseMarketplaceEnabled(record['value'], fallback);
    }
    return fallback;
  }

  defaultSettings(): MarketplaceSettings {
    return {
      commission: { percent: 10, minFee: 0, maxFee: null, platformFeePercent: 0 },
      dynamicPricing: {
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
        demandSupplyEnabled: true,
        weatherEnabled: false,
        trafficEnabled: false,
        eventMultiplierEnabled: false
      },
      negotiation: {
        enabled: true,
        timeoutSeconds: 120,
        maxRounds: 3,
        minServices: ['errand', 'delivery', 'van-moving'],
        enabledServices: ['errand', 'delivery', 'van-moving'],
        defaultServices: ['errand', 'delivery', 'van-moving']
      },
      hybridNegotiation: {
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
        paymentDeadlineAfterFareAgreement: 600,
        assignNegotiatingDriverAfterPayment: true
      },
      bidding: {
        enabled: false,
        enabledServices: ['van', 'van_moving'],
        timeoutSeconds: 300,
        maxBids: 10,
        defaultServices: ['van', 'van_moving'],
        minBid: 0,
        maxBidPercentageAboveSuggestedFare: 50,
        customerCanChooseDriver: false,
        showDriverEta: true,
        showDriverRating: true,
        showCompletedTrips: true,
        autoExpireUnsuccessfulBids: true
      },
      smartMatching: {
        enabled: true,
        maxDistanceKm: 10,
        ratingWeight: 0.25,
        completionWeight: 0.35,
        distanceWeight: 0.30,
        responseWeight: 0.10,
        searchBatchSize: 15,
        driverClaimBatchSize: 5,
        etaWeight: 0,
        acceptanceRateWeight: 0,
        cancellationRateWeight: 0,
        responseTimeWeight: 0,
        vehicleCompatibilityWeight: 0,
        idleTimeWeight: 0,
        repeatCustomerBonus: 0,
        driverTierBonus: 0
      },
      serviceRules: {
        ride: {
          enabled: true,
          marketplaceEnabled: true,
          negotiationEnabled: false,
          biddingEnabled: false,
          dynamicPricingEnabled: true,
          smartMatchingEnabled: true,
          minimumDistanceKm: 0,
          maximumDistanceKm: 100,
          minimumFare: 0,
          maximumFare: 0,
          paymentBeforeDispatch: false,
          allowScheduledJobs: true,
          allowMultiStop: true,
          allowHourlyBooking: false
        },
        shop: {
          enabled: true,
          marketplaceEnabled: true,
          negotiationEnabled: true,
          biddingEnabled: false,
          dynamicPricingEnabled: true,
          smartMatchingEnabled: true,
          minimumDistanceKm: 0,
          maximumDistanceKm: 100,
          minimumFare: 0,
          maximumFare: 0,
          paymentBeforeDispatch: false,
          allowScheduledJobs: false,
          allowMultiStop: false,
          allowHourlyBooking: false
        },
        errand: {
          enabled: true,
          marketplaceEnabled: true,
          negotiationEnabled: true,
          biddingEnabled: false,
          dynamicPricingEnabled: true,
          smartMatchingEnabled: true,
          minimumDistanceKm: 0,
          maximumDistanceKm: 100,
          minimumFare: 0,
          maximumFare: 0,
          paymentBeforeDispatch: false,
          allowScheduledJobs: false,
          allowMultiStop: false,
          allowHourlyBooking: false
        },
        delivery: {
          enabled: true,
          marketplaceEnabled: true,
          negotiationEnabled: true,
          biddingEnabled: false,
          dynamicPricingEnabled: true,
          smartMatchingEnabled: true,
          minimumDistanceKm: 0,
          maximumDistanceKm: 100,
          minimumFare: 0,
          maximumFare: 0,
          paymentBeforeDispatch: false,
          allowScheduledJobs: false,
          allowMultiStop: true,
          allowHourlyBooking: false
        },
        'van-moving': {
          enabled: true,
          marketplaceEnabled: true,
          negotiationEnabled: true,
          biddingEnabled: true,
          dynamicPricingEnabled: true,
          smartMatchingEnabled: true,
          minimumDistanceKm: 0,
          maximumDistanceKm: 200,
          minimumFare: 0,
          maximumFare: 0,
          paymentBeforeDispatch: false,
          allowScheduledJobs: true,
          allowMultiStop: true,
          allowHourlyBooking: true
        }
      },
      paymentRules: {
        cardEnabled: true,
        walletEnabled: true,
        cashEnabled: false,
        manualCaptureEnabled: true,
        paymentBeforeDispatch: true,
        paymentDeadlineAfterFareAgreement: 600,
        itemBudgetReservationEnabled: true,
        itemBudgetMaximum: 0,
        refundReleaseTimeout: 0,
        duplicatePaymentIntentProtection: true,
        allowedPaymentStatusesForDispatch: ['succeeded', 'requires_capture']
      },
      notificationRules: {
        customer: {},
        driver: {}
      },
      driverRules: {
        minimumDriverRating: 0,
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
      },
      emergencyControls: {
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
      },
      marketplaceDraftRules: {
        enabled: true,
        pendingFareTtlMinutes: 30,
        fareAgreedUnpaidTtlMinutes: 30,
        negotiationIdleTtlMinutes: 15,
        cleanupIntervalMinutes: 10,
        deleteExpiredDrafts: false
      },
      marketplaceEnabled: true
    };
  }

  async loadSettings(): Promise<MarketplaceSettings> {
    this.loading.set(true);
    try {
      const { data, error } = await this.supabase
        .from('marketplace_settings')
        .select('key, value')
        .is('tenant_id', null)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const defaults = this.defaultSettings();
      const map = (data || []).reduce((acc: Record<string, unknown>, row: any) => {
        if (!(row.key in acc)) {
          acc[row.key] = row.value;
        }
        return acc;
      }, {});

      const rawHybridRest = ((map['hybrid_negotiation'] as Record<string, unknown> || {}) as any);
      const rawBidding = ((map['bidding'] as Record<string, unknown> || {}) as any);
      const normalizedHybrid = {
        ...defaults.hybridNegotiation,
        ...rawHybridRest,
        enabledServices: (Array.isArray(rawHybridRest.enabledServices) ? rawHybridRest.enabledServices : (Array.isArray(rawHybridRest.eligibleServices) ? rawHybridRest.eligibleServices : defaults.hybridNegotiation.enabledServices)) as string[],
        rideMinimumDistanceKm: Number(rawHybridRest.rideMinimumDistanceKm ?? rawHybridRest.longDistanceRideKm ?? defaults.hybridNegotiation.rideMinimumDistanceKm),
        claimTimeoutSeconds: Number(rawHybridRest.claimTimeoutSeconds ?? defaults.hybridNegotiation.claimTimeoutSeconds),
        makeOfferEnabled: rawHybridRest.makeOfferEnabled !== undefined ? Boolean(rawHybridRest.makeOfferEnabled) : defaults.hybridNegotiation.makeOfferEnabled,
        acceptFareEnabled: rawHybridRest.acceptFareEnabled !== undefined ? Boolean(rawHybridRest.acceptFareEnabled) : defaults.hybridNegotiation.acceptFareEnabled
      };
      const normalizedBidding = {
        ...defaults.bidding,
        ...rawBidding,
        enabled: rawBidding.enabled !== undefined ? Boolean(rawBidding.enabled) : defaults.bidding.enabled,
        enabledServices: (Array.isArray(rawBidding.enabledServices)
          ? rawBidding.enabledServices
          : (Array.isArray(rawBidding.defaultServices) ? rawBidding.defaultServices : defaults.bidding.enabledServices)) as string[],
        defaultServices: (Array.isArray(rawBidding.defaultServices)
          ? rawBidding.defaultServices
          : (Array.isArray(rawBidding.enabledServices) ? rawBidding.enabledServices : defaults.bidding.defaultServices)) as string[]
      };

      const settings: MarketplaceSettings = {
        commission: { ...defaults.commission, ...(map['commission'] as Record<string, unknown> || {}) },
        dynamicPricing: { ...defaults.dynamicPricing, ...(map['dynamic_pricing'] as Record<string, unknown> || {}) },
        negotiation: { ...defaults.negotiation, ...(map['negotiation'] as Record<string, unknown> || {}) },
        hybridNegotiation: normalizedHybrid,
        bidding: normalizedBidding,
        smartMatching: { ...defaults.smartMatching, ...(map['smart_matching'] as Record<string, unknown> || {}) },
        serviceRules: { ...defaults.serviceRules, ...(map['service_rules'] as MarketplaceServiceRules || {}) },
        paymentRules: { ...defaults.paymentRules, ...(map['payment_rules'] as MarketplacePaymentRules || {}) },
        notificationRules: { ...defaults.notificationRules, ...(map['notification_rules'] as MarketplaceNotificationRules || {}) },
        driverRules: { ...defaults.driverRules, ...(map['driver_rules'] as MarketplaceDriverRules || {}) },
        emergencyControls: { ...defaults.emergencyControls, ...(map['emergency_controls'] as MarketplaceEmergencyControls || {}) },
        marketplaceDraftRules: { ...defaults.marketplaceDraftRules, ...(map['marketplace_draft_rules'] as MarketplaceDraftRules || {}) },
        marketplaceEnabled: this.parseMarketplaceEnabled(map['marketplace_enabled'], defaults.marketplaceEnabled),
        effectiveStatus: (map['effective_status'] as Record<string, unknown>) || undefined
      };

      this.settings.set(settings);
      return settings;
    } finally {
      this.loading.set(false);
    }
  }

  async saveSettings(settings: MarketplaceSettings): Promise<void> {
    const rows = [
      { key: 'commission', value: settings.commission },
      { key: 'dynamic_pricing', value: settings.dynamicPricing },
      { key: 'negotiation', value: settings.negotiation },
      { key: 'hybrid_negotiation', value: settings.hybridNegotiation },
      { key: 'bidding', value: settings.bidding },
      { key: 'smart_matching', value: settings.smartMatching },
      { key: 'service_rules', value: settings.serviceRules },
      { key: 'payment_rules', value: settings.paymentRules },
      { key: 'notification_rules', value: settings.notificationRules },
      { key: 'driver_rules', value: settings.driverRules },
      { key: 'emergency_controls', value: settings.emergencyControls },
      { key: 'marketplace_draft_rules', value: settings.marketplaceDraftRules },
      { key: 'marketplace_enabled', value: { enabled: Boolean(settings.marketplaceEnabled) } }
    ];

    for (const row of rows) {
      await this.saveGlobalSetting(row.key, row.value);
    }

    this.settings.set(settings);
    await this.loadSettings();
  }

  private async saveGlobalSetting(key: string, value: unknown): Promise<void> {
    const now = new Date().toISOString();
    const { data: existing, error: lookupError } = await this.supabase
      .from('marketplace_settings')
      .select('id, value')
      .is('tenant_id', null)
      .eq('key', key)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lookupError) throw lookupError;

    const mergedValue = this.mergeJsonValue(existing?.value, value);

    if (existing?.id) {
      const { error } = await this.supabase
        .from('marketplace_settings')
        .update({
          value: mergedValue,
          updated_at: now
        })
        .eq('id', existing.id);

      if (error) throw error;
      return;
    }

    const { error } = await this.supabase
      .from('marketplace_settings')
      .insert({
        key,
        value: mergedValue,
        tenant_id: null,
        updated_at: now
      });

    if (error?.code === '23505') {
      const { data: retryExisting, error: retryLookupError } = await this.supabase
        .from('marketplace_settings')
        .select('id, value')
        .is('tenant_id', null)
        .eq('key', key)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (retryLookupError) throw retryLookupError;
      if (!retryExisting?.id) throw error;

      const retryValue = this.mergeJsonValue(retryExisting.value, value);
      const { error: retryError } = await this.supabase
        .from('marketplace_settings')
        .update({ value: retryValue, updated_at: now })
        .eq('id', retryExisting.id);

      if (retryError) throw retryError;
      return;
    }

    if (error) throw error;
  }

  private mergeJsonValue(existing: unknown, incoming: unknown): unknown {
    if (
      existing &&
      incoming &&
      typeof existing === 'object' &&
      typeof incoming === 'object' &&
      !Array.isArray(existing) &&
      !Array.isArray(incoming)
    ) {
      return { ...(existing as Record<string, unknown>), ...(incoming as Record<string, unknown>) };
    }

    return incoming;
  }

  async reload(): Promise<void> {
    await this.loadSettings();
  }

  async loadOverrides(): Promise<MarketplaceCommissionOverride[]> {
    const { data, error } = await this.supabase
      .from('marketplace_commission_overrides')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const overrides = (data || []) as MarketplaceCommissionOverride[];
    this.overrides.set(overrides);
    return overrides;
  }

  async saveOverride(override: MarketplaceCommissionOverride): Promise<void> {
    const payload = {
      ...override,
      service_type_slug: override.service_type_slug || null,
      city_zone: override.city_zone || null,
      driver_tier: override.driver_tier || null,
      promotion_period_id: override.promotion_period_id || null,
      updated_at: new Date().toISOString()
    };

    const { error } = await this.supabase
      .from('marketplace_commission_overrides')
      .upsert(payload, { onConflict: 'id' });

    if (error) throw error;

    await this.loadOverrides();
  }

  async deleteOverride(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('marketplace_commission_overrides')
      .delete()
      .eq('id', id);

    if (error) throw error;

    await this.loadOverrides();
  }
}
