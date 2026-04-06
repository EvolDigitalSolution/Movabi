import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { AdminService } from '../../services/admin.service';

import { BadgeComponent } from '../../../../shared/ui/badge';
import { ButtonComponent } from '../../../../shared/ui/button';

interface SubscriptionPlan {
  id: string;
  name: string;
  description: string;
  price: number;
  interval: string;
  features: string[];
  is_active: boolean;
}

@Component({
  selector: 'app-subscription-plans',
  template: `
    <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
      <div class="p-10 border-b border-slate-50 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 class="text-2xl font-display font-bold text-slate-900">Subscription Plans</h3>
          <p class="text-slate-500 font-medium mt-1">Manage driver subscription plans and pricing.</p>
        </div>
        <app-button variant="primary" size="md" [fullWidth]="false" class="px-8 h-12 rounded-2xl">
          <ion-icon name="add-outline" slot="start" class="mr-2"></ion-icon>
          Create Plan
        </app-button>
      </div>

      <div class="p-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        @for (plan of plans(); track plan.id) {
          <div class="bg-slate-50/50 p-8 rounded-[2rem] border border-slate-100 hover:border-blue-500/20 hover:shadow-xl hover:shadow-slate-200/40 transition-all group relative">
            <div class="flex items-center justify-between mb-8">
              <div class="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100 shadow-sm">
                <ion-icon name="ribbon-outline" class="text-2xl"></ion-icon>
              </div>
              <div class="flex items-center gap-2">
                <button (click)="togglePlan(plan)" class="w-10 h-10 rounded-xl bg-white text-slate-400 hover:bg-blue-600 hover:text-white hover:shadow-lg hover:shadow-blue-600/20 transition-all flex items-center justify-center border border-slate-100">
                  <ion-icon [name]="plan.is_active ? 'eye-outline' : 'eye-off-outline'" class="text-xl"></ion-icon>
                </button>
                <button class="w-10 h-10 rounded-xl bg-white text-slate-400 hover:bg-blue-600 hover:text-white hover:shadow-lg hover:shadow-blue-600/20 transition-all flex items-center justify-center border border-slate-100">
                  <ion-icon name="create-outline" class="text-xl"></ion-icon>
                </button>
              </div>
            </div>

            <h4 class="text-xl font-bold text-slate-900">{{ plan.name }}</h4>
            <p class="text-sm text-slate-500 mt-2 font-medium line-clamp-2">{{ plan.description }}</p>

            <div class="mt-8 flex items-baseline gap-1">
              <span class="text-4xl font-display font-black text-slate-900">£{{ plan.price }}</span>
              <span class="text-sm text-slate-400 font-bold uppercase tracking-widest">/{{ plan.interval }}</span>
            </div>

            <div class="mt-8 space-y-4">
              @for (feature of plan.features; track feature) {
                <div class="flex items-center gap-3 text-sm font-medium text-slate-600">
                  <div class="w-5 h-5 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-500 border border-emerald-100">
                    <ion-icon name="checkmark" class="text-xs"></ion-icon>
                  </div>
                  {{ feature }}
                </div>
              }
            </div>

            <div class="mt-10 pt-8 border-t border-slate-100 flex items-center justify-between">
              <app-badge [variant]="plan.is_active ? 'success' : 'secondary'">
                {{ plan.is_active ? 'Active' : 'Inactive' }}
              </app-badge>
              <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">ID: {{ plan.id.slice(0, 8) }}</span>
            </div>
          </div>
        }
      </div>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, BadgeComponent, ButtonComponent]
})
export class SubscriptionPlansComponent implements OnInit {
  private adminService = inject(AdminService);
  plans = signal<SubscriptionPlan[]>([]);

  async ngOnInit() {
    await this.loadPlans();
  }

  async loadPlans() {
    const data = await this.adminService.getSubscriptionPlans();
    this.plans.set(data);
  }

  async togglePlan(plan: SubscriptionPlan) {
    await this.adminService.updateSubscriptionPlan(plan.id, { is_active: !plan.is_active });
    await this.loadPlans();
  }
}
