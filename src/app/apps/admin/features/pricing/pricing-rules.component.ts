import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminPricingRule, AdminService } from '../../services/admin.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { ButtonComponent } from '../../../../shared/ui/button';
import { AppConfigService, CountryConfig } from '../../../../core/services/config/app-config.service';

type PricingServiceType = AdminPricingRule & {
    price_per_km?: number | string | null;
    currency_code?: string | null;
    currency_symbol?: string | null;
    is_active?: boolean | null;
    per_min?: number | string | null;
    service_fee?: number | string | null;
    minimum_fare?: number | string | null;
    free_included_items?: number | string | null;
    extra_item_fee?: number | string | null;
    large_shopping_surcharge?: number | string | null;
    large_shopping_threshold?: number | string | null;
    peak_multiplier?: number | string | null;
    weather_multiplier?: number | string | null;
};

type PricingSection = 'general' | 'pricing' | 'shop' | 'waiting' | 'dynamic' | 'preview';

const PRICING_SERVICES = [
    { name: 'Ride', slug: 'ride', icon: 'car' },
    { name: 'Errand', slug: 'errand', icon: 'basket' },
    { name: 'Delivery', slug: 'delivery', icon: 'cube' },
    { name: 'Van Moving', slug: 'van-moving', icon: 'bus' }
] as const;

@Component({
    selector: 'app-pricing-rules',
    standalone: true,
    imports: [CommonModule, IonicModule, ReactiveFormsModule, ButtonComponent],
    template: `
    <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden">
      <div class="p-8 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 class="text-xl font-display font-bold text-slate-900">Pricing Rules</h3>
          <p class="text-sm text-slate-500 font-medium mt-1">Configure base rates, distance pricing and currency for services.</p>
        </div>

        <app-button (clicked)="addRule()" variant="primary" size="md" [fullWidth]="false" class="px-6 h-11 rounded-xl">
          <ion-icon name="add-outline" slot="start" class="mr-2"></ion-icon>
          Add Rule
        </app-button>
      </div>

      <div class="p-8 grid grid-cols-1 md:grid-cols-2 gap-6">
        @for (service of serviceTypes(); track service.id) {
          <div class="bg-slate-50/50 p-6 rounded-[1.5rem] border border-slate-100 hover:border-blue-500/20 hover:shadow-lg transition-all">
            <div class="flex items-center justify-between mb-6">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100 shadow-sm">
                  <ion-icon [name]="getIconName(service)" class="text-xl"></ion-icon>
                </div>

                <div>
                  <h4 class="text-base font-bold text-slate-900">{{ service.name }}</h4>
                  <p class="text-[11px] text-slate-400 font-medium mt-1">ID: {{ shortId(service.id) }}</p>
                  <p class="text-[11px] text-slate-500 font-medium mt-0.5">
                    {{ service.country_code || 'GB' }} · {{ service.market_city || 'Country-wide' }} · {{ service.zone_id || 'Default' }} · {{ getCurrencyCode(service) }} · {{ service.is_active === false ? 'Inactive' : 'Active' }}
                  </p>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <button
                  (click)="openEditModal(service)"
                  class="w-10 h-10 rounded-xl bg-white text-slate-400 hover:bg-blue-600 hover:text-white transition-all flex items-center justify-center border border-slate-100"
                  title="Edit"
                >
                  <ion-icon name="create-outline" class="text-lg"></ion-icon>
                </button>

                <button
                  (click)="deleteRule(service)"
                  class="w-10 h-10 rounded-xl bg-white text-slate-400 hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center border border-slate-100"
                  title="Delete"
                >
                  <ion-icon name="trash-outline" class="text-lg"></ion-icon>
                </button>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Base Price</p>
                <div class="flex items-baseline gap-1">
                  <span class="text-xs font-bold text-slate-400">{{ getCurrencySymbol(service) }}</span>
                  <span class="text-xl font-display font-bold text-slate-900">{{ toMoney(service.base_price) }}</span>
                </div>
              </div>

              <div class="bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Price / {{ service.distance_unit || 'km' }}</p>
                <div class="flex items-baseline gap-1">
                  <span class="text-xs font-bold text-slate-400">{{ getCurrencySymbol(service) }}</span>
                  <span class="text-xl font-display font-bold text-slate-900">{{ toMoney(service.price_per_km) }}</span>
                </div>
              </div>

              <div class="bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Minimum</p>
                <div class="flex items-baseline gap-1">
                  <span class="text-xs font-bold text-slate-400">{{ getCurrencySymbol(service) }}</span>
                  <span class="text-xl font-display font-bold text-slate-900">{{ toMoney(service.minimum_fare) }}</span>
                </div>
              </div>

              <div class="bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Service Fee</p>
                <div class="flex items-baseline gap-1">
                  <span class="text-xs font-bold text-slate-400">{{ getCurrencySymbol(service) }}</span>
                  <span class="text-xl font-display font-bold text-slate-900">{{ toMoney(service.service_fee) }}</span>
                </div>
              </div>
            </div>

            <div class="mt-5 p-4 bg-blue-50/60 rounded-xl border border-blue-100/60 flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600">
                <ion-icon name="calculator-outline" class="text-base"></ion-icon>
              </div>

              <p class="text-xs font-medium text-blue-700 leading-relaxed">
                5 km / 12-minute estimate:
                <span class="font-bold text-blue-900 ml-1">
                  {{ getCurrencySymbol(service) }}{{ estimate(service) }}
                </span>
              </p>
            </div>
          </div>
        }

        @if (serviceTypes().length === 0) {
          <div class="col-span-full p-10 text-center text-slate-400 font-semibold">
            No pricing rules found.
          </div>
        }
      </div>
    </div>

    @if (isModalOpen()) {
      <div class="fixed inset-0 z-[9999] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-[2rem] shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden">
        <div class="flex max-h-[90vh] flex-col bg-white">
          <div class="sticky top-0 z-10 bg-white p-6 md:p-8 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 class="text-xl font-display font-bold text-slate-900">
                {{ isEditMode() ? 'Edit Pricing Rule' : 'Add Pricing Rule' }}
              </h3>
              <p class="text-sm text-slate-500 font-medium mt-1">
                {{ selectedCountry()?.name || 'Country' }} · {{ selectedServiceName() || 'Service pricing' }}
              </p>
            </div>

            <button
              type="button"
              (click)="closeModal()"
              class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100 transition-all flex items-center justify-center"
              aria-label="Close pricing dialog"
            >
              <ion-icon name="close-outline" class="text-xl"></ion-icon>
            </button>
          </div>

          <form [formGroup]="editForm" (ngSubmit)="saveRule()" class="flex min-h-0 flex-1 flex-col">
          <div class="flex-1 overflow-y-auto p-5 md:p-8">
            <div class="space-y-4">
              <section class="pricing-section">
                <button type="button" class="section-toggle" (click)="toggleSection('general')">
                  <span>General</span>
                  <ion-icon [name]="isSectionOpen('general') ? 'chevron-up-outline' : 'chevron-down-outline'"></ion-icon>
                </button>

                @if (isSectionOpen('general')) {
                  <div class="section-body">
                    <div class="grid md:grid-cols-2 gap-5">
                      <div>
                        <label class="field-label">Select country *</label>
                        <select formControlName="country_code" [attr.disabled]="isEditMode() ? true : null" (change)="onCountryChange()" class="field-control">
                          @for (country of countries(); track country.code) {
                            <option [value]="country.code">{{ flagFor(country.code) }} {{ country.name }} ({{ country.currency }})</option>
                          }
                        </select>
                        @if (isEditMode()) {
                          <p class="text-[11px] font-semibold text-slate-500 mt-2">Country is locked while editing. Create a new rule for another country.</p>
                        }
                      </div>

                      <div>
                        <label class="field-label">Service *</label>
                        <select formControlName="slug" (change)="onServiceChange()" class="field-control">
                          @for (service of pricingServices; track service.slug) {
                            <option [value]="service.slug">{{ service.name }}</option>
                          }
                        </select>
                      </div>
                    </div>

                    <div class="grid md:grid-cols-5 gap-5">
                      <div>
                        <label class="field-label">ISO code</label>
                        <input formControlName="country_code" readonly class="field-control read-only">
                      </div>
                      <div>
                        <label class="field-label">Currency</label>
                        <input formControlName="currency_code" readonly class="field-control read-only">
                      </div>
                      <div>
                        <label class="field-label">Symbol</label>
                        <input formControlName="currency_symbol" readonly class="field-control read-only">
                      </div>
                      <div>
                        <label class="field-label">Locale</label>
                        <input formControlName="locale" readonly class="field-control read-only">
                      </div>
                      <div>
                        <label class="field-label">Distance unit</label>
                        <input formControlName="distance_unit" readonly class="field-control read-only">
                      </div>
                    </div>

                    <div class="grid md:grid-cols-2 gap-5">
                      <div>
                        <label class="field-label">Market / City</label>
                        <input formControlName="market_city" placeholder="Country-wide pricing" class="field-control">
                      </div>
                      <div>
                        <label class="field-label">Zone</label>
                        <input formControlName="zone_id" placeholder="Default zone" class="field-control">
                      </div>
                    </div>

                    <div>
                      <label class="field-label">Description</label>
                      <input type="text" formControlName="description" placeholder="e.g. London airport ride pricing" class="field-control">
                    </div>

                    <div class="grid md:grid-cols-2 gap-5">
                      <div>
                        <label class="field-label">Icon</label>
                        <input type="text" formControlName="icon" placeholder="e.g. car" class="field-control">
                      </div>
                      <div>
                        <label class="field-label">Status</label>
                        <select formControlName="is_active" class="field-control">
                          <option [ngValue]="true">Active</option>
                          <option [ngValue]="false">Inactive</option>
                        </select>
                      </div>
                    </div>
                  </div>
                }
              </section>

              <section class="pricing-section">
                <button type="button" class="section-toggle" (click)="toggleSection('pricing')">
                  <span>Pricing</span>
                  <ion-icon [name]="isSectionOpen('pricing') ? 'chevron-up-outline' : 'chevron-down-outline'"></ion-icon>
                </button>

                @if (isSectionOpen('pricing')) {
                  <div class="section-body">
                    <div class="grid md:grid-cols-3 gap-5">
                      <div><label class="field-label">Base Fare</label><div class="relative"><span class="money-prefix">{{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}</span><input type="number" step="0.01" min="0" formControlName="base_price" class="field-control pl-10"></div></div>
                      <div><label class="field-label">Price per km</label><div class="relative"><span class="money-prefix">{{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}</span><input type="number" step="0.01" min="0" formControlName="price_per_km" class="field-control pl-10"></div></div>
                      <div><label class="field-label">Price per minute</label><div class="relative"><span class="money-prefix">{{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}</span><input type="number" step="0.01" min="0" formControlName="per_min" class="field-control pl-10"></div></div>
                      <div><label class="field-label">Minimum Fare</label><div class="relative"><span class="money-prefix">{{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}</span><input type="number" step="0.01" min="0" formControlName="minimum_fare" class="field-control pl-10"></div></div>
                      <div><label class="field-label">Service Fee</label><div class="relative"><span class="money-prefix">{{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}</span><input type="number" step="0.01" min="0" formControlName="service_fee" class="field-control pl-10"></div></div>
                    </div>
                  </div>
                }
              </section>

              <section class="pricing-section">
                <button type="button" class="section-toggle" (click)="toggleSection('shop')">
                  <span>Shop</span>
                  <ion-icon [name]="isSectionOpen('shop') ? 'chevron-up-outline' : 'chevron-down-outline'"></ion-icon>
                </button>

                @if (isSectionOpen('shop')) {
                  <div class="section-body">
                    <div class="grid md:grid-cols-4 gap-5">
                      <div><label class="field-label">Free Included Items</label><input type="number" min="0" step="1" formControlName="free_included_items" class="field-control"></div>
                      <div><label class="field-label">Extra Item Fee</label><div class="relative"><span class="money-prefix">{{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}</span><input type="number" step="0.01" min="0" formControlName="extra_item_fee" class="field-control pl-10"></div></div>
                      <div><label class="field-label">Large Shop Surcharge</label><div class="relative"><span class="money-prefix">{{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}</span><input type="number" step="0.01" min="0" formControlName="large_shopping_surcharge" class="field-control pl-10"></div></div>
                      <div><label class="field-label">Large Shop Threshold</label><div class="relative"><span class="money-prefix">{{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}</span><input type="number" step="0.01" min="0" formControlName="large_shopping_threshold" class="field-control pl-10"></div></div>
                    </div>
                  </div>
                }
              </section>

              <section class="pricing-section">
                <button type="button" class="section-toggle" (click)="toggleSection('waiting')">
                  <span>Waiting</span>
                  <ion-icon [name]="isSectionOpen('waiting') ? 'chevron-up-outline' : 'chevron-down-outline'"></ion-icon>
                </button>
                @if (isSectionOpen('waiting')) {
                  <div class="section-body">
                    <p class="text-sm font-semibold text-slate-500">Waiting rules are configured in Marketplace settings. This pricing rule keeps the country, market, zone and service anchor for those settings.</p>
                  </div>
                }
              </section>

              <section class="pricing-section">
                <button type="button" class="section-toggle" (click)="toggleSection('dynamic')">
                  <span>Dynamic</span>
                  <ion-icon [name]="isSectionOpen('dynamic') ? 'chevron-up-outline' : 'chevron-down-outline'"></ion-icon>
                </button>

                @if (isSectionOpen('dynamic')) {
                  <div class="section-body">
                    <div class="grid md:grid-cols-2 gap-5">
                      <div><label class="field-label">Peak Multiplier</label><input type="number" step="0.1" min="0" formControlName="peak_multiplier" class="field-control"></div>
                      <div><label class="field-label">Weather Multiplier</label><input type="number" step="0.1" min="0" formControlName="weather_multiplier" class="field-control"></div>
                    </div>
                  </div>
                }
              </section>

              <section class="pricing-section">
                <button type="button" class="section-toggle" (click)="toggleSection('preview')">
                  <span>Preview</span>
                  <ion-icon [name]="isSectionOpen('preview') ? 'chevron-up-outline' : 'chevron-down-outline'"></ion-icon>
                </button>

                @if (isSectionOpen('preview')) {
                  <div class="section-body">
                    <div class="rounded-2xl border border-orange-100 bg-orange-50/60 p-5">
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p class="text-xs font-black uppercase tracking-widest text-orange-700">{{ selectedCountry()?.name || 'Country' }}</p>
                          <p class="text-sm font-bold text-slate-700">{{ editForm.value.currency_code }} · Example estimate · 5 {{ editForm.value.distance_unit || 'km' }} · 10 min</p>
                        </div>
                        <div class="text-right">
                          <p class="text-xs font-bold uppercase tracking-widest text-slate-500">Total</p>
                          <p class="text-3xl font-black text-slate-950">{{ previewTotal() }}</p>
                        </div>
                      </div>
                      <div class="mt-5 grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
                        <div class="preview-row"><span>Base</span><strong>{{ money(editForm.value.base_price) }}</strong></div>
                        <div class="preview-row"><span>Distance</span><strong>{{ previewDistanceCharge() }}</strong></div>
                        <div class="preview-row"><span>Time</span><strong>{{ previewTimeCharge() }}</strong></div>
                        <div class="preview-row"><span>Service fee</span><strong>{{ money(editForm.value.service_fee) }}</strong></div>
                        <div class="preview-row"><span>Minimum</span><strong>{{ money(editForm.value.minimum_fare) }}</strong></div>
                      </div>
                    </div>
                  </div>
                }
              </section>

              @if (duplicateWarning()) {
                <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-800">
                  {{ duplicateWarning() }}
                </div>
              }
            </div>
          </div>

          <div class="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-slate-100 bg-white p-5 md:p-6">
            <button type="button" class="modal-cancel" (click)="closeModal()">Cancel</button>
            <app-button
              type="submit"
              [disabled]="editForm.invalid || isSaving() || !!duplicateWarning()"
              variant="primary"
              size="md"
              [fullWidth]="false"
              class="h-12 rounded-xl"
            >
              {{ isSaving() ? 'Saving...' : 'Save' }}
            </app-button>
          </div>
          </form>
          </div>
        </div>
      </div>
    }

    @if (confirmModal()) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6">
          <h3 class="text-xl font-bold text-slate-900">{{ confirmModal()?.title }}</h3>
          <p class="text-sm text-slate-600 mt-4">{{ confirmModal()?.message }}</p>

          <div class="flex justify-end gap-3 mt-6">
            <button type="button" class="modal-cancel" (click)="confirmModal.set(null)">
              {{ confirmModal()?.cancelText || 'Cancel' }}
            </button>
            <button type="button" class="modal-danger" (click)="runConfirmAction()">
              {{ confirmModal()?.confirmText || 'Confirm' }}
            </button>
          </div>
        </div>
      </div>
    }

    @if (toastMessage()) {
      <div class="fixed bottom-6 right-6 z-[11000] rounded-2xl px-5 py-4 shadow-2xl text-white font-semibold"
           [class.bg-emerald-600]="toastType() === 'success'"
           [class.bg-rose-600]="toastType() === 'danger'"
           [class.bg-amber-600]="toastType() === 'warning'">
        {{ toastMessage() }}
      </div>
    }

  `,
    styles: [`
    .modal-danger {
      border-radius: 0.9rem;
      background: rgb(225 29 72);
      color: white;
      font-weight: 800;
      padding: 0.7rem 1rem;
    }

    .modal-cancel {
      border-radius: 0.9rem;
      background: rgb(248 250 252);
      color: rgb(71 85 105);
      font-weight: 800;
      padding: 0.7rem 1rem;
      border: 1px solid rgb(226 232 240);
    }

    .pricing-section {
      overflow: hidden;
      border: 1px solid rgb(226 232 240);
      border-radius: 1rem;
      background: white;
    }

    .section-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 1rem 1.25rem;
      background: rgb(248 250 252);
      color: rgb(51 65 85);
      font-size: 0.75rem;
      font-weight: 900;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .section-body {
      display: grid;
      gap: 1.25rem;
      padding: 1rem;
    }

    .field-label {
      display: block;
      margin-bottom: 0.5rem;
      color: rgb(100 116 139);
      font-size: 0.65rem;
      font-weight: 900;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .field-control {
      width: 100%;
      border: 1px solid rgb(226 232 240);
      border-radius: 0.85rem;
      background: rgb(248 250 252);
      color: rgb(15 23 42);
      font-size: 0.875rem;
      font-weight: 700;
      outline: none;
      padding: 0.78rem 1rem;
    }

    .field-control:focus {
      border-color: rgb(249 115 22);
      box-shadow: 0 0 0 3px rgb(249 115 22 / 0.14);
    }

    .field-control.read-only {
      background: rgb(241 245 249);
      color: rgb(71 85 105);
    }

    .money-prefix {
      position: absolute;
      left: 1rem;
      top: 50%;
      transform: translateY(-50%);
      color: rgb(100 116 139);
      font-size: 0.875rem;
      font-weight: 900;
      pointer-events: none;
    }

    .preview-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      border: 1px solid rgb(254 215 170);
      border-radius: 0.85rem;
      background: white;
      color: rgb(100 116 139);
      font-size: 0.8rem;
      font-weight: 800;
      padding: 0.75rem;
    }

    .preview-row strong {
      color: rgb(15 23 42);
      white-space: nowrap;
    }
  `]
})
export class PricingRulesComponent implements OnInit {
    private adminService = inject(AdminService);
    private fb = inject(FormBuilder);
    private appConfig = inject(AppConfigService);

    serviceTypes = signal<PricingServiceType[]>([]);
    isModalOpen = signal(false);
    isSaving = signal(false);
    selectedService = signal<PricingServiceType | null>(null);
    pricingServices = PRICING_SERVICES;
    countries = this.appConfig.countries;
    openSections = signal<Record<PricingSection, boolean>>({
        general: true,
        pricing: true,
        shop: false,
        waiting: false,
        dynamic: false,
        preview: true
    });

    toastMessage = signal<string | null>(null);
    toastType = signal<'success' | 'danger' | 'warning'>('success');

    confirmModal = signal<{
        title: string;
        message: string;
        confirmText?: string;
        cancelText?: string;
        action?: () => Promise<void>;
    } | null>(null);

    editForm: FormGroup = this.fb.group({
        name: ['', Validators.required],
        slug: ['', Validators.required],
        description: [''],
        icon: ['cube'],
        base_price: [0, [Validators.required, Validators.min(0)]],
        price_per_km: [0, [Validators.required, Validators.min(0)]],
        per_min: [0, [Validators.required, Validators.min(0)]],
        service_fee: [0, [Validators.required, Validators.min(0)]],
        minimum_fare: [0, [Validators.required, Validators.min(0)]],
        free_included_items: [1, [Validators.required, Validators.min(0)]],
        extra_item_fee: [0.75, [Validators.required, Validators.min(0)]],
        large_shopping_surcharge: [0, [Validators.required, Validators.min(0)]],
        large_shopping_threshold: [50, [Validators.required, Validators.min(0)]],
        peak_multiplier: [1, [Validators.required, Validators.min(0)]],
        weather_multiplier: [1, [Validators.required, Validators.min(0)]],
        country_code: ['GB', Validators.required],
        currency_code: ['GBP', Validators.required],
        currency_symbol: ['£', Validators.required],
        locale: ['en-GB'],
        distance_unit: ['km'],
        market_city: [''],
        zone_id: [''],
        is_active: [true]
    });

    async ngOnInit() {
        await this.loadServiceTypes();
    }

    async loadServiceTypes() {
        try {
            const data = await this.adminService.getServiceTypes();
            this.serviceTypes.set(Array.isArray(data) ? data as PricingServiceType[] : []);
        } catch {
            await this.showToast('Failed to load pricing rules.', 'danger');
        }
    }

    addRule() {
        this.selectedService.set(null);
        const service = this.pricingServices[0];
        const country = this.countryByCode('GB');
        this.editForm.reset({
            name: service.name,
            slug: service.slug,
            description: '',
            icon: service.icon,
            base_price: 0,
            price_per_km: 0,
            per_min: 0,
            service_fee: 0,
            minimum_fare: 0,
            free_included_items: 1,
            extra_item_fee: 0.75,
            large_shopping_surcharge: 0,
            large_shopping_threshold: 50,
            peak_multiplier: 1,
            weather_multiplier: 1,
            country_code: country.code,
            currency_code: country.currency,
            currency_symbol: country.currencySymbol,
            locale: country.locale,
            distance_unit: this.distanceUnitFor(country.code),
            market_city: '',
            zone_id: '',
            is_active: true
        });
        this.openSections.set({
            general: true,
            pricing: true,
            shop: false,
            waiting: false,
            dynamic: false,
            preview: true
        });
        this.isModalOpen.set(true);
    }

    openEditModal(service: PricingServiceType) {
        this.selectedService.set(service);

        const countryCode = String((service as any).country_code || 'GB').toUpperCase();
        const country = this.countryByCode(countryCode);
        const currencyCode = service.currency_code || country.currency || 'GBP';

        this.editForm.reset({
            name: service.name || '',
            slug: (service as any).slug || '',
            description: (service as any).description || '',
            icon: service.icon || 'cube',
            base_price: Number(service.base_price || 0),
            price_per_km: Number(service.price_per_km || 0),
            per_min: Number(service.per_min || 0),
            service_fee: Number(service.service_fee || 0),
            minimum_fare: Number(service.minimum_fare || service.base_price || 0),
            free_included_items: Number(service.free_included_items ?? 1),
            extra_item_fee: Number(service.extra_item_fee ?? 0.75),
            large_shopping_surcharge: Number(service.large_shopping_surcharge ?? 0),
            large_shopping_threshold: Number(service.large_shopping_threshold ?? 50),
            peak_multiplier: Number(service.peak_multiplier ?? 1),
            weather_multiplier: Number(service.weather_multiplier ?? 1),
            country_code: countryCode,
            currency_code: currencyCode,
            currency_symbol: service.currency_symbol || country.currencySymbol || this.symbolFromCode(currencyCode),
            locale: (service as any).locale || country.locale,
            distance_unit: (service as any).distance_unit || this.distanceUnitFor(countryCode),
            market_city: (service as any).market_city || '',
            zone_id: (service as any).zone_id || '',
            is_active: service.is_active ?? true
        });
        this.openSections.set({
            general: true,
            pricing: true,
            shop: false,
            waiting: false,
            dynamic: false,
            preview: true
        });

        this.isModalOpen.set(true);
    }

    closeModal() {
        this.isModalOpen.set(false);
        this.selectedService.set(null);
        this.isSaving.set(false);
    }

    isEditMode(): boolean {
        return !!this.selectedService()?.id;
    }

    async saveRule() {
        if (this.editForm.invalid) {
            this.editForm.markAllAsTouched();
            return;
        }

        const duplicate = this.duplicateWarning();
        if (duplicate) {
            await this.showToast(duplicate, 'warning');
            return;
        }

        const service = this.selectedPricingService();

        const payload = {
            name: service?.name || String(this.editForm.value.name || '').trim(),
            slug: String(this.editForm.value.slug || '').trim(),
            description: String(this.editForm.value.description || '').trim(),
            icon: String(this.editForm.value.icon || service?.icon || 'cube').trim(),
            base_price: Number(this.editForm.value.base_price || 0),
            price_per_km: Number(this.editForm.value.price_per_km || 0),
            per_min: Number(this.editForm.value.per_min || 0),
            service_fee: Number(this.editForm.value.service_fee || 0),
            minimum_fare: Number(this.editForm.value.minimum_fare || 0),
            country_code: String(this.editForm.value.country_code || 'GB').trim().toUpperCase(),
            currency_code: String(this.editForm.value.currency_code || 'GBP').trim().toUpperCase(),
            currency_symbol: String(this.editForm.value.currency_symbol || this.symbolFromCode(this.editForm.value.currency_code)).trim(),
            locale: String(this.editForm.value.locale || '').trim(),
            distance_unit: String(this.editForm.value.distance_unit || 'km').trim().toLowerCase(),
            market_city: String(this.editForm.value.market_city || '').trim(),
            zone_id: String(this.editForm.value.zone_id || '').trim(),
            free_included_items: Number(this.editForm.value.free_included_items ?? 1),
            extra_item_fee: Number(this.editForm.value.extra_item_fee ?? 0.75),
            large_shopping_surcharge: Number(this.editForm.value.large_shopping_surcharge ?? 0),
            large_shopping_threshold: Number(this.editForm.value.large_shopping_threshold ?? 50),
            peak_multiplier: Number(this.editForm.value.peak_multiplier ?? 1),
            weather_multiplier: Number(this.editForm.value.weather_multiplier ?? 1),
            is_active: this.editForm.value.is_active === true
        };

        this.isSaving.set(true);

        try {
            if (this.isEditMode()) {
                await this.adminService.updateServiceType(this.selectedService()!.id, payload);
                await this.showToast('Pricing rule updated.', 'success');
            } else {
                await this.adminService.createServiceType(payload);
                await this.showToast('Pricing rule created.', 'success');
            }

            await this.loadServiceTypes();
            this.closeModal();
        } catch (error: unknown) {
            await this.showToast(error instanceof Error ? error.message : 'Failed to save pricing rule.', 'danger');
            this.isSaving.set(false);
        }
    }


    async deleteRule(service: PricingServiceType) {
        this.confirmModal.set({
            title: 'Delete Pricing Rule',
            message: `Delete "${service.name || 'this rule'}"?`,
            confirmText: 'Delete',
            cancelText: 'Cancel',
            action: async () => {
                await this.adminService.deletePricingRule(service as AdminPricingRule);
                await this.showToast('Pricing rule deleted.', 'success');
                await this.loadServiceTypes();
            }
        });
    }

    async runConfirmAction() {
        const current = this.confirmModal();

        if (!current?.action) {
            this.confirmModal.set(null);
            return;
        }

        try {
            await current.action();
            this.confirmModal.set(null);
        } catch (error: unknown) {
            await this.showToast(
                error instanceof Error ? error.message : 'Action failed.',
                'danger'
            );
        }
    }

    onCurrencyCodeChange() {
        const code = String(this.editForm.value.currency_code || 'GBP').toUpperCase();
        this.editForm.patchValue({
            currency_symbol: this.symbolFromCode(code)
        });
    }

    onCountryChange() {
        const country = this.selectedCountry();
        if (!country) return;

        this.editForm.patchValue({
            country_code: country.code,
            currency_code: country.currency,
            currency_symbol: country.currencySymbol,
            locale: country.locale,
            distance_unit: this.distanceUnitFor(country.code)
        });
    }

    onServiceChange() {
        const service = this.selectedPricingService();
        if (!service) return;

        this.editForm.patchValue({
            name: service.name,
            icon: service.icon
        });
    }

    getCurrencyCode(service: PricingServiceType): string {
        return service.currency_code || 'GBP';
    }

    getCurrencySymbol(service: PricingServiceType): string {
        return service.currency_symbol || this.symbolFromCode(service.currency_code) || '£';
    }

    symbolFromCode(code?: string | null): string {
        switch ((code || '').toUpperCase()) {
            case 'GBP': return '£';
            case 'USD': return '$';
            case 'EUR': return '€';
            case 'NGN': return '₦';
            case 'CAD': return '$';
            case 'AUD': return '$';
            default: return '£';
        }
    }

    selectedCountry(): CountryConfig | undefined {
        return this.countryByCode(String(this.editForm.value.country_code || 'GB'));
    }

    selectedPricingService(): typeof PRICING_SERVICES[number] | undefined {
        const slug = String(this.editForm.value.slug || '').trim();
        return this.pricingServices.find(service => service.slug === slug);
    }

    selectedServiceName(): string {
        return this.selectedPricingService()?.name || String(this.editForm.value.name || '').trim();
    }

    toggleSection(section: PricingSection) {
        this.openSections.update(current => ({
            ...current,
            [section]: !current[section]
        }));
    }

    isSectionOpen(section: PricingSection): boolean {
        return this.openSections()[section] === true;
    }

    flagFor(code: string): string {
        const clean = String(code || '').trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(clean)) return '';
        return clean
            .split('')
            .map(char => String.fromCodePoint(127397 + char.charCodeAt(0)))
            .join('');
    }

    distanceUnitFor(countryCode: string): string {
        return String(countryCode || '').toUpperCase() === 'US' ? 'miles' : 'km';
    }

    money(value: unknown): string {
        return `${this.editForm.value.currency_symbol || this.symbolFromCode(this.editForm.value.currency_code)}${Number(value || 0).toFixed(2)}`;
    }

    previewDistanceCharge(): string {
        return this.money(Number(this.editForm.value.price_per_km || 0) * 5);
    }

    previewTimeCharge(): string {
        return this.money(Number(this.editForm.value.per_min || 0) * 10);
    }

    previewTotal(): string {
        const base = Number(this.editForm.value.base_price || 0);
        const distance = Number(this.editForm.value.price_per_km || 0) * 5;
        const time = Number(this.editForm.value.per_min || 0) * 10;
        const fee = Number(this.editForm.value.service_fee || 0);
        const minimum = Number(this.editForm.value.minimum_fare || 0);
        return this.money(Math.max(minimum, base + distance + time + fee));
    }

    duplicateWarning(): string | null {
        const slug = String(this.editForm.value.slug || '').trim();
        const country = String(this.editForm.value.country_code || 'GB').trim().toUpperCase();
        const city = this.normaliseScope(this.editForm.value.market_city);
        const zone = this.normaliseScope(this.editForm.value.zone_id);
        const currentPricingConfigId = String((this.selectedService() as any)?.pricing_config_id || '');

        if (!slug || !country) return null;

        const duplicate = this.serviceTypes().find((row: PricingServiceType) => {
            const rowPricingId = String((row as any).pricing_config_id || '');
            if (currentPricingConfigId && rowPricingId === currentPricingConfigId) return false;
            if (!currentPricingConfigId && this.selectedService()?.id && row.id === this.selectedService()?.id) return false;

            return String((row as any).slug || '').trim() === slug &&
                String((row as any).country_code || 'GB').trim().toUpperCase() === country &&
                this.normaliseScope((row as any).market_city) === city &&
                this.normaliseScope((row as any).zone_id) === zone;
        });

        return duplicate
            ? 'A pricing rule already exists for this country, market, zone and service.'
            : null;
    }

    getIconName(service: PricingServiceType): string {
        const icon = service.icon || 'cube';
        if (icon.endsWith('-outline')) return icon;
        return `${icon}-outline`;
    }

    shortId(id: string | undefined | null): string {
        return (id || '').slice(0, 8).toUpperCase() || 'UNKNOWN';
    }

    toMoney(value: unknown): string {
        return Number(value || 0).toFixed(2);
    }

    estimate(service: PricingServiceType): string {
        const base = Number(service.base_price || 0);
        const perKm = Number(service.price_per_km || 0);
        const perMin = Number(service.per_min || 0);
        const serviceFee = Number(service.service_fee || 0);
        const minimumFare = Number(service.minimum_fare || 0);
        return Math.max(minimumFare, base + perKm * 5 + perMin * 12 + serviceFee).toFixed(2);
    }

    private countryByCode(code: string): CountryConfig {
        const clean = String(code || 'GB').toUpperCase();
        return this.countries().find(country => country.code === clean)
            || this.countries().find(country => country.code === 'GB')
            || {
                code: 'GB',
                name: 'United Kingdom',
                currency: 'GBP',
                currencySymbol: '£',
                locale: 'en-GB',
                phoneCode: '+44',
                defaultCenter: { lat: 51.5074, lng: -0.1278 },
                pricingDefaults: {
                    rideBaseFare: 3.5,
                    errandBaseFare: 5.5,
                    deliveryBaseFare: 2.25,
                    vanBaseFare: 30,
                    perKm: 1,
                    perMinute: 0.2,
                    platformFeePercent: 0
                }
            };
    }

    private normaliseScope(value: unknown): string {
        return String(value || '').trim().toLowerCase();
    }


    private async showToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
        this.toastType.set(color);
        this.toastMessage.set(message);

        window.setTimeout(() => {
            this.toastMessage.set(null);
        }, 2500);
    }

}
