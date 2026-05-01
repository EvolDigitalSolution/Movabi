import { Component, inject } from '@angular/core';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { CommonModule } from '@angular/common';
import { IonicModule, MenuController } from '@ionic/angular';
import { Router, RouterModule } from '@angular/router';

import { addIcons } from 'ionicons';
import * as allIcons from 'ionicons/icons';

addIcons(allIcons);

@Component({
  selector: 'app-admin-layout',
  standalone: true,
  imports: [CommonModule, IonicModule, RouterModule],
  template: `
    <div class="admin-shell">
      <aside class="admin-sidebar">
        <div class="flex flex-col h-full bg-slate-900 text-slate-400">
          <div class="p-10 border-b border-slate-800/50 flex items-center gap-5">
            <div class="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-2xl shadow-blue-600/20">
              <ion-icon name="shield-checkmark-outline" class="text-3xl"></ion-icon>
            </div>
            <div>
              <h2 class="text-2xl font-display font-bold text-white tracking-tighter">Movabi</h2>
              <p class="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Admin Control</p>
            </div>
          </div>

          <nav class="flex-1 p-8 space-y-2 overflow-y-auto custom-scrollbar">
            @for (item of navItems; track item.path) {
              <button
                type="button"
                (click)="navigate(item.path)"
                [class.active]="isActive(item.path)"
                class="nav-link w-full flex items-center gap-4 px-5 py-4 rounded-2xl transition-all hover:bg-slate-800 hover:text-white group relative text-left"
              >
                <div class="w-10 h-10 rounded-xl bg-slate-800/50 flex items-center justify-center transition-all">
                  <ion-icon [name]="item.icon" class="text-xl group-hover:scale-110 transition-transform"></ion-icon>
                </div>
                <span class="font-bold text-sm tracking-wide">{{ item.label }}</span>
                <div class="active-dot absolute right-4 w-1.5 h-1.5 rounded-full bg-blue-600 opacity-0 transition-opacity"></div>
              </button>
            }
          </nav>

          <div class="p-8 border-t border-slate-800/50">
            <div class="bg-slate-800/30 p-5 rounded-3xl flex items-center gap-4 mb-6 border border-slate-700/30">
              <div class="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white font-bold text-sm shadow-inner">
                {{ getInitial() }}
              </div>
              <div class="flex-1 min-w-0">
                <h4 class="text-sm font-bold text-white truncate">{{ auth.currentUser()?.email || 'Admin' }}</h4>
                <p class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">System Admin</p>
              </div>
            </div>

            <button
              type="button"
              (click)="signOut()"
              class="w-full flex items-center justify-center gap-3 py-4 rounded-2xl bg-red-500/5 text-red-400 font-bold text-sm hover:bg-red-500 hover:text-white transition-all border border-red-500/10 hover:border-red-500 shadow-lg shadow-red-600/0 hover:shadow-red-600/20"
            >
              <ion-icon name="log-out-outline" class="text-xl"></ion-icon>
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </aside>

      <main class="admin-main">
        <header class="admin-topbar">
          <div class="flex items-center gap-4">
            <div class="w-1.5 h-8 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <span class="text-xl font-display font-bold text-slate-900 tracking-tight">
              Control Center
            </span>
          </div>

          <div class="flex items-center gap-3">
            <button type="button" (click)="navigate('/settings')" class="header-icon-button">
              <ion-icon name="settings-outline"></ion-icon>
            </button>

            <button type="button" (click)="signOut()" class="header-icon-button">
              <ion-icon name="log-out-outline"></ion-icon>
            </button>
          </div>
        </header>

        <div class="admin-content bg-slate-50">
          <div class="max-w-7xl mx-auto px-4 md:px-8 py-10">
            <router-outlet></router-outlet>
          </div>
        </div>
      </main>
    </div>
  `,
  styles: [`
    .admin-shell {
      height: 100vh;
      display: flex;
      background: #f8fafc;
      overflow: hidden;
    }

    .admin-sidebar {
      width: 340px;
      min-width: 340px;
      height: 100vh;
      position: sticky;
      top: 0;
      overflow: hidden;
      z-index: 20;
    }

    .admin-main {
      flex: 1;
      min-width: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .admin-topbar {
      min-height: 84px;
      background: rgba(255,255,255,0.92);
      border-bottom: 1px solid #e2e8f0;
      backdrop-filter: blur(16px);
      padding: 0 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      z-index: 10;
    }

    .admin-content {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }

    .header-icon-button {
      width: 48px;
      height: 48px;
      border-radius: 1rem;
      background: #f8fafc;
      color: #475569;
      border: 1px solid #e2e8f0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 150ms ease;
    }

    .header-icon-button:hover {
      background: #2563eb;
      color: white;
      border-color: #2563eb;
    }

    .nav-link.active {
      background-color: rgba(255,255,255,0.06)!important;
      color: white!important;
    }

    .nav-link.active div:first-child {
      background-color: #2563eb!important;
      color: white!important;
    }

    .nav-link.active .active-dot {
      opacity: 1!important;
    }

    .custom-scrollbar::-webkit-scrollbar {
      width: 4px;
    }

    .custom-scrollbar::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.1);
      border-radius: 10px;
    }

    @media (max-width: 900px) {
      .admin-shell {
        display: block;
        height: auto;
        min-height: 100vh;
        overflow: auto;
      }

      .admin-sidebar {
        width: 100%;
        min-width: 0;
        height: auto;
        position: relative;
      }

      .admin-main {
        height: auto;
        min-height: 100vh;
      }

      .admin-topbar {
        position: sticky;
        top: 0;
      }
    }
  `]
})
export class AdminLayoutComponent {
  public auth = inject(AuthService);
  private router = inject(Router);
  private menuCtrl = inject(MenuController);

  navItems = [
    { label: 'Dashboard', path: '/dashboard', icon: 'grid-outline' },
    { label: 'Users', path: '/users', icon: 'people-outline' },
    { label: 'Drivers', path: '/drivers', icon: 'car-sport-outline' },
    { label: 'Bookings', path: '/bookings', icon: 'calendar-clear-outline' },
    { label: 'Pricing', path: '/pricing', icon: 'cash-outline' },
    { label: 'Plans', path: '/subscriptions', icon: 'card-outline' },
    { label: 'Active Subs', path: '/active-subscriptions', icon: 'shield-checkmark-outline' },
    { label: 'Driver Subs', path: '/driver-subscriptions', icon: 'people-circle-outline' },
    { label: 'Jobs', path: '/van-jobs', icon: 'briefcase-outline' },
    { label: 'Settings', path: '/settings', icon: 'settings-outline' }
  ];

  async navigate(path: string) {
    await this.router.navigateByUrl(path);

    try {
      await this.menuCtrl.close();
    } catch {
      // no mobile ion-menu active
    }
  }

  isActive(path: string) {
    return this.router.url === path || this.router.url.startsWith(path + '/');
  }

  getInitial(): string {
    const email = this.auth.currentUser()?.email || 'A';
    return email.charAt(0).toUpperCase();
  }

  async signOut() {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
