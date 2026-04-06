import { Component, inject, signal } from '@angular/core';
import { IonicModule } from '@ionic/angular';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators, FormGroup } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { SupabaseService } from '../../../../core/services/supabase/supabase.service';

@Component({
  selector: 'app-reset-password',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4 bg-white">
        <ion-title class="font-display font-bold text-2xl text-slate-900">Movabi</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding bg-slate-50">
      <div class="flex flex-col h-full max-w-md mx-auto pt-8">
        <div class="mb-10 text-center">
          <h1 class="text-3xl font-display font-bold text-slate-900 mb-3">Reset Password</h1>
          <p class="text-slate-500 text-sm">Enter your new password below to regain access to your account.</p>
        </div>

        @if (errorMessage()) {
          <div class="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm animate-shake">
            <ion-icon name="alert-circle-outline" class="text-xl shrink-0"></ion-icon>
            <p class="font-medium">{{ errorMessage() }}</p>
          </div>
        }

        @if (isSuccess()) {
          <div class="bg-emerald-50 border border-emerald-100 rounded-3xl p-8 text-center animate-in fade-in zoom-in duration-300">
            <div class="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <ion-icon name="checkmark-circle-outline" class="text-4xl text-emerald-600"></ion-icon>
            </div>
            <h3 class="text-xl font-bold text-slate-900 mb-3">Password updated</h3>
            <p class="text-slate-600 text-sm leading-relaxed mb-8">
              Your password has been successfully reset. You can now sign in with your new password.
            </p>
            <ion-button 
              expand="block" 
              class="h-14 font-bold text-lg rounded-2xl shadow-xl shadow-emerald-600/20"
              routerLink="/auth/login"
            >
              Back to Sign In
            </ion-button>
          </div>
        } @else {
          <form [formGroup]="resetForm" (ngSubmit)="onSubmit()" class="space-y-6">
            <div>
              <label for="password" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">New Password</label>
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
              <label for="confirmPassword" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">Confirm New Password</label>
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
              @if (resetForm.errors?.['passwordMismatch'] && resetForm.get('confirmPassword')?.touched) {
                <p class="mt-1.5 ml-1 text-xs text-red-500 font-medium">Passwords do not match.</p>
              }
            </div>

            <ion-button 
              type="submit" 
              expand="block" 
              class="h-14 font-bold text-lg rounded-2xl shadow-xl shadow-blue-600/20"
              [disabled]="resetForm.invalid || isLoading()"
            >
              @if (isLoading()) {
                <ion-spinner name="crescent"></ion-spinner>
              } @else {
                Reset Password
              }
            </ion-button>
          </form>
        }
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, ReactiveFormsModule, RouterModule]
})
export class ResetPasswordPage {
  private fb = inject(FormBuilder);
  private supabase = inject(SupabaseService);
  private router = inject(Router);

  resetForm = this.fb.group({
    password: ['', [Validators.required, Validators.minLength(6)]],
    confirmPassword: ['', [Validators.required]]
  }, { validators: this.passwordMatchValidator });

  showPassword = signal(false);
  isLoading = signal(false);
  isSuccess = signal(false);
  errorMessage = signal<string | null>(null);

  passwordMatchValidator(g: FormGroup) {
    const password = g.get('password')?.value;
    const confirmPassword = g.get('confirmPassword')?.value;
    return password === confirmPassword ? null : { 'passwordMismatch': true };
  }

  togglePassword() {
    this.showPassword.update(v => !v);
  }

  async onSubmit() {
    if (this.resetForm.invalid) return;
    const { password } = this.resetForm.value;
    if (!password) return;

    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const { error } = await this.supabase.auth.updateUser({ password });
      if (error) throw error;
      this.isSuccess.set(true);
    } catch (err: unknown) {
      console.error('Password reset failed:', err);
      const message = err instanceof Error ? err.message : 'Failed to reset password. Please try again.';
      this.errorMessage.set(message);
    } finally {
      this.isLoading.set(false);
    }
  }
}
