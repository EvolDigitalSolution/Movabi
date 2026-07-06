import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import {
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    IonButton,
    IonIcon,
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
        ReactiveFormsModule,
        IonContent,
        IonHeader,
        IonTitle,
        IonToolbar,
        IonButton,
        IonIcon
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-title>Getting Started</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="onboarding-content">
      <div class="page-shell">
        <div class="onboarding-container">
          <div class="header-section">
            <div class="logo-wrapper">
              <ion-icon name="rocket-outline" class="main-icon"></ion-icon>
            </div>

            <h1 class="title">Welcome to Movabi!</h1>
            <p class="subtitle">
              You're ready to book rides, deliveries, errands and van services.
            </p>
          </div>

          <div class="feature-list">
            <form [formGroup]="profileForm" class="profile-form" (ngSubmit)="finishOnboarding()">
              <label>
                <span>Full name</span>
                <input
                  type="text"
                  formControlName="fullName"
                  placeholder="Your full name"
                  autocomplete="name"
                  enterkeyhint="next"
                />
              </label>

              <label>
                <span>Mobile number</span>
                <input
                  type="tel"
                  formControlName="phone"
                  placeholder="Mobile number"
                  autocomplete="tel"
                  inputmode="tel"
                  enterkeyhint="next"
                />
              </label>

              @if (otpSent()) {
                <label>
                  <span>Verification code</span>
                  <input
                    type="text"
                    formControlName="otp"
                    placeholder="6 digit code"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="6"
                  />
                </label>

                <p class="otp-note">
                  Enter the code sent to your phone to finish setup.
                </p>
              }
            </form>

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

        <div class="button-safe-area">
          <ion-button
            expand="block"
            class="finish-button"
            [disabled]="isSubmitting()"
            (click)="finishOnboarding()"
          >
            {{ otpSent() ? 'Verify & Continue' : 'Send Verification Code' }}
            <ion-icon name="chevron-forward-outline" slot="end"></ion-icon>
          </ion-button>
        </div>
      </div>
    </ion-content>
  `,
    styles: [`
    :host {
      display: block;
      height: 100%;
      background: #f8fafc;
    }

    ion-header,
    ion-toolbar,
    ion-content {
      --background: #f8fafc;
    }

    .onboarding-content {
      --padding-start: 0;
      --padding-end: 0;
      --padding-top: 0;
      --padding-bottom: 0;
    }

    .page-shell {
      min-height: 100%;
      display: flex;
      flex-direction: column;
      padding: 18px 20px calc(96px + env(safe-area-inset-bottom));
      box-sizing: border-box;
    }

    .onboarding-container {
      width: 100%;
      max-width: 500px;
      margin: 0 auto;
      flex: 1;
    }

    .header-section {
      text-align: center;
      margin-bottom: 42px;
    }

    .logo-wrapper {
      width: 88px;
      height: 88px;
      background: linear-gradient(135deg, var(--ion-color-primary), var(--ion-color-primary-shade));
      border-radius: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 22px auto 22px;
      box-shadow: 0 12px 24px rgba(var(--ion-color-primary-rgb), 0.3);
    }

    .main-icon {
      font-size: 44px;
      color: #fff;
    }

    .title {
      font-size: 25px;
      font-weight: 800;
      color: var(--ion-color-dark);
      margin: 0 0 10px;
    }

    .subtitle {
      font-size: 15px;
      color: var(--ion-color-medium);
      line-height: 1.5;
      margin: 0 auto;
      max-width: 360px;
    }

    .feature-list {
      display: flex;
      flex-direction: column;
      gap: 18px;
      width: 100%;
      max-width: 500px;
      margin: 0 auto;
    }

    .profile-form {
      display: grid;
      gap: 14px;
      padding: 18px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 24px;
      box-shadow: 0 14px 30px rgb(15 23 42 / 0.06);
    }

    .profile-form label {
      display: grid;
      gap: 8px;
    }

    .profile-form span {
      font-size: 11px;
      font-weight: 900;
      letter-spacing: .16em;
      text-transform: uppercase;
      color: #64748b;
    }

    .profile-form input {
      width: 100%;
      min-height: 54px;
      border: 1.5px solid #dbe4ef;
      border-radius: 18px;
      padding: 0 16px;
      color: #0f172a;
      background: #f8fafc;
      font-weight: 800;
      outline: none;
      box-sizing: border-box;
    }

    .profile-form input:focus {
      border-color: #f59e0b;
      box-shadow: 0 0 0 4px rgb(245 158 11 / 0.12);
      background: #fff;
    }

    .otp-note {
      margin: 0;
      color: #64748b;
      font-weight: 700;
      font-size: 13px;
      line-height: 1.45;
    }

    .feature-item {
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }

    .feature-icon-wrapper {
      width: 46px;
      height: 46px;
      background-color: rgba(var(--ion-color-primary-rgb), 0.1);
      color: var(--ion-color-primary);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 23px;
      flex-shrink: 0;
    }

    .feature-text h3 {
      font-size: 17px;
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

    .button-safe-area {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 20;
      padding: 12px 20px calc(18px + env(safe-area-inset-bottom));
      background: #f8fafc;
    }

    .finish-button {
      --border-radius: 16px;
      height: 56px;
      font-weight: 700;
      font-size: 16px;
      max-width: 500px;
      margin: 0 auto;
      display: block;
    }
  `]
})
export class CustomerOnboardingPage {
    private router = inject(Router);
    private authService = inject(AuthService);
    private profileService = inject(ProfileService);
    private loadingCtrl = inject(LoadingController);
    private alertCtrl = inject(AlertController);
    private fb = inject(FormBuilder);

    isSubmitting = signal(false);
    otpSent = signal(false);
    private expectedOtp = signal<string | null>(null);

    profileForm = this.fb.group({
        fullName: ['', [Validators.required, Validators.minLength(2)]],
        phone: ['', [Validators.required, Validators.minLength(7)]],
        otp: ['']
    });

    constructor() {
        addIcons({
            rocketOutline,
            shieldCheckmarkOutline,
            notificationsOutline,
            chevronForwardOutline
        });

        const user = this.authService.currentUser();
        const profile = this.profileService.profile();
        const fallbackName = String(user?.user_metadata?.['full_name'] || user?.user_metadata?.['name'] || profile?.full_name || '').trim();
        this.profileForm.patchValue({
            fullName: fallbackName,
            phone: String(profile?.phone || user?.phone || '').trim()
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

        if (this.profileForm.invalid) {
            this.profileForm.markAllAsTouched();
            await this.showSetupAlert('Details needed', 'Enter your full name and mobile number before continuing.');
            this.isSubmitting.set(false);
            return;
        }

        if (!this.otpSent()) {
            const code = this.generateOtp();
            this.expectedOtp.set(code);
            this.otpSent.set(true);
            this.profileForm.get('otp')?.setValidators([Validators.required, Validators.pattern(/^\d{6}$/)]);
            this.profileForm.get('otp')?.updateValueAndValidity();
            await this.showSetupAlert('Verification code sent', `Use code ${code} to verify this test account. Connect an SMS provider before production.`);
            this.isSubmitting.set(false);
            return;
        }

        const enteredOtp = String(this.profileForm.value.otp || '').trim();
        if (enteredOtp !== this.expectedOtp()) {
            await this.showSetupAlert('Code not recognised', 'Check the 6 digit code and try again.');
            this.isSubmitting.set(false);
            return;
        }

        const loading = await this.loadingCtrl.create({
            message: 'Setting up your account...'
        });

        await loading.present();

        try {
            await this.profileService.updateProfile(user.id, {
                onboarding_completed: true,
                role: 'customer',
                full_name: String(this.profileForm.value.fullName || '').trim(),
                phone: String(this.profileForm.value.phone || '').trim()
            });

            this.authService.onboardingCompleted.set(true);
            this.authService.userRole.set('customer');

            await loading.dismiss();
            await this.router.navigateByUrl('/customer', { replaceUrl: true });
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

    private generateOtp(): string {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    private async showSetupAlert(header: string, message: string): Promise<void> {
        const alert = await this.alertCtrl.create({
            header,
            message,
            buttons: ['OK']
        });
        await alert.present();
    }
}
