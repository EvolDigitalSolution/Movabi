import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminPricingRule, AdminService } from '../../services/admin.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { ButtonComponent } from '../../../../shared/ui/button';

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
                    {{ getCurrencyCode(service) }} · {{ service.is_active === false ? 'Inactive' : 'Active' }}
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
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Price / KM</p>
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
                5-km estimate:
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
        <div class="bg-white rounded-[2rem] shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-hidden">
        <div class="flex flex-col h-full bg-white">
          <div class="p-8 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 class="text-xl font-display font-bold text-slate-900">
                {{ isEditMode() ? 'Edit Pricing Rule' : 'Add Pricing Rule' }}
              </h3>
              <p class="text-sm text-slate-500 font-medium mt-1">
                {{ selectedService()?.name || 'Create a new service pricing rule' }}
              </p>
            </div>

            <button
              (click)="closeModal()"
              class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100 transition-all flex items-center justify-center"
            >
              <ion-icon name="close-outline" class="text-xl"></ion-icon>
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-8">
            <form [formGroup]="editForm" (ngSubmit)="saveRule()" class="space-y-6">
              <div class="grid md:grid-cols-2 gap-5">
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Service Name</label>
                  <input
                    type="text"
                    formControlName="name"
                    placeholder="e.g. Van Moving"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                </div>

                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Slug</label>
                  <input
                    type="text"
                    formControlName="slug"
                    placeholder="e.g. van-moving"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                </div>
              </div>

              <div>
                <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Description</label>
                <input
                  type="text"
                  formControlName="description"
                  placeholder="e.g. Moving services"
                  class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                >
              </div>

              <div class="grid md:grid-cols-2 gap-5">
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Base Price</label>
                  <div class="relative">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">
                      {{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      formControlName="base_price"
                      class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                    >
                  </div>
                </div>

                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Price Per KM</label>
                  <div class="relative">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">
                      {{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      formControlName="price_per_km"
                      class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                    >
                  </div>
                </div>
              </div>

              <div class="grid md:grid-cols-3 gap-5">
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Per Minute</label>
                  <div class="relative">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">
                      {{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      formControlName="per_min"
                      class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                    >
                  </div>
                </div>

                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Service Fee</label>
                  <div class="relative">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">
                      {{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      formControlName="service_fee"
                      class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                    >
                  </div>
                </div>

                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Minimum Fare</label>
                  <div class="relative">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">
                      {{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      formControlName="minimum_fare"
                      class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                    >
                  </div>
                </div>
              </div>

              <div class="pt-4 border-t border-slate-100">
                <h4 class="text-sm font-bold text-slate-900 mb-4">Shop / Errand Settings</h4>
                <div class="grid md:grid-cols-3 gap-5">
                  <div>
                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Free Included Items</label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      formControlName="free_included_items"
                      class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                    >
                  </div>

                  <div>
                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Extra Item Fee</label>
                    <div class="relative">
                      <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">
                        {{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        formControlName="extra_item_fee"
                        class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                      >
                    </div>
                  </div>

                  <div>
                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Large Shop Surcharge</label>
                    <div class="relative">
                      <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">
                        {{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        formControlName="large_shopping_surcharge"
                        class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                      >
                    </div>
                  </div>

                  <div>
                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Large Shop Threshold</label>
                    <div class="relative">
                      <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">
                        {{ editForm.value.currency_symbol || symbolFromCode(editForm.value.currency_code) }}
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        formControlName="large_shopping_threshold"
                        class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                      >
                    </div>
                  </div>

                  <div>
                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Peak Multiplier</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      formControlName="peak_multiplier"
                      class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                    >
                  </div>

                  <div>
                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Weather Multiplier</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      formControlName="weather_multiplier"
                      class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                    >
                  </div>
                </div>
              </div>

              <div class="grid md:grid-cols-2 gap-5">
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Currency Code</label>
                  <select
                    formControlName="currency_code"
                    (change)="onCurrencyCodeChange()"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
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
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Currency Symbol</label>
                  <input
                    type="text"
                    formControlName="currency_symbol"
                    placeholder="£"
                    maxlength="4"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                </div>
              </div>

              <div class="grid md:grid-cols-2 gap-5">
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Icon</label>
                  <input
                    type="text"
                    formControlName="icon"
                    placeholder="e.g. car"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                </div>

                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Status</label>
                  <select
                    formControlName="is_active"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                    <option [ngValue]="true">Active</option>
                    <option [ngValue]="false">Inactive</option>
                  </select>
                </div>
              </div>

              <div class="pt-4">
                <app-button
                  type="submit"
                  [disabled]="editForm.invalid || isSaving()"
                  variant="primary"
                  size="lg"
                  [fullWidth]="true"
                  class="h-14 rounded-xl"
                >
                  {{ isSaving() ? 'Saving...' : (isEditMode() ? 'Save Changes' : 'Create Rule') }}
                </app-button>
              </div>
            </form>
          </div>
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
  `]
})
export class PricingRulesComponent implements OnInit {
    private adminService = inject(AdminService);
    private fb = inject(FormBuilder);

    serviceTypes = signal<PricingServiceType[]>([]);
    isModalOpen = signal(false);
    isSaving = signal(false);
    selectedService = signal<PricingServiceType | null>(null);

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
        currency_code: ['GBP', Validators.required],
        currency_symbol: ['£', Validators.required],
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
        this.editForm.reset({
            name: '',
            slug: '',
            description: '',
            icon: 'cube',
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
            currency_code: 'GBP',
            currency_symbol: '£',
            is_active: true
        });
        this.isModalOpen.set(true);
    }

    openEditModal(service: PricingServiceType) {
        this.selectedService.set(service);

        const currencyCode = service.currency_code || 'GBP';

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
            currency_code: currencyCode,
            currency_symbol: service.currency_symbol || this.symbolFromCode(currencyCode),
            is_active: service.is_active ?? true
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

        const payload = {
            name: String(this.editForm.value.name || '').trim(),
            slug: String(this.editForm.value.slug || '').trim(),
            description: String(this.editForm.value.description || '').trim(),
            icon: String(this.editForm.value.icon || 'cube').trim(),
            base_price: Number(this.editForm.value.base_price || 0),
            price_per_km: Number(this.editForm.value.price_per_km || 0),
            per_min: Number(this.editForm.value.per_min || 0),
            service_fee: Number(this.editForm.value.service_fee || 0),
            minimum_fare: Number(this.editForm.value.minimum_fare || 0),
            currency_code: String(this.editForm.value.currency_code || 'GBP').trim().toUpperCase(),
            currency_symbol: String(this.editForm.value.currency_symbol || this.symbolFromCode(this.editForm.value.currency_code)).trim(),
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
                await this.adminService.deleteServiceType(service.id);
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


    private async showToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
        this.toastType.set(color);
        this.toastMessage.set(message);

        window.setTimeout(() => {
            this.toastMessage.set(null);
        }, 2500);
    }

}
