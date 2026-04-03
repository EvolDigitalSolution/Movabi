import { Component, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, LoadingController, ToastController } from '@ionic/angular';
import { DriverService } from '../../../../../core/services/driver/driver.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { ProfileService } from '../../../../../core/services/profile/profile.service';
import { ConnectService } from '../../../../../core/services/stripe/connect.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../../shared/ui';

@Component({
  selector: 'app-driver-dashboard',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4">
        <ion-title class="font-display font-bold text-2xl">Driver Hub</ion-title>
        <ion-buttons slot="end">
          @if (auth.userRole() === 'admin') {
            <ion-button (click)="nav.navigateForward('/admin')" color="primary">
              <ion-icon name="shield-checkmark-outline" slot="icon-only"></ion-icon>
            </ion-button>
          }
          <ion-button (click)="nav.navigateForward('/driver/earnings')">
            <ion-icon name="wallet-outline" slot="icon-only"></ion-icon>
          </ion-button>
          <ion-button (click)="auth.signOut()">
            <ion-icon name="log-out-outline" slot="icon-only"></ion-icon>
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <div class="bg-secondary rounded-3xl p-6 mb-8 text-white relative overflow-hidden shadow-xl">
        <div class="relative z-10">
          <div class="flex justify-between items-center mb-6">
            <span class="text-gray-400 text-sm font-semibold tracking-wider uppercase">Current Status</span>
            <div class="flex gap-6">
              <div class="flex flex-col items-center">
                <span class="text-[10px] uppercase text-gray-500 font-bold mb-1">Online</span>
                <ion-toggle [checked]="status() === 'online'" (ionChange)="toggleStatus($event)" color="success"></ion-toggle>
              </div>
              <div class="flex flex-col items-center">
                <span class="text-[10px] uppercase text-gray-500 font-bold mb-1">Available</span>
                <ion-toggle [checked]="isAvailable()" (ionChange)="toggleAvailability($event)" color="primary"></ion-toggle>
              </div>
            </div>
          </div>
          <h2 class="text-3xl font-display font-bold text-white mb-1">{{ status() === 'online' ? 'You are Online' : 'You are Offline' }}</h2>
          <p class="text-gray-400 font-medium">{{ status() === 'online' ? 'Waiting for requests...' : 'Go online to start earning' }}</p>
        </div>
        <div class="absolute -right-4 -bottom-4 text-9xl text-white/5 rotate-12">
          <ion-icon name="car"></ion-icon>
        </div>
      </div>

      <div class="mb-8">
        <h3 class="text-lg font-display font-bold mb-4 flex items-center">
          Available Requests
          <app-badge variant="primary" class="ml-2">{{ jobs().length }}</app-badge>
        </h3>

        @if (status() === 'offline') {
          <app-card>
            <div class="text-center py-8">
              <ion-icon name="moon-outline" class="text-5xl text-gray-200 mb-3"></ion-icon>
              <p class="text-text-secondary font-medium">Go online to see available jobs in your area.</p>
            </div>
          </app-card>
        } @else if (jobs().length === 0) {
          <app-card>
            <div class="text-center py-8">
              <ion-spinner name="crescent" color="primary" class="mb-3"></ion-spinner>
              <p class="text-text-secondary font-medium">Searching for nearby requests...</p>
            </div>
          </app-card>
        } @else {
          <div class="space-y-4">
            @for (job of jobs(); track job.id) {
              <app-card [hoverable]="true">
                <div class="flex justify-between items-center mb-4">
                  <app-badge variant="secondary">{{ job.service_type?.name }}</app-badge>
                  <span class="text-2xl font-bold text-primary">£{{ job.total_price }}</span>
                </div>
                
                <div class="space-y-4 mb-6">
                  <div class="flex items-start">
                    <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center mr-3 shrink-0">
                      <ion-icon name="pin" class="text-primary"></ion-icon>
                    </div>
                    <div>
                      <p class="text-[10px] text-text-secondary uppercase font-bold tracking-tighter">Pickup</p>
                      <p class="font-semibold text-text-primary">{{ job.pickup_address }}</p>
                    </div>
                  </div>
                  <div class="flex items-start">
                    <div class="w-8 h-8 rounded-full bg-success/10 flex items-center justify-center mr-3 shrink-0">
                      <ion-icon name="flag" class="text-success"></ion-icon>
                    </div>
                    <div>
                      <p class="text-[10px] text-text-secondary uppercase font-bold tracking-tighter">Destination</p>
                      <p class="font-semibold text-text-primary">{{ job.dropoff_address }}</p>
                    </div>
                  </div>
                </div>

                <div class="flex gap-3">
                  <app-button variant="secondary" class="flex-1" (onClick)="reject(job.id)">Reject</app-button>
                  <app-button variant="primary" class="flex-1" (onClick)="accept(job.id)">Accept</app-button>
                </div>
              </app-card>
            }
          </div>
        }
      </div>

      <div class="grid grid-cols-2 gap-4">
        <app-card [hoverable]="true" (click)="nav.navigateForward('/driver/earnings')">
          <ion-icon name="stats-chart-outline" class="text-2xl text-blue-600 mb-2"></ion-icon>
          <h4 class="font-bold text-text-primary">Earnings</h4>
          <p class="text-xs text-text-secondary">View your income</p>
        </app-card>
        <app-card [hoverable]="true" (click)="nav.navigateForward('/driver/subscription')">
          <ion-icon name="star-outline" class="text-2xl text-amber-500 mb-2"></ion-icon>
          <h4 class="font-bold text-text-primary">Subscription</h4>
          <p class="text-xs text-text-secondary">Manage your plan</p>
        </app-card>
        <app-card [hoverable]="true" (click)="nav.navigateForward('/driver/van-moving')">
          <ion-icon name="bus-outline" class="text-2xl text-indigo-600 mb-2"></ion-icon>
          <h4 class="font-bold text-text-primary">Van Jobs</h4>
          <p class="text-xs text-text-secondary">View moving requests</p>
        </app-card>
        <app-card [hoverable]="true" (click)="setupPayouts()">
          <ion-icon name="card-outline" class="text-2xl text-emerald-600 mb-2"></ion-icon>
          <h4 class="font-bold text-text-primary">Payouts</h4>
          <p class="text-xs text-text-secondary">Stripe Connect</p>
        </app-card>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, CardComponent, ButtonComponent, BadgeComponent]
})
export class DriverDashboardPage implements OnInit, OnDestroy {
  public nav = inject(NavController);
  public auth = inject(AuthService);
  private driverService = inject(DriverService);
  private locationService = inject(LocationService);
  private profileService = inject(ProfileService);
  private connectService = inject(ConnectService);
  private supabase = inject(SupabaseService);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);

  status = this.driverService.onlineStatus;
  jobs = this.driverService.availableJobs;
  isAvailable = signal(true);

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
    const profile = this.profileService.profile();
    if (profile) {
      this.isAvailable.set(profile.is_available ?? true);
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

  async toggleAvailability(event: Event) {
    const customEvent = event as CustomEvent;
    const available = customEvent.detail.checked;
    this.isAvailable.set(available);
    
    const profile = this.profileService.profile();
    if (profile) {
      await this.profileService.updateProfile(profile.id, { is_available: available });
    }
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
    const loading = await this.loadingCtrl.create({ message: 'Accepting job...' });
    await loading.present();

    try {
      await this.driverService.acceptJob(jobId);
      await loading.dismiss();
      this.nav.navigateForward(['/driver/job-details', jobId]);
    } catch {
      await loading.dismiss();
      const toast = await this.toastCtrl.create({ message: 'Job no longer available', duration: 2000, color: 'danger' });
      toast.present();
    }
  }

  reject(jobId: string) {
    // Simply remove from local list for now
    this.driverService.availableJobs.update((jobs: any[]) => jobs.filter((j: any) => j.id !== jobId));
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
