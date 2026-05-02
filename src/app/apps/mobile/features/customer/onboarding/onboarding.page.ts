import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    IonButton,
    IonIcon,
    IonFooter,
    LoadingController,
    AlertController
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
    rocketOutline,
    shieldCheckmarkOutline,
    notificationsOutline,
    chevronForwardOutline
} from 'ionicons/icons';

import { ProfileService } from '@core/services/profile/profile.service';
import { AuthService } from '@core/services/auth/auth.service';

@Component({
    selector: 'app-customer-onboarding',
    standalone: true,
    imports: [
        CommonModule,
        IonContent,
        IonHeader,
        IonTitle,
        IonToolbar,
        IonButton,
        IonIcon,
        IonFooter
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-title>Getting Started</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content [fullscreen]="true" class="ion-padding">
      <div class="onboarding-container">
        <div class="header-section">
          <div class="logo-wrapper">
            <ion-icon name="rocket-outline" class="main-icon"></ion-icon>
          </div>

          <h1 class="title">Welcome to Movabi!</h1>
          <p class="subtitle">
            You’re ready to book rides, deliveries, errands and van services.
          </p>
        </div>

        <div class="feature-list">
          <div class="feature-item">
            <div class="feature-icon-wrapper">
              <ion-icon name="shield-checkmark-outline"></ion-icon>
            </div>

            <div class="feature-text">
              <h3>Safe & Secure</h3>
              <p>Vetted drivers, protected payments and real booking updates.</p>
            </div>
          </div>

          <div class="feature-item">
            <div class="feature-icon-wrapper">
              <ion-icon name="notifications-outline"></ion-icon>
            </div>

            <div class="feature-text">
              <h3>Live Tracking</h3>
              <p>Track your booking and receive progress updates in real time.</p>
            </div>
          </div>
        </div>
      </div>
    </ion-content>

    <ion-footer class="ion-no-border ion-padding">
      <ion-button
        expand="block"
        class="finish-button"
        [disabled]="isSubmitting()"
        (click)="finishOnboarding()"
      >
        Go to Dashboard
        <ion-icon name="chevron-forward-outline" slot="end"></ion-icon>
      </ion-button>
    </ion-footer>
  `,
    styles: [`
    .onboarding-container {
      display: flex;
      flex-direction: column;
      min-height: 100%;
      max-width: 500px;
      margin: 0 auto;
      padding-top: 40px;
    }

    .header-section {
      text-align: center;
      margin-bottom: 60px;
    }

    .logo-wrapper {
      width: 100px;
      height: 100px;
      background: linear-gradient(
        135deg,
        var(--ion-color-primary),
        var(--ion-color-primary-shade)
      );
      border-radius: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      box-shadow: 0 12px 24px rgba(var(--ion-color-primary-rgb), 0.3);
    }

    .main-icon {
      font-size: 50px;
      color: #fff;
    }

    .title {
      font-size: 28px;
      font-weight: 800;
      color: var(--ion-color-dark);
      margin: 0 0 12px;
    }

    .subtitle {
      font-size: 16px;
      color: var(--ion-color-medium);
      line-height: 1.5;
      margin: 0;
    }

    .feature-list {
      display: flex;
      flex-direction: column;
      gap: 28px;
    }

    .feature-item {
      display: flex;
      gap: 18px;
      align-items: flex-start;
    }

    .feature-icon-wrapper {
      width: 48px;
      height: 48px;
      background-color: rgba(var(--ion-color-primary-rgb), 0.1);
      color: var(--ion-color-primary);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      flex-shrink: 0;
    }

    .feature-text h3 {
      font-size: 18px;
      font-weight: 700;
      margin: 0 0 4px;
      color: var(--ion-color-dark);
    }

    .feature-text p {
      margin: 0;
      font-size: 14px;
      color: var(--ion-color-medium);
      line-height: 1.45;
    }

    .finish-button {
      --border-radius: 16px;
      height: 56px;
      font-weight: 700;
      font-size: 16px;
    }
  `]
})
export class CustomerOnboardingPage {
    private router = inject(Router);
    private authService = inject(AuthService);
    private profileService = inject(ProfileService);
    private loadingCtrl = inject(LoadingController);
    private alertCtrl = inject(AlertController);

    isSubmitting = signal(false);

    constructor() {
        addIcons({
            rocketOutline,
            shieldCheckmarkOutline,
            notificationsOutline,
            chevronForwardOutline
        });
    }

    async finishOnboarding(): Promise<void> {
        if (this.isSubmitting()) return;

        const user = this.authService.currentUser();

        if (!user?.id) {
            await this.router.navigate(['/auth/login']);
            return;
        }

        this.isSubmitting.set(true);

        const loading = await this.loadingCtrl.create({
            message: 'Setting up your account...'
        });

        await loading.present();

        try {
            await this.profileService.updateProfile(user.id, {
                onboarding_completed: true,
                role: 'customer'
            });

            this.authService.onboardingCompleted?.set?.(true);
            this.authService.userRole?.set?.('customer');

            await loading.dismiss();

            if (typeof this.authService.handlePostAuthRedirect === 'function') {
                await this.authService.handlePostAuthRedirect();
            } else {
                await this.router.navigate(['/customer']);
            }
        } catch (error) {
            console.error('Error finishing onboarding:', error);

            await loading.dismiss();

            const alert = await this.alertCtrl.create({
                header: 'Setup Failed',
                message: 'We could not complete your onboarding. Please try again.',
                buttons: ['OK']
            });

            await alert.present();
        } finally {
            this.isSubmitting.set(false);
        }
    }
}