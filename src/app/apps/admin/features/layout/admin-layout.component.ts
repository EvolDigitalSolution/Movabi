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
          <div class="flex flex-col h-full bg-slate-900 text-slate-400">
            <!-- Sidebar Header -->
            <div class="p-10 border-b border-slate-800/50 flex items-center gap-5">
              <div class="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-2xl shadow-blue-600/20">
                <ion-icon name="shield-checkmark" class="text-3xl"></ion-icon>
              </div>
              <div>
                <h2 class="text-2xl font-display font-bold text-white tracking-tighter">Movabi</h2>
                <p class="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Admin Control</p>
              </div>
            </div>

            <!-- Navigation -->
            <nav class="flex-1 p-8 space-y-2 overflow-y-auto custom-scrollbar">
              @for (item of navItems; track item.path) {
                <a [routerLink]="item.path" routerLinkActive="active" 
                   class="flex items-center gap-4 px-5 py-4 rounded-2xl transition-all hover:bg-slate-800 hover:text-white group relative">
                  <div class="w-10 h-10 rounded-xl bg-slate-800/50 flex items-center justify-center group-[.active]:bg-blue-600 group-[.active]:text-white transition-all">
                    <ion-icon [name]="item.icon" class="text-xl group-hover:scale-110 transition-transform"></ion-icon>
                  </div>
                  <span class="font-bold text-sm tracking-wide group-[.active]:text-white">{{ item.label }}</span>
                  <div class="absolute right-4 w-1.5 h-1.5 rounded-full bg-blue-600 opacity-0 group-[.active]:opacity-100 transition-opacity"></div>
                </a>
              }
            </nav>

            <!-- Sidebar Footer -->
            <div class="p-8 border-t border-slate-800/50">
              <div class="bg-slate-800/30 p-5 rounded-3xl flex items-center gap-4 mb-6 border border-slate-700/30">
                <div class="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white font-bold text-sm shadow-inner">
                  {{ auth.currentUser()?.email?.[0]?.toUpperCase() || 'A' }}
                </div>
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-bold text-white truncate">{{ auth.currentUser()?.email }}</h4>
                  <p class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">System Admin</p>
                </div>
              </div>
              <button (click)="auth.signOut()" 
                      class="w-full flex items-center justify-center gap-3 py-4 rounded-2xl bg-red-500/5 text-red-400 font-bold text-sm hover:bg-red-500 hover:text-white transition-all border border-red-500/10 hover:border-red-500 shadow-lg shadow-red-600/0 hover:shadow-red-600/20">
                <ion-icon name="log-out-outline" class="text-xl"></ion-icon>
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </ion-content>
      </ion-menu>

      <div class="ion-page" id="main-content">
        <ion-header class="ion-no-border">
          <ion-toolbar class="px-8 py-5 bg-white/80 backdrop-blur-xl border-b border-slate-100">
            <ion-buttons slot="start">
              <ion-menu-button class="text-slate-900"></ion-menu-button>
            </ion-buttons>
            <div class="flex items-center gap-4">
              <div class="w-1.5 h-8 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <ion-title class="text-xl font-display font-bold text-slate-900 p-0 tracking-tight">Control Center</ion-title>
            </div>
            <ion-buttons slot="end">
              <ion-button class="bg-slate-50 text-slate-600 rounded-2xl h-12 w-12 mr-2">
                <ion-icon name="notifications-outline" slot="icon-only"></ion-icon>
              </ion-button>
              <ion-button class="bg-slate-50 text-slate-600 rounded-2xl h-12 w-12">
                <ion-icon name="settings-outline" slot="icon-only"></ion-icon>
              </ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>

        <ion-content class="ion-padding bg-slate-50">
          <div class="max-w-7xl mx-auto py-10">
            <router-outlet></router-outlet>
          </div>
        </ion-content>
      </div>
    </ion-split-pane>
  `,
  styles: [`
    .active {
      background-color: rgba(255, 255, 255, 0.03) !important;
    }
    ion-menu::part(container) {
      width: 340px;
      border-right: 1px solid rgba(255, 255, 255, 0.05);
    }
    .admin-sidebar {
      display: block;
      height: 100vh;
    }
    .custom-scrollbar::-webkit-scrollbar {
      width: 4px;
    }
    .custom-scrollbar::-webkit-scrollbar-track {
      background: transparent;
    }
    .custom-scrollbar::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 10px;
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
    { label: 'Settings', path: '/admin/settings', icon: 'settings-outline' },
  ];
}
