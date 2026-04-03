import { Component, inject } from '@angular/core';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'app-admin-layout',
  template: `
    <ion-split-pane contentId="main-content" when="lg">
      <ion-menu contentId="main-content" type="overlay" class="admin-sidebar">
        <ion-content class="ion-no-padding">
          <div class="flex flex-col h-full bg-gray-900 text-gray-400">
            <!-- Sidebar Header -->
            <div class="p-8 border-b border-gray-800 flex items-center gap-4">
              <div class="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20">
                <ion-icon name="shield-checkmark" class="text-2xl"></ion-icon>
              </div>
              <div>
                <h2 class="text-xl font-bold text-white tracking-tight">MoveMate</h2>
                <p class="text-xs font-bold text-blue-500 uppercase tracking-widest">Admin Panel</p>
              </div>
            </div>

            <!-- Navigation -->
            <nav class="flex-1 p-6 space-y-2 overflow-y-auto">
              @for (item of navItems; track item.path) {
                <a [routerLink]="item.path" routerLinkActive="active" 
                   class="flex items-center gap-4 px-4 py-3 rounded-2xl transition-all hover:bg-gray-800 hover:text-white group">
                  <ion-icon [name]="item.icon" class="text-xl group-hover:scale-110 transition-transform"></ion-icon>
                  <span class="font-bold text-sm tracking-wide">{{ item.label }}</span>
                </a>
              }
            </nav>

            <!-- Sidebar Footer -->
            <div class="p-6 border-t border-gray-800">
              <div class="bg-gray-800/50 p-4 rounded-2xl flex items-center gap-3 mb-4">
                <div class="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold text-xs">
                  {{ auth.currentUser()?.email?.[0]?.toUpperCase() || 'A' }}
                </div>
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-bold text-white truncate">{{ auth.currentUser()?.email }}</h4>
                  <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest">System Administrator</p>
                </div>
              </div>
              <button (click)="auth.signOut()" 
                      class="w-full flex items-center justify-center gap-3 py-3 rounded-2xl bg-red-600/10 text-red-500 font-bold text-sm hover:bg-red-600 hover:text-white transition-all">
                <ion-icon name="log-out-outline" class="text-xl"></ion-icon>
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </ion-content>
      </ion-menu>

      <div class="ion-page" id="main-content">
        <ion-header class="ion-no-border">
          <ion-toolbar class="px-4 py-2 bg-gray-50">
            <ion-buttons slot="start">
              <ion-menu-button class="text-gray-900"></ion-menu-button>
            </ion-buttons>
            <ion-title class="text-lg font-bold text-gray-900">Admin Control Center</ion-title>
          </ion-toolbar>
        </ion-header>

        <ion-content class="ion-padding bg-gray-50">
          <div class="max-w-7xl mx-auto py-8">
            <router-outlet></router-outlet>
          </div>
        </ion-content>
      </div>
    </ion-split-pane>
  `,
  styles: [`
    .active {
      background-color: #2563eb !important;
      color: white !important;
      box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.2);
    }
    ion-menu::part(container) {
      width: 320px;
    }
    .admin-sidebar {
      display: block;
      height: 100vh;
    }
  `],
  imports: [CommonModule, IonicModule, RouterModule]
})
export class AdminLayoutComponent {
  public auth = inject(AuthService);

  navItems = [
    { label: 'Dashboard', path: '/admin/dashboard', icon: 'grid-outline' },
    { label: 'Users', path: '/admin/users', icon: 'people-outline' },
    { label: 'Drivers', path: '/admin/drivers', icon: 'car-outline' },
    { label: 'Bookings', path: '/admin/bookings', icon: 'calendar-outline' },
    { label: 'Pricing', path: '/admin/pricing', icon: 'cash-outline' },
    { label: 'Plans', path: '/admin/subscriptions', icon: 'card-outline' },
    { label: 'Active Subs', path: '/admin/active-subscriptions', icon: 'shield-checkmark-outline' },
    { label: 'Driver Subs', path: '/admin/driver-subscriptions', icon: 'people-circle-outline' },
    { label: 'Van Jobs', path: '/admin/van-jobs', icon: 'bus-outline' },
  ];
}
