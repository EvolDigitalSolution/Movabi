import { Component, inject, computed, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { 
  IonHeader, 
  IonToolbar, 
  IonTitle, 
  IonButtons, 
  IonContent, 
  IonIcon, 
  IonToggle, 
  IonSpinner,
  LoadingController, 
  ToastController 
} from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { 
  shieldCheckmark, 
  walletOutline, 
  logOutOutline, 
  locationOutline, 
  checkmarkDoneOutline, 
  starOutline, 
  moonOutline, 
  searchOutline, 
  optionsOutline, 
  star, 
  statsChart, 
  bus, 
  card,
  timeOutline,
  alertCircleOutline
} from 'ionicons/icons';
import { DriverService } from '../../../../../core/services/driver/driver.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { ProfileService } from '../../../../../core/services/profile/profile.service';
import { ConnectService } from '../../../../../core/services/stripe/connect.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { CardComponent, ButtonComponent, BadgeComponent, RatingComponent, EmptyStateComponent, PerformanceBadgeComponent } from '../../../../../shared/ui';
import { Booking, DriverProfile } from '../../../../../shared/models/booking.model';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';

@Component({
  selector: 'app-driver-dashboard',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-title class="font-display font-black text-3xl tracking-tighter text-slate-900">Driver Hub</ion-title>
        <ion-buttons slot="end">
          @if (auth.userRole() === 'admin') {
            <button (click)="router.navigate(['/admin'])" class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-sm active:scale-95 transition-all">
              <ion-icon name="shield-checkmark" class="text-xl"></ion-icon>
            </button>
          }
          <button (click)="router.navigate(['/driver/earnings'])" class="w-12 h-12 rounded-2xl bg-white text-slate-600 flex items-center justify-center border border-slate-200 shadow-sm ml-3 active:scale-95 transition-all">
            <ion-icon name="wallet-outline" class="text-xl"></ion-icon>
          </button>
          <button (click)="auth.signOut()" class="w-12 h-12 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100 shadow-sm ml-3 active:scale-95 transition-all">
            <ion-icon name="log-out-outline" class="text-xl"></ion-icon>
          </button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="max-w-2xl mx-auto p-6 space-y-10 pb-12">
        
        @if (!isVerified()) {
          <div class="bg-white rounded-[2.5rem] p-10 border border-slate-100 shadow-xl shadow-slate-200/50 text-center space-y-6">
            <div class="w-20 h-20 bg-amber-50 rounded-[2rem] flex items-center justify-center mx-auto border border-amber-100">
              <ion-icon name="time-outline" class="text-4xl text-amber-600"></ion-icon>
            </div>
            <div class="space-y-2">
              <h2 class="text-2xl font-display font-bold text-slate-900">Verification Pending</h2>
              <p class="text-slate-500 font-medium leading-relaxed">
                We're currently reviewing your documents. This usually takes 24-48 hours. We'll notify you once you're ready to hit the road!
              </p>
            </div>
            <div class="pt-4">
              <app-button variant="outline" (clicked)="router.navigate(['/driver/onboarding'])">
                Update Documents
              </app-button>
            </div>
          </div>
        } @else {
          @if (auth.stripeConnectStatus() !== 'enabled') {
            <div class="bg-rose-50 border border-rose-100 rounded-[2rem] p-8 space-y-4 animate-in fade-in slide-in-from-top duration-500">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 bg-rose-100 rounded-2xl flex items-center justify-center text-rose-600">
                  <ion-icon name="alert-circle-outline" class="text-2xl"></ion-icon>
                </div>
                <div>
                  <h3 class="font-display font-bold text-rose-900">Payouts Not Ready</h3>
                  <p class="text-xs text-rose-700 font-medium">Complete Stripe onboarding to accept funded errands.</p>
                </div>
              </div>
              <app-button variant="primary" color="error" size="sm" class="w-full" (clicked)="setupPayouts()">
                Setup Payouts
              </app-button>
            </div>
          }

          @if (locationError() && status() === 'online') {
            <div class="bg-amber-50 border border-amber-100 rounded-2xl p-4 flex items-center gap-3 text-amber-700 text-sm animate-in fade-in slide-in-from-top duration-300">
              <ion-icon name="location-outline" class="text-xl shrink-0"></ion-icon>
              <p class="font-medium">{{ locationError() }} Tracking is disabled.</p>
            </div>
          }

          <!-- Status Card -->
          <div class="relative bg-slate-900 rounded-[2.5rem] p-10 shadow-2xl shadow-slate-900/20 overflow-hidden group min-h-[320px] flex items-center">
            <!-- Background Image -->
            <div class="absolute inset-0">
              <img src="https://picsum.photos/seed/driver/1920/1080?blur=4" 
                   alt="Driver Dashboard" 
                   class="w-full h-full object-cover opacity-40 group-hover:scale-105 transition-transform duration-1000"
                   referrerpolicy="no-referrer">
            </div>
            <div class="absolute inset-0 bg-gradient-to-r from-slate-900 via-slate-900/80 to-transparent"></div>

            <div class="relative z-10 w-full">
              <div class="flex justify-between items-start mb-10">
                <div>
                  <span class="text-[10px] text-blue-400 font-bold tracking-[0.3em] uppercase block mb-2">Work Mode</span>
                  <h2 class="text-4xl font-display font-bold text-white tracking-tight">
                    {{ status() === 'online' ? (isAvailable() ? 'Active' : 'Busy') : 'Offline' }}
                  </h2>
                </div>
                <div class="flex gap-6">
                  <div class="flex flex-col items-center">
                    <span class="text-[8px] uppercase text-slate-500 font-bold mb-2 tracking-widest">Online</span>
                    <ion-toggle [checked]="status() === 'online'" (ionChange)="toggleStatus($event)" class="custom-toggle" color="success"></ion-toggle>
                  </div>
                  <div class="flex flex-col items-center">
                    <span class="text-[8px] uppercase text-slate-500 font-bold mb-2 tracking-widest">Available</span>
                    <ion-toggle [checked]="isAvailable()" (ionChange)="toggleAvailability($event)" class="custom-toggle" color="primary"></ion-toggle>
                  </div>
                </div>
              </div>
              
              <div class="flex flex-wrap gap-2 mb-6">
                <app-performance-badge type="pro-driver"></app-performance-badge>
                @if (rating() >= 4.8) {
                  <app-performance-badge type="top-rated"></app-performance-badge>
                }
                @if (acceptanceRate() >= 95) {
                  <app-performance-badge type="reliable"></app-performance-badge>
                }
              </div>

              <p class="text-slate-300 font-medium text-lg">
                @if (status() === 'offline') {
                  Go online to start earning
                } @else if (!isAvailable()) {
                  You are currently set to busy
                } @else {
                  Ready for new requests
                }
              </p>
            </div>
          </div>

          <!-- Performance Metrics Section -->
          <div class="space-y-6">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Performance Metrics</h3>
            </div>
            
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
                <div class="flex items-center justify-between mb-4">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
                      <ion-icon name="checkmark-done-outline"></ion-icon>
                    </div>
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Acceptance</span>
                  </div>
                  <app-badge [variant]="getMetricVariant(acceptanceRate())">
                    {{ getMetricLabel(acceptanceRate()) }}
                  </app-badge>
                </div>
                <p class="text-2xl font-display font-bold text-slate-900">{{ acceptanceRate() }}%</p>
                <div class="mt-2 h-1 w-full bg-slate-50 rounded-full overflow-hidden">
                  <div class="h-full bg-blue-600" [style.width.%]="acceptanceRate()"></div>
                </div>
              </div>
              
              <div class="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
                <div class="flex items-center gap-3 mb-4">
                  <div class="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600">
                    <ion-icon name="star-outline"></ion-icon>
                  </div>
                  <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rating</span>
                </div>
                <div class="flex flex-col gap-1">
                  <p class="text-2xl font-display font-bold text-slate-900">{{ rating() || 'N/A' }}</p>
                  <app-rating [rating]="rating()"></app-rating>
                </div>
              </div>
            </div>
          </div>

          <!-- Available Requests Section -->
          <div class="space-y-6">
            <div class="flex items-center justify-between px-1">
              <div class="flex items-center gap-3">
                <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
                <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em] flex items-center">
                  Available Requests
                  <span class="ml-3 px-2.5 py-0.5 bg-blue-600 text-white rounded-full text-[10px] font-black">{{ jobs().length }}</span>
                </h3>
              </div>
            </div>

            @if (status() === 'offline') {
              <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden py-12">
                <app-empty-state 
                  icon="moon-outline"
                  title="You are offline"
                  description="Go online to see available jobs in your area and start earning."
                  actionLabel="Go Online"
                  (action)="goOnline()"
                ></app-empty-state>
              </div>
            } @else if (jobs().length === 0) {
              <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden py-12">
                <app-empty-state 
                  icon="search-outline"
                  title="Searching for jobs"
                  description="We're looking for available requests in your area. We'll notify you as soon as one arrives."
                ></app-empty-state>
              </div>
            } @else {
              <div class="space-y-5">
                @for (job of jobs(); track job.id) {
                  <app-card [hoverable]="true" class="group">
                    <div class="flex justify-between items-start mb-8">
                      <app-badge variant="primary">{{ job.service_type?.name }}</app-badge>
                      <div class="text-right">
                        <span class="text-3xl font-display font-bold text-slate-900">{{ formatPrice(job.total_price) }}</span>
                        <p class="text-[10px] font-black text-emerald-600 uppercase tracking-widest mt-1">Est. Payout</p>
                      </div>
                    </div>
                    
                    <div class="relative pl-10 space-y-8 mb-10">
                      <!-- Vertical Line -->
                      <div class="absolute left-4 top-2 bottom-2 w-0.5 bg-slate-100 dashed border-l-2 border-slate-200 border-dashed"></div>

                      <div class="relative">
                        <div class="absolute -left-8 top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                        <div>
                          <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1.5">Pickup</p>
                          <p class="font-bold text-slate-900 leading-relaxed text-sm">{{ job.pickup_address }}</p>
                        </div>
                      </div>
                      <div class="relative">
                        <div class="absolute -left-8 top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                        <div>
                          <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1.5">Destination</p>
                          <p class="font-bold text-slate-900 leading-relaxed text-sm">{{ job.dropoff_address }}</p>
                        </div>
                      </div>
                    </div>

                    <div class="flex gap-4">
                      <app-button variant="outline" class="flex-1" [disabled]="submitting()" (clicked)="reject(job.id)">Pass</app-button>
                      <app-button variant="primary" class="flex-1 shadow-xl shadow-blue-600/20" [disabled]="submitting()" (clicked)="accept(job.id)">
                        {{ submitting() ? 'Accepting...' : 'Accept Job' }}
                      </app-button>
                    </div>
                  </app-card>
                }
              </div>
            }
          </div>

          <!-- Quick Actions Grid -->
          <div class="space-y-6">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Quick Actions</h3>
            </div>
            <div class="grid grid-cols-2 gap-5">
              <button (click)="router.navigate(['/driver/earnings'])" 
                      class="flex flex-col items-start p-8 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-blue-600/10 hover:-translate-y-1 transition-all duration-500 text-left group">
                <div class="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 mb-6 border border-blue-100 group-hover:bg-blue-600 group-hover:text-white transition-all">
                  <ion-icon name="stats-chart" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-bold text-slate-900 text-lg mb-1">Earnings</h4>
                <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">View your income</p>
              </button>

              <button (click)="router.navigate(['/driver/subscription'])" 
                      class="flex flex-col items-start p-8 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-amber-600/10 hover:-translate-y-1 transition-all duration-500 text-left group">
                <div class="w-14 h-14 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-600 mb-6 border border-amber-100 group-hover:bg-amber-600 group-hover:text-white transition-all">
                  <ion-icon name="star" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-bold text-slate-900 text-lg mb-1">Subscription</h4>
                <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Manage your plan</p>
              </button>

              <button (click)="router.navigate(['/driver/van-moving'])" 
                      class="flex flex-col items-start p-8 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-indigo-600/10 hover:-translate-y-1 transition-all duration-500 text-left group">
                <div class="w-14 h-14 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600 mb-6 border border-indigo-100 group-hover:bg-indigo-600 group-hover:text-white transition-all">
                  <ion-icon name="bus" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-bold text-slate-900 text-lg mb-1">Van Jobs</h4>
                <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Moving requests</p>
              </button>

              <button (click)="setupPayouts()" 
                      class="flex flex-col items-start p-8 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-emerald-600/10 hover:-translate-y-1 transition-all duration-500 text-left group">
                <div class="w-14 h-14 bg-emerald-50 rounded-2xl flex items-center justify-center text-emerald-600 mb-6 border border-emerald-100 group-hover:bg-emerald-600 group-hover:text-white transition-all">
                  <ion-icon name="card" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-bold text-slate-900 text-lg mb-1">Payouts</h4>
                <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Stripe Connect</p>
              </button>
            </div>
          </div>
        }
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [
    CommonModule, 
    IonHeader, 
    IonToolbar, 
    IonTitle, 
    IonButtons, 
    IonContent, 
    IonIcon, 
    IonToggle, 
    IonSpinner,
    CardComponent, 
    ButtonComponent, 
    BadgeComponent, 
    RatingComponent, 
    EmptyStateComponent, 
    PerformanceBadgeComponent
  ]
})
export class DriverDashboardPage implements OnInit, OnDestroy {
  public router = inject(Router);
  public auth = inject(AuthService);
  private driverService = inject(DriverService);
  private locationService = inject(LocationService);
  private profileService = inject(ProfileService);
  private connectService = inject(ConnectService);
  private supabase = inject(SupabaseService);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);
  private config = inject(AppConfigService);

  status = this.driverService.onlineStatus;
  isAvailable = this.driverService.isAvailable;
  jobs = this.driverService.availableJobs;
  locationError = this.locationService.locationError;
  submitting = signal(false);

  isVerified = computed(() => {
    const profile = this.profileService.profile() as DriverProfile | null;
    return profile?.is_verified ?? false;
  });

  acceptanceRate = computed(() => {
    const profile = this.profileService.profile() as DriverProfile | null;
    return profile?.acceptance_rate ?? 98;
  });

  rating = computed(() => {
    const profile = this.profileService.profile() as DriverProfile | null;
    return profile?.rating ?? 4.9;
  });

  constructor() {
    addIcons({ 
      shieldCheckmark, 
      walletOutline, 
      logOutOutline, 
      locationOutline, 
      checkmarkDoneOutline, 
      starOutline, 
      moonOutline, 
      searchOutline, 
      optionsOutline, 
      star, 
      statsChart, 
      bus, 
      card,
      timeOutline,
      alertCircleOutline
    });
  }

  formatPrice(amount: number) {
    return this.config.formatCurrency(amount);
  }

  ngOnInit() {
    if (!this.supabase.isConfigured) {
      console.warn('DriverDashboard: Supabase is not configured.');
      return;
    }

    this.driverService.fetchAvailableJobs();
    this.checkTracking();
    this.loadAvailability();
  }

  async loadAvailability() {
    const profile = this.profileService.profile() as DriverProfile | null;
    if (profile) {
      this.driverService.isAvailable.set(profile.is_available ?? true);
      this.driverService.onlineStatus.set(profile.status ?? 'offline');
    }
  }

  ngOnDestroy() {
    this.locationService.stopTracking();
  }

  async toggleStatus(event: Event) {
    const customEvent = event as CustomEvent;
    const isOnline = customEvent.detail.checked;
    await this.driverService.toggleOnline(isOnline ? 'online' : 'offline');
    
    // Update profiles table
    const profile = this.profileService.profile();
    if (profile) {
      await this.profileService.updateProfile(profile.id, { 
        is_online: isOnline,
        last_active_at: new Date().toISOString()
      });
    }
    
    this.checkTracking();
  }

  async goOnline() {
    await this.driverService.toggleOnline('online');
    const profile = this.profileService.profile();
    if (profile) {
      await this.profileService.updateProfile(profile.id, { 
        is_online: true,
        last_active_at: new Date().toISOString()
      });
    }
    this.checkTracking();
  }

  async toggleAvailability(event: Event) {
    const customEvent = event as CustomEvent;
    const available = customEvent.detail.checked;
    await this.driverService.toggleAvailability(available);
  }

  private checkTracking() {
    const profile = this.profileService.profile();
    if (this.status() === 'online' && profile) {
      this.locationService.startTracking(profile.tenant_id);
    } else {
      this.locationService.stopTracking();
    }
  }

  async accept(jobId: string) {
    if (this.submitting()) return;
    
    this.submitting.set(true);
    const loading = await this.loadingCtrl.create({ message: 'Accepting job...' });
    await loading.present();

    try {
      await this.driverService.acceptJob(jobId);
      await loading.dismiss();
      this.router.navigate(['/driver/job-details', jobId]);
    } catch (e: unknown) {
      await loading.dismiss();
      this.submitting.set(false);
      const message = e instanceof Error ? e.message : 'Job no longer available';
      const toast = await this.toastCtrl.create({ message, duration: 2000, color: 'danger' });
      toast.present();
      // Refresh list if it was already taken
      this.driverService.fetchAvailableJobs();
    }
  }

  reject(jobId: string) {
    // Simply remove from local list for now
    this.driverService.availableJobs.update((jobs: Booking[]) => jobs.filter((j: Booking) => j.id !== jobId));
  }

  getMetricLabel(value: number): string {
    if (value >= 85) return 'Excellent';
    if (value >= 70) return 'Good';
    return 'Needs improvement';
  }

  getMetricVariant(value: number): 'success' | 'warning' | 'error' | 'info' {
    if (value >= 85) return 'success';
    if (value >= 70) return 'info';
    return 'warning';
  }

  async setupPayouts() {
    const user = this.auth.currentUser();
    const profile = this.profileService.profile();
    if (!user || !profile) return;

    const loading = await this.loadingCtrl.create({ message: 'Loading payout settings...' });
    await loading.present();

    try {
      // Check if driver has a connect account
      const { data: account } = await this.supabase.client
        .from('driver_accounts')
        .select('*')
        .eq('user_id', user.id)
        .single();

      let accountId = account?.stripe_account_id;

      if (!accountId) {
        const result = await this.connectService.createAccount(user.id, user.email!, profile.tenant_id);
        accountId = result.stripe_account_id;
      }

      if (account?.payouts_enabled) {
        const link = await this.connectService.getDashboardLink(accountId);
        window.location.href = link.url;
      } else {
        const returnUrl = window.location.origin + '/driver/dashboard';
        const refreshUrl = window.location.origin + '/driver/dashboard';
        const link = await this.connectService.getOnboardingLink(accountId, returnUrl, refreshUrl);
        window.location.href = link.url;
      }
    } catch (error) {
      console.error('Payout Setup Error:', error);
      const toast = await this.toastCtrl.create({ message: 'Failed to load payout settings', duration: 2000, color: 'danger' });
      toast.present();
    } finally {
      await loading.dismiss();
    }
  }
}
