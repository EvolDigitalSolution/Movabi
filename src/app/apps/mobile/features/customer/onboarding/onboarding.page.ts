import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { 
  IonContent, 
  IonHeader, 
  IonTitle, 
  IonToolbar, 
  IonButton, 
  IonIcon, 
  IonText,
  IonFooter,
  LoadingController
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
    IonText,
    IonFooter
  ],
  template: `
    <ion-header [translucent]="true" class="ion-no-border">
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
          <p class="subtitle">You're all set to start using our services. Here's what you can do:</p>
        </div>

        <div class="feature-list">
          <div class="feature-item">
            <div class="feature-icon-wrapper">
              <ion-icon name="shield-checkmark-outline"></ion-icon>
            </div>
            <div class="feature-text">
              <h3>Safe & Secure</h3>
              <p>All our drivers are vetted and your payments are secure.</p>
            </div>
          </div>

          <div class="feature-item">
            <div class="feature-icon-wrapper">
              <ion-icon name="notifications-outline"></ion-icon>
            </div>
            <div class="feature-text">
              <h3>Real-time Updates</h3>
              <p>Track your bookings and get notified of progress.</p>
            </div>
          </div>
        </div>
      </div>
    </ion-content>

    <ion-footer class="ion-no-border ion-padding">
      <ion-button expand="block" (click)="finishOnboarding()" class="finish-button">
        Go to Dashboard
        <ion-icon name="chevron-forward-outline" slot="end"></ion-icon>
      </ion-button>
    </ion-footer>
  `,
  styles: [`
    .onboarding-container {
      display: flex;
      flex-direction: column;
      height: 100%;
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
      background: linear-gradient(135deg, var(--ion-color-primary), var(--ion-color-primary-shade));
      border-radius: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      box-shadow: 0 12px 24px rgba(var(--ion-color-primary-rgb), 0.3);
    }

    .main-icon {
      font-size: 50px;
      color: white;
    }

    .title {
      font-size: 28px;
      font-weight: 700;
      color: var(--ion-color-dark);
      margin-bottom: 12px;
    }

    .subtitle {
      font-size: 16px;
      color: var(--ion-color-medium);
      line-height: 1.5;
    }

    .feature-list {
      display: flex;
      flex-direction: column;
      gap: 32px;
    }

    .feature-item {
      display: flex;
      gap: 20px;
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
      font-weight: 600;
      margin: 0 0 4px;
      color: var(--ion-color-dark);
    }

    .feature-text p {
      margin: 0;
      font-size: 14px;
      color: var(--ion-color-medium);
      line-height: 1.4;
    }

    .finish-button {
      --border-radius: 16px;
      height: 56px;
      font-weight: 600;
      font-size: 16px;
    }
  `]
})
export class CustomerOnboardingPage {
  private router = inject(Router);
  private authService = inject(AuthService);
  private profileService = inject(ProfileService);
  private loadingCtrl = inject(LoadingController);

  constructor() {
    addIcons({ rocketOutline, shieldCheckmarkOutline, notificationsOutline, chevronForwardOutline });
  }

  async finishOnboarding() {
    const user = this.authService.currentUser();
    if (!user) return;

    const loading = await this.loadingCtrl.create({
      message: 'Setting up your account...',
    });
    await loading.present();

    try {
      await this.profileService.updateProfile(user.id, { 
        onboarding_completed: true,
        role: 'customer'
      });
      
      // Update local state
      this.authService.onboardingCompleted.set(true);
      this.authService.userRole.set('customer');

      await loading.dismiss();
      await this.authService.handlePostAuthRedirect();
    } catch (error) {
      await loading.dismiss();
      console.error('Error finishing onboarding:', error);
    }
  }
}
