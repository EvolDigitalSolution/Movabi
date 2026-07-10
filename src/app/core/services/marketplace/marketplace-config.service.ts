import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';

export interface MarketplaceCommissionSettings {
  percent: number;
  minFee: number;
  maxFee: number | null;
}

export interface MarketplaceDynamicPricingSettings {
  enabled: boolean;
  maxSurge: number;
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
}

export interface MarketplaceBiddingSettings {
  enabled: boolean;
  timeoutSeconds: number;
  maxBids: number;
  defaultServices: string[];
}

export interface MarketplaceSmartMatchingSettings {
  enabled: boolean;
  maxDistanceKm: number;
  ratingWeight: number;
  completionWeight: number;
  distanceWeight: number;
  responseWeight: number;
}

export interface MarketplaceHybridNegotiationSettings {
  enabled: boolean;
  maxRounds: number;
  timeoutSeconds: number;
  maxDriverAttempts: number;
  eligibleServices: string[];
  longDistanceRideKm: number;
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

  private defaultSettings(): MarketplaceSettings {
    return {
      commission: { percent: 5.0, minFee: 0, maxFee: null },
      dynamicPricing: {
        enabled: true,
        maxSurge: 3.0,
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
        minServices: ['errand', 'delivery', 'van-moving']
      },
      hybridNegotiation: {
        enabled: false,
        maxRounds: 5,
        timeoutSeconds: 120,
        maxDriverAttempts: 10,
        eligibleServices: ['shop', 'errand', 'shopping', 'van', 'van_moving', 'delivery'],
        longDistanceRideKm: 25
      },
      bidding: {
        enabled: true,
        timeoutSeconds: 300,
        maxBids: 10,
        defaultServices: ['van-moving']
      },
      smartMatching: {
        enabled: true,
        maxDistanceKm: 10,
        ratingWeight: 0.25,
        completionWeight: 0.35,
        distanceWeight: 0.30,
        responseWeight: 0.10
      }
    };
  }

  async loadSettings(): Promise<MarketplaceSettings> {
    this.loading.set(true);
    try {
      const { data, error } = await this.supabase
        .from('marketplace_settings')
        .select('key, value')
        .is('tenant_id', null);

      if (error) throw error;

      const defaults = this.defaultSettings();
      const map = (data || []).reduce((acc: Record<string, unknown>, row: any) => {
        acc[row.key] = row.value;
        return acc;
      }, {});

      const settings: MarketplaceSettings = {
        commission: { ...defaults.commission, ...(map['commission'] as Record<string, unknown> || {}) },
        dynamicPricing: { ...defaults.dynamicPricing, ...(map['dynamic_pricing'] as Record<string, unknown> || {}) },
        negotiation: { ...defaults.negotiation, ...(map['negotiation'] as Record<string, unknown> || {}) },
        hybridNegotiation: { ...defaults.hybridNegotiation, ...(map['hybrid_negotiation'] as Record<string, unknown> || {}) },
        bidding: { ...defaults.bidding, ...(map['bidding'] as Record<string, unknown> || {}) },
        smartMatching: { ...defaults.smartMatching, ...(map['smart_matching'] as Record<string, unknown> || {}) }
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
      { key: 'smart_matching', value: settings.smartMatching }
    ];

    for (const row of rows) {
      const { error } = await this.supabase
        .from('marketplace_settings')
        .upsert({
          key: row.key,
          value: row.value,
          tenant_id: null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'tenant_id,key' });

      if (error) throw error;
    }

    this.settings.set(settings);
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
