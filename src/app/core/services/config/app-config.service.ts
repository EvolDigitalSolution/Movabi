import { Injectable, inject, computed, signal } from '@angular/core';
import { environment } from '@env/environment';
import { SystemConfigService } from './system-config.service';

export interface PopularShopPreset {
  name: string;
  logo: string;
  color: string;
  query: string;
}

export interface CountryPricingDefaults {
  rideBaseFare: number;
  errandBaseFare: number;
  deliveryBaseFare: number;
  vanBaseFare: number;
  perKm: number;
  perMinute: number;
  platformFeePercent: number;
}

export interface CountryConfig {
  code: string;
  name: string;
  currency: string;
  currencySymbol: string;
  locale: string;
  phoneCode: string;
  defaultCenter: { lat: number, lng: number };
  popularShops?: PopularShopPreset[];
  pricingDefaults?: CountryPricingDefaults;
}

interface RuntimeCountryHint {
  code: string;
  name?: string;
  currency?: string;
  phoneCode?: string;
  lat?: number;
  lng?: number;
}

@Injectable({
  providedIn: 'root'
})
export class AppConfigService {
  private systemConfig = inject(SystemConfigService);
  private readonly countryStorageKey = 'movabi_country_code';
  private readonly geoHintStorageKey = 'movabi_geo_hint';
  private readonly runtimeCountryCode = signal<string | null>(this.readStoredCountryCode());
  private readonly runtimeCountryHint = signal<RuntimeCountryHint | null>(this.readCachedGeoHint());
  private detectionStarted = false;
  private geoLookupAttempted = false;

  public readonly env = environment;

  // Admin country/pricing settings remain the production source of truth.
  // These defaults give every market a safe startup experience before admin customisation.
  public readonly defaultCountries: CountryConfig[] = [
    this.country('GB', 'United Kingdom', 'GBP', '£', 'en-GB', '+44', 51.5074, -0.1278, [
      ['Tesco', 'T', '#00539f'], ['Asda', 'A', '#2f8f2f'], ["Sainsbury's", 'S', '#f06c00'],
      ['Morrisons', 'M', '#006548'], ['Co-op', 'C', '#00a3e0'], ['Aldi', 'A', '#0b4ea2'],
      ['Lidl', 'L', '#0050aa'], ['Boots', 'B', '#00539f'], ['Other', 'O', '#64748b']
    ], this.pricing(3.5, 4.5, 3.25, 14, 1.05, 0.18, 12)),
    this.country('US', 'United States', 'USD', '$', 'en-US', '+1', 38.9072, -77.0369, [
      ['Walmart', 'W', '#0071ce'], ['Target', 'T', '#cc0000'], ['Costco', 'C', '#005daa'],
      ['Kroger', 'K', '#0066b3'], ['Walgreens', 'W', '#e31837'], ['CVS', 'C', '#cc0000']
    ], this.pricing(5, 6, 5, 22, 1.15, 0.22, 12)),
    this.country('NG', 'Nigeria', 'NGN', '₦', 'en-NG', '+234', 6.5244, 3.3792, [
      ['Shoprite', 'S', '#f4b000'], ['SPAR', 'S', '#007a3d'], ['Market Square', 'M', '#d71920'],
      ['Justrite', 'J', '#005aaa'], ['Ebeano', 'E', '#0f9d58'], ['Jumia', 'J', '#f68b1e']
    ], this.pricing(1800, 2200, 1600, 7500, 400, 70, 12)),
    this.country('IE', 'Ireland', 'EUR', '€', 'en-IE', '+353', 53.3498, -6.2603, [
      ['Tesco', 'T', '#00539f'], ['Dunnes', 'D', '#111827'], ['Lidl', 'L', '#0050aa'],
      ['Aldi', 'A', '#0b4ea2'], ['SuperValu', 'S', '#dc2626'], ['Centra', 'C', '#16a34a']
    ], this.pricing(4.5, 5.5, 4.25, 18, 1.1, 0.2, 12)),
    this.country('FR', 'France', 'EUR', '€', 'fr-FR', '+33', 48.8566, 2.3522, [
      ['Carrefour', 'C', '#0050a4'], ['Lidl', 'L', '#0050aa'], ['Intermarche', 'I', '#dc2626'],
      ['Auchan', 'A', '#e30613'], ['Monoprix', 'M', '#ef4444'], ['E.Leclerc', 'E', '#2563eb']
    ], this.pricing(5, 6, 4.5, 20, 1.15, 0.22, 12)),
    this.country('DE', 'Germany', 'EUR', '€', 'de-DE', '+49', 52.52, 13.405, [
      ['Aldi', 'A', '#0b4ea2'], ['Lidl', 'L', '#0050aa'], ['Rewe', 'R', '#d71920'],
      ['Edeka', 'E', '#f59e0b'], ['Kaufland', 'K', '#dc2626'], ['dm', 'D', '#0ea5e9']
    ], this.pricing(5, 6, 4.5, 20, 1.15, 0.22, 12)),
    this.country('ES', 'Spain', 'EUR', '€', 'es-ES', '+34', 40.4168, -3.7038, [
      ['Mercadona', 'M', '#00953b'], ['Carrefour', 'C', '#0050a4'], ['Dia', 'D', '#ef4444'],
      ['Lidl', 'L', '#0050aa'], ['Aldi', 'A', '#0b4ea2'], ['Alcampo', 'A', '#dc2626']
    ], this.pricing(4.5, 5.5, 4.25, 18, 1.05, 0.2, 12)),
    this.country('IT', 'Italy', 'EUR', '€', 'it-IT', '+39', 41.9028, 12.4964, [
      ['Conad', 'C', '#e30613'], ['Coop', 'C', '#dc2626'], ['Esselunga', 'E', '#f97316'],
      ['Carrefour', 'C', '#0050a4'], ['Lidl', 'L', '#0050aa'], ['Eurospin', 'E', '#2563eb']
    ], this.pricing(4.5, 5.5, 4.25, 18, 1.05, 0.2, 12)),
    this.country('NL', 'Netherlands', 'EUR', '€', 'nl-NL', '+31', 52.3676, 4.9041, [
      ['Albert Heijn', 'A', '#009fe3'], ['Jumbo', 'J', '#f7c600'], ['Lidl', 'L', '#0050aa'],
      ['Aldi', 'A', '#0b4ea2'], ['PLUS', 'P', '#16a34a'], ['Kruidvat', 'K', '#dc2626']
    ], this.pricing(5, 6, 4.5, 20, 1.15, 0.22, 12)),
    this.country('BE', 'Belgium', 'EUR', '€', 'nl-BE', '+32', 50.8503, 4.3517, [
      ['Delhaize', 'D', '#e30613'], ['Carrefour', 'C', '#0050a4'], ['Colruyt', 'C', '#dc2626'],
      ['Aldi', 'A', '#0b4ea2'], ['Lidl', 'L', '#0050aa'], ['Albert Heijn', 'A', '#009fe3']
    ], this.pricing(5, 6, 4.5, 20, 1.15, 0.22, 12)),
    this.country('PT', 'Portugal', 'EUR', '€', 'pt-PT', '+351', 38.7223, -9.1393, [
      ['Continente', 'C', '#ef4444'], ['Pingo Doce', 'P', '#16a34a'], ['Lidl', 'L', '#0050aa'],
      ['Aldi', 'A', '#0b4ea2'], ['Auchan', 'A', '#e30613'], ['Minipreco', 'M', '#dc2626']
    ], this.pricing(4, 5, 3.75, 16, 0.95, 0.18, 12)),
    this.country('CA', 'Canada', 'CAD', '$', 'en-CA', '+1', 45.4215, -75.6972, [
      ['Walmart', 'W', '#0071ce'], ['Costco', 'C', '#005daa'], ['Loblaws', 'L', '#dc2626'],
      ['No Frills', 'N', '#facc15'], ['Shoppers', 'S', '#ef4444'], ['Metro', 'M', '#2563eb']
    ], this.pricing(6, 7, 5.5, 24, 1.25, 0.24, 12)),
    this.country('AU', 'Australia', 'AUD', '$', 'en-AU', '+61', -35.2809, 149.13, [
      ['Woolworths', 'W', '#178a00'], ['Coles', 'C', '#e31b23'], ['Aldi', 'A', '#0b4ea2'],
      ['IGA', 'I', '#dc2626'], ['Chemist Warehouse', 'C', '#facc15'], ['Big W', 'B', '#2563eb']
    ], this.pricing(7, 8, 6, 28, 1.35, 0.26, 12)),
    this.country('NZ', 'New Zealand', 'NZD', '$', 'en-NZ', '+64', -41.2865, 174.7762, [
      ['New World', 'N', '#dc2626'], ['Countdown', 'C', '#16a34a'], ["Pak'nSave", 'P', '#facc15'],
      ['The Warehouse', 'T', '#ef4444'], ['Chemist Warehouse', 'C', '#facc15'], ['Four Square', 'F', '#2563eb']
    ], this.pricing(7, 8, 6, 28, 1.35, 0.26, 12)),
    this.country('IN', 'India', 'INR', '₹', 'en-IN', '+91', 28.6139, 77.209, [
      ['Reliance Fresh', 'R', '#0066b3'], ['DMart', 'D', '#16a34a'], ['BigBasket', 'B', '#dc2626'],
      ['Blinkit', 'B', '#facc15'], ['Apollo Pharmacy', 'A', '#16a34a'], ['More', 'M', '#f97316']
    ], this.pricing(120, 150, 120, 650, 22, 4, 12)),
    this.country('AE', 'United Arab Emirates', 'AED', 'د.إ', 'ar-AE', '+971', 25.2048, 55.2708, [
      ['Carrefour', 'C', '#0050a4'], ['Lulu', 'L', '#16a34a'], ['Spinneys', 'S', '#dc2626'],
      ['Choithrams', 'C', '#f97316'], ['Noon', 'N', '#facc15'], ['Union Coop', 'U', '#2563eb']
    ], this.pricing(12, 15, 12, 55, 2.5, 0.5, 12)),
    this.country('ZA', 'South Africa', 'ZAR', 'R', 'en-ZA', '+27', -26.2041, 28.0473, [
      ['Pick n Pay', 'P', '#0050a4'], ['Checkers', 'C', '#dc2626'], ['Shoprite', 'S', '#f97316'],
      ['Woolworths', 'W', '#111827'], ['Spar', 'S', '#16a34a'], ['Dis-Chem', 'D', '#2563eb']
    ], this.pricing(55, 65, 50, 220, 10, 2, 12)),
    this.country('KE', 'Kenya', 'KES', 'KSh', 'en-KE', '+254', -1.2864, 36.8172, [
      ['Naivas', 'N', '#16a34a'], ['Carrefour', 'C', '#0050a4'], ['Quickmart', 'Q', '#f97316'],
      ['Chandarana', 'C', '#dc2626'], ['Java House', 'J', '#7c2d12'], ['Cleanshelf', 'C', '#2563eb']
    ], this.pricing(250, 300, 220, 1200, 45, 8, 12)),
    this.country('GH', 'Ghana', 'GHS', 'GH₵', 'en-GH', '+233', 5.6037, -0.187, [
      ['Shoprite', 'S', '#f4b000'], ['Melcom', 'M', '#2563eb'], ['MaxMart', 'M', '#dc2626'],
      ['Palace Mall', 'P', '#7c3aed'], ['Koala', 'K', '#16a34a'], ['Jumia', 'J', '#f68b1e']
    ], this.pricing(25, 30, 22, 110, 4.5, 0.8, 12))
  ];

  public readonly countries = computed(() => {
    const configured = this.systemConfig.getConfig<CountryConfig[]>('countries', this.defaultCountries);
    return this.mergeCountryDefaults(configured);
  });

  public readonly currentCountry = computed(() => {
    const code = this.runtimeCountryCode() || this.systemConfig.getConfig<string>('default_country_code', 'GB');
    const configuredCountry = this.countries().find(c => c.code === code);
    if (configuredCountry) return configuredCountry;

    const hint = this.runtimeCountryHint();
    if (hint?.code === code) return this.countryFromHint(hint);

    return this.defaultCountries[0];
  });

  public readonly popularShops = computed(() => {
    return this.currentCountry().popularShops || this.defaultCountries[0].popularShops || [];
  });

  public readonly vehiclePlateLookupEnabled = computed(() => {
    return this.systemConfig.getConfig<boolean>('vehicle_plate_lookup_enabled', false);
  });

  public readonly selectedLanguage = computed(() => this.currentCountry().locale.split('-')[0] || 'en');

  // Static FX rates are placeholders until live FX service is added.
  private readonly gbpRates: Record<string, number> = {
    GBP: 1,
    USD: 1.27,
    EUR: 1.18,
    NGN: 1900,
    CAD: 1.73,
    AUD: 1.94,
    NZD: 2.1,
    INR: 106,
    AED: 4.66,
    ZAR: 23,
    KES: 164,
    GHS: 20
  };

  private readonly phrases: Record<string, Record<string, string>> = {
    en: {
      country_updated: 'Country updated',
      currency_preview: 'Currency preview',
      language_preview: 'Language'
    },
    fr: {
      country_updated: 'Pays mis à jour',
      currency_preview: 'Aperçu de la devise',
      language_preview: 'Langue'
    },
    de: {
      country_updated: 'Land aktualisiert',
      currency_preview: 'Währungsvorschau',
      language_preview: 'Sprache'
    },
    es: {
      country_updated: 'País actualizado',
      currency_preview: 'Vista de moneda',
      language_preview: 'Idioma'
    },
    it: {
      country_updated: 'Paese aggiornato',
      currency_preview: 'Anteprima valuta',
      language_preview: 'Lingua'
    },
    pt: {
      country_updated: 'País atualizado',
      currency_preview: 'Prévia da moeda',
      language_preview: 'Idioma'
    }
  };

  constructor() {
    this.refreshConfigs();
  }

  async refreshConfigs() {
    await this.systemConfig.loadConfigs();
  }

  setCountry(code: string) {
    this.setRuntimeCountry(code);
  }

  async detectRuntimeCountry() {
    if (this.detectionStarted) return;
    this.detectionStarted = true;

    // If the user has already selected a country, trust that and skip geo lookup.
    if (!this.runtimeCountryCode()) {
      const localeCountry = this.countryFromLocale(this.getBrowserLocale());
      if (localeCountry) this.setRuntimeCountry(localeCountry, false);
    }

    // Use a cached geo hint if we have one. This avoids repeated calls to the
    // external geo service and keeps the app working when the service is rate
    // limited or blocked by CORS.
    const cachedHint = this.readCachedGeoHint();
    if (cachedHint?.code) {
      this.setRuntimeCountry(cachedHint.code, false, cachedHint);
      return;
    }

    // If a user-selected country is already set, don't override it with geo.
    if (this.runtimeCountryCode()) return;

    // Only attempt the external lookup once per session. On failure we fall back
    // to the UK defaults, which already power pricing/booking/dashbord.
    if (this.geoLookupAttempted) return;
    this.geoLookupAttempted = true;

    try {
      const ipCountry = await this.detectCountryFromIp();
      if (ipCountry) {
        this.writeCachedGeoHint(ipCountry);
        this.setRuntimeCountry(ipCountry.code, false, ipCountry);
      }
    } catch {
      // Fail silently. Default GB/GBP will be used.
    }
  }

  get currencySymbol() {
    return this.currentCountry().currencySymbol;
  }

  get currencyCode() {
    return this.currentCountry().currency;
  }

  currentCurrency(): string {
    return this.currencyCode;
  }

  get locale() {
    return this.currentCountry().locale;
  }

  formatCurrency(amount: number | string | null | undefined): string {
    const numericAmount = typeof amount === 'string' ? parseFloat(amount) : (amount || 0);
    if (isNaN(numericAmount)) return `${this.currencySymbol}0.00`;
    const displayAmount = this.convertAmount(numericAmount, 'GBP', this.currencyCode);

    try {
      return new Intl.NumberFormat(this.locale, {
        style: 'currency',
        currency: this.currencyCode,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(displayAmount);
    } catch {
      return `${this.currencySymbol}${displayAmount.toFixed(2)}`;
    }
  }

  convertAmount(amount: number, fromCurrency = 'GBP', toCurrency = this.currencyCode): number {
    const sourceRate = this.gbpRates[String(fromCurrency || 'GBP').toUpperCase()] || 1;
    const targetRate = this.gbpRates[String(toCurrency || this.currencyCode).toUpperCase()] || sourceRate;
    return Number(((Number(amount || 0) / sourceRate) * targetRate).toFixed(2));
  }

  formatConvertedFromGbp(amount: number): string {
    return this.formatCurrency(amount);
  }

  t(key: string): string {
    const language = this.selectedLanguage();
    return this.phrases[language]?.[key] || this.phrases['en'][key] || key;
  }

  private country(
    code: string,
    name: string,
    currency: string,
    currencySymbol: string,
    locale: string,
    phoneCode: string,
    lat: number,
    lng: number,
    shops: Array<[string, string, string]>,
    pricingDefaults: CountryPricingDefaults
  ): CountryConfig {
    return {
      code,
      name,
      currency,
      currencySymbol,
      locale,
      phoneCode,
      defaultCenter: { lat, lng },
      popularShops: shops.map(([shopName, logo, color]) => ({
        name: shopName,
        logo,
        color,
        query: shopName === 'Other' ? '' : `${shopName} near me`
      })),
      pricingDefaults
    };
  }

  private pricing(
    rideBaseFare: number,
    errandBaseFare: number,
    deliveryBaseFare: number,
    vanBaseFare: number,
    perKm: number,
    perMinute: number,
    platformFeePercent: number
  ): CountryPricingDefaults {
    return { rideBaseFare, errandBaseFare, deliveryBaseFare, vanBaseFare, perKm, perMinute, platformFeePercent };
  }

  private mergeCountryDefaults(countries: CountryConfig[]): CountryConfig[] {
    const defaults = new Map(this.defaultCountries.map(country => [country.code, country]));
    const merged = (countries || []).map(country => {
      const fallback = defaults.get(country.code);
      return {
        ...fallback,
        ...country,
        currencySymbol: this.isBrokenSymbol(country.currencySymbol) ? (fallback?.currencySymbol || country.currencySymbol) : country.currencySymbol,
        defaultCenter: country.defaultCenter || fallback?.defaultCenter || this.defaultCountries[0].defaultCenter,
        popularShops: country.popularShops?.length ? country.popularShops : fallback?.popularShops,
        pricingDefaults: country.pricingDefaults || fallback?.pricingDefaults
      } as CountryConfig;
    });

    const configuredCodes = new Set(merged.map(country => country.code));
    for (const country of this.defaultCountries) {
      if (!configuredCodes.has(country.code)) merged.push(country);
    }

    return merged.sort((a, b) => a.name.localeCompare(b.name));
  }

  private setRuntimeCountry(code: string, persist = true, hint: RuntimeCountryHint | null = null) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return;
    const supported = this.defaultCountries.some(country => country.code === normalized)
      || this.countries().some(country => country.code === normalized);
    if (!supported && !hint) return;

    this.runtimeCountryCode.set(normalized);
    if (hint) this.runtimeCountryHint.set({ ...hint, code: normalized });
    if (persist && typeof localStorage !== 'undefined') {
      localStorage.setItem(this.countryStorageKey, normalized);
    }
  }

  private countryFromHint(hint: RuntimeCountryHint): CountryConfig {
    const locale = `en-${hint.code}`;
    // Prefer known defaults for this country; otherwise fall back to the hint
    // values and finally to the UK default so pricing/booking never break.
    const defaultCountry = this.defaultCountries.find(c => c.code === hint.code);
    const currency = hint.currency || defaultCountry?.currency || 'GBP';
    const phoneCode = hint.phoneCode || defaultCountry?.phoneCode || '+44';
    return {
      code: hint.code,
      name: hint.name || this.countryNameFromCode(hint.code),
      currency,
      currencySymbol: this.symbolFromCurrency(currency, locale),
      locale,
      phoneCode,
      defaultCenter: {
        lat: typeof hint.lat === 'number' ? hint.lat : defaultCountry?.defaultCenter.lat ?? this.defaultCountries[0].defaultCenter.lat,
        lng: typeof hint.lng === 'number' ? hint.lng : defaultCountry?.defaultCenter.lng ?? this.defaultCountries[0].defaultCenter.lng
      },
      popularShops: defaultCountry?.popularShops ?? this.defaultCountries[0].popularShops,
      pricingDefaults: defaultCountry?.pricingDefaults ?? this.defaultCountries[0].pricingDefaults
    };
  }

  private readCachedGeoHint(): RuntimeCountryHint | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.geoHintStorageKey);
      return raw ? (JSON.parse(raw) as RuntimeCountryHint) : null;
    } catch {
      return null;
    }
  }

  private writeCachedGeoHint(hint: RuntimeCountryHint): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.geoHintStorageKey, JSON.stringify(hint));
    } catch {
      // ignore storage errors
    }
  }

  private isBrokenSymbol(symbol: string | null | undefined): boolean {
    return !symbol || /Ã|Â|â|Ø/.test(symbol);
  }

  private readStoredCountryCode(): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(this.countryStorageKey);
  }

  private getBrowserLocale(): string | null {
    if (typeof navigator === 'undefined') return null;
    return navigator.languages?.[0] || navigator.language || null;
  }

  private countryFromLocale(locale: string | null): string | null {
    const match = String(locale || '').match(/[-_]([A-Za-z]{2})$/);
    return match?.[1]?.toUpperCase() || null;
  }

  private countryNameFromCode(code: string): string {
    try {
      const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
      return displayNames.of(code) || code;
    } catch {
      return code;
    }
  }

  private symbolFromCurrency(currency: string, locale: string): string {
    try {
      const parts = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      }).formatToParts(0);
      return parts.find(part => part.type === 'currency')?.value || currency;
    } catch {
      return currency;
    }
  }

  private async detectCountryFromIp(): Promise<RuntimeCountryHint | null> {
    if (typeof fetch === 'undefined') return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch('https://ipapi.co/json/', {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return null;
      const data = await response.json() as {
        country_code?: string;
        country_name?: string;
        currency?: string;
        country_calling_code?: string;
        latitude?: number;
        longitude?: number;
      };
      if (!data.country_code) return null;
      return {
        code: String(data.country_code).toUpperCase(),
        name: data.country_name,
        currency: data.currency,
        phoneCode: data.country_calling_code,
        lat: data.latitude,
        lng: data.longitude
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
