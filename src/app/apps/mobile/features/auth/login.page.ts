import { Component, inject, effect } from '@angular/core';
import { IonicModule, NavController } from '@ionic/angular';
import { Router } from '@angular/router';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-login',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4">
        <ion-title class="font-bold text-2xl">MoveMate</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <div class="flex flex-col items-center justify-center h-full max-w-md mx-auto">
        <div class="w-20 h-20 bg-blue-600 rounded-3xl flex items-center justify-center shadow-xl shadow-blue-600/20 mb-8">
          <ion-icon name="car" class="text-4xl text-white"></ion-icon>
        </div>
        
        <h1 class="text-3xl font-bold text-gray-900 mb-2">Welcome Back</h1>
        <p class="text-gray-500 mb-12 text-center px-8">Sign in to access your MoveMate account and start your journey.</p>
        
        <ion-button expand="block" class="w-full h-14 font-bold text-lg rounded-2xl shadow-lg shadow-blue-600/10" (click)="login()">
          <ion-icon name="logo-google" slot="start" class="mr-2"></ion-icon>
          Sign In with Google
        </ion-button>
        
        <div class="mt-12 flex flex-col items-center gap-4">
          <p class="text-xs font-bold text-gray-400 uppercase tracking-widest">MVP Prototype</p>
          <div class="flex gap-4">
            <div class="w-2 h-2 rounded-full bg-blue-600"></div>
            <div class="w-2 h-2 rounded-full bg-emerald-600"></div>
            <div class="w-2 h-2 rounded-full bg-amber-600"></div>
          </div>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule]
})
export class LoginPage {
  public auth = inject(AuthService);
  private nav = inject(NavController);
  private router = inject(Router);

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();
      const role = this.auth.userRole();
      
      if (user && role) {
        this.redirectByRole(role);
      }
    });
  }

  async login() {
    try {
      await this.auth.signInWithGoogle();
    } catch (error) {
      console.error('Login failed:', error);
    }
  }

  private redirectByRole(role: string) {
    const currentPath = window.location.pathname;
    const isAdminApp = currentPath.startsWith('/admin') || this.router.url.includes('admin');

    if (role === 'admin') {
      // If we are in the mobile app, we should probably tell the user to go to the web app
      // But for this environment, we'll just redirect to /admin if it's available
      this.router.navigate(['/admin']);
    } else if (role === 'driver') {
      this.router.navigate(['/driver']);
    } else {
      this.router.navigate(['/customer']);
    }
  }
}
