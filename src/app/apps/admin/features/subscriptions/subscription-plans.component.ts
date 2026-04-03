import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { AdminService } from '../../services/admin.service';

@Component({
  selector: 'app-subscription-plans',
  template: `
    <div class="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
      <div class="p-8 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-bold text-gray-900">Subscription Plans</h3>
          <p class="text-sm text-gray-500 mt-1">Manage driver subscription plans and pricing.</p>
        </div>
        <button class="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold text-sm hover:bg-blue-700 transition-all flex items-center gap-2">
          <ion-icon name="add-outline" class="text-lg"></ion-icon>
          Create Plan
        </button>
      </div>

      <div class="p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        @for (plan of plans(); track plan.id) {
          <div class="border border-gray-100 rounded-3xl p-6 hover:shadow-lg transition-all group">
            <div class="flex items-center justify-between mb-6">
              <div class="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600">
                <ion-icon name="ribbon-outline" class="text-2xl"></ion-icon>
              </div>
              <div class="flex items-center gap-2">
                <button (click)="togglePlan(plan)" class="p-2 text-gray-400 hover:text-blue-600 transition-all">
                  <ion-icon [name]="plan.is_active ? 'eye-outline' : 'eye-off-outline'" class="text-xl"></ion-icon>
                </button>
                <button class="p-2 text-gray-400 hover:text-blue-600 transition-all">
                  <ion-icon name="create-outline" class="text-xl"></ion-icon>
                </button>
              </div>
            </div>

            <h4 class="text-lg font-bold text-gray-900">{{ plan.name }}</h4>
            <p class="text-sm text-gray-500 mt-1 line-clamp-2">{{ plan.description }}</p>

            <div class="mt-6 flex items-baseline gap-1">
              <span class="text-3xl font-black text-gray-900">£{{ plan.price }}</span>
              <span class="text-sm text-gray-400 font-medium">/{{ plan.interval }}</span>
            </div>

            <div class="mt-6 space-y-3">
              @for (feature of plan.features; track feature) {
                <div class="flex items-center gap-2 text-sm text-gray-600">
                  <ion-icon name="checkmark-circle" class="text-emerald-500"></ion-icon>
                  {{ feature }}
                </div>
              }
            </div>

            <div class="mt-8 pt-6 border-t border-gray-50 flex items-center justify-between">
              <span [class]="'px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-widest ' + (plan.is_active ? 'bg-emerald-100 text-emerald-600' : 'bg-gray-100 text-gray-600')">
                {{ plan.is_active ? 'Active' : 'Inactive' }}
              </span>
              <span class="text-xs text-gray-400">ID: {{ plan.id }}</span>
            </div>
          </div>
        }
      </div>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule]
})
export class SubscriptionPlansComponent implements OnInit {
  private adminService = inject(AdminService);
  plans = signal<any[]>([]);

  async ngOnInit() {
    await this.loadPlans();
  }

  async loadPlans() {
    const data = await this.adminService.getSubscriptionPlans();
    this.plans.set(data);
  }

  async togglePlan(plan: any) {
    await this.adminService.updateSubscriptionPlan(plan.id, { is_active: !plan.is_active });
    await this.loadPlans();
  }
}
