import { Component, inject, signal } from '@angular/core';
import { IonicModule } from '@ionic/angular';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';

@Component({
  selector: 'app-forgot-password',
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
      <div class="flex flex-col h-full max-w-md mx-auto pt-8">
        <div class="mb-10 text-center">
          <h1 class="text-3xl font-display font-bold text-slate-900 mb-3">Forgot password?</h1>
          <p class="text-slate-500 text-sm px-4">Enter your email address and we'll send you a link to reset your password.</p>
        </div>

        @if (isSuccess()) {
          <div class="bg-emerald-50 border border-emerald-100 rounded-3xl p-8 text-center animate-in fade-in zoom-in duration-300">
            <div class="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <ion-icon name="mail-unread-outline" class="text-4xl text-emerald-600"></ion-icon>
            </div>
            <h3 class="text-xl font-bold text-slate-900 mb-3">Check your email</h3>
            <p class="text-slate-600 text-sm leading-relaxed mb-8">
              We've sent a password reset link to <br>
              <strong class="text-slate-900">{{ emailInput.value }}</strong>
            </p>
            <ion-button 
              expand="block" 
              class="h-14 font-bold text-lg rounded-2xl shadow-xl shadow-emerald-600/20"
              routerLink="/auth/login"
            >
              Back to Sign In
            </ion-button>
            <button (click)="isSuccess.set(false)" class="mt-6 text-sm font-bold text-slate-400 hover:text-slate-600 transition-colors">
              Didn't receive the email? Try again
            </button>
          </div>
        } @else {
          @if (errorMessage()) {
            <div class="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm animate-shake">
              <ion-icon name="alert-circle-outline" class="text-xl shrink-0"></ion-icon>
              <p class="font-medium">{{ errorMessage() }}</p>
            </div>
          }

          <form [formGroup]="forgotForm" (ngSubmit)="onSubmit()" class="space-y-6">
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

            <ion-button 
              type="submit" 
              expand="block" 
              class="h-14 font-bold text-lg rounded-2xl shadow-xl shadow-blue-600/20"
              [disabled]="forgotForm.invalid || isLoading()"
            >
              @if (isLoading()) {
                <ion-spinner name="crescent"></ion-spinner>
              } @else {
                Send Reset Link
              }
            </ion-button>
          </form>

          <p class="mt-10 text-center text-slate-600 text-sm">
            Remember your password? 
            <a routerLink="/auth/login" class="text-blue-600 font-bold hover:text-blue-700 transition-colors">Sign In</a>
          </p>
        }
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, ReactiveFormsModule, RouterModule]
})
export class ForgotPasswordPage {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);

  forgotForm = this.fb.group({
    email: ['', [Validators.required, Validators.email]]
  });

  get emailInput() { return this.forgotForm.get('email')!; }

  isLoading = signal(false);
  isSuccess = signal(false);
  errorMessage = signal<string | null>(null);

  private redirectByRole(role: string) {
    if (role === 'admin') {
      this.router.navigate(['/admin']);
    } else if (role === 'driver') {
      this.router.navigate(['/driver']);
    } else {
      this.router.navigate(['/customer']);
    }
  }

  async onSubmit() {
    if (this.forgotForm.invalid) return;
    const email = this.emailInput.value;
    if (!email) return;

    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      await this.auth.resetPassword(email);
      this.isSuccess.set(true);
    } catch (err: unknown) {
      console.error('Password reset failed:', err);
      const message = err instanceof Error ? err.message : 'Failed to send reset link. Please check your email and try again.';
      this.errorMessage.set(message);
    } finally {
      this.isLoading.set(false);
    }
  }
}
