import { Component, inject, signal } from '@angular/core';
import { 
  IonHeader, 
  IonToolbar, 
  IonButtons, 
  IonBackButton, 
  IonTitle, 
  IonContent, 
  IonIcon, 
  IonButton, 
  IonSpinner, 
  IonSelect, 
  IonSelectOption
} from '@ionic/angular/standalone';
import { Router, RouterModule } from '@angular/router';
import { addIcons } from 'ionicons';
import { 
  checkmarkCircleOutline, 
  alertCircleOutline, 
  globeOutline, 
  personOutline, 
  mailOutline, 
  lockClosedOutline, 
  eyeOutline, 
  eyeOffOutline, 
  logoGoogle 
} from 'ionicons/icons';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { ProfileService } from '../../../../core/services/profile/profile.service';
import { AppConfigService } from '../../../../core/services/config/app-config.service';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators, FormGroup } from '@angular/forms';

@Component({
  selector: 'app-signup',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/auth/login" class="text-slate-900"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-2xl text-slate-900">Movabi</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding bg-slate-50">
      <div class="flex flex-col h-full max-w-md mx-auto pt-4">
        @if (isSuccess()) {
          <div class="bg-emerald-50 border border-emerald-100 rounded-3xl p-8 text-center animate-in fade-in zoom-in duration-300 my-auto">
            <div class="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <ion-icon name="checkmark-circle-outline" class="text-4xl text-emerald-600"></ion-icon>
            </div>
            <h3 class="text-2xl font-display font-bold text-slate-900 mb-3 tracking-tight">Account Created!</h3>
            <p class="text-slate-600 text-sm leading-relaxed mb-8">
              Welcome to Movabi. Your account has been created successfully. 
              Please check your email to confirm your account before signing in.
            </p>
            <ion-button 
              expand="block" 
              class="h-14 font-bold text-lg rounded-2xl shadow-xl shadow-emerald-600/20"
              routerLink="/auth/login"
            >
              Go to Sign In
            </ion-button>
          </div>
        } @else {
          <div class="mb-8 text-center">
            <h1 class="text-3xl font-display font-bold text-slate-900 mb-3">Create account</h1>
            <p class="text-slate-500 text-sm">Join Movabi and start managing your services today.</p>
          </div>

          @if (errorMessage()) {
            <div class="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm animate-shake">
              <ion-icon name="alert-circle-outline" class="text-xl shrink-0"></ion-icon>
              <p class="font-medium">{{ errorMessage() }}</p>
            </div>
          }

          <form [formGroup]="signupForm" (ngSubmit)="onSubmit()" class="space-y-4">
            <div>
              <label for="country" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Country</label>
              <div class="relative group">
                <ion-icon name="globe-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl group-focus-within:text-blue-600 transition-colors"></ion-icon>
                <ion-select 
                  id="country"
                  [value]="config.currentCountry().code" 
                  (ionChange)="onCountryChange($event)"
                  class="w-full h-14 pl-12 pr-4 bg-white border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all font-medium text-slate-900"
                >
                  @for (country of config.countries(); track country.code) {
                    <ion-select-option [value]="country.code">{{ country.name }}</ion-select-option>
                  }
                </ion-select>
              </div>
            </div>

            <div>
              <label for="fullName" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Full Name</label>
              <div class="relative group">
                <ion-icon name="person-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl group-focus-within:text-blue-600 transition-colors"></ion-icon>
                <input 
                  id="fullName"
                  type="text" 
                  formControlName="fullName"
                  placeholder="John Doe"
                  class="w-full h-14 pl-12 pr-4 bg-white border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all font-medium text-slate-900"
                >
              </div>
            </div>

            <div>
              <label for="email" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Email Address</label>
              <div class="relative group">
                <ion-icon name="mail-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl group-focus-within:text-blue-600 transition-colors"></ion-icon>
                <input 
                  id="email"
                  type="email" 
                  formControlName="email"
                  placeholder="name@example.com"
                  class="w-full h-14 pl-12 pr-4 bg-white border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all font-medium text-slate-900"
                >
              </div>
            </div>

            <div>
              <label for="password" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Password</label>
              <div class="relative group">
                <ion-icon name="lock-closed-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl group-focus-within:text-blue-600 transition-colors"></ion-icon>
                <input 
                  id="password"
                  [type]="showPassword() ? 'text' : 'password'" 
                  formControlName="password"
                  placeholder="••••••••"
                  class="w-full h-14 pl-12 pr-12 bg-white border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all font-medium text-slate-900"
                >
                <button 
                  type="button"
                  (click)="togglePassword()"
                  class="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <ion-icon [name]="showPassword() ? 'eye-off-outline' : 'eye-outline'" class="text-xl"></ion-icon>
                </button>
              </div>
            </div>

            <div>
              <label for="confirmPassword" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Confirm Password</label>
              <div class="relative group">
                <ion-icon name="lock-closed-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl group-focus-within:text-blue-600 transition-colors"></ion-icon>
                <input 
                  id="confirmPassword"
                  [type]="showPassword() ? 'text' : 'password'" 
                  formControlName="confirmPassword"
                  placeholder="••••••••"
                  class="w-full h-14 pl-12 pr-12 bg-white border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all font-medium text-slate-900"
                >
              </div>
              @if (signupForm.errors?.['passwordMismatch'] && signupForm.get('confirmPassword')?.touched) {
                <p class="mt-1.5 ml-1 text-xs text-red-500 font-medium">Passwords do not match.</p>
              }
            </div>

            <div class="pt-4">
              <ion-button 
                type="submit" 
                expand="block" 
                class="h-14 font-bold text-lg rounded-2xl shadow-xl shadow-blue-600/20"
                [disabled]="signupForm.invalid || isLoading()"
              >
                @if (isLoading()) {
                  <ion-spinner name="crescent"></ion-spinner>
                } @else {
                  Create Account
                }
              </ion-button>
            </div>
          </form>

          <div class="relative my-8">
            <div class="absolute inset-0 flex items-center">
              <div class="w-full border-t border-slate-200"></div>
            </div>
            <div class="relative flex justify-center text-xs">
              <span class="px-4 bg-slate-50 text-slate-400 font-bold uppercase tracking-widest">Or continue with</span>
            </div>
          </div>

          <button 
            type="button"
            class="w-full h-14 flex items-center justify-center gap-3 bg-white border border-slate-200 rounded-2xl font-bold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all active:scale-[0.98] disabled:opacity-50" 
            (click)="loginWithGoogle()"
            [disabled]="isLoading()"
          >
            <ion-icon name="logo-google" class="text-xl text-red-500"></ion-icon>
            <span>Continue with Google</span>
          </button>

          <div class="mt-8 p-6 bg-blue-50 rounded-2xl border border-blue-100">
            <p class="text-xs text-blue-800 font-medium leading-relaxed text-center">
              <span class="font-bold">Driving with Movabi?</span> Choose between our commission-free Pro plan or our flexible Starter plan after you sign up.
            </p>
          </div>

          <p class="mt-8 text-center text-slate-600 text-sm pb-8">
            Already have an account? 
            <a routerLink="/auth/login" class="text-blue-600 font-bold hover:text-blue-700 transition-colors">Sign In</a>
          </p>
        }
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [
    CommonModule, 
    FormsModule, 
    ReactiveFormsModule, 
    RouterModule, 
    IonHeader, 
    IonToolbar, 
    IonButtons, 
    IonBackButton, 
    IonTitle, 
    IonContent, 
    IonIcon, 
    IonButton, 
    IonSpinner, 
    IonSelect, 
    IonSelectOption
  ]
})
export class SignupPage {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private profileService = inject(ProfileService);
  private router = inject(Router);
  public config = inject(AppConfigService);

  signupForm = this.fb.group({
    fullName: ['', [Validators.required, Validators.minLength(2)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
    confirmPassword: ['', [Validators.required]]
  }, { validators: this.passwordMatchValidator });

  showPassword = signal(false);
  isLoading = signal(false);
  isSuccess = signal(false);
  errorMessage = signal<string | null>(null);

  constructor() {
    addIcons({ 
      checkmarkCircleOutline, 
      alertCircleOutline, 
      globeOutline, 
      personOutline, 
      mailOutline, 
      lockClosedOutline, 
      eyeOutline, 
      eyeOffOutline, 
      logoGoogle 
    });
  }

  onCountryChange(event: Event) {
    const customEvent = event as CustomEvent;
    const code = customEvent.detail.value;
    this.config.setCountry(code);
  }

  passwordMatchValidator(g: FormGroup) {
    const password = g.get('password')?.value;
    const confirmPassword = g.get('confirmPassword')?.value;
    return password === confirmPassword ? null : { 'passwordMismatch': true };
  }

  togglePassword() {
    this.showPassword.update(v => !v);
  }

  async onSubmit() {
    if (this.signupForm.invalid) return;
    const { email, password, fullName } = this.signupForm.value;
    if (!email || !password || !fullName) return;

    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      await this.auth.signUp(email, password, { full_name: fullName });
      this.isSuccess.set(true);
    } catch (err: unknown) {
      console.error('Signup failed:', err);
      const message = err instanceof Error ? err.message : 'Failed to create account. Please try again.';
      this.errorMessage.set(message);
    } finally {
      this.isLoading.set(false);
    }
  }

  async loginWithGoogle() {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      await this.auth.signInWithGoogle();
    } catch (err: unknown) {
      console.error('Google login failed:', err);
      const message = err instanceof Error ? err.message : 'Google sign-in failed. Please try again.';
      this.errorMessage.set(message);
      this.isLoading.set(false);
    }
  }
}
