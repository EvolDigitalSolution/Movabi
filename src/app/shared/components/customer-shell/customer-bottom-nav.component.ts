import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonIcon } from '@ionic/angular/standalone';
import { NavigationEnd, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { addIcons } from 'ionicons';
import {
    home,
    homeOutline,
    gridOutline,
    grid,
    timeOutline,
    time,
    personCircleOutline,
    personCircle
} from 'ionicons/icons';

interface CustomerNavItem {
    label: string;
    icon: string;
    iconActive: string;
    route: string;
}

/**
 * Floating bottom navigation for the Movabi customer shell.
 * Intentionally standalone and dumb: it only reads the current router URL
 * and navigates to existing routes. No booking, pricing, or address state
 * is read or mutated here.
 *
 * Mount this only on top-level customer shell pages (Home, Services, Activity,
 * Account). Do NOT mount on full-screen flows such as booking-request,
 * tracking, marketplace-fare, marketplace-payment, or payment sheets.
 */
@Component({
    selector: 'app-customer-bottom-nav',
    standalone: true,
    imports: [CommonModule, IonIcon],
    template: `
    <nav class="customer-bottom-nav" role="navigation" aria-label="Primary">
      <div class="customer-bottom-nav__pill">
        @for (item of navItems; track item.route) {
          <button
            type="button"
            class="customer-bottom-nav__item"
            [class.customer-bottom-nav__item--active]="isActive(item.route)"
            [attr.aria-current]="isActive(item.route) ? 'page' : null"
            [attr.aria-label]="item.label"
            (click)="go(item.route)">
            <span class="customer-bottom-nav__icon-wrap">
              <ion-icon
                [name]="isActive(item.route) ? item.iconActive : item.icon"
                class="customer-bottom-nav__icon">
              </ion-icon>
              @if (isActive(item.route)) {
                <span class="customer-bottom-nav__dot" aria-hidden="true"></span>
              }
            </span>
            <span class="customer-bottom-nav__label">{{ item.label }}</span>
          </button>
        }
      </div>
    </nav>
  `,
    styles: [`
    .customer-bottom-nav {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 40;
      display: flex;
      justify-content: center;
      padding: 0 12px max(12px, env(safe-area-inset-bottom));
      pointer-events: none;
    }

    .customer-bottom-nav__pill {
      pointer-events: auto;
      width: 100%;
      max-width: 30rem;
      display: flex;
      align-items: stretch;
      gap: 2px;
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(18px);
      border: 1px solid rgba(15, 23, 42, 0.06);
      border-radius: 1.75rem;
      box-shadow: 0 12px 32px -8px rgba(15, 23, 42, 0.18);
      padding: 6px;
    }

    .customer-bottom-nav__item {
      flex: 1 1 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      min-height: 56px;
      border-radius: 1.4rem;
      background: transparent;
      color: #64748b;
      font-weight: 700;
      font-size: 10px;
      letter-spacing: 0.02em;
      transition: background-color 0.2s ease, color 0.2s ease, transform 0.15s ease;
    }

    .customer-bottom-nav__item:active {
      transform: scale(0.96);
    }

    .customer-bottom-nav__item--active {
      background: #fff7ed;
      color: #c2410c;
    }

    .customer-bottom-nav__icon-wrap {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .customer-bottom-nav__icon {
      font-size: 22px;
    }

    .customer-bottom-nav__dot {
      position: absolute;
      top: -3px;
      right: -5px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #f97316;
    }

    .customer-bottom-nav__label {
      line-height: 1;
    }

    .customer-bottom-nav__item:focus-visible {
      outline: 2px solid #f97316;
      outline-offset: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
      .customer-bottom-nav__item {
        transition: none;
      }
    }
  `]
})
export class CustomerBottomNavComponent {
    private router = inject(Router);

    private currentUrl = toSignal(
        this.router.events.pipe(
            filter((event): event is NavigationEnd => event instanceof NavigationEnd),
            map(() => this.router.url),
            startWith(this.router.url)
        ),
        { initialValue: this.router.url }
    );

    readonly navItems: CustomerNavItem[] = [
        { label: 'Home', icon: 'home-outline', iconActive: 'home', route: '/customer' },
        { label: 'Services', icon: 'grid-outline', iconActive: 'grid', route: '/customer/services' },
        { label: 'Activity', icon: 'time-outline', iconActive: 'time', route: '/customer/activity' },
        { label: 'Account', icon: 'person-circle-outline', iconActive: 'person-circle', route: '/account/settings' }
    ];

    constructor() {
        addIcons({
            home,
            homeOutline,
            grid,
            gridOutline,
            timeOutline,
            time,
            personCircleOutline,
            personCircle
        });
    }

    isActive(route: string): boolean {
        const url = this.currentUrl().split('?')[0];

        if (route === '/customer') {
            return url === '/customer' || url === '/customer/';
        }

        return url === route || url.startsWith(`${route}/`);
    }

    go(route: string): void {
        if (this.isActive(route)) return;
        void this.router.navigateByUrl(route);
    }
}
