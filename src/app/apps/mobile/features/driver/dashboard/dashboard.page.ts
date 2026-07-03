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
    LoadingController,
    ToastController
} from '@ionic/angular/standalone';
import { ActivatedRoute, Router } from '@angular/router';
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
    star,
    statsChart,
    card,
    timeOutline,
    alertCircleOutline,
    flashOutline,
    radioOutline,
    cashOutline,
    checkmarkCircleOutline,
    personAddOutline,
    listOutline,
    navigate,
    chevronDownOutline,
    settingsOutline
} from 'ionicons/icons';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Haptics, NotificationType } from '@capacitor/haptics';

import { DriverService } from '../../../../../core/services/driver/driver.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { ProfileService } from '../../../../../core/services/profile/profile.service';
import { ConnectService } from '../../../../../core/services/stripe/connect.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { VehicleCompatibilityService } from '../../../../../core/services/driver/vehicle-compatibility.service';
import { OneSignalService } from '../../../../../core/services/notification/onesignal.service';
import { OnboardingTourService } from '../../../../../core/services/onboarding-tour/onboarding-tour.service';
import {
    CardComponent,
    ButtonComponent,
    BadgeComponent,
    RatingComponent,
    EmptyStateComponent,
    PerformanceBadgeComponent,
    MovabiCarouselComponent,
    MovabiCarouselSlide
} from '../../../../../shared/ui';
import { MapComponent } from '../../../../../shared/components/map/map.component';
import { Booking, DriverProfile, ServiceTypeEnum } from '../../../../../shared/models/booking.model';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import { MapProviderService } from '../../../../../core/services/maps/map-provider.service';
import { GeocodingService } from '../../../../../core/services/maps/geocoding.service';
import { RoutingService } from '../../../../../core/services/maps/routing.service';

type ToastColor = 'success' | 'danger' | 'warning';

type StripeUiState = {
    accountId: string | null;
    status: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
};

type MetricState = {
    value: number | null;
    label: string;
    display: string;
    isNew: boolean;
};

type DriverDashboardStats = {
    todayJobs: number;
    acceptedJobs: number;
    completedJobs: number;
};

type PassedJob = {
    id: string;
    passedAt: number;
};

@Component({
    selector: 'app-driver-dashboard',
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
        CardComponent,
        ButtonComponent,
        BadgeComponent,
        RatingComponent,
        EmptyStateComponent,
        PerformanceBadgeComponent,
        MovabiCarouselComponent,
        MapComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-3 bg-slate-50">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <ion-title class="font-display font-black text-[1.4rem] tracking-tighter text-slate-950">
              Driver Hub
            </ion-title>
            @if (status() === 'online' && isAvailable()) {
              <div class="flex items-center gap-1.5 px-2 py-1 bg-emerald-50 border border-emerald-100 rounded-full">
                <div class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                <span class="text-[10px] font-bold text-emerald-700 uppercase tracking-wide">Online</span>
              </div>
            } @else if (status() === 'online') {
              <div class="flex items-center gap-1.5 px-2 py-1 bg-amber-50 border border-amber-100 rounded-full">
                <div class="w-2 h-2 bg-amber-500 rounded-full"></div>
                <span class="text-[10px] font-bold text-amber-700 uppercase tracking-wide">Busy</span>
              </div>
            } @else {
              <div class="flex items-center gap-1.5 px-2 py-1 bg-slate-100 border border-slate-200 rounded-full">
                <div class="w-2 h-2 bg-slate-400 rounded-full"></div>
                <span class="text-[10px] font-bold text-slate-600 uppercase tracking-wide">Offline</span>
              </div>
            }
          </div>

          <ion-buttons slot="end">
            @if (auth.userRole() === 'admin') {
              <button
                type="button"
                (click)="router.navigate(['/dashboard'])"
                class="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-700 flex items-center justify-center border border-indigo-100 shadow-sm active:scale-95 transition-all"
              >
                <ion-icon name="shield-checkmark" class="text-lg"></ion-icon>
              </button>
            }

            <button
              type="button"
              (click)="router.navigate(['/driver/earnings'])"
              class="w-9 h-9 rounded-xl bg-white text-slate-700 flex items-center justify-center border border-slate-200 shadow-sm ml-2 active:scale-95 transition-all"
            >
              <ion-icon name="wallet-outline" class="text-lg"></ion-icon>
            </button>

            <button
              type="button"
              (click)="router.navigate(['/driver/settings'])"
              class="w-9 h-9 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center border border-amber-100 shadow-sm ml-2 active:scale-95 transition-all"
            >
              <ion-icon name="settings-outline" class="text-lg"></ion-icon>
            </button>

            <button
              type="button"
              (click)="auth.signOut()"
              class="w-9 h-9 rounded-xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100 shadow-sm ml-2 active:scale-95 transition-all"
            >
              <ion-icon name="log-out-outline" class="text-lg"></ion-icon>
            </button>
          </ion-buttons>
        </div>
      </ion-toolbar>
    </ion-header>

    <ion-content class="movabi-page relative">
      @if (toastVisible()) {
        <div
          class="fixed top-4 left-4 right-4 z-[9999] max-w-xl mx-auto rounded-xl px-4 py-3 shadow-xl border text-sm font-bold"
          [class.bg-emerald-50]="toastColor() === 'success'"
          [class.text-emerald-800]="toastColor() === 'success'"
          [class.border-emerald-100]="toastColor() === 'success'"
          [class.bg-amber-50]="toastColor() === 'warning'"
          [class.text-amber-800]="toastColor() === 'warning'"
          [class.border-amber-100]="toastColor() === 'warning'"
          [class.bg-rose-50]="toastColor() === 'danger'"
          [class.text-rose-800]="toastColor() === 'danger'"
          [class.border-rose-100]="toastColor() === 'danger'"
        >
          {{ toastMessage() }}
        </div>
      }

      <!-- Map Container -->
      <div class="relative h-[60vh] w-full">
        <app-map
          #map
          class="w-full h-full"
        ></app-map>

        <!-- Re-center Button -->
        <button
          type="button"
          (click)="recenterMap()"
          class="absolute top-4 right-4 w-10 h-10 bg-white border border-slate-200 rounded-xl shadow-lg flex items-center justify-center active:scale-95 transition-all z-10"
        >
          <ion-icon name="navigate" class="text-lg text-slate-700"></ion-icon>
        </button>

        <!-- Surge Area Overlay -->
        @if (surgeAreas().length > 0) {
          <div class="absolute top-4 left-4 bg-orange-50 border border-orange-100 rounded-xl px-3 py-2 shadow-lg z-10">
            <div class="flex items-center gap-2">
              <ion-icon name="flash-outline" class="text-orange-600"></ion-icon>
              <div>
                <p class="text-[10px] font-bold text-orange-800 uppercase tracking-wide">High Demand</p>
                <p class="text-xs font-semibold text-orange-700">{{ surgeAreas()[0]?.multiplier || 1.2 }}x surge</p>
              </div>
            </div>
          </div>
        }
      </div>

      <!-- Draggable Bottom Sheet -->
      <div 
        class="absolute bottom-0 left-0 right-0 bg-white rounded-t-3xl shadow-2xl border-t border-slate-100 transition-all duration-300 z-20"
        [style.height.%]="sheetHeight()"
        [style.transform]="isDraggingSheet() ? 'scale(0.98)' : 'scale(1)'"
      >
        <!-- Drag Handle -->
        <div class="flex justify-center py-3 cursor-grab active:cursor-grabbing" (mousedown)="startDragSheet()" (touchstart)="startDragSheet()">
          <div class="w-12 h-1.5 bg-slate-300 rounded-full"></div>
        </div>

        <!-- Sheet Content -->
        <div class="px-4 pb-4 h-full overflow-hidden flex flex-col">
          @if (selectedJobId()) {
            <!-- Job Details View -->
            <div class="flex-1 overflow-y-auto">
              @let selectedJob = jobs().find(j => j.id === selectedJobId());
              @if (selectedJob) {
                <div class="space-y-4">
                  <!-- Job Header -->
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex-1">
                      <app-badge variant="primary">{{ getServiceName(selectedJob) }}</app-badge>
                      <h3 class="text-lg font-display font-bold text-slate-900 mt-2">
                        {{ requestServiceHeadline(selectedJob) }}
                      </h3>
                      <p class="text-sm text-slate-600 mt-1">{{ requestServiceHelper(selectedJob) }}</p>
                    </div>
                    <div class="text-right">
                      <p class="text-2xl font-display font-black text-slate-950">
                        {{ formatPrice(getRequestFare(selectedJob)) }}
                      </p>
                      <p class="text-[10px] font-bold text-blue-600 uppercase tracking-wider">Fare</p>
                    </div>
                  </div>

                  <!-- Route Info -->
                  <div class="grid grid-cols-2 gap-3">
                    <div class="bg-slate-50 border border-slate-100 rounded-xl p-3">
                      <p class="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-1">Pickup</p>
                      <p class="text-sm font-bold text-slate-900 leading-snug">
                        {{ selectedJob.pickup_address || 'Location pending' }}
                      </p>
                    </div>
                    <div class="bg-slate-50 border border-slate-100 rounded-xl p-3">
                      <p class="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-1">Dropoff</p>
                      <p class="text-sm font-bold text-slate-900 leading-snug">
                        {{ selectedJob.dropoff_address || 'Location pending' }}
                      </p>
                    </div>
                  </div>

                  <!-- Job Details -->
                  <div class="grid grid-cols-3 gap-2">
                    <div class="bg-blue-50 border border-blue-100 rounded-xl p-3">
                      <p class="text-[8px] font-black text-blue-500 uppercase tracking-wider">Distance</p>
                      <p class="text-xs font-bold text-slate-900 mt-1">{{ formatJobDistance(selectedJob) }}</p>
                    </div>
                    <div class="bg-emerald-50 border border-emerald-100 rounded-xl p-3">
                      <p class="text-[8px] font-black text-emerald-600 uppercase tracking-wider">Time</p>
                      <p class="text-xs font-bold text-slate-900 mt-1">{{ formatJobDuration(selectedJob) }}</p>
                    </div>
                    <div class="bg-amber-50 border border-amber-100 rounded-xl p-3">
                      <p class="text-[8px] font-black text-amber-600 uppercase tracking-wider">Vehicle</p>
                      <p class="text-xs font-bold text-slate-900 mt-1">{{ getVehicleRequired(selectedJob) }}</p>
                    </div>
                  </div>

                  <!-- Action Buttons -->
                  <div class="grid grid-cols-2 gap-3 pt-2">
                    <button
                      type="button"
                      (click)="seeJobOnMap(selectedJob)"
                      class="w-full py-3 bg-slate-100 text-slate-700 rounded-xl font-bold text-sm active:scale-95 transition-all"
                    >
                      See on Map
                    </button>
                    <button
                      type="button"
                      [disabled]="submitting()"
                      (click)="accept(selectedJob.id)"
                      class="w-full py-3 bg-blue-600 text-white rounded-xl font-bold text-sm active:scale-95 transition-all disabled:opacity-50"
                    >
                      {{ submitting() ? 'Accepting...' : 'Accept Request' }}
                    </button>
                  </div>
                </div>
              }
            </div>
          } @else {
            <!-- Job List View -->
            <div class="flex-1 overflow-y-auto">
              <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-display font-bold text-slate-900">
                  Available Requests
                  <span class="ml-2 px-2 py-1 bg-amber-500 text-slate-950 text-[10px] font-bold rounded-full">
                    {{ jobs().length }}
                  </span>
                </h3>
                <button
                  type="button"
                  (click)="refreshAvailableJobs()"
                  class="px-3 py-2 bg-white border border-slate-200 text-slate-600 text-[10px] font-bold uppercase rounded-xl active:scale-95 transition-all"
                >
                  Refresh
                </button>
              </div>

              @if (status() === 'offline') {
                <div class="text-center py-8">
                  <ion-icon name="moon-outline" class="text-4xl text-slate-400"></ion-icon>
                  <p class="text-sm font-bold text-slate-900 mt-3">You are offline</p>
                  <p class="text-xs text-slate-600 mt-1">Go online to see nearby requests</p>
                  <button
                    type="button"
                    (click)="goOnline()"
                    class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-xl font-bold text-sm active:scale-95 transition-all"
                  >
                    Go Online
                  </button>
                </div>
              } @else if (!isAvailable()) {
                <div class="text-center py-8">
                  <ion-icon name="time-outline" class="text-4xl text-slate-400"></ion-icon>
                  <p class="text-sm font-bold text-slate-900 mt-3">You are marked busy</p>
                  <p class="text-xs text-slate-600 mt-1">Turn Free on to receive requests</p>
                  <button
                    type="button"
                    (click)="setAvailableNow()"
                    class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-xl font-bold text-sm active:scale-95 transition-all"
                  >
                    Set Free
                  </button>
                </div>
              } @else if (jobs().length === 0) {
                <div class="text-center py-8">
                  <ion-icon name="search-outline" class="text-4xl text-slate-400"></ion-icon>
                  <p class="text-sm font-bold text-slate-900 mt-3">No requests right now</p>
                  <p class="text-xs text-slate-600 mt-1">New nearby requests will appear automatically</p>
                </div>
              } @else {
                <div class="space-y-3">
                  @for (job of jobs(); track job.id) {
                    <button
                      type="button"
                      (click)="selectJob(job.id)"
                      class="w-full bg-white border border-slate-100 rounded-xl p-4 text-left active:scale-[0.98] transition-all hover:border-blue-200 hover:bg-blue-50"
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 mb-2">
                            <app-badge variant="primary" size="sm">{{ getServiceName(job) }}</app-badge>
                            @if (getSurgeMultiplier(job) > 1) {
                              <span class="px-2 py-1 bg-orange-100 text-orange-700 text-[9px] font-bold rounded-full">
                                {{ getSurgeMultiplier(job) }}x surge
                              </span>
                            }
                          </div>
                          <p class="text-sm font-bold text-slate-900 truncate">{{ requestServiceHeadline(job) }}</p>
                          <p class="text-xs text-slate-600 mt-1">{{ job.pickup_address || 'Location pending' }}</p>
                          <div class="flex items-center gap-3 mt-2">
                            <span class="text-xs text-slate-500">{{ formatJobDistance(job) }}</span>
                            <span class="text-xs text-slate-500">{{ formatJobDuration(job) }}</span>
                            <span class="text-xs text-slate-500">{{ getVehicleRequired(job) }}</span>
                          </div>
                        </div>
                        <div class="text-right">
                          <p class="text-lg font-display font-black text-slate-950">
                            {{ formatPrice(getRequestFare(job)) }}
                          </p>
                        </div>
                      </div>
                    </button>
                  }
                </div>
              }
            </div>
          }
        </div>
      </div>

      <!-- Legacy Status Cards (Hidden but functional) -->
      @if (isUnderReview() || isActionRequired() || !isVerified() || !isStripeReady() || activeJob()) {
        <div class="hidden">
          <!-- Keep existing logic for backward compatibility -->
        </div>
      }
  `
}

export class DriverDashboardPage implements OnInit, OnDestroy {
    public router = inject(Router);
    private route = inject(ActivatedRoute);
    public auth = inject(AuthService);
    private driverService = inject(DriverService);
    private locationService = inject(LocationService);
    public profileService = inject(ProfileService);
    private connectService = inject(ConnectService);
    private supabase = inject(SupabaseService);
    private vehicleCompatibility = inject(VehicleCompatibilityService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private config = inject(AppConfigService);
    private oneSignal = inject(OneSignalService);
    private tour = inject(OnboardingTourService);
    private mapProvider = inject(MapProviderService);
    private geocoding = inject(GeocodingService);
    private routing = inject(RoutingService);

    status = this.driverService.onlineStatus;
    isAvailable = this.driverService.isAvailable;
    activeJob = this.driverService.activeJob;
    private readonly passedJobsStorageKey = 'movabi_driver_passed_jobs';
    passedJobIds = signal<Set<string>>(new Set());
    jobs = computed(() => {
        const passed = this.passedJobIds();
        return this.driverService.availableJobs().filter(job => !passed.has(job.id));
    });
    locationError = this.locationService.locationError;

    submitting = signal(false);
    toastVisible = signal(false);
    toastMessage = signal('');
    toastColor = signal<ToastColor>('success');
    dashboardStats = signal<DriverDashboardStats>({
        todayJobs: 0,
        acceptedJobs: 0,
        completedJobs: 0
    });

    stripeUiState = signal<StripeUiState>({
        accountId: null,
        status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false
    });
    payoutPanelOpen = signal(false);

    // Marketplace UI signals
    selectedJobId = signal<string | null>(null);
    mapComponent = signal<any>(null);
    driverLocation = signal<{ lat: number; lng: number } | null>(null);
    sheetHeight = signal(40); // 40% default height
    isDraggingSheet = signal(false);
    surgeAreas = signal<any[]>([]); // For surge/high-demand areas

    private jobsChannel?: RealtimeChannel;
    private jobsRefreshInterval?: ReturnType<typeof setInterval>;
    private knownAvailableJobIds = new Set<string>();
    resubmittingReview = signal(false);

    verificationStatus = computed<'draft' | 'under_review' | 'action_required' | 'approved'>(() => {
        const profile = this.profileService.profile() as DriverProfile | null;

        if (!profile) return 'draft';
        if (profile.is_verified === true || profile.verification_status === 'approved') return 'approved';
        if (profile.driver_review_status === 'action_required') return 'action_required';
        if (profile.verification_status === 'action_required') return 'action_required';
        if (profile.driver_review_status === 'under_review') return 'under_review';
        if (profile.verification_status === 'under_review') return 'under_review';
        if (profile.onboarding_completed) return 'under_review';

        return 'draft';
    });

    verificationNotes = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return profile?.driver_review_notes ?? profile?.verification_notes ?? null;
    });

    reviewBlockers = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return this.parseStringList(profile?.driver_review_blockers ?? profile?.verification_blockers);
    });

    isVerified = computed(() => this.verificationStatus() === 'approved');
    isUnderReview = computed(() => this.verificationStatus() === 'under_review');
    isActionRequired = computed(() => this.verificationStatus() === 'action_required');
    hasDriverReviewActionRequired = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return profile?.driver_review_status === 'action_required';
    });

    todayMetric = computed<MetricState>(() => {
        const count = this.dashboardStats().todayJobs;

        return {
            value: count,
            label: count === 1 ? 'Job today' : 'Jobs today',
            display: String(count),
            isNew: count === 0
        };
    });

    acceptanceMetric = computed<MetricState>(() => {
        const profile = this.profileService.profile() as any;
        const value = this.toNullableNumber(profile?.acceptance_rate ?? null);

        if (value === null || value <= 0) {
            const acceptedJobs = this.dashboardStats().acceptedJobs;

            return {
                value: acceptedJobs,
                label: acceptedJobs === 1 ? 'Accepted request' : 'Accepted requests',
                display: String(acceptedJobs),
                isNew: acceptedJobs === 0
            };
        }

        const percentage = Math.max(0, Math.min(100, Math.round(value)));

        return {
            value: percentage,
            label: 'Live performance',
            display: `${percentage}%`,
            isNew: false
        };
    });

    ratingMetric = computed<MetricState>(() => {
        const profile = this.profileService.profile() as any;
        const value = this.toNullableNumber(profile?.rating ?? profile?.driver_rating ?? null);

        if (value === null || value <= 0) {
            return {
                value: 0,
                label: 'No reviews yet',
                display: '0.0',
                isNew: true
            };
        }

        const rating = Math.max(0, Math.min(5, value));

        return {
            value: rating,
            label: 'Driver score',
            display: rating.toFixed(1),
            isNew: false
        };
    });

    driverCarouselSlides = computed<MovabiCarouselSlide[]>(() => {
        const slides: MovabiCarouselSlide[] = [
            {
                eyebrow: 'Today',
                title: `${this.todayMetric().display} ${this.todayMetric().label}`,
                subtitle: this.status() === 'online' ? 'Stay available for nearby requests.' : 'Go online when you are ready.',
                value: `${this.dashboardStats().completedJobs || 0} done`,
                icon: 'location-outline',
                cta: this.status() === 'online' ? 'Live now' : 'Go online',
                tone: 'slate'
            },
            {
                eyebrow: 'Performance',
                title: `Rating ${this.ratingMetric().display}`,
                subtitle: this.ratingMetric().isNew ? 'Your first customer review will appear here.' : 'Keep responses quick and service friendly.',
                icon: 'star-outline',
                cta: 'Build trust',
                tone: 'amber',
                accentColor: '#c2410c'
            },
            {
                eyebrow: 'Requests',
                title: `${this.jobs().length} available now`,
                subtitle: this.jobs().length > 0 ? 'Review the best nearby request and accept when ready.' : "We'll show nearby jobs here automatically.",
                icon: 'location-outline',
                cta: 'Nearby work',
                tone: 'emerald',
                accentColor: '#047857'
            },
            {
                eyebrow: 'Payouts',
                title: this.isStripeReady() ? 'Payouts ready' : 'Payout setup pending',
                subtitle: this.isStripeReady() ? 'Completed jobs can be processed safely.' : 'Complete Stripe Connect to avoid payout delays.',
                icon: 'wallet-outline',
                cta: this.isStripeReady() ? 'Earnings safe' : 'Finish setup',
                tone: this.isStripeReady() ? 'blue' : 'rose'
            }
        ];

        if (!this.isVerified()) {
            slides.push({
                eyebrow: 'Compliance',
                title: 'Documents under review',
                subtitle: 'Some request types unlock after approval.',
                icon: 'document-text-outline',
                cta: 'Review status',
                tone: 'rose'
            });
        }

        return slides;
    });

    isStripeReady = computed(() => {
        const state = this.stripeUiState();
        if (!state.accountId) return false;
        return state.chargesEnabled === true && state.payoutsEnabled === true;
    });

    canDriverAcceptTrips = computed(() => {
        return this.isStripeReady();
    });

    isPayoutPanelOpen = computed(() => this.payoutPanelOpen() || !this.isStripeReady());

    isStripePending = computed(() => {
        if (this.isStripeReady()) return false;
        return !!this.stripeUiState().accountId;
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
            star,
            statsChart,
            card,
            timeOutline,
            alertCircleOutline,
            flashOutline,
            radioOutline,
            cashOutline,
            checkmarkCircleOutline,
            personAddOutline,
            listOutline,
            navigate,
            chevronDownOutline,
            settingsOutline
        });
    }

    async ngOnInit() {
        if (!this.supabase.isConfigured) return;

        this.loadPassedJobs();
        await this.refreshStripeUiStateFromDb();
        await this.ensureMovabiPayVirtualCard();
        await this.loadAvailability();
        await this.handleStripeReturn();

        await this.loadDashboardStats();
        await this.refreshActiveJob();
        await this.driverService.fetchAvailableJobs();
        this.knownAvailableJobIds = new Set(this.jobs().map(job => job.id));

        this.subscribeToAvailableJobsRealtime();
        this.startJobsAutoRefresh();

        // Initialize marketplace UI features
        this.setupLocationTracking();
        await this.loadSurgeAreas();

        if (this.isVerified()) {
            this.checkTracking();
            await this.loadAvailability();
        }

        this.tour.startIfNeeded('driver');
    }

    ngOnDestroy() {
        this.locationService.stopTracking();

        if (this.jobsRefreshInterval) {
            clearInterval(this.jobsRefreshInterval);
            this.jobsRefreshInterval = undefined;
        }

        if (this.jobsChannel) {
            this.supabase.client.removeChannel(this.jobsChannel);
            this.jobsChannel = undefined;
        }
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(Number(amount || 0));
    }

    async refreshActiveJob(): Promise<void> {
        try {
            await this.driverService.fetchActiveJob();
        } catch (error) {
            console.warn('[driver-dashboard] Failed to refresh active job', error);
        }
    }

    private async ensureMovabiPayVirtualCard(): Promise<void> {
        try {
            await this.driverService.ensureMovabiPayVirtualCard();
        } catch (error) {
            console.warn('[driver-dashboard] Movabi Pay virtual card setup deferred', error);
        }
    }

    async loadDashboardStats(): Promise<void> {
        const user = this.auth.currentUser();

        if (!user?.id) {
            this.dashboardStats.set({ todayJobs: 0, acceptedJobs: 0, completedJobs: 0 });
            return;
        }

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const activeAndDoneStatuses = [
            'assigned',
            'accepted',
            'heading_to_pickup',
            'arrived',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'in_progress',
            'delivered',
            'completed',
            'settled',
            'over_budget_requested'
        ];

        try {
            const [todayResult, acceptedResult, completedResult] = await Promise.all([
                this.supabase.client
                    .from('jobs')
                    .select('id')
                    .eq('driver_id', user.id)
                    .in('status', activeAndDoneStatuses)
                    .gte('updated_at', startOfToday.toISOString())
                    .limit(1000),
                this.supabase.client
                    .from('jobs')
                    .select('id')
                    .eq('driver_id', user.id)
                    .in('status', activeAndDoneStatuses)
                    .limit(1000),
                this.supabase.client
                    .from('jobs')
                    .select('id')
                    .eq('driver_id', user.id)
                    .in('status', ['completed', 'settled'])
                    .limit(1000)
            ]);

            if (todayResult.error || acceptedResult.error || completedResult.error) {
                throw todayResult.error || acceptedResult.error || completedResult.error;
            }

            this.dashboardStats.set({
                todayJobs: todayResult.data?.length ?? 0,
                acceptedJobs: acceptedResult.data?.length ?? 0,
                completedJobs: completedResult.data?.length ?? 0
            });
        } catch (error) {
            console.warn('[driver-dashboard] Failed to load dashboard stats', error);

            const profile = this.profileService.profile() as DriverProfile | null;
            this.dashboardStats.set({
                todayJobs: this.activeJob() ? 1 : 0,
                acceptedJobs: Number(profile?.completed_jobs || profile?.total_trips || 0),
                completedJobs: Number(profile?.completed_jobs || profile?.total_trips || 0)
            });
        }
    }

    async resumeActiveJob(): Promise<void> {
        const active = this.activeJob();

        if (!active?.id) {
            await this.refreshActiveJob();
        }

        const jobId = this.activeJob()?.id;

        if (!jobId) {
            this.showToast('No active request to resume.', 'warning');
            return;
        }

        await this.router.navigate(['/driver/job-details', jobId]);
    }

    activeJobTitle(): string {
        const job = this.activeJob();
        if (!job) return 'Active request';

        return this.getServiceName(job);
    }

    activeJobStatusLabel(): string {
        const status = this.activeJob()?.status;
        if (!status) return 'Active';

        return String(status)
            .replace(/_/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    activeJobRouteLabel(): string {
        const job = this.activeJob();
        if (!job) return 'Tap to continue the request.';

        const origin = this.shortenAddress(job.pickup_address || this.requestOriginUnavailableLabel(job));
        const destination = this.shortenAddress(job.dropoff_address || this.requestDestinationUnavailableLabel(job));

        return `${origin} ? ${destination}`;
    }

    activeJobShortRouteLabel(): string {
        const job = this.activeJob();
        if (!job) return 'Tap to continue the request.';

        const origin = this.compactAddress(job.pickup_address || this.requestOriginUnavailableLabel(job));
        const destination = this.compactAddress(job.dropoff_address || this.requestDestinationUnavailableLabel(job));

        return `${this.requestOriginLabel(job)}: ${origin} ? ${this.requestDestinationLabel(job)}: ${destination}`;
    }

    private compactAddress(address: string | null | undefined): string {
        const value = String(address || '').trim();

        if (!value) return 'Location unavailable';

        const parts = value
            .split(',')
            .map(part => part.trim())
            .filter(Boolean);

        if (parts.length >= 2) {
            return `${parts[0]}, ${parts[1]}`;
        }

        return value.length > 46 ? `${value.slice(0, 43)}...` : value;
    }

    private shortenAddress(address: string): string {
        const value = String(address || '').trim();
        if (!value) return 'Location unavailable';

        const parts = value
            .split(',')
            .map(part => part.trim())
            .filter(Boolean);

        return parts.length >= 2 ? `${parts[0]}, ${parts[1]}` : value;
    }

    getRequestFare(job: Booking): number {
        const raw = job as any;

        const total = Number(raw.total_price);
        if (Number.isFinite(total) && total > 0) return total;

        const price = Number(raw.price);
        if (Number.isFinite(price) && price > 0) return price;

        const estimated = Number(raw.estimated_price);
        if (Number.isFinite(estimated) && estimated > 0) return estimated;

        const frontendTotal = Number(raw.metadata?.frontend_total_price);
        if (Number.isFinite(frontendTotal) && frontendTotal > 0) return frontendTotal;

        return 0;
    }

    getDriverPayout(job: Booking): number {
        const raw = job as any;
        const payout = Number(raw.driver_payout);

        if (Number.isFinite(payout) && payout > 0) {
            return payout;
        }

        return this.getRequestFare(job);
    }

    formatJobTime(value: unknown): string {
        if (!value) return 'ASAP';

        const date = new Date(String(value));

        if (Number.isNaN(date.getTime())) {
            return 'ASAP';
        }

        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    formatSearchTimeLeft(job: Booking): string {
        const raw = job as any;

        if (!raw.driver_search_expires_at) {
            return 'Open now';
        }

        const expiresAt = new Date(raw.driver_search_expires_at).getTime();

        if (!Number.isFinite(expiresAt)) {
            return 'Open now';
        }

        const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));

        if (seconds === 0) {
            return 'Expiring';
        }

        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;

        return `${mins}m ${secs.toString().padStart(2, '0')}s`;
    }

    getServiceName(job: Booking): string {
        const raw = String(
            (job as any)?.service_type?.name ||
            (job as any)?.service_type_name ||
            (job as any)?.service_slug ||
            (job as any)?.service_type ||
            (job as any)?.type ||
            'Request'
        );

        return raw
            .trim()
            .replace(/_/g, ' ')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    requestServiceIcon(job: Booking): string {
        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'storefront-outline';
            case ServiceTypeEnum.DELIVERY:
                return 'cube-outline';
            case ServiceTypeEnum.VAN:
                return 'home-outline';
            default:
                return 'car-sport-outline';
        }
    }

    requestServiceHeadline(job: Booking): string {
        const customer = this.requestCustomerFirstName(job);

        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return `Shop and deliver for ${customer}`;
            case ServiceTypeEnum.DELIVERY:
                return `Collect and deliver a package`;
            case ServiceTypeEnum.VAN:
                return `Help with a move`;
            default:
                return `Pickup ride for ${customer}`;
        }
    }

    requestServiceHelper(job: Booking): string {
        const vehicle = this.vehicleCompatibility.getRequiredLabel(job);

        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return `Includes item budget handling, receipt upload, and delivery. Vehicle needed: ${vehicle}.`;
            case ServiceTypeEnum.DELIVERY:
                return `Confirm collection before travelling to the recipient. Vehicle needed: ${vehicle}.`;
            case ServiceTypeEnum.VAN:
                return `Accept only if your vehicle can handle the load and you can complete the move. Vehicle needed: ${vehicle}.`;
            default:
                return `Accept when you can reach pickup and complete the trip. Vehicle needed: ${vehicle}.`;
        }
    }

    requestThirdMetricLabel(job: Booking): string {
        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Item Budget';
            case ServiceTypeEnum.VAN:
                return 'Vehicle';
            default:
                return 'Search Window';
        }
    }

    requestThirdMetricValue(job: Booking): string {
        if ((job as any)?.service_slug === ServiceTypeEnum.ERRAND) {
            const budget = this.firstPositiveNumber(
                (job as any)?.metadata?.errand_details?.budget,
                (job as any)?.metadata?.errand_details?.estimated_budget,
                (job as any)?.metadata?.payment_split?.item_budget,
                (job as any)?.item_budget
            );

            return budget !== null ? this.formatPrice(budget) : 'Protected';
        }

        if ((job as any)?.service_slug === ServiceTypeEnum.VAN) {
            return this.vehicleCompatibility.getRequiredLabel(job);
        }

        return this.formatSearchTimeLeft(job);
    }

    private requestCustomerFirstName(job: Booking): string {
        const customer = (job as any)?.customer || {};
        const first = String(customer.first_name || customer.full_name || '').trim().split(/\s+/)[0];

        return first || 'customer';
    }

    requestOriginLabel(job: Booking): string {
        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store';
            case ServiceTypeEnum.DELIVERY:
                return 'Collect from';
            case ServiceTypeEnum.VAN:
                return 'Moving from';
            default:
                return 'Pickup';
        }
    }

    requestDestinationLabel(job: Booking): string {
        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Deliver to';
            case ServiceTypeEnum.DELIVERY:
                return 'Recipient';
            case ServiceTypeEnum.VAN:
                return 'Moving to';
            default:
                return 'Dropoff';
        }
    }

    requestOriginUnavailableLabel(job: Booking): string {
        return `${this.requestOriginLabel(job)} unavailable`;
    }

    requestDestinationUnavailableLabel(job: Booking): string {
        return `${this.requestDestinationLabel(job)} unavailable`;
    }

    hasAcceptanceRate(): boolean {
        const profile = this.profileService.profile() as any;
        const value = this.toNullableNumber(profile?.acceptance_rate ?? null);
        return value !== null && value > 0;
    }

    acceptanceBadgeLabel(): string {
        const metric = this.acceptanceMetric();

        if (this.hasAcceptanceRate()) {
            return this.getMetricLabel(metric.value || 0);
        }

        return metric.isNew ? 'New' : 'Accepted';
    }

    acceptanceBadgeVariant(): 'success' | 'warning' | 'error' | 'info' | 'secondary' {
        const metric = this.acceptanceMetric();

        if (this.hasAcceptanceRate()) {
            return this.getMetricVariant(metric.value || 0);
        }

        return metric.isNew ? 'secondary' : 'info';
    }

    formatJobDistance(job: Booking): string {
        const raw = job as any;
        const metadata = raw.metadata || {};
        const km = this.firstPositiveNumber(
            raw.estimated_distance_km,
            raw.distance_km,
            raw.estimated_distance,
            metadata.distance_km,
            metadata.estimated_distance_km
        );

        if (km !== null) {
            return this.formatDistance(km);
        }

        const meters = this.firstPositiveNumber(raw.distance_meters, metadata.distance_meters);
        if (meters !== null) {
            return this.formatDistance(meters / 1000);
        }

        return 'Not set';
    }

    formatJobDuration(job: Booking): string {
        const raw = job as any;
        const metadata = raw.metadata || {};
        const seconds = this.firstPositiveNumber(
            raw.duration_seconds,
            raw.estimated_duration_seconds,
            metadata.duration_seconds
        );

        if (seconds !== null) {
            const mins = Math.max(1, Math.round(seconds / 60));
            return `${mins} min`;
        }

        const minutes = this.firstPositiveNumber(
            raw.duration_minutes,
            raw.estimated_duration_minutes,
            metadata.duration_minutes
        );

        if (minutes !== null) {
            return `${Math.max(1, Math.round(minutes))} min`;
        }

        return 'ASAP';
    }

    getPaymentLabel(job: Booking): string {
        const status = String((job as any).payment_status || '').replace(/_/g, ' ');

        if (!status) {
            return 'Pending';
        }

        return status.replace(/\b\w/g, char => char.toUpperCase());
    }

    formatDistance(distance: unknown): string {
        const value = Number(distance || 0);

        if (!Number.isFinite(value) || value <= 0) {
            return 'Not set';
        }

        return `${value.toFixed(1)} km`;
    }

    private firstPositiveNumber(...values: unknown[]): number | null {
        for (const value of values) {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 0) {
                return parsed;
            }
        }

        return null;
    }


    getJobNotes(job: Booking): string | null {
        const raw = job as any;
        const metadata = raw.metadata || {};

        return (
            raw.notes ||
            raw.instructions ||
            raw.customer_notes ||
            metadata.notes ||
            metadata.instructions ||
            null
        );
    }

    isProDriver(): boolean {
        const profile = this.profileService.profile() as any;
        return profile?.pricing_plan === 'pro' && profile?.subscription_status === 'active';
    }

    private toNullableNumber(value: unknown): number | null {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private parseStringList(raw: unknown): string[] {
        if (Array.isArray(raw)) {
            return raw.map((item) => String(item || '').trim()).filter(Boolean);
        }

        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed)
                    ? parsed.map((item) => String(item || '').trim()).filter(Boolean)
                    : raw.trim()
                        ? [raw.trim()]
                        : [];
            } catch {
                return raw.trim() ? [raw.trim()] : [];
            }
        }

        return [];
    }

    async refreshAvailableJobs() {
        await this.driverService.fetchAvailableJobs();
        this.showToast('Requests refreshed.', 'success');
    }

    async browseRequests() {
        if (this.status() !== 'online') {
            await this.goOnline();
        } else {
            await this.driverService.fetchAvailableJobs();
        }

        const section = document.querySelector('[data-section="available-requests"]');
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async setAvailableNow() {
        this.driverService.isAvailable.set(true);

        const profile = this.profileService.profile();

        if (profile) {
            await this.safeUpdateProfile(profile.id, {
                is_available: true,
                last_active_at: new Date().toISOString()
            });
        }

        await this.driverService.fetchAvailableJobs();
    }

    private subscribeToAvailableJobsRealtime(): void {
        if (this.jobsChannel) return;

        this.jobsChannel = this.supabase.client
            .channel('driver-dashboard-jobs')
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'jobs'
                },
                async (payload) => {
                    const newStatus = String((payload.new as any)?.status || '');
                    const oldStatus = String((payload.old as any)?.status || '');
                    const changedJobId = String((payload.new as any)?.id || (payload.old as any)?.id || '');
                    const shouldAlert =
                        newStatus === 'searching' &&
                        !!changedJobId &&
                        !this.knownAvailableJobIds.has(changedJobId) &&
                        this.status() === 'online' &&
                        this.isAvailable();
                    const activeStatuses = [
                        'assigned',
                        'accepted',
                        'heading_to_pickup',
                        'arrived',
                        'arrived_at_store',
                        'shopping_in_progress',
                        'collected',
                        'en_route_to_customer',
                        'in_progress',
                        'delivered',
                        'over_budget_requested'
                    ];

                    if (
                        newStatus === 'searching' ||
                        oldStatus === 'searching' ||
                        activeStatuses.includes(newStatus) ||
                        activeStatuses.includes(oldStatus) ||
                        newStatus === 'completed' ||
                        newStatus === 'cancelled' ||
                        newStatus === 'no_driver_found'
                    ) {
                        await this.refreshActiveJob();
                        await this.driverService.fetchAvailableJobs();

                        const visibleJobs = this.jobs();
                        const newVisibleJob = visibleJobs.find(job => job.id === changedJobId);

                        if (shouldAlert && newVisibleJob) {
                            await this.alertNewJob(newVisibleJob);
                        }

                        this.knownAvailableJobIds = new Set(visibleJobs.map(job => job.id));
                    }
                }
            )
            .subscribe((status) => {
                console.log('[driver-dashboard] jobs realtime:', status);
            });
    }

    private async alertNewJob(job: Booking): Promise<void> {
        const serviceName = this.getServiceName(job);
        this.showToast(`New ${serviceName.toLowerCase()} request nearby`, 'warning');

        try {
            await Haptics.notification({ type: NotificationType.Warning });
        } catch {
            navigator.vibrate?.([160, 80, 160]);
        }

        await this.oneSignal.notifyNewJob(serviceName, this.formatPrice(this.getRequestFare(job)), job.id)
            .catch(() => undefined);

        this.playNewJobTone();
    }

    private playNewJobTone(): void {
        try {
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioContextClass) return;

            const context: AudioContext = new AudioContextClass();
            const start = context.currentTime;

            [
                { offset: 0, frequency: 880, duration: 0.12, gain: 0.2 },
                { offset: 0.18, frequency: 660, duration: 0.1, gain: 0.12 }
            ].forEach((tone) => {
                const oscillator = context.createOscillator();
                const gain = context.createGain();
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(tone.frequency, start + tone.offset);
                gain.gain.setValueAtTime(0.0001, start + tone.offset);
                gain.gain.exponentialRampToValueAtTime(tone.gain, start + tone.offset + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.offset + tone.duration);
                oscillator.connect(gain);
                gain.connect(context.destination);
                oscillator.start(start + tone.offset);
                oscillator.stop(start + tone.offset + tone.duration + 0.02);
            });

            window.setTimeout(() => void context.close(), 600);
        } catch (error) {
            console.warn('[driver-dashboard] New request tone was blocked by the device:', error);
        }
    }

    private startJobsAutoRefresh(): void {
        if (this.jobsRefreshInterval) return;

        this.jobsRefreshInterval = setInterval(async () => {
            await this.loadDashboardStats();
            await this.refreshActiveJob();

            if (this.status() === 'online' && this.isAvailable()) {
                await this.driverService.fetchAvailableJobs();
            }
        }, 5000);
    }

    private async refreshStripeUiStateFromDb() {
        const user = this.auth.currentUser();

        if (!user?.id) {
            this.resetStripeUiState();
            return;
        }

        try {
            const settings = await this.connectService.getPayoutSettings();

            if (!settings.stripeAccountId) {
                this.resetStripeUiState();
                return;
            }

            this.stripeUiState.set({
                accountId: settings.stripeAccountId,
                status: settings.connectStatus || 'pending',
                chargesEnabled: settings.chargesEnabled === true,
                payoutsEnabled: settings.payoutsEnabled === true
            });

            this.mergeLocalProfile({
                stripe_account_id: settings.stripeAccountId,
                stripe_connect_status: settings.connectStatus || 'pending'
            });

            return;
        } catch (error) {
            console.warn('[DriverDashboard] payout settings lookup failed; falling back to profile Stripe fields', error);
        }

        const { data: profile, error } = await this.supabase.client
            .from('profiles')
            .select('id, tenant_id, stripe_account_id, stripe_connect_status')
            .eq('id', user.id)
            .maybeSingle();

        if (error) return;

        this.mergeLocalProfile((profile || {}) as Record<string, unknown>);

        const accountId = (profile as any)?.stripe_account_id || null;
        const dbStatus = String((profile as any)?.stripe_connect_status || 'not_started');

        if (!accountId) {
            this.resetStripeUiState();
            return;
        }

        try {
            const status = await this.connectService.refreshAccountStatus(accountId, user.id);

            this.stripeUiState.set({
                accountId: status.stripe_account_id || accountId,
                status: status.status || dbStatus,
                chargesEnabled: status.charges_enabled === true,
                payoutsEnabled: status.payouts_enabled === true
            });
        } catch (error) {
            console.warn('[DriverDashboard] Stripe status refresh failed', error);
            this.stripeUiState.set({
                accountId,
                status: dbStatus,
                chargesEnabled: false,
                payoutsEnabled: false
            });
        }
    }

    private resetStripeUiState() {
        this.stripeUiState.set({
            accountId: null,
            status: 'not_started',
            chargesEnabled: false,
            payoutsEnabled: false
        });

        this.driverService.stripeAccount.set(null);

        this.mergeLocalProfile({
            stripe_account_id: null,
            stripe_connect_status: 'not_started'
        });
    }

    async handleStripeReturn() {
        const stripe = this.route.snapshot.queryParamMap.get('stripe');
        if (!stripe) return;

        try {
            await this.refreshStripeUiStateFromDb();

            if (stripe === 'success') {
                this.showToast(
                    this.isStripeReady()
                        ? 'Stripe payouts are connected.'
                        : 'Stripe setup saved, but Stripe still needs more information.',
                    this.isStripeReady() ? 'success' : 'warning'
                );
            }

            if (stripe === 'refresh') {
                this.showToast('Please continue completing your Stripe onboarding.', 'warning');
            }
        } finally {
            await this.router.navigate([], {
                relativeTo: this.route,
                queryParams: {},
                replaceUrl: true
            });
        }
    }

    async loadAvailability() {
        const profile = this.profileService.profile() as DriverProfile | null;
        if (!profile) return;

        this.driverService.isAvailable.set(profile.is_available ?? true);
        this.driverService.onlineStatus.set(profile.is_online ? 'online' : 'offline');
    }

    async toggleStatus(event: Event) {
        const customEvent = event as CustomEvent;
        const isOnline = !!customEvent.detail?.checked;

        if (isOnline) {
            await this.goOnline();
            return;
        }

        const profile = this.profileService.profile();

        this.driverService.onlineStatus.set('offline');
        this.driverService.availableJobs.set([]);

        if (profile) {
            await this.safeUpdateProfile(profile.id, {
                is_online: false,
                last_active_at: new Date().toISOString()
            });
        }

        this.checkTracking();
    }

    async goOnline() {
        if (!this.canDriverAcceptTrips()) {
            this.showToast('Complete Stripe Connect before going online.', 'warning');
            return;
        }

        const profile = this.profileService.profile();

        this.driverService.onlineStatus.set('online');
        this.driverService.isAvailable.set(true);

        if (profile) {
            await this.safeUpdateProfile(profile.id, {
                is_online: true,
                is_available: true,
                last_active_at: new Date().toISOString()
            });
        }

        await this.driverService.fetchAvailableJobs();
        this.checkTracking();
    }

    async toggleAvailability(event: Event) {
        const customEvent = event as CustomEvent;
        const available = !!customEvent.detail?.checked;
        const profile = this.profileService.profile();

        if (available && !this.canDriverAcceptTrips()) {
            this.showToast('Complete Stripe Connect before accepting trips.', 'warning');
            // Force the toggle back to off
            this.driverService.isAvailable.set(false);
            return;
        }

        this.driverService.isAvailable.set(available);

        if (profile) {
            await this.safeUpdateProfile(profile.id, {
                is_available: available,
                last_active_at: new Date().toISOString()
            });
        }

        if (available) {
            await this.driverService.fetchAvailableJobs();
        } else {
            this.driverService.availableJobs.set([]);
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
        if (this.submitting()) return;

        this.submitting.set(true);

        const loading = await this.loadingCtrl.create({
            message: 'Accepting request...'
        });

        await loading.present();

        try {
            const user = this.auth.currentUser();

            if (!user?.id) {
                throw new Error('Please sign in again.');
            }

            const blockers = await this.driverService.getAcceptanceBlockers();
            if (blockers.length) {
                throw new Error(this.driverService.formatAcceptanceBlockers(blockers));
            }

            const job = this.driverService.availableJobs().find(item => item.id === jobId);
            const vehicle = this.driverService.vehicle() || await this.driverService.fetchVehicle();

            if (job && !this.vehicleCompatibility.isCompatible(job, vehicle)) {
                throw new Error(
                    `This request needs ${this.vehicleCompatibility.getRequiredLabel(job)}. Your saved vehicle is ${this.vehicleCompatibility.getVehicleLabel(vehicle)}.`
                );
            }

            const { error } = await this.supabase.client.rpc('accept_searching_job', {
                p_driver_id: user.id,
                p_job_id: jobId
            });

            if (error) {
                throw new Error(error.message || 'Request no longer available');
            }

            await this.driverService.fetchAvailableJobs();

            await loading.dismiss();
            this.submitting.set(false);

            await this.router.navigate(['/driver/job-details', jobId]);
        } catch (e: unknown) {
            await loading.dismiss();
            this.submitting.set(false);

            const message = e instanceof Error ? e.message : 'Request no longer available';
            this.showToast(message, 'danger');

            await this.driverService.fetchAvailableJobs();
        }
    }

    reject(jobId: string) {
        this.rememberPassedJob(jobId);
        this.driverService.availableJobs.update((jobs: Booking[]) =>
            jobs.filter((job: Booking) => job.id !== jobId)
        );
    }

    async resubmitDriverReview() {
        const profile = this.profileService.profile();

        if (!profile?.id || this.resubmittingReview()) return;

        this.resubmittingReview.set(true);

        try {
            await this.safeUpdateProfile(profile.id, {
                driver_review_status: 'under_review',
                verification_status: 'under_review',
                verification_notes: null,
                driver_review_notes: null,
                verification_blockers: [],
                driver_review_blockers: [],
                updated_at: new Date().toISOString()
            });

            if (typeof (this.profileService as any).fetchProfile === 'function') {
                await (this.profileService as any).fetchProfile(profile.id);
            }

            this.showToast('Resubmitted for manual review.', 'success');
        } finally {
            this.resubmittingReview.set(false);
        }
    }

    private loadPassedJobs() {
        try {
            const maxAgeMs = 60 * 60 * 1000;
            const parsed = JSON.parse(localStorage.getItem(this.passedJobsStorageKey) || '[]') as PassedJob[];
            const now = Date.now();
            const fresh = parsed.filter(item => item?.id && now - Number(item.passedAt || 0) < maxAgeMs);
            this.passedJobIds.set(new Set(fresh.map(item => item.id)));
            localStorage.setItem(this.passedJobsStorageKey, JSON.stringify(fresh));
        } catch {
            this.passedJobIds.set(new Set());
        }
    }

    private rememberPassedJob(jobId: string) {
        const now = Date.now();
        const next = new Set(this.passedJobIds());
        next.add(jobId);
        this.passedJobIds.set(next);

        const items = Array.from(next).map(id => ({
            id,
            passedAt: id === jobId ? now : now
        }));

        localStorage.setItem(this.passedJobsStorageKey, JSON.stringify(items));
    }

    getMetricLabel(value: number): string {
        if (value >= 85) return 'Excellent';
        if (value >= 70) return 'Good';
        return 'Needs work';
    }

    getMetricVariant(value: number): 'success' | 'warning' | 'error' | 'info' {
        if (value >= 85) return 'success';
        if (value >= 70) return 'info';
        return 'warning';
    }

    getStripeBadgeText(): string {
        const state = this.stripeUiState();

        if (this.isStripeReady()) return 'Connected';
        if (!state.accountId) return 'Not Started';

        const status = String(state.status || '').toLowerCase();

        if (status === 'restricted' || status === 'requires_action') return 'Action Required';

        return 'Pending';
    }

    getStripeBadgeVariant(): 'success' | 'warning' | 'info' | 'error' | 'secondary' | 'primary' {
        const state = this.stripeUiState();

        if (this.isStripeReady()) return 'success';
        if (!state.accountId) return 'secondary';

        const status = String(state.status || '').toLowerCase();

        if (status === 'restricted' || status === 'requires_action') return 'error';

        return 'warning';
    }

    getStripeDescription(): string {
        const state = this.stripeUiState();
        const status = String(state.status || '').toLowerCase();

        if (!state.accountId) {
            return 'Connect your payout account so earnings from ride, errand, delivery, and moving requests can be processed safely.';
        }

        if (status === 'restricted' || status === 'requires_action') {
            return 'Stripe still needs a few more details before payouts can be enabled.';
        }

        return 'Your Stripe account has started onboarding, but payouts are not fully enabled yet.';
    }

    togglePayoutPanel(): void {
        if (!this.isStripeReady()) {
            this.payoutPanelOpen.set(true);
            return;
        }

        this.payoutPanelOpen.update(open => !open);
    }

    getStripeCompactSummary(): string {
        if (this.isStripeReady()) return 'Payouts connected';
        if (this.isStripePending()) return 'Setup needs attention';
        return 'Setup required';
    }

    async openStripeDashboard() {
        await this.refreshStripeUiStateFromDb();

        const accountId = this.stripeUiState().accountId;

        if (!accountId) {
            this.showToast('Stripe account not found. Start setup first.', 'warning');
            return;
        }

        const loading = await this.loadingCtrl.create({
            message: 'Opening Stripe dashboard...'
        });

        await loading.present();

        try {
            const link = await this.connectService.getDashboardLink(accountId);
            window.location.href = link.url;
        } catch {
            this.showToast('Failed to open Stripe dashboard', 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async setupPayouts() {
        const user = this.auth.currentUser();

        if (!user) {
            this.showToast('Please sign in again to continue payout setup.', 'warning');
            return;
        }

        const loading = await this.loadingCtrl.create({
            message: 'Loading payout settings...'
        });

        await loading.present();

        try {
            await this.refreshStripeUiStateFromDb();

            let accountId = this.stripeUiState().accountId;

            if (!accountId) {
                const { data: freshProfile, error } = await this.supabase.client
                    .from('profiles')
                    .select('id, tenant_id')
                    .eq('id', user.id)
                    .maybeSingle();

                if (error) throw error;

                const result = await this.connectService.createAccount(
                    user.id,
                    user.email || '',
                    (freshProfile as any)?.tenant_id || null
                );

                accountId = result.stripe_account_id;

                await this.safeUpdateProfile(user.id, {
                    stripe_account_id: accountId,
                    stripe_connect_status: 'pending'
                });

                await this.refreshStripeUiStateFromDb();
            }

            if (!accountId) throw new Error('Stripe account could not be created.');

            const settings = await this.connectService.getPayoutSettings();

            this.stripeUiState.set({
                accountId: settings.stripeAccountId || accountId,
                status: settings.connectStatus || 'pending',
                chargesEnabled: settings.chargesEnabled === true,
                payoutsEnabled: settings.payoutsEnabled === true
            });

            const returnUrl = `${window.location.origin}/driver?stripe=success`;
            const refreshUrl = `${window.location.origin}/driver?stripe=refresh`;

            const link = this.isStripeReady()
                ? await this.connectService.getDashboardLink(accountId)
                : await this.connectService.getOnboardingLink(accountId, returnUrl, refreshUrl);

            window.location.href = link.url;
        } catch (error) {
            console.warn('[DriverDashboard] Failed to load payout settings', error);
            this.showToast('Failed to load payout settings', 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    private async safeUpdateProfile(profileId: string, updates: Record<string, unknown>) {
        const cleanUpdates = this.cleanProfileUpdates(updates);

        if (!Object.keys(cleanUpdates).length) return;

        const { error } = await this.supabase.client
            .from('profiles')
            .update(cleanUpdates)
            .eq('id', profileId);

        if (!error) {
            this.mergeLocalProfile(cleanUpdates);
            return;
        }

        console.error('Profile update failed:', error);
        this.showToast('Could not update profile. Please try again.', 'danger');
    }

    private cleanProfileUpdates(updates: Record<string, unknown>) {
        const blockedKeys = new Set([
            'status',
            '_status',
            'moderated_by',
            'completed_at'
        ]);

        return Object.entries(updates).reduce<Record<string, unknown>>((acc, [key, value]) => {
            if (blockedKeys.has(key)) return acc;
            if (value === undefined) return acc;
            acc[key] = value;
            return acc;
        }, {});
    }

    private mergeLocalProfile(updates: Record<string, unknown>) {
        const current = this.profileService.profile() as any;
        if (!current) return;

        const next = {
            ...current,
            ...updates
        };

        const service = this.profileService as any;

        if (typeof service.profile?.set === 'function') {
            service.profile.set(next);
            return;
        }

        if (typeof service.setProfile === 'function') {
            service.setProfile(next);
        }
    }

    private showToast(message: string, color: ToastColor = 'success') {
        this.toastMessage.set(message);
        this.toastColor.set(color);
        this.toastVisible.set(true);

        window.setTimeout(() => {
            this.toastVisible.set(false);
        }, 2500);

        void this.showIonicToastFallback(message, color);
    }

    private async showIonicToastFallback(message: string, color: ToastColor) {
        try {
            const toast = await this.toastCtrl.create({
                message,
                duration: 1800,
                color,
                position: 'top'
            });

            await toast.present();
        } catch {
            // Signal toast is already visible.
        }
    }

    // MARK: - Marketplace UI Methods

    onMapReady(mapComponent: any) {
        console.log('[DriverDashboard] Map component ready');
        this.mapComponent.set(mapComponent);
        
        // Initialize map with driver location
        this.updateDriverLocation();
    }

    selectJob(jobId: string) {
        console.log('[DriverDashboard] Selecting job:', jobId);
        this.selectedJobId.set(jobId);
        
        // Focus map on selected job
        const job = this.jobs().find(j => j.id === jobId);
        if (job && this.mapComponent()) {
            this.focusMapOnJob(job);
        }
        
        // Expand sheet to show details
        this.sheetHeight.set(60);
    }

    recenterMap() {
        console.log('[DriverDashboard] Recentering map');
        if (this.mapComponent() && this.driverLocation()) {
            this.mapComponent().recenter(this.driverLocation());
        } else {
            this.updateDriverLocation();
        }
    }

    seeJobOnMap(job: Booking) {
        console.log('[DriverDashboard] Focusing map on job:', job.id);
        if (this.mapComponent()) {
            this.focusMapOnJob(job);
        }
    }

    startDragSheet() {
        this.isDraggingSheet.set(true);
        // TODO: Implement drag functionality
        console.log('[DriverDashboard] Sheet drag started');
    }

    private setupLocationTracking() {
        // Update driver location every 10 seconds
        setInterval(() => {
            this.updateDriverLocation();
        }, 10000);
    }

    private async updateDriverLocation() {
        try {
            const location = await this.locationService.getCurrentPosition();
            if (location) {
                this.driverLocation.set({
                    lat: location.coords.latitude,
                    lng: location.coords.longitude
                });
            }
        } catch (error) {
            console.error('[DriverDashboard] Failed to update driver location:', error);
        }
    }

    private async loadSurgeAreas() {
        try {
            // TODO: Implement surge area loading from backend
            // For now, set empty array
            this.surgeAreas.set([]);
        } catch (error) {
            console.error('[DriverDashboard] Failed to load surge areas:', error);
        }
    }

    private focusMapOnJob(job: Booking) {
        if (!job.pickup_lat || !job.pickup_lng) return;
        
        // Update selected job and center map on job location
        this.selectedJobId.set(job.id);
        // Note: Will implement map focusing when MapComponent supports it
        console.log('[DriverDashboard] Focus map on job:', job.id);
    }

    getVehicleRequired(job: Booking): string {
        const vehicleClass = (job as any).vehicle_class_required;
        if (!vehicleClass) return 'Any';
        
        switch (vehicleClass.toLowerCase()) {
            case 'bike': return 'Bike';
            case 'car': return 'Car';
            case 'van': return 'Van';
            default: return vehicleClass;
        }
    }

    getSurgeMultiplier(job: Booking): number {
        return (job as any).surge_multiplier || 1;
    }
}
