import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { RouterModule } from '@angular/router';
import { OnboardingTourService } from '../../../../core/services/onboarding-tour/onboarding-tour.service';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';

@Component({
  selector: 'app-help',
  standalone: true,
  imports: [CommonModule, RouterModule, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/"></ion-back-button>
        </ion-buttons>
        <ion-title>How to use Movabi</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="help-content">
      <article class="help-page">
        <p class="eyebrow">Simple app guide</p>
        <h1>Get around Movabi without guessing.</h1>
        <p class="intro">
          This guide explains the main controls customers and drivers use across rides, shop,
          deliver, move, wallet, tracking, chat, and payments.
        </p>

        <section>
          <h2>Customer booking</h2>
          <div class="guide-grid">
            @for (item of customerGuide; track item.title) {
              <div class="guide-card">
                <strong>{{ item.title }}</strong>
                <p>{{ item.copy }}</p>
              </div>
            }
          </div>
        </section>

        <section>
          <h2>Live tracking and chat</h2>
          <div class="guide-grid">
            @for (item of trackingGuide; track item.title) {
              <div class="guide-card">
                <strong>{{ item.title }}</strong>
                <p>{{ item.copy }}</p>
              </div>
            }
          </div>
        </section>

        <section>
          <h2>Driver app</h2>
          <div class="guide-grid">
            @for (item of driverGuide; track item.title) {
              <div class="guide-card">
                <strong>{{ item.title }}</strong>
                <p>{{ item.copy }}</p>
              </div>
            }
          </div>
        </section>

        <section>
          <h2>Payments, cancellation, and refunds</h2>
          <div class="guide-grid">
            @for (item of paymentGuide; track item.title) {
              <div class="guide-card">
                <strong>{{ item.title }}</strong>
                <p>{{ item.copy }}</p>
              </div>
            }
          </div>
        </section>

        <section class="support-card">
          <h2>Still stuck?</h2>
          <p>
            Use in-app support with the booking ID shown on the tracking screen. Include what happened,
            the service type, and any payment or driver issue so Movabi can check the job faster.
          </p>
          <div class="tour-actions" aria-label="Restart onboarding tours">
            <button type="button" (click)="restartTour('customer')">Restart customer tour</button>
            <button type="button" (click)="restartTour('driver')">Restart driver tour</button>
          </div>
          <a routerLink="/privacy">Read privacy and data use</a>
        </section>
      </article>
    </ion-content>
  `,
  styles: [`
    ion-toolbar {
      --background: #f4f6f8;
      --color: #111827;
    }

    ion-title {
      font-weight: 900;
    }

    .help-content {
      --background: #f4f6f8;
    }

    .help-page {
      max-width: 1000px;
      margin: 0 auto;
      padding: 24px 18px 52px;
    }

    .eyebrow {
      margin: 0 0 10px;
      color: #c2410c;
      font-size: 0.72rem;
      font-weight: 900;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      color: #111827;
      font-size: clamp(2.1rem, 8vw, 4rem);
      line-height: 1;
      font-weight: 900;
      letter-spacing: 0;
    }

    .intro {
      margin: 18px 0 24px;
      color: #475569;
      font-size: 1.05rem;
      line-height: 1.7;
      font-weight: 700;
    }

    section {
      margin: 18px 0;
    }

    h2 {
      color: #111827;
      font-size: 1.45rem;
      font-weight: 900;
      margin: 0 0 14px;
      letter-spacing: 0;
    }

    .guide-grid {
      display: grid;
      gap: 12px;
    }

    .guide-card,
    .support-card {
      padding: 18px;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 22px;
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.05);
    }

    .guide-card strong {
      display: block;
      color: #111827;
      font-size: 1rem;
      font-weight: 900;
      margin-bottom: 6px;
    }

    p {
      margin: 0;
      color: #64748b;
      line-height: 1.65;
      font-weight: 700;
    }

    .support-card {
      border-color: #fed7aa;
      background: #fff7ed;
    }

    .support-card p {
      margin-bottom: 14px;
    }

    .tour-actions {
      display: grid;
      gap: 10px;
      margin: 14px 0;
    }

    .tour-actions button {
      min-height: 44px;
      border: 1px solid #fed7aa;
      border-radius: 14px;
      background: #fff;
      color: #9a3412;
      font-weight: 900;
    }

    .support-card a {
      color: #c2410c;
      font-weight: 900;
      text-decoration: none;
    }

    @media (min-width: 760px) {
      .guide-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `]
})
export class HelpPage {
  private tour = inject(OnboardingTourService);

  restartTour(audience: 'customer' | 'driver') {
    this.tour.restart(audience);
  }

  customerGuide = [
    {
      title: 'Service cards',
      copy: 'Tap Ride, Shop, Deliver, or Move. Each service asks for the correct details, vehicle type, budget, and route.'
    },
    {
      title: 'Pickup and dropoff',
      copy: 'Type a place, street, or house number and choose a suggestion. Use Current only when you want the app to use your live device location.'
    },
    {
      title: 'Price and budget',
      copy: 'Confirm only after pickup and dropoff are set. Shop jobs may include an item budget; rides and deliver focus on route and service fee.'
    },
    {
      title: 'Wallet or card',
      copy: 'Movabi checks wallet first where supported. If wallet is not enough, card authorisation can be used before the job is sent.'
    }
  ];

  trackingGuide = [
    {
      title: 'Map and bottom sheet',
      copy: 'The map shows the active route or useful service points. Pull the details panel up to see booking details, messages, budget, and actions.'
    },
    {
      title: 'Service status',
      copy: 'Ride, errand, delivery, and moving use different tracking words so customers know whether the driver is coming, shopping, delivering, or moving items.'
    },
    {
      title: 'Chat and quick replies',
      copy: 'Use quick replies for common messages or type a message. Important messages should also trigger push notifications in the mobile app.'
    },
    {
      title: 'No driver or cancelled',
      copy: 'The tracking page explains whether wallet funds return to Movabi wallet or card authorisation returns to the original payment card.'
    }
  ];

  driverGuide = [
    {
      title: 'Online and free',
      copy: 'Online means you are available on the platform. Free means you are ready to receive new jobs.'
    },
    {
      title: 'Available requests',
      copy: 'Open requests expand when jobs are available. Accept starts the job flow; Pass hides that request from your dashboard.'
    },
    {
      title: 'Active job',
      copy: 'If you leave the app or navigate away, return to Driver Hub and use the active job card to continue the request.'
    },
    {
      title: 'Movabi Pay',
      copy: 'For errand item budgets, eligible drivers can use a Movabi Pay virtual card limited to the approved customer budget.'
    },
    {
      title: 'Complete request',
      copy: 'Only complete a job when the ride, delivery, errand, or move is actually finished. This triggers payment settlement and customer rating.'
    },
    {
      title: 'Cannot continue',
      copy: 'If a driver cannot finish, they should contact support from the job screen so the job can be reassigned, cancelled, or reviewed.'
    }
  ];

  paymentGuide = [
    {
      title: 'Wallet reservation',
      copy: 'Reserved wallet funds are held for the job. If no driver is found or the job is cancelled before charge, the funds return to the customer wallet.'
    },
    {
      title: 'Card authorisation',
      copy: 'A card authorisation is not the same as a completed charge. If no driver is found or the job is cancelled before charge, Movabi releases it to the original card.'
    },
    {
      title: 'Errand item spend',
      copy: 'The driver records actual spend and uploads receipt where needed. Unused approved item budget should be released back to the customer.'
    },
    {
      title: 'Driver payout',
      copy: 'Completed jobs are settled through the driver payout flow, including Stripe Connect where enabled.'
    }
  ];
}
