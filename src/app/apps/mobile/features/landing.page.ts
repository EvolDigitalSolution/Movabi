import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { AuthService } from '@core/services/auth/auth.service';
import {
    IonContent,
    IonIcon,
    IonButton
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
    car,
    carOutline,
    basketOutline,
    cubeOutline,
    checkmarkCircle,
    shieldCheckmark,
    trendingUp,
    arrowForwardOutline,
    flashOutline,
    locationOutline,
    peopleOutline,
    logoApple,
    logoGooglePlaystore
} from 'ionicons/icons';

@Component({
    selector: 'app-landing',
    standalone: true,
    imports: [
        CommonModule,
        RouterModule,
        IonContent,
        IonIcon,
        IonButton
    ],
    template: `
    <ion-content class="landing-content">
      <div class="landing-shell">

        <!-- HERO -->
        <section class="hero-section">
          <div class="hero-media">
            <div class="hero-image-frame">
              <img
                src="assets/images/movabi-hero.png"
                alt="Movabi hero"
                class="hero-image"
              />
            </div>
            <div class="hero-overlay"></div>
            <div class="hero-glow hero-glow-left"></div>
            <div class="hero-glow hero-glow-right"></div>
          </div>

          <div class="hero-inner">
            <div class="brand-row">
              <div class="brand-mark">
                <ion-icon name="car"></ion-icon>
              </div>
              <div>
                <div class="brand-name">Movabi</div>
                <div class="brand-tag">MOVE SMARTER</div>
              </div>
            </div>

            <div class="hero-pill">
              <span class="hero-pill-dot"></span>
              <span>Rides • Errands • Delivery • Van Moving</span>
            </div>

            <h1 class="hero-title">
              Local movement,
              <span class="hero-title-accent">made simple.</span>
            </h1>

            <p class="hero-copy">
              Book trusted rides, run errands, send deliveries, or earn as a driver —
              all from one modern platform built for communities and everyday movement.
            </p>

            <div class="hero-stats">
              <div class="hero-stat">
                <ion-icon name="shield-checkmark" class="text-emerald-400"></ion-icon>
                <div>
                  <strong>Safe & Verified</strong>
                  <span>Trusted users and drivers</span>
                </div>
              </div>

              <div class="hero-stat">
                <ion-icon name="flash-outline" class="text-amber-400"></ion-icon>
                <div>
                  <strong>Fast Booking</strong>
                  <span>Simple request flow</span>
                </div>
              </div>

              <div class="hero-stat">
                <ion-icon name="location-outline" class="text-blue-400"></ion-icon>
                <div>
                  <strong>Live Updates</strong>
                  <span>Track every step</span>
                </div>
              </div>
            </div>

            <div class="hero-actions">
              <ion-button expand="block" class="hero-primary-btn" routerLink="/auth/signup">
                Book a Service
                <ion-icon name="arrow-forward-outline" slot="end"></ion-icon>
              </ion-button>

              <ion-button expand="block" fill="outline" class="hero-secondary-btn" routerLink="/auth/signup">
                Drive with Movabi
              </ion-button>
            </div>

            <div class="store-actions">
              <a [href]="appStoreUrl" target="_blank" rel="noopener noreferrer" class="store-badge">
                <ion-icon name="logo-apple"></ion-icon>
                <span>
                  <small>Download on the</small>
                  <strong>App Store</strong>
                </span>
              </a>

              <a [href]="googlePlayUrl" target="_blank" rel="noopener noreferrer" class="store-badge">
                <ion-icon name="logo-google-playstore"></ion-icon>
                <span>
                  <small>Get it on</small>
                  <strong>Google Play</strong>
                </span>
              </a>
            </div>

            <p class="hero-login">
              Already have an account?
              <a routerLink="/auth/login">Sign in</a>
            </p>
          </div>
        </section>

        <!-- FLOATING SERVICE CARDS -->
        <section class="service-stack-section">
          <div class="service-stack">
            <a routerLink="/auth/signup" class="service-float-card blue">
              <div class="service-icon blue">
                <ion-icon name="car-outline"></ion-icon>
              </div>
              <div class="service-float-text">
                <h3>Book a Ride</h3>
                <p>Fixed prices. No surge. Everyday trips made easy.</p>
              </div>
            </a>

            <a routerLink="/auth/signup" class="service-float-card emerald">
              <div class="service-icon emerald">
                <ion-icon name="basket-outline"></ion-icon>
              </div>
              <div class="service-float-text">
                <h3>Run an Errand</h3>
                <p>Shopping, pickups, pharmacy, and quick local tasks.</p>
              </div>
            </a>

            <a routerLink="/auth/signup" class="service-float-card amber">
              <div class="service-icon amber">
                <ion-icon name="cube-outline"></ion-icon>
              </div>
              <div class="service-float-text">
                <h3>Send a Delivery</h3>
                <p>Fast and secure movement for packages and documents.</p>
              </div>
            </a>
          </div>
        </section>

        <!-- TRUST STRIP -->
        <section class="trust-strip-section">
          <div class="trust-strip">
            <div class="trust-item">
              <div class="trust-value">Fixed</div>
              <div class="trust-label">fair pricing</div>
            </div>
            <div class="trust-item">
              <div class="trust-value">Fast</div>
              <div class="trust-label">local response</div>
            </div>
            <div class="trust-item">
              <div class="trust-value">Flexible</div>
              <div class="trust-label">driver plans</div>
            </div>
            <div class="trust-item">
              <div class="trust-value">One App</div>
              <div class="trust-label">many services</div>
            </div>
          </div>
        </section>

        <!-- SERVICES -->
        <section class="section-light">
          <div class="section-wrap">
            <p class="section-kicker">Quick Services</p>
            <h2 class="section-title">
              Everything you need to move through the day
            </h2>
            <p class="section-subtitle">
              Whether you need to get somewhere, send something, or have something done,
              Movabi gives you one place to start.
            </p>

            <div class="service-grid">
              <a routerLink="/auth/signup" class="service-card">
                <div class="service-card-icon blue">
                  <ion-icon name="car-outline"></ion-icon>
                </div>
                <h3>Book a Ride</h3>
                <p>Reliable local transport with upfront pricing.</p>
              </a>

              <a routerLink="/auth/signup" class="service-card">
                <div class="service-card-icon emerald">
                  <ion-icon name="basket-outline"></ion-icon>
                </div>
                <h3>Run an Errand</h3>
                <p>Let someone handle the task while you focus on your day.</p>
              </a>

              <a routerLink="/auth/signup" class="service-card">
                <div class="service-card-icon amber">
                  <ion-icon name="cube-outline"></ion-icon>
                </div>
                <h3>Send a Delivery</h3>
                <p>Quick package and item delivery you can track.</p>
              </a>
            </div>
          </div>
        </section>

        <!-- CUSTOMER -->
        <section class="section-white">
          <div class="section-wrap feature-layout">
            <div class="feature-copy">
              <p class="section-kicker blue">For Customers</p>
              <h2 class="section-title">
                Straightforward service. Clear pricing. Peace of mind.
              </h2>
              <p class="section-subtitle">
                From short rides to moving a van-load, Movabi is designed to keep things simple,
                visible, and dependable from booking to completion.
              </p>

              <div class="feature-list">
                <div class="feature-row">
                  <ion-icon name="checkmark-circle" class="text-emerald-500"></ion-icon>
                  <span>Know your fare before you confirm</span>
                </div>
                <div class="feature-row">
                  <ion-icon name="shield-checkmark" class="text-blue-500"></ion-icon>
                  <span>Trusted and monitored service experience</span>
                </div>
                <div class="feature-row">
                  <ion-icon name="location-outline" class="text-amber-500"></ion-icon>
                  <span>Track progress with live updates</span>
                </div>
              </div>

              <ion-button class="cta-btn" routerLink="/auth/signup">
                Start Booking
              </ion-button>
            </div>

            <div class="feature-image-shell">
              <img
                src="assets/images/movabi-customer.png"
                alt="Movabi customer service"
                class="feature-image"
              />
            </div>
          </div>
        </section>

        <!-- DRIVER -->
        <section class="section-dark">
          <div class="section-wrap feature-layout reverse-on-mobile">
            <div class="feature-image-shell dark">
              <img
                src="assets/images/movabi-driver.png"
                alt="Movabi driver partner"
                class="feature-image"
              />
            </div>

            <div class="feature-copy dark-copy">
              <p class="section-kicker amber">For Drivers</p>
              <h2 class="section-title dark-title">
                Earn on your terms with a platform built for growth.
              </h2>
              <p class="section-subtitle dark-subtitle">
                Drive flexibly, grow consistently, and choose the setup that works best
                for your lifestyle. Start small or go all-in.
              </p>

              <div class="driver-plans">
                <div class="driver-plan starter">
                  <div>
                    <h3>Starter</h3>
                    <p>Flexible, pay as you earn</p>
                  </div>
                  <span>Commission model</span>
                </div>

                <div class="driver-plan pro">
                  <div>
                    <h3>Pro</h3>
                    <p>Keep more of what you earn</p>
                  </div>
                  <span>Fixed monthly fee</span>
                </div>
              </div>

              <ion-button class="driver-btn" routerLink="/auth/signup">
                Become a Driver
                <ion-icon name="trending-up" slot="end"></ion-icon>
              </ion-button>
            </div>
          </div>
        </section>

        <!-- FINAL CTA -->
        <section class="final-cta">
          <div class="section-wrap final-cta-inner">
            <p class="section-kicker">Ready to move?</p>
            <h2 class="section-title final-title">
              Join Movabi and get moving with a platform built for real everyday needs.
            </h2>
            <p class="section-subtitle final-subtitle">
              One account. Multiple services. Better movement for customers and drivers alike.
            </p>

            <div class="final-actions">
              <ion-button class="cta-btn" routerLink="/auth/signup">
                Create Free Account
              </ion-button>
              <ion-button fill="outline" class="signin-btn" routerLink="/auth/login">
                Sign In
              </ion-button>
            </div>

            <div class="store-actions final-store-actions">
              <a [href]="appStoreUrl" target="_blank" rel="noopener noreferrer" class="store-badge light">
                <ion-icon name="logo-apple"></ion-icon>
                <span>
                  <small>Download on the</small>
                  <strong>App Store</strong>
                </span>
              </a>

              <a [href]="googlePlayUrl" target="_blank" rel="noopener noreferrer" class="store-badge light">
                <ion-icon name="logo-google-playstore"></ion-icon>
                <span>
                  <small>Get it on</small>
                  <strong>Google Play</strong>
                </span>
              </a>
            </div>

            <p class="footer-note">© 2026 Movabi Logistics Platform</p>
          </div>
        </section>

      </div>
    </ion-content>
  `,
    styles: [`
    ion-content.landing-content {
      --background: #020617;
    }

    .landing-shell {
      min-height: 100vh;
      background: #020617;
    }

    .hero-section {
      position: relative;
      min-height: 100vh;
      overflow: hidden;
    }

    .hero-media {
      position: absolute;
      inset: 0;
      background: #020617;
    }

    .hero-image-frame {
      position: absolute;
      inset: 0;
      padding: 0;
      background:
        radial-gradient(circle at top left, rgba(37, 99, 235, 0.18), transparent 28%),
        radial-gradient(circle at bottom right, rgba(16, 185, 129, 0.12), transparent 28%);
    }

    .hero-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: center center;
      display: block;
      padding: 18px 12px 0;
    }

    .hero-overlay {
      position: absolute;
      inset: 0;
      background:
        linear-gradient(to bottom, rgba(2, 6, 23, 0.22), rgba(2, 6, 23, 0.82)),
        linear-gradient(to right, rgba(2, 6, 23, 0.88), rgba(2, 6, 23, 0.36));
    }

    .hero-glow {
      position: absolute;
      border-radius: 9999px;
      filter: blur(72px);
      pointer-events: none;
    }

    .hero-glow-left {
      width: 240px;
      height: 240px;
      top: -60px;
      left: -60px;
      background: rgba(37, 99, 235, 0.22);
    }

    .hero-glow-right {
      width: 280px;
      height: 280px;
      bottom: -40px;
      right: -40px;
      background: rgba(16, 185, 129, 0.14);
    }

    .hero-inner {
      position: relative;
      z-index: 2;
      min-height: 100vh;
      max-width: 1180px;
      margin: 0 auto;
      padding: 20px 20px 40px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .brand-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 18px;
    }

    .brand-mark {
      width: 44px;
      height: 44px;
      border-radius: 18px;
      background: white;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #2563eb;
      font-size: 1.5rem;
      box-shadow: 0 16px 32px rgba(15, 23, 42, 0.18);
    }

    .brand-name {
      color: white;
      font-size: 1.8rem;
      font-weight: 900;
      letter-spacing: -0.03em;
    }

    .brand-tag {
      color: #cbd5e1;
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.25em;
      text-transform: uppercase;
    }

    .hero-pill {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      width: fit-content;
      padding: 10px 14px;
      border-radius: 9999px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.06);
      backdrop-filter: blur(14px);
      color: #e2e8f0;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      margin-bottom: 18px;
    }

    .hero-pill-dot {
      width: 8px;
      height: 8px;
      border-radius: 9999px;
      background: #34d399;
      flex-shrink: 0;
    }

    .hero-title {
      color: white;
      font-size: clamp(2.9rem, 8vw, 5.4rem);
      line-height: 0.95;
      font-weight: 900;
      letter-spacing: -0.04em;
      margin: 0 0 16px;
      text-shadow: 0 10px 30px rgba(0,0,0,0.45);
      max-width: 760px;
    }

    .hero-title-accent {
      color: #60a5fa;
    }

    .hero-copy {
      color: #cbd5e1;
      font-size: 1rem;
      line-height: 1.8;
      font-weight: 500;
      margin: 0 0 24px;
      max-width: 640px;
    }

    .hero-stats {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      margin-bottom: 24px;
      max-width: 720px;
    }

    .hero-stat {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      border-radius: 20px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      backdrop-filter: blur(12px);
    }

    .hero-stat ion-icon {
      font-size: 1.2rem;
      margin-top: 2px;
      flex-shrink: 0;
    }

    .hero-stat strong {
      display: block;
      color: white;
      font-size: 0.94rem;
      font-weight: 800;
      margin-bottom: 2px;
    }

    .hero-stat span {
      display: block;
      color: #94a3b8;
      font-size: 0.77rem;
      line-height: 1.4;
      font-weight: 600;
    }

    .hero-actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 14px;
      max-width: 520px;
    }

    .store-actions {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      max-width: 520px;
      margin: 10px 0 16px;
    }

    .store-badge {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 58px;
      padding: 12px 16px;
      border-radius: 18px;
      text-decoration: none;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.08);
      color: white;
      backdrop-filter: blur(14px);
      transition: transform 0.25s ease, border-color 0.25s ease, background 0.25s ease;
    }

    .store-badge:hover {
      transform: translateY(-2px);
      border-color: rgba(255,255,255,0.22);
      background: rgba(255,255,255,0.12);
    }

    .store-badge.light {
      border: 1px solid #e2e8f0;
      background: white;
      color: #0f172a;
      box-shadow: 0 12px 24px rgba(15, 23, 42, 0.06);
    }

    .store-badge ion-icon {
      font-size: 1.5rem;
      flex-shrink: 0;
    }

    .store-badge span {
      display: flex;
      flex-direction: column;
      line-height: 1.1;
    }

    .store-badge small {
      font-size: 0.68rem;
      font-weight: 700;
      opacity: 0.8;
    }

    .store-badge strong {
      font-size: 1rem;
      font-weight: 900;
    }

    .hero-top-btn {
      --background: white;
      --color: #0f172a;
      --border-radius: 18px;
      height: 52px;
      font-weight: 800;
    }

    .hero-primary-btn {
      --background: #2563eb;
      --background-hover: #1d4ed8;
      --border-radius: 18px;
      height: 56px;
      font-weight: 800;
      box-shadow: 0 20px 40px rgba(37, 99, 235, 0.35);
    }

    .hero-secondary-btn {
      --border-color: rgba(255,255,255,0.22);
      --color: white;
      --border-radius: 18px;
      height: 56px;
      font-weight: 800;
      backdrop-filter: blur(10px);
    }

    .hero-login {
      color: #94a3b8;
      font-size: 0.9rem;
      font-weight: 600;
      margin: 0;
    }

    .hero-login a {
      color: white;
      font-weight: 800;
      text-decoration: none;
    }

    .service-stack-section {
      position: relative;
      z-index: 5;
      margin-top: -44px;
      padding: 0 16px;
    }

    .service-stack {
      max-width: 1180px;
      margin: 0 auto;
      display: grid;
      gap: 14px;
    }

    .service-float-card {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 18px;
      border-radius: 26px;
      backdrop-filter: blur(18px);
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(15, 23, 42, 0.82);
      text-decoration: none;
      box-shadow: 0 20px 40px rgba(0,0,0,0.18);
    }

    .service-float-text h3 {
      color: white;
      font-size: 1.1rem;
      font-weight: 800;
      margin: 0 0 4px;
    }

    .service-float-text p {
      color: rgba(255,255,255,0.72);
      font-size: 0.88rem;
      line-height: 1.45;
      margin: 0;
    }

    .service-icon {
      width: 56px;
      height: 56px;
      border-radius: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.45rem;
      color: white;
      flex-shrink: 0;
    }

    .service-icon.blue { background: linear-gradient(135deg, #2563eb, #1d4ed8); }
    .service-icon.emerald { background: linear-gradient(135deg, #10b981, #059669); }
    .service-icon.amber { background: linear-gradient(135deg, #f59e0b, #d97706); }

    .trust-strip-section {
      background: #f8fafc;
      padding: 18px 16px 0;
    }

    .trust-strip {
      max-width: 1180px;
      margin: 0 auto;
      background: white;
      border-radius: 26px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
      border: 1px solid #e2e8f0;
      padding: 18px;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }

    .trust-item {
      text-align: center;
    }

    .trust-value {
      font-size: 1.12rem;
      font-weight: 900;
      color: #0f172a;
      margin: 0 0 4px;
    }

    .trust-label {
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #64748b;
      margin: 0;
    }

    .section-light,
    .section-white,
    .final-cta {
      background: #f8fafc;
    }

    .section-white {
      background: white;
    }

    .section-dark {
      background: #020617;
    }

    .section-wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 56px 16px;
    }

    .section-kicker {
      font-size: 0.72rem;
      font-weight: 900;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: #2563eb;
      margin: 0 0 12px;
    }

    .section-kicker.blue { color: #2563eb; }
    .section-kicker.amber { color: #f59e0b; }

    .section-title {
      font-size: clamp(2rem, 7vw, 3.2rem);
      line-height: 1.04;
      font-weight: 900;
      letter-spacing: -0.04em;
      color: #0f172a;
      margin: 0 0 14px;
    }

    .section-subtitle {
      font-size: 1rem;
      line-height: 1.75;
      color: #64748b;
      font-weight: 500;
      margin: 0;
    }

    .service-grid {
      display: grid;
      gap: 16px;
      margin-top: 28px;
    }

    .service-card {
      display: block;
      padding: 24px;
      border-radius: 26px;
      background: white;
      border: 1px solid #e2e8f0;
      text-decoration: none;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
    }

    .service-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 18px 32px rgba(15, 23, 42, 0.08);
    }

    .service-card h3 {
      font-size: 1.25rem;
      font-weight: 800;
      color: #0f172a;
      margin: 0 0 8px;
    }

    .service-card p {
      margin: 0;
      color: #64748b;
      line-height: 1.6;
      font-weight: 500;
      font-size: 0.95rem;
    }

    .service-card-icon {
      width: 60px;
      height: 60px;
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.6rem;
      margin-bottom: 16px;
      color: white;
    }

    .service-card-icon.blue { background: linear-gradient(135deg, #2563eb, #1d4ed8); }
    .service-card-icon.emerald { background: linear-gradient(135deg, #10b981, #059669); }
    .service-card-icon.amber { background: linear-gradient(135deg, #f59e0b, #d97706); }

    .feature-layout {
      display: grid;
      gap: 28px;
      align-items: center;
    }

    .feature-copy {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .feature-list {
      display: grid;
      gap: 12px;
    }

    .feature-row {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #334155;
      font-weight: 600;
      font-size: 0.98rem;
    }

    .feature-row ion-icon {
      font-size: 1.1rem;
      flex-shrink: 0;
    }

    .feature-image-shell {
      border-radius: 32px;
      overflow: hidden;
      box-shadow: 0 24px 48px rgba(15, 23, 42, 0.12);
      border: 1px solid #e2e8f0;
      background:
        linear-gradient(135deg, #f8fafc, #e2e8f0);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 14px;
    }

    .feature-image-shell.dark {
      border-color: rgba(255,255,255,0.08);
      box-shadow: 0 24px 48px rgba(2, 6, 23, 0.35);
      background:
        linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(2, 6, 23, 1));
    }

    .feature-image {
      display: block;
      width: 100%;
      height: 320px;
      object-fit: contain;
      object-position: center center;
      border-radius: 24px;
    }

    .dark-copy .section-subtitle,
    .dark-subtitle {
      color: #cbd5e1;
    }

    .dark-title {
      color: white;
    }

    .driver-plans {
      display: grid;
      gap: 14px;
    }

    .driver-plan {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 18px 20px;
      border-radius: 22px;
    }

    .driver-plan h3 {
      margin: 0 0 4px;
      font-size: 1.15rem;
      font-weight: 800;
    }

    .driver-plan p {
      margin: 0;
      font-size: 0.92rem;
    }

    .driver-plan span {
      font-size: 0.68rem;
      font-weight: 900;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .driver-plan.starter {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      color: white;
    }

    .driver-plan.starter p,
    .driver-plan.starter span {
      color: #cbd5e1;
    }

    .driver-plan.pro {
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: white;
      box-shadow: 0 16px 30px rgba(37, 99, 235, 0.3);
    }

    .driver-plan.pro p,
    .driver-plan.pro span {
      color: #dbeafe;
    }

    .cta-btn {
      --background: #2563eb;
      --background-hover: #1d4ed8;
      --border-radius: 18px;
      height: 54px;
      font-weight: 800;
      box-shadow: 0 14px 28px rgba(37, 99, 235, 0.22);
      width: fit-content;
    }

    .driver-btn {
      --background: white;
      --color: #0f172a;
      --border-radius: 18px;
      height: 54px;
      font-weight: 800;
      box-shadow: 0 14px 28px rgba(255,255,255,0.08);
      width: fit-content;
    }

    .signin-btn {
      --border-color: #cbd5e1;
      --color: #0f172a;
      --border-radius: 18px;
      height: 54px;
      font-weight: 800;
    }

    .final-cta-inner {
      text-align: center;
    }

    .final-title,
    .final-subtitle {
      max-width: 760px;
      margin-left: auto;
      margin-right: auto;
    }

    .final-actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
      justify-content: center;
      margin-top: 28px;
    }

    .final-store-actions {
      margin: 18px auto 0;
      max-width: 520px;
    }

    .footer-note {
      margin-top: 28px;
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: #94a3b8;
    }

    @media (min-width: 768px) {
      .hero-image {
        object-fit: contain;
        object-position: right center;
        padding: 24px 24px 0;
      }

      .hero-inner {
        padding: 28px 28px 52px;
      }

      .hero-stats {
        grid-template-columns: repeat(3, 1fr);
      }

      .hero-actions {
        flex-direction: row;
      }

      .store-actions {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .service-stack {
        grid-template-columns: repeat(3, 1fr);
      }

      .trust-strip {
        grid-template-columns: repeat(4, 1fr);
      }

      .service-grid {
        grid-template-columns: repeat(3, 1fr);
      }

      .feature-layout {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 48px;
      }

      .feature-image {
        height: 480px;
      }

      .final-actions {
        flex-direction: row;
        align-items: center;
      }
    }
  `]
})
export class LandingPage implements OnInit {
    private auth = inject(AuthService);
    private router = inject(Router);

    appStoreUrl = 'https://apps.apple.com/app/idYOUR_APP_ID';
    googlePlayUrl = 'https://play.google.com/store/apps/details?id=YOUR_PACKAGE_NAME';

    constructor() {
        addIcons({
            car,
            carOutline,
            basketOutline,
            cubeOutline,
            checkmarkCircle,
            shieldCheckmark,
            trendingUp,
            arrowForwardOutline,
            peopleOutline,
            flashOutline,
            locationOutline,
            logoApple,
            logoGooglePlaystore
        });
    }

    async ngOnInit() {
        // If user is already authenticated, redirect them to their dashboard
        if (this.auth.currentUser()) {
            await this.auth.handlePostAuthRedirect();
            return;
        }

        // If user is not authenticated but has previously completed onboarding/registration intent:
        // default entry should go to login page instead of marketing landing page
        const isReturningUser = localStorage.getItem('movabi_returning_user') === 'true';
        if (isReturningUser) {
            await this.router.navigate(['/auth/login'], { replaceUrl: true });
        }
    }
}