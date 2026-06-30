import { Injectable, signal } from '@angular/core';

export type MovabiTourAudience = 'customer' | 'driver' | 'admin';

export interface MovabiTourStep {
  title: string;
  body: string;
  target?: string;
}

type ActiveTour = {
  audience: MovabiTourAudience;
  steps: MovabiTourStep[];
  index: number;
};

const TOUR_STORAGE_KEYS: Record<MovabiTourAudience, string> = {
  customer: 'movabi_customer_tour_completed',
  driver: 'movabi_driver_tour_completed',
  admin: 'movabi_admin_tour_completed'
};

const TOUR_STEPS: Record<MovabiTourAudience, MovabiTourStep[]> = {
  customer: [
    { title: 'Welcome to Movabi', body: 'Book rides, errands, package delivery, and moving help from one place.' },
    { title: 'Choose a service', body: 'Start with Ride, Errand, Delivery, or Van depending on what you need.', target: '[data-tour="customer-services"]' },
    { title: 'Add trip details', body: 'Enter pickup and destination details before checking the fare.' },
    { title: 'Check fixed price', body: 'Movabi shows the price before you confirm a paid booking.' },
    { title: 'Track live', body: 'Follow your assigned driver and status updates from the tracking screen.' },
    { title: 'Wallet and bookings', body: 'Manage wallet balance, payment history, and recent bookings anytime.' }
  ],
  driver: [
    { title: 'Welcome to Movabi Driver', body: 'Your dashboard is where you manage availability, requests, earnings, and verification.' },
    { title: 'Complete onboarding', body: 'Finish country and service-based requirements before accepting paid work.' },
    { title: 'Go online or offline', body: 'Use Online when you are ready to receive nearby requests.', target: '[data-tour="driver-status"]' },
    { title: 'Set Free or Busy', body: 'Stay online but mark yourself Busy when you need a short break.' },
    { title: 'Accept nearby jobs', body: 'Available requests appear only when your profile and service requirements match.' },
    { title: 'Track active requests', body: 'Resume accepted work from the dashboard if you leave the app.' },
    { title: 'Earnings and payouts', body: 'Stripe Connect handles payouts once your account is ready.' },
    { title: 'Action required messages', body: 'If admin needs more information, you will see clear blockers in settings.' }
  ],
  admin: [
    { title: 'Control Center', body: 'Use the admin area to monitor operations and configure Movabi safely.' },
    { title: 'Review drivers', body: 'Driver review shows country, vehicle class, selected services, and relevant blockers.' },
    { title: 'Check documents', body: 'Only country and service-specific document requirements should appear.' },
    { title: 'Request missing information', body: 'Send selected blockers back to the driver without approving too early.' },
    { title: 'Manual approval', body: 'Manual approval is available when external verification APIs are not enabled.' },
    { title: 'Notification settings', body: 'OneSignal REST keys stay on the server. Configure them in server env until a secure settings API exists.' }
  ]
};

@Injectable({ providedIn: 'root' })
export class OnboardingTourService {
  readonly activeTour = signal<ActiveTour | null>(null);

  startIfNeeded(audience: MovabiTourAudience): void {
    if (this.isCompleted(audience) || this.activeTour()) return;
    this.start(audience);
  }

  start(audience: MovabiTourAudience): void {
    this.activeTour.set({
      audience,
      steps: TOUR_STEPS[audience],
      index: 0
    });
  }

  restart(audience: MovabiTourAudience): void {
    this.storage()?.removeItem(TOUR_STORAGE_KEYS[audience]);
    this.start(audience);
  }

  next(): void {
    const tour = this.activeTour();
    if (!tour) return;

    if (tour.index >= tour.steps.length - 1) {
      this.finish();
      return;
    }

    this.activeTour.set({ ...tour, index: tour.index + 1 });
  }

  skip(): void {
    this.finish();
  }

  finish(): void {
    const tour = this.activeTour();
    if (tour) {
      this.storage()?.setItem(TOUR_STORAGE_KEYS[tour.audience], 'true');
    }
    this.activeTour.set(null);
  }

  isCompleted(audience: MovabiTourAudience): boolean {
    return this.storage()?.getItem(TOUR_STORAGE_KEYS[audience]) === 'true';
  }

  private storage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
  }
}
