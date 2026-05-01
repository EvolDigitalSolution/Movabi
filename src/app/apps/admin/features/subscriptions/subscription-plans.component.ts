import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
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
}

@Component({
  selector: 'app-subscription-plans',
  standalone: true,
  imports: [CommonModule, IonicModule, ReactiveFormsModule, BadgeComponent, ButtonComponent],
  template: `
  <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl overflow-hidden">

    <div class="p-8 border-b border-slate-100 flex items-center justify-between">
      <div>
        <h3 class="text-xl font-bold text-slate-900">Subscription Plans</h3>
        <p class="text-sm text-slate-500 mt-1">Manage driver plans and pricing</p>
      </div>

      <button
        type="button"
        (click)="createPlan()"
        class="h-11 px-5 rounded-xl bg-blue-600 text-white font-bold"
      >
        Create Plan
      </button>
    </div>

    <div class="p-8 grid md:grid-cols-2 xl:grid-cols-3 gap-6">

      @for(plan of plans(); track plan.id) {
        <div class="rounded-3xl border border-slate-100 bg-slate-50/50 p-6">

          <div class="flex items-center justify-between">
            <h4 class="font-bold text-slate-900 text-lg">{{ plan.name }}</h4>

            <app-badge [variant]="plan.is_active ? 'success':'secondary'">
              {{ plan.is_active ? 'Active' : 'Inactive' }}
            </app-badge>
          </div>

          <p class="text-sm text-slate-500 mt-2">
            {{ plan.description || 'No description' }}
          </p>

          <div class="mt-5 text-3xl font-black text-slate-900">
            {{ getCurrencySymbol(plan) }}{{ toMoney(plan.price) }}
            <span class="text-xs text-slate-400">/{{ plan.interval }}</span>
          </div>

          <div class="mt-4 space-y-2">
            @for(feature of getFeatures(plan); track feature) {
              <div class="text-sm text-slate-600">• {{ feature }}</div>
            }
          </div>

          <div class="mt-6 flex gap-2">
            <button
              type="button"
              (click)="togglePlan(plan)"
              class="flex-1 h-10 rounded-xl bg-slate-100 font-bold"
            >
              {{ plan.is_active ? 'Disable' : 'Enable' }}
            </button>

            <button
              type="button"
              (click)="editPlan(plan)"
              class="flex-1 h-10 rounded-xl bg-blue-600 text-white font-bold"
            >
              Edit
            </button>

            <button
              type="button"
              (click)="askDelete(plan)"
              class="w-10 rounded-xl bg-rose-50 text-rose-600"
            >
              <ion-icon name="trash-outline"></ion-icon>
            </button>
          </div>

        </div>
      }

    </div>
  </div>


  @if(isModalOpen()) {
    <div class="fixed inset-0 z-[9999] bg-slate-900/50 flex items-center justify-center p-4">

      <div class="bg-white rounded-[2rem] shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-hidden">

        <div class="p-6 border-b border-slate-100 flex items-center justify-between">
          <h3 class="text-xl font-bold text-slate-900">
            {{ isEditMode() ? 'Edit Plan' : 'Create Plan' }}
          </h3>

          <button
            type="button"
            (click)="closeModal()"
            class="w-10 h-10 rounded-xl bg-slate-100"
          >
            <ion-icon name="close-outline"></ion-icon>
          </button>
        </div>

        <div class="p-6 overflow-y-auto max-h-[75vh]">

          <form [formGroup]="planForm" (ngSubmit)="savePlan()" class="space-y-5">

            <input formControlName="name" placeholder="Plan Name" class="input" />
            <input formControlName="plan_code" placeholder="Plan Code" class="input" />
            <textarea formControlName="description" rows="3" placeholder="Description" class="input"></textarea>

            <div class="grid md:grid-cols-3 gap-4">
              <input type="number" formControlName="price" placeholder="Price" class="input" />

              <select formControlName="interval" class="input">
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
                <option value="week">Weekly</option>
              </select>

              <select formControlName="country_code" (change)="onCountryCodeChange()" class="input">
                <option value="GB">GB</option>
                <option value="US">US</option>
                <option value="NG">NG</option>
              </select>
            </div>

            <div class="grid md:grid-cols-2 gap-4">
              <select formControlName="currency_code" (change)="onCurrencyCodeChange()" class="input">
                <option value="GBP">GBP</option>
                <option value="USD">USD</option>
                <option value="NGN">NGN</option>
                <option value="EUR">EUR</option>
              </select>

              <input formControlName="currency_symbol" class="input" />
            </div>

            <textarea
              rows="5"
              formControlName="featuresText"
              placeholder="One feature per line"
              class="input"
            ></textarea>

            <input formControlName="stripe_price_id" class="input" />

            <select formControlName="is_active" class="input">
              <option [ngValue]="true">Active</option>
              <option [ngValue]="false">Inactive</option>
            </select>

            <button
              type="submit"
              [disabled]="planForm.invalid || isSaving()"
              class="w-full h-12 rounded-xl bg-blue-600 text-white font-bold"
            >
              {{ isSaving() ? 'Saving...' : 'Save Plan' }}
            </button>

          </form>

        </div>
      </div>
    </div>
  }


  @if(confirmDelete()) {
    <div class="fixed inset-0 z-[10000] bg-slate-900/50 flex items-center justify-center p-4">
      <div class="bg-white rounded-3xl shadow-xl w-full max-w-md p-6">

        <h3 class="text-lg font-bold text-slate-900">Delete Plan</h3>
        <p class="text-sm text-slate-500 mt-2">
          Delete "{{ confirmDelete()?.name }}"?
        </p>

        <div class="mt-6 flex gap-3">
          <button
            type="button"
            (click)="confirmDelete.set(null)"
            class="flex-1 h-11 rounded-xl bg-slate-100 font-bold"
          >
            Cancel
          </button>

          <button
            type="button"
            (click)="deletePlanNow()"
            class="flex-1 h-11 rounded-xl bg-rose-600 text-white font-bold"
          >
            Delete
          </button>
        </div>

      </div>
    </div>
  }


  @if(showToast()) {
    <div class="fixed top-5 right-5 z-[11000]">
      <div
        class="px-5 py-3 rounded-2xl shadow-xl text-white font-semibold"
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
    .input{
      width:100%;
      border:1px solid rgb(226 232 240);
      background:rgb(248 250 252);
      border-radius:1rem;
      padding:.9rem 1rem;
      font-size:.9rem;
      font-weight:600;
      outline:none;
    }
  `]
})
export class SubscriptionPlansComponent implements OnInit {

  private adminService = inject(AdminService);
  private fb = inject(FormBuilder);

  plans = signal<SubscriptionPlan[]>([]);
  isModalOpen = signal(false);
  isSaving = signal(false);
  selectedPlan = signal<SubscriptionPlan | null>(null);

  confirmDelete = signal<SubscriptionPlan | null>(null);

  toastMessage = signal('');
  toastColor = signal<'success'|'danger'|'warning'>('success');
  showToast = signal(false);

  planForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    plan_code: ['', Validators.required],
    description: [''],
    price: [0, Validators.required],
    interval: ['month'],
    featuresText: [''],
    country_code: ['GB'],
    currency_code: ['GBP'],
    currency_symbol: ['£'],
    stripe_price_id: ['price_manual_default'],
    is_active: [true]
  });

  async ngOnInit() {
    await this.loadPlans();
  }

  async loadPlans() {
    try {
      const data = await this.adminService.getSubscriptionPlans();
      this.plans.set(Array.isArray(data) ? data : []);
    } catch {
      this.triggerToast('Failed to load plans', 'danger');
    }
  }

  triggerToast(message:string,color:'success'|'danger'|'warning'='success'){
    this.toastMessage.set(message);
    this.toastColor.set(color);
    this.showToast.set(true);
    setTimeout(()=>this.showToast.set(false),2500);
  }

  createPlan() {
    this.selectedPlan.set(null);

    this.planForm.reset({
      name:'',
      plan_code:'',
      description:'',
      price:0,
      interval:'month',
      featuresText:'',
      country_code:'GB',
      currency_code:'GBP',
      currency_symbol:'£',
      stripe_price_id:'price_manual_' + Date.now(),
      is_active:true
    });

    this.isModalOpen.set(true);
  }

  editPlan(plan: SubscriptionPlan) {
    this.selectedPlan.set(plan);

    this.planForm.patchValue({
      ...plan,
      featuresText: this.getFeatures(plan).join('\n')
    });

    this.isModalOpen.set(true);
  }

  closeModal() {
    this.isModalOpen.set(false);
    this.selectedPlan.set(null);
  }

  isEditMode(): boolean {
    return !!this.selectedPlan();
  }

  async savePlan() {
    if (this.planForm.invalid) return;

    this.isSaving.set(true);

    const val = this.planForm.value;

    const payload:any = {
      ...val,
      display_name: val.name,
      amount: Number(val.price || 0),
      features: this.featuresFromText(val.featuresText)
    };

    try {
      if (this.isEditMode()) {
        await this.adminService.updateSubscriptionPlan(this.selectedPlan()!.id, payload);
        this.triggerToast('Plan updated');
      } else {
        await this.adminService.createSubscriptionPlan(payload);
        this.triggerToast('Plan created');
      }

      await this.loadPlans();
      this.closeModal();

    } catch {
      this.triggerToast('Failed to save plan','danger');
    }

    this.isSaving.set(false);
  }

  async togglePlan(plan: SubscriptionPlan) {
    try {
      await this.adminService.updateSubscriptionPlan(plan.id, {
        is_active: !plan.is_active
      });

      await this.loadPlans();
      this.triggerToast('Plan updated');

    } catch {
      this.triggerToast('Failed to update','danger');
    }
  }

  askDelete(plan: SubscriptionPlan) {
    this.confirmDelete.set(plan);
  }

  async deletePlanNow() {
    const plan = this.confirmDelete();
    if (!plan) return;

    try {
      await this.adminService.deleteSubscriptionPlan(plan.id);
      this.confirmDelete.set(null);
      await this.loadPlans();
      this.triggerToast('Plan deleted');
    } catch {
      this.triggerToast('Delete failed','danger');
    }
  }

  onCountryCodeChange() {
    const code = String(this.planForm.value.country_code || 'GB');
    const cur = this.currencyFromCountry(code);

    this.planForm.patchValue({
      currency_code: cur,
      currency_symbol: this.symbolFromCode(cur)
    });
  }

  onCurrencyCodeChange() {
    const code = String(this.planForm.value.currency_code || 'GBP');

    this.planForm.patchValue({
      currency_symbol: this.symbolFromCode(code)
    });
  }

  currencyFromCountry(code?:string):string{
    const map:any = { GB:'GBP', US:'USD', NG:'NGN', EU:'EUR' };
    return map[String(code || 'GB').toUpperCase()] || 'GBP';
  }

  symbolFromCode(code?:string):string{
    const map:any = { GBP:'£', USD:'$', EUR:'€', NGN:'₦' };
    return map[String(code || 'GBP').toUpperCase()] || '£';
  }

  getCurrencySymbol(plan: SubscriptionPlan): string {
    return plan.currency_symbol || this.symbolFromCode(plan.currency_code || 'GBP');
  }

  getFeatures(plan: SubscriptionPlan): string[] {
    const f:any = plan.features;

    if (Array.isArray(f)) return f;

    return String(f || '')
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean);
  }

  featuresFromText(value:any): string[] {
    return String(value || '')
      .split('\n')
      .map((x:string)=>x.trim())
      .filter(Boolean);
  }

  toMoney(value:any): string {
    return Number(value || 0).toFixed(2);
  }
}
