import { Component, inject, OnInit, OnDestroy, signal, ViewChild } from '@angular/core';
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
  informationCircle
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
      <ion-toolbar class="px-4">
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
              <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center p-8 z-20">
                <app-card class="max-w-xs w-full text-center">
                  <div class="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 mx-auto mb-6 border border-blue-100">
                    <ion-spinner name="crescent" color="primary"></ion-spinner>
                  </div>
                  <h2 class="text-xl font-display font-bold text-slate-900 mb-2 tracking-tight">Finding a Driver</h2>
                  <p class="text-sm text-slate-500 font-medium">Matching you with the nearest professional. Please wait.</p>
                </app-card>
              </div>
            }
          </div>

          <!-- Info Sheet -->
          <div class="bg-white rounded-t-[2.5rem] shadow-2xl p-6 space-y-6 -mt-10 relative z-10 max-h-[70%] overflow-y-auto custom-scrollbar border-t border-slate-100">
            <div class="w-12 h-1 bg-slate-100 rounded-full mx-auto mb-2"></div>

            <div class="flex justify-between items-start">
              <div>
                <app-badge [variant]="getStatusVariant(booking()?.status || '')" class="mb-2">{{ booking()?.status?.replace('_', ' ') }}</app-badge>
                <h2 class="text-2xl font-display font-bold text-slate-900 tracking-tight">Booking Details</h2>
                <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">ID: {{ booking()?.id?.slice(0,8) }}</p>
              </div>
              <div class="text-right">
                <p class="text-3xl font-display font-bold text-slate-900">
                  {{ config.formatCurrency((booking()?.total_price || 0) + (errandFunding()?.amount_reserved || 0)) }}
                </p>
                @if (booking()?.service_slug === ServiceTypeEnum.ERRAND) {
                  <p class="text-[9px] font-bold text-emerald-600 uppercase tracking-widest mt-0.5">Total Reserved</p>
                } @else {
                  <p class="text-[9px] font-bold text-emerald-600 uppercase tracking-widest mt-0.5">Fixed Price</p>
                }
              </div>
            </div>

            @if (booking()?.service_slug === ServiceTypeEnum.ERRAND && errandFunding()) {
              <div class="grid grid-cols-2 gap-3">
                <div class="p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Service Fee</p>
                  <p class="text-base font-display font-bold text-slate-900">{{ config.formatCurrency(booking()?.total_price || 0) }}</p>
                </div>
                <div class="p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Item Budget</p>
                  <p class="text-base font-display font-bold text-slate-900">{{ config.formatCurrency(errandFunding()?.amount_reserved || 0) }}</p>
                </div>
              </div>
            }

            @if (booking()?.driver_id) {
              <!-- Over Budget Request -->
              @if (errandFunding()?.over_budget_status === 'requested') {
                <div class="p-6 bg-rose-50 rounded-[2rem] border border-rose-100 animate-in slide-in-from-top-4">
                  <div class="flex items-center gap-3 mb-4">
                    <div class="w-10 h-10 rounded-xl bg-rose-500 flex items-center justify-center text-white shadow-lg shadow-rose-200">
                      <ion-icon name="alert-circle" class="text-xl"></ion-icon>
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

              <div class="flex items-center p-3 bg-slate-50 rounded-xl border border-slate-100 group transition-all hover:bg-white hover:shadow-lg hover:shadow-slate-200/50">
                <div class="w-12 h-12 rounded-xl overflow-hidden mr-4 border-2 border-white shadow-md">
                  <img src="https://picsum.photos/seed/driver/200" alt="Driver profile" class="w-full h-full object-cover" />
                </div>
                <div class="flex-1 min-w-0">
                  <h3 class="text-base font-bold text-slate-900 truncate">{{ booking()?.driver?.first_name }} {{ booking()?.driver?.last_name }}</h3>
                  <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">Arriving in 5 mins</p>
                </div>
                <div class="flex gap-2">
                  <app-button variant="secondary" size="sm" [fullWidth]="false" class="h-10 w-10 rounded-xl" (onClick)="callDriver()">
                    <ion-icon name="call" slot="icon-only" class="text-lg"></ion-icon>
                  </app-button>
                </div>
              </div>

              <!-- Communication Panel Integration -->
              @if (['accepted', 'arrived', 'in_progress'].includes(booking()?.status || '')) {
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

            <div class="space-y-8">
              <div class="relative pl-10 space-y-10">
                <!-- Vertical Line -->
                <div class="absolute left-[13px] top-2 bottom-2 w-0.5 bg-slate-100"></div>

                <!-- Pickup -->
                <div class="relative">
                  <div class="absolute -left-[31px] top-1 w-5 h-5 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Pickup Location</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-snug">{{ booking()?.pickup_address }}</h3>
                  </div>
                </div>

                <!-- Destination -->
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
              <div class="pt-10 border-t border-slate-50">
                <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-6">Service Details</h3>
                
                <div class="grid grid-cols-2 gap-5">
                  @if (booking()?.service_slug === ServiceTypeEnum.RIDE) {
                    <div class="p-4 bg-slate-50 rounded-xl border border-slate-100">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Passengers</p>
                      <p class="text-xl font-display font-bold text-slate-900">{{ details()?.['passenger_count'] }}</p>
                    </div>
                  }

                  @if (booking()?.service_slug === ServiceTypeEnum.VAN) {
                    <div class="p-4 bg-slate-50 rounded-xl border border-slate-100">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Helpers</p>
                      <p class="text-xl font-display font-bold text-slate-900">{{ details()?.['helper_count'] }}</p>
                    </div>
                  }
                </div>

                @if (booking()?.service_slug === ServiceTypeEnum.ERRAND) {
                  <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100 mt-4">
                    <div class="flex justify-between items-center mb-4">
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
                        <span class="text-xl font-display font-bold text-emerald-600">{{ config.formatCurrency($any(details()?.['estimated_budget']) || 0) }}</span>
                      </div>

                      @if (details()?.['receipt_url']) {
                        <div class="pt-4">
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

            <div class="pt-6 space-y-4">
              @if (booking()?.status === 'completed') {
                <app-button variant="primary" size="lg" (click)="showRating()" class="w-full">
                  Rate Experience
                </app-button>
              } @else if (booking()?.status !== 'cancelled') {
                <app-button variant="outline" color="error" size="lg" (click)="cancelBooking()" class="w-full">
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
              <p class="text-slate-500 font-medium max-w-xs mx-auto leading-relaxed">We couldn't find this booking. It might have been completed or cancelled.</p>
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
  imports: [IonicModule, CommonModule, CardComponent, ButtonComponent, BadgeComponent, CommunicationPanelComponent, MapComponent]
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

  constructor() {
    addIcons({ 
      chevronBackOutline, 
      call, 
      chevronDown, 
      chatbubbles, 
      alertCircleOutline,
      navigate,
      shieldCheckmark,
      informationCircle
    });
  }
  private channel?: RealtimeChannel;
  private locationSubscription?: RealtimeChannel;
  private searchTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  getStatusVariant(status: string): 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' {
    switch (status) {
      case 'searching': return 'warning';
      case 'accepted':
      case 'arrived':
      case 'in_progress': return 'primary';
      case 'completed':
      case 'settled': return 'success';
      case 'cancelled': return 'error';
      default: return 'secondary';
    }
  }

  ngOnInit() {
    const id = this.route.snapshot.params['id'];
    if (id) {
      this.channel = this.bookingService.subscribeToBooking(id);
      this.loadBookingAndDetails(id);
      
      // Start search timeout if status is searching
      this.checkSearchTimeout();

      // Polling fallback
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

  private checkSearchTimeout() {
    const b = this.booking();
    if (b?.status === 'searching') {
      this.mapComponent?.showSearchingOverlay.set(true);
      if (this.searchTimeoutHandle) clearTimeout(this.searchTimeoutHandle);
      this.searchTimeoutHandle = setTimeout(() => {
        this.handleNoDriverFound();
      }, 90000);
    } else {
      this.mapComponent?.showSearchingOverlay.set(false);
      if (this.searchTimeoutHandle) {
        clearTimeout(this.searchTimeoutHandle);
        this.searchTimeoutHandle = null;
      }
    }
  }

  private async handleNoDriverFound() {
    const b = this.booking();
    if (!b || b.status !== 'searching') return;

    // stop realtime
    this.channel?.unsubscribe();
    this.locationSubscription?.unsubscribe();

    try {
      await this.bookingService.updateBookingStatus(b.id, 'no_driver_found', 'No driver found within timeout');
      
      const toast = await this.alertCtrl.create({
        header: 'No Driver Found',
        message: 'No drivers available right now. Please try again.',
        buttons: ['OK']
      });
      await toast.present();

      this.router.navigate(['/customer']);
    } catch (e) {
      console.error('Failed to update status to no_driver_found', e);
    }
  }

  ngOnDestroy() {
    this.stopPolling();
    this.channel?.unsubscribe();
    this.locationSubscription?.unsubscribe();
  }

  async loadBookingAndDetails(id: string, showLoading = true) {
    if (showLoading) this.isLoading.set(true);
    try {
      const b = await this.bookingService.getBooking(id);
      this.bookingService.activeBooking.set(b);
      
      // Check timeout after loading
      this.checkSearchTimeout();
      
      const details = await this.bookingService.getBookingDetails(b.id, b.service_slug);
      this.details.set(details as Record<string, string | number | boolean | string[] | null | undefined>);

      if (b.service_slug === ServiceTypeEnum.ERRAND) {
        const funding = await this.bookingService.getErrandFunding(b.id);
        this.errandFunding.set(funding);
      }

      this.initMap();
      if (b.driver_id) {
        this.subscribeToDriverLocation(b.driver_id);
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

    // Defensive guard against NaN coordinates
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
