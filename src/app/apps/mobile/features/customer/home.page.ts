import { Component, inject } from '@angular/core';
import { IonicModule, NavController } from '@ionic/angular';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { CardComponent, ButtonComponent } from '../../../../shared/ui';

@Component({
  selector: 'app-customer-home',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4">
        <ion-title class="font-display font-bold text-2xl">MoveMate</ion-title>
        <ion-buttons slot="end">
          @if (auth.userRole() === 'admin') {
            <ion-button (click)="nav.navigateForward('/admin')" color="primary">
              <ion-icon name="shield-checkmark-outline" slot="icon-only"></ion-icon>
            </ion-button>
          }
          <ion-button (click)="nav.navigateForward('/customer/activity')">
            <ion-icon name="time-outline" slot="icon-only"></ion-icon>
          </ion-button>
          <ion-button (click)="auth.signOut()">
            <ion-icon name="log-out-outline" slot="icon-only"></ion-icon>
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <div class="mb-8 container-padding">
        @let userEmail = auth.currentUser()?.email;
        <h1>Hello, {{ userEmail ? userEmail.split('@')[0] : 'User' }}!</h1>
        <p>What do you need today?</p>
      </div>

      <div class="grid grid-cols-1 gap-6 px-4">
        <div (click)="goToBooking('ride')" class="relative overflow-hidden bg-blue-600 p-6 rounded-3xl shadow-lg active:scale-95 transition-all duration-200 cursor-pointer group">
          <div class="relative z-10">
            <h2 class="text-white text-2xl font-bold mb-1">Book a Ride</h2>
            <p class="text-blue-100 mt-1 opacity-90">Fixed price, no surge.</p>
            <div class="mt-4 text-white font-bold flex items-center group-hover:translate-x-1 transition-transform">
              Request Now <ion-icon name="arrow-forward" class="ml-2"></ion-icon>
            </div>
          </div>
          <ion-icon name="car" class="absolute -right-4 -bottom-4 text-9xl text-blue-500/30 rotate-12"></ion-icon>
        </div>

        <div (click)="goToBooking('errand')" class="relative overflow-hidden bg-emerald-600 p-6 rounded-3xl shadow-lg active:scale-95 transition-all duration-200 cursor-pointer group">
          <div class="relative z-10">
            <h2 class="text-white text-2xl font-bold mb-1">Run an Errand</h2>
            <p class="text-emerald-100 mt-1 opacity-90">We buy and deliver for you.</p>
            <div class="mt-4 text-white font-bold flex items-center group-hover:translate-x-1 transition-transform">
              Request Now <ion-icon name="arrow-forward" class="ml-2"></ion-icon>
            </div>
          </div>
          <ion-icon name="cart" class="absolute -right-4 -bottom-4 text-9xl text-emerald-500/30 rotate-12"></ion-icon>
        </div>

        <div (click)="nav.navigateForward('/customer/van-moving/create')" class="relative overflow-hidden bg-indigo-600 p-6 rounded-3xl shadow-lg active:scale-95 transition-all duration-200 cursor-pointer group">
          <div class="relative z-10">
            <h2 class="text-white text-2xl font-bold mb-1">Van Moving</h2>
            <p class="text-indigo-100 mt-1 opacity-90">Professional help for your move.</p>
            <div class="mt-4 text-white font-bold flex items-center group-hover:translate-x-1 transition-transform">
              Book Now <ion-icon name="arrow-forward" class="ml-2"></ion-icon>
            </div>
          </div>
          <ion-icon name="bus" class="absolute -right-4 -bottom-4 text-9xl text-indigo-500/30 rotate-12"></ion-icon>
        </div>
      </div>

      <div class="mt-12 px-4">
        <h3 class="text-lg font-bold mb-4 font-display">Recent Activity</h3>
        <app-card>
          <div class="text-center py-4">
            <ion-icon name="receipt-outline" class="text-4xl text-gray-200 mb-2"></ion-icon>
            <p class="text-sm">Your recent trips will appear here.</p>
            <app-button variant="ghost" size="sm" [fullWidth]="false" (onClick)="nav.navigateForward('/customer/activity')" class="mt-2">
              View All
            </app-button>
          </div>
        </app-card>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, CardComponent, ButtonComponent]
})
export class HomePage {
  public nav = inject(NavController);
  public auth = inject(AuthService);

  goToBooking(type: string) {
    this.nav.navigateForward(['/customer/request'], { queryParams: { type } });
  }
}
