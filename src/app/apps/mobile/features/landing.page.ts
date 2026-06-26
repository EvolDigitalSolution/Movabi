import { CommonModule } from '@angular/common';
import { Component, signal } from '@angular/core';
import { RouterModule } from '@angular/router';
import { IonButton, IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  arrowForwardOutline,
  carSportOutline,
  cardOutline,
  cartOutline,
  checkmarkCircleOutline,
  cubeOutline,
  peopleOutline,
  shieldCheckmarkOutline,
  storefrontOutline
} from 'ionicons/icons';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, RouterModule, IonContent, IonIcon, IonButton],
  template: `
    <ion-content class="landing-page">
      <main class="landing-shell">
        <header class="landing-header">
          <div class="brand-lockup">
            <span class="brand-mark">
              <ion-icon name="car-sport-outline"></ion-icon>
            </span>
            <div>
              <strong>Movabi</strong>
              <small>Ride. Errand. Delivery. Moving.</small>
            </div>
          </div>

          <ion-button routerLink="/auth/login" fill="clear" class="signin-link">Sign in</ion-button>
        </header>

        <section class="hero-card">
          <div class="hero-visual">
            <span class="road-line"></span>
            <span class="car-badge">
              <ion-icon name="car-sport-outline"></ion-icon>
            </span>
            <span class="pin pin-a"></span>
            <span class="pin pin-b"></span>
          </div>

          <p class="eyebrow">{{ slides[activeSlide()].eyebrow }}</p>
          <h1>{{ slides[activeSlide()].title }}</h1>
          <p class="hero-copy">{{ slides[activeSlide()].copy }}</p>

          <div class="carousel-controls" aria-label="Landing carousel controls">
            <button type="button" (click)="previousSlide()" aria-label="Previous slide">
              <ion-icon name="arrow-back-outline"></ion-icon>
            </button>
            <div class="dots">
              @for (slide of slides; track slide.title; let i = $index) {
                <button
                  type="button"
                  [class.active]="i === activeSlide()"
                  (click)="activeSlide.set(i)"
                  [attr.aria-label]="'Show slide ' + (i + 1)"
                ></button>
              }
            </div>
            <button type="button" (click)="nextSlide()" aria-label="Next slide">
              <ion-icon name="arrow-forward-outline"></ion-icon>
            </button>
          </div>
        </section>

        <section class="action-panel">
          <ion-button routerLink="/auth/signup" expand="block" class="primary-action">
            Create account
            <ion-icon name="arrow-forward-outline" slot="end"></ion-icon>
          </ion-button>
          <ion-button routerLink="/auth/login" expand="block" fill="outline" class="secondary-action">
            I already have an account
          </ion-button>
        </section>

        <section class="service-carousel" aria-label="Movabi services">
          @for (service of services; track service.title) {
            <article>
              <span [ngClass]="service.tone">
                <ion-icon [name]="service.icon"></ion-icon>
              </span>
              <strong>{{ service.title }}</strong>
              <p>{{ service.copy }}</p>
            </article>
          }
        </section>

        <section class="trust-card">
          <h2>Built for everyday local movement</h2>
          @for (point of trustPoints; track point) {
            <p><ion-icon name="checkmark-circle-outline"></ion-icon>{{ point }}</p>
          }
        </section>

        <footer>
          <a routerLink="/help">How it works</a>
          <a routerLink="/privacy">Privacy</a>
          <a routerLink="/about-movabi">About Movabi</a>
        </footer>
      </main>
    </ion-content>
  `,
  styles: [`
    .landing-page {
      --background: #f8fafc;
    }

    .landing-shell {
      min-height: 100%;
      padding: max(1rem, env(safe-area-inset-top)) 1rem max(1.25rem, env(safe-area-inset-bottom));
      color: #0f172a;
    }

    .landing-header,
    .brand-lockup,
    .carousel-controls,
    .dots,
    footer {
      display: flex;
      align-items: center;
    }

    .landing-header {
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 1rem;
    }

    .brand-lockup {
      gap: 0.75rem;
      min-width: 0;
    }

    .brand-mark,
    .car-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: white;
      background: linear-gradient(135deg, #f97316, #0f172a);
      box-shadow: 0 16px 30px rgba(15, 23, 42, 0.16);
    }

    .brand-mark {
      width: 3.25rem;
      height: 3.25rem;
      border-radius: 1.35rem;
      font-size: 1.8rem;
      flex: 0 0 auto;
    }

    .brand-lockup strong {
      display: block;
      font: 900 1.8rem/1 "Outfit", sans-serif;
      letter-spacing: 0;
    }

    .brand-lockup small {
      display: block;
      max-width: 13rem;
      color: #64748b;
      font-size: 0.76rem;
      font-weight: 800;
    }

    .signin-link {
      --color: #c2410c;
      font-weight: 900;
      min-width: 4.5rem;
    }

    .hero-card,
    .trust-card,
    .service-carousel article {
      background: white;
      border: 1px solid #e2e8f0;
      box-shadow: 0 20px 55px rgba(15, 23, 42, 0.08);
    }

    .hero-card {
      position: relative;
      overflow: hidden;
      border-radius: 2rem;
      padding: 1rem;
    }

    .hero-visual {
      position: relative;
      min-height: 15rem;
      border-radius: 1.5rem;
      overflow: hidden;
      background:
        radial-gradient(circle at 20% 18%, rgba(249, 115, 22, 0.36), transparent 28%),
        radial-gradient(circle at 76% 72%, rgba(16, 185, 129, 0.24), transparent 26%),
        linear-gradient(135deg, #111827, #1e293b 55%, #f59e0b);
      margin-bottom: 1.25rem;
    }

    .road-line {
      position: absolute;
      left: 8%;
      right: 8%;
      top: 54%;
      height: 0.42rem;
      border-radius: 999px;
      background: repeating-linear-gradient(90deg, white 0 2rem, transparent 2rem 3rem);
      opacity: 0.72;
      transform: rotate(-10deg);
    }

    .car-badge {
      position: absolute;
      left: 50%;
      top: 46%;
      width: 5.8rem;
      height: 5.8rem;
      border-radius: 2rem;
      font-size: 3rem;
      transform: translate(-50%, -50%);
      border: 1px solid rgba(255, 255, 255, 0.24);
    }

    .pin {
      position: absolute;
      width: 1rem;
      height: 1rem;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 0 0.55rem rgba(16, 185, 129, 0.18);
    }

    .pin-a { left: 18%; bottom: 22%; }
    .pin-b { right: 18%; top: 24%; background: #f97316; box-shadow: 0 0 0 0.55rem rgba(249, 115, 22, 0.18); }

    .eyebrow {
      margin: 0 0 0.7rem;
      color: #c2410c;
      font-size: 0.78rem;
      font-weight: 900;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      color: #0f172a;
      font-size: clamp(2.2rem, 12vw, 4.4rem);
      line-height: 0.95;
      letter-spacing: 0;
    }

    .hero-copy {
      margin: 1rem 0;
      color: #475569;
      font-size: 1rem;
      font-weight: 650;
      line-height: 1.55;
    }

    .carousel-controls {
      justify-content: space-between;
      gap: 1rem;
      margin-top: 1rem;
    }

    .carousel-controls button {
      border: 0;
      color: #0f172a;
      background: #f8fafc;
      border-radius: 1rem;
      min-width: 2.75rem;
      min-height: 2.75rem;
      font-size: 1.25rem;
      font-weight: 900;
    }

    .dots {
      gap: 0.45rem;
    }

    .dots button {
      width: 0.65rem;
      min-width: 0.65rem;
      height: 0.65rem;
      min-height: 0.65rem;
      padding: 0;
      border-radius: 999px;
      background: #cbd5e1;
    }

    .dots button.active {
      width: 2rem;
      min-width: 2rem;
      background: #f59e0b;
    }

    .action-panel {
      display: grid;
      gap: 0.8rem;
      margin: 1rem 0;
    }

    ion-button {
      min-height: 3.5rem;
      font-weight: 900;
      letter-spacing: 0;
    }

    .primary-action {
      --background: #f59e0b;
      --background-activated: #d97706;
      --color: #111827;
      --border-radius: 1.25rem;
      --box-shadow: 0 18px 34px rgba(245, 158, 11, 0.24);
    }

    .secondary-action {
      --border-radius: 1.25rem;
      --border-color: #fed7aa;
      --color: #9a3412;
    }

    .service-carousel {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(13rem, 72%);
      gap: 0.8rem;
      overflow-x: auto;
      padding: 0.25rem 0 1rem;
      scroll-snap-type: x mandatory;
    }

    .service-carousel article {
      scroll-snap-align: start;
      border-radius: 1.35rem;
      padding: 1rem;
    }

    .service-carousel span {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 3.5rem;
      height: 3.5rem;
      border-radius: 1.25rem;
      font-size: 1.8rem;
      color: white;
      margin-bottom: 1rem;
    }

    .tone-ride { background: #f97316; }
    .tone-errand { background: #059669; }
    .tone-delivery { background: #ea580c; }
    .tone-moving { background: #334155; }

    .service-carousel strong {
      display: block;
      color: #0f172a;
      font: 900 1.1rem/1.15 "Outfit", sans-serif;
    }

    .service-carousel p,
    .trust-card p {
      margin: 0.45rem 0 0;
      color: #64748b;
      font-size: 0.9rem;
      font-weight: 700;
      line-height: 1.45;
    }

    .trust-card {
      border-radius: 1.5rem;
      padding: 1rem;
      margin-top: 0.25rem;
    }

    .trust-card h2 {
      margin: 0 0 0.75rem;
      font-size: 1.25rem;
    }

    .trust-card p {
      display: flex;
      align-items: flex-start;
      gap: 0.55rem;
      color: #475569;
    }

    .trust-card ion-icon {
      color: #059669;
      flex: 0 0 auto;
      margin-top: 0.15rem;
    }

    footer {
      justify-content: center;
      flex-wrap: wrap;
      gap: 1rem;
      padding: 1.25rem 0 0.25rem;
    }

    footer a {
      color: #c2410c;
      font-size: 0.85rem;
      font-weight: 900;
      text-decoration: none;
    }

    @media (min-width: 760px) {
      .landing-shell {
        max-width: 54rem;
        margin: 0 auto;
      }

      .service-carousel {
        grid-auto-flow: initial;
        grid-template-columns: repeat(4, 1fr);
        overflow: visible;
      }
    }
  `]
})
export class LandingPage {
  activeSlide = signal(0);

  slides = [
    {
      eyebrow: 'Cheaper local movement',
      title: 'Move, shop and deliver without the usual stress.',
      copy: 'Movabi brings rides, errands, package delivery and moving help into one simple app with clear pricing.'
    },
    {
      eyebrow: 'Track every step',
      title: 'Know what is happening from request to finish.',
      copy: 'Customers see live progress, driver details and payment protection. Drivers get guided steps for each service.'
    },
    {
      eyebrow: 'Built for drivers too',
      title: 'Earn from the vehicle you already use.',
      copy: 'Bike, car, XL and van drivers receive matching jobs, navigation, chat, wallet tools and Stripe payouts.'
    }
  ];

  services = [
    { title: 'Book a Ride', copy: 'Fixed or clear estimated pricing.', icon: 'car-sport-outline', tone: 'tone-ride' },
    { title: 'Run an Errand', copy: 'Shop, collect or deliver locally.', icon: 'cart-outline', tone: 'tone-errand' },
    { title: 'Send a Package', copy: 'Bike, car or van delivery.', icon: 'cube-outline', tone: 'tone-delivery' },
    { title: 'Book a Move', copy: 'Moving help by van size.', icon: 'storefront-outline', tone: 'tone-moving' }
  ];

  trustPoints = [
    'Wallet-first payment where available, with protected card authorisation fallback.',
    'Customer completion PIN for safer handover and service finish.',
    'Country-aware pricing and service options for multi-city rollout.'
  ];

  constructor() {
    addIcons({
      arrowBackOutline,
      arrowForwardOutline,
      carSportOutline,
      cardOutline,
      cartOutline,
      checkmarkCircleOutline,
      cubeOutline,
      peopleOutline,
      shieldCheckmarkOutline,
      storefrontOutline
    });
  }

  nextSlide(): void {
    this.activeSlide.update(index => (index + 1) % this.slides.length);
  }

  previousSlide(): void {
    this.activeSlide.update(index => (index - 1 + this.slides.length) % this.slides.length);
  }
}
