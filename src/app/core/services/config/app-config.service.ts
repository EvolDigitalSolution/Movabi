import { Injectable, signal } from '@angular/core';
import { environment } from '@env/environment';

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
  // Environment access
  public readonly env = environment;

  // Default to UK as per current project state
  public readonly countries: CountryConfig[] = [
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

  currentCountry = signal<CountryConfig>(this.countries[0]);

  setCountry(code: string) {
    const country = this.countries.find(c => c.code === code);
    if (country) {
      this.currentCountry.set(country);
    }
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

  formatCurrency(amount: number): string {
    return new Intl.NumberFormat(this.locale, {
      style: 'currency',
      currency: this.currencyCode,
    }).format(amount);
  }
}
