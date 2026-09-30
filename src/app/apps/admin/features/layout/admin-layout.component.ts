import { Component, inject, signal } from '@angular/core';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { CommonModule } from '@angular/common';
import { IonicModule, MenuController } from '@ionic/angular';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';

import { addIcons } from 'ionicons';
import * as allIcons from 'ionicons/icons';

addIcons(allIcons);

@Component({
  selector: 'app-admin-layout',
  standalone: true,
  imports: [CommonModule, IonicModule, RouterModule],
  template: `
    <div class="admin-shell">
      <aside class="admin-sidebar bg-slate-900 text-slate-400" [class.open]="sidebarOpen()">
        <div class="admin-sidebar-header p-6 border-b border-slate-800/50 flex items-center gap-4">
            <div class="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-2xl shadow-blue-600/20">
              <ion-icon name="shield-checkmark-outline" class="text-2xl"></ion-icon>
            </div>
            <div>
              <h2 class="text-xl font-display font-bold text-white tracking-tighter">Movabi</h2>
              <p class="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Admin Control</p>
            </div>
          </div>

          <nav class="admin-nav p-5 space-y-1.5 custom-scrollbar">
            @for (item of navItems; track item.path) {
              <button
                type="button"
                (click)="navigate(item.path)"
                [class.active]="isActive(item.path)"
                class="nav-link w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all hover:bg-slate-800 hover:text-white group relative text-left"
              >
                <div class="w-9 h-9 rounded-lg bg-slate-800/50 flex items-center justify-center transition-all">
                  <ion-icon [name]="item.icon" class="text-lg group-hover:scale-110 transition-transform"></ion-icon>
                </div>
                <span class="font-bold text-sm tracking-wide">{{ item.label }}</span>
                <div class="active-dot absolute right-4 w-1.5 h-1.5 rounded-full bg-blue-600 opacity-0 transition-opacity"></div>
              </button>
            }
          </nav>

          <div class="admin-sidebar-footer p-5 border-t border-slate-800/50">
            <div class="bg-slate-800/30 p-4 rounded-2xl flex items-center gap-3 mb-4 border border-slate-700/30">
              <div class="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold text-sm shadow-inner">
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
      </aside>

      <div class="sidebar-backdrop" [class.visible]="sidebarOpen()" (click)="closeSidebar()"></div>

      <main class="admin-main">
        <header class="admin-topbar">
          <div class="flex items-center gap-4">
            <button type="button" class="menu-toggle" (click)="toggleSidebar()" aria-label="Toggle navigation">
              <ion-icon name="menu-outline"></ion-icon>
            </button>
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
          <div class="max-w-7xl mx-auto px-4 md:px-6 py-6">
            <router-outlet></router-outlet>
          </div>
        </div>
      </main>
    </div>
  `,
  styles: [`
    :host {
      /* Admin typography scale — moderate and information-efficient. These
         tokens override Tailwind's named text utilities (text-xs … text-4xl)
         ONLY within the Admin shell; the mobile/consumer apps keep their own
         scale. */
      --text-xs: 0.75rem;
      --text-sm: 0.8125rem;
      --text-base: 0.875rem;
      --text-lg: 1rem;
      --text-xl: 1.125rem;
      --text-2xl: 1.25rem;
      --text-3xl: 1.5rem;
      --text-4xl: 1.75rem;

      --text-xs--line-height: 1rem;
      --text-sm--line-height: 1.25rem;
      --text-base--line-height: 1.25rem;
      --text-lg--line-height: 1.5rem;
      --text-xl--line-height: 1.5rem;
      --text-2xl--line-height: 1.5rem;
      --text-3xl--line-height: 1.5rem;
      --text-4xl--line-height: 1.5rem;
    }

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
      height: 100dvh;
      position: relative;
      display: flex;
      flex-direction: column;
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
      min-height: 60px;
      background: rgba(255,255,255,0.92);
      border-bottom: 1px solid #e2e8f0;
      backdrop-filter: blur(16px);
      padding: 0 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      z-index: 10;
    }

    .admin-content {
      flex: 1;
      min-height: 0;
      min-width: 0;
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

    /* Sidebar is itself the flex column: header (fixed) + nav (fills, scrolls)
       + footer (fixed). Header/footer never shrink, so the nav owns ALL of the
       remaining height and is the only region that scrolls. */
    .admin-sidebar-header,
    .admin-sidebar-footer {
      flex-shrink: 0;
    }

    .admin-nav {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
    }

    .menu-toggle {
      display: none;
    }

    .sidebar-backdrop {
      display: none;
    }

    @media (max-width: 1023px) {
      .menu-toggle {
        display: inline-flex;
        width: 48px;
        height: 48px;
        border-radius: 1rem;
        background: #f8fafc;
        color: #475569;
        border: 1px solid #e2e8f0;
        align-items: center;
        justify-content: center;
        transition: all 150ms ease;
        flex-shrink: 0;
      }

      .menu-toggle:hover {
        background: #2563eb;
        color: white;
        border-color: #2563eb;
      }

      /* Off-canvas drawer: the sidebar slides over the content instead of
         stacking in normal flow. Stacking is incompatible with Ionic's global
         body{position:fixed;overflow:hidden}, which would otherwise clip the
         stacked sidebar past 100vh and leave the lower nav items unreachable. */
      .admin-sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: min(340px, 85vw);
        min-width: 0;
        height: 100vh;
        height: 100dvh;
        transform: translateX(-100%);
        transition: transform 200ms ease;
        z-index: 40;
      }

      .admin-sidebar.open {
        transform: translateX(0);
        box-shadow: 0 0 48px rgba(15, 23, 42, 0.35);
      }

      .sidebar-backdrop {
        display: block;
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        z-index: 30;
        opacity: 0;
        pointer-events: none;
        transition: opacity 200ms ease;
      }

      .sidebar-backdrop.visible {
        opacity: 1;
        pointer-events: auto;
      }
    }

    /* Compact header/footer whenever the sidebar is a drawer OR the viewport
       height is short, so the nav keeps the dominant vertical space. The
       desktop design at normal large widths/heights is unchanged. */
    @media (max-width: 1023px), (max-height: 800px) {
      .admin-sidebar-header {
        padding: 0.75rem 1.25rem;
        gap: 0.75rem;
      }

      .admin-sidebar-header > div:first-child {
        width: 2.5rem;
        height: 2.5rem;
      }

      .admin-sidebar-header > div:first-child ion-icon {
        font-size: 1.25rem;
      }

      .admin-sidebar-header h2 {
        font-size: 1.125rem;
        line-height: 1.1;
        margin-bottom: 0;
      }

      .admin-sidebar-header p {
        line-height: 1.2;
        margin-bottom: 0;
      }

      .admin-sidebar-footer {
        padding: 0.75rem 1rem;
      }

      .admin-sidebar-footer > div:first-child {
        padding: 0.5rem 0.75rem;
        margin-bottom: 0.625rem;
        border-radius: 1rem;
        gap: 0.625rem;
      }

      .admin-sidebar-footer > div:first-child > div:first-child {
        width: 2.25rem;
        height: 2.25rem;
      }

      .admin-sidebar-footer button {
        padding-top: 0.5rem;
        padding-bottom: 0.5rem;
        gap: 0.625rem;
      }

      /* Visible, tasteful scrollbar in the drawer/short-height context. */
      .admin-nav {
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.32) transparent;
      }

      .admin-nav::-webkit-scrollbar {
        width: 8px;
      }

      .admin-nav::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.28);
        border-radius: 999px;
      }

      .admin-nav::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.45);
      }
    }

    /* Very short viewports: further compact so the nav never collapses to a
       sliver. */
    @media (max-height: 600px) {
      .admin-sidebar-header {
        padding-top: 0.5rem;
        padding-bottom: 0.5rem;
      }

      .admin-sidebar-header > div:first-child {
        width: 2rem;
        height: 2rem;
      }

      .admin-sidebar-footer {
        padding-top: 0.5rem;
        padding-bottom: 0.5rem;
      }

      .admin-sidebar-footer > div:first-child {
        margin-bottom: 0.5rem;
      }
    }
  `]
})
export class AdminLayoutComponent {
  public auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private menuCtrl = inject(MenuController);

  sidebarOpen = signal(false);

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
    { label: 'Marketplace Control Centre', path: '/marketplace', icon: 'storefront-outline' },
    { label: 'Local Services', path: '/marketplace/local-services', icon: 'business-outline' },
    { label: 'Global AI Pricing', path: '/marketplace/global-ai-pricing', icon: 'analytics-outline' },
    { label: 'Market Intelligence', path: '/pricing/market-intelligence', icon: 'trending-up-outline' },
    { label: 'Market Rollout', path: '/marketplace/market-rollout', icon: 'globe-outline' },
    { label: 'About Movabi', path: '/about-movabi', icon: 'rocket-outline' },
    { label: 'Settings', path: '/settings', icon: 'settings-outline' }
  ];

  async navigate(path: string) {
    // Navigate relative to this layout's own route so the same nav works both
    // when the Admin app is served standalone (mounted at '/') and when it is
    // embedded in the mobile shell (mounted at '/admin'). An absolute
    // navigateByUrl('/settings') resolves against the app root and 404s with
    // NG04002 in the embedded case.
    const clean = String(path || '').replace(/^\/+/, '');
    await this.router.navigate([clean], { relativeTo: this.route });
    this.sidebarOpen.set(false);

    try {
      await this.menuCtrl.close();
    } catch {
      // no mobile ion-menu active
    }
  }

  toggleSidebar() {
    this.sidebarOpen.update((open) => !open);
  }

  closeSidebar() {
    this.sidebarOpen.set(false);
  }

  isActive(path: string) {
    const clean = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '');
    const url = (this.router.url || '').split('?')[0].replace(/\/+$/, '');
    return url === `/${clean}` || url.endsWith(`/${clean}`) || url.includes(`/${clean}/`);
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
