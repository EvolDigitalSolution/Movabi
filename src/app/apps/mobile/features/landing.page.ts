import { Component, inject, effect } from '@angular/core';
import { IonicModule } from '@ionic/angular';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth/auth.service';

@Component({
  selector: 'app-landing',
  template: `
    <ion-content class="bg-slate-50">
      <div class="flex flex-col min-h-screen">
        <!-- Hero Section -->
        <div class="relative h-[85vh] flex items-center justify-center overflow-hidden">
          <!-- Background Image Placeholder -->
          <div class="absolute inset-0 bg-slate-900">
            <img src="https://picsum.photos/seed/movabi-hero/1280/720" 
                 alt="Movabi Logistics" 
                 class="w-full h-full object-cover opacity-60 mix-blend-overlay scale-105 animate-slow-zoom"
                 referrerpolicy="no-referrer">
          </div>
          <div class="absolute inset-0 bg-gradient-to-b from-slate-900/60 via-slate-900/40 to-slate-900"></div>
          
          <div class="relative z-10 text-center px-8 max-w-3xl mx-auto">
            <div class="w-20 h-20 bg-white rounded-[2rem] flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-blue-900/40 border border-white/20 animate-bounce-slow">
              <ion-icon name="car" class="text-4xl text-blue-600"></ion-icon>
            </div>
            <h1 class="text-5xl md:text-7xl font-display font-black text-white mb-6 tracking-tighter leading-none">
              Movement <span class="text-blue-400">Redefined.</span>
            </h1>
            <p class="text-slate-300 text-lg md:text-xl font-medium max-w-xl mx-auto leading-relaxed mb-4">
              Reliable rides, efficient deliveries, and local errands — all in one platform built for the community.
            </p>
            <p class="text-blue-400 text-lg md:text-xl font-bold mb-12 animate-pulse">
              No surge pricing. Flexible driver plans. Just simple, fair movement.
            </p>
            
            <div class="flex flex-col sm:flex-row items-center justify-center gap-4">
              <ion-button 
                expand="block" 
                class="h-16 px-10 font-bold text-lg rounded-2xl shadow-2xl shadow-blue-600/40 w-full sm:w-auto"
                routerLink="/auth/signup"
              >
                Get Started
              </ion-button>
              <ion-button 
                expand="block" 
                fill="clear"
                class="h-16 px-10 font-bold text-lg text-white hover:text-blue-400 transition-colors w-full sm:w-auto"
                routerLink="/auth/login"
              >
                Sign In
              </ion-button>
            </div>
          </div>
        </div>

        <!-- Quick Actions Section -->
        <div class="bg-white rounded-t-[4rem] -mt-20 relative z-20 px-8 pt-20 pb-10">
          <div class="max-w-5xl mx-auto">
            <div class="flex flex-col md:flex-row items-end justify-between mb-12 gap-6">
              <div>
                <h2 class="text-4xl font-display font-bold text-slate-900 tracking-tight">Quick Services</h2>
                <p class="text-slate-500 font-medium mt-2">What do you need help with today?</p>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div routerLink="/auth/signup" class="group cursor-pointer bg-slate-50 p-8 rounded-[2.5rem] border border-slate-100 hover:bg-blue-600 hover:border-blue-500 transition-all duration-500 hover:-translate-y-2 hover:shadow-2xl hover:shadow-blue-600/20">
                <div class="w-16 h-16 rounded-2xl bg-blue-100 flex items-center justify-center mb-6 group-hover:bg-white/20 transition-colors">
                  <ion-icon name="car-outline" class="text-3xl text-blue-600 group-hover:text-white"></ion-icon>
                </div>
                <h3 class="text-2xl font-display font-bold text-slate-900 group-hover:text-white mb-2">Book a Ride</h3>
                <p class="text-slate-500 group-hover:text-blue-100 font-medium">Reliable local transport at fixed, fair prices.</p>
              </div>

              <div routerLink="/auth/signup" class="group cursor-pointer bg-slate-50 p-8 rounded-[2.5rem] border border-slate-100 hover:bg-emerald-600 hover:border-emerald-500 transition-all duration-500 hover:-translate-y-2 hover:shadow-2xl hover:shadow-emerald-600/20">
                <div class="w-16 h-16 rounded-2xl bg-emerald-100 flex items-center justify-center mb-6 group-hover:bg-white/20 transition-colors">
                  <ion-icon name="basket-outline" class="text-3xl text-emerald-600 group-hover:text-white"></ion-icon>
                </div>
                <h3 class="text-2xl font-display font-bold text-slate-900 group-hover:text-white mb-2">Run an Errand</h3>
                <p class="text-slate-500 group-hover:text-emerald-100 font-medium">Groceries, pharmacy, or any task you need done.</p>
              </div>

              <div routerLink="/auth/signup" class="group cursor-pointer bg-slate-50 p-8 rounded-[2.5rem] border border-slate-100 hover:bg-amber-600 hover:border-amber-500 transition-all duration-500 hover:-translate-y-2 hover:shadow-2xl hover:shadow-amber-600/20">
                <div class="w-16 h-16 rounded-2xl bg-amber-100 flex items-center justify-center mb-6 group-hover:bg-white/20 transition-colors">
                  <ion-icon name="cube-outline" class="text-3xl text-amber-600 group-hover:text-white"></ion-icon>
                </div>
                <h3 class="text-2xl font-display font-bold text-slate-900 group-hover:text-white mb-2">Send a Delivery</h3>
                <p class="text-slate-500 group-hover:text-amber-100 font-medium">Fast and secure delivery for your packages.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Value Proposition Sections -->
        <div class="bg-white px-8 py-20 space-y-32">
          
          <!-- For Customers -->
          <div class="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div class="space-y-8">
              <div class="inline-flex items-center gap-2 px-4 py-2 bg-blue-50 rounded-full border border-blue-100">
                <div class="w-2 h-2 rounded-full bg-blue-500"></div>
                <span class="text-[10px] font-bold text-blue-600 uppercase tracking-widest">For Customers</span>
              </div>
              <h2 class="text-4xl font-display font-bold text-slate-900 tracking-tight leading-tight">
                Transparent pricing, <br>no surprises.
              </h2>
              <p class="text-slate-500 text-lg font-medium leading-relaxed">
                From a quick ride across town to moving your entire home, Movabi provides fixed-price, reliable services. We charge a small service fee to support the platform, ensuring fair pay for everyone.
              </p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="flex items-start gap-4">
                  <div class="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 shrink-0">
                    <ion-icon name="checkmark-circle" class="text-xl"></ion-icon>
                  </div>
                  <div>
                    <h4 class="font-bold text-slate-900">Fixed Pricing</h4>
                    <p class="text-xs text-slate-500 mt-1">Know your fare before you book.</p>
                  </div>
                </div>
                <div class="flex items-start gap-4">
                  <div class="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 shrink-0">
                    <ion-icon name="shield-checkmark" class="text-xl"></ion-icon>
                  </div>
                  <div>
                    <h4 class="font-bold text-slate-900">Verified Drivers</h4>
                    <p class="text-xs text-slate-500 mt-1">Safety is our top priority.</p>
                  </div>
                </div>
              </div>
            </div>
            <div class="relative">
              <div class="aspect-square bg-slate-100 rounded-[3rem] overflow-hidden shadow-2xl shadow-slate-200/50 group">
                <img src="https://picsum.photos/seed/movabi-ride/800/800" 
                     alt="Movabi Ride Service" 
                     class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                     referrerpolicy="no-referrer">
              </div>
              <div class="absolute -bottom-10 -left-10 bg-white p-8 rounded-3xl shadow-2xl border border-slate-50 max-w-[240px] hidden sm:block">
                <div class="flex items-center gap-4 mb-4">
                  <div class="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white">
                    <ion-icon name="car" class="text-2xl"></ion-icon>
                  </div>
                  <div class="flex-1">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Next Ride</p>
                    <p class="text-sm font-bold text-slate-900">Arriving in 4m</p>
                  </div>
                </div>
                <div class="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                  <div class="h-full bg-blue-600 w-2/3"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- For Drivers -->
          <div class="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div class="order-2 lg:order-1 relative">
              <div class="aspect-square bg-slate-900 rounded-[3rem] overflow-hidden shadow-2xl shadow-blue-900/20 group">
                <img src="https://picsum.photos/seed/movabi-driver/800/800" 
                     alt="Movabi Driver" 
                     class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 opacity-80"
                     referrerpolicy="no-referrer">
              </div>
              <div class="absolute -top-10 -right-10 bg-slate-900 p-8 rounded-3xl shadow-2xl border border-white/10 max-w-[240px] hidden sm:block">
                <p class="text-blue-400 text-[10px] font-bold uppercase tracking-widest mb-2">Driver Earnings</p>
                <p class="text-3xl font-display font-bold text-white mb-4">£1,240.00</p>
                <div class="flex items-center gap-2 text-emerald-400 text-[10px] font-bold uppercase tracking-widest">
                  <ion-icon name="trending-up"></ion-icon>
                  <span>+12% this week</span>
                </div>
              </div>
            </div>
            <div class="order-1 lg:order-2 space-y-8">
              <div class="inline-flex items-center gap-2 px-4 py-2 bg-amber-50 rounded-full border border-amber-100">
                <div class="w-2 h-2 rounded-full bg-amber-500"></div>
                <span class="text-[10px] font-bold text-amber-600 uppercase tracking-widest">For Drivers</span>
              </div>
              <h2 class="text-4xl font-display font-bold text-slate-900 tracking-tight leading-tight">
                Choose the way <br>you want to earn.
              </h2>
              <p class="text-slate-500 text-lg font-medium leading-relaxed">
                Whether you drive occasionally or every day, Movabi gives you a pricing option that fits your lifestyle. Start flexible or go Pro to maximize your take-home pay.
              </p>
              
              <div class="grid grid-cols-1 gap-4">
                <!-- Starter Plan Card -->
                <div class="p-6 bg-slate-50 rounded-3xl border border-slate-100 group hover:border-blue-200 transition-all">
                  <div class="flex justify-between items-start mb-4">
                    <div>
                      <h3 class="text-xl font-display font-bold text-slate-900">Starter Plan</h3>
                      <p class="text-xs font-bold text-blue-600 uppercase tracking-widest">Flexible</p>
                    </div>
                    <div class="text-right">
                      <p class="text-2xl font-display font-bold text-slate-900">£0</p>
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">per month</p>
                    </div>
                  </div>
                  <ul class="space-y-2 mb-6">
                    <li class="flex items-center gap-2 text-sm text-slate-600">
                      <ion-icon name="checkmark-circle" class="text-emerald-500"></ion-icon>
                      Pay only when you earn
                    </li>
                    <li class="flex items-center gap-2 text-sm text-slate-600">
                      <ion-icon name="checkmark-circle" class="text-emerald-500"></ion-icon>
                      10–15% commission per job
                    </li>
                    <li class="flex items-center gap-2 text-sm text-slate-600">
                      <ion-icon name="checkmark-circle" class="text-emerald-500"></ion-icon>
                      Ideal for occasional drivers
                    </li>
                  </ul>
                </div>

                <!-- Pro Plan Card -->
                <div class="p-6 bg-blue-600 rounded-3xl border border-blue-500 shadow-xl shadow-blue-600/20 relative overflow-hidden">
                  <div class="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16 blur-2xl"></div>
                  <div class="relative z-10">
                    <div class="flex justify-between items-start mb-4">
                      <div>
                        <h3 class="text-xl font-display font-bold text-white">Pro Plan</h3>
                        <p class="text-xs font-bold text-blue-200 uppercase tracking-widest">Best for active drivers</p>
                      </div>
                      <div class="text-right">
                        <p class="text-2xl font-display font-bold text-white">Fixed Fee</p>
                        <p class="text-[10px] font-bold text-blue-200 uppercase tracking-widest">monthly</p>
                      </div>
                    </div>
                    <ul class="space-y-2 mb-6">
                      <li class="flex items-center gap-2 text-sm text-blue-50">
                        <ion-icon name="checkmark-circle" class="text-emerald-400"></ion-icon>
                        Keep 100% of your fares
                      </li>
                      <li class="flex items-center gap-2 text-sm text-blue-50">
                        <ion-icon name="checkmark-circle" class="text-emerald-400"></ion-icon>
                        No heavy commission cuts
                      </li>
                      <li class="flex items-center gap-2 text-sm text-blue-50">
                        <ion-icon name="checkmark-circle" class="text-emerald-400"></ion-icon>
                        Predictable monthly cost
                      </li>
                    </ul>
                  </div>
                </div>
              </div>

              <ion-button 
                expand="block" 
                class="h-16 px-10 font-bold text-lg rounded-2xl shadow-xl shadow-blue-600/20"
                routerLink="/auth/signup"
              >
                Become a Driver
              </ion-button>
              <p class="text-center text-xs text-slate-400 font-medium italic">
                Start flexible. Upgrade when you're ready.
              </p>
            </div>
          </div>

        </div>

        <!-- Footer CTA -->
        <div class="bg-slate-900 py-32 px-8 text-center relative overflow-hidden">
          <div class="absolute inset-0 bg-blue-600/5"></div>
          <div class="relative z-10 max-w-2xl mx-auto space-y-10">
            <h2 class="text-5xl font-display font-bold text-white tracking-tight">Ready to move with us?</h2>
            <p class="text-slate-400 text-xl font-medium leading-relaxed">
              Join Movabi today and experience the future of local logistics.
            </p>
            <div class="flex flex-col sm:flex-row items-center justify-center gap-6">
              <ion-button 
                expand="block" 
                class="h-16 px-12 font-bold text-lg rounded-2xl shadow-2xl shadow-blue-600/40 w-full sm:w-auto"
                routerLink="/auth/signup"
              >
                Create Free Account
              </ion-button>
            </div>
            <div class="pt-12">
              <p class="text-[10px] font-bold text-slate-500 uppercase tracking-[0.3em]">
                © 2026 Movabi Logistics Platform
              </p>
            </div>
          </div>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, RouterModule]
})
export class LandingPage {
  private auth = inject(AuthService);
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

  private redirectByRole(role: string) {
    if (role === 'admin') {
      this.router.navigate(['/admin']);
    } else if (role === 'driver') {
      this.router.navigate(['/driver']);
    } else {
      this.router.navigate(['/customer']);
    }
  }
}
