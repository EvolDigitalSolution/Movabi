import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ToastController } from '@ionic/angular';
import { FormsModule } from '@angular/forms';
import { addIcons } from 'ionicons';
import { settingsOutline, globeOutline, trashOutline, addCircleOutline } from 'ionicons/icons';
import { SystemConfigService } from '../../../../core/services/config/system-config.service';
import { AppConfigService, CountryConfig } from '../../../../core/services/config/app-config.service';
import { CardComponent, ButtonComponent, InputComponent } from '../../../../shared/ui';

@Component({
  selector: 'app-admin-settings',
  standalone: true,
  imports: [CommonModule, IonicModule, FormsModule, CardComponent, ButtonComponent, InputComponent],
  template: `
    <ion-content class="ion-padding bg-slate-50">
      <div class="max-w-4xl mx-auto space-y-8 pb-12">
        <div class="flex justify-between items-center">
          <div>
            <h1 class="text-3xl font-display font-bold text-slate-900">System Settings</h1>
            <p class="text-slate-500 font-medium">Configure global defaults, countries, and regional settings.</p>
          </div>
          <app-button (clicked)="saveAll()" [disabled]="saving()">
            {{ saving() ? 'Saving...' : 'Save All Changes' }}
          </app-button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <!-- Sidebar Navigation -->
          <div class="md:col-span-1 space-y-2">
            <button (click)="activeTab.set('general')" 
                    [class]="activeTab() === 'general' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'"
                    class="w-full px-6 py-4 rounded-2xl text-left font-bold transition-all shadow-sm flex items-center gap-3">
              <ion-icon name="settings-outline"></ion-icon>
              General Defaults
            </button>
            <button (click)="activeTab.set('countries')" 
                    [class]="activeTab() === 'countries' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'"
                    class="w-full px-6 py-4 rounded-2xl text-left font-bold transition-all shadow-sm flex items-center gap-3">
              <ion-icon name="globe-outline"></ion-icon>
              Countries & Currencies
            </button>
          </div>

          <!-- Main Content -->
          <div class="md:col-span-2 space-y-8">
            @if (activeTab() === 'general') {
              <app-card class="p-8 space-y-6 animate-in fade-in slide-in-from-right-4">
                <h3 class="text-lg font-display font-bold text-slate-900">General Configuration</h3>
                
                <div class="space-y-4">
                  <app-input label="Default Country Code" [(ngModel)]="generalConfig.defaultCountryCode" placeholder="e.g. GB"></app-input>
                  <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">This will be the default for new users and map views.</p>
                </div>

                <div class="pt-4 border-t border-slate-100">
                  <h4 class="text-sm font-bold text-slate-900 mb-4">Map Defaults</h4>
                  <div class="grid grid-cols-2 gap-4">
                    <app-input label="Default Lat" type="number" [(ngModel)]="generalConfig.mapLat"></app-input>
                    <app-input label="Default Lng" type="number" [(ngModel)]="generalConfig.mapLng"></app-input>
                  </div>
                </div>
              </app-card>
            }

            @if (activeTab() === 'countries') {
              <div class="space-y-6 animate-in fade-in slide-in-from-right-4">
                @for (country of countries; track country.code; let i = $index) {
                  <app-card class="p-8 relative group">
                    <button (click)="removeCountry(i)" class="absolute top-6 right-6 text-slate-300 hover:text-rose-500 transition-colors">
                      <ion-icon name="trash-outline" class="text-xl"></ion-icon>
                    </button>

                    <div class="grid grid-cols-2 gap-6">
                      <app-input label="Country Name" [(ngModel)]="country.name"></app-input>
                      <app-input label="ISO Code" [(ngModel)]="country.code"></app-input>
                      <app-input label="Currency" [(ngModel)]="country.currency"></app-input>
                      <app-input label="Symbol" [(ngModel)]="country.currencySymbol"></app-input>
                      <app-input label="Locale" [(ngModel)]="country.locale"></app-input>
                      <app-input label="Phone Code" [(ngModel)]="country.phoneCode"></app-input>
                    </div>

                    <div class="mt-6 pt-6 border-t border-slate-100">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Default Map Center</p>
                      <div class="grid grid-cols-2 gap-4">
                        <app-input label="Lat" type="number" [(ngModel)]="country.defaultCenter.lat"></app-input>
                        <app-input label="Lng" type="number" [(ngModel)]="country.defaultCenter.lng"></app-input>
                      </div>
                    </div>
                  </app-card>
                }

                <button (click)="addCountry()" class="w-full py-6 border-2 border-dashed border-slate-200 rounded-3xl text-slate-400 font-bold hover:border-blue-400 hover:text-blue-600 transition-all flex items-center justify-center gap-2">
                  <ion-icon name="add-circle-outline" class="text-2xl"></ion-icon>
                  Add New Country
                </button>
              </div>
            }
          </div>
        </div>
      </div>
    </ion-content>
  `
})
export class AdminSettingsComponent implements OnInit {
  private systemConfig = inject(SystemConfigService);
  private appConfig = inject(AppConfigService);
  private toastCtrl = inject(ToastController);

  activeTab = signal('general');
  saving = signal(false);

  constructor() {
    addIcons({ settingsOutline, globeOutline, trashOutline, addCircleOutline });
  }

  generalConfig = {
    defaultCountryCode: 'GB',
    mapLat: 51.5074,
    mapLng: -0.1278
  };

  countries: CountryConfig[] = [];

  async ngOnInit() {
    await this.systemConfig.loadConfigs();
    this.countries = JSON.parse(JSON.stringify(this.appConfig.countries()));
    this.generalConfig.defaultCountryCode = this.systemConfig.getConfig('default_country_code', 'GB');
    
    const country = this.countries.find(c => c.code === this.generalConfig.defaultCountryCode);
    if (country) {
      this.generalConfig.mapLat = country.defaultCenter.lat;
      this.generalConfig.mapLng = country.defaultCenter.lng;
    }
  }

  addCountry() {
    this.countries.push({
      code: '',
      name: '',
      currency: '',
      currencySymbol: '',
      locale: '',
      phoneCode: '',
      defaultCenter: { lat: 0, lng: 0 }
    });
  }

  removeCountry(index: number) {
    this.countries.splice(index, 1);
  }

  async saveAll() {
    this.saving.set(true);
    try {
      await this.systemConfig.setConfig('countries', this.countries);
      await this.systemConfig.setConfig('default_country_code', this.generalConfig.defaultCountryCode);
      
      const toast = await this.toastCtrl.create({
        message: 'Settings saved successfully!',
        duration: 2000,
        color: 'success'
      });
      await toast.present();
      
      // Refresh app config
      await this.appConfig.refreshConfigs();
    } catch (error) {
      console.error('Error saving settings:', error);
      const toast = await this.toastCtrl.create({
        message: 'Failed to save settings.',
        duration: 2000,
        color: 'danger'
      });
      await toast.present();
    } finally {
      this.saving.set(false);
    }
  }
}
