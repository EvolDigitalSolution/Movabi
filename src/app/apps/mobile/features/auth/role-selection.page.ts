import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { 
  IonContent, 
  IonHeader, 
  IonTitle, 
  IonToolbar, 
  IonButton, 
  IonCard, 
  IonCardHeader, 
  IonCardTitle, 
  IonCardContent,
  IonIcon,
  IonText,
  LoadingController
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { personOutline, carOutline, chevronForwardOutline } from 'ionicons/icons';
import { ProfileService } from '@core/services/profile/profile.service';
import { AuthService } from '@core/services/auth/auth.service';

@Component({
  selector: 'app-role-selection',
  standalone: true,
  imports: [
    CommonModule,
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    IonButton,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonIcon,
    IonText
  ],
  template: `
    <ion-header [translucent]="true" class="ion-no-border">
      <ion-toolbar>
        <ion-title>Welcome to Movabi</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content [fullscreen]="true" class="ion-padding">
      <div class="onboarding-container">
        <div class="header-section">
          <h1 class="title">How will you use Movabi?</h1>
          <p class="subtitle">Choose the role that best fits your needs. You can always change this later.</p>
        </div>

        <div class="role-cards">
          <ion-card (click)="selectRole('customer')" class="role-card customer-card">
            <ion-card-content>
              <div class="card-content-wrapper">
                <div class="icon-wrapper customer-icon">
                  <ion-icon name="person-outline"></ion-icon>
                </div>
                <div class="text-wrapper">
                  <ion-card-title>I'm a Customer</ion-card-title>
                  <p>I want to book errands, taxis, or moving services.</p>
                </div>
                <ion-icon name="chevron-forward-outline" class="arrow-icon"></ion-icon>
              </div>
            </ion-card-content>
          </ion-card>

          <ion-card (click)="selectRole('driver')" class="role-card driver-card">
            <ion-card-content>
              <div class="card-content-wrapper">
                <div class="icon-wrapper driver-icon">
                  <ion-icon name="car-outline"></ion-icon>
                </div>
                <div class="text-wrapper">
                  <ion-card-title>I'm a Driver</ion-card-title>
                  <p>I want to earn money by providing services.</p>
                </div>
                <ion-icon name="chevron-forward-outline" class="arrow-icon"></ion-icon>
              </div>
            </ion-card-content>
          </ion-card>
        </div>
      </div>
    </ion-content>
  `,
  styles: [`
    .onboarding-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      justify-content: center;
      max-width: 500px;
      margin: 0 auto;
    }

    .header-section {
      text-align: center;
      margin-bottom: 40px;
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

    .role-cards {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .role-card {
      margin: 0;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      border-radius: 16px;
      border: 2px solid transparent;
    }

    .role-card:active {
      transform: scale(0.98);
    }

    .customer-card:hover {
      border-color: var(--ion-color-primary);
    }

    .driver-card:hover {
      border-color: var(--ion-color-secondary);
    }

    .card-content-wrapper {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .icon-wrapper {
      width: 56px;
      height: 56px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      flex-shrink: 0;
    }

    .customer-icon {
      background-color: rgba(var(--ion-color-primary-rgb), 0.1);
      color: var(--ion-color-primary);
    }

    .driver-icon {
      background-color: rgba(var(--ion-color-secondary-rgb), 0.1);
      color: var(--ion-color-secondary);
    }

    .text-wrapper {
      flex: 1;
    }

    .text-wrapper ion-card-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .text-wrapper p {
      margin: 0;
      font-size: 14px;
      color: var(--ion-color-medium);
    }

    .arrow-icon {
      font-size: 20px;
      color: var(--ion-color-light-shade);
    }
  `]
})
export class RoleSelectionPage {
  private profileService = inject(ProfileService);
  private authService = inject(AuthService);
  private router = inject(Router);
  private loadingCtrl = inject(LoadingController);

  constructor() {
    addIcons({ personOutline, carOutline, chevronForwardOutline });
  }

  async selectRole(role: 'customer' | 'driver') {
    const user = this.authService.currentUser();
    if (!user) return;

    const loading = await this.loadingCtrl.create({
      message: 'Setting your role...',
    });
    await loading.present();

    try {
      // Update profile in DB
      await this.profileService.updateProfile(user.id, { role });
      
      // Update local state
      this.authService.userRole.set(role);

      await loading.dismiss();
      // Use centralized redirect logic to handle onboarding etc.
      await this.authService.handlePostAuthRedirect();
    } catch (error) {
      await loading.dismiss();
      console.error('Error setting role:', error);
    }
  }
}
