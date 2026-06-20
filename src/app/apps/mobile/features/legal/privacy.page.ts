import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';

@Component({
  selector: 'app-privacy',
  standalone: true,
  imports: [CommonModule, RouterModule, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/"></ion-back-button>
        </ion-buttons>
        <ion-title>Privacy</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="legal-content">
      <article class="legal-page">
        <p class="eyebrow">Movabi privacy notice</p>
        <h1>How Movabi uses your data</h1>
        <p class="intro">
          This notice explains what information Movabi collects, why we use it, how it supports bookings,
          payments, safety, and support, and the choices available to customers and drivers.
        </p>

        @for (section of sections; track section.title) {
          <section>
            <h2>{{ section.title }}</h2>
            <p>{{ section.copy }}</p>
            <ul>
              @for (item of section.items; track item) {
                <li>{{ item }}</li>
              }
            </ul>
          </section>
        }

        <section>
          <h2>Your rights</h2>
          <p>
            Depending on where you live, you may be able to ask for access, correction, deletion,
            restriction, portability, or objection to certain processing. You may also withdraw consent
            where processing depends on consent, such as optional marketing or some device permissions.
          </p>
          <ul>
            <li>To use the service, Movabi still needs the data required to create, dispatch, pay for, and support a booking.</li>
            <li>Location permission can be changed in your device settings, but live tracking and accurate pickup may be limited.</li>
            <li>Payment records may need to be retained for accounting, fraud prevention, disputes, and legal obligations.</li>
          </ul>
        </section>

        <section>
          <h2>Contact and updates</h2>
          <p>
            Contact Movabi support from inside the app for privacy questions, account requests, or safety concerns.
            We may update this notice when the app, law, providers, or services change. The latest version will be
            shown in the app or on the Movabi website.
          </p>
        </section>

        <p class="footer-note">Last updated: 20 June 2026</p>
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

    .legal-content {
      --background: #f4f6f8;
    }

    .legal-page {
      max-width: 860px;
      margin: 0 auto;
      padding: 24px 18px 48px;
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
      margin: 16px 0;
      padding: 22px;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 24px;
      box-shadow: 0 14px 30px rgba(15, 23, 42, 0.05);
    }

    h2 {
      margin: 0 0 10px;
      color: #111827;
      font-size: 1.25rem;
      font-weight: 900;
      letter-spacing: 0;
    }

    p,
    li {
      color: #475569;
      line-height: 1.65;
      font-weight: 700;
    }

    ul {
      display: grid;
      gap: 8px;
      margin: 12px 0 0;
      padding-left: 18px;
    }

    .footer-note {
      margin: 24px 0 0;
      color: #64748b;
      font-size: 0.84rem;
      font-weight: 900;
      text-align: center;
    }
  `]
})
export class PrivacyPage {
  sections = [
    {
      title: 'What we collect',
      copy: 'Movabi collects the information needed to create an account, match a request, process payment, protect users, and provide support.',
      items: [
        'Account details such as name, email, phone, role, country, and profile settings.',
        'Booking details such as pickup, dropoff, service type, items, budgets, vehicle needs, messages, ratings, and job status.',
        'Driver details such as vehicle profile, verification status, location while online or assigned, Stripe Connect, and Movabi Pay setup.',
        'Payment and wallet records such as authorisations, reservations, refunds, payouts, and transaction references handled with payment providers.',
        'Device and technical data such as app version, logs, IP address, diagnostics, fraud signals, and notification tokens.'
      ]
    },
    {
      title: 'How we use it',
      copy: 'We use data to operate Movabi, make the app understandable, and keep bookings moving safely.',
      items: [
        'Create and manage customer, driver, and admin accounts.',
        'Estimate prices, dispatch drivers, show live tracking, enable chat, and complete requests.',
        'Reserve wallet or card funds, release money after cancellation or no driver, pay drivers, and handle disputes.',
        'Send important service messages, push notifications, receipts, safety alerts, and support updates.',
        'Detect abuse, investigate incidents, prevent fraud, improve reliability, and meet legal or tax duties.'
      ]
    },
    {
      title: 'Lawful basis',
      copy: 'For UK and EU users, Movabi relies on recognised lawful bases depending on the activity.',
      items: [
        'Contract: to provide bookings, driver services, payments, tracking, and support.',
        'Legitimate interests: to keep the platform secure, prevent fraud, improve service quality, and manage operations.',
        'Consent: for optional permissions such as precise device location, some notifications, or optional marketing where required.',
        'Legal obligation: for accounting, tax, regulatory, safety, fraud, and law enforcement requirements.'
      ]
    },
    {
      title: 'Who we share data with',
      copy: 'Movabi shares data only where needed to run the service, protect people, or meet obligations.',
      items: [
        'Customers and drivers see the details needed to complete the job, such as names, vehicle details, trip status, chat, and location.',
        'Payment providers such as Stripe process card authorisations, wallet top-ups, driver payouts, and Movabi Pay issuing where enabled.',
        'Infrastructure providers such as Supabase, hosting, map, notification, analytics, and support tools help operate the app.',
        'Authorities, insurers, or professional advisers may receive information where required by law, disputes, safety, or fraud prevention.'
      ]
    },
    {
      title: 'Location, tracking, and messages',
      copy: 'Location and communication data are sensitive in a transport app, so Movabi uses them for clear service purposes.',
      items: [
        'Customer location helps set pickup, delivery, and route details when permission is granted.',
        'Driver location is used while online or assigned so customers can see progress and drivers can navigate.',
        'Job messages and quick replies help customers and drivers coordinate and can be reviewed for support, safety, or disputes.',
        'Push notifications are used for job updates, budget approvals, driver arrival, chat, cancellation, payment, and account alerts.'
      ]
    },
    {
      title: 'Retention and security',
      copy: 'Movabi keeps data only for as long as needed for service, legal, accounting, safety, and dispute purposes.',
      items: [
        'Active booking data is kept while the job is open and for a reasonable period afterwards for receipts, support, and disputes.',
        'Payment, wallet, payout, and tax records may be retained longer where law or providers require it.',
        'Security controls include access controls, provider security tools, encrypted transport, audit logs, and restricted admin access.',
        'No system is risk-free, but Movabi works to reduce unnecessary data collection and limit access to people and systems that need it.'
      ]
    }
  ];
}
