import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import { AuthService } from '../../../../core/services/auth/auth.service';

@Component({
  selector: 'app-auth-callback',
  template: `
    <ion-content class="ion-padding bg-slate-50">
      <div class="flex flex-col items-center justify-center h-full text-center space-y-8 max-w-md mx-auto">
        @if (callbackError()) {
          <div class="w-20 h-20 bg-orange-50 rounded-[2rem] flex items-center justify-center shadow-2xl shadow-orange-200/40 border border-orange-100">
            <ion-icon name="alert-circle-outline" class="text-4xl text-orange-600"></ion-icon>
          </div>
          <div class="space-y-3">
            <h3 class="text-2xl font-display font-bold text-slate-900">{{ callbackTitle() }}</h3>
            <p class="text-slate-600 font-medium leading-relaxed">{{ callbackError() }}</p>
          </div>
          <div class="grid gap-3 w-full">
            <ion-button routerLink="/auth/login" class="h-14 font-bold rounded-2xl">
              Back to sign in
            </ion-button>
            <ion-button routerLink="/auth/signup" fill="outline" class="h-14 font-bold rounded-2xl">
              Create account
            </ion-button>
          </div>
        } @else {
          <div class="w-20 h-20 bg-white rounded-[2rem] flex items-center justify-center shadow-2xl shadow-slate-200/50 border border-slate-100">
            <ion-spinner name="crescent" color="primary"></ion-spinner>
          </div>
          <div class="space-y-2">
            <h3 class="text-xl font-display font-bold text-slate-900">Authenticating...</h3>
            <p class="text-slate-500 font-medium">Please wait while we finalize your session.</p>
          </div>
        }
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, RouterModule]
})
export class AuthCallbackPage implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);

  callbackTitle = signal('Sign-in could not continue');
  callbackError = signal<string | null>(null);

    async ngOnInit() {
        const oauthError = this.getOAuthError();

        if (oauthError) {
            this.callbackTitle.set(oauthError.title);
            this.callbackError.set(oauthError.message);
            return;
        }

        const code = this.getCallbackCode();
        const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');

        try {
            if (code) {
                await this.auth.completeOAuthCallback(code);
            } else if (accessToken && refreshToken) {
                await this.auth.completeOAuthHashCallback(accessToken, refreshToken);
            }

            await this.waitForAuthReady();
            await this.auth.handlePostAuthRedirect();
        } catch (error) {
            console.error('[AuthCallback] callback failed:', error);
            this.callbackTitle.set('Google sign-in failed');
            this.callbackError.set('Movabi could not finish Google sign-in. Please try again or use email and password.');
        }
    }

  private getOAuthError(): { title: string; message: string } | null {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const code = params.get('error') || hashParams.get('error');
    const description = params.get('error_description') || hashParams.get('error_description');

    if (!code) return null;

    if (code === 'access_denied') {
      return {
        title: 'Google sign-in was cancelled',
        message: 'No account was changed. You can try Google again or sign in with email and password.'
      };
    }

    return {
      title: 'Google sign-in failed',
      message: description || 'Google could not complete sign-in. Please try again or use email and password.'
    };
  }

  private async waitForAuthReady(): Promise<void> {
    const startedAt = Date.now();

    while (!this.auth.isAuthReady() && Date.now() - startedAt < 8000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private getCallbackCode(): string | null {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    return params.get('code') || hashParams.get('code');
  }
}
