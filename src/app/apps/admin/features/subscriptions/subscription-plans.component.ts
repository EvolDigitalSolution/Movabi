import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ToastController, AlertController } from '@ionic/angular';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminService } from '../../services/admin.service';

import { BadgeComponent } from '../../../../shared/ui/badge';
import { ButtonComponent } from '../../../../shared/ui/button';

interface SubscriptionPlan {
    id: string;
    name: string;
    plan_code?: string | null;
    description: string;
    price: number;
    interval: string;
    features: string[] | string;
    is_active: boolean;
    country_code?: string | null;
    currency_code?: string | null;
    currency_symbol?: string | null;
    stripe_price_id?: string | null;
    created_at?: string;
    updated_at?: string;
}

@Component({
    selector: 'app-subscription-plans',
    standalone: true,
    imports: [CommonModule, IonicModule, ReactiveFormsModule, BadgeComponent, ButtonComponent],
    template: `
    <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden">
      <div class="p-8 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 class="text-xl font-display font-bold text-slate-900">Subscription Plans</h3>
          <p class="text-sm text-slate-500 font-medium mt-1">Manage driver subscription plans and pricing.</p>
        </div>

        <button
          type="button"
          (click)="createPlan()"
          class="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 transition"
        >
          <ion-icon name="add-outline"></ion-icon>
          Create Plan
        </button>
      </div>

      <div class="p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        @for (plan of plans(); track plan.id) {
          <div class="bg-slate-50/50 p-6 rounded-[1.5rem] border border-slate-100 hover:border-blue-500/20 hover:shadow-lg transition-all">
            <div class="flex items-center justify-between mb-6">
              <div class="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100 shadow-sm">
                <ion-icon name="ribbon-outline" class="text-xl"></ion-icon>
              </div>

              <div class="flex items-center gap-2">
                <button
                  type="button"
                  (click)="togglePlan(plan)"
                  class="w-10 h-10 rounded-xl bg-white text-slate-400 hover:bg-blue-600 hover:text-white transition-all flex items-center justify-center border border-slate-100"
                  title="Toggle Active"
                >
                  <ion-icon [name]="plan.is_active ? 'eye-outline' : 'eye-off-outline'" class="text-lg"></ion-icon>
                </button>

                <button
                  type="button"
                  (click)="editPlan(plan)"
                  class="w-10 h-10 rounded-xl bg-white text-slate-400 hover:bg-blue-600 hover:text-white transition-all flex items-center justify-center border border-slate-100"
                  title="Edit Plan"
                >
                  <ion-icon name="create-outline" class="text-lg"></ion-icon>
                </button>

                <button
                  type="button"
                  (click)="deletePlan(plan)"
                  class="w-10 h-10 rounded-xl bg-white text-slate-400 hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center border border-slate-100"
                  title="Delete Plan"
                >
                  <ion-icon name="trash-outline" class="text-lg"></ion-icon>
                </button>
              </div>
            </div>

            <h4 class="text-lg font-bold text-slate-900">{{ plan.name }}</h4>
            <p class="text-sm text-slate-500 mt-2 font-medium line-clamp-2">{{ plan.description || 'No description' }}</p>

            <div class="mt-6 flex items-baseline gap-1">
              <span class="text-3xl font-display font-black text-slate-900">
                {{ getCurrencySymbol(plan) }}{{ toMoney(plan.price) }}
              </span>
              <span class="text-xs text-slate-400 font-bold uppercase tracking-widest">/{{ plan.interval || 'month' }}</span>
            </div>

            <p class="mt-2 text-xs text-slate-400 font-semibold">
              {{ plan.country_code || 'GB' }} · {{ plan.currency_code || currencyFromCountry(plan.country_code) }}
            </p>

            <div class="mt-6 space-y-3">
              @for (feature of getFeatures(plan); track feature) {
                <div class="flex items-center gap-3 text-sm font-medium text-slate-600">
                  <div class="w-5 h-5 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-500 border border-emerald-100">
                    <ion-icon name="checkmark" class="text-xs"></ion-icon>
                  </div>
                  {{ feature }}
                </div>
              }

              @if (getFeatures(plan).length === 0) {
                <p class="text-sm text-slate-400 font-medium">No features listed.</p>
              }
            </div>

            <div class="mt-8 pt-6 border-t border-slate-100 flex items-center justify-between">
              <app-badge [variant]="plan.is_active ? 'success' : 'secondary'">
                {{ plan.is_active ? 'Active' : 'Inactive' }}
              </app-badge>

              <span class="text-[11px] text-slate-400 font-medium">ID: {{ shortId(plan.id) }}</span>
            </div>
          </div>
        }

        @if (plans().length === 0) {
          <div class="col-span-full px-10 py-20 text-center">
            <div class="w-20 h-20 rounded-[2rem] bg-slate-50 flex items-center justify-center text-slate-300 mx-auto mb-6 border border-slate-100">
              <ion-icon name="card-outline" class="text-4xl"></ion-icon>
            </div>
            <h4 class="text-lg font-bold text-slate-900">No plans found</h4>
            <p class="text-slate-500 font-medium mt-1">Create your first driver subscription plan.</p>
          </div>
        }
      </div>
    </div>

    <ion-modal [isOpen]="isModalOpen()" (didDismiss)="closeModal()" class="admin-modal">
      <ng-template>
        <div class="flex flex-col h-full bg-white">
          <div class="p-8 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 class="text-xl font-display font-bold text-slate-900">
                {{ isEditMode() ? 'Edit Plan' : 'Create Plan' }}
              </h3>
              <p class="text-sm text-slate-500 font-medium mt-1">
                {{ selectedPlan()?.name || 'Add a new subscription plan' }}
              </p>
            </div>

            <button
              type="button"
              (click)="closeModal()"
              class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100 transition-all flex items-center justify-center"
            >
              <ion-icon name="close-outline" class="text-xl"></ion-icon>
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-8">
            <form [formGroup]="planForm" (ngSubmit)="savePlan()" class="space-y-6">
              <div class="grid md:grid-cols-2 gap-5">
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Plan Name</label>
                  <input
                    type="text"
                    formControlName="name"
                    placeholder="e.g. Pro"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                </div>

                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Plan Code</label>
                  <input
                    type="text"
                    formControlName="plan_code"
                    placeholder="e.g. starter"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                </div>
              </div>

              <div class="grid md:grid-cols-2 gap-5">
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Billing Interval</label>
                  <select
                    formControlName="interval"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                    <option value="month">Monthly</option>
                    <option value="year">Yearly</option>
                    <option value="week">Weekly</option>
                    <option value="day">Daily</option>
                  </select>
                </div>

                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Country</label>
                  <select
                    formControlName="country_code"
                    (change)="onCountryCodeChange()"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                    <option value="GB">GB - United Kingdom</option>
                    <option value="US">US - United States</option>
                    <option value="NG">NG - Nigeria</option>
                    <option value="CA">CA - Canada</option>
                    <option value="AU">AU - Australia</option>
                    <option value="EU">EU - Europe</option>
                  </select>
                </div>
              </div>

              <div>
                <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Description</label>
                <textarea
                  rows="3"
                  formControlName="description"
                  placeholder="Describe the plan..."
                  class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none resize-none"
                ></textarea>
              </div>

              <div class="grid md:grid-cols-3 gap-5">
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Price</label>
                  <div class="relative">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">
                      {{ planForm.get('currency_symbol')?.value || symbolFromCode(planForm.get('currency_code')?.value) }}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      formControlName="price"
                      class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                    >
                  </div>
                </div>

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
                    maxlength="4"
                    formControlName="currency_symbol"
                    class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none"
                  >
                </div>
              </div>

              <div>
                <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Features</label>
                <textarea
                  rows="5"
                  formControlName="featuresText"
                  placeholder="One feature per line"
                  class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-semibold text-slate-900 focus:outline-none resize-none"
                ></textarea>
                <p class="text-xs text-slate-400 mt-2">Enter one feature per line.</p>
              </div>

              <div class="grid md:grid-cols-2 gap-5">
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Stripe Price ID</label>
                  <input
                    type="text"
                    formControlName="stripe_price_id"
                    placeholder="Required, e.g. price_manual_starter"
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
                <button
                  type="submit"
                  [disabled]="planForm.invalid || isSaving()"
                  class="w-full h-12 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {{ isSaving() ? 'Saving...' : (isEditMode() ? 'Save Changes' : 'Create Plan') }}
                </button>
              </div>
            </form>
          </div>
        </div>
      </ng-template>
    </ion-modal>
  `
})
export class SubscriptionPlansComponent implements OnInit {
    private adminService = inject(AdminService);
    private fb = inject(FormBuilder);
    private toastCtrl = inject(ToastController);
    private alertCtrl = inject(AlertController);

    plans = signal<SubscriptionPlan[]>([]);
    isModalOpen = signal(false);
    isSaving = signal(false);
    selectedPlan = signal<SubscriptionPlan | null>(null);

    planForm: FormGroup = this.fb.group({
        name: ['', Validators.required],
        plan_code: ['', Validators.required],
        description: [''],
        price: [0, [Validators.required, Validators.min(0)]],
        interval: ['month', Validators.required],
        featuresText: [''],
        country_code: ['GB', Validators.required],
        currency_code: ['GBP', Validators.required],
        currency_symbol: ['£', Validators.required],
        stripe_price_id: ['', Validators.required],
        is_active: [true]
    });

    async ngOnInit() {
        await this.loadPlans();

        this.planForm.get('currency_code')?.valueChanges.subscribe(() => {
            this.onCurrencyCodeChange();
        });

        this.planForm.get('country_code')?.valueChanges.subscribe(() => {
            this.onCountryCodeChange();
        });
    }

    async loadPlans() {
        try {
            const data = await this.adminService.getSubscriptionPlans();
            this.plans.set(Array.isArray(data) ? data as SubscriptionPlan[] : []);
        } catch (error: unknown) {
            await this.showToast(error instanceof Error ? error.message : 'Failed to load plans.', 'danger');
        }
    }

    createPlan() {
        this.selectedPlan.set(null);

        this.planForm.reset({
            name: '',
            plan_code: '',
            description: '',
            price: 0,
            interval: 'month',
            featuresText: '',
            country_code: 'GB',
            currency_code: 'GBP',
            currency_symbol: '£',
            stripe_price_id: 'price_manual_' + Date.now(),
            is_active: true
        });

        this.isModalOpen.set(true);
    }

    editPlan(plan: SubscriptionPlan) {
        this.selectedPlan.set(plan);

        const countryCode = plan.country_code || 'GB';
        const currencyCode = plan.currency_code || this.currencyFromCountry(countryCode);

        this.planForm.reset({
            name: plan.name || '',
            plan_code: plan.plan_code || '',
            description: plan.description || '',
            price: Number(plan.price || 0),
            interval: plan.interval || 'month',
            featuresText: this.getFeatures(plan).join('\n'),
            country_code: countryCode,
            currency_code: currencyCode,
            currency_symbol: plan.currency_symbol || this.symbolFromCode(currencyCode),
            stripe_price_id: plan.stripe_price_id || '',
            is_active: plan.is_active ?? true
        });

        this.isModalOpen.set(true);
    }

    closeModal() {
        this.isModalOpen.set(false);
        this.selectedPlan.set(null);
        this.isSaving.set(false);
    }

    isEditMode(): boolean {
        return !!this.selectedPlan()?.id;
    }

    async savePlan() {
        if (this.planForm.invalid) {
            this.planForm.markAllAsTouched();
            return;
        }

        const planName = String(this.planForm.value.name || '').trim();
        const planCode = String(this.planForm.value.plan_code || '').trim().toLowerCase();
        const price = Number(this.planForm.value.price || 0);

        const payload: any = {
            name: planName,
            display_name: planName,
            plan_code: planCode,
            description: String(this.planForm.value.description || '').trim(),
            price,
            amount: price,
            interval: String(this.planForm.value.interval || 'month').trim(),
            features: this.featuresFromText(this.planForm.value.featuresText),
            country_code: String(this.planForm.value.country_code || 'GB').trim().toUpperCase(),
            currency_code: String(this.planForm.value.currency_code || 'GBP').trim().toUpperCase(),
            currency_symbol: String(this.planForm.value.currency_symbol || this.symbolFromCode(this.planForm.value.currency_code)).trim(),
            stripe_price_id: String(this.planForm.value.stripe_price_id || '').trim(),
            is_active: this.planForm.value.is_active === true
        };

        this.isSaving.set(true);

        try {
            if (this.isEditMode()) {
                await this.adminService.updateSubscriptionPlan(this.selectedPlan()!.id, payload);
                await this.showToast('Plan updated.', 'success');
            } else {
                await this.adminService.createSubscriptionPlan(payload);
                await this.showToast('Plan created.', 'success');
            }

            await this.loadPlans();
            this.closeModal();
        } catch (error: unknown) {
            console.error('[SubscriptionPlans] save failed:', error);
            await this.showToast(error instanceof Error ? error.message : 'Failed to save plan.', 'danger');
            this.isSaving.set(false);
        }
    }

    async togglePlan(plan: SubscriptionPlan) {
        try {
            await this.adminService.updateSubscriptionPlan(plan.id, { is_active: !plan.is_active });
            await this.loadPlans();
            await this.showToast(plan.is_active ? 'Plan deactivated.' : 'Plan activated.', 'success');
        } catch (error: unknown) {
            await this.showToast(error instanceof Error ? error.message : 'Failed to update plan.', 'danger');
        }
    }

    async deletePlan(plan: SubscriptionPlan) {
        const alert = await this.alertCtrl.create({
            header: 'Delete Plan',
            message: `Delete "${plan.name}"? This cannot be undone.`,
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Delete',
                    role: 'destructive',
                    handler: async () => {
                        try {
                            await this.adminService.deleteSubscriptionPlan(plan.id);
                            await this.loadPlans();
                            await this.showToast('Plan deleted.', 'success');
                        } catch (error: unknown) {
                            await this.showToast(error instanceof Error ? error.message : 'Failed to delete plan.', 'danger');
                        }
                    }
                }
            ]
        });

        await alert.present();
    }

    onCountryCodeChange() {
        const countryCode = String(this.planForm.get('country_code')?.value || 'GB').toUpperCase();
        const currencyCode = this.currencyFromCountry(countryCode);
        const currencySymbol = this.symbolFromCode(currencyCode);

        this.planForm.patchValue(
            {
                currency_code: currencyCode,
                currency_symbol: currencySymbol
            },
            { emitEvent: false }
        );
    }

    onCurrencyCodeChange() {
        const code = String(this.planForm.get('currency_code')?.value || 'GBP').toUpperCase();
        const symbol = this.symbolFromCode(code);

        this.planForm.patchValue(
            { currency_symbol: symbol },
            { emitEvent: false }
        );
    }

    currencyFromCountry(countryCode?: string | null): string {
        const map: Record<string, string> = {
            GB: 'GBP',
            US: 'USD',
            NG: 'NGN',
            CA: 'CAD',
            AU: 'AUD',
            EU: 'EUR'
        };

        return map[String(countryCode || 'GB').toUpperCase()] || 'GBP';
    }

    getCurrencySymbol(plan: SubscriptionPlan): string {
        return plan.currency_symbol || this.symbolFromCode(plan.currency_code || this.currencyFromCountry(plan.country_code));
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

        return map[String(code || 'GBP').toUpperCase()] || '£';
    }

    getFeatures(plan: SubscriptionPlan): string[] {
        const features: unknown = (plan as any).features;

        if (Array.isArray(features)) {
            return features.map((f: unknown) => String(f).trim()).filter(Boolean);
        }

        if (typeof features === 'string') {
            try {
                const parsed: unknown = JSON.parse(features);

                if (Array.isArray(parsed)) {
                    return parsed.map((f: unknown) => String(f).trim()).filter(Boolean);
                }
            } catch {
                return features
                    .split('\n')
                    .map((f: string) => f.trim())
                    .filter(Boolean);
            }

            return features
                .split('\n')
                .map((f: string) => f.trim())
                .filter(Boolean);
        }

        return [];
    }

    featuresFromText(value: unknown): string[] {
        return String(value || '')
            .split('\n')
            .map(feature => feature.trim())
            .filter(Boolean);
    }

    toMoney(value: unknown): string {
        return Number(value || 0).toFixed(2);
    }

    shortId(id: string | undefined | null): string {
        return (id || '').slice(0, 8).toUpperCase() || 'UNKNOWN';
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