import { AfterViewInit, Component, ViewChild, inject, computed, effect, OnInit, OnDestroy, signal } from '@angular/core';
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
import { firstValueFrom } from 'rxjs';

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
import { MarkerCoordinates, ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';
import { RouteSummary } from '../../../../../core/models/maps/route-result.model';
import { NotificationService } from '../../../../../core/services/notification.service';

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

type DriverHubTab = 'requests' | 'earnings' | 'trips' | 'wallet' | 'profile';

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

      @if (activeHubTab() === 'requests') {
        <div class="relative h-[calc(100vh-10.75rem)] min-h-[560px] overflow-hidden bg-slate-100 mb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
          <div class="absolute inset-0">
            <app-map
              #map
              class="w-full h-full"
            ></app-map>
          </div>

          <button
            type="button"
            (click)="recenterMap()"
            class="absolute top-4 right-4 w-10 h-10 bg-white border border-slate-200 rounded-xl shadow-lg flex items-center justify-center active:scale-95 transition-all z-10"
          >
            <ion-icon name="navigate" class="text-lg text-slate-700"></ion-icon>
          </button>

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

          <div 
            class="absolute bottom-0 left-0 right-0 bg-white rounded-t-3xl shadow-2xl border-t border-slate-100 transition-all duration-300 z-20"
            [style.height.%]="sheetHeight()"
            [style.transform]="isDraggingSheet() ? 'scale(0.99)' : 'scale(1)'"
          >
            <button
              type="button"
              class="w-full flex justify-center py-3 cursor-grab active:cursor-grabbing"
              (click)="toggleSheet()"
              (pointerdown)="startDragSheet($event)"
              aria-label="Resize requests sheet"
            >
              <span class="w-12 h-1.5 bg-slate-300 rounded-full"></span>
            </button>

            <div class="px-4 h-[calc(100%-3rem)] overflow-hidden flex flex-col">
              @if (activeJob()) {
                @let currentJob = activeJob();
                <div class="min-h-0 flex-1 flex flex-col">
                  <div class="flex-1 overflow-y-auto overscroll-contain pb-5">
                    <div class="space-y-4">
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                          <app-badge variant="primary">{{ activeJobStatusLabel() }}</app-badge>
                          <h3 class="mt-2 text-lg font-display font-bold text-slate-900">
                            {{ activeJobTitle() }} in progress
                          </h3>
                          <p class="mt-1 text-sm font-semibold text-slate-600">
                            {{ activeJobCustomerName(currentJob) }}
                          </p>
                        </div>
                        <div class="text-right shrink-0">
                          <p class="text-2xl font-display font-black text-slate-950">
                            {{ formatPrice(getRequestFare(currentJob!)) }}
                          </p>
                          <p class="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Fare</p>
                        </div>
                      </div>

                      <div class="grid grid-cols-2 gap-3">
                        <div class="bg-slate-50 border border-slate-100 rounded-xl p-3">
                          <p class="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-1">{{ requestOriginLabel(currentJob!) }}</p>
                          <p class="text-sm font-bold text-slate-900 leading-snug">
                            {{ currentJob?.pickup_address || requestOriginUnavailableLabel(currentJob!) }}
                          </p>
                        </div>
                        <div class="bg-slate-50 border border-slate-100 rounded-xl p-3">
                          <p class="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-1">{{ requestDestinationLabel(currentJob!) }}</p>
                          <p class="text-sm font-bold text-slate-900 leading-snug">
                            {{ currentJob?.dropoff_address || requestDestinationUnavailableLabel(currentJob!) }}
                          </p>
                        </div>
                      </div>

                      <div class="grid grid-cols-3 gap-2">
                        <div class="bg-blue-50 border border-blue-100 rounded-xl p-3">
                          <p class="text-[8px] font-black text-blue-500 uppercase tracking-wider">Status</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">{{ activeJobStatusLabel() }}</p>
                        </div>
                        <div class="bg-emerald-50 border border-emerald-100 rounded-xl p-3">
                          <p class="text-[8px] font-black text-emerald-600 uppercase tracking-wider">Route</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">{{ activeJobShortRouteLabel() }}</p>
                        </div>
                        <div class="bg-amber-50 border border-amber-100 rounded-xl p-3">
                          <p class="text-[8px] font-black text-amber-600 uppercase tracking-wider">Vehicle</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">{{ getVehicleRequired(currentJob!) }}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="-mx-4 shrink-0 grid grid-cols-2 gap-3 bg-white/95 backdrop-blur border-t border-slate-100 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
                    <button
                      type="button"
                      (click)="openActiveJobChat(currentJob)"
                      class="w-full py-3 bg-white border border-slate-200 text-slate-700 rounded-xl font-bold text-sm active:scale-95 transition-all"
                    >
                      Chat
                    </button>
                    @if (activeJobCustomerPhone(currentJob)) {
                      <button
                        type="button"
                        (click)="callActiveJobCustomer(currentJob)"
                        class="w-full py-3 bg-white border border-slate-200 text-slate-700 rounded-xl font-bold text-sm active:scale-95 transition-all"
                      >
                        Call
                      </button>
                    } @else {
                      <button
                        type="button"
                        (click)="focusMapOnActiveJob()"
                        class="w-full py-3 bg-white border border-slate-200 text-slate-700 rounded-xl font-bold text-sm active:scale-95 transition-all"
                      >
                        Go to map
                      </button>
                    }
                    <button
                      type="button"
                      (click)="resumeActiveJob()"
                      class="col-span-2 w-full py-3 bg-amber-500 text-slate-950 rounded-xl font-bold text-sm active:scale-95 transition-all"
                    >
                      Continue Request
                    </button>
                  </div>
                </div>
              } @else if (selectedAvailableJob()) {
                @let selectedJob = selectedAvailableJob();
                  <div class="min-h-0 flex-1 flex flex-col">
                    <div class="flex-1 overflow-y-auto overscroll-contain pb-5">
                      <div class="space-y-4">
                      <div class="flex items-start justify-between gap-3">
                        <div class="flex-1">
                          <app-badge variant="primary">{{ getServiceName(selectedJob!) }}</app-badge>
                          <h3 class="text-lg font-display font-bold text-slate-900 mt-2">
                            {{ requestServiceHeadline(selectedJob!) }}
                          </h3>
                          <p class="text-sm text-slate-600 mt-1">{{ requestServiceHelper(selectedJob!) }}</p>
                        </div>
                        <div class="text-right">
                          <p class="text-2xl font-display font-black text-slate-950">
                            {{ formatPrice(getRequestFare(selectedJob!)) }}
                          </p>
                          <p class="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Fare</p>
                        </div>
                      </div>

                      <div class="grid grid-cols-2 gap-3">
                        <div class="bg-slate-50 border border-slate-100 rounded-xl p-3">
                          <p class="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-1">Pickup</p>
                          <p class="text-sm font-bold text-slate-900 leading-snug">
                            {{ selectedJob!.pickup_address || 'Location pending' }}
                          </p>
                        </div>
                        <div class="bg-slate-50 border border-slate-100 rounded-xl p-3">
                          <p class="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-1">Dropoff</p>
                          <p class="text-sm font-bold text-slate-900 leading-snug">
                            {{ selectedJob!.dropoff_address || 'Location pending' }}
                          </p>
                        </div>
                      </div>

                      <div class="grid grid-cols-3 gap-2">
                        <div class="bg-blue-50 border border-blue-100 rounded-xl p-3">
                          <p class="text-[8px] font-black text-blue-500 uppercase tracking-wider">Distance</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">{{ formatJobDistance(selectedJob!) }}</p>
                        </div>
                        <div class="bg-emerald-50 border border-emerald-100 rounded-xl p-3">
                          <p class="text-[8px] font-black text-emerald-600 uppercase tracking-wider">Time</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">{{ formatJobDuration(selectedJob!) }}</p>
                        </div>
                        <div class="bg-amber-50 border border-amber-100 rounded-xl p-3">
                          <p class="text-[8px] font-black text-amber-600 uppercase tracking-wider">Vehicle</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">{{ getVehicleRequired(selectedJob!) }}</p>
                        </div>
                      </div>
                      </div>
                    </div>

                    <div class="-mx-4 shrink-0 grid grid-cols-2 gap-3 bg-white/95 backdrop-blur border-t border-slate-100 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
                      <button
                        type="button"
                        (click)="reject(selectedJob!.id)"
                        class="w-full py-3 bg-white border border-slate-200 text-slate-700 rounded-xl font-bold text-sm active:scale-95 transition-all"
                      >
                        Pass
                      </button>
                      <button
                        type="button"
                        [disabled]="submitting()"
                        (click)="accept(selectedJob!.id)"
                        class="w-full py-3 bg-amber-500 text-slate-950 rounded-xl font-bold text-sm active:scale-95 transition-all disabled:opacity-50"
                      >
                        {{ submitting() ? 'Accepting...' : 'Accept Request' }}
                      </button>
                    </div>
                  </div>
              } @else {
                <div class="flex-1 overflow-y-auto overscroll-contain pb-[calc(env(safe-area-inset-bottom)+5rem)]">
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
                        class="mt-4 px-4 py-2 bg-amber-500 text-slate-950 rounded-xl font-bold text-sm active:scale-95 transition-all"
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
                        class="mt-4 px-4 py-2 bg-amber-500 text-slate-950 rounded-xl font-bold text-sm active:scale-95 transition-all"
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
                          class="w-full bg-white border border-slate-100 rounded-xl p-4 text-left active:scale-[0.98] transition-all hover:border-amber-200 hover:bg-amber-50"
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
        </div>
      } @else {
        <div class="px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+6.75rem)] space-y-4">
          @if (activeHubTab() === 'earnings') {
            <app-movabi-carousel [slides]="driverCarouselSlides()"></app-movabi-carousel>

            <div class="grid grid-cols-1 min-[560px]:grid-cols-2 gap-3">
              <app-card class="p-3 rounded-2xl">
                <div class="space-y-2.5">
                  <div class="flex items-start justify-between gap-3">
                    <p class="text-[10px] font-black uppercase tracking-[0.08em] text-slate-500 whitespace-nowrap leading-none">Acceptance</p>
                    <div class="shrink-0 scale-90 origin-top-right">
                      <app-performance-badge [type]="hasAcceptanceRate() ? 'reliable' : 'fast-responder'"></app-performance-badge>
                    </div>
                  </div>
                  <div>
                    <h2 class="text-[1.35rem] leading-none font-display font-black text-slate-950">
                      {{ acceptanceMetric().display }}
                    </h2>
                    <p class="mt-2 text-[11px] leading-snug font-bold text-slate-500 break-normal">
                      {{ acceptanceMetric().label }}
                    </p>
                  </div>
                </div>
              </app-card>

              <app-card class="p-3 rounded-2xl">
                <div class="space-y-2.5">
                  <div class="flex items-start justify-between gap-3">
                    <p class="text-[10px] font-black uppercase tracking-[0.08em] text-slate-500 whitespace-nowrap leading-none">Rating</p>
                    <div class="w-8 h-8 shrink-0 rounded-xl bg-amber-50 border border-amber-100 text-amber-500 flex items-center justify-center">
                      <ion-icon name="star-outline" class="text-lg"></ion-icon>
                    </div>
                  </div>
                  <div>
                    <h2 class="text-[1.35rem] leading-none font-display font-black text-slate-950">
                      {{ ratingMetric().isNew ? 'New' : ratingMetric().display }}
                    </h2>
                    @if (!ratingMetric().isNew && ratingMetric().value) {
                      <div class="mt-2 flex items-center gap-1 overflow-hidden" aria-label="Driver rating stars">
                        @for (starValue of [1, 2, 3, 4, 5]; track starValue) {
                          <ion-icon
                            [name]="starValue <= ratingMetric().value! ? 'star' : 'star-outline'"
                            class="text-[14px] shrink-0"
                            [class.text-amber-400]="starValue <= ratingMetric().value!"
                            [class.text-slate-300]="starValue > ratingMetric().value!"
                          ></ion-icon>
                        }
                      </div>
                    }
                    <p class="mt-2 text-[11px] leading-snug font-bold text-slate-500 break-normal">
                      {{ ratingMetric().label }}
                    </p>
                  </div>
                </div>
              </app-card>
            </div>

            <app-card class="p-4">
              <p class="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Future analytics</p>
              <h2 class="mt-2 text-xl font-display font-black text-slate-950">Performance insights</h2>
              <p class="mt-1 text-sm font-semibold text-slate-600">Acceptance, service quality, and growth features will appear here without duplicating wallet payouts.</p>
            </app-card>
          } @else if (activeHubTab() === 'trips') {
            <app-card class="p-4">
              <p class="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Trips</p>
              <h2 class="mt-2 text-xl font-display font-black text-slate-950">{{ activeJob() ? activeJobTitle() : 'No active request' }}</h2>
              <p class="mt-1 text-sm font-semibold text-slate-600">{{ activeJob() ? activeJobShortRouteLabel() : 'Accepted requests will appear here so you can continue them.' }}</p>
              <button type="button" (click)="activeJob() ? resumeActiveJob() : setHubTab('requests')" class="mt-4 w-full rounded-xl bg-amber-500 py-3 text-sm font-black text-slate-950">{{ activeJob() ? 'Continue Request' : 'Browse Requests' }}</button>
            </app-card>
          } @else if (activeHubTab() === 'wallet') {
            <div class="space-y-4">
              <app-card class="p-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p class="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Earnings & Wallet</p>
                    <h2 class="mt-2 text-2xl font-display font-black text-slate-950">{{ formatPrice(walletTransferredTotal()) }}</h2>
                    <p class="mt-1 text-sm font-semibold text-slate-600">Completed payouts transferred to Stripe Express.</p>
                  </div>
                  <span class="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-slate-600">
                    {{ getStripeBadgeText() }}
                  </span>
                </div>
                <div class="mt-4 grid grid-cols-3 gap-2">
                  <div class="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                    <p class="text-[9px] font-black uppercase tracking-[0.12em] text-emerald-700">Paid</p>
                    <p class="mt-1 text-sm font-black text-slate-950">{{ formatPrice(walletPaidTotal()) }}</p>
                  </div>
                  <div class="rounded-xl border border-amber-100 bg-amber-50 p-3">
                    <p class="text-[9px] font-black uppercase tracking-[0.12em] text-amber-700">Pending</p>
                    <p class="mt-1 text-sm font-black text-slate-950">{{ formatPrice(walletPendingTotal()) }}</p>
                  </div>
                  <div class="rounded-xl border border-rose-100 bg-rose-50 p-3">
                    <p class="text-[9px] font-black uppercase tracking-[0.12em] text-rose-700">Fees</p>
                    <p class="mt-1 text-sm font-black text-slate-950">{{ formatPrice(walletFeeTotal()) }}</p>
                  </div>
                </div>
                <div class="mt-4 grid grid-cols-2 gap-3">
                  <button type="button" (click)="openPayoutSettings()" class="rounded-xl bg-amber-500 py-3 text-sm font-black text-slate-950">Stripe Payouts</button>
                  <button type="button" (click)="router.navigate(['/driver/earnings'])" class="rounded-xl border border-slate-200 bg-white py-3 text-sm font-black text-slate-800">Full History</button>
                </div>
              </app-card>

              <app-card class="p-4">
                <div class="mb-3 flex items-center justify-between">
                  <p class="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Transactions</p>
                  <span class="text-[10px] font-black text-slate-400">{{ walletRecentEarnings().length }} latest</span>
                </div>
                @if (walletRecentEarnings().length === 0) {
                  <p class="rounded-xl bg-slate-50 px-3 py-4 text-sm font-semibold text-slate-600">Completed job earnings will appear here.</p>
                } @else {
                  <div class="space-y-2">
                    @for (earning of walletRecentEarnings(); track earning.id || earning.job_id || $index) {
                      <div class="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
                        <div class="min-w-0">
                          <p class="truncate text-sm font-black text-slate-900">{{ earningLabel(earning) }}</p>
                          <p class="text-[11px] font-semibold text-slate-500">{{ earningStatusLabel(earning) }}</p>
                        </div>
                        <p class="shrink-0 text-sm font-black text-slate-950">{{ formatPrice(earningNetAmount(earning)) }}</p>
                      </div>
                    }
                  </div>
                }
              </app-card>
            </div>
          } @else if (activeHubTab() === 'profile') {
            <div class="space-y-4">
              <app-card class="p-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p class="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Driver Controls</p>
                    <h2 class="mt-2 text-xl font-display font-black text-slate-950">{{ status() === 'online' ? 'Active' : 'Offline' }}</h2>
                    <p class="mt-1 text-sm font-semibold text-slate-600">
                      {{ status() === 'online' ? "You're live and ready for request controls." : 'Go online when you are ready to receive requests.' }}
                    </p>
                  </div>
                  <span class="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-slate-700">
                    {{ driverPlanLabel() }}
                  </span>
                </div>
                <div class="mt-4 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    (click)="status() === 'online' ? goOffline() : goOnline()"
                    class="rounded-xl py-3 text-sm font-black active:scale-95 transition-all"
                    [class.bg-emerald-500]="status() !== 'online'"
                    [class.text-white]="status() !== 'online'"
                    [class.bg-slate-900]="status() === 'online'"
                    [class.text-white]="status() === 'online'"
                  >
                    {{ status() === 'online' ? 'Go Offline' : 'Go Online' }}
                  </button>
                  <button
                    type="button"
                    (click)="toggleAvailability()"
                    [disabled]="status() !== 'online'"
                    class="rounded-xl py-3 text-sm font-black active:scale-95 transition-all disabled:opacity-50"
                    [class.bg-amber-500]="isAvailable()"
                    [class.text-slate-950]="isAvailable()"
                    [class.bg-slate-100]="!isAvailable()"
                    [class.text-slate-800]="!isAvailable()"
                  >
                    {{ isAvailable() ? 'Set Busy' : 'Set Free' }}
                  </button>
                </div>
              </app-card>

              <app-card class="p-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p class="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Verification</p>
                    <h2 class="mt-2 text-xl font-display font-black text-slate-950">{{ isVerified() ? 'Approved driver' : 'Setup needs attention' }}</h2>
                    <p class="mt-1 text-sm font-semibold text-slate-600">{{ verificationNotes() || 'Manage vehicle, documents, plan and verification status.' }}</p>
                  </div>
                  <app-badge [variant]="isVerified() ? 'success' : isActionRequired() ? 'warning' : 'secondary'">{{ verificationStatus() }}</app-badge>
                </div>
                <div class="mt-4 grid grid-cols-2 gap-3">
                  <button type="button" (click)="router.navigate(['/driver/settings'])" class="rounded-xl bg-slate-100 py-3 text-sm font-black text-slate-800">Settings</button>
                  <button type="button" (click)="router.navigate(['/driver/onboarding'])" class="rounded-xl bg-amber-500 py-3 text-sm font-black text-slate-950">Setup</button>
                </div>
              </app-card>

              <app-card class="p-4">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Stripe Connect</p>
                    <h2 class="mt-2 text-lg font-display font-black text-slate-950">{{ getStripeCompactSummary() }}</h2>
                    <p class="mt-1 text-sm font-semibold text-slate-600">{{ getStripeDescription() }}</p>
                  </div>
                  <app-badge [variant]="getStripeBadgeVariant()">{{ getStripeBadgeText() }}</app-badge>
                </div>
                <button type="button" (click)="openPayoutSettings()" class="mt-4 w-full rounded-xl bg-slate-950 py-3 text-sm font-black text-white">Payout Setup</button>
              </app-card>
            </div>
          }
        </div>
      }
    </ion-content>

    <nav class="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] shadow-[0_-12px_30px_rgba(15,23,42,0.08)] backdrop-blur">
      <div class="grid grid-cols-5 gap-1 rounded-2xl bg-slate-50 p-1">
        @for (tab of hubTabs; track tab.key) {
          <button
            type="button"
            (click)="setHubTab(tab.key)"
            class="flex min-h-[3.25rem] flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-black transition-all"
            [class.bg-amber-500]="activeHubTab() === tab.key"
            [class.text-slate-950]="activeHubTab() === tab.key"
            [class.text-slate-500]="activeHubTab() !== tab.key"
          >
            <ion-icon [name]="tab.icon" class="text-base"></ion-icon>
            <span>{{ tab.label }}</span>
          </button>
        }
      </div>
    </nav>
  `
})



export class DriverDashboardPage implements OnInit, OnDestroy, AfterViewInit {
    @ViewChild('map') private marketplaceMap?: MapComponent;

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
    private notificationService = inject(NotificationService);

    status = this.driverService.onlineStatus;
    isAvailable = this.driverService.isAvailable;
    activeJob = this.driverService.activeJob;
    activeHubTab = signal<DriverHubTab>('requests');
    readonly hubTabs: Array<{ key: DriverHubTab; label: string; icon: string }> = [
        { key: 'requests', label: 'Requests', icon: 'location-outline' },
        { key: 'earnings', label: 'Earnings', icon: 'stats-chart' },
        { key: 'trips', label: 'Trips', icon: 'list-outline' },
        { key: 'wallet', label: 'Wallet', icon: 'wallet-outline' },
        { key: 'profile', label: 'Profile', icon: 'settings-outline' }
    ];
    private readonly passedJobsStorageKey = 'movabi_driver_passed_jobs';
    passedJobIds = signal<Set<string>>(new Set());
    
    // Urgent request notification system
    private requestAlertInterval: any = null;
    private activeRequestId = signal<string | null>(null);
    jobs = computed(() => {
        const passed = this.passedJobIds();
        return this.driverService.availableJobs().filter(job => !passed.has(job.id));
    });
    selectedAvailableJob = computed(() => {
        const id = this.selectedJobId();
        if (!id) return null;
        return this.jobs().find(job => job.id === id) || null;
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
    private messagesChannel?: RealtimeChannel;
    private jobsRefreshInterval?: ReturnType<typeof setInterval>;
    private locationRefreshInterval?: ReturnType<typeof setInterval>;
    private knownAvailableJobIds = new Set<string>();
    private renderedJobMarkerIds = new Set<string>();
    private geocodedJobCoordinates = new Map<string, MarkerCoordinates>();
    private geocodingInFlight = new Set<string>();
    private geocodingAttempted = new Set<string>();
    private hasCenteredMarketplaceMap = false;
    private hasFitMarketplaceBounds = false;
    private activeRouteDrawnFor: string | null = null;
    private notifiedDriverEventIds = new Set<string>();
    private sheetDragStartY = 0;
    private sheetDragStartHeight = 40;
    private sheetDragMoved = false;
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

        effect(() => {
            this.jobs();
            this.activeJob();
            this.driverLocation();
            this.activeHubTab();

            if (this.mapComponent()) {
                queueMicrotask(() => this.syncMarketplaceMapMarkers());
            }
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
        await this.loadWalletEarnings();
        this.syncMarketplaceMapMarkers();
        this.knownAvailableJobIds = new Set(this.jobs().map(job => job.id));

        this.subscribeToAvailableJobsRealtime();
        this.subscribeToDriverMessagesRealtime();
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

        if (this.locationRefreshInterval) {
            clearInterval(this.locationRefreshInterval);
            this.locationRefreshInterval = undefined;
        }

        if (this.jobsChannel) {
            this.supabase.client.removeChannel(this.jobsChannel);
            this.jobsChannel = undefined;
        }

        if (this.messagesChannel) {
            this.supabase.client.removeChannel(this.messagesChannel);
            this.messagesChannel = undefined;
        }

        this.stopRequestAlert();
    }

    ngAfterViewInit(): void {
        window.setTimeout(() => {
            if (this.marketplaceMap) {
                this.onMapReady(this.marketplaceMap);
            }
        }, 150);
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

    async openActiveJobChat(job: Booking | null | undefined): Promise<void> {
        const jobId = job?.id || this.activeJob()?.id;

        if (!jobId) {
            this.showToast('No active request chat to open.', 'warning');
            return;
        }

        await this.router.navigate(['/driver/job-details', jobId], { queryParams: { chat: '1' } });
    }

    activeJobCustomerName(job: Booking | null | undefined = this.activeJob()): string {
        const raw = job as any;
        const value = raw?.customer?.full_name ||
            raw?.customer?.name ||
            raw?.customer_name ||
            raw?.rider_name ||
            raw?.metadata?.customer_name ||
            raw?.metadata?.rider_name;

        return String(value || 'Customer').trim();
    }

    activeJobCustomerPhone(job: Booking | null | undefined = this.activeJob()): string | null {
        const raw = job as any;
        const value = raw?.customer?.phone ||
            raw?.customer_phone ||
            raw?.metadata?.customer_phone ||
            raw?.metadata?.phone ||
            raw?.details?.customer_phone;
        const phone = String(value || '').trim();
        return phone || null;
    }

    callActiveJobCustomer(job: Booking | null | undefined = this.activeJob()): void {
        const phone = this.activeJobCustomerPhone(job);
        if (!phone) {
            this.showToast('No customer phone number available.', 'warning');
            return;
        }

        window.location.href = `tel:${phone}`;
    }

    async focusMapOnActiveJob(): Promise<void> {
        const active = this.activeJob();
        if (!active) return;

        const pickup = this.resolveJobCoordinates(active) || await this.ensureJobCoordinates(active);
        if (pickup) {
            this.mapComponent()?.setCenter(pickup.lng, pickup.lat, 15);
        }

        this.syncMarketplaceMapMarkers();
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

    driverPlanLabel(): string {
        return this.isProDriver() ? 'Pro Driver' : 'Starter Driver';
    }

    walletRecentEarnings(): any[] {
        return (this.driverService.earnings() || []).slice(0, 5);
    }

    walletPaidTotal(): number {
        return this.sumEarningsByStatus('paid');
    }

    walletPendingTotal(): number {
        return this.sumEarningsByStatus('pending');
    }

    walletTransferredTotal(): number {
        return this.walletPaidTotal();
    }

    walletFeeTotal(): number {
        return (this.driverService.earnings() || []).reduce((total, earning: any) => {
            const fee = this.firstPositiveNumber(
                earning?.platform_fee,
                earning?.platform_commission,
                earning?.commission_amount,
                earning?.fee
            );
            return total + (fee || 0);
        }, 0);
    }

    earningNetAmount(earning: any): number {
        return this.firstPositiveNumber(
            earning?.net_amount,
            earning?.driver_payout,
            earning?.payout_amount,
            earning?.amount
        ) || 0;
    }

    earningStatusLabel(earning: any): string {
        const status = this.getWalletEarningStatus(earning);
        return status === 'paid' ? 'Paid to Stripe' : 'Pending payout';
    }

    earningLabel(earning: any): string {
        return String(
            earning?.service_type ||
            earning?.service_slug ||
            earning?.job_type ||
            earning?.description ||
            'Completed request'
        ).replace(/_/g, ' ');
    }

    private sumEarningsByStatus(status: 'paid' | 'pending'): number {
        return (this.driverService.earnings() || [])
            .filter((earning: any) => this.getWalletEarningStatus(earning) === status)
            .reduce((total, earning: any) => total + this.earningNetAmount(earning), 0);
    }

    private getWalletEarningStatus(earning: any): 'paid' | 'pending' {
        const status = String(
            earning?.status ||
            earning?.payout_status ||
            earning?.transfer_status ||
            ''
        ).toLowerCase();

        return ['paid', 'transferred', 'settled', 'completed', 'succeeded'].includes(status)
            ? 'paid'
            : 'pending';
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
        this.syncMarketplaceMapMarkers();
        this.showToast('Requests refreshed.', 'success');
    }

    private async loadWalletEarnings(): Promise<void> {
        try {
            await this.driverService.fetchEarnings();
        } catch (error) {
            console.warn('[driver-dashboard] Failed to load wallet earnings', error);
        }
    }

    async browseRequests() {
        if (this.status() !== 'online') {
            await this.goOnline();
        } else {
            await this.driverService.fetchAvailableJobs();
            this.syncMarketplaceMapMarkers();
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
        this.syncMarketplaceMapMarkers();
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
                    const user = this.auth.currentUser();
                    const changedDriverId = String((payload.new as any)?.driver_id || (payload.old as any)?.driver_id || '');
                    const isDriverJob = !!user?.id && changedDriverId === user.id;
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
                        this.syncMarketplaceMapMarkers();

                        const visibleJobs = this.jobs();
                        const newVisibleJob = visibleJobs.find(job => job.id === changedJobId);

                        if (shouldAlert && newVisibleJob) {
                            await this.alertNewJob(newVisibleJob);
                        }

                        if (isDriverJob && changedJobId && newStatus && newStatus !== oldStatus) {
                            await this.notifyDriverEventOnce(
                                `job-status:${changedJobId}:${newStatus}`,
                                'Request updated',
                                `Status changed to ${this.formatStatusText(newStatus)}.`,
                                { route: `/driver/job-details/${changedJobId}`, jobId: changedJobId, type: 'job_status_update' }
                            );
                        }

                        this.knownAvailableJobIds = new Set(visibleJobs.map(job => job.id));
                    }
                }
            )
            .subscribe((status) => {
                console.log('[driver-dashboard] jobs realtime:', status);
            });
    }

    private subscribeToDriverMessagesRealtime(): void {
        if (this.messagesChannel) return;

        const user = this.auth.currentUser();
        if (!user?.id) return;

        this.messagesChannel = this.supabase.client
            .channel(`driver-dashboard-messages-${user.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'job_messages',
                    filter: `receiver_id=eq.${user.id}`
                },
                async (payload) => {
                    const message = payload.new as Record<string, any>;
                    const jobId = String(message['job_id'] || '');
                    const messageId = String(message['id'] || `${jobId}:${message['created_at'] || Date.now()}`);

                    await this.notifyDriverEventOnce(
                        `chat:${messageId}`,
                        'New customer message',
                        String(message['message'] || 'Open the request to reply.'),
                        { route: jobId ? `/driver/job-details/${jobId}` : '/driver', jobId, type: 'customer_chat_message' }
                    );
                }
            )
            .subscribe((status) => {
                console.log('[driver-dashboard] messages realtime:', status);
            });
    }

    private async notifyDriverEventOnce(
        key: string,
        title: string,
        body: string,
        data?: Record<string, unknown>
    ): Promise<void> {
        if (this.notifiedDriverEventIds.has(key)) return;
        this.notifiedDriverEventIds.add(key);

        this.showToast(`${title}: ${body}`, 'warning');

        try {
            await Haptics.notification({ type: NotificationType.Warning });
        } catch {
            navigator.vibrate?.([120, 70, 120]);
        }

        this.playNewJobTone();
        await this.notificationService.showLocalNotification(title, body, data).catch(() => undefined);
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

    private formatStatusText(status: string): string {
        return String(status || 'updated')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
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
                this.syncMarketplaceMapMarkers();
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
        this.syncMarketplaceMapMarkers();

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
        this.syncMarketplaceMapMarkers();
        this.checkTracking();
    }

    async goOffline() {
        const profile = this.profileService.profile();

        this.driverService.onlineStatus.set('offline');
        this.driverService.isAvailable.set(false);
        this.driverService.availableJobs.set([]);
        this.syncMarketplaceMapMarkers();

        if (profile) {
            await this.safeUpdateProfile(profile.id, {
                is_online: false,
                is_available: false,
                last_active_at: new Date().toISOString()
            });
        }

        this.checkTracking();
    }

    async toggleAvailability(event?: Event) {
        const customEvent = event as CustomEvent | undefined;
        const hasToggleValue = customEvent?.detail && typeof customEvent.detail.checked === 'boolean';
        const available = hasToggleValue ? !!customEvent?.detail?.checked : !this.isAvailable();
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
            this.syncMarketplaceMapMarkers();
        } else {
            this.driverService.availableJobs.set([]);
            this.syncMarketplaceMapMarkers();
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

            this.driverService.availableJobs.update((jobs: Booking[]) =>
                jobs.filter((job: Booking) => job.id !== jobId)
            );
            this.stopRequestAlert();
            await this.refreshActiveJob();
            await this.driverService.fetchAvailableJobs();
            this.selectedJobId.set(null);
            this.sheetHeight.set(55);
            this.hasFitMarketplaceBounds = false;
            this.syncMarketplaceMapMarkers();

            await loading.dismiss();
            this.submitting.set(false);
            this.showToast('Request accepted. Continue when you are ready.', 'success');
        } catch (e: unknown) {
            await loading.dismiss();
            this.submitting.set(false);

            const message = e instanceof Error ? e.message : 'Request no longer available';
            this.showToast(message, 'danger');

            await this.driverService.fetchAvailableJobs();
            this.syncMarketplaceMapMarkers();
        }
    }

    reject(jobId: string) {
        this.rememberPassedJob(jobId);
        this.stopRequestAlert();
        if (this.selectedJobId() === jobId) {
            this.selectedJobId.set(null);
            this.sheetHeight.set(40);
        }
        this.driverService.availableJobs.update((jobs: Booking[]) =>
            jobs.filter((job: Booking) => job.id !== jobId)
        );
        this.syncMarketplaceMapMarkers();
    }

    private startRequestAlert(requestId: string): void {
        if (this.requestAlertInterval) return;

        this.activeRequestId.set(requestId);
        this.playRequestSound();
        this.vibrateNewRequest();

        this.requestAlertInterval = setInterval(() => {
            if (!this.activeRequestId() || this.activeRequestId() !== requestId) {
                this.stopRequestAlert();
                return;
            }

            this.playRequestSound();
        }, 4000);
    }

    private stopRequestAlert(): void {
        if (this.requestAlertInterval) {
            clearInterval(this.requestAlertInterval);
            this.requestAlertInterval = null;
        }
        this.activeRequestId.set(null);
    }

    private async playRequestSound(): Promise<void> {
        try {
            const audio = new Audio('/assets/sounds/request-notification.mp3');
            audio.volume = 0.7;
            await audio.play();
        } catch (error) {
            console.warn('[DriverDashboard] Failed to play request sound:', error);
        }
    }

    private async vibrateNewRequest(): Promise<void> {
        try {
            await Haptics.notification({
                type: NotificationType.Success
            });
        } catch (error) {
            console.warn('[DriverDashboard] Failed to vibrate for new request:', error);
        }
    }

    // Monitor available jobs for urgent requests
    private urgentRequestEffect = effect(() => {
        const availableJobs = this.driverService.availableJobs();
        const activeJob = this.activeJob();
        
        // Only alert if there's no active job and there are available jobs
        if (!activeJob && availableJobs.length > 0) {
            const newestJob = availableJobs[0]; // Assume first is newest
            if (newestJob?.id && this.activeRequestId() !== newestJob.id) {
                this.startRequestAlert(newestJob.id);
            }
        } else {
            // Stop alert if there's an active job or no available jobs
            this.stopRequestAlert();
        }
    });

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

    onMapReady(mapComponent: MapComponent) {
        this.mapComponent.set(mapComponent);

        window.setTimeout(() => {
            mapComponent.resize();
            void this.updateDriverLocation();
            this.syncMarketplaceMapMarkers();
        }, 200);
    }

    setHubTab(tab: DriverHubTab): void {
        this.activeHubTab.set(tab);

        if (tab === 'requests') {
            window.setTimeout(() => {
                this.mapComponent()?.resize?.();
                this.syncMarketplaceMapMarkers();
                this.centerMarketplaceMap(false);
            }, 120);
        }

        if (tab === 'wallet' || tab === 'earnings') {
            void this.loadWalletEarnings();
        }
    }

    selectJob(jobId: string) {
        this.selectedJobId.set(jobId);

        const job = this.jobs().find(j => j.id === jobId);
        if (job) {
            void this.focusMapOnJob(job);
        }

        this.sheetHeight.set(80);
    }

    recenterMap() {
        this.hasCenteredMarketplaceMap = false;
        this.hasFitMarketplaceBounds = false;
        void this.updateDriverLocation().then(() => this.centerMarketplaceMap(true));
    }

    seeJobOnMap(job: Booking) {
        this.selectedJobId.set(job.id);
        void this.focusMapOnJob(job);
    }

    toggleSheet(): void {
        if (this.sheetDragMoved) {
            this.sheetDragMoved = false;
            return;
        }

        this.sheetHeight.set(this.sheetHeight() >= 70 ? 40 : 80);
    }

    startDragSheet(event: PointerEvent) {
        event.preventDefault();
        this.isDraggingSheet.set(true);
        this.sheetDragMoved = false;
        this.sheetDragStartY = event.clientY;
        this.sheetDragStartHeight = this.sheetHeight();

        const move = (moveEvent: PointerEvent) => {
            const delta = Math.abs(moveEvent.clientY - this.sheetDragStartY);
            if (delta > 4) {
                this.sheetDragMoved = true;
            }

            const viewportHeight = Math.max(window.innerHeight, 1);
            const deltaVh = ((this.sheetDragStartY - moveEvent.clientY) / viewportHeight) * 100;
            const nextHeight = Math.max(40, Math.min(80, this.sheetDragStartHeight + deltaVh));
            this.sheetHeight.set(nextHeight);
        };

        const end = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            document.removeEventListener('pointercancel', end);
            this.sheetHeight.set(this.sheetHeight() >= 60 ? 80 : 40);

            window.setTimeout(() => {
                this.isDraggingSheet.set(false);
                this.sheetDragMoved = false;
            }, 0);
        };

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end, { once: true });
        document.addEventListener('pointercancel', end, { once: true });
    }

    payoutHelperText(): string {
        if (this.isStripeReady()) {
            return 'Stripe Connect is ready for completed job payouts.';
        }

        return 'Open payout setup to finish Stripe Connect before payout processing.';
    }

    async openPayoutSettings(): Promise<void> {
        if (this.isStripeReady()) {
            await this.openStripeDashboard();
            return;
        }

        await this.setupPayouts();
    }

    private setupLocationTracking() {
        if (this.locationRefreshInterval) return;

        void this.updateDriverLocation();
        this.locationRefreshInterval = setInterval(() => {
            void this.updateDriverLocation();
        }, 10000);
    }

    private async updateDriverLocation(): Promise<MarkerCoordinates | null> {
        try {
            const location = await this.locationService.getCurrentPosition();
            if (location) {
                const coordinates = {
                    lat: location.coords.latitude,
                    lng: location.coords.longitude
                };
                this.driverLocation.set(coordinates);
                this.syncMarketplaceMapMarkers();
                this.centerMarketplaceMap(false);
                return coordinates;
            }
        } catch (error) {
            console.warn('[DriverDashboard] GPS location unavailable, checking last known driver location.', error);
        }

        const user = this.auth.currentUser();
        if (user?.id) {
            try {
                const lastKnown = await this.locationService.getLatestDriverLocation(user.id);
                if (lastKnown) {
                    const coordinates = {
                        lat: lastKnown.lat,
                        lng: lastKnown.lng
                    };
                    this.driverLocation.set(coordinates);
                    this.syncMarketplaceMapMarkers();
                    this.centerMarketplaceMap(false);
                    return coordinates;
                }
            } catch (error) {
                console.warn('[DriverDashboard] Last known driver location unavailable.', error);
            }
        }

        this.centerMarketplaceMap(false);
        return null;
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

    private async focusMapOnJob(job: Booking): Promise<void> {
        let coordinates = this.resolveJobCoordinates(job);

        if (!coordinates) {
            coordinates = await this.ensureJobCoordinates(job);
        }

        if (!coordinates) return;

        this.selectedJobId.set(job.id);
        this.mapComponent()?.setCenter(coordinates.lng, coordinates.lat, 15);
        this.syncMarketplaceMapMarkers();
    }

    private syncMarketplaceMapMarkers(): void {
        const map = this.mapComponent() as MapComponent | null;
        if (!map || this.activeHubTab() !== 'requests') return;

        map.resize();

        const driverLocation = this.driverLocation();
        if (driverLocation) {
            map.addOrUpdateMarker({
                id: 'driver-current-location',
                kind: 'driver',
                serviceType: 'ride',
                coordinates: driverLocation,
                label: 'You'
            });
        } else {
            map.removeMarker('driver-current-location');
        }

        const nextMarkerIds = new Set<string>();
        for (const job of this.jobs()) {
            const coordinates = this.resolveJobCoordinates(job);

            if (!coordinates) {
                void this.ensureJobCoordinates(job);
                continue;
            }

            const markerId = `available-job-${job.id}`;
            nextMarkerIds.add(markerId);
            map.addOrUpdateMarker({
                id: markerId,
                kind: 'pickup',
                serviceType: this.getMarkerServiceType(job),
                coordinates,
                label: this.formatPrice(this.getRequestFare(job)),
                onClick: () => this.selectJob(job.id)
            });
        }

        const active = this.activeJob();
        if (active) {
            const pickup = this.resolveJobCoordinates(active);
            const dropoff = this.resolveJobDestinationCoordinates(active);

            if (!pickup) {
                void this.ensureJobCoordinates(active);
            }

            if (!dropoff) {
                void this.ensureJobDestinationCoordinates(active);
            }

            if (pickup) {
                const pickupMarkerId = `active-job-pickup-${active.id}`;
                nextMarkerIds.add(pickupMarkerId);
                map.addOrUpdateMarker({
                    id: pickupMarkerId,
                    kind: 'pickup',
                    serviceType: this.getMarkerServiceType(active),
                    coordinates: pickup,
                    label: this.requestOriginLabel(active)
                });
            }

            if (dropoff) {
                const dropoffMarkerId = `active-job-dropoff-${active.id}`;
                nextMarkerIds.add(dropoffMarkerId);
                map.addOrUpdateMarker({
                    id: dropoffMarkerId,
                    kind: 'destination',
                    serviceType: this.getMarkerServiceType(active),
                    coordinates: dropoff,
                    label: this.requestDestinationLabel(active)
                });
            }

            this.drawActiveJobRoute(active, pickup, dropoff);
        } else {
            map.clearRoute();
            this.activeRouteDrawnFor = null;
        }

        for (const markerId of this.renderedJobMarkerIds) {
            if (!nextMarkerIds.has(markerId)) {
                map.removeMarker(markerId);
            }
        }

        this.renderedJobMarkerIds = nextMarkerIds;
        this.centerMarketplaceMap(false);
    }

    private centerMarketplaceMap(force: boolean): void {
        const map = this.mapComponent() as MapComponent | null;
        if (!map || this.activeHubTab() !== 'requests') return;

        const points = this.getMarketplaceMapPoints();
        const uniquePoints = this.uniqueCoordinates(points);

        if (uniquePoints.length >= 2) {
            if (this.hasFitMarketplaceBounds && !force) return;

            const lats = uniquePoints.map(point => point.lat);
            const lngs = uniquePoints.map(point => point.lng);
            const bounds: [[number, number], [number, number]] = [
                [Math.min(...lngs), Math.min(...lats)],
                [Math.max(...lngs), Math.max(...lats)]
            ];

            map.fitBounds(bounds, {
                padding: { top: 72, bottom: 260, left: 48, right: 48 },
                maxZoom: 15,
                duration: force ? 700 : 900
            });
            this.hasFitMarketplaceBounds = true;
            this.hasCenteredMarketplaceMap = true;
            return;
        }

        if (this.hasCenteredMarketplaceMap && !force) return;

        const center = uniquePoints[0] ?? this.locationService.getFallbackCoordinates();
        if (!center) return;

        map.setCenter(center.lng, center.lat, this.driverLocation() ? 14 : 12);
        this.hasCenteredMarketplaceMap = true;
    }

    private getMarketplaceMapPoints(): MarkerCoordinates[] {
        const points: MarkerCoordinates[] = [];
        const driverLocation = this.driverLocation();

        if (driverLocation) {
            points.push(driverLocation);
        }

        for (const job of this.jobs()) {
            const coordinates = this.resolveJobCoordinates(job);
            if (coordinates) {
                points.push(coordinates);
            }
        }

        const active = this.activeJob();
        if (active) {
            const pickup = this.resolveJobCoordinates(active);
            const dropoff = this.resolveJobDestinationCoordinates(active);
            if (pickup) points.push(pickup);
            if (dropoff) points.push(dropoff);
        }

        const serviceArea = this.resolveServiceAreaCoordinates();
        if (!points.length && serviceArea) {
            points.push(serviceArea);
        }

        return points;
    }

    private uniqueCoordinates(points: MarkerCoordinates[]): MarkerCoordinates[] {
        const seen = new Set<string>();
        const unique: MarkerCoordinates[] = [];

        for (const point of points) {
            const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(point);
        }

        return unique;
    }

    private resolveJobCoordinates(job: Booking): MarkerCoordinates | null {
        const cached = this.geocodedJobCoordinates.get(job.id);
        if (cached) return cached;

        const raw = job as Record<string, any>;
        const direct = this.coordinatesFromValues(
            raw['pickup_lat'] ?? raw['pickup_latitude'] ?? raw['store_lat'] ?? raw['store_latitude'],
            raw['pickup_lng'] ?? raw['pickup_longitude'] ?? raw['pickup_lon'] ?? raw['store_lng'] ?? raw['store_longitude'] ?? raw['store_lon']
        );
        if (direct) return direct;

        const metadata = raw['metadata'] as Record<string, any> | undefined;
        return this.coordinatesFromValues(
            metadata?.['pickup_lat'] ?? metadata?.['store_lat'],
            metadata?.['pickup_lng'] ?? metadata?.['pickup_lon'] ?? metadata?.['store_lng'] ?? metadata?.['store_lon']
        );
    }

    private resolveJobDestinationCoordinates(job: Booking): MarkerCoordinates | null {
        const cacheKey = `${job.id}:dropoff`;
        const cached = this.geocodedJobCoordinates.get(cacheKey);
        if (cached) return cached;

        const raw = job as Record<string, any>;
        const direct = this.coordinatesFromValues(
            raw['dropoff_lat'] ?? raw['dropoff_latitude'] ?? raw['destination_lat'] ?? raw['delivery_lat'],
            raw['dropoff_lng'] ?? raw['dropoff_longitude'] ?? raw['dropoff_lon'] ?? raw['destination_lng'] ?? raw['destination_lon'] ?? raw['delivery_lng'] ?? raw['delivery_lon']
        );
        if (direct) return direct;

        const metadata = raw['metadata'] as Record<string, any> | undefined;
        return this.coordinatesFromValues(
            metadata?.['dropoff_lat'] ?? metadata?.['destination_lat'] ?? metadata?.['delivery_lat'],
            metadata?.['dropoff_lng'] ?? metadata?.['dropoff_lon'] ?? metadata?.['destination_lng'] ?? metadata?.['destination_lon'] ?? metadata?.['delivery_lng'] ?? metadata?.['delivery_lon']
        );
    }

    private async ensureJobCoordinates(job: Booking): Promise<MarkerCoordinates | null> {
        const existing = this.resolveJobCoordinates(job);
        if (existing) return existing;
        if (this.geocodingInFlight.has(job.id)) return null;
        if (this.geocodingAttempted.has(job.id)) return null;

        const address = this.getJobMarkerAddress(job);
        if (!address) return null;

        this.geocodingInFlight.add(job.id);
        this.geocodingAttempted.add(job.id);

        try {
            const results = await firstValueFrom(this.geocoding.geocodeAddress(address));
            const match = results.find(result => this.isValidCoordinate(result.lat, result.lng));

            if (!match) return null;

            const coordinates = { lat: Number(match.lat), lng: Number(match.lng) };
            this.geocodedJobCoordinates.set(job.id, coordinates);
            await this.cacheJobCoordinates(job.id, coordinates);
            this.syncMarketplaceMapMarkers();
            return coordinates;
        } catch (error) {
            console.warn('[DriverDashboard] Could not geocode available request address.', { jobId: job.id, error });
            return null;
        } finally {
            this.geocodingInFlight.delete(job.id);
        }
    }

    private async ensureJobDestinationCoordinates(job: Booking): Promise<MarkerCoordinates | null> {
        const existing = this.resolveJobDestinationCoordinates(job);
        if (existing) return existing;

        const cacheKey = `${job.id}:dropoff`;
        if (this.geocodingInFlight.has(cacheKey)) return null;
        if (this.geocodingAttempted.has(cacheKey)) return null;

        const address = this.getJobDestinationMarkerAddress(job);
        if (!address) return null;

        this.geocodingInFlight.add(cacheKey);
        this.geocodingAttempted.add(cacheKey);

        try {
            const results = await firstValueFrom(this.geocoding.geocodeAddress(address));
            const match = results.find(result => this.isValidCoordinate(result.lat, result.lng));

            if (!match) return null;

            const coordinates = { lat: Number(match.lat), lng: Number(match.lng) };
            this.geocodedJobCoordinates.set(cacheKey, coordinates);
            await this.cacheJobDestinationCoordinates(job.id, coordinates);
            this.syncMarketplaceMapMarkers();
            return coordinates;
        } catch (error) {
            console.warn('[DriverDashboard] Could not geocode active request destination.', { jobId: job.id, error });
            return null;
        } finally {
            this.geocodingInFlight.delete(cacheKey);
        }
    }

    private async cacheJobCoordinates(jobId: string, coordinates: MarkerCoordinates): Promise<void> {
        try {
            const { error } = await this.supabase.client
                .from('jobs')
                .update({
                    pickup_lat: coordinates.lat,
                    pickup_lng: coordinates.lng
                })
                .eq('id', jobId);

            if (error) {
                console.warn('[DriverDashboard] Could not cache available request coordinates.', error);
            }
        } catch (error) {
            console.warn('[DriverDashboard] Available request coordinate cache skipped.', error);
        }
    }

    private async cacheJobDestinationCoordinates(jobId: string, coordinates: MarkerCoordinates): Promise<void> {
        try {
            const { error } = await this.supabase.client
                .from('jobs')
                .update({
                    dropoff_lat: coordinates.lat,
                    dropoff_lng: coordinates.lng
                })
                .eq('id', jobId);

            if (error) {
                console.warn('[DriverDashboard] Could not cache active request destination coordinates.', error);
            }
        } catch (error) {
            console.warn('[DriverDashboard] Active request destination coordinate cache skipped.', error);
        }
    }

    private getJobMarkerAddress(job: Booking): string {
        const raw = job as Record<string, any>;
        const metadata = raw['metadata'] as Record<string, any> | undefined;
        return String(
            raw['pickup_address'] ||
            raw['store_address'] ||
            raw['origin_address'] ||
            metadata?.['pickup_address'] ||
            metadata?.['store_address'] ||
            ''
        ).trim();
    }

    private getJobDestinationMarkerAddress(job: Booking): string {
        const raw = job as Record<string, any>;
        const metadata = raw['metadata'] as Record<string, any> | undefined;
        return String(
            raw['dropoff_address'] ||
            raw['destination_address'] ||
            raw['delivery_address'] ||
            metadata?.['dropoff_address'] ||
            metadata?.['destination_address'] ||
            metadata?.['delivery_address'] ||
            ''
        ).trim();
    }

    private drawActiveJobRoute(
        job: Booking,
        pickup: MarkerCoordinates | null,
        dropoff: MarkerCoordinates | null
    ): void {
        const map = this.mapComponent() as MapComponent | null;
        if (!map || !pickup || !dropoff) {
            map?.clearRoute();
            this.activeRouteDrawnFor = null;
            return;
        }

        const routeKey = `${job.id}:${pickup.lat.toFixed(5)},${pickup.lng.toFixed(5)}:${dropoff.lat.toFixed(5)},${dropoff.lng.toFixed(5)}`;
        if (this.activeRouteDrawnFor === routeKey) return;

        const bounds: [[number, number], [number, number]] = [
            [Math.min(pickup.lng, dropoff.lng), Math.min(pickup.lat, dropoff.lat)],
            [Math.max(pickup.lng, dropoff.lng), Math.max(pickup.lat, dropoff.lat)]
        ];

        const route: RouteSummary = {
            distanceMeters: 0,
            durationSeconds: 0,
            geometry: {
                type: 'LineString',
                coordinates: [
                    [pickup.lng, pickup.lat],
                    [dropoff.lng, dropoff.lat]
                ]
            },
            bounds
        };

        map.drawRoute(route);
        this.activeRouteDrawnFor = routeKey;
    }

    private getMarkerServiceType(job: Booking): ServiceTypeSlug {
        const slug = String((job as any).service_type?.slug || (job as any).service_slug || (job as any).type || '').toLowerCase();

        if (slug.includes('van')) return 'van-moving';
        if (slug.includes('delivery')) return 'delivery';
        if (slug.includes('errand')) return 'errand';
        return 'ride';
    }

    private resolveServiceAreaCoordinates(): MarkerCoordinates | null {
        for (const job of this.jobs()) {
            const coordinates = this.resolveJobCoordinates(job);
            if (coordinates) return coordinates;

            const raw = job as Record<string, any>;
            const metadata = raw['metadata'] as Record<string, any> | undefined;
            const cityCoordinates = this.coordinatesFromValues(
                raw['city_lat'] ?? metadata?.['city_lat'],
                raw['city_lng'] ?? raw['city_lon'] ?? metadata?.['city_lng'] ?? metadata?.['city_lon']
            );

            if (cityCoordinates) return cityCoordinates;
        }

        return null;
    }

    private coordinatesFromValues(latValue: unknown, lngValue: unknown): MarkerCoordinates | null {
        const lat = Number(latValue);
        const lng = Number(lngValue);

        if (!this.isValidCoordinate(lat, lng)) return null;
        return { lat, lng };
    }

    private isValidCoordinate(lat: unknown, lng: unknown): boolean {
        const parsedLat = Number(lat);
        const parsedLng = Number(lng);
        return Number.isFinite(parsedLat) &&
            Number.isFinite(parsedLng) &&
            parsedLat >= -90 &&
            parsedLat <= 90 &&
            parsedLng >= -180 &&
            parsedLng <= 180;
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
