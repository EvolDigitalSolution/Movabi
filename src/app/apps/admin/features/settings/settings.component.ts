import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { FormsModule } from '@angular/forms';
import { addIcons } from 'ionicons';
import {
  settingsOutline,
  globeOutline,
  trashOutline,
  addCircleOutline,
  saveOutline,
  refreshOutline,
  checkmarkCircleOutline
} from 'ionicons/icons';
import { SystemConfigService } from '../../../../core/services/config/system-config.service';
import { AppConfigService, CountryConfig } from '../../../../core/services/config/app-config.service';
import { CardComponent, ButtonComponent, InputComponent } from '../../../../shared/ui';

type SettingsTab = 'general' | 'countries';

@Component({
  selector: 'app-admin-settings',
  standalone: true,
  imports: [CommonModule, IonicModule, FormsModule, CardComponent, ButtonComponent, InputComponent],
  template: `
    <div class="w-full min-h-screen bg-slate-50 overflow-y-auto">
      <div class="max-w-6xl mx-auto p-5 md:p-8 space-y-6 pb-12">

        <div class="bg-white border border-slate-100 rounded-[2rem] shadow-sm p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div>
            <h1 class="text-2xl md:text-3xl font-display font-bold text-slate-950">System Settings</h1>
            <p class="text-sm text-slate-500 font-medium mt-1">
              Configure defaults, supported countries, currencies and regional map settings.
            </p>
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <button type="button" (click)="resetChanges()" [disabled]="saving()" class="secondary-btn">
              <ion-icon name="refresh-outline"></ion-icon>
              Reset
            </button>

            <button type="button" (click)="saveAll()" [disabled]="saving()" class="primary-btn">
              <ion-icon name="save-outline"></ion-icon>
              {{ saving() ? 'Saving...' : 'Save Changes' }}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div class="lg:col-span-1">
            <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm p-3 lg:sticky lg:top-5 space-y-2">
              <button type="button" (click)="activeTab.set('general')" [class]="activeTab() === 'general' ? 'nav-btn active' : 'nav-btn'">
                <ion-icon name="settings-outline"></ion-icon>
                <span>General Defaults</span>
              </button>

              <button type="button" (click)="activeTab.set('countries')" [class]="activeTab() === 'countries' ? 'nav-btn active' : 'nav-btn'">
                <ion-icon name="globe-outline"></ion-icon>
                <span>Countries & Currencies</span>
                <span class="ml-auto text-[10px] px-2 py-1 rounded-full bg-slate-100 text-slate-500">
                  {{ countries.length }}
                </span>
              </button>
            </div>
          </div>

          <div class="lg:col-span-3 space-y-6">
            @if (loading()) {
              <div class="bg-white rounded-[1.5rem] border border-slate-100 p-20 text-center">
                <ion-spinner name="crescent"></ion-spinner>
                <p class="text-sm text-slate-500 font-semibold mt-4">Loading settings...</p>
              </div>
            } @else {
              @if (activeTab() === 'general') {
                <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm overflow-hidden">
                  <div class="p-6 border-b border-slate-100">
                    <h3 class="text-lg font-bold text-slate-950">General Configuration</h3>
                    <p class="text-sm text-slate-500 font-medium mt-1">
                      These settings control default country and map fallback values.
                    </p>
                  </div>

                  <div class="p-6 space-y-6">
                    <div class="grid md:grid-cols-2 gap-5">
                      <div>
                        <label class="field-label">Default Country</label>
                        <select [(ngModel)]="generalConfig.defaultCountryCode" (ngModelChange)="onDefaultCountryChange()" class="field-control">
                          @for (country of countries; track trackCountry(country, $index)) {
                            <option [value]="country.code">
                              {{ country.code || 'N/A' }} - {{ country.name || 'Unnamed country' }}
                            </option>
                          }
                        </select>
                      </div>

                      <div>
                        <label class="field-label">Default Currency Preview</label>
                        <div class="field-control bg-slate-50 flex items-center justify-between">
                          <span>{{ getDefaultCountry()?.currency || 'GBP' }}</span>
                          <strong>{{ getDefaultCountry()?.currencySymbol || '£' }}</strong>
                        </div>
                      </div>
                    </div>

                    <div class="pt-5 border-t border-slate-100">
                      <h4 class="text-sm font-bold text-slate-900 mb-4">Map Defaults</h4>

                      <div class="grid md:grid-cols-2 gap-5">
                        <div>
                          <label class="field-label">Default Latitude</label>
                          <input type="number" step="0.000001" [(ngModel)]="generalConfig.mapLat" class="field-control">
                        </div>

                        <div>
                          <label class="field-label">Default Longitude</label>
                          <input type="number" step="0.000001" [(ngModel)]="generalConfig.mapLng" class="field-control">
                        </div>
                      </div>
                    </div>

                    <div class="rounded-2xl bg-blue-50 border border-blue-100 p-5 flex items-start gap-4">
                      <div class="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
                        <ion-icon name="checkmark-circle-outline" class="text-xl"></ion-icon>
                      </div>
                      <div>
                        <h4 class="text-sm font-bold text-blue-950">Tip</h4>
                        <p class="text-sm text-blue-800 font-medium mt-1">
                          Changing the default country also updates the map latitude and longitude from that country’s saved centre.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              }

              @if (activeTab() === 'countries') {
                <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm overflow-hidden">
                  <div class="p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 class="text-lg font-bold text-slate-950">Countries & Currencies</h3>
                      <p class="text-sm text-slate-500 font-medium mt-1">
                        Manage supported countries, currency symbols, phone codes and map centres.
                      </p>
                    </div>

                    <button type="button" (click)="addCountry()" class="primary-btn h-10 text-xs">
                      <ion-icon name="add-circle-outline"></ion-icon>
                      Add Country
                    </button>
                  </div>

                  <div class="p-6 space-y-5">
                    @for (country of countries; track trackCountry(country, $index); let i = $index) {
                      <div class="rounded-[1.25rem] border border-slate-100 bg-slate-50/60 p-5">
                        <div class="flex items-start justify-between gap-4 mb-5">
                          <div>
                            <h4 class="text-base font-bold text-slate-950">
                              {{ country.name || 'New Country' }}
                              <span class="text-xs text-slate-400 font-semibold ml-2">{{ country.code || 'NO CODE' }}</span>
                            </h4>
                            <p class="text-xs text-slate-500 font-medium mt-1">
                              {{ country.currency || 'Currency missing' }} · {{ country.currencySymbol || 'Symbol missing' }} · {{ country.phoneCode || 'Phone missing' }}
                            </p>
                          </div>

                          <button type="button" (click)="askRemoveCountry(i)" class="icon-danger-btn" title="Remove country">
                            <ion-icon name="trash-outline" class="text-lg"></ion-icon>
                          </button>
                        </div>

                        <div class="grid md:grid-cols-2 gap-4">
                          <div>
                            <label class="field-label">Country Name</label>
                            <input [(ngModel)]="country.name" placeholder="United Kingdom" class="field-control">
                          </div>

                          <div>
                            <label class="field-label">ISO Code</label>
                            <input [(ngModel)]="country.code" (ngModelChange)="country.code = normaliseCode(country.code)" placeholder="GB" maxlength="3" class="field-control uppercase">
                          </div>

                          <div>
                            <label class="field-label">Currency Code</label>
                            <select [(ngModel)]="country.currency" (ngModelChange)="onCurrencyChange(country)" class="field-control">
                              <option value="GBP">GBP - British Pound</option>
                              <option value="USD">USD - US Dollar</option>
                              <option value="EUR">EUR - Euro</option>
                              <option value="NGN">NGN - Nigerian Naira</option>
                              <option value="CAD">CAD - Canadian Dollar</option>
                              <option value="AUD">AUD - Australian Dollar</option>
                              <option value="AED">AED - UAE Dirham</option>
                            </select>
                          </div>

                          <div>
                            <label class="field-label">Currency Symbol</label>
                            <input [(ngModel)]="country.currencySymbol" placeholder="£" maxlength="4" class="field-control">
                          </div>

                          <div>
                            <label class="field-label">Locale</label>
                            <input [(ngModel)]="country.locale" placeholder="en-GB" class="field-control">
                          </div>

                          <div>
                            <label class="field-label">Phone Code</label>
                            <input [(ngModel)]="country.phoneCode" placeholder="+44" class="field-control">
                          </div>
                        </div>

                        <div class="mt-5 pt-5 border-t border-slate-200">
                          <p class="field-label mb-3">Default Map Center</p>

                          <div class="grid md:grid-cols-2 gap-4">
                            <div>
                              <label class="field-label">Latitude</label>
                              <input type="number" step="0.000001" [(ngModel)]="country.defaultCenter.lat" class="field-control">
                            </div>

                            <div>
                              <label class="field-label">Longitude</label>
                              <input type="number" step="0.000001" [(ngModel)]="country.defaultCenter.lng" class="field-control">
                            </div>
                          </div>
                        </div>
                      </div>
                    }

                    @if (countries.length === 0) {
                      <div class="py-16 text-center">
                        <div class="w-16 h-16 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-300 mx-auto mb-4">
                          <ion-icon name="globe-outline" class="text-3xl"></ion-icon>
                        </div>
                        <h4 class="text-base font-bold text-slate-900">No countries configured</h4>
                        <p class="text-sm text-slate-500 font-medium mt-1">Add your first supported country.</p>
                      </div>
                    }
                  </div>
                </div>
              }
            }
          </div>
        </div>
      </div>
    </div>

    @if (confirmRemoveIndex() !== null) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-xl w-full max-w-md p-6">
          <h3 class="text-lg font-bold text-slate-900">Remove Country</h3>
          <p class="text-sm text-slate-500 mt-2">
            Remove "{{ countries[confirmRemoveIndex()!]?.name || 'this country' }}"?
          </p>

          <div class="mt-6 flex gap-3">
            <button type="button" (click)="confirmRemoveIndex.set(null)" class="flex-1 h-11 rounded-xl bg-slate-100 font-bold">
              Cancel
            </button>

            <button type="button" (click)="removeCountryNow()" class="flex-1 h-11 rounded-xl bg-rose-600 text-white font-bold">
              Remove
            </button>
          </div>
        </div>
      </div>
    }

    @if(showToast()) {
      <div class="fixed top-5 right-5 z-[11000]">
        <div
          class="px-5 py-3 rounded-2xl shadow-xl text-white text-sm font-semibold"
          [class.bg-emerald-600]="toastColor()==='success'"
          [class.bg-rose-600]="toastColor()==='danger'"
          [class.bg-amber-500]="toastColor()==='warning'"
        >
          {{ toastMessage() }}
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      min-height: 100%;
    }

    .nav-btn {
      width: 100%;
      padding: 0.9rem 1rem;
      border-radius: 1rem;
      text-align: left;
      font-weight: 800;
      font-size: 0.875rem;
      transition: all 150ms ease;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      color: rgb(71 85 105);
      background: white;
    }

    .nav-btn:hover {
      background: rgb(248 250 252);
    }

    .nav-btn.active {
      background: rgb(37 99 235);
      color: white;
      box-shadow: 0 10px 25px rgb(37 99 235 / 0.2);
    }

    .field-label {
      display: block;
      font-size: 10px;
      font-weight: 800;
      color: rgb(148 163 184);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 0.5rem;
    }

    .field-control {
      width: 100%;
      min-height: 2.75rem;
      background: white;
      border: 1px solid rgb(226 232 240);
      border-radius: 0.85rem;
      padding: 0.7rem 0.9rem;
      font-size: 0.875rem;
      font-weight: 700;
      color: rgb(15 23 42);
      outline: none;
    }

    .field-control:focus {
      border-color: rgb(59 130 246 / 0.55);
      box-shadow: 0 0 0 4px rgb(59 130 246 / 0.10);
    }

    .primary-btn {
      min-height: 2.75rem;
      padding: 0 1.25rem;
      border-radius: 0.75rem;
      background: rgb(37 99 235);
      color: white;
      font-size: 0.875rem;
      font-weight: 800;
      transition: all 150ms ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .primary-btn:hover {
      background: rgb(29 78 216);
    }

    .secondary-btn {
      min-height: 2.75rem;
      padding: 0 1.25rem;
      border-radius: 0.75rem;
      background: rgb(248 250 252);
      border: 1px solid rgb(226 232 240);
      color: rgb(51 65 85);
      font-size: 0.875rem;
      font-weight: 800;
      transition: all 150ms ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .icon-danger-btn {
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.75rem;
      background: white;
      color: rgb(148 163 184);
      border: 1px solid rgb(241 245 249);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 150ms ease;
    }

    .icon-danger-btn:hover {
      background: rgb(225 29 72);
      color: white;
    }
  `]
})
export class AdminSettingsComponent implements OnInit {
  private systemConfig = inject(SystemConfigService);
  private appConfig = inject(AppConfigService);

  activeTab = signal<SettingsTab>('general');
  saving = signal(false);
  loading = signal(true);
  confirmRemoveIndex = signal<number | null>(null);

  toastMessage = signal('');
  toastColor = signal<'success' | 'danger' | 'warning'>('success');
  showToast = signal(false);

  generalConfig = {
    defaultCountryCode: 'GB',
    mapLat: 51.5074,
    mapLng: -0.1278
  };

  countries: CountryConfig[] = [];
  private originalCountries: CountryConfig[] = [];

  constructor() {
    addIcons({
      settingsOutline,
      globeOutline,
      trashOutline,
      addCircleOutline,
      saveOutline,
      refreshOutline,
      checkmarkCircleOutline
    });
  }

  async ngOnInit() {
    await this.loadSettings();
  }

  async loadSettings() {
    this.loading.set(true);

    try {
      await this.systemConfig.loadConfigs();

      const appCountries = this.appConfig.countries();
      const loadedCountries = Array.isArray(appCountries) && appCountries.length
        ? appCountries
        : this.getDefaultCountries();

      this.countries = this.mergeCountries(
        this.cloneCountries(loadedCountries).map(country => this.normaliseCountry(country)),
        this.getDefaultCountries().map(country => this.normaliseCountry(country))
      );

      this.originalCountries = this.cloneCountries(this.countries);

      this.generalConfig.defaultCountryCode = this.normaliseCode(
        this.systemConfig.getConfig('default_country_code', this.countries[0]?.code || 'GB')
      );

      if (!this.countries.find(c => c.code === this.generalConfig.defaultCountryCode)) {
        this.generalConfig.defaultCountryCode = this.countries[0]?.code || 'GB';
      }

      this.onDefaultCountryChange();
    } catch (error) {
      console.error('Failed to load settings:', error);

      this.countries = this.getDefaultCountries();
      this.originalCountries = this.cloneCountries(this.countries);
      this.generalConfig.defaultCountryCode = 'GB';
      this.onDefaultCountryChange();

      this.triggerToast('Settings loaded with defaults.', 'warning');
    } finally {
      this.loading.set(false);
    }
  }

  private mergeCountries(saved: CountryConfig[], defaults: CountryConfig[]): CountryConfig[] {
    const map = new Map<string, CountryConfig>();

    for (const country of defaults) {
      map.set(country.code, country);
    }

    for (const country of saved) {
      map.set(country.code, {
        ...map.get(country.code),
        ...country,
        defaultCenter: {
          ...(map.get(country.code)?.defaultCenter || { lat: 0, lng: 0 }),
          ...(country.defaultCenter || { lat: 0, lng: 0 })
        }
      });
    }

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  addCountry() {
    this.countries.push({
      code: 'GB',
      name: 'New Country',
      currency: 'GBP',
      currencySymbol: '£',
      locale: 'en-GB',
      phoneCode: '+44',
      defaultCenter: { lat: 51.5074, lng: -0.1278 }
    });

    this.activeTab.set('countries');
  }

  askRemoveCountry(index: number) {
    this.confirmRemoveIndex.set(index);
  }

  removeCountryNow() {
    const index = this.confirmRemoveIndex();

    if (index === null || index < 0 || index >= this.countries.length) {
      this.confirmRemoveIndex.set(null);
      return;
    }

    this.countries.splice(index, 1);

    if (!this.countries.find(c => c.code === this.generalConfig.defaultCountryCode)) {
      this.generalConfig.defaultCountryCode = this.countries[0]?.code || 'GB';
      this.onDefaultCountryChange();
    }

    this.confirmRemoveIndex.set(null);
    this.triggerToast('Country removed.', 'success');
  }

  resetChanges() {
    this.countries = this.cloneCountries(this.originalCountries);
    this.generalConfig.defaultCountryCode = this.countries[0]?.code || 'GB';
    this.onDefaultCountryChange();
    this.triggerToast('Changes reset.', 'success');
  }

  onDefaultCountryChange() {
    const country = this.getDefaultCountry();

    if (country?.defaultCenter) {
      this.generalConfig.mapLat = Number(country.defaultCenter.lat || 0);
      this.generalConfig.mapLng = Number(country.defaultCenter.lng || 0);
    }
  }

  onCurrencyChange(country: CountryConfig) {
    country.currency = this.normaliseCode(country.currency);
    country.currencySymbol = this.symbolFromCode(country.currency);

    if (!country.locale) {
      country.locale = this.localeFromCountry(country.code);
    }
  }

  async saveAll() {
    if (!this.validateSettings()) return;

    this.saving.set(true);

    try {
      const normalisedCountries = this.countries.map(country => this.normaliseCountry(country));

      await this.systemConfig.setConfig('countries', normalisedCountries);
      await this.systemConfig.setConfig('default_country_code', this.normaliseCode(this.generalConfig.defaultCountryCode));
      await this.systemConfig.setConfig('default_map_center', {
        lat: Number(this.generalConfig.mapLat || 0),
        lng: Number(this.generalConfig.mapLng || 0)
      });

      await this.appConfig.refreshConfigs();

      this.countries = this.cloneCountries(normalisedCountries);
      this.originalCountries = this.cloneCountries(normalisedCountries);

      this.triggerToast('Settings saved successfully.', 'success');
    } catch (error) {
      console.error('Error saving settings:', error);
      this.triggerToast(error instanceof Error ? error.message : JSON.stringify(error), 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  validateSettings(): boolean {
    if (!this.countries.length) {
      this.triggerToast('Add at least one country.', 'warning');
      return false;
    }

    const codes = new Set<string>();

    for (const country of this.countries) {
      const normalised = this.normaliseCountry(country);
      Object.assign(country, normalised);

      if (!country.code || !country.name || !country.currency || !country.currencySymbol) {
        this.triggerToast('Country name, code, currency and symbol are required.', 'warning');
        return false;
      }

      if (codes.has(country.code)) {
        this.triggerToast(`Duplicate country code: ${country.code}`, 'warning');
        return false;
      }

      codes.add(country.code);
    }

    this.generalConfig.defaultCountryCode = this.normaliseCode(this.generalConfig.defaultCountryCode);

    if (!codes.has(this.generalConfig.defaultCountryCode)) {
      this.triggerToast('Default country must exist in countries list.', 'warning');
      return false;
    }

    return true;
  }

  getDefaultCountry(): CountryConfig | undefined {
    return this.countries.find(c => c.code === this.generalConfig.defaultCountryCode) || this.countries[0];
  }

  trackCountry(country: CountryConfig, index: number): string {
    return `${country.code || 'new'}-${index}`;
  }

  normaliseCode(value?: string | null): string {
    return String(value || '').trim().toUpperCase();
  }

  symbolFromCode(code?: string | null): string {
    const map: Record<string, string> = {
      GBP: '£',
      USD: '$',
      EUR: '€',
      NGN: '₦',
      CAD: '$',
      AUD: '$',
      AED: 'د.إ'
    };

    return map[this.normaliseCode(code)] || '£';
  }

  localeFromCountry(code?: string | null): string {
    const map: Record<string, string> = {
      GB: 'en-GB',
      US: 'en-US',
      NG: 'en-NG',
      CA: 'en-CA',
      AU: 'en-AU',
      AE: 'ar-AE',
      EU: 'en-IE'
    };

    return map[this.normaliseCode(code)] || 'en-GB';
  }

  private normaliseCountry(country: CountryConfig): CountryConfig {
    const code = this.normaliseCode(country?.code || 'GB');
    const currency = this.normaliseCode(country?.currency || 'GBP');

    return {
      code,
      name: country?.name || code,
      currency,
      currencySymbol: country?.currencySymbol || this.symbolFromCode(currency),
      locale: country?.locale || this.localeFromCountry(code),
      phoneCode: country?.phoneCode || '',
      defaultCenter: {
        lat: Number(country?.defaultCenter?.lat || 0),
        lng: Number(country?.defaultCenter?.lng || 0)
      }
    };
  }

  private cloneCountries(countries: CountryConfig[]): CountryConfig[] {
    return JSON.parse(JSON.stringify(countries || []));
  }

  private getDefaultCountries(): CountryConfig[] {
    return [
      {
        code: 'GB',
        name: 'United Kingdom',
        currency: 'GBP',
        currencySymbol: '£',
        locale: 'en-GB',
        phoneCode: '+44',
        defaultCenter: { lat: 51.5074, lng: -0.1278 }
      },
      {
        code: 'US',
        name: 'United States',
        currency: 'USD',
        currencySymbol: '$',
        locale: 'en-US',
        phoneCode: '+1',
        defaultCenter: { lat: 38.9072, lng: -77.0369 }
      },
      {
        code: 'NG',
        name: 'Nigeria',
        currency: 'NGN',
        currencySymbol: '₦',
        locale: 'en-NG',
        phoneCode: '+234',
        defaultCenter: { lat: 6.5244, lng: 3.3792 }
      },
      {
        code: 'IE',
        name: 'Ireland',
        currency: 'EUR',
        currencySymbol: '€',
        locale: 'en-IE',
        phoneCode: '+353',
        defaultCenter: { lat: 53.3498, lng: -6.2603 }
      },
      {
        code: 'FR',
        name: 'France',
        currency: 'EUR',
        currencySymbol: '€',
        locale: 'fr-FR',
        phoneCode: '+33',
        defaultCenter: { lat: 48.8566, lng: 2.3522 }
      },
      {
        code: 'DE',
        name: 'Germany',
        currency: 'EUR',
        currencySymbol: '€',
        locale: 'de-DE',
        phoneCode: '+49',
        defaultCenter: { lat: 52.52, lng: 13.405 }
      },
      {
        code: 'ES',
        name: 'Spain',
        currency: 'EUR',
        currencySymbol: '€',
        locale: 'es-ES',
        phoneCode: '+34',
        defaultCenter: { lat: 40.4168, lng: -3.7038 }
      },
      {
        code: 'IT',
        name: 'Italy',
        currency: 'EUR',
        currencySymbol: '€',
        locale: 'it-IT',
        phoneCode: '+39',
        defaultCenter: { lat: 41.9028, lng: 12.4964 }
      },
      {
        code: 'NL',
        name: 'Netherlands',
        currency: 'EUR',
        currencySymbol: '€',
        locale: 'nl-NL',
        phoneCode: '+31',
        defaultCenter: { lat: 52.3676, lng: 4.9041 }
      },
      {
        code: 'BE',
        name: 'Belgium',
        currency: 'EUR',
        currencySymbol: '€',
        locale: 'nl-BE',
        phoneCode: '+32',
        defaultCenter: { lat: 50.8503, lng: 4.3517 }
      },
      {
        code: 'PT',
        name: 'Portugal',
        currency: 'EUR',
        currencySymbol: '€',
        locale: 'pt-PT',
        phoneCode: '+351',
        defaultCenter: { lat: 38.7223, lng: -9.1393 }
      },
      {
        code: 'CA',
        name: 'Canada',
        currency: 'CAD',
        currencySymbol: '$',
        locale: 'en-CA',
        phoneCode: '+1',
        defaultCenter: { lat: 45.4215, lng: -75.6972 }
      },
      {
        code: 'AU',
        name: 'Australia',
        currency: 'AUD',
        currencySymbol: '$',
        locale: 'en-AU',
        phoneCode: '+61',
        defaultCenter: { lat: -35.2809, lng: 149.13 }
      },
      {
        code: 'AE',
        name: 'United Arab Emirates',
        currency: 'AED',
        currencySymbol: 'د.إ',
        locale: 'ar-AE',
        phoneCode: '+971',
        defaultCenter: { lat: 25.2048, lng: 55.2708 }
      }
    ];
  }

  triggerToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
    this.toastMessage.set(message);
    this.toastColor.set(color);
    this.showToast.set(true);

    setTimeout(() => {
      this.showToast.set(false);
    }, 2500);
  }
}
