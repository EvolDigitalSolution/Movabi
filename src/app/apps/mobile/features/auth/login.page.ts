import { Component, inject, signal } from '@angular/core';
import { 
  IonHeader, 
  IonToolbar, 
  IonTitle, 
  IonContent, 
  IonIcon, 
  IonButton, 
  IonSpinner
} from '@ionic/angular/standalone';
import { Router, RouterModule } from '@angular/router';
import { addIcons } from 'ionicons';
import { 
  alertCircleOutline, 
  mailOutline, 
  lockClosedOutline, 
  eyeOutline, 
  eyeOffOutline, 
  logoGoogle 
} from 'ionicons/icons';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { ProfileService } from '../../../../core/services/profile/profile.service';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';

@Component({
  selector: 'app-login',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4 bg-white">
        <ion-title class="font-display font-bold text-2xl text-slate-900">Movabi</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding bg-slate-50">
      <div class="flex flex-col h-full max-w-md mx-auto pt-8">
        <div class="mb-10 text-center">
          <h1 class="text-3xl font-display font-bold text-slate-900 mb-3">Welcome back</h1>
          <p class="text-slate-500 text-sm">Sign in to your Movabi account to manage your services.</p>
        </div>

        @if (errorMessage()) {
          <div class="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm animate-shake">
            <ion-icon name="alert-circle-outline" class="text-xl shrink-0"></ion-icon>
            <p class="font-medium">{{ errorMessage() }}</p>
          </div>
        }

        <form [formGroup]="loginForm" (ngSubmit)="onSubmit()" class="space-y-5">
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
            @if (loginForm.get('email')?.touched && loginForm.get('email')?.errors?.['email']) {
              <p class="mt-1.5 ml-1 text-xs text-red-500 font-medium">Please enter a valid email address.</p>
            }
          </div>

          <div>
            <div class="flex justify-between items-center mb-2 ml-1">
              <label for="password" class="block text-xs font-bold text-slate-500 uppercase tracking-widest">Password</label>
              <a routerLink="/auth/forgot-password" class="text-xs text-blue-600 font-bold hover:text-blue-700 transition-colors">Forgot Password?</a>
            </div>
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
                aria-label="Toggle password visibility"
              >
                <ion-icon [name]="showPassword() ? 'eye-off-outline' : 'eye-outline'" class="text-xl"></ion-icon>
              </button>
            </div>
          </div>

          <div class="pt-4">
            <ion-button 
              type="submit" 
              expand="block" 
              class="h-14 font-bold text-lg rounded-2xl shadow-xl shadow-blue-600/20"
              [disabled]="loginForm.invalid || isLoading()"
            >
              @if (isLoading()) {
                <ion-spinner name="crescent"></ion-spinner>
              } @else {
                Sign In
              }
            </ion-button>
          </div>
        </form>

        <div class="relative my-10">
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

        <p class="mt-10 text-center text-slate-600 text-sm">
          New to Movabi? 
          <a routerLink="/auth/signup" class="text-blue-600 font-bold hover:text-blue-700 transition-colors">Create your account</a>
        </p>
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
    IonTitle, 
    IonContent, 
    IonIcon, 
    IonButton, 
    IonSpinner
  ]
})
export class LoginPage {
  private fb = inject(FormBuilder);
  public auth = inject(AuthService);
  private profileService = inject(ProfileService);
  private router = inject(Router);

  loginForm = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]]
  });

  showPassword = signal(false);
  isLoading = signal(false);
  errorMessage = signal<string | null>(null);
  private isSubmitting = false;

  constructor() {
    addIcons({ 
      alertCircleOutline, 
      mailOutline, 
      lockClosedOutline, 
      eyeOutline, 
      eyeOffOutline, 
      logoGoogle 
    });
  }

  togglePassword() {
    this.showPassword.update(v => !v);
  }

  async onSubmit() {
    if (this.loginForm.invalid || this.isSubmitting) return;
    const { email, password } = this.loginForm.value;
    if (!email || !password) return;

    this.isSubmitting = true;
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      await this.auth.signIn(email, password);
      await this.auth.handlePostAuthRedirect();
    } catch (err: unknown) {
      console.error('Login failed:', err);
      const message = err instanceof Error ? err.message : 'Invalid email or password. Please try again.';
      this.errorMessage.set(message);
    } finally {
      this.isLoading.set(false);
      this.isSubmitting = false;
    }
  }

  async loginWithGoogle() {
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      await this.auth.signInWithGoogle();
      // Note: OAuth usually redirects away and back to callback page
    } catch (err: unknown) {
      console.error('Google login failed:', err);
      const message = err instanceof Error ? err.message : 'Google sign-in failed. Please try again.';
      this.errorMessage.set(message);
      this.isLoading.set(false);
      this.isSubmitting = false;
    }
  }
}
