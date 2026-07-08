import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { PricingConfig, FarePricingConfig } from '../../models/pricing-config.model';
import { ServiceTypeSlug } from '../../models/maps/map-marker.model';

@Injectable({
    providedIn: 'root'
})
export class PricingConfigService {
    private supabase = inject(SupabaseService);

    private configs = new Map<ServiceTypeSlug, FarePricingConfig>();
    private isLoaded = false;

    private readonly DEFAULT_CONFIGS: Record<ServiceTypeSlug, FarePricingConfig> = {
        ride: {
            baseFare: 2.5,
            distanceRatePerKm: 0.95,
            timeRatePerMinute: 0.12,
            serviceFee: 0.25,
            minimumFare: 3.99,
            label: 'Ride',
            freeIncludedItems: 1,
            extraItemFee: 0.75,
            largeShoppingSurcharge: 0,
            largeShoppingThreshold: 50,
            peakMultiplier: 1.0,
            weatherMultiplier: 1.0
        },

        delivery: {
            baseFare: 2.25,
            distanceRatePerKm: 0.55,
            timeRatePerMinute: 0.04,
            serviceFee: 0.1,
            minimumFare: 2.99,
            label: 'Delivery',
            freeIncludedItems: 1,
            extraItemFee: 0.75,
            largeShoppingSurcharge: 0,
            largeShoppingThreshold: 50,
            peakMultiplier: 1.0,
            weatherMultiplier: 1.0
        },

        errand: {
            baseFare: 5,
            distanceRatePerKm: 0.95,
            timeRatePerMinute: 0.12,
            serviceFee: 0.5,
            minimumFare: 6.5,
            label: 'Errand',
            freeIncludedItems: 1,
            extraItemFee: 0.75,
            largeShoppingSurcharge: 0,
            largeShoppingThreshold: 50,
            peakMultiplier: 1.0,
            weatherMultiplier: 1.0
        },

        'van-moving': {
            baseFare: 25,
            distanceRatePerKm: 1.6,
            timeRatePerMinute: 0.25,
            serviceFee: 1.5,
            minimumFare: 30,
            label: 'Van Moving',
            freeIncludedItems: 1,
            extraItemFee: 0.75,
            largeShoppingSurcharge: 0,
            largeShoppingThreshold: 50,
            peakMultiplier: 1.0,
            weatherMultiplier: 1.0
        }
    };

    constructor() {
        this.initializeWithDefaults();
    }

    private initializeWithDefaults() {
        Object.entries(this.DEFAULT_CONFIGS).forEach(([type, config]) => {
            this.configs.set(type as ServiceTypeSlug, { ...config });
        });
    }

    async loadPricingConfigs(force = false): Promise<void> {
        if (this.isLoaded && !force) return;

        try {
            const { data, error } = await this.supabase
                .from('pricing_config')
                .select('*')
                .eq('is_active', true);

            if (error) throw error;

            this.initializeWithDefaults();

            if (data?.length) {
                data.forEach((item: PricingConfig) => {
                    const serviceType = String(item.service_type || '') as ServiceTypeSlug;

                    if (!this.isSupportedServiceType(serviceType)) return;

                    const defaults = this.DEFAULT_CONFIGS[serviceType];
                    this.configs.set(serviceType, {
                        baseFare: this.safeMoney(item.base_fare, defaults.baseFare),
                        distanceRatePerKm: this.safeMoney(item.per_km, defaults.distanceRatePerKm),
                        timeRatePerMinute: this.safeMoney(item.per_min, defaults.timeRatePerMinute),
                        serviceFee: this.safeMoney(item.service_fee, defaults.serviceFee),
                        minimumFare: this.safeMoney(item.minimum_fare, defaults.minimumFare),
                        label: this.getLabelForService(serviceType),
                        freeIncludedItems: this.safeInt(item.free_included_items, defaults.freeIncludedItems),
                        extraItemFee: this.safeMoney(item.extra_item_fee, defaults.extraItemFee),
                        largeShoppingSurcharge: this.safeMoney(item.large_shopping_surcharge, defaults.largeShoppingSurcharge),
                        largeShoppingThreshold: this.safeMoney(item.large_shopping_threshold, defaults.largeShoppingThreshold),
                        peakMultiplier: this.safeMultiplier(item.peak_multiplier, defaults.peakMultiplier),
                        weatherMultiplier: this.safeMultiplier(item.weather_multiplier, defaults.weatherMultiplier)
                    });
                });
            }

            this.isLoaded = true;
        } catch (error) {
            console.warn('Failed to load pricing from database. Using competitive defaults.', error);
            this.initializeWithDefaults();
            this.isLoaded = true;
        }
    }

    getConfig(serviceType: ServiceTypeSlug | string | null | undefined): FarePricingConfig {
        const normalized = this.normalizeServiceType(serviceType);

        return (
            this.configs.get(normalized) ||
            this.DEFAULT_CONFIGS[normalized] ||
            this.DEFAULT_CONFIGS.ride
        );
    }

    getAllConfigs(): Record<ServiceTypeSlug, FarePricingConfig> {
        return {
            ride: this.getConfig('ride'),
            delivery: this.getConfig('delivery'),
            errand: this.getConfig('errand'),
            'van-moving': this.getConfig('van-moving')
        };
    }

    getSupportedServiceTypes(): ServiceTypeSlug[] {
        return ['ride', 'delivery', 'errand', 'van-moving'];
    }

    private normalizeServiceType(serviceType: ServiceTypeSlug | string | null | undefined): ServiceTypeSlug {
        const value = String(serviceType || 'ride').trim().toLowerCase();

        if (value === 'van' || value === 'moving' || value === 'van_moving' || value === 'van-moving') {
            return 'van-moving';
        }

        if (value === 'courier' || value === 'package' || value === 'parcel' || value === 'delivery') {
            return 'delivery';
        }

        if (value === 'shopping' || value === 'task' || value === 'errand') {
            return 'errand';
        }

        if (value === 'taxi' || value === 'cab' || value === 'ride') {
            return 'ride';
        }

        return 'ride';
    }

    private isSupportedServiceType(serviceType: string): serviceType is ServiceTypeSlug {
        return ['ride', 'delivery', 'errand', 'van-moving'].includes(serviceType);
    }

    private safeMoney(value: unknown, fallback = 0): number {
        const parsed = Number(value);

        if (!Number.isFinite(parsed) || parsed < 0) {
            return fallback;
        }

        return Math.round(parsed * 100) / 100;
    }

    private safeInt(value: unknown, fallback = 0): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
    }

    private safeMultiplier(value: unknown, fallback = 1): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    }

    private getLabelForService(serviceType: ServiceTypeSlug): string {
        switch (serviceType) {
            case 'ride':
                return 'Estimated ride fare';
            case 'delivery':
                return 'Estimated delivery fee';
            case 'errand':
                return 'Estimated errand fee';
            case 'van-moving':
                return 'Estimated moving fare';
            default:
                return 'Estimated fare';
        }
    }
}
