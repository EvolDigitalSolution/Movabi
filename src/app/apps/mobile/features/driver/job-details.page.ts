import {
    Component,
    inject,
    signal,
    OnInit,
    OnDestroy,
    ViewChild,
    AfterViewInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonIcon,
    IonContent,
    IonSpinner,
    AlertController,
    LoadingController,
    ToastController,
    NavController
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
    alertCircleOutline,
    call,
    cashOutline,
    chatbubbles,
    chevronBack,
    chevronDown,
    locationOutline,
    navigateOutline,
    receiptOutline,
    walletOutline
} from 'ionicons/icons';
import { ActivatedRoute } from '@angular/router';
import { RealtimeChannel } from '@supabase/supabase-js';

import { DriverService } from '../../../../core/services/driver/driver.service';
import { BookingService } from '../../../../core/services/booking/booking.service';
import { SupabaseService } from '../../../../core/services/supabase/supabase.service';
import { BookingStatus, DriverLocation, Booking } from '../../../../shared/models/booking.model';
import { ButtonComponent, BadgeComponent } from '../../../../shared/ui';
import { CommunicationPanelComponent } from '../../../../shared/ui/communication-panel';
import { MapComponent } from '../../../../shared/components/map/map.component';
import { RoutingService } from '../../../../core/services/maps/routing.service';
import { LocationService } from '../../../../core/services/logistics/location.service';
import { GeocodingService } from '../../../../core/services/maps/geocoding.service';
import { ServiceTypeSlug } from '../../../../core/models/maps/map-marker.model';
import { AppConfigService } from '../../../../core/services/config/app-config.service';

@Component({
    selector: 'app-job-details',
    standalone: true,
    imports: [
        CommonModule,
        IonHeader,
        IonToolbar,
        IonTitle,
        IonButtons,
        IonBackButton,
        IonIcon,
        IonContent,
        IonSpinner,
        ButtonComponent,
        BadgeComponent,
        CommunicationPanelComponent,
        MapComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" color="dark" text="" icon="chevron-back"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Request Execution
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      @if (job()) {
        <div class="flex flex-col min-h-full">
          <div class="h-[30vh] min-h-[220px] bg-slate-100 relative overflow-hidden z-10 shadow-lg">
            <app-map #map></app-map>
          </div>

          <div class="bg-white rounded-t-[2rem] shadow-[0_-20px_40px_-15px_rgba(0,0,0,0.12)] px-4 pt-5 pb-24 space-y-6 -mt-8 relative z-20 flex-1">
            <div class="w-12 h-1.5 bg-slate-100 rounded-full mx-auto"></div>

            <div class="flex justify-between items-start gap-4">
              <div class="min-w-0">
                <app-badge variant="primary">
                  {{ formatStatus(job()?.status) }}
                </app-badge>

                <h2 class="text-2xl font-display font-black text-slate-950 tracking-tight mt-3">
                  {{ serviceTitle() }}
                </h2>

                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                  ID: {{ shortId(job()?.id) }}
                </p>
              </div>

              <div class="text-right shrink-0">
                <p class="text-3xl font-display font-black text-blue-600 tracking-tight">
                  {{ formatPrice(job()?.total_price || job()?.price || 0) }}
                </p>
                <p class="text-[10px] font-black text-emerald-600 uppercase tracking-widest">
                  Est. earning
                </p>
              </div>
            </div>

            @if (job()?.service_slug === 'errand' && job()?.errand_funding) {
              <div class="p-5 bg-emerald-50 rounded-[1.75rem] border border-emerald-100 space-y-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-200 shrink-0">
                      <ion-icon name="wallet-outline" class="text-xl"></ion-icon>
                    </div>

                    <div class="min-w-0">
                      <p class="text-[10px] font-black text-emerald-600 uppercase tracking-widest">
                        Wallet Funded
                      </p>
                      <p class="text-sm font-black text-slate-950">
                        Reserved: {{ formatPrice(job()?.errand_funding?.amount_reserved || 0) }}
                      </p>
                    </div>
                  </div>

                  @if (job()?.errand_funding?.over_budget_status === 'requested') {
                    <app-badge variant="warning">Extra pending</app-badge>
                  }
                </div>

                @if (itemsList().length > 0) {
                  <div class="pt-4 border-t border-emerald-100/70">
                    <p class="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-2">
                      Items to Buy
                    </p>

                    <ul class="space-y-2">
                      @for (item of itemsList(); track item) {
                        <li class="text-xs font-semibold text-slate-700 flex items-center gap-2">
                          <div class="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></div>
                          {{ item }}
                        </li>
                      }
                    </ul>
                  </div>
                }
              </div>
            }

            <div class="flex items-center p-4 bg-slate-50 rounded-[1.75rem] border border-slate-100 shadow-sm">
              <div class="w-14 h-14 rounded-2xl overflow-hidden mr-4 border-2 border-white shadow-md bg-slate-200 flex items-center justify-center shrink-0">
                @if (customerAvatar()) {
                  <img
                    [src]="customerAvatar()"
                    alt="Customer profile"
                    class="w-full h-full object-cover"
                    referrerpolicy="no-referrer"
                  />
                } @else {
                  <span class="font-black text-slate-500">{{ customerInitial() }}</span>
                }
              </div>

              <div class="flex-1 min-w-0">
                <h3 class="font-black text-slate-950 truncate">{{ customerName() }}</h3>
                <p class="text-xs text-slate-500 font-semibold">Customer</p>
              </div>

              <app-button variant="secondary" size="sm" [fullWidth]="false" class="ml-2" (clicked)="callCustomer()">
                <ion-icon name="call" slot="icon-only"></ion-icon>
              </app-button>
            </div>

            <!-- Delivery/Errand Contact Details -->
            @if (recipientName()) {
              <div class="flex items-center p-4 bg-blue-50 rounded-[1.75rem] border border-blue-100 shadow-sm">
                <div class="w-14 h-14 rounded-2xl bg-blue-500 flex items-center justify-center text-white shadow-lg shadow-blue-200 shrink-0 mr-4">
                  <ion-icon name="location-outline" class="text-xl"></ion-icon>
                </div>

                <div class="flex-1 min-w-0">
                  <h3 class="font-black text-slate-950 truncate">{{ recipientName() }}</h3>
                  <p class="text-xs text-slate-500 font-semibold">
                    @if (job()?.service_slug === 'errand') { Recipient } @else { Delivery Recipient }
                  </p>
                  @if (recipientPhone()) {
                    <p class="text-xs text-blue-600 font-medium mt-1">{{ recipientPhone() }}</p>
                  }
                </div>

                @if (recipientPhone()) {
                  <a [href]="'tel:' + recipientPhone()" class="ml-2">
                    <app-button variant="primary" size="sm" [fullWidth]="false">
                      <ion-icon name="call" slot="icon-only"></ion-icon>
                    </app-button>
                  </a>
                }
              </div>
            }

            <!-- Delivery Details -->
            @if (job()?.service_slug === 'delivery' || job()?.service_slug === 'package') {
              <div class="p-5 bg-amber-50 rounded-[1.75rem] border border-amber-100 space-y-4">
                <h3 class="text-xs font-black text-amber-600 uppercase tracking-[0.18em]">Delivery Details</h3>
                
                @if (packageSizeLabel()) {
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-slate-600">Package Size</span>
                    <span class="text-xs font-black text-slate-950">{{ packageSizeLabel() }}</span>
                  </div>
                }

                @if (packageDescription()) {
                  <div>
                    <p class="text-xs font-semibold text-slate-600 mb-2">Package Details</p>
                    <p class="text-xs text-slate-700 leading-relaxed">{{ packageDescription() }}</p>
                  </div>
                }

                @if (deliveryInstructions()) {
                  <div>
                    <p class="text-xs font-semibold text-slate-600 mb-2">Special Instructions</p>
                    <p class="text-xs text-slate-700 leading-relaxed">{{ deliveryInstructions() }}</p>
                  </div>
                }
              </div>
            }

            <!-- Errand Details -->
            @if (job()?.service_slug === 'errand') {
              <div class="p-5 bg-purple-50 rounded-[1.75rem] border border-purple-100 space-y-4">
                <h3 class="text-xs font-black text-purple-600 uppercase tracking-[0.18em]">Errand Details</h3>
                
                @if (errandMode()) {
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-slate-600">Errand Mode</span>
                    <span class="text-xs font-black text-slate-950">{{ errandMode() }}</span>
                  </div>
                }

                @if (errandCustomerPhone()) {
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-slate-600">Customer Phone</span>
                    <div class="flex items-center gap-2">
                      <span class="text-xs text-slate-700">{{ errandCustomerPhone() }}</span>
                      <a [href]="'tel:' + errandCustomerPhone()">
                        <app-button variant="outline" size="sm" [fullWidth]="false">
                          <ion-icon name="call" slot="icon-only"></ion-icon>
                        </app-button>
                      </a>
                    </div>
                  </div>
                }

                @if (errandItems().length > 0) {
                  <div>
                    <p class="text-xs font-semibold text-slate-600 mb-2">Items List</p>
                    <ul class="space-y-1">
                      @for (item of errandItems(); track item) {
                        <li class="text-xs text-slate-700 flex items-center gap-2">
                          <div class="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0"></div>
                          {{ item }}
                        </li>
                      }
                    </ul>
                  </div>
                }

                @if (estimatedBudget()) {
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-slate-600">Estimated Budget</span>
                    <span class="text-xs font-black text-slate-950">{{ formatPrice(estimatedBudget()) }}</span>
                  </div>
                }

                @if (substitutionRule()) {
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-slate-600">Substitution Rule</span>
                    <span class="text-xs font-black text-slate-950">{{ substitutionRule() }}</span>
                  </div>
                }
              </div>
            }

            @if (canMessageCustomer()) {
              <div>
                <app-button variant="secondary" (clicked)="showChat.set(!showChat())">
                  <ion-icon [name]="showChat() ? 'chevron-down' : 'chatbubbles'" class="mr-2"></ion-icon>
                  {{ showChat() ? 'Hide Chat' : 'Message Customer' }}
                </app-button>

                @if (showChat()) {
                  <div class="mt-4 h-[400px] border border-slate-100 rounded-[1.75rem] overflow-hidden shadow-xl">
                    <app-communication-panel
                      [jobId]="job()!.id"
                      [receiverId]="job()!.customer_id!"
                      [receiverPhone]="customerPhone() || undefined"
                    ></app-communication-panel>
                  </div>
                }
              </div>
            }

            <div class="space-y-6">
              <div class="flex gap-4">
                <div class="flex flex-col items-center gap-1 pt-1">
                  <div class="w-3 h-3 rounded-full bg-blue-600 ring-4 ring-blue-100"></div>
                  <div class="w-0.5 h-14 bg-slate-100"></div>
                  <div class="w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-100"></div>
                </div>

                <div class="flex-1 space-y-6 min-w-0">
                  @if (!isNavigating()) {
                    <button type="button" (click)="startNavigation('pickup')" class="block text-left w-full">
                      <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Pickup</p>
                      <h3 class="text-sm font-black text-slate-950 leading-tight">{{ job()?.pickup_address || 'Pickup unavailable' }}</h3>
                      <p class="text-xs text-blue-600 font-bold mt-1">Start navigation</p>
                    </button>

                    <button type="button" (click)="startNavigation('dropoff')" class="block text-left w-full">
                      <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Destination</p>
                      <h3 class="text-sm font-black text-slate-950 leading-tight">{{ job()?.dropoff_address || 'Destination unavailable' }}</h3>
                      <p class="text-xs text-emerald-600 font-bold mt-1">Start navigation</p>
                    </button>
                  } @else {
                    <div class="space-y-4">
                      <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
                        <div class="flex items-center justify-between">
                          <div>
                            <p class="text-sm font-bold text-blue-900">
                              Navigating to {{ navigationMode() === 'pickup' ? 'Pickup' : 'Destination' }}
                            </p>
                            @if (currentRoute()) {
                              <p class="text-xs text-blue-700 mt-1">
                                {{ formatDistance(currentRoute().distanceMeters || 0) }} • 
                                {{ formatDuration(currentRoute().durationSeconds || 0) }} mins
                              </p>
                            }
                          </div>
                          <button type="button" (click)="stopNavigation()" 
                                  class="bg-red-500 text-white px-3 py-1 rounded-lg text-xs font-medium">
                            Stop
                          </button>
                        </div>
                      </div>

                      <div class="flex gap-2">
                        <button type="button" (click)="openExternalMaps(navigationMode() === 'pickup' ? job()?.pickup_address : job()?.dropoff_address)" 
                                class="flex-1 text-center bg-gray-100 text-gray-700 px-3 py-2 rounded-lg text-xs font-medium">
                          Open in Google Maps
                        </button>
                      </div>
                    </div>
                  }
                </div>
              </div>
            </div>

            @if (job()?.service_slug === 'errand' && showErrandTools()) {
              <div class="p-5 bg-slate-50 rounded-[1.75rem] border border-slate-100 space-y-5">
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Spending Details</h3>

                  @if (job()?.errand_details?.actual_spending) {
                    <app-badge variant="success">
                      {{ formatPrice(job()?.errand_details?.actual_spending || 0) }}
                    </app-badge>
                  }
                </div>

                <div class="grid grid-cols-1 gap-3">
                  <app-button variant="outline" size="sm" (clicked)="recordSpend()">
                    <ion-icon name="cash-outline" class="mr-2"></ion-icon>
                    {{ job()?.errand_details?.actual_spending ? 'Update Spend' : 'Record Actual Spend' }}
                  </app-button>

                  <app-button variant="outline" size="sm" (clicked)="uploadReceipt()">
                    <ion-icon name="receipt-outline" class="mr-2"></ion-icon>
                    {{ job()?.errand_details?.receipt_url ? 'Update Receipt' : 'Upload Receipt' }}
                  </app-button>

                  <app-button variant="secondary" size="sm" (clicked)="requestOverBudget()">
                    <ion-icon name="alert-circle-outline" class="mr-2"></ion-icon>
                    Request Extra Budget
                  </app-button>
                </div>
              </div>
            }

            <div class="pt-4">
              @if (job()?.service_slug === 'errand') {
                @switch (job()?.status) {
                  @case ('accepted') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="updateStatus('arrived_at_store')">
                      {{ submitting() ? 'Updating...' : 'Arrived at Store' }}
                    </app-button>
                  }

                  @case ('arrived_at_store') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="updateStatus('shopping_in_progress')">
                      {{ submitting() ? 'Starting...' : 'Start Shopping' }}
                    </app-button>
                  }

                  @case ('shopping_in_progress') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="updateStatus('collected')">
                      {{ submitting() ? 'Updating...' : 'Items Collected' }}
                    </app-button>
                  }

                  @case ('collected') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="updateStatus('en_route_to_customer')">
                      {{ submitting() ? 'Starting...' : 'En Route to Customer' }}
                    </app-button>
                  }

                  @case ('en_route_to_customer') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="updateStatus('delivered')">
                      {{ submitting() ? 'Updating...' : 'Delivered' }}
                    </app-button>
                  }

                  @case ('delivered') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="confirmCompletion()">
                      {{ submitting() ? 'Completing...' : 'Complete Errand' }}
                    </app-button>
                  }

                  @case ('completed') {
                    <app-button variant="secondary" size="lg" (clicked)="nav.navigateRoot('/driver')">
                      Back to Dashboard
                    </app-button>
                  }
                }
              } @else {
                @switch (job()?.status) {
                  @case ('accepted') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="updateStatus('arrived')">
                      {{ submitting() ? 'Updating...' : 'I Have Arrived' }}
                    </app-button>
                  }

                  @case ('arrived') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="updateStatus('in_progress')">
                      {{ submitting() ? 'Starting...' : 'Start Request' }}
                    </app-button>
                  }

                  @case ('in_progress') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="confirmCompletion()">
                      {{ submitting() ? 'Completing...' : 'Complete Request' }}
                    </app-button>
                  }

                  @case ('completed') {
                    <app-button variant="secondary" size="lg" (clicked)="nav.navigateRoot('/driver')">
                      Back to Dashboard
                    </app-button>
                  }
                }
              }
            </div>
          </div>
        </div>
      } @else {
        <div class="min-h-full flex flex-col items-center justify-center p-8 text-center space-y-6">
          <ion-spinner name="crescent" color="primary"></ion-spinner>
          <div>
            <h3 class="text-lg font-display font-black text-slate-950">
              {{ loadingJob() ? 'Loading request' : 'Request unavailable' }}
            </h3>
            <p class="text-slate-500 font-medium mt-1">
              {{ loadingJob() ? 'Retrieving details...' : 'This request may have been cancelled or assigned elsewhere.' }}
            </p>
          </div>

          @if (!loadingJob()) {
            <app-button variant="secondary" (clicked)="nav.navigateRoot('/driver')">
              Back to Dashboard
            </app-button>
          }
        </div>
      }
    </ion-content>
  `
})
export class JobDetailsPage implements OnInit, OnDestroy, AfterViewInit {
    @ViewChild('map') mapComponent?: MapComponent;

    public route = inject(ActivatedRoute);
    private driverService = inject(DriverService);
    private bookingService = inject(BookingService);
    private supabase = inject(SupabaseService);
    public nav = inject(NavController);
    private alertCtrl = inject(AlertController);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private routing = inject(RoutingService);
    private locationService = inject(LocationService);
    private geocoding = inject(GeocodingService);
    private config = inject(AppConfigService);

    job = this.driverService.activeJob;
    showChat = signal(false);
    submitting = signal(false);
    loadingJob = signal(true);
    
    // Delivery and errand details
    deliveryDetails = signal<any>(null);
    errandDetails = signal<any>(null);

    private locationSubscription?: RealtimeChannel;
    private routeId: string | null = null;
    private mapReady = false;

    // Navigation mode properties
    navigationMode = signal<'pickup' | 'dropoff' | null>(null);
    isNavigating = signal(false);
    currentRoute = signal<any>(null);
    driverPosition = signal<{ lat: number; lng: number } | null>(null);
    navigationWatchId: number | null = null;
    lastRouteUpdate = 0;
    private readonly ROUTE_UPDATE_THRESHOLD = 100; // meters

    constructor() {
        addIcons({
            alertCircleOutline,
            call,
            cashOutline,
            chatbubbles,
            chevronBack,
            chevronDown,
            locationOutline,
            navigateOutline,
            receiptOutline,
            walletOutline
        });
    }

    async ngOnInit() {
        this.routeId = this.route.snapshot.paramMap.get('id');

        await this.loadJob();

        this.subscribeToSelfLocation();
    }

    ngAfterViewInit() {
        this.mapReady = true;
        this.initMap();
    }

    ngOnDestroy() {
        void this.locationSubscription?.unsubscribe();
        
        // Clean up navigation watch
        if (this.navigationWatchId !== null) {
            navigator.geolocation.clearWatch(this.navigationWatchId);
            this.navigationWatchId = null;
        }
    }

    private async loadJob() {
        this.loadingJob.set(true);

        try {
            const id = this.routeId;

            if (!id) {
                this.driverService.activeJob.set(null);
                return;
            }

            if (!this.job() || this.job()?.id !== id) {
                const booking = await this.bookingService.getBooking(id);
                this.driverService.activeJob.set(booking as Booking);
                
                // Fetch delivery and errand details
                await this.loadJobDetails(booking as Booking);
            }

            this.initMap();
        } catch (error) {
            console.error('Failed to load request:', error);
            this.driverService.activeJob.set(null);
        } finally {
            this.loadingJob.set(false);
        }
    }

    private async loadJobDetails(job: Booking) {
        if (!job?.id) return;

        try {
            // Fetch delivery details if it's a delivery job
            if (job.service_slug === 'delivery' || job.service_slug === 'package') {
                const { data: deliveryData, error: deliveryError } = await this.supabase
                    .from('delivery_details')
                    .select('*')
                    .eq('job_id', job.id)
                    .maybeSingle();

                if (!deliveryError && deliveryData) {
                    this.deliveryDetails.set(deliveryData);
                } else if (deliveryError) {
                    console.warn('Failed to fetch delivery details:', deliveryError);
                    // Fallback to metadata
                    this.deliveryDetails.set((job as any).metadata?.delivery_details || null);
                }
            }

            // Fetch errand details if it's an errand job
            if (job.service_slug === 'errand') {
                const { data: errandData, error: errandError } = await this.supabase
                    .from('errand_details')
                    .select('*')
                    .eq('job_id', job.id)
                    .maybeSingle();

                if (!errandError && errandData) {
                    this.errandDetails.set(errandData);
                } else if (errandError) {
                    console.warn('Failed to fetch errand details:', errandError);
                    // Fallback to metadata
                    this.errandDetails.set((job as any).metadata?.errand_details || null);
                }
            }
        } catch (error) {
            console.error('Failed to load job details:', error);
        }
    }

    initMap() {
        const currentJob = this.job();

        if (!this.mapReady || !this.mapComponent || !currentJob) return;

        const pickup = {
            lat: Number(currentJob.pickup_lat || 0),
            lng: Number(currentJob.pickup_lng || 0)
        };

        const dropoff = {
            lat: Number(currentJob.dropoff_lat || 0),
            lng: Number(currentJob.dropoff_lng || 0)
        };

        if (!this.hasValidCoords(pickup)) return;

        this.mapComponent.addOrUpdateMarker({
            id: 'pickup',
            coordinates: pickup,
            kind: 'pickup',
            serviceType: (currentJob.service_slug || 'ride') as ServiceTypeSlug,
            label: 'PICKUP'
        });

        if (this.hasValidCoords(dropoff)) {
            this.mapComponent.addOrUpdateMarker({
                id: 'dropoff',
                coordinates: dropoff,
                kind: 'destination',
                serviceType: (currentJob.service_slug || 'ride') as ServiceTypeSlug,
                label: 'DROPOFF'
            });

            this.routing.getRoute(pickup, dropoff).subscribe({
                next: (route) => {
                    if (route && this.mapComponent) this.mapComponent.drawRoute(route);
                },
                error: (error) => console.error('Route drawing failed:', error)
            });
        }

        this.mapComponent.setCenter(pickup.lng, pickup.lat, 14);
    }

    subscribeToSelfLocation() {
        const currentJob = this.job();
        const driverId = currentJob?.driver_id;

        if (!driverId) return;

        this.locationSubscription = this.locationService.subscribeToDriverLocation(driverId, (location) => {
            this.updateDriverMarker(location);
        });
    }

    updateDriverMarker(location: DriverLocation) {
        const currentJob = this.job();

        if (!this.mapComponent || !currentJob) return;

        this.mapComponent.addOrUpdateMarker({
            id: 'driver',
            coordinates: {
                lat: Number(location.lat),
                lng: Number(location.lng)
            },
            kind: 'driver',
            serviceType: (currentJob.service_slug || 'ride') as ServiceTypeSlug,
            heading: location.heading ?? undefined
        });
    }

    async updateStatus(status: BookingStatus) {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        if (this.submitting()) return;

        this.submitting.set(true);

        const loading = await this.loadingCtrl.create({ message: 'Updating status...' });
        await loading.present();

        try {
            const updated = await this.driverService.updateJobStatus(currentJob.id, status);
            this.driverService.activeJob.set(updated as Booking);

            await this.showToast('Status updated.', 'success');
            this.initMap();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to update status.';
            await this.showToast(message, 'danger');
        } finally {
            this.submitting.set(false);
            await loading.dismiss();
        }
    }

    async confirmCompletion() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        if (currentJob.service_slug === 'errand') {
            const spending = Number(currentJob.errand_details?.actual_spending || 0);
            const receiptUrl = currentJob.errand_details?.receipt_url;
            const overBudgetStatus = currentJob.errand_funding?.over_budget_status;

            if (spending <= 0) {
                await this.showToast('Please record actual spending before completing this errand.', 'warning');
                return;
            }

            if (!receiptUrl) {
                await this.showToast('Please upload a receipt before completing this errand.', 'warning');
                return;
            }

            if (overBudgetStatus === 'requested') {
                await this.showToast('Please wait for the customer to approve or reject the extra budget request.', 'warning');
                return;
            }
        }

        const alert = await this.alertCtrl.create({
            header: 'Complete Request?',
            message: 'Confirm that this request is fully completed. Payment settlement will only continue after completion.',
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Complete',
                    role: 'confirm',
                    handler: () => {
                        void this.completeRequest();
                    }
                }
            ]
        });

        await alert.present();
    }

    private async completeRequest() {
        const currentJob = this.job();

        if (!currentJob?.id) return;

        if (this.submitting()) return;

        this.submitting.set(true);

        const loading = await this.loadingCtrl.create({ message: 'Completing request...' });
        await loading.present();

        try {
            const completed = await this.driverService.completeJob(currentJob.id);

            if (completed) {
                this.driverService.activeJob.set(completed as Booking);
            } else {
                await this.loadJob();
            }

            await this.showToast('Request completed.', 'success');
            await this.nav.navigateRoot('/driver');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to complete request.';
            await this.showToast(message, 'danger');
        } finally {
            this.submitting.set(false);
            await loading.dismiss();
        }
    }

    callCustomer() {
        const phone = this.customerPhone();

        if (!phone) {
            void this.showToast('Customer phone number is unavailable.', 'warning');
            return;
        }

        window.location.href = `tel:${phone}`;
    }

    async recordSpend() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const alert = await this.alertCtrl.create({
            header: 'Record Actual Spend',
            message: 'Enter the total amount spent on items.',
            inputs: [
                {
                    name: 'amount',
                    type: 'number',
                    placeholder: 'Amount, e.g. 25.50',
                    min: 0,
                    value: currentJob.errand_details?.actual_spending ?? ''
                },
                {
                    name: 'notes',
                    type: 'textarea',
                    placeholder: 'Spending notes, optional',
                    value: currentJob.errand_details?.spending_notes ?? ''
                }
            ],
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Save',
                    handler: (data) => {
                        const amount = Number(data?.amount);

                        if (!Number.isFinite(amount) || amount <= 0) {
                            void this.showToast('Enter a valid amount.', 'warning');
                            return false;
                        }

                        void this.saveSpend(currentJob.id, amount, data?.notes || '');
                        return true;
                    }
                }
            ]
        });

        await alert.present();
    }

    private async saveSpend(jobId: string, amount: number, notes?: string) {
        const loading = await this.loadingCtrl.create({ message: 'Saving spend...' });
        await loading.present();

        try {
            await this.driverService.recordErrandSpending(jobId, amount, notes);
            await this.loadJob();
            await this.showToast('Spending recorded.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to save spend.';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async uploadReceipt() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/webp,application/pdf';

        input.onchange = async (event: Event) => {
            const target = event.target as HTMLInputElement;
            const file = target.files?.[0];

            if (!file) return;

            if (!this.isAllowedReceipt(file)) {
                await this.showToast('Receipt must be JPG, PNG, WEBP, or PDF under 8MB.', 'warning');
                target.value = '';
                return;
            }

            const loading = await this.loadingCtrl.create({ message: 'Uploading receipt...' });
            await loading.present();

            try {
                await this.driverService.uploadErrandReceipt(currentJob.id, file);
                await this.loadJob();
                await this.showToast('Receipt uploaded.', 'success');
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : 'Failed to upload receipt.';
                await this.showToast(message, 'danger');
            } finally {
                target.value = '';
                await loading.dismiss();
            }
        };

        input.click();
    }

    async requestOverBudget() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const alert = await this.alertCtrl.create({
            header: 'Request Extra Budget',
            message: 'Enter the extra amount needed and explain why.',
            inputs: [
                {
                    name: 'amount',
                    type: 'number',
                    min: 0,
                    placeholder: 'Extra amount, e.g. 10.00'
                },
                {
                    name: 'reason',
                    type: 'textarea',
                    placeholder: 'Why is more budget needed?'
                }
            ],
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Request',
                    handler: (data) => {
                        const amount = Number(data?.amount);
                        const reason = String(data?.reason || '').trim();

                        if (!Number.isFinite(amount) || amount <= 0) {
                            void this.showToast('Enter a valid amount.', 'warning');
                            return false;
                        }

                        if (!reason) {
                            void this.showToast('Please enter a reason.', 'warning');
                            return false;
                        }

                        void this.sendOverBudgetRequest(currentJob.id, amount, reason);
                        return true;
                    }
                }
            ]
        });

        await alert.present();
    }

    private async sendOverBudgetRequest(jobId: string, amount: number, reason: string) {
        const loading = await this.loadingCtrl.create({ message: 'Sending request...' });
        await loading.present();

        try {
            await this.driverService.requestOverBudget(jobId, amount, reason);
            await this.loadJob();
            await this.showToast('Extra budget request sent.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to send request.';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    itemsList(): string[] {
        const raw: unknown = this.job()?.errand_details?.items_list;

        if (Array.isArray(raw)) {
            return raw.map((item: unknown) => String(item)).filter(Boolean);
        }

        if (typeof raw === 'string') {
            try {
                const parsed: unknown = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return parsed.map((item: unknown) => String(item)).filter(Boolean);
                }
            } catch {
                return raw
                    .split(',')
                    .map((item: string) => item.trim())
                    .filter(Boolean);
            }
        }

        return [];
    }

    showErrandTools(): boolean {
        return ['shopping_in_progress', 'collected', 'en_route_to_customer', 'delivered'].includes(this.job()?.status || '');
    }

    canMessageCustomer(): boolean {
        return ['accepted', 'arrived', 'in_progress', 'arrived_at_store', 'shopping_in_progress', 'collected', 'en_route_to_customer'].includes(this.job()?.status || '');
    }

    customerName(): string {
        const customer = this.job()?.customer;
        const first = String(customer?.first_name || '').trim();
        const last = String(customer?.last_name || '').trim();

        return first || last || 'Customer';
    }

    customerInitial(): string {
        return this.customerName().charAt(0).toUpperCase() || 'C';
    }

    customerAvatar(): string | null {
        return this.job()?.customer?.avatar_url || null;
    }

    customerPhone(): string | null {
        return this.job()?.customer?.phone || null;
    }

    // Delivery and errand detail helpers
    recipientName(): string | null {
        const delivery = this.deliveryDetails();
        const errand = this.errandDetails();
        
        return delivery?.recipientName || errand?.recipient_name || null;
    }

    recipientPhone(): string | null {
        const delivery = this.deliveryDetails();
        const errand = this.errandDetails();
        
        return delivery?.recipientPhone || errand?.recipient_phone || null;
    }

    packageDescription(): string | null {
        const delivery = this.deliveryDetails();
        return delivery?.itemDescription || null;
    }

    packageSizeLabel(): string | null {
        const delivery = this.deliveryDetails();
        const size = delivery?.packageSize;
        
        if (!size) return null;
        
        switch (size) {
            case 'small': return 'Small';
            case 'medium': return 'Medium';
            case 'large': return 'Large';
            case 'extra_large': return 'Extra Large';
            default: return size;
        }
    }

    deliveryInstructions(): string | null {
        const delivery = this.deliveryDetails();
        return delivery?.deliveryInstructions || null;
    }

    errandMode(): string | null {
        const errand = this.errandDetails();
        const mode = errand?.mode;
        
        if (!mode) return null;
        
        switch (mode) {
            case 'collect_deliver': return 'Collect & Deliver';
            case 'quick_buy': return 'Quick Buy';
            case 'shop_deliver': return 'Shop & Deliver';
            default: return mode;
        }
    }

    errandCustomerPhone(): string | null {
        const errand = this.errandDetails();
        return errand?.customer_phone || null;
    }

    errandItems(): string[] {
        const errand = this.errandDetails();
        const items = errand?.items_list;
        
        if (Array.isArray(items)) {
            return items.map((item: unknown) => String(item)).filter(Boolean);
        }
        
        if (typeof items === 'string') {
            try {
                const parsed = JSON.parse(items);
                if (Array.isArray(parsed)) {
                    return parsed.map((item: unknown) => String(item)).filter(Boolean);
                }
            } catch {
                return items
                    .split(',')
                    .map((item: string) => item.trim())
                    .filter(Boolean);
            }
        }
        
        return [];
    }

    estimatedBudget(): number | null {
        const errand = this.errandDetails();
        const budget = errand?.estimated_budget;
        return Number.isFinite(Number(budget)) ? Number(budget) : null;
    }

    substitutionRule(): string | null {
        const errand = this.errandDetails();
        const rule = errand?.substitution_rule;
        
        if (!rule) return null;
        
        switch (rule) {
            case 'no_substitution': return 'No Substitution';
            case 'contact_first': return 'Contact First';
            case 'similar_quality': return 'Similar Quality';
            case 'any_available': return 'Any Available';
            default: return rule;
        }
    }

    serviceTitle(): string {
        const slug = String(this.job()?.service_slug || 'request');
        return this.titleCase(slug);
    }

    formatStatus(status?: string | null): string {
        return this.titleCase(String(status || 'pending'));
    }

    shortId(id?: string | null): string {
        return String(id || '').slice(0, 8) || 'N/A';
    }

    formatPrice(amount: number | null | undefined): string {
        return this.config.formatCurrency(Number(amount || 0));
    }

    formatDistance(meters: number): string {
        const km = Math.round(meters / 10) / 100;
        return `${km} km`;
    }

    formatDuration(seconds: number): string {
        return `${Math.round(seconds / 60)}`;
    }

    // In-app navigation methods
    async startNavigation(type: 'pickup' | 'dropoff') {
        const currentJob = this.job();
        if (!currentJob) {
            await this.showToast('Job details not available.', 'warning');
            return;
        }

        const address = type === 'pickup' ? currentJob.pickup_address : currentJob.dropoff_address;
        if (!address) {
            await this.showToast(`${type === 'pickup' ? 'Pickup' : 'Dropoff'} address is unavailable.`, 'warning');
            return;
        }

        // Get current driver position
        const currentPosition = await this.getCurrentDriverPosition();
        if (!currentPosition) {
            await this.showToast('Unable to get your current location.', 'warning');
            return;
        }

        // Geocode the destination address
        const destination = await this.geocodeAddress(address);
        if (!destination) {
            await this.showToast('Unable to locate destination address.', 'warning');
            return;
        }

        console.log(`[Navigation] Starting ${type} navigation:`, {
            from: currentPosition,
            to: destination
        });

        this.navigationMode.set(type);
        this.isNavigating.set(true);
        this.driverPosition.set(currentPosition);

        // Get initial route
        await this.updateNavigationRoute(currentPosition, destination);

        // Start watching driver position
        this.startNavigationWatch(destination);

        // Update map to show navigation view
        await this.updateNavigationMap();
    }

    stopNavigation() {
        console.log('[Navigation] Stopping navigation');
        
        if (this.navigationWatchId !== null) {
            navigator.geolocation.clearWatch(this.navigationWatchId);
            this.navigationWatchId = null;
        }

        this.navigationMode.set(null);
        this.isNavigating.set(false);
        this.currentRoute.set(null);
        this.driverPosition.set(null);

        // Reset map to normal view
        this.resetMapToNormalView();
    }

    openExternalMaps(address?: string | null) {
        const safeAddress = String(address || '').trim();

        if (!safeAddress) {
            void this.showToast('Address is unavailable.', 'warning');
            return;
        }

        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(safeAddress)}`, '_blank');
    }

    private async getCurrentDriverPosition(): Promise<{ lat: number; lng: number } | null> {
        return new Promise((resolve) => {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    resolve({
                        lat: position.coords.latitude,
                        lng: position.coords.longitude
                    });
                },
                (error) => {
                    console.warn('[Navigation] Could not get current position:', error);
                    resolve(null);
                },
                {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 30000
                }
            );
        });
    }

    private async geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
        try {
            const result = await this.geocoding.geocodeAddress(address).toPromise();
            if (result && result.length > 0) {
                return {
                    lat: result[0].lat,
                    lng: result[0].lng
                };
            }
        } catch (error) {
            console.error('[Navigation] Geocoding failed:', error);
        }
        return null;
    }

    private async updateNavigationRoute(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
        try {
            const route = await this.routing.getRoute(from, to).toPromise();
            if (route) {
                this.currentRoute.set(route);
                console.log('[Navigation] Route updated:', {
                    distance: route.distanceMeters,
                    duration: route.durationSeconds
                });
            }
        } catch (error) {
            console.error('[Navigation] Failed to get route:', error);
        }
    }

    private startNavigationWatch(destination: { lat: number; lng: number }) {
        this.navigationWatchId = navigator.geolocation.watchPosition(
            async (position) => {
                const newPosition = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };

                this.driverPosition.set(newPosition);

                // Update driver location in database for customer tracking
                await this.updateDriverLocationInDatabase(
                    newPosition.lat,
                    newPosition.lng,
                    position.coords.heading || undefined
                );

                // Update route if driver has moved enough distance
                const lastPos = this.driverPosition();
                if (lastPos) {
                    const distance = this.locationService.calculateDistance(
                        lastPos.lat, lastPos.lng,
                        newPosition.lat, newPosition.lng
                    );

                    const now = Date.now();
                    if (distance > this.ROUTE_UPDATE_THRESHOLD || 
                        (now - this.lastRouteUpdate) > 30000) { // Update every 30 seconds minimum
                        await this.updateNavigationRoute(newPosition, destination);
                        this.lastRouteUpdate = now;
                        await this.updateNavigationMap();
                    }
                }
            },
            (error) => {
                console.error('[Navigation] Position watch error:', error);
            },
            {
                enableHighAccuracy: true,
                maximumAge: 5000,
                timeout: 10000
            }
        );
    }

    private async updateDriverLocationInDatabase(lat: number, lng: number, heading?: number) {
        try {
            // Direct database update to driver_locations table for customer tracking
            const { data: { user } } = await this.supabase.client.auth.getUser();
            if (!user?.id) return;

            const payload = {
                driver_id: user.id,
                lat,
                lng,
                heading: heading || null,
                updated_at: new Date().toISOString()
            };

            const { error } = await this.supabase.client
                .from('driver_locations')
                .upsert(payload, { onConflict: 'driver_id' });

            if (error) {
                console.error('[Navigation] Failed to update driver location:', error);
            }
        } catch (error) {
            console.error('[Navigation] Failed to update driver location:', error);
        }
    }

    private async updateNavigationMap() {
        if (!this.mapComponent || !this.driverPosition() || !this.currentRoute()) return;

        const driverPos = this.driverPosition()!;
        const route = this.currentRoute()!;
        const currentJob = this.job();
        if (!currentJob) return;

        // Clear existing markers
        this.mapComponent.removeMarker('driver');
        this.mapComponent.removeMarker('destination');

        // Add driver marker
        this.mapComponent.addOrUpdateMarker({
            id: 'driver',
            kind: 'driver',
            coordinates: driverPos,
            serviceType: currentJob.service_slug as ServiceTypeSlug,
            heading: 0 // Will be updated with actual heading
        });

        // Add destination marker
        const destination = this.navigationMode() === 'pickup' 
            ? await this.geocodeAddress(currentJob.pickup_address || '')
            : await this.geocodeAddress(currentJob.dropoff_address || '');

        if (destination) {
            this.mapComponent.addOrUpdateMarker({
                id: 'destination',
                kind: 'pickup',
                coordinates: destination,
                serviceType: currentJob.service_slug as ServiceTypeSlug
            });
        }

        // Draw route
        if (route.geometry) {
            this.mapComponent.drawRoute(route);
        }

        // Fit map to show route
        if (route.bounds) {
            this.mapComponent.fitBounds(route.bounds, { padding: 50 });
        }
    }

    private resetMapToNormalView() {
        if (!this.mapComponent) return;

        // Clear navigation markers
        this.mapComponent.removeMarker('driver');
        this.mapComponent.removeMarker('destination');
        this.mapComponent.clearRoute();

        // Reset to original job view
        this.initMap();
    }

    private hasValidCoords(coords: { lat: number; lng: number }): boolean {
        return (
            Number.isFinite(coords.lat) &&
            Number.isFinite(coords.lng) &&
            coords.lat !== 0 &&
            coords.lng !== 0
        );
    }

    private isAllowedReceipt(file: File): boolean {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        const maxBytes = 8 * 1024 * 1024;

        return allowedTypes.includes(file.type) && file.size <= maxBytes;
    }

    private titleCase(value: string): string {
        return value
            .replace(/[_-]/g, ' ')
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning') {
        const toast = await this.toastCtrl.create({
            message,
            duration: 2400,
            color,
            position: 'top'
        });

        await toast.present();
    }
}
