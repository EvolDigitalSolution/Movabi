import { Component, inject, OnInit, OnDestroy, signal, ViewChild, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, AlertController } from '@ionic/angular';
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
import { ActivatedRoute, Router } from '@angular/router';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { ServiceTypeEnum, DriverLocation, ErrandFunding } from '../../../../../shared/models/booking.model';
import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../../shared/ui';
import { CommunicationPanelComponent } from '../../../../../shared/ui/communication-panel';
import { RealtimeChannel } from '@supabase/supabase-js';
import { MapComponent } from '../../../../../shared/components/map/map.component';
import { RoutingService } from '../../../../../core/services/maps/routing.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';
import { WalletService } from '../../../../../core/services/wallet/wallet.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';

@Component({
    selector: 'app-booking-tracking',
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
          <!-- Map Area -->
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
                        [style.width.%]="searchProgressPercent()">
                      </div>
                    </div>
                  </div>

                  <div class="space-y-2 text-left">
                    <div class="flex items-start gap-3 text-slate-600">
                      <div class="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                        <ion-icon name="sparkles-outline" class="text-lg"></ion-icon>
                      </div>
                      <p class="text-xs font-semibold leading-relaxed">
                        We’re checking nearby drivers in real time.
                      </p>
                    </div>

                    <div class="flex items-start gap-3 text-slate-600">
                      <div class="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                        <ion-icon name="shield-checkmark" class="text-lg"></ion-icon>
                      </div>
                      <p class="text-xs font-semibold leading-relaxed">
                        If no driver is found in time, we’ll automatically cancel this booking.
                      </p>
                    </div>

                    <div class="flex items-start gap-3 text-slate-600">
                      <div class="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                        <ion-icon name="information-circle" class="text-lg"></ion-icon>
                      </div>
                      <p class="text-xs font-semibold leading-relaxed">
                        Any payment or reserved errand funds will follow your existing cancellation/refund flow.
                      </p>
                    </div>
                  </div>

                  @if (autoCancelling()) {
                    <div class="mt-5 p-3 rounded-2xl bg-rose-50 border border-rose-100">
                      <p class="text-xs font-bold text-rose-700 uppercase tracking-widest">
                        Cancelling booking…
                      </p>
                    </div>
                  }
                </div>
              </div>
            }
          </div>

          <!-- Info Sheet -->
          <div class="bg-white rounded-t-[2.5rem] shadow-2xl p-6 space-y-6 -mt-10 relative z-10 max-h-[72%] overflow-y-auto custom-scrollbar border-t border-slate-100">
            <div class="w-12 h-1 bg-slate-100 rounded-full mx-auto"></div>

            <!-- Hero Summary -->
            <div class="p-5 rounded-[2rem] border border-slate-100 bg-gradient-to-br from-white to-slate-50 shadow-sm">
              <div class="flex justify-between items-start gap-4">
                <div class="min-w-0">
                  <app-badge [variant]="getStatusVariant(booking()?.status || '')" class="mb-3">
                    {{ getStatusLabel(booking()?.status || '') }}
                  </app-badge>

                  <h2 class="text-2xl font-display font-bold text-slate-900 tracking-tight">Booking Details</h2>
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
                    <p class="text-lg font-display font-bold text-slate-900">{{ searchCountdownLabel() }}</p>
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
                  <p class="text-lg font-display font-bold text-slate-900">{{ config.formatCurrency(booking()?.total_price || 0) }}</p>
                </div>
                <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Item Budget</p>
                  <p class="text-lg font-display font-bold text-slate-900">{{ config.formatCurrency(errandFunding()?.amount_reserved || 0) }}</p>
                </div>
              </div>
            }

            @if (booking()?.driver_id) {
              @if (errandFunding()?.over_budget_status === 'requested') {
                <div class="p-6 bg-rose-50 rounded-[2rem] border border-rose-100 animate-in slide-in-from-top-4">
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
                      <span class="text-base font-display font-bold text-slate-900">{{ config.formatCurrency(errandFunding()?.amount_reserved || 0) }}</span>
                    </div>
                    <div class="flex justify-between items-center p-3 bg-rose-100/50 rounded-xl border border-rose-200">
                      <span class="text-[10px] font-bold text-rose-600 uppercase tracking-widest">New Required</span>
                      <span class="text-base font-display font-bold text-rose-700">{{ config.formatCurrency(errandFunding()?.over_budget_amount || 0) }}</span>
                    </div>
                  </div>

                  <div class="grid grid-cols-2 gap-2">
                    <app-button variant="secondary" size="sm" (onClick)="rejectOverBudget()" class="border-rose-200 text-rose-700">
                      Reject
                    </app-button>
                    <app-button variant="primary" size="sm" (onClick)="approveOverBudget()" class="bg-rose-600 border-rose-600 shadow-lg shadow-rose-200">
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
                      {{ booking()?.driver?.first_name }} {{ booking()?.driver?.last_name }}
                    </h3>
                    <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">
                      {{ getDriverStatusText() }}
                    </p>
                  </div>

                  <div class="flex gap-2 shrink-0">
                    <app-button variant="secondary" size="sm" [fullWidth]="false" class="h-11 w-11 rounded-xl" (onClick)="callDriver()">
                      <ion-icon name="call" slot="icon-only" class="text-lg"></ion-icon>
                    </app-button>
                  </div>
                </div>
              </div>

              @if (['accepted', 'arrived', 'in_progress', 'heading_to_pickup', 'en_route_to_customer'].includes(booking()?.status || '')) {
                <div class="pt-2">
                  <app-button [variant]="showChat() ? 'outline' : 'secondary'" (onClick)="showChat.set(!showChat())" class="w-full">
                    <ion-icon [name]="showChat() ? 'chevron-down' : 'chatbubbles'" class="mr-2 text-xl"></ion-icon>
                    {{ showChat() ? 'Hide Chat' : 'Message Driver' }}
                  </app-button>

                  @if (showChat()) {
                    <div class="mt-6 h-[500px] border border-slate-100 rounded-[2.5rem] overflow-hidden shadow-2xl shadow-slate-200/50 animate-in slide-in-from-top-4 duration-500">
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

            <!-- Route Details -->
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
                    <h3 class="text-sm font-bold text-slate-900 leading-snug">{{ booking()?.pickup_address }}</h3>
                  </div>
                </div>

                <div class="relative">
                  <div class="absolute -left-[31px] top-1 w-5 h-5 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Destination</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-snug">{{ booking()?.dropoff_address }}</h3>
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
                      <p class="text-xl font-display font-bold text-slate-900">{{ details()?.['passenger_count'] }}</p>
                    </div>
                  }

                  @if (booking()?.service_slug === ServiceTypeEnum.VAN) {
                    <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Helpers</p>
                      <p class="text-xl font-display font-bold text-slate-900">{{ details()?.['helper_count'] }}</p>
                    </div>
                  }
                </div>

                @if (booking()?.service_slug === ServiceTypeEnum.ERRAND) {
                  <div class="p-4 bg-slate-50 rounded-[2rem] border border-slate-100 mt-4">
                    <div class="flex justify-between items-center mb-4 gap-3">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Items Requested</p>
                      @if (details()?.['actual_spending']) {
                        <app-badge variant="success" class="bg-emerald-100 text-emerald-700 border-emerald-200">
                          {{ config.formatCurrency($any(details()?.['actual_spending']) || 0) }} Spent
                        </app-badge>
                      }
                    </div>

                    <div class="flex flex-wrap gap-2">
                      @for (item of (details()?.['items_list'] || []); track item) {
                        <app-badge variant="primary" class="bg-white border-slate-100 text-slate-600">{{ item }}</app-badge>
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
                        <div class="pt-2">
                          <app-button variant="secondary" size="sm" class="w-full" (onClick)="viewReceipt(details()?.['receipt_url']?.toString())">
                            <ion-icon name="receipt-outline" slot="start" class="mr-2"></ion-icon>
                            View Receipt
                          </app-button>
                        </div>
                      }
                    </div>
                  </div>
                }
              </div>
            }

            <div class="pt-4 space-y-4">
              @if (booking()?.status === 'completed') {
                <app-button variant="primary" size="lg" (click)="showRating()" class="w-full">
                  <ion-icon name="checkmark-circle-outline" slot="start" class="mr-2"></ion-icon>
                  Rate Experience
                </app-button>
              } @else if (canManuallyCancel()) {
                <app-button variant="outline" color="error" size="lg" (click)="cancelBooking()" class="w-full">
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
                We couldn't find this booking. It might have been completed or cancelled.
              </p>
            </div>
            <app-button variant="secondary" size="lg" (click)="router.navigate(['/customer'])" class="w-full">
              Back to Home
            </app-button>
          }
        </div>
      }
    </ion-content>
  `,
    standalone: true,
    imports: [
        IonicModule,
        CommonModule,
        CardComponent,
        ButtonComponent,
        BadgeComponent,
        CommunicationPanelComponent,
        MapComponent
    ]
})
export class BookingTrackingPage implements OnInit, OnDestroy {
    @ViewChild('map') mapComponent!: MapComponent;

    private route = inject(ActivatedRoute);
    private bookingService = inject(BookingService);
    private supabase = inject(SupabaseService);
    private alertCtrl = inject(AlertController);
    private routing = inject(RoutingService);
    private locationService = inject(LocationService);
    private walletService = inject(WalletService);
    public config = inject(AppConfigService);
    public router = inject(Router);

    ServiceTypeEnum = ServiceTypeEnum;
    booking = this.bookingService.activeBooking;
    details = signal<Record<string, string | number | boolean | string[] | null | undefined> | null>(null);
    errandFunding = signal<ErrandFunding | null>(null);
    isLoading = signal(true);
    showChat = signal(false);
    autoCancelling = signal(false);
    searchCountdownSeconds = signal(90);

    searchProgressPercent = computed(() => {
        const value = Math.max(0, Math.min(90, this.searchCountdownSeconds()));
        return (value / 90) * 100;
    });

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

    private channel?: RealtimeChannel;
    private locationSubscription?: RealtimeChannel;
    private searchTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    private pollingInterval: ReturnType<typeof setInterval> | null = null;
    private countdownInterval: ReturnType<typeof setInterval> | null = null;
    private searchStartedAt: number | null = null;

    getStatusVariant(status: string): 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' {
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
                return 'error';
            default:
                return 'secondary';
        }
    }

    getStatusLabel(status: string): string {
        switch (status) {
            case 'searching': return 'Searching for driver';
            case 'accepted': return 'Driver assigned';
            case 'heading_to_pickup': return 'Driver heading to pickup';
            case 'arrived': return 'Driver arrived';
            case 'in_progress': return 'Trip in progress';
            case 'arrived_at_store': return 'Driver at store';
            case 'shopping_in_progress': return 'Shopping in progress';
            case 'collected': return 'Items collected';
            case 'en_route_to_customer': return 'En route to you';
            case 'delivered': return 'Delivered';
            case 'completed': return 'Completed';
            case 'settled': return 'Settled';
            case 'cancelled': return 'Cancelled';
            case 'no_driver_found': return 'No driver found';
            default: return status.replace(/_/g, ' ');
        }
    }

    getStatusHint(status: string): string {
        switch (status) {
            case 'searching':
                return 'We are actively matching your request';
            case 'accepted':
            case 'heading_to_pickup':
                return 'Your driver is on the way';
            case 'arrived':
                return 'Driver has reached pickup point';
            case 'in_progress':
            case 'shopping_in_progress':
                return 'Your service is currently ongoing';
            case 'completed':
            case 'delivered':
                return 'Everything has been completed successfully';
            case 'cancelled':
                return 'This booking was cancelled';
            case 'no_driver_found':
                return 'No driver was available in time';
            default:
                return 'Live updates will appear here';
        }
    }

    getDriverStatusText(): string {
        const status = this.booking()?.status || '';
        switch (status) {
            case 'accepted': return 'Driver assigned to your booking';
            case 'heading_to_pickup': return 'Heading to pickup location';
            case 'arrived': return 'Driver has arrived';
            case 'arrived_at_store': return 'Driver is at the store';
            case 'shopping_in_progress': return 'Driver is shopping for your items';
            case 'collected': return 'Items collected';
            case 'en_route_to_customer': return 'On the way to your destination';
            case 'in_progress': return 'Trip in progress';
            default: return 'Connected to your booking';
        }
    }

    getDisplayedTotal(): string {
        const bookingTotal = this.booking()?.total_price || 0;
        const reserved = this.errandFunding()?.amount_reserved || 0;

        if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
            return this.config.formatCurrency(bookingTotal + reserved);
        }

        return this.config.formatCurrency(bookingTotal);
    }

    searchCountdownLabel(): string {
        const total = Math.max(0, this.searchCountdownSeconds());
        const mins = Math.floor(total / 60);
        const secs = total % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    canManuallyCancel(): boolean {
        const status = this.booking()?.status || '';
        return !['cancelled', 'completed', 'settled', 'no_driver_found'].includes(status);
    }

    ngOnInit() {
        const id = this.route.snapshot.params['id'];
        if (id) {
            this.channel = this.bookingService.subscribeToBooking(id);
            this.loadBookingAndDetails(id);
            this.startPolling(id);
        }
    }

    private startPolling(id: string) {
        this.pollingInterval = setInterval(() => {
            this.loadBookingAndDetails(id, false);
        }, 5000);
    }

    private stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    private startSearchCountdown() {
        if (this.searchStartedAt === null) {
            this.searchStartedAt = Date.now();
        }

        this.stopSearchCountdown();

        this.countdownInterval = setInterval(() => {
            if (this.searchStartedAt === null) return;

            const elapsed = Math.floor((Date.now() - this.searchStartedAt) / 1000);
            const remaining = Math.max(0, 90 - elapsed);
            this.searchCountdownSeconds.set(remaining);

            if (remaining <= 0) {
                this.stopSearchCountdown();
            }
        }, 1000);
    }

    private stopSearchCountdown() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }
    }

    private resetSearchState() {
        if (this.searchTimeoutHandle) {
            clearTimeout(this.searchTimeoutHandle);
            this.searchTimeoutHandle = null;
        }

        this.stopSearchCountdown();
        this.searchStartedAt = null;
        this.searchCountdownSeconds.set(90);
        this.autoCancelling.set(false);
    }

    private checkSearchTimeout() {
        const b = this.booking();

        if (b?.status === 'searching') {
            this.mapComponent?.showSearchingOverlay.set(true);

            if (!this.searchTimeoutHandle) {
                this.searchStartedAt = Date.now();
                this.searchCountdownSeconds.set(90);
                this.startSearchCountdown();

                this.searchTimeoutHandle = setTimeout(() => {
                    void this.handleNoDriverFound();
                }, 90000);
            }
        } else {
            this.mapComponent?.showSearchingOverlay.set(false);
            this.resetSearchState();
        }
    }

    private async handleNoDriverFound() {
        const b = this.booking();
        if (!b || b.status !== 'searching' || this.autoCancelling()) return;

        this.autoCancelling.set(true);
        this.stopPolling();
        this.channel?.unsubscribe();
        this.locationSubscription?.unsubscribe();

        try {
            // Use cancelBooking so existing server-side cancellation flow can
            // handle refunds / wallet release / payment cancellation if implemented there.
            await this.bookingService.cancelBooking(
                b.id,
                'Auto-cancelled because no driver was found within the search window'
            );

            const alert = await this.alertCtrl.create({
                header: 'No Driver Found',
                message: 'We could not find an available driver in time, so this booking has been automatically cancelled.',
                buttons: [
                    {
                        text: 'OK',
                        handler: () => this.router.navigate(['/customer'])
                    }
                ]
            });
            await alert.present();
        } catch (e) {
            console.error('Failed to auto-cancel after no driver found', e);

            const alert = await this.alertCtrl.create({
                header: 'Search Timed Out',
                message: 'We could not find a driver, but automatic cancellation did not complete. Please try cancelling manually.',
                buttons: ['OK']
            });
            await alert.present();
        } finally {
            this.resetSearchState();
        }
    }

    ngOnDestroy() {
        this.resetSearchState();
        this.stopPolling();
        this.channel?.unsubscribe();
        this.locationSubscription?.unsubscribe();
    }

    async loadBookingAndDetails(id: string, showLoading = true) {
        if (showLoading) this.isLoading.set(true);

        try {
            const b = await this.bookingService.getBooking(id);
            this.bookingService.activeBooking.set(b);

            this.checkSearchTimeout();

            const details = await this.bookingService.getBookingDetails(
                b.id,
                b.service_slug as ServiceTypeEnum
            );
            this.details.set(details as Record<string, string | number | boolean | string[] | null | undefined>);

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
            }
        } catch (e) {
            console.error('Failed to load booking or details', e);
        } finally {
            this.isLoading.set(false);
        }
    }

    initMap() {
        const b = this.booking();
        if (!b) return;

        const pickup = { lat: b.pickup_lat, lng: b.pickup_lng };
        const dropoff = { lat: b.dropoff_lat || 0, lng: b.dropoff_lng || 0 };

        if (isNaN(pickup.lat) || isNaN(pickup.lng)) {
            console.warn('[BookingTracking] Invalid pickup coordinates', pickup);
            return;
        }

        setTimeout(() => {
            if (!this.mapComponent) return;

            this.mapComponent.addOrUpdateMarker({
                id: 'pickup',
                coordinates: pickup,
                kind: 'pickup',
                serviceType: b.service_slug as ServiceTypeSlug,
                label: 'PICKUP'
            });

            if (b.dropoff_lat && !isNaN(b.dropoff_lat) && !isNaN(b.dropoff_lng || 0)) {
                this.mapComponent.addOrUpdateMarker({
                    id: 'dropoff',
                    coordinates: dropoff,
                    kind: 'destination',
                    serviceType: b.service_slug as ServiceTypeSlug,
                    label: 'DROPOFF'
                });

                this.routing.getRoute(pickup, dropoff).subscribe(route => {
                    if (route) this.mapComponent.drawRoute(route);
                });
            }

            this.mapComponent.setCenter(pickup.lng, pickup.lat, 14);
        }, 500);
    }

    subscribeToDriverLocation(driverId: string) {
        this.locationSubscription?.unsubscribe();
        this.locationSubscription = this.locationService.subscribeToDriverLocation(driverId, (location) => {
            this.updateDriverMarker(location);
        });
    }

    updateDriverMarker(location: DriverLocation) {
        if (!this.mapComponent) return;
        const b = this.booking();
        if (!b) return;

        this.mapComponent.addOrUpdateMarker({
            id: 'driver',
            coordinates: { lat: location.lat, lng: location.lng },
            kind: 'driver',
            serviceType: b.service_slug as ServiceTypeSlug,
            heading: location.heading
        });
    }

    async showRating() {
        const alert = await this.alertCtrl.create({
            header: 'Rate your Trip',
            message: 'How was your experience with Movabi?',
            inputs: [
                { name: 'score', type: 'number', placeholder: 'Score (1-5)', min: 1, max: 5 },
                { name: 'comment', type: 'textarea', placeholder: 'Optional comment' }
            ],
            buttons: [
                { text: 'Skip', role: 'cancel', handler: () => this.router.navigate(['/customer']) },
                {
                    text: 'Submit',
                    handler: async (data) => {
                        await this.bookingService.rateBooking(this.booking()!.id, data.score, data.comment);
                        this.router.navigate(['/customer']);
                    }
                }
            ]
        });
        await alert.present();
    }

    async cancelBooking() {
        const alert = await this.alertCtrl.create({
            header: 'Cancel Booking',
            message: 'Are you sure you want to cancel this booking?',
            inputs: [
                { name: 'reason', type: 'text', placeholder: 'Reason for cancellation' }
            ],
            buttons: [
                { text: 'No', role: 'cancel' },
                {
                    text: 'Yes, Cancel',
                    role: 'destructive',
                    handler: async (data) => {
                        try {
                            await this.bookingService.cancelBooking(this.booking()!.id, data.reason || 'No reason provided');
                            this.router.navigate(['/customer']);
                        } catch (e) {
                            const errorAlert = await this.alertCtrl.create({
                                header: 'Error',
                                message: (e as Error).message,
                                buttons: ['OK']
                            });
                            await errorAlert.present();
                        }
                    }
                }
            ]
        });
        await alert.present();
    }

    callDriver() {
        const phone = this.booking()?.driver?.phone;
        if (phone) {
            window.open(`tel:${phone}`, '_system');
        }
    }

    async approveOverBudget() {
        const b = this.booking();
        if (!b) return;

        const alert = await this.alertCtrl.create({
            header: 'Approve Budget Increase',
            message: `Are you sure you want to increase the budget to ${this.config.formatCurrency(this.errandFunding()?.over_budget_amount || 0)}? This will reserve additional funds from your wallet.`,
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Approve',
                    handler: async () => {
                        try {
                            await this.walletService.approveErrandOverBudget(b.id);
                            await this.loadBookingAndDetails(b.id);
                        } catch (e) {
                            const errorAlert = await this.alertCtrl.create({
                                header: 'Approval Failed',
                                message: (e as Error).message,
                                buttons: ['OK']
                            });
                            await errorAlert.present();
                        }
                    }
                }
            ]
        });
        await alert.present();
    }

    async rejectOverBudget() {
        const b = this.booking();
        if (!b) return;

        const alert = await this.alertCtrl.create({
            header: 'Reject Budget Increase',
            message: 'Are you sure you want to reject this request? The driver may not be able to complete the errand if funds are insufficient.',
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Reject',
                    role: 'destructive',
                    handler: async () => {
                        try {
                            await this.walletService.rejectErrandOverBudget(b.id);
                            await this.loadBookingAndDetails(b.id);
                        } catch (e) {
                            console.error('Rejection failed', e);
                        }
                    }
                }
            ]
        });
        await alert.present();
    }

    viewReceipt(path: string | null | undefined) {
        if (!path) return;
        const { data } = this.supabase.storage.from('documents').getPublicUrl(path);
        if (data?.publicUrl) {
            window.open(data.publicUrl, '_blank');
        }
    }
}