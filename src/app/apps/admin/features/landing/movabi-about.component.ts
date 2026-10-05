import { CommonModule } from '@angular/common';
import { Component, afterNextRender, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { IonButton, IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  analyticsOutline,
  arrowForwardOutline,
  basketOutline,
  car,
  carOutline,
  cardOutline,
  cashOutline,
  chatbubbleEllipsesOutline,
  checkmarkCircleOutline,
  chevronForwardOutline,
  closeOutline,
  cubeOutline,
  downloadOutline,
  helpCircleOutline,
  locationOutline,
  lockClosedOutline,
  menuOutline,
  peopleOutline,
  phonePortraitOutline,
  rocketOutline,
  shieldCheckmarkOutline,
  storefrontOutline,
  trendingUpOutline,
  walletOutline
} from 'ionicons/icons';

@Component({
  selector: 'app-admin-movabi-about',
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
              <small>Ride, errand, delivery and moving</small>
            </span>
          </a>

          <nav class="desktop-nav" aria-label="Main navigation">
            <a href="/about-movabi#why" (click)="onSectionLink($event, 'why')">Why Movabi</a>
            <a href="/about-movabi#services" (click)="onSectionLink($event, 'services')">Services</a>
            <a href="/about-movabi#drivers" (click)="onSectionLink($event, 'drivers')">Drivers</a>
            <a href="/about-movabi#investors" (click)="onSectionLink($event, 'investors')">Investors</a>
            <a href="/about-movabi#download" (click)="onSectionLink($event, 'download')">Download</a>
            <a routerLink="/auth/login">Sign in</a>
          </nav>

          <button type="button" class="icon-nav-btn" (click)="menuOpen.set(!menuOpen())" aria-label="Open menu">
            <ion-icon [name]="menuOpen() ? 'close-outline' : 'menu-outline'"></ion-icon>
          </button>
        </header>

        @if (menuOpen()) {
          <nav class="mobile-menu" aria-label="Mobile navigation">
            <a href="/about-movabi#why" (click)="onSectionLink($event, 'why', { closeMenu: true })">Why Movabi</a>
            <a href="/about-movabi#services" (click)="onSectionLink($event, 'services', { closeMenu: true })">Services</a>
            <a href="/about-movabi#drivers" (click)="onSectionLink($event, 'drivers', { closeMenu: true })">Drivers</a>
            <a href="/about-movabi#investors" (click)="onSectionLink($event, 'investors', { closeMenu: true })">Investors</a>
            <a href="/about-movabi#download" (click)="onSectionLink($event, 'download', { closeMenu: true })">Download</a>
            <a routerLink="/help" (click)="menuOpen.set(false)">How it works</a>
            <a routerLink="/privacy" (click)="menuOpen.set(false)">Privacy</a>
            <a routerLink="/auth/login" (click)="menuOpen.set(false)">Sign in</a>
          </nav>
        }

        <section class="hero" aria-labelledby="about-hero-title">
          <div class="hero-inner">
            <div class="hero-copy">
              <p class="hero-eyebrow">LOCAL TRANSPORT MADE SIMPLER</p>
              <h1 id="about-hero-title" class="hero-title">Your everyday move, made simple.</h1>
              <p class="hero-lede">Rides, errands, deliveries and moving — all in one app.</p>

              <div class="hero-actions">
                <ion-button class="primary-action" (click)="onSectionLink($event, 'services')">
                  Explore services
                  <ion-icon name="arrow-forward-outline" slot="end"></ion-icon>
                </ion-button>
                <ion-button routerLink="/auth/signup" fill="outline" class="secondary-action">
                  Become a driver
                </ion-button>
              </div>

              <p class="hero-note">
                <ion-icon name="location-outline" aria-hidden="true"></ion-icon>
                <span>Available services vary by location.</span>
              </p>

              <ul class="hero-services" aria-label="Movabi services">
                @for (service of heroServices; track service.label) {
                  <li>
                    <ion-icon [name]="service.icon" aria-hidden="true"></ion-icon>
                    <span>{{ service.label }}</span>
                  </li>
                }
              </ul>
            </div>

            <div class="hero-media">
              <img
                src="/assets/images/movabi-about-hero.webp"
                alt="A Movabi driver smiling at the wheel while driving through the city"
                width="517"
                height="378"
                decoding="async"
                (error)="heroImageFailed.set(true)"
                [class.is-hidden]="heroImageFailed()"
              >
            </div>
          </div>
        </section>

        <section class="value-strip" id="why">
          @for (item of valuePoints; track item.title) {
            <article class="value-card">
              <ion-icon [name]="item.icon"></ion-icon>
              <h2>{{ item.title }}</h2>
              <p>{{ item.copy }}</p>
            </article>
          }
        </section>

        <section class="price-story">
          <div class="section-copy">
            <p class="eyebrow">Built to be more affordable</p>
            <h2>Transparent pricing without confusing surge moments.</h2>
            <p>
              Movabi is designed around fixed or clearly estimated fares, admin-managed local pricing and lower-cost
              service options such as bike delivery, standard car, XL and van. The goal is simple: make everyday local
              movement cheaper than many traditional ride or delivery choices while still paying drivers fairly.
            </p>
          </div>

          <div class="comparison-grid" aria-label="Movabi pricing advantages">
            @for (item of priceAdvantages; track item.title) {
              <article>
                <span>{{ item.stat }}</span>
                <h3>{{ item.title }}</h3>
                <p>{{ item.copy }}</p>
              </article>
            }
          </div>
        </section>

        <section class="service-section" id="services">
          <div class="section-heading">
            <p class="eyebrow">One app, four high-frequency services</p>
            <h2>Choose what needs moving and Movabi adapts the booking flow.</h2>
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

        <section class="audience-section">
          <article class="audience-copy">
            <p class="eyebrow">For customers</p>
            <h2>Less waiting, fewer surprises, more control.</h2>
            <p>
              Movabi explains the job before you pay, keeps your reservation protected, and shows live status in plain
              English until the service is finished.
            </p>
            <ul>
              @for (item of customerBenefits; track item) {
                <li><ion-icon name="checkmark-circle-outline"></ion-icon>{{ item }}</li>
              }
            </ul>
            <ion-button routerLink="/auth/signup" class="primary-action">Create customer account</ion-button>
          </article>

          <div class="image-panel">
            <img src="/assets/images/movabi-customer.png" alt="Customer using Movabi in a car" loading="lazy">
          </div>
        </section>

        <section class="audience-section driver-layout" id="drivers">
          <div class="image-panel">
            <img src="/assets/images/movabi-driver.png" alt="Movabi driver earning from local jobs" loading="lazy">
          </div>

          <article class="audience-copy driver-copy">
            <p class="eyebrow">For drivers and couriers</p>
            <h2>A clearer way to earn from local demand.</h2>
            <p>
              Drivers can register by vehicle type, receive jobs that match their profile, navigate, chat, complete
              with customer PIN verification, and track payouts.
            </p>
            <ul>
              @for (item of driverBenefits; track item) {
                <li><ion-icon name="checkmark-circle-outline"></ion-icon>{{ item }}</li>
              }
            </ul>
            <ion-button routerLink="/auth/signup" class="dark-action">Apply as driver</ion-button>
          </article>
        </section>

        <section class="investor-section" id="investors">
          <div class="section-heading">
            <p class="eyebrow">Investor view</p>
            <h2>Movabi combines local mobility, logistics and errands in one operating system.</h2>
            <p>
              The same dispatch, wallet, pricing, driver verification, live tracking and admin controls support
              multiple revenue lines. That gives Movabi room to grow city by city without building a separate app for
              every service.
            </p>
          </div>

          <div class="investor-grid">
            @for (item of investorPoints; track item.title) {
              <article>
                <ion-icon [name]="item.icon"></ion-icon>
                <h3>{{ item.title }}</h3>
                <p>{{ item.copy }}</p>
              </article>
            }
          </div>
        </section>

        <section class="download-section" id="download">
          <div>
            <p class="eyebrow">Download Movabi</p>
            <h2>Start as a customer or driver from the same app.</h2>
            <p>
              Use Movabi on mobile to book, track, chat, pay, earn and manage your account. Web sign-up is available
              now while the native store listings are prepared.
            </p>
          </div>

          <div class="download-actions">
            @for (link of downloadLinks; track link.label) {
              <a [href]="link.href" target="_blank" rel="noopener" class="store-link">
                <ion-icon [name]="link.icon"></ion-icon>
                <span>
                  <small>{{ link.kicker }}</small>
                  <strong>{{ link.label }}</strong>
                </span>
              </a>
            }
            <a routerLink="/auth/signup" class="store-link web-link">
              <ion-icon name="phone-portrait-outline"></ion-icon>
              <span>
                <small>Start on web</small>
                <strong>Create account</strong>
              </span>
            </a>
          </div>
        </section>

        <section class="final-cta">
          <p class="eyebrow">A practical competitor for everyday movement</p>
          <h2>Movabi makes local transport easier to buy, easier to deliver and easier to scale.</h2>
          <div class="hero-actions centered">
            <ion-button routerLink="/auth/signup" class="primary-action">Join Movabi</ion-button>
            <ion-button routerLink="/help" fill="outline" class="secondary-action light">How it works</ion-button>
          </div>
          <footer>
            <a routerLink="/privacy">Privacy</a>
            <a routerLink="/help">Help</a>
            <a routerLink="/auth/login">Sign in</a>
            <a routerLink="/admin">Admin</a>
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
      background: rgba(244, 246, 248, 0.94);
      border-bottom: 1px solid #e5e7eb;
      backdrop-filter: blur(18px);
    }

    a {
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
      background: #f59e0b;
      color: #111827;
      font-size: 1.45rem;
      box-shadow: 0 10px 24px rgba(245, 158, 11, 0.28);
    }

    .brand-row strong {
      display: block;
      font-size: 1.45rem;
      font-weight: 900;
      line-height: 1;
    }

    .brand-row small {
      display: none;
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

    /* ---- Hero: navy canvas, amber accents, photograph on the right ---- */
    .hero {
      position: relative;
      isolation: isolate;
      /* Navy fallback paints first and always, so the hero is complete even if
         the photograph is missing or fails to load. */
      background: #0b1b33;
      color: #f8fafc;
      overflow: hidden;
    }

    /* Controlled navy gradient: keeps a warm amber glow at the left, holds
       contrast behind the copy, then eases toward the photograph. */
    .hero::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: -1;
      background:
        radial-gradient(120% 95% at 10% 12%, rgba(245, 158, 11, 0.18), transparent 55%),
        linear-gradient(100deg, #0b1b33 0%, #0f2445 44%, rgba(15, 36, 69, 0.74) 60%, rgba(11, 27, 51, 0.3) 100%);
      pointer-events: none;
    }

    .hero-inner {
      position: relative;
      width: min(1180px, calc(100% - 36px));
      margin: 0 auto;
      padding: 52px 0;
      display: grid;
      gap: 30px;
      align-items: center;
    }

    .hero-copy {
      max-width: 620px;
    }

    .hero-eyebrow {
      margin: 0 0 14px;
      color: #fbbf24;
      font-weight: 900;
      font-size: 0.74rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    .hero-title {
      margin: 0;
      max-width: 20ch;
      color: #ffffff;
      font-weight: 900;
      line-height: 1.05;
      letter-spacing: -0.01em;
      font-size: clamp(2.5rem, 6.2vw, 4rem);
    }

    .hero-lede {
      margin: 16px 0 0;
      max-width: 46ch;
      color: #dbe4f0;
      font-size: clamp(1rem, 2.2vw, 1.18rem);
      line-height: 1.7;
      font-weight: 700;
    }

    .hero-note {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 20px 0 0;
      color: #b6c5da;
      font-size: 0.86rem;
      font-weight: 800;
    }

    .hero-note ion-icon {
      color: #fbbf24;
      font-size: 1.05rem;
      flex-shrink: 0;
    }

    .hero-services {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 22px 0 0;
      padding: 0;
      list-style: none;
    }

    .hero-services li {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #f8fafc;
      font-size: 0.86rem;
      font-weight: 800;
      white-space: nowrap;
    }

    .hero-services li ion-icon {
      color: #fbbf24;
      font-size: 1.05rem;
    }

    .hero-media {
      position: relative;
      width: 100%;
      border-radius: 28px;
      overflow: hidden;
      /* Navy fallback for the media panel itself. */
      background: linear-gradient(150deg, #14305a, #0b1b33);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 30px 60px rgba(2, 8, 20, 0.45);
      aspect-ratio: 5 / 4;
    }

    .hero-media img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      /* Keep the driver's face and the wheel in frame. */
      object-position: 62% 30%;
    }

    .hero-media img.is-hidden {
      display: none;
    }

    /* Visible keyboard focus for every hero control. */
    .hero a:focus-visible,
    .hero ion-button:focus-visible,
    .hero ion-button::part(native):focus-visible {
      outline: 3px solid #fbbf24;
      outline-offset: 3px;
      border-radius: 8px;
    }

    .hero ion-button.primary-action::part(native):focus-visible,
    .hero ion-button.secondary-action::part(native):focus-visible {
      border-radius: 18px;
    }

    .eyebrow {
      margin: 0 0 12px;
      color: #c2410c;
      font-weight: 900;
      font-size: 0.74rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .final-cta .eyebrow {
      color: #fbbf24;
    }

    h1,
    h2,
    h3,
    p {
      letter-spacing: 0;
    }

    /* Same-page section targets: clear the sticky top navigation when scrolled
       into view, so no heading lands underneath it. */
    #why,
    #services,
    #drivers,
    #investors,
    #download {
      scroll-margin-top: 88px;
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
    .dark-action,
    .secondary-action {
      --border-radius: 18px;
      height: 56px;
      font-weight: 900;
      letter-spacing: 0;
    }

    .primary-action {
      --background: #f59e0b;
      --color: #111827;
      box-shadow: 0 16px 32px rgba(245, 158, 11, 0.24);
    }

    .dark-action {
      --background: #111827;
      --color: white;
    }

    .secondary-action {
      --border-color: rgba(255, 255, 255, 0.7);
      --color: white;
      --background: rgba(255, 255, 255, 0.08);
    }

    .secondary-action.light {
      --border-color: rgba(255, 255, 255, 0.72);
      --color: white;
    }

    .value-strip,
    .price-story,
    .service-section,
    .audience-section,
    .investor-section,
    .download-section {
      width: min(1180px, calc(100% - 36px));
      margin: 0 auto;
      padding: 54px 0;
    }

    .value-strip,
    .comparison-grid,
    .service-grid,
    .investor-grid,
    .download-actions {
      display: grid;
      gap: 16px;
    }

    .value-card,
    .comparison-grid article,
    .service-card,
    .audience-copy,
    .investor-grid article,
    .download-section,
    .store-link {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 28px;
      box-shadow: 0 16px 34px rgba(15, 23, 42, 0.06);
    }

    .value-card,
    .comparison-grid article,
    .service-card,
    .audience-copy,
    .investor-grid article {
      padding: 24px;
    }

    .value-card ion-icon,
    .investor-grid ion-icon {
      width: 54px;
      height: 54px;
      padding: 14px;
      border-radius: 20px;
      background: #fff7ed;
      color: #c2410c;
      font-size: 1.4rem;
    }

    .section-heading,
    .section-copy {
      max-width: 780px;
      margin-bottom: 24px;
    }

    .section-heading h2,
    .section-copy h2,
    .audience-copy h2,
    .investor-section h2,
    .download-section h2,
    .final-cta h2 {
      margin: 0;
      color: #111827;
      font-size: clamp(1.85rem, 6vw, 3.35rem);
      line-height: 1.05;
      font-weight: 900;
    }

    .section-heading p,
    .section-copy p,
    .value-card p,
    .comparison-grid p,
    .service-card p,
    .audience-copy p,
    .audience-copy li,
    .investor-grid p,
    .download-section p,
    .final-cta p {
      color: #64748b;
      line-height: 1.68;
      font-weight: 700;
    }

    .comparison-grid article span {
      color: #c2410c;
      font-size: 2rem;
      font-weight: 900;
    }

    .comparison-grid article h3,
    .value-card h2,
    .service-card strong,
    .investor-grid h3 {
      color: #111827;
      font-weight: 900;
    }

    .service-card {
      min-height: 230px;
      display: flex;
      flex-direction: column;
      color: #111827;
    }

    .service-icon {
      width: 74px;
      height: 74px;
      border-radius: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 1.9rem;
      margin-bottom: 18px;
    }

    .ride { background: #f59e0b; color: #111827; }
    .errand { background: #10b981; }
    .delivery { background: #0f766e; }
    .moving { background: #111827; }

    .service-card strong {
      font-size: 1.28rem;
    }

    .card-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: auto;
      color: #c2410c;
      font-weight: 900;
    }

    .audience-section {
      display: grid;
      gap: 18px;
      align-items: center;
    }

    .audience-copy ul {
      display: grid;
      gap: 12px;
      margin: 22px 0;
      padding: 0;
      list-style: none;
    }

    .audience-copy li {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }

    .audience-copy li ion-icon {
      color: #10b981;
      font-size: 1.2rem;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .driver-copy {
      background: #111827;
      color: white;
    }

    .driver-copy h2,
    .driver-copy li {
      color: white;
    }

    .driver-copy p {
      color: #cbd5e1;
    }

    .image-panel {
      overflow: hidden;
      border-radius: 32px;
      background: #e2e8f0;
      box-shadow: 0 24px 48px rgba(15, 23, 42, 0.12);
    }

    .image-panel img {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 11;
      object-fit: cover;
    }

    .investor-section {
      border-radius: 36px;
      padding: 42px 24px;
      background: #111827;
      color: white;
    }

    .investor-section .section-heading h2,
    .investor-section .investor-grid h3 {
      color: white;
    }

    .investor-section .section-heading p,
    .investor-section .investor-grid p {
      color: #cbd5e1;
    }

    .investor-grid article {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.12);
      box-shadow: none;
    }

    .download-section {
      display: grid;
      gap: 22px;
      padding: 30px;
      align-items: center;
    }

    .store-link {
      display: flex;
      align-items: center;
      gap: 14px;
      min-height: 78px;
      padding: 16px;
      color: #111827;
    }

    .store-link ion-icon {
      width: 48px;
      height: 48px;
      padding: 12px;
      border-radius: 18px;
      background: #fff7ed;
      color: #c2410c;
    }

    .store-link small {
      display: block;
      color: #64748b;
      font-weight: 900;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .store-link strong {
      display: block;
      margin-top: 3px;
      font-size: 1.1rem;
      font-weight: 900;
    }

    .web-link {
      border-color: #fed7aa;
      background: #fff7ed;
    }

    .final-cta {
      text-align: center;
      background: #111827;
      color: white;
      padding: 58px 18px;
      margin-top: 24px;
    }

    .final-cta h2 {
      max-width: 900px;
      margin-left: auto;
      margin-right: auto;
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

    @media (max-width: 430px) {
      .brand-row strong {
        font-size: 1.25rem;
      }
    }

    @media (min-width: 640px) {
      .brand-row small {
        display: block;
      }

      .hero-actions {
        flex-direction: row;
      }

      .value-strip,
      .comparison-grid,
      .download-actions {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .download-section {
        grid-template-columns: 1fr 1.2fr;
      }
    }

    @media (min-width: 860px) {
      .desktop-nav {
        display: flex;
      }

      .icon-nav-btn {
        display: none;
      }

      .hero-inner {
        grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
        gap: 48px;
        padding: 76px 0;
      }

      .service-grid,
      .investor-grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .audience-section {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `]
})
export class AdminMovabiAboutComponent {
  menuOpen = signal(false);

  /** True once the hero photograph fails to load: the navy panel stays visible. */
  heroImageFailed = signal(false);

  private route = inject(ActivatedRoute);

  /**
   * In-page section navigation for the public About page.
   *
   * Every section link carries its real destination (`/about-movabi#section`) so
   * opening it in a new tab, copying it or sharing it resolves correctly — a
   * bare `href="#section"` would resolve against Angular's `<base href="/">` to
   * `/#section`. A plain primary click is intercepted for a smooth in-page
   * scroll; modified clicks (ctrl/cmd/shift/alt) and non-primary buttons are
   * left entirely to the browser so open-in-new-tab keeps working.
   */
  onSectionLink(event: MouseEvent, id: string, options?: { closeMenu?: boolean }): void {
    if (options?.closeMenu) this.menuOpen.set(false);

    const isModifiedOrNonPrimary =
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey;

    if (isModifiedOrNonPrimary) return;

    const target = typeof document !== 'undefined' ? document.getElementById(id) : null;
    if (!target) return;

    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Scroll to an existing section without changing global router scroll config. */
  private scrollToSection(id: string): void {
    if (typeof document === 'undefined') return;
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }

  heroServices = [
    { label: 'Ride', icon: 'car-outline' },
    { label: 'Errands', icon: 'basket-outline' },
    { label: 'Delivery', icon: 'cube-outline' },
    { label: 'Moving', icon: 'storefront-outline' }
  ];

  valuePoints = [
    {
      title: 'One account for daily movement',
      copy: 'Book a ride, send a package, ask for shopping help or move bulky items without learning a different app each time.',
      icon: 'phone-portrait-outline'
    },
    {
      title: 'Cheaper by design',
      copy: 'Local pricing, vehicle choice and no confusing surge messaging help Movabi compete hard on everyday affordability.',
      icon: 'cash-outline'
    },
    {
      title: 'Built for trust',
      copy: 'Driver profiles, live location, chat, payment holds, wallet refunds and completion PINs make each job easier to understand.',
      icon: 'shield-checkmark-outline'
    }
  ];

  priceAdvantages = [
    {
      stat: 'No surge',
      title: 'Simple fare story',
      copy: 'Movabi prioritises upfront fares and admin-controlled pricing so customers know what they are agreeing to.'
    },
    {
      stat: 'Right size',
      title: 'Pay for the vehicle you need',
      copy: 'Bike, car, XL, small van and large van options stop customers overpaying for the wrong type of transport.'
    },
    {
      stat: 'Local',
      title: 'City-by-city control',
      copy: 'Pricing can be tuned by service and region, giving Movabi a practical way to stay competitive in each launch market.'
    }
  ];

  services = [
    {
      title: 'Book a ride',
      copy: 'Choose pickup and destination, see the fare, pay securely and track your driver.',
      icon: 'car-outline',
      tone: 'ride'
    },
    {
      title: 'Run an errand',
      copy: 'Reserve an item budget, let a driver shop, approve changes and receive your items.',
      icon: 'basket-outline',
      tone: 'errand'
    },
    {
      title: 'Send a package',
      copy: 'Book bike, car or van delivery for parcels, documents and local handovers.',
      icon: 'cube-outline',
      tone: 'delivery'
    },
    {
      title: 'Book a move',
      copy: 'Request van moving help with the right vehicle size and clear route details.',
      icon: 'storefront-outline',
      tone: 'moving'
    }
  ];

  customerBenefits = [
    'Clear price or item budget before confirming.',
    'Wallet and card payment protection with plain refund status.',
    'Live tracking, driver details, chat and service-specific updates.',
    'Customer handover PIN before completion for extra delivery security.'
  ];

  driverBenefits = [
    'Register with bike, car, XL or van profile so requests match your vehicle.',
    'Accept, pass, navigate, chat and complete jobs from one simple driver hub.',
    'Stripe Connect payouts and Movabi Pay support for approved errand budgets.',
    'Customer PIN completion reduces disputes and protects genuine work.'
  ];

  investorPoints = [
    {
      title: 'Multi-service demand',
      copy: 'The same customer can use Movabi for rides, errands, delivery and moving, improving repeat usage potential.',
      icon: 'people-outline'
    },
    {
      title: 'Configurable pricing',
      copy: 'Admin-managed service pricing supports local market strategy and a cheaper-than-incumbent positioning.',
      icon: 'analytics-outline'
    },
    {
      title: 'Driver supply utility',
      copy: 'Drivers can earn across service categories that match their vehicle, increasing utilisation beyond ride-only demand.',
      icon: 'trending-up-outline'
    },
    {
      title: 'Scalable platform layer',
      copy: 'Dispatch, wallet, verification, live tracking, chat, payouts and admin monitoring are shared across services.',
      icon: 'rocket-outline'
    }
  ];

  downloadLinks = [
    {
      kicker: 'Download on',
      label: 'App Store',
      href: 'https://apps.apple.com/gb/search?term=Movabi',
      icon: 'download-outline'
    },
    {
      kicker: 'Get it on',
      label: 'Google Play',
      href: 'https://play.google.com/store/search?q=Movabi&c=apps',
      icon: 'download-outline'
    }
  ];

  constructor() {
    addIcons({
      analyticsOutline,
      arrowForwardOutline,
      basketOutline,
      car,
      carOutline,
      cardOutline,
      cashOutline,
      chatbubbleEllipsesOutline,
      checkmarkCircleOutline,
      chevronForwardOutline,
      closeOutline,
      cubeOutline,
      downloadOutline,
      helpCircleOutline,
      locationOutline,
      lockClosedOutline,
      menuOutline,
      peopleOutline,
      phonePortraitOutline,
      rocketOutline,
      shieldCheckmarkOutline,
      storefrontOutline,
      trendingUpOutline,
      walletOutline
    });

    // Landing on /about-movabi#section (direct entry, refresh, or a new tab)
    // must reach that section once it has rendered — the element does not exist
    // yet when the browser first resolves the fragment.
    afterNextRender(() => {
      const fragment = this.route.snapshot.fragment;
      if (fragment) this.scrollToSection(fragment);
    });
  }
}
