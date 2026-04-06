import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminService } from '../../services/admin.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { ServiceType } from '../../../../shared/models/booking.model';

import { ButtonComponent } from '../../../../shared/ui/button';

@Component({
  selector: 'app-pricing-rules',
  template: `
    <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
      <div class="p-10 border-b border-slate-50 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 class="text-2xl font-display font-bold text-slate-900">Pricing Rules</h3>
          <p class="text-slate-500 font-medium mt-1">Configure base rates and per-mile pricing for all services.</p>
        </div>
        <app-button (click)="addRule()" variant="primary" size="md" [fullWidth]="false" class="px-8 h-12 rounded-2xl">
          <ion-icon name="add-outline" slot="start" class="mr-2"></ion-icon>
          Add Rule
        </app-button>
      </div>

      <div class="p-10 grid grid-cols-1 md:grid-cols-2 gap-8">
        @for (service of serviceTypes(); track service.id) {
          <div class="bg-slate-50/50 p-8 rounded-[2rem] border border-slate-100 hover:border-blue-500/20 hover:shadow-xl hover:shadow-slate-200/40 transition-all group relative">
            <div class="flex items-center justify-between mb-8">
              <div class="flex items-center gap-5">
                <div class="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100 shadow-sm">
                  <ion-icon [name]="service.icon" class="text-2xl"></ion-icon>
                </div>
                <div>
                  <h4 class="text-lg font-bold text-slate-900">{{ service.name }}</h4>
                  <p class="text-[10px] text-slate-400 uppercase tracking-[0.2em] font-bold mt-1">ID: {{ service.id.slice(0, 8) }}</p>
                </div>
              </div>
              <button (click)="openEditModal(service)" class="w-10 h-10 rounded-xl bg-white text-slate-400 hover:bg-blue-600 hover:text-white hover:shadow-lg hover:shadow-blue-600/20 transition-all flex items-center justify-center border border-slate-100">
                <ion-icon name="create-outline" class="text-xl"></ion-icon>
              </button>
            </div>

            <div class="grid grid-cols-2 gap-6">
              <div class="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-2">Base Price</p>
                <div class="flex items-baseline gap-1">
                  <span class="text-sm font-bold text-slate-400">$</span>
                  <span class="text-2xl font-display font-bold text-slate-900">{{ service.base_price }}</span>
                </div>
              </div>
              <div class="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-2">Price Per KM</p>
                <div class="flex items-baseline gap-1">
                  <span class="text-sm font-bold text-slate-400">$</span>
                  <span class="text-2xl font-display font-bold text-slate-900">{{ service.price_per_km }}</span>
                </div>
              </div>
            </div>

            <div class="mt-8 p-5 bg-blue-50/50 rounded-2xl border border-blue-100/50 flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600">
                <ion-icon name="calculator-outline" class="text-lg"></ion-icon>
              </div>
              <p class="text-xs font-medium text-blue-700 leading-relaxed">
                Estimated price for a 5-km trip: 
                <span class="font-bold text-blue-900 ml-1">{{ '$' }}{{ service.base_price + (service.price_per_km * 5) }}</span>
              </p>
            </div>
          </div>
        }
      </div>
    </div>

    <!-- Edit Modal -->
    <ion-modal [isOpen]="isModalOpen" (didDismiss)="closeModal()" class="admin-modal">
      <ng-template>
        <div class="flex flex-col h-full bg-white">
          <div class="p-8 border-b border-slate-50 flex items-center justify-between">
            <div>
              <h3 class="text-xl font-display font-bold text-slate-900">Edit Pricing Rule</h3>
              <p class="text-sm text-slate-500 font-medium mt-1">{{ selectedService?.name }}</p>
            </div>
            <button (click)="closeModal()" class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100 transition-all flex items-center justify-center">
              <ion-icon name="close-outline" class="text-2xl"></ion-icon>
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-8">
            <form [formGroup]="editForm" (ngSubmit)="saveRule()" class="space-y-8">
              <div class="space-y-6">
                <div class="group">
                  <label for="base_price" class="block text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-3 group-focus-within:text-blue-600 transition-colors">Base Price ($)</label>
                  <div class="relative">
                    <span class="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                    <input id="base_price" type="number" formControlName="base_price" 
                           class="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-10 pr-5 py-4 text-sm font-bold text-slate-900 focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50 transition-all">
                  </div>
                </div>
                
                <div class="group">
                  <label for="price_per_km" class="block text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-3 group-focus-within:text-blue-600 transition-colors">Price Per KM ($)</label>
                  <div class="relative">
                    <span class="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                    <input id="price_per_km" type="number" formControlName="price_per_km" 
                           class="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-10 pr-5 py-4 text-sm font-bold text-slate-900 focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50 transition-all">
                  </div>
                </div>
              </div>

              <div class="pt-4">
                <app-button type="submit" [disabled]="editForm.invalid || isSaving" variant="primary" size="lg" [fullWidth]="true" class="h-14 rounded-2xl">
                  {{ isSaving ? 'Saving Changes...' : 'Save Changes' }}
                </app-button>
              </div>
            </form>
          </div>
        </div>
      </ng-template>
    </ion-modal>
  `,
  imports: [CommonModule, IonicModule, ReactiveFormsModule, ButtonComponent]
})
export class PricingRulesComponent implements OnInit {
  private adminService = inject(AdminService);
  private fb = inject(FormBuilder);

  serviceTypes = signal<ServiceType[]>([]);
  isModalOpen = false;
  isSaving = false;
  selectedService: ServiceType | null = null;

  editForm: FormGroup = this.fb.group({
    base_price: [0, [Validators.required, Validators.min(0)]],
    price_per_km: [0, [Validators.required, Validators.min(0)]]
  });

  async ngOnInit() {
    await this.loadServiceTypes();
  }

  async loadServiceTypes() {
    const data = await this.adminService.getServiceTypes();
    this.serviceTypes.set(data);
  }

  addRule() {
    console.log('Add rule clicked');
    // Implement add rule modal/logic
  }

  openEditModal(service: ServiceType) {
    this.selectedService = service;
    this.editForm.patchValue({
      base_price: service.base_price,
      price_per_km: service.price_per_km
    });
    this.isModalOpen = true;
  }

  closeModal() {
    this.isModalOpen = false;
    this.selectedService = null;
    this.isSaving = false;
  }

  async saveRule() {
    if (this.editForm.invalid || !this.selectedService) return;

    this.isSaving = true;
    try {
      await this.adminService.updateServiceType(this.selectedService.id, this.editForm.value);
      await this.loadServiceTypes();
      this.closeModal();
    } catch (error) {
      console.error('Error saving rule:', error);
      this.isSaving = false;
    }
  }
}
