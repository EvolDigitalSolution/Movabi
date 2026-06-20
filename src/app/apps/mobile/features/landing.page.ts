import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { IonButton, IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowForwardOutline,
  basketOutline,
  car,
  carOutline,
  cardOutline,
  chatbubbleEllipsesOutline,
  checkmarkCircleOutline,
  chevronForwardOutline,
  cubeOutline,
  helpCircleOutline,
  locationOutline,
  lockClosedOutline,
  menuOutline,
  closeOutline,
  shieldCheckmarkOutline,
  storefrontOutline,
  walletOutline
} from 'ionicons/icons';
import { AuthService } from '@core/services/auth/auth.service';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, RouterModule, IonContent, IonIcon, IonButton],
  template: `
    <ion-content class="landing-content">
      <main class="landing-shell">
        <header class="top-nav">
          <a routerLink="/" class="brand-row" aria-label="Movabi home">
            <span class="brand-mark">
              <ion-icon name="car"></ion-icon>
            </span>
            <span>
              <strong>Movabi</strong>
              <small>Transport, errands and delivery</small>
            </span>
          </a>

          <nav class="desktop-nav" aria-label="Main navigation">
            <a href="#services">Services</a>
            <a href="#customers">Customers</a>
            <a href="#drivers">Drivers</a>
            <a routerLink="/help">How it works</a>
            <a routerLink="/auth/login">Sign in</a>
          </nav>

          <button type="button" class="icon-nav-btn" (click)="menuOpen.set(!menuOpen())" aria-label="Open menu">
            <ion-icon [name]="menuOpen() ? 'close-outline' : 'menu-outline'"></ion-icon>
          </button>
        </header>

        @if (menuOpen()) {
          <nav class="mobile-menu" aria-label="Mobile navigation">
            <a href="#services" (click)="menuOpen.set(false)">Services</a>
            <a href="#customers" (click)="menuOpen.set(false)">Customers</a>
            <a href="#drivers" (click)="menuOpen.set(false)">Drivers</a>
            <a routerLink="/help" (click)="menuOpen.set(false)">How it works</a>
            <a routerLink="/privacy" (click)="menuOpen.set(false)">Privacy</a>
            <a routerLink="/auth/login" (click)="menuOpen.set(false)">Sign in</a>
          </nav>
        }

        <section class="hero">
          <div class="hero-copy">
            <p class="eyebrow">One app for local movement</p>
            <h1>Book a ride, send a package, run an errand, or move items.</h1>
            <p class="hero-text">
              Movabi helps customers get things done quickly and helps drivers earn from real local requests.
              Prices are shown before booking, payments are protected, and progress is easy to follow.
            </p>

            <div class="hero-actions">
              <ion-button routerLink="/auth/signup" class="primary-action">
                Get started
                <ion-icon name="arrow-forward-outline" slot="end"></ion-icon>
              </ion-button>
              <ion-button routerLink="/auth/login" fill="outline" class="secondary-action">
                Sign in
              </ion-button>
            </div>

            <div class="hero-links" aria-label="Quick links">
              <a routerLink="/help">
                <ion-icon name="help-circle-outline"></ion-icon>
                How to use Movabi
              </a>
              <a routerLink="/privacy">
                <ion-icon name="shield-checkmark-outline"></ion-icon>
                Privacy and data
              </a>
            </div>
          </div>

          <div class="hero-panel" aria-label="Movabi service summary">
            <div class="phone-card">
              <div class="phone-header">
                <span>Movabi</span>
                <strong>Live</strong>
              </div>
              <div class="map-preview">
                <span class="pin pickup">Pickup</span>
                <span class="pin dropoff">Dropoff</span>
                <span class="route-line"></span>
              </div>
              <div class="booking-preview">
                <div>
                  <small>Next request</small>
                  <strong>Ride to city centre</strong>
                </div>
                <span>£8.40</span>
              </div>
              <div class="preview-grid">
                <span><ion-icon name="location-outline"></ion-icon> Track</span>
                <span><ion-icon name="wallet-outline"></ion-icon> Wallet</span>
                <span><ion-icon name="chatbubble-ellipses-outline"></ion-icon> Chat</span>
              </div>
            </div>
          </div>
        </section>

        <section class="quick-services" id="services">
          <div class="section-heading">
            <p class="eyebrow">Choose what you need</p>
            <h2>Simple services, clear actions.</h2>
          </div>

          <div class="service-grid">
            @for (service of services; track service.title) {
              <a routerLink="/auth/signup" class="service-card">
                <span class="service-icon" [ngClass]="service.tone">
                  <ion-icon [name]="service.icon"></ion-icon>
                </span>
                <strong>{{ service.title }}</strong>
                <p>{{ service.copy }}</p>
                <span class="card-link">Start <ion-icon name="chevron-forward-outline"></ion-icon></span>
              </a>
            }
          </div>
        </section>

        <section class="how-section">
          <div class="section-heading">
            <p class="eyebrow">How Movabi works</p>
            <h2>Built so non-technical users can book or earn without guessing.</h2>
          </div>

          <div class="steps-grid">
            @for (step of customerSteps; track step.title; let index = $index) {
              <article class="step-card">
                <span class="step-number">{{ index + 1 }}</span>
                <h3>{{ step.title }}</h3>
                <p>{{ step.copy }}</p>
              </article>
            }
          </div>
        </section>

        <section class="split-section" id="customers">
          <div class="split-card customer-card">
            <p class="eyebrow">For customers</p>
            <h2>Know the price, follow the job, and understand your money.</h2>
            <ul>
              <li><ion-icon name="checkmark-circle-outline"></ion-icon> Upfront estimates before you confirm.</li>
              <li><ion-icon name="checkmark-circle-outline"></ion-icon> Wallet or card payment protection with clear refund status.</li>
              <li><ion-icon name="checkmark-circle-outline"></ion-icon> Live tracking, driver details, chat, and service-specific updates.</li>
            </ul>
            <ion-button routerLink="/auth/signup" class="primary-action">Book as customer</ion-button>
          </div>

          <div class="split-card driver-card" id="drivers">
            <p class="eyebrow">For drivers</p>
            <h2>Accept local jobs and get paid through a guided driver flow.</h2>
            <ul>
              <li><ion-icon name="checkmark-circle-outline"></ion-icon> Vehicle and service setup during registration.</li>
              <li><ion-icon name="checkmark-circle-outline"></ion-icon> Online, free, accept, pass, navigate, chat, and complete controls.</li>
              <li><ion-icon name="checkmark-circle-outline"></ion-icon> Stripe Connect payouts and Movabi Pay for approved errand budgets.</li>
            </ul>
            <ion-button routerLink="/auth/signup" class="dark-action">Drive with Movabi</ion-button>
          </div>
        </section>

        <section class="trust-section">
          <div class="trust-card">
            <span><ion-icon name="lock-closed-outline"></ion-icon></span>
            <div>
              <h2>Privacy and payments are explained in plain language.</h2>
              <p>
                Movabi uses personal, location, payment, and service data only where needed to run the app,
                protect bookings, support drivers, meet legal duties, and improve safety.
              </p>
            </div>
            <a routerLink="/privacy">Read privacy notice</a>
          </div>
        </section>

        <section class="final-cta">
          <p class="eyebrow">Start today</p>
          <h2>Join Movabi as a customer or driver.</h2>
          <p>One account gives you access to the right tools for booking, earning, tracking, paying, and getting support.</p>
          <div class="hero-actions centered">
            <ion-button routerLink="/auth/signup" class="primary-action">Create account</ion-button>
            <ion-button routerLink="/help" fill="outline" class="secondary-action light">Learn how it works</ion-button>
          </div>
          <footer>
            <a routerLink="/privacy">Privacy</a>
            <a routerLink="/help">Help</a>
            <a routerLink="/auth/login">Sign in</a>
            <span>© 2026 Movabi</span>
          </footer>
        </section>
      </main>
    </ion-content>
  `,
  styles: [`
    ion-content.landing-content {
      --background: #f4f6f8;
      color: #111827;
    }

    .landing-shell {
      min-height: 100vh;
      background: #f4f6f8;
    }

    .top-nav {
      position: sticky;
      top: 0;
      z-index: 30;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      background: rgba(244, 246, 248, 0.92);
      border-bottom: 1px solid #e5e7eb;
      backdrop-filter: blur(18px);
    }

    .brand-row,
    .desktop-nav a,
    .mobile-menu a,
    .hero-links a,
    .service-card,
    .trust-card a,
    footer a {
      text-decoration: none;
    }

    .brand-row {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #111827;
    }

    .brand-mark {
      width: 46px;
      height: 46px;
      border-radius: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #ff9800;
      color: #111827;
      font-size: 1.45rem;
      box-shadow: 0 10px 24px rgba(255, 152, 0, 0.28);
    }

    .brand-row strong {
      display: block;
      font-size: 1.45rem;
      font-weight: 900;
      line-height: 1;
    }

    .brand-row small {
      display: block;
      color: #64748b;
      font-weight: 800;
      font-size: 0.68rem;
      margin-top: 4px;
    }

    .desktop-nav {
      display: none;
      align-items: center;
      gap: 20px;
    }

    .desktop-nav a {
      color: #334155;
      font-weight: 900;
      font-size: 0.9rem;
    }

    .icon-nav-btn {
      width: 44px;
      height: 44px;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      background: white;
      color: #111827;
      font-size: 1.35rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
    }

    .mobile-menu {
      position: fixed;
      top: 76px;
      left: 16px;
      right: 16px;
      z-index: 40;
      display: grid;
      gap: 8px;
      padding: 12px;
      border-radius: 22px;
      background: white;
      border: 1px solid #e2e8f0;
      box-shadow: 0 22px 44px rgba(15, 23, 42, 0.16);
    }

    .mobile-menu a {
      padding: 14px 16px;
      border-radius: 16px;
      background: #f8fafc;
      color: #111827;
      font-weight: 900;
    }

    .hero {
      max-width: 1180px;
      margin: 0 auto;
      padding: 34px 18px 28px;
      display: grid;
      gap: 28px;
      align-items: center;
    }

    .eyebrow {
      margin: 0 0 12px;
      color: #c2410c;
      font-weight: 900;
      font-size: 0.74rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    h1,
    h2,
    h3,
    p {
      letter-spacing: 0;
    }

    h1 {
      margin: 0;
      max-width: 740px;
      color: #111827;
      font-size: clamp(2.45rem, 9vw, 5.2rem);
      line-height: 0.96;
      font-weight: 900;
    }

    .hero-text {
      max-width: 670px;
      margin: 18px 0 0;
      color: #475569;
      font-size: 1.05rem;
      line-height: 1.75;
      font-weight: 700;
    }

    .hero-actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 24px;
    }

    .hero-actions.centered {
      justify-content: center;
    }

    .primary-action,
    .dark-action {
      --border-radius: 18px;
      height: 56px;
      font-weight: 900;
      letter-spacing: 0;
    }

    .primary-action {
      --background: #ff9800;
      --color: #111827;
      box-shadow: 0 16px 32px rgba(255, 152, 0, 0.24);
    }

    .dark-action {
      --background: #111827;
      --color: white;
    }

    .secondary-action {
      --border-radius: 18px;
      --border-color: #cbd5e1;
      --color: #111827;
      height: 56px;
      font-weight: 900;
    }

    .secondary-action.light {
      --border-color: rgba(255,255,255,0.72);
      --color: white;
    }

    .hero-links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }

    .hero-links a {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 42px;
      padding: 10px 14px;
      border-radius: 999px;
      background: white;
      color: #334155;
      font-size: 0.86rem;
      font-weight: 900;
      border: 1px solid #e2e8f0;
    }

    .hero-panel {
      min-height: 420px;
      border-radius: 34px;
      background:
        radial-gradient(circle at 82% 18%, rgba(255, 152, 0, 0.3), transparent 28%),
        linear-gradient(145deg, #111827, #1f2937);
      padding: 22px;
      box-shadow: 0 28px 56px rgba(15, 23, 42, 0.18);
    }

    .phone-card {
      height: 100%;
      border-radius: 30px;
      background: #f8fafc;
      padding: 18px;
      display: grid;
      gap: 16px;
    }

    .phone-header,
    .booking-preview,
    .preview-grid {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .phone-header span {
      font-weight: 900;
      color: #111827;
      font-size: 1.2rem;
    }

    .phone-header strong {
      border-radius: 999px;
      background: #dcfce7;
      color: #047857;
      padding: 8px 12px;
      font-size: 0.72rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .map-preview {
      position: relative;
      min-height: 210px;
      border-radius: 26px;
      overflow: hidden;
      background:
        linear-gradient(90deg, rgba(148, 163, 184, 0.24) 1px, transparent 1px),
        linear-gradient(rgba(148, 163, 184, 0.24) 1px, transparent 1px),
        #e8f3ed;
      background-size: 42px 42px;
    }

    .route-line {
      position: absolute;
      left: 25%;
      right: 22%;
      top: 52%;
      height: 6px;
      border-radius: 999px;
      background: #ff9800;
      transform: rotate(-16deg);
      box-shadow: 0 0 0 6px rgba(255, 152, 0, 0.13);
    }

    .pin {
      position: absolute;
      z-index: 2;
      padding: 8px 10px;
      border-radius: 999px;
      background: white;
      color: #111827;
      font-weight: 900;
      font-size: 0.72rem;
      box-shadow: 0 10px 20px rgba(15, 23, 42, 0.12);
    }

    .pin.pickup {
      left: 20px;
      top: 32px;
      border: 2px solid #ff9800;
    }

    .pin.dropoff {
      right: 20px;
      bottom: 32px;
      border: 2px solid #10b981;
    }

    .booking-preview {
      padding: 16px;
      border-radius: 22px;
      background: white;
      border: 1px solid #e2e8f0;
    }

    .booking-preview small {
      display: block;
      color: #64748b;
      font-weight: 900;
      font-size: 0.72rem;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .booking-preview strong {
      color: #111827;
      font-size: 1rem;
    }

    .booking-preview span {
      color: #c2410c;
      font-size: 1.45rem;
      font-weight: 900;
    }

    .preview-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
    }

    .preview-grid span {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 14px 8px;
      border-radius: 18px;
      background: #fff7ed;
      color: #334155;
      font-weight: 900;
      font-size: 0.75rem;
      text-align: center;
    }

    .quick-services,
    .how-section,
    .split-section,
    .trust-section,
    .final-cta {
      max-width: 1180px;
      margin: 0 auto;
      padding: 48px 18px;
    }

    .section-heading {
      max-width: 720px;
      margin-bottom: 22px;
    }

    .section-heading h2,
    .split-card h2,
    .trust-card h2,
    .final-cta h2 {
      margin: 0;
      color: #111827;
      font-size: clamp(1.85rem, 6vw, 3.2rem);
      line-height: 1.05;
      font-weight: 900;
    }

    .service-grid,
    .steps-grid,
    .split-section {
      display: grid;
      gap: 16px;
    }

    .service-card,
    .step-card,
    .split-card,
    .trust-card {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 28px;
      box-shadow: 0 16px 34px rgba(15, 23, 42, 0.06);
    }

    .service-card {
      min-height: 210px;
      padding: 22px;
      display: flex;
      flex-direction: column;
      color: #111827;
    }

    .service-icon {
      width: 70px;
      height: 70px;
      border-radius: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 1.8rem;
      margin-bottom: 18px;
    }

    .ride { background: #ff9800; color: #111827; }
    .errand { background: #10b981; }
    .delivery { background: #0f766e; }
    .moving { background: #111827; }

    .service-card strong {
      font-size: 1.25rem;
      font-weight: 900;
    }

    .service-card p,
    .step-card p,
    .split-card li,
    .trust-card p,
    .final-cta p {
      color: #64748b;
      line-height: 1.65;
      font-weight: 700;
    }

    .card-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: auto;
      color: #c2410c;
      font-weight: 900;
    }

    .step-card {
      padding: 24px;
    }

    .step-number {
      display: inline-flex;
      width: 42px;
      height: 42px;
      border-radius: 16px;
      align-items: center;
      justify-content: center;
      background: #fff7ed;
      color: #c2410c;
      font-weight: 900;
      margin-bottom: 16px;
    }

    .step-card h3 {
      margin: 0 0 8px;
      color: #111827;
      font-weight: 900;
      font-size: 1.12rem;
    }

    .split-card {
      padding: 26px;
    }

    .split-card ul {
      display: grid;
      gap: 12px;
      margin: 22px 0;
      padding: 0;
      list-style: none;
    }

    .split-card li {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }

    .split-card ion-icon {
      color: #10b981;
      font-size: 1.2rem;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .driver-card {
      background: #111827;
      color: white;
    }

    .driver-card h2,
    .driver-card li {
      color: white;
    }

    .driver-card li {
      opacity: 0.82;
    }

    .trust-card {
      display: grid;
      gap: 16px;
      align-items: center;
      padding: 24px;
    }

    .trust-card > span {
      width: 66px;
      height: 66px;
      border-radius: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #fff7ed;
      color: #c2410c;
      font-size: 1.8rem;
    }

    .trust-card a {
      color: #c2410c;
      font-weight: 900;
    }

    .final-cta {
      text-align: center;
      background: #111827;
      max-width: none;
      color: white;
      margin-top: 24px;
    }

    .final-cta h2 {
      color: white;
    }

    .final-cta p {
      max-width: 680px;
      margin-left: auto;
      margin-right: auto;
      color: #cbd5e1;
    }

    footer {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 14px;
      margin-top: 28px;
      color: #94a3b8;
      font-size: 0.86rem;
      font-weight: 800;
    }

    footer a {
      color: white;
    }

    @media (min-width: 760px) {
      .desktop-nav {
        display: flex;
      }

      .icon-nav-btn {
        display: none;
      }

      .hero,
      .split-section,
      .trust-card {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .service-grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .steps-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .hero-actions {
        flex-direction: row;
      }

      .hero {
        padding-top: 64px;
        padding-bottom: 58px;
      }
    }
  `]
})
export class LandingPage implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);

  menuOpen = signal(false);

  services = [
    {
      title: 'Book a ride',
      copy: 'Choose pickup and destination, see the fare, then track your driver.',
      icon: 'car-outline',
      tone: 'ride'
    },
    {
      title: 'Run an errand',
      copy: 'Reserve an item budget, follow shop progress, and approve changes when needed.',
      icon: 'basket-outline',
      tone: 'errand'
    },
    {
      title: 'Send a package',
      copy: 'Book bike, car, or van delivery for local parcels and documents.',
      icon: 'cube-outline',
      tone: 'delivery'
    },
    {
      title: 'Book a move',
      copy: 'Request van moving help with vehicle size and clear job details.',
      icon: 'storefront-outline',
      tone: 'moving'
    }
  ];

  customerSteps = [
    {
      title: 'Pick a service',
      copy: 'Choose ride, errand, delivery, or moving. Movabi only asks for details needed for that service.'
    },
    {
      title: 'Confirm the price',
      copy: 'Review route, budget, wallet, or card authorisation before the request is sent to drivers.'
    },
    {
      title: 'Track and chat',
      copy: 'Follow live status, use quick messages, and see what happens if a job is cancelled or no driver is found.'
    }
  ];

  constructor() {
    addIcons({
      arrowForwardOutline,
      basketOutline,
      car,
      carOutline,
      cardOutline,
      chatbubbleEllipsesOutline,
      checkmarkCircleOutline,
      chevronForwardOutline,
      cubeOutline,
      helpCircleOutline,
      locationOutline,
      lockClosedOutline,
      menuOutline,
      closeOutline,
      shieldCheckmarkOutline,
      storefrontOutline,
      walletOutline
    });
  }

  async ngOnInit() {
    const user = this.auth.currentUser();

    if (user) {
      await this.auth.handlePostAuthRedirect();
      return;
    }

    const returningUser = localStorage.getItem('movabi_returning_user') === 'true';

    if (returningUser) {
      await this.router.navigate(['/auth/login'], { replaceUrl: true });
    }
  }
}
