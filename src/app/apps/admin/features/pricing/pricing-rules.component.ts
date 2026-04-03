import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminService } from '../../services/admin.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { ServiceType } from '../../../../shared/models/booking.model';

@Component({
  selector: 'app-pricing-rules',
  template: `
    <div class="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
      <div class="p-8 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-bold text-gray-900">Pricing Rules</h3>
          <p class="text-sm text-gray-500 mt-1">Configure base rates and per-mile pricing for all services.</p>
        </div>
        <button (click)="addRule()" class="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold text-sm hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20">
          Add Rule
        </button>
      </div>

      <div class="p-8 grid grid-cols-1 md:grid-cols-2 gap-8">
        @for (service of serviceTypes(); track service.id) {
          <div class="bg-gray-50/50 p-6 rounded-3xl border border-gray-100 hover:border-blue-500/20 transition-all group">
            <div class="flex items-center justify-between mb-6">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center text-blue-600">
                  <ion-icon [name]="service.icon" class="text-2xl"></ion-icon>
                </div>
                <div>
                  <h4 class="text-lg font-bold text-gray-900">{{ service.name }}</h4>
                  <p class="text-xs text-gray-400 uppercase tracking-widest font-bold">Service Type ID: {{ service.id.slice(0, 8) }}</p>
                </div>
              </div>
              <button (click)="openEditModal(service)" class="p-2 text-gray-400 hover:text-blue-600 transition-all">
                <ion-icon name="create-outline" class="text-xl"></ion-icon>
              </button>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="bg-white p-4 rounded-2xl border border-gray-100">
                <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Base Price</p>
                <div class="flex items-baseline gap-1">
                  <span class="text-sm font-bold text-gray-400">$</span>
                  <span class="text-xl font-bold text-gray-900">{{ service.base_price }}</span>
                </div>
              </div>
              <div class="bg-white p-4 rounded-2xl border border-gray-100">
                <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Price Per KM</p>
                <div class="flex items-baseline gap-1">
                  <span class="text-sm font-bold text-gray-400">$</span>
                  <span class="text-xl font-bold text-gray-900">{{ service.price_per_km }}</span>
                </div>
              </div>
            </div>

            <div class="mt-6 p-4 bg-blue-50/50 rounded-2xl border border-blue-100/50">
              <p class="text-xs font-medium text-blue-600 leading-relaxed">
                <ion-icon name="information-circle" class="mr-1 inline-block align-middle"></ion-icon>
                Estimated price for a 5-km trip: 
                <span class="font-bold">{{ '$' }}{{ service.base_price + (service.price_per_km * 5) }}</span>
              </p>
            </div>
          </div>
        }
      </div>
    </div>

    <!-- Edit Modal -->
    <ion-modal [isOpen]="isModalOpen" (didDismiss)="closeModal()">
      <ng-template>
        <ion-header class="ion-no-border">
          <ion-toolbar class="px-4 py-2">
            <ion-title class="text-lg font-bold">Edit Pricing Rule</ion-title>
            <ion-buttons slot="end">
              <ion-button (click)="closeModal()">Cancel</ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>

        <ion-content class="ion-padding">
          <form [formGroup]="editForm" (ngSubmit)="saveRule()" class="space-y-6">
            <div>
              <label for="base_price" class="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Base Price ($)</label>
              <input id="base_price" type="number" formControlName="base_price" 
                     class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20">
            </div>
            <div>
              <label for="price_per_km" class="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Price Per KM ($)</label>
              <input id="price_per_km" type="number" formControlName="price_per_km" 
                     class="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20">
            </div>

            <div class="pt-4">
              <button type="submit" [disabled]="editForm.invalid || isSaving"
                      class="w-full bg-blue-600 text-white py-4 rounded-2xl font-bold text-sm hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20 disabled:opacity-50">
                {{ isSaving ? 'Saving...' : 'Save Changes' }}
              </button>
            </div>
          </form>
        </ion-content>
      </ng-template>
    </ion-modal>
  `,
  imports: [CommonModule, IonicModule, ReactiveFormsModule]
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
