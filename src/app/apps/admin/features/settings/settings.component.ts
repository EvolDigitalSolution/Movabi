import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ToastController, AlertController } from '@ionic/angular';
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
    <ion-content class="bg-slate-50">
      <div class="max-w-6xl mx-auto p-5 md:p-8 space-y-6 pb-12">
        <div class="bg-white border border-slate-100 rounded-[2rem] shadow-sm p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div>
            <h1 class="text-2xl md:text-3xl font-display font-bold text-slate-950">System Settings</h1>
            <p class="text-sm text-slate-500 font-medium mt-1">
              Configure defaults, supported countries, currencies and regional map settings.
            </p>
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              (click)="resetChanges()"
              [disabled]="saving()"
              class="h-11 px-5 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-100 disabled:opacity-50 transition inline-flex items-center justify-center gap-2"
            >
              <ion-icon name="refresh-outline"></ion-icon>
              Reset
            </button>

            <button
              type="button"
              (click)="saveAll()"
              [disabled]="saving()"
              class="h-11 px-5 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-50 transition inline-flex items-center justify-center gap-2"
            >
              <ion-icon name="save-outline"></ion-icon>
              {{ saving() ? 'Saving...' : 'Save Changes' }}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div class="lg:col-span-1">
            <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm p-3 sticky top-5 space-y-2">
              <button
                type="button"
                (click)="activeTab.set('general')"
                [class]="activeTab() === 'general' ? 'nav-btn active' : 'nav-btn'"
              >
                <ion-icon name="settings-outline"></ion-icon>
                <span>General Defaults</span>
              </button>

              <button
                type="button"
                (click)="activeTab.set('countries')"
                [class]="activeTab() === 'countries' ? 'nav-btn active' : 'nav-btn'"
              >
                <ion-icon name="globe-outline"></ion-icon>
                <span>Countries & Currencies</span>
                <span class="ml-auto text-[10px] px-2 py-1 rounded-full bg-slate-100 text-slate-500">
                  {{ countries.length }}
                </span>
              </button>
            </div>
          </div>

          <div class="lg:col-span-3 space-y-6">
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
                      <select
                        [(ngModel)]="generalConfig.defaultCountryCode"
                        (ngModelChange)="onDefaultCountryChange()"
                        class="field-control"
                      >
                        @for (country of countries; track country.code) {
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
                        <input
                          type="number"
                          step="0.000001"
                          [(ngModel)]="generalConfig.mapLat"
                          class="field-control"
                        >
                      </div>

                      <div>
                        <label class="field-label">Default Longitude</label>
                        <input
                          type="number"
                          step="0.000001"
                          [(ngModel)]="generalConfig.mapLng"
                          class="field-control"
                        >
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

                  <button
                    type="button"
                    (click)="addCountry()"
                    class="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition inline-flex items-center justify-center gap-2"
                  >
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

                        <button
                          type="button"
                          (click)="removeCountry(i)"
                          class="w-9 h-9 rounded-xl bg-white text-slate-400 hover:bg-rose-600 hover:text-white transition border border-slate-100 flex items-center justify-center"
                          title="Remove country"
                        >
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
                          <input
                            [(ngModel)]="country.code"
                            (ngModelChange)="country.code = normaliseCode(country.code)"
                            placeholder="GB"
                            maxlength="3"
                            class="field-control uppercase"
                          >
                        </div>

                        <div>
                          <label class="field-label">Currency Code</label>
                          <select
                            [(ngModel)]="country.currency"
                            (ngModelChange)="onCurrencyChange(country)"
                            class="field-control"
                          >
                            <option value="GBP">GBP - British Pound</option>
                            <option value="USD">USD - US Dollar</option>
                            <option value="EUR">EUR - Euro</option>
                            <option value="NGN">NGN - Nigerian Naira</option>
                            <option value="CAD">CAD - Canadian Dollar</option>
                            <option value="AUD">AUD - Australian Dollar</option>
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
          </div>
        </div>
      </div>
    </ion-content>
  `,
    styles: [`
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
  `]
})
export class AdminSettingsComponent implements OnInit {
    private systemConfig = inject(SystemConfigService);
    private appConfig = inject(AppConfigService);
    private toastCtrl = inject(ToastController);
    private alertCtrl = inject(AlertController);

    activeTab = signal<SettingsTab>('general');
    saving = signal(false);

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
        try {
            await this.systemConfig.loadConfigs();

            const countries = this.appConfig.countries();
            this.countries = this.cloneCountries(Array.isArray(countries) ? countries : []);
            this.originalCountries = this.cloneCountries(this.countries);

            this.generalConfig.defaultCountryCode = this.systemConfig.getConfig('default_country_code', 'GB');

            if (!this.countries.length) {
                this.countries = this.getDefaultCountries();
                this.originalCountries = this.cloneCountries(this.countries);
            }

            this.onDefaultCountryChange();
        } catch (error) {
            console.error('Failed to load settings:', error);
            await this.showToast('Failed to load settings.', 'danger');
        }
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

    async removeCountry(index: number) {
        const country = this.countries[index];

        const alert = await this.alertCtrl.create({
            header: 'Remove Country',
            message: `Remove "${country?.name || 'this country'}"?`,
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Remove',
                    role: 'destructive',
                    handler: () => {
                        this.countries.splice(index, 1);

                        if (!this.countries.find(c => c.code === this.generalConfig.defaultCountryCode)) {
                            this.generalConfig.defaultCountryCode = this.countries[0]?.code || 'GB';
                            this.onDefaultCountryChange();
                        }
                    }
                }
            ]
        });

        await alert.present();
    }

    resetChanges() {
        this.countries = this.cloneCountries(this.originalCountries);
        this.generalConfig.defaultCountryCode = this.systemConfig.getConfig('default_country_code', 'GB');
        this.onDefaultCountryChange();
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
            const normalisedCountries = this.countries.map(country => ({
                ...country,
                code: this.normaliseCode(country.code),
                currency: this.normaliseCode(country.currency),
                currencySymbol: country.currencySymbol || this.symbolFromCode(country.currency),
                locale: country.locale || this.localeFromCountry(country.code),
                phoneCode: country.phoneCode || '',
                defaultCenter: {
                    lat: Number(country.defaultCenter?.lat || 0),
                    lng: Number(country.defaultCenter?.lng || 0)
                }
            }));

            await this.systemConfig.setConfig('countries', normalisedCountries);
            await this.systemConfig.setConfig('default_country_code', this.normaliseCode(this.generalConfig.defaultCountryCode));
            await this.systemConfig.setConfig('default_map_center', {
                lat: Number(this.generalConfig.mapLat || 0),
                lng: Number(this.generalConfig.mapLng || 0)
            });

            await this.appConfig.refreshConfigs();

            this.countries = this.cloneCountries(normalisedCountries);
            this.originalCountries = this.cloneCountries(normalisedCountries);

            await this.showToast('Settings saved successfully.', 'success');
        } catch (error) {
            console.error('Error saving settings:', error);
            await this.showToast(error instanceof Error ? error.message : 'Failed to save settings.', 'danger');
        } finally {
            this.saving.set(false);
        }
    }

    validateSettings(): boolean {
        if (!this.countries.length) {
            this.showToast('Add at least one country.', 'warning');
            return false;
        }

        const codes = new Set<string>();

        for (const country of this.countries) {
            country.code = this.normaliseCode(country.code);
            country.currency = this.normaliseCode(country.currency);

            if (!country.code || !country.name || !country.currency || !country.currencySymbol) {
                this.showToast('Country name, code, currency and symbol are required.', 'warning');
                return false;
            }

            if (codes.has(country.code)) {
                this.showToast(`Duplicate country code: ${country.code}`, 'warning');
                return false;
            }

            codes.add(country.code);

            if (!country.defaultCenter) {
                country.defaultCenter = { lat: 0, lng: 0 };
            }

            country.defaultCenter.lat = Number(country.defaultCenter.lat || 0);
            country.defaultCenter.lng = Number(country.defaultCenter.lng || 0);
        }

        this.generalConfig.defaultCountryCode = this.normaliseCode(this.generalConfig.defaultCountryCode);

        if (!codes.has(this.generalConfig.defaultCountryCode)) {
            this.showToast('Default country must exist in countries list.', 'warning');
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
            AUD: '$'
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
            EU: 'en-IE'
        };

        return map[this.normaliseCode(code)] || 'en-GB';
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
                code: 'NG',
                name: 'Nigeria',
                currency: 'NGN',
                currencySymbol: '₦',
                locale: 'en-NG',
                phoneCode: '+234',
                defaultCenter: { lat: 6.5244, lng: 3.3792 }
            }
        ];
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
        const toast = await this.toastCtrl.create({
            message,
            duration: 2500,
            color
        });

        await toast.present();
    }
}