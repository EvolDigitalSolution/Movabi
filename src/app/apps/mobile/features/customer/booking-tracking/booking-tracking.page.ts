import {
    Component,
    inject,
    OnInit,
    OnDestroy,
    signal,
    ViewChild,
    computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, AlertController } from '@ionic/angular';
import { ActivatedRoute, Router } from '@angular/router';
import { addIcons } from 'ionicons';

import {
    chevronBackOutline,
    call,
    chevronDown,
    chatbubbles,
    alertCircleOutline,
    navigate,
    shieldCheckmark,
    informationCircle,
    receiptOutline,
    timeOutline,
    sparklesOutline,
    carSportOutline,
    refreshOutline,
    closeCircleOutline,
    timerOutline,
    checkmarkCircleOutline
} from 'ionicons/icons';

import { RealtimeChannel } from '@supabase/supabase-js';

import { BookingService } from '../../../../../core/services/booking/booking.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { RoutingService } from '../../../../../core/services/maps/routing.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { WalletService } from '../../../../../core/services/wallet/wallet.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';

import {
    ServiceTypeEnum,
    DriverLocation,
    ErrandFunding
} from '../../../../../shared/models/booking.model';

import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';

import {
    CardComponent,
    ButtonComponent,
    BadgeComponent
} from '../../../../../shared/ui';

import { CommunicationPanelComponent } from '../../../../../shared/ui/communication-panel';
import { MapComponent } from '../../../../../shared/components/map/map.component';

const DRIVER_SEARCH_WINDOW_SECONDS = 300;

@Component({
    selector: 'app-booking-tracking',
    standalone: true,
    imports: [
        CommonModule,
        IonicModule,
        CardComponent,
        ButtonComponent,
        BadgeComponent,
        CommunicationPanelComponent,
        MapComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Live Tracking</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      @if (booking()) {
        <div class="flex flex-col h-full">
          <div class="flex-1 bg-slate-100 relative overflow-hidden min-h-[300px]">
            <app-map #map></app-map>

            @if (booking()?.status === 'searching') {
              <div class="absolute inset-0 bg-slate-950/45 backdrop-blur-md flex items-center justify-center p-6 z-20">
                <div class="max-w-sm w-full bg-white/95 border border-white/60 rounded-[2rem] shadow-2xl p-6 text-center">
                  <div class="w-16 h-16 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto mb-5 border border-blue-100 shadow-lg shadow-blue-100">
                    <ion-spinner name="crescent" color="primary"></ion-spinner>
                  </div>

                  <div class="space-y-2 mb-5">
                    <h2 class="text-xl font-display font-bold text-slate-900 tracking-tight">Finding your driver</h2>
                    <p class="text-sm text-slate-500 font-medium leading-relaxed">
                      We’re matching you with the nearest available driver.
                    </p>
                  </div>

                  <div class="p-4 rounded-2xl bg-blue-50 border border-blue-100 text-left mb-4">
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-[10px] font-bold uppercase tracking-widest text-blue-600">Search timer</span>
                      <span class="text-base font-display font-bold text-slate-900">
                        {{ searchCountdownLabel() }}
                      </span>
                    </div>

                    <div class="w-full h-2 bg-blue-100 rounded-full overflow-hidden">
                      <div
                        class="h-full bg-blue-600 rounded-full transition-all duration-1000"
                        [style.width.%]="searchProgressPercent()"
                      ></div>
                    </div>
                  </div>

                  <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    Dispatch is being managed securely
                  </p>
                </div>
              </div>
            }
          </div>

          <div class="bg-white rounded-t-[2.5rem] shadow-2xl p-6 space-y-6 -mt-10 relative z-10 max-h-[72%] overflow-y-auto border-t border-slate-100">
            <div class="w-12 h-1 bg-slate-100 rounded-full mx-auto"></div>

            <div class="p-5 rounded-[2rem] border border-slate-100 bg-gradient-to-br from-white to-slate-50 shadow-sm">
              <div class="flex justify-between items-start gap-4">
                <div class="min-w-0">
                  <app-badge [variant]="getStatusVariant(booking()?.status || '')" class="mb-3">
                    {{ getStatusLabel(booking()?.status || '') }}
                  </app-badge>

                  <h2 class="text-2xl font-display font-bold text-slate-900 tracking-tight">
                    Booking Details
                  </h2>

                  <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                    {{ getStatusHint(booking()?.status || '') }}
                  </p>

                  <p class="text-[9px] font-bold text-slate-300 uppercase tracking-widest mt-2">
                    ID: {{ booking()?.id?.slice(0, 8) }}
                  </p>
                </div>

                <div class="text-right shrink-0">
                  <p class="text-3xl font-display font-bold text-slate-900">
                    {{ getDisplayedTotal() }}
                  </p>
                  <p class="text-[9px] font-bold text-emerald-600 uppercase tracking-widest mt-1">
                    {{ booking()?.service_slug === ServiceTypeEnum.ERRAND ? 'Total Reserved' : 'Fixed Price' }}
                  </p>
                </div>
              </div>

              @if (booking()?.status === 'searching') {
                <div class="mt-5 grid grid-cols-2 gap-3">
                  <div class="p-4 rounded-2xl bg-blue-50 border border-blue-100">
                    <div class="flex items-center gap-2 mb-1">
                      <ion-icon name="timer-outline" class="text-blue-600"></ion-icon>
                      <p class="text-[10px] font-bold text-blue-600 uppercase tracking-widest">Time left</p>
                    </div>
                    <p class="text-lg font-display font-bold text-slate-900">
                      {{ searchCountdownLabel() }}
                    </p>
                  </div>

                  <div class="p-4 rounded-2xl bg-slate-50 border border-slate-100">
                    <div class="flex items-center gap-2 mb-1">
                      <ion-icon name="refresh-outline" class="text-slate-500"></ion-icon>
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Search status</p>
                    </div>
                    <p class="text-sm font-bold text-slate-900">Looking nearby</p>
                  </div>
                </div>
              }
            </div>

            @if (booking()?.service_slug === ServiceTypeEnum.ERRAND && errandFunding()) {
              <div class="grid grid-cols-2 gap-3">
                <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Service Fee</p>
                  <p class="text-lg font-display font-bold text-slate-900">
                    {{ config.formatCurrency(booking()?.total_price || 0) }}
                  </p>
                </div>

                <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Item Budget</p>
                  <p class="text-lg font-display font-bold text-slate-900">
                    {{ config.formatCurrency(errandFunding()?.amount_reserved || 0) }}
                  </p>
                </div>
              </div>
            }

            @if (booking()?.driver_id) {
              @if (errandFunding()?.over_budget_status === 'requested') {
                <div class="p-6 bg-rose-50 rounded-[2rem] border border-rose-100">
                  <div class="flex items-center gap-3 mb-4">
                    <div class="w-10 h-10 rounded-xl bg-rose-500 flex items-center justify-center text-white shadow-lg shadow-rose-200">
                      <ion-icon name="alert-circle-outline" class="text-xl"></ion-icon>
                    </div>
                    <div>
                      <h3 class="text-base font-display font-bold text-slate-900">Budget Increase</h3>
                      <p class="text-[9px] font-bold text-rose-600 uppercase tracking-widest">Action Required</p>
                    </div>
                  </div>

                  <div class="space-y-3 mb-6">
                    <div class="flex justify-between items-center p-3 bg-white rounded-xl border border-rose-100">
                      <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Original</span>
                      <span class="text-base font-display font-bold text-slate-900">
                        {{ config.formatCurrency(errandFunding()?.amount_reserved || 0) }}
                      </span>
                    </div>

                    <div class="flex justify-between items-center p-3 bg-rose-100/50 rounded-xl border border-rose-200">
                      <span class="text-[10px] font-bold text-rose-600 uppercase tracking-widest">New Required</span>
                      <span class="text-base font-display font-bold text-rose-700">
                        {{ config.formatCurrency(errandFunding()?.over_budget_amount || 0) }}
                      </span>
                    </div>
                  </div>

                  <div class="grid grid-cols-2 gap-2">
                    <app-button variant="secondary" size="sm" (onClick)="rejectOverBudget()">
                      Reject
                    </app-button>

                    <app-button variant="primary" size="sm" (onClick)="approveOverBudget()">
                      Approve
                    </app-button>
                  </div>
                </div>
              }

              <div class="p-4 bg-white rounded-[2rem] border border-slate-100 shadow-sm">
                <div class="flex items-center gap-4">
                  <div class="w-14 h-14 rounded-2xl overflow-hidden border-2 border-white shadow-md shrink-0">
                    <img src="https://picsum.photos/seed/driver/200" alt="Driver profile" class="w-full h-full object-cover" />
                  </div>

                  <div class="flex-1 min-w-0">
                    <h3 class="text-base font-bold text-slate-900 truncate">
                      {{ booking()?.driver?.first_name || 'Driver' }} {{ booking()?.driver?.last_name || '' }}
                    </h3>
                    <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">
                      {{ getDriverStatusText() }}
                    </p>
                  </div>

                  @if (booking()?.driver?.phone) {
                    <div class="flex gap-2 shrink-0">
                      <app-button variant="secondary" size="sm" [fullWidth]="false" class="h-11 w-11 rounded-xl" (onClick)="callDriver()">
                        <ion-icon name="call" slot="icon-only" class="text-lg"></ion-icon>
                      </app-button>
                    </div>
                  }
                </div>
              </div>

              @if (['accepted', 'arrived', 'in_progress', 'heading_to_pickup', 'en_route_to_customer'].includes(booking()?.status || '')) {
                <div class="pt-2">
                  <app-button
                    [variant]="showChat() ? 'outline' : 'secondary'"
                    (onClick)="showChat.set(!showChat())"
                    class="w-full"
                  >
                    <ion-icon [name]="showChat() ? 'chevron-down' : 'chatbubbles'" class="mr-2 text-xl"></ion-icon>
                    {{ showChat() ? 'Hide Chat' : 'Message Driver' }}
                  </app-button>

                  @if (showChat()) {
                    <div class="mt-6 h-[500px] border border-slate-100 rounded-[2.5rem] overflow-hidden shadow-2xl shadow-slate-200/50">
                      <app-communication-panel
                        [jobId]="booking()!.id"
                        [receiverId]="booking()!.driver_id!"
                        [receiverPhone]="booking()?.driver?.phone"
                      ></app-communication-panel>
                    </div>
                  }
                </div>
              }
            }

            <div class="p-5 bg-slate-50 rounded-[2rem] border border-slate-100">
              <div class="flex items-center gap-2 mb-5">
                <div class="w-10 h-10 rounded-xl bg-white border border-slate-100 flex items-center justify-center text-slate-700 shadow-sm">
                  <ion-icon name="navigate" class="text-xl"></ion-icon>
                </div>
                <div>
                  <h3 class="text-base font-display font-bold text-slate-900">Trip Route</h3>
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Live journey details</p>
                </div>
              </div>

              <div class="relative pl-10 space-y-10">
                <div class="absolute left-[13px] top-2 bottom-2 w-0.5 bg-slate-200"></div>

                <div class="relative">
                  <div class="absolute -left-[31px] top-1 w-5 h-5 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Pickup Location</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-snug">
                      {{ booking()?.pickup_address }}
                    </h3>
                  </div>
                </div>

                <div class="relative">
                  <div class="absolute -left-[31px] top-1 w-5 h-5 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Destination</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-snug">
                      {{ booking()?.dropoff_address }}
                    </h3>
                  </div>
                </div>
              </div>
            </div>

            @if (details()) {
              <div class="pt-2">
                <div class="flex items-center gap-2 mb-4">
                  <div class="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-700 shadow-sm">
                    <ion-icon name="sparkles-outline" class="text-xl"></ion-icon>
                  </div>
                  <div>
                    <h3 class="text-base font-display font-bold text-slate-900">Service Details</h3>
                    <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Extra information</p>
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-4">
                  @if (booking()?.service_slug === ServiceTypeEnum.RIDE) {
                    <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Passengers</p>
                      <p class="text-xl font-display font-bold text-slate-900">
                        {{ details()?.['passenger_count'] || 1 }}
                      </p>
                    </div>
                  }

                  @if (booking()?.service_slug === ServiceTypeEnum.VAN) {
                    <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Helpers</p>
                      <p class="text-xl font-display font-bold text-slate-900">
                        {{ details()?.['helper_count'] || 0 }}
                      </p>
                    </div>
                  }
                </div>

                @if (booking()?.service_slug === ServiceTypeEnum.ERRAND) {
                  <div class="p-4 bg-slate-50 rounded-[2rem] border border-slate-100 mt-4">
                    <div class="flex justify-between items-center mb-4 gap-3">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Items Requested</p>

                      @if (details()?.['actual_spending']) {
                        <app-badge variant="success">
                          {{ config.formatCurrency($any(details()?.['actual_spending']) || 0) }} Spent
                        </app-badge>
                      }
                    </div>

                    <div class="flex flex-wrap gap-2">
                      @for (item of ($any(details()?.['items_list']) || []); track item) {
                        <app-badge variant="primary">{{ item }}</app-badge>
                      }
                    </div>

                    <div class="mt-6 pt-6 border-t border-slate-200/50 space-y-4">
                      <div class="flex justify-between items-center">
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Initial Budget</span>
                        <span class="text-xl font-display font-bold text-emerald-600">
                          {{ config.formatCurrency($any(details()?.['estimated_budget']) || 0) }}
                        </span>
                      </div>

                      @if (details()?.['receipt_url']) {
                        <app-button variant="secondary" size="sm" class="w-full" (onClick)="viewReceipt(details()?.['receipt_url']?.toString())">
                          <ion-icon name="receipt-outline" slot="start" class="mr-2"></ion-icon>
                          View Receipt
                        </app-button>
                      }
                    </div>
                  </div>
                }
              </div>
            }

            <div class="pt-4 space-y-4">
              @if (booking()?.status === 'completed') {
                <app-button variant="primary" size="lg" (onClick)="showRating()" class="w-full">
                  <ion-icon name="checkmark-circle-outline" slot="start" class="mr-2"></ion-icon>
                  Rate Experience
                </app-button>
              } @else if (canManuallyCancel()) {
                <app-button variant="outline" color="error" size="lg" (onClick)="cancelBooking()" class="w-full">
                  <ion-icon name="close-circle-outline" slot="start" class="mr-2"></ion-icon>
                  Cancel Booking
                </app-button>
              }
            </div>
          </div>
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-full p-10 text-center space-y-8">
          @if (isLoading()) {
            <div class="w-20 h-20 bg-white rounded-[2rem] flex items-center justify-center shadow-2xl shadow-slate-200/50 border border-slate-100">
              <ion-spinner name="crescent" color="primary"></ion-spinner>
            </div>
            <div class="space-y-2">
              <h3 class="text-xl font-display font-bold text-slate-900">Loading details</h3>
              <p class="text-slate-500 font-medium">Retrieving your journey information...</p>
            </div>
          } @else {
            <div class="w-24 h-24 bg-red-50 rounded-[2.5rem] flex items-center justify-center text-red-500 border border-red-100 mb-4">
              <ion-icon name="alert-circle-outline" class="text-5xl"></ion-icon>
            </div>
            <div class="space-y-3">
              <h3 class="text-2xl font-display font-bold text-slate-900">Booking Not Found</h3>
              <p class="text-slate-500 font-medium max-w-xs mx-auto leading-relaxed">
                We couldn't find this booking. It may have been completed or cancelled.
              </p>
            </div>
            <app-button variant="secondary" size="lg" (onClick)="router.navigate(['/customer'])" class="w-full">
              Back to Home
            </app-button>
          }
        </div>
      }
    </ion-content>
  `
})
export class BookingTrackingPage implements OnInit, OnDestroy {
    @ViewChild('map') mapComponent?: MapComponent;

    private route = inject(ActivatedRoute);
    public router = inject(Router);

    private bookingService = inject(BookingService);
    private supabase = inject(SupabaseService);
    private alertCtrl = inject(AlertController);
    private routing = inject(RoutingService);
    private locationService = inject(LocationService);
    private walletService = inject(WalletService);

    private localSearchFallbackExpiresAt: number | null = null;

    public config = inject(AppConfigService);

    ServiceTypeEnum = ServiceTypeEnum;

    booking = this.bookingService.activeBooking;

    details = signal<Record<string, any> | null>(null);
    errandFunding = signal<ErrandFunding | null>(null);

    isLoading = signal(true);
    showChat = signal(false);

    searchCountdownSeconds = signal(DRIVER_SEARCH_WINDOW_SECONDS);

    searchProgressPercent = computed(() => {
        const val = Math.max(0, Math.min(DRIVER_SEARCH_WINDOW_SECONDS, this.searchCountdownSeconds()));
        return (val / DRIVER_SEARCH_WINDOW_SECONDS) * 100;
    });

    private channel?: RealtimeChannel;
    private locationSubscription?: RealtimeChannel;

    private pollingInterval?: ReturnType<typeof setInterval>;
    private countdownInterval?: ReturnType<typeof setInterval>;

    constructor() {
        addIcons({
            chevronBackOutline,
            call,
            chevronDown,
            chatbubbles,
            alertCircleOutline,
            navigate,
            shieldCheckmark,
            informationCircle,
            receiptOutline,
            timeOutline,
            sparklesOutline,
            carSportOutline,
            refreshOutline,
            closeCircleOutline,
            timerOutline,
            checkmarkCircleOutline
        });
    }

    async ngOnInit(): Promise<void> {
        const id = this.route.snapshot.paramMap.get('id');

        if (!id) {
            this.isLoading.set(false);
            return;
        }

        this.channel = this.bookingService.subscribeToBooking(id);

        await this.loadBookingAndDetails(id, true);
        this.startPolling(id);
    }

    ngOnDestroy(): void {
        this.resetSearchState();

        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = undefined;
        }

        this.channel?.unsubscribe();
        this.locationSubscription?.unsubscribe();
    }

    getStatusVariant(
        status: string
    ): 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' {
        switch (status) {
            case 'searching':
            case 'no_driver_found':
                return 'warning';
            case 'accepted':
            case 'arrived':
            case 'in_progress':
            case 'heading_to_pickup':
            case 'en_route_to_customer':
                return 'primary';
            case 'completed':
            case 'settled':
                return 'success';
            case 'cancelled':
            case 'canceled':
                return 'error';
            default:
                return 'secondary';
        }
    }

    getStatusLabel(status: string): string {
        const map: Record<string, string> = {
            searching: 'Searching for driver',
            accepted: 'Driver assigned',
            assigned: 'Driver assigned',
            heading_to_pickup: 'Heading to pickup',
            arrived: 'Driver arrived',
            in_progress: 'Trip in progress',
            arrived_at_store: 'Driver at store',
            shopping_in_progress: 'Shopping in progress',
            collected: 'Items collected',
            en_route_to_customer: 'On the way',
            delivered: 'Delivered',
            completed: 'Completed',
            settled: 'Settled',
            cancelled: 'Cancelled',
            canceled: 'Cancelled',
            no_driver_found: 'No driver found'
        };

        return map[status] ?? status.replace(/_/g, ' ');
    }

    getStatusHint(status: string): string {
        const map: Record<string, string> = {
            searching: 'Matching nearby drivers',
            accepted: 'Driver is coming',
            assigned: 'Driver is coming',
            heading_to_pickup: 'Driver is on the way',
            arrived: 'Driver reached pickup',
            in_progress: 'Journey in progress',
            arrived_at_store: 'Driver reached the store',
            shopping_in_progress: 'Driver is shopping',
            collected: 'Items have been collected',
            en_route_to_customer: 'Driver is on the way',
            delivered: 'Delivery completed',
            completed: 'Trip completed',
            settled: 'Payment settled',
            cancelled: 'Booking cancelled',
            canceled: 'Booking cancelled',
            no_driver_found: 'No available driver'
        };

        return map[status] ?? 'Live updates available';
    }

    getDriverStatusText(): string {
        return this.getStatusHint(this.booking()?.status || '');
    }

    canManuallyCancel(): boolean {
        const status = this.booking()?.status || '';

        return ![
            'cancelled',
            'canceled',
            'completed',
            'settled',
            'no_driver_found'
        ].includes(status);
    }

    getDisplayedTotal(): string {
        const bookingTotal = Number(this.booking()?.total_price || 0);
        const reserve = Number(this.errandFunding()?.amount_reserved || 0);

        if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
            return this.config.formatCurrency(bookingTotal + reserve);
        }

        return this.config.formatCurrency(bookingTotal);
    }

    searchCountdownLabel(): string {
        const total = Math.max(0, this.searchCountdownSeconds());
        const mins = Math.floor(total / 60);
        const secs = total % 60;

        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    private startSearchCountdown(): void {
        this.stopSearchCountdown();
        this.updateSearchCountdownFromBooking();

        this.countdownInterval = setInterval(() => {
            this.updateSearchCountdownFromBooking();
        }, 1000);
    }

  

    private updateSearchCountdownFromBooking(): void {
        const b: any = this.booking();

        if (!b || b.status !== 'searching') {
            this.localSearchFallbackExpiresAt = null;
            this.searchCountdownSeconds.set(DRIVER_SEARCH_WINDOW_SECONDS);
            return;
        }

        let expiresAt: number | null = null;

        if (b.driver_search_expires_at) {
            const parsed = new Date(b.driver_search_expires_at).getTime();

            if (Number.isFinite(parsed)) {
                expiresAt = parsed;
                this.localSearchFallbackExpiresAt = parsed;
            }
        }

        if (!expiresAt) {
            if (!this.localSearchFallbackExpiresAt) {
                this.localSearchFallbackExpiresAt = Date.now() + DRIVER_SEARCH_WINDOW_SECONDS * 1000;
            }

            expiresAt = this.localSearchFallbackExpiresAt;
        }

        const remain = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));

        this.searchCountdownSeconds.set(
            Math.min(DRIVER_SEARCH_WINDOW_SECONDS, remain)
        );

        if (remain <= 0) {
            this.stopSearchCountdown();
        }
    }

    private stopSearchCountdown(): void {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = undefined;
        }
    }

    private resetSearchState(): void {
        this.stopSearchCountdown();
        this.searchCountdownSeconds.set(DRIVER_SEARCH_WINDOW_SECONDS);
        this.mapComponent?.showSearchingOverlay?.set(false);
    }

    private syncSearchUiState(): void {
        const b = this.booking();

        if (b?.status === 'searching') {
            this.mapComponent?.showSearchingOverlay?.set(true);

            if (!this.countdownInterval) {
                this.startSearchCountdown();
            } else {
                this.updateSearchCountdownFromBooking();
            }

            return;
        }

        this.resetSearchState();
    }

    private startPolling(id: string): void {
        this.pollingInterval = setInterval(() => {
            void this.loadBookingAndDetails(id, false);
        }, 5000);
    }

    async loadBookingAndDetails(id: string, showLoading = true): Promise<void> {
        if (showLoading) this.isLoading.set(true);

        try {
            const b = await this.bookingService.getBooking(id);

            if (!b) {
                this.isLoading.set(false);
                return;
            }

            this.bookingService.activeBooking.set(b);
            this.syncSearchUiState();

            const bookingDetails = await this.bookingService.getBookingDetails(
                b.id,
                b.service_slug as ServiceTypeEnum
            );

            this.details.set(bookingDetails || null);

            if (b.service_slug === ServiceTypeEnum.ERRAND) {
                const funding = await this.bookingService.getErrandFunding(b.id);
                this.errandFunding.set(funding);
            } else {
                this.errandFunding.set(null);
            }

            this.initMap();

            if (b.driver_id) {
                this.subscribeToDriverLocation(b.driver_id);
            } else {
                this.locationSubscription?.unsubscribe();
                this.locationSubscription = undefined;
            }
        } catch (err) {
            console.error('Load booking failed', err);
        } finally {
            this.isLoading.set(false);
        }
    }

    private initMap(): void {
        const b = this.booking();

        if (!b || !this.mapComponent) return;

        const pickupLat = Number(b.pickup_lat);
        const pickupLng = Number(b.pickup_lng);

        const dropLat = Number(b.dropoff_lat);
        const dropLng = Number(b.dropoff_lng);

        if (!this.isValidCoordinate(pickupLat) || !this.isValidCoordinate(pickupLng)) {
            return;
        }

        setTimeout(() => {
            this.mapComponent?.addOrUpdateMarker({
                id: 'pickup',
                coordinates: { lat: pickupLat, lng: pickupLng },
                kind: 'pickup',
                serviceType: b.service_slug as ServiceTypeSlug,
                label: 'PICKUP'
            });

            if (this.isValidCoordinate(dropLat) && this.isValidCoordinate(dropLng)) {
                this.mapComponent?.addOrUpdateMarker({
                    id: 'dropoff',
                    coordinates: { lat: dropLat, lng: dropLng },
                    kind: 'destination',
                    serviceType: b.service_slug as ServiceTypeSlug,
                    label: 'DROPOFF'
                });

                this.routing
                    .getRoute(
                        { lat: pickupLat, lng: pickupLng },
                        { lat: dropLat, lng: dropLng }
                    )
                    .subscribe({
                        next: (route: any) => {
                            if (route) {
                                this.mapComponent?.drawRoute(route);
                            }
                        },
                        error: (error) => console.warn('Route draw failed:', error)
                    });
            }

            this.mapComponent?.setCenter(pickupLng, pickupLat, 14);
        }, 300);
    }

    private subscribeToDriverLocation(driverId: string): void {
        this.locationSubscription?.unsubscribe();

        this.locationSubscription = this.locationService.subscribeToDriverLocation(
            driverId,
            (location: DriverLocation) => {
                this.updateDriverMarker(location);
            }
        );
    }

    private updateDriverMarker(location: DriverLocation): void {
        const b = this.booking();

        if (!b || !this.mapComponent) return;

        const lat = Number(location.lat);
        const lng = Number(location.lng);

        if (!this.isValidCoordinate(lat) || !this.isValidCoordinate(lng)) return;

        this.mapComponent.addOrUpdateMarker({
            id: 'driver',
            coordinates: { lat, lng },
            kind: 'driver',
            serviceType: b.service_slug as ServiceTypeSlug,
            heading: Number(location.heading || 0)
        });
    }

    async cancelBooking(): Promise<void> {
        const b = this.booking();
        if (!b) return;

        const alert = await this.alertCtrl.create({
            header: 'Cancel Booking',
            message: 'Are you sure you want to cancel this booking?',
            inputs: [
                {
                    name: 'reason',
                    type: 'text',
                    placeholder: 'Reason'
                }
            ],
            buttons: [
                {
                    text: 'No',
                    role: 'cancel'
                },
                {
                    text: 'Yes, Cancel',
                    role: 'destructive',
                    handler: async (data) => {
                        await this.bookingService.cancelBooking(
                            b.id,
                            data?.reason || 'Customer cancelled'
                        );

                        await this.router.navigate(['/customer']);
                    }
                }
            ]
        });

        await alert.present();
    }

    async showRating(): Promise<void> {
        const b = this.booking();
        if (!b) return;

        const alert = await this.alertCtrl.create({
            header: 'Rate Trip',
            inputs: [
                {
                    name: 'score',
                    type: 'number',
                    placeholder: '1-5',
                    min: 1,
                    max: 5
                },
                {
                    name: 'comment',
                    type: 'textarea',
                    placeholder: 'Comment'
                }
            ],
            buttons: [
                {
                    text: 'Skip',
                    role: 'cancel',
                    handler: () => this.router.navigate(['/customer'])
                },
                {
                    text: 'Submit',
                    handler: async (data) => {
                        await this.bookingService.rateBooking(
                            b.id,
                            Number(data.score || 5),
                            data.comment || ''
                        );

                        await this.router.navigate(['/customer']);
                    }
                }
            ]
        });

        await alert.present();
    }

    callDriver(): void {
        const phone = this.booking()?.driver?.phone;

        if (phone) {
            window.open(`tel:${phone}`, '_system');
        }
    }

    async approveOverBudget(): Promise<void> {
        const b = this.booking();
        if (!b) return;

        await this.walletService.approveErrandOverBudget(b.id);
        await this.loadBookingAndDetails(b.id, false);
    }

    async rejectOverBudget(): Promise<void> {
        const b = this.booking();
        if (!b) return;

        await this.walletService.rejectErrandOverBudget(b.id);
        await this.loadBookingAndDetails(b.id, false);
    }

    viewReceipt(path?: string | null): void {
        if (!path) return;

        const { data } = this.supabase.storage
            .from('documents')
            .getPublicUrl(path);

        if (data?.publicUrl) {
            window.open(data.publicUrl, '_blank');
        }
    }

    private isValidCoordinate(value: number): boolean {
        return Number.isFinite(value) && !Number.isNaN(value);
    }
}