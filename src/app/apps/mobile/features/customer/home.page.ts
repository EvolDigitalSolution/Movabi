import { Component, inject } from '@angular/core';
import { IonicModule, NavController } from '@ionic/angular';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { CardComponent, EmptyStateComponent } from '../../../../shared/ui';

@Component({
  selector: 'app-customer-home',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-title class="font-display font-black text-3xl tracking-tighter text-slate-900">Movabi</ion-title>
        <ion-buttons slot="end">
          @if (auth.userRole() === 'admin') {
            <button (click)="nav.navigateForward('/admin')" class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-sm active:scale-95 transition-all">
              <ion-icon name="shield-checkmark" class="text-xl"></ion-icon>
            </button>
          }
          <button (click)="nav.navigateForward('/customer/activity')" class="w-12 h-12 rounded-2xl bg-white text-slate-600 flex items-center justify-center border border-slate-200 shadow-sm ml-3 active:scale-95 transition-all">
            <ion-icon name="time-outline" class="text-xl"></ion-icon>
          </button>
          <button (click)="auth.signOut()" class="w-12 h-12 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100 shadow-sm ml-3 active:scale-95 transition-all">
            <ion-icon name="log-out-outline" class="text-xl"></ion-icon>
          </button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="max-w-2xl mx-auto p-6 space-y-10 pb-12">
        <!-- Hero Section -->
        <div class="relative bg-slate-900 rounded-[2.5rem] p-10 shadow-2xl shadow-slate-900/20 overflow-hidden group min-h-[320px] flex items-center">
          <!-- Background Image -->
          <div class="absolute inset-0">
            <img src="assets/images/movabi-customer-hero.webp" 
                 alt="Movabi Services" 
                 class="w-full h-full object-cover opacity-40 group-hover:scale-105 transition-transform duration-1000"
                 referrerpolicy="no-referrer">
          </div>
          <div class="absolute inset-0 bg-gradient-to-r from-slate-900 via-slate-900/80 to-transparent"></div>

          <div class="relative z-10 w-full">
            @let userEmail = auth.currentUser()?.email;
            <p class="text-blue-400 font-bold text-[10px] uppercase tracking-[0.3em] mb-4">Welcome Back</p>
            <h1 class="text-4xl font-display font-bold text-white mb-3 tracking-tight">
              Hello, {{ userEmail ? userEmail.split('@')[0] : 'User' }}!
            </h1>
            <p class="text-slate-300 font-medium text-lg">Where can we take you today?</p>
            
            <div class="mt-10 grid grid-cols-2 gap-4">
              <div class="bg-white/10 backdrop-blur-md rounded-3xl p-6 border border-white/10 group-hover:border-white/20 transition-colors">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Wallet Balance</p>
                <p class="text-2xl font-display font-bold text-white">£0.00</p>
              </div>
              <div class="bg-white/10 backdrop-blur-md rounded-3xl p-6 border border-white/10 group-hover:border-white/20 transition-colors">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Active Trips</p>
                <p class="text-2xl font-display font-bold text-white">0</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Services Grid -->
        <div class="space-y-6">
          <div class="flex items-center gap-3 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Our Premium Services</h3>
          </div>
          
          <div class="grid grid-cols-1 gap-5">
            <button (click)="goToBooking('ride')" 
                 class="w-full text-left group relative overflow-hidden bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-blue-600/10 hover:-translate-y-1 transition-all duration-500">
              <div class="flex items-center gap-6">
                <div class="w-20 h-20 bg-blue-600 rounded-[2rem] flex items-center justify-center text-white shadow-2xl shadow-blue-600/20 group-hover:rotate-6 transition-transform">
                  <ion-icon name="car" class="text-4xl"></ion-icon>
                </div>
                <div class="flex-1">
                  <h2 class="text-2xl font-display font-bold text-slate-900 mb-1">Book a Ride</h2>
                  <p class="text-slate-500 text-sm font-medium">Fixed price, no surge pricing.</p>
                </div>
                <div class="w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-blue-600 group-hover:text-white transition-all">
                  <ion-icon name="chevron-forward" class="text-xl"></ion-icon>
                </div>
              </div>
            </button>

            <button (click)="goToBooking('errand')" 
                 class="w-full text-left group relative overflow-hidden bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-emerald-600/10 hover:-translate-y-1 transition-all duration-500">
              <div class="flex items-center gap-6">
                <div class="w-20 h-20 bg-emerald-600 rounded-[2rem] flex items-center justify-center text-white shadow-2xl shadow-emerald-600/20 group-hover:rotate-6 transition-transform">
                  <ion-icon name="cart" class="text-4xl"></ion-icon>
                </div>
                <div class="flex-1">
                  <h2 class="text-2xl font-display font-bold text-slate-900 mb-1">Run an Errand</h2>
                  <p class="text-slate-500 text-sm font-medium">We shop and deliver for you.</p>
                </div>
                <div class="w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-emerald-600 group-hover:text-white transition-all">
                  <ion-icon name="chevron-forward" class="text-xl"></ion-icon>
                </div>
              </div>
            </button>

            <button (click)="nav.navigateForward('/customer/van-moving/create')" 
                 class="w-full text-left group relative overflow-hidden bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-indigo-600/10 hover:-translate-y-1 transition-all duration-500">
              <div class="flex items-center gap-6">
                <div class="w-20 h-20 bg-indigo-600 rounded-[2rem] flex items-center justify-center text-white shadow-2xl shadow-indigo-600/20 group-hover:rotate-6 transition-transform">
                  <ion-icon name="bus" class="text-4xl"></ion-icon>
                </div>
                <div class="flex-1">
                  <h2 class="text-2xl font-display font-bold text-slate-900 mb-1">Van Moving</h2>
                  <p class="text-slate-500 text-sm font-medium">Professional help for your move.</p>
                </div>
                <div class="w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-indigo-600 group-hover:text-white transition-all">
                  <ion-icon name="chevron-forward" class="text-xl"></ion-icon>
                </div>
              </div>
            </button>
          </div>
        </div>

        <!-- Recent Activity Section -->
        <div class="space-y-6">
          <div class="flex items-center justify-between px-1">
            <div class="flex items-center gap-3">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Recent Activity</h3>
            </div>
            <button (click)="nav.navigateForward('/customer/activity')" class="text-[10px] font-black text-blue-600 uppercase tracking-widest hover:text-blue-700 transition-colors">
              View All
            </button>
          </div>
          
          <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
            <app-empty-state 
              icon="receipt-outline"
              title="No recent activity"
              description="Your trips and errands will appear here once you start using Movabi."
              actionLabel="Book your first ride"
              (action)="goToBooking('ride')"
            ></app-empty-state>
          </div>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, CardComponent, EmptyStateComponent]
})
export class HomePage {
  public nav = inject(NavController);
  public auth = inject(AuthService);

  goToBooking(type: string) {
    this.nav.navigateForward(['/customer/request'], { queryParams: { type } });
  }
}
