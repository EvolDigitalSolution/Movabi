import { Injectable, inject, computed } from '@angular/core';
import { environment } from '@env/environment';
import { SystemConfigService } from './system-config.service';

export interface CountryConfig {
  code: string;
  name: string;
  currency: string;
  currencySymbol: string;
  locale: string;
  phoneCode: string;
  defaultCenter: { lat: number, lng: number };
}

@Injectable({
  providedIn: 'root'
})
export class AppConfigService {
  private systemConfig = inject(SystemConfigService);

  // Environment access
  public readonly env = environment;

  // Default to UK as per current project state
  public readonly defaultCountries: CountryConfig[] = [
    {
      code: 'GB',
      name: 'United Kingdom',
      currency: 'GBP',
      currencySymbol: '£',
      locale: 'en-GB',
      phoneCode: '+44',
      defaultCenter: { lat: 51.5074, lng: -0.1278 } // London
    },
    {
      code: 'US',
      name: 'United States',
      currency: 'USD',
      currencySymbol: '$',
      locale: 'en-US',
      phoneCode: '+1',
      defaultCenter: { lat: 37.0902, lng: -95.7129 } // USA Center
    },
    {
      code: 'NG',
      name: 'Nigeria',
      currency: 'NGN',
      currencySymbol: '₦',
      locale: 'en-NG',
      phoneCode: '+234',
      defaultCenter: { lat: 9.0820, lng: 8.6753 } // Nigeria Center
    }
  ];

  public readonly countries = computed(() => {
    return this.systemConfig.getConfig<CountryConfig[]>('countries', this.defaultCountries);
  });

  public readonly currentCountry = computed(() => {
    const code = this.systemConfig.getConfig<string>('default_country_code', 'GB');
    return this.countries().find(c => c.code === code) || this.defaultCountries[0];
  });

  constructor() {
    this.refreshConfigs();
  }

  async refreshConfigs() {
    await this.systemConfig.loadConfigs();
  }

  setCountry(code: string) {
    // This is now handled by the computed currentCountry signal
    // but we keep the method if needed for explicit overrides, 
    // though it would need to update SystemConfig to persist.
    this.systemConfig.setConfig('default_country_code', code);
  }

  get currencySymbol() {
    return this.currentCountry().currencySymbol;
  }

  get currencyCode() {
    return this.currentCountry().currency;
  }

  get locale() {
    return this.currentCountry().locale;
  }

  formatCurrency(amount: number | string | null | undefined): string {
    const numericAmount = typeof amount === 'string' ? parseFloat(amount) : (amount || 0);
    if (isNaN(numericAmount)) return `${this.currencySymbol}0.00`;

    try {
      return new Intl.NumberFormat(this.locale, {
        style: 'currency',
        currency: this.currencyCode,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(numericAmount);
    } catch {
      // Fallback to simple formatting if Intl fails
      return `${this.currencySymbol}${numericAmount.toFixed(2)}`;
    }
  }
}
