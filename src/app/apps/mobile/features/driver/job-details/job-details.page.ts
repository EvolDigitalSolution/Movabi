import { Component, ViewChild, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonIcon,
    IonSpinner,
    LoadingController,
    ToastController,
    AlertController,
    NavController
} from '@ionic/angular/standalone';
import { ActivatedRoute } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    addOutline,
    alertCircleOutline,
    call,
    callOutline,
    cameraOutline,
    checkmarkCircle,
    checkmarkDone,
    chevronBackOutline,
    navigate,
    receiptOutline,
    walletOutline,
    locationOutline,
    flagOutline,
    cashOutline,
    timeOutline,
    storefrontOutline,
    cubeOutline,
    carOutline,
    homeOutline
} from 'ionicons/icons';
import { RealtimeChannel } from '@supabase/supabase-js';

import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import { DriverService } from '../../../../../core/services/driver/driver.service';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { RoutingService } from '../../../../../core/services/maps/routing.service';
import {
    Booking,
    BookingStatus,
    ServiceTypeEnum,
    ErrandDetails,
    RideDetails,
    DeliveryDetails,
    VanDetails,
    ErrandFunding
} from '../../../../../shared/models/booking.model';

import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../../shared/ui';
import { MapComponent } from '../../../../../shared/components/map/map.component';
import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';

type JobDetails = ErrandDetails | RideDetails | DeliveryDetails | VanDetails;

@Component({
    selector: 'app-job-details',
    standalone: true,
    imports: [
        CommonModule,
        IonHeader,
        IonToolbar,
        IonButtons,
        IonBackButton,
        IonTitle,
        IonContent,
        IonIcon,
        IonSpinner,
        CardComponent,
        ButtonComponent,
        BadgeComponent,
        MapComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-4 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Request Details
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="w-full max-w-xl mx-auto px-3 py-4 space-y-6 pb-24 overflow-x-hidden">
        @if (job()) {
          <div class="relative overflow-hidden bg-white rounded-[2rem] p-6 text-slate-950 shadow-xl shadow-slate-900/10 border border-slate-200">
            <div class="absolute inset-x-0 top-0 h-1.5 bg-amber-500"></div>
            <ion-icon name="navigate" class="absolute -right-8 -bottom-8 text-[10rem] text-amber-500/[0.08] rotate-12"></ion-icon>

            <div class="relative z-10">
              <div class="flex items-start justify-between gap-4 mb-8">
                <div class="min-w-0">
                  <app-badge variant="primary">
                    {{ serviceName() }}
                  </app-badge>

                  <h2 class="text-3xl font-display font-black tracking-tight mt-4 capitalize text-slate-950">
                    {{ formatStatus(job()?.status) }}
                  </h2>

                  <p class="text-slate-600 font-semibold mt-1 text-xs">
                    ID: {{ shortId(job()?.id) }}
                  </p>
                </div>

                <div class="text-right shrink-0">
                  <p class="text-xs text-slate-500 font-semibold mb-1">
                    Payout
                  </p>
                  <span class="text-3xl font-display font-black text-slate-950">
                    {{ formatPrice(job()?.total_price || job()?.price || 0) }}
                  </span>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  (click)="openMap(job()?.pickup_address)"
                  class="h-12 rounded-2xl bg-amber-500 text-slate-950 font-black text-sm shadow-lg shadow-amber-500/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                >
                  <ion-icon name="location-outline"></ion-icon>
                  {{ originActionLabel() }}
                </button>

                <button
                  type="button"
                  (click)="openMap(job()?.dropoff_address)"
                  class="h-12 rounded-2xl bg-slate-50 border border-slate-200 text-slate-950 font-black text-sm active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                >
                  <ion-icon name="flag-outline"></ion-icon>
                  {{ destinationActionLabel() }}
                </button>
              </div>
            </div>
          </div>

          <app-card class="overflow-hidden">
            <div class="p-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-xs text-slate-500 font-semibold mb-1">{{ navigationSectionLabel() }}</p>
                <h3 class="text-base font-display font-black text-slate-950">{{ pickupMapTitle() }}</h3>
                <p class="text-xs text-slate-500 font-semibold mt-1">{{ pickupMapSubtitle() }}</p>
              </div>

              <button
                type="button"
                (click)="openMap(job()?.pickup_address)"
                class="w-11 h-11 rounded-2xl bg-blue-50 border border-blue-100 text-blue-600 flex items-center justify-center active:scale-95 transition-all shrink-0"
              >
                <ion-icon name="navigate"></ion-icon>
              </button>
            </div>

            <div class="h-72 bg-slate-50">
              <app-map #pickupMap></app-map>
            </div>
          </app-card>

          <app-card class="p-5">
            <div class="flex items-center justify-between gap-4 mb-8">
              <div class="flex items-center min-w-0">
                <div class="w-14 h-14 rounded-2xl overflow-hidden mr-4 border-4 border-slate-50 shadow-lg shadow-slate-200/50 bg-slate-100 flex items-center justify-center shrink-0">
                  <span class="text-lg font-black text-slate-500">
                    {{ customerInitial() }}
                  </span>
                </div>

                <div class="flex-1 min-w-0">
                  <h4 class="text-lg font-display font-black text-slate-950 truncate">
                    {{ customerName() }}
                  </h4>
                  <p class="text-xs text-slate-500 font-semibold">
                    Customer
                  </p>
                </div>
              </div>

              @if (customerPhone()) {
                <button
                  type="button"
                  (click)="callPhone(customerPhone())"
                  class="w-12 h-12 rounded-2xl bg-blue-50 border border-blue-100 text-blue-600 flex items-center justify-center active:scale-95 transition-all"
                >
                  <ion-icon name="call" class="text-xl"></ion-icon>
                </button>
              }
            </div>

            <div class="relative pl-8 space-y-8">
              <div class="absolute left-[9px] top-2 bottom-2 w-0.5 bg-slate-100"></div>

              <div class="relative">
                <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                <p class="text-xs text-slate-500 font-semibold mb-1">{{ originLabel() }}</p>
                <p class="font-bold text-slate-950 leading-snug">{{ job()?.pickup_address || originUnavailableLabel() }}</p>
              </div>

              <div class="relative">
                <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                <p class="text-xs text-slate-500 font-semibold mb-1">{{ destinationLabel() }}</p>
                <p class="font-bold text-slate-950 leading-snug">{{ job()?.dropoff_address || destinationUnavailableLabel() }}</p>
              </div>
            </div>
          </app-card>

          <app-card class="p-5">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-10 h-10 rounded-2xl bg-slate-50 border border-slate-100 text-slate-600 flex items-center justify-center">
                <ion-icon [name]="serviceIcon()" class="text-xl"></ion-icon>
              </div>
              <div>
                <h3 class="font-display font-black text-slate-950">Service Requirements</h3>
                <p class="text-xs text-slate-500 font-semibold">
                  {{ serviceName() }}
                </p>
              </div>
            </div>

            @if (details()) {
              @if (serviceVehicleLabel()) {
                <div class="p-4 bg-blue-50 rounded-2xl border border-blue-100 flex justify-between items-center mb-3">
                  <span class="text-sm font-bold text-blue-700">Vehicle needed</span>
                  <span class="text-sm font-black text-slate-950">{{ serviceVehicleLabel() }}</span>
                </div>
              }

              @if (job()?.service_slug === ServiceTypeEnum.RIDE) {
                <div class="space-y-3">
                  <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center">
                    <span class="text-sm font-bold text-slate-600">Passengers</span>
                    <span class="text-xl font-display font-black text-slate-950">{{ anyDetails()?.passenger_count || 1 }}</span>
                  </div>

                  @if (anyDetails()?.notes) {
                    <div class="p-4 bg-blue-50 rounded-2xl border border-blue-100">
                      <p class="text-xs font-semibold text-blue-700 mb-2">Customer notes</p>
                      <p class="text-sm text-slate-700 leading-relaxed">{{ anyDetails()?.notes }}</p>
                    </div>
                  }
                </div>
              }

              @if (job()?.service_slug === ServiceTypeEnum.DELIVERY) {
                <div class="space-y-3">
                  <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Package</p>
                    <p class="text-sm font-bold text-slate-800">{{ anyDetails()?.item_description || anyDetails()?.package_description || 'Package details not provided' }}</p>
                  </div>

                  @if (packageSizeLabel()) {
                    <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center">
                      <span class="text-sm font-bold text-slate-600">Package size</span>
                      <span class="text-sm font-black text-slate-950">{{ packageSizeLabel() }}</span>
                    </div>
                  }

                  @if (anyDetails()?.recipient_phone) {
                    <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center">
                      <span class="text-sm font-bold text-slate-600">Recipient</span>
                      <button
                        type="button"
                        (click)="callPhone(anyDetails()?.recipient_phone)"
                        class="w-10 h-10 rounded-2xl bg-white border border-slate-100 text-blue-600 flex items-center justify-center"
                      >
                        <ion-icon name="call-outline"></ion-icon>
                      </button>
                    </div>
                  }

                  @if (anyDetails()?.delivery_instructions) {
                    <div class="p-4 bg-blue-50 rounded-2xl border border-blue-100">
                      <p class="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-2">Instructions</p>
                      <p class="text-sm text-slate-700 leading-relaxed">{{ anyDetails()?.delivery_instructions }}</p>
                    </div>
                  }
                </div>
              }

              @if (job()?.service_slug === ServiceTypeEnum.ERRAND) {
                <div class="space-y-4">
                  <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <div class="flex justify-between items-center gap-3 mb-4">
                      <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Shopping List</p>

                      @if (errandDetails()?.receipt_url) {
                        <app-badge variant="success">
                          Receipt uploaded
                        </app-badge>
                      }
                    </div>

                    @if (itemsList().length > 0) {
                      <div class="flex flex-wrap gap-2">
                        @for (item of itemsList(); track item) {
                          <app-badge variant="secondary">{{ item }}</app-badge>
                        }
                      </div>
                    } @else {
                      <p class="text-sm text-slate-500 font-semibold">No shopping list provided.</p>
                    }
                  </div>

                  <div class="grid grid-cols-2 gap-3">
                    <div class="p-4 bg-white rounded-2xl border border-slate-100">
                      <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Budget</p>
                      <p class="text-lg font-display font-black text-slate-950">
                        {{ formatPrice(errandDetails()?.estimated_budget || 0) }}
                      </p>
                    </div>

                    <div class="p-4 bg-white rounded-2xl border border-slate-100">
                      <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Spent</p>
                      <p
                        class="text-lg font-display font-black"
                        [class.text-amber-600]="!hasRecordedErrandSpend()"
                        [class.text-emerald-600]="hasRecordedErrandSpend() && toNumber(errandDetails()?.actual_spending) <= toNumber(errandDetails()?.estimated_budget)"
                        [class.text-rose-600]="hasRecordedErrandSpend() && toNumber(errandDetails()?.actual_spending) > toNumber(errandDetails()?.estimated_budget)"
                      >
                        {{ hasRecordedErrandSpend() ? formatPrice(errandDetails()?.actual_spending || 0) : 'Not recorded' }}
                      </p>
                    </div>
                  </div>

                  @if (funding() && funding()?.over_budget_status !== 'none') {
                    <div
                      class="p-4 rounded-2xl border"
                      [class.bg-emerald-50]="funding()?.over_budget_status === 'approved'"
                      [class.border-emerald-100]="funding()?.over_budget_status === 'approved'"
                      [class.bg-amber-50]="funding()?.over_budget_status === 'requested'"
                      [class.border-amber-100]="funding()?.over_budget_status === 'requested'"
                      [class.bg-rose-50]="funding()?.over_budget_status === 'rejected'"
                      [class.border-rose-100]="funding()?.over_budget_status === 'rejected'"
                    >
                      <div class="flex justify-between items-center gap-3">
                        <span class="text-[10px] font-black uppercase tracking-widest text-slate-600">
                          Extra budget: {{ funding()?.over_budget_status }}
                        </span>
                        <span class="font-black text-slate-950">
                          {{ formatPrice(funding()?.over_budget_amount || 0) }}
                        </span>
                      </div>
                    </div>
                  }

                  @if (showErrandSpendTools()) {
                    <div class="grid grid-cols-2 gap-3 pt-2">
                      <app-button variant="secondary" size="sm" (clicked)="recordSpending()">
                        {{ hasRecordedErrandSpend() ? 'Update Spend' : 'Record Spend' }}
                      </app-button>

                      <app-button variant="secondary" size="sm" (clicked)="requestOverBudget()">
                        Extra Budget
                      </app-button>
                    </div>

                    <div>
                      <input type="file" #receiptInput class="hidden" (change)="onReceiptSelected($event)" accept="image/*,.pdf">
                      <app-button variant="secondary" size="sm" class="w-full" (clicked)="receiptInput.click()">
                        {{ errandDetails()?.receipt_url ? 'Update Receipt' : 'Upload Receipt' }}
                      </app-button>
                    </div>
                  }
                </div>
              }

              @if (job()?.service_slug === ServiceTypeEnum.VAN) {
                <div class="grid grid-cols-2 gap-3">
                  <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Helpers</p>
                    <p class="text-xl font-display font-black text-slate-950">{{ anyDetails()?.helper_count || 0 }}</p>
                  </div>

                  <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Floor</p>
                    <p class="text-xl font-display font-black text-slate-950">{{ anyDetails()?.floor_number || 0 }}</p>
                  </div>

                  @if (anyDetails()?.items_description) {
                    <div class="col-span-2 p-4 bg-blue-50 rounded-2xl border border-blue-100">
                      <p class="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-2">Items</p>
                      <p class="text-sm text-slate-700 leading-relaxed">{{ anyDetails()?.items_description }}</p>
                    </div>
                  }
                </div>
              }
            } @else {
              <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <p class="text-sm text-slate-500 font-semibold">No extra service details found.</p>
              </div>
            }
          </app-card>

          <div class="sticky bottom-3 z-20">
            @if (job()?.status !== 'completed') {
              <div class="bg-white/95 backdrop-blur rounded-[1.5rem] border border-slate-100 shadow-xl shadow-slate-200/60 p-4 mb-3">
                <div class="flex items-start justify-between gap-4 mb-3">
                  <div class="min-w-0">
                    <p class="text-xs text-slate-500 font-semibold mb-1">Next step</p>
                    <h3 class="text-base font-display font-black text-slate-950">{{ actionTitle() }}</h3>
                  </div>
                  <app-badge [variant]="actionBadgeVariant()">{{ formatStatus(job()?.status) }}</app-badge>
                </div>

                <div class="h-2 rounded-full bg-slate-100 overflow-hidden mb-3">
                  <div
                    class="h-full rounded-full bg-blue-600 transition-all duration-300"
                    [style.width.%]="actionProgress()"
                  ></div>
                </div>

                <p class="text-xs text-slate-500 font-semibold leading-relaxed">
                  {{ actionHint() }}
                </p>
              </div>
            }

            @switch (job()?.status) {
              @case ('accepted') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus('arrived')">
                  I Have Arrived
                </app-button>
              }

              @case ('arrived') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus(startStatus())">
                  Start Request
                </app-button>
              }

              @case ('arrived_at_store') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus('shopping_in_progress')">
                  Start Shopping
                </app-button>
              }

              @case ('shopping_in_progress') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus('collected')">
                  Items Collected
                </app-button>
              }

              @case ('collected') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus('en_route_to_customer')">
                  En Route to Customer
                </app-button>
              }

              @case ('en_route_to_customer') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-emerald-600/20 bg-emerald-600 border-emerald-600" (clicked)="completeTrip()">
                  Complete Request
                </app-button>
              }

              @case ('in_progress') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-emerald-600/20 bg-emerald-600 border-emerald-600" (clicked)="completeTrip()">
                  Complete Request
                </app-button>
              }

              @case ('delivered') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-emerald-600/20 bg-emerald-600 border-emerald-600" (clicked)="completeTrip()">
                  Complete Request
                </app-button>
              }

              @case ('completed') {
                <div class="bg-emerald-50 p-6 rounded-[2rem] text-center border border-emerald-100">
                  <div class="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <ion-icon name="checkmark-circle" class="text-4xl text-emerald-600"></ion-icon>
                  </div>
                  <h3 class="text-xl font-display font-black text-slate-950 mb-2">Request Completed</h3>
                  <p class="text-slate-600 font-medium mb-5">Earnings will appear once settlement is complete.</p>
                  <app-button variant="secondary" size="lg" (clicked)="nav.navigateRoot('/driver')" class="w-full">
                    Back to Dashboard
                  </app-button>
                </div>
              }

              @default {
                <app-button variant="secondary" size="lg" class="w-full h-14 rounded-2xl" (clicked)="nav.navigateRoot('/driver')">
                  Back to Dashboard
                </app-button>
              }
            }
          </div>
        } @else {
          <div class="min-h-[70vh] flex flex-col items-center justify-center py-20 text-center space-y-8">
            @if (isLoading()) {
              <div class="w-20 h-20 bg-white rounded-[2rem] flex items-center justify-center shadow-2xl shadow-slate-200/50 border border-slate-100">
                <ion-spinner name="crescent" color="primary"></ion-spinner>
              </div>
              <div class="space-y-2">
                <h3 class="text-xl font-display font-black text-slate-950">Loading request</h3>
                <p class="text-slate-500 font-medium">Retrieving details...</p>
              </div>
            } @else {
              <div class="w-24 h-24 bg-red-50 rounded-[2rem] flex items-center justify-center text-red-500 border border-red-100">
                <ion-icon name="alert-circle-outline" class="text-5xl"></ion-icon>
              </div>
              <div class="space-y-3">
                <h3 class="text-2xl font-display font-black text-slate-950">Request Not Found</h3>
                <p class="text-slate-500 font-medium max-w-xs mx-auto leading-relaxed">
                  This request may have been cancelled, completed, or assigned to another driver.
                </p>
              </div>
              <app-button variant="secondary" size="lg" (clicked)="nav.navigateRoot('/driver')" class="w-full">
                Back to Dashboard
              </app-button>
            }
          </div>
        }
      </div>
    </ion-content>
  `
})
export class JobDetailsPage implements OnInit, OnDestroy {
    @ViewChild('pickupMap') pickupMap?: MapComponent;

    private route = inject(ActivatedRoute);
    private driverService = inject(DriverService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private alertCtrl = inject(AlertController);
    public nav = inject(NavController);
    private bookingService = inject(BookingService);
    private locationService = inject(LocationService);
    private routing = inject(RoutingService);
    public config = inject(AppConfigService);

    ServiceTypeEnum = ServiceTypeEnum;

    job = this.driverService.activeJob;
    details = signal<JobDetails | null>(null);
    anyDetails = computed(() => this.details() as any);
    errandDetails = computed(() => this.details() as ErrandDetails | null);
    funding = signal<ErrandFunding | null>(null);
    isLoading = signal(true);
    driverPickupDistance = signal<number | null>(null);
    driverPickupDuration = signal<number | null>(null);
    pickupMapReady = signal(false);

    itemsList = computed((): string[] => {
        const details = this.details() as any;
        const raw: unknown = details?.items_list;

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
    });

    serviceName = computed(() => {
        const job = this.job() as any;
        const raw = job?.service_type?.name || job?.service_slug || 'Request';
        return this.titleCase(String(raw));
    });

    serviceVehicleLabel = computed(() => {
        const metadata = this.jobMetadata();
        const details = this.anyDetails() || {};
        const raw = String(
            metadata['service_vehicle_class'] ||
            metadata['vehicleClass'] ||
            metadata['vehicle_class'] ||
            metadata['ride_details']?.vehicle_class ||
            metadata['delivery_details']?.vehicleClass ||
            metadata['errand_details']?.vehicleClass ||
            details?.vehicle_class ||
            ''
        ).toLowerCase();

        switch (raw) {
            case 'bike':
                return 'Bike';
            case 'standard':
            case 'car':
                return 'Car';
            case 'xl':
                return 'XL car';
            case 'van':
                return 'Van';
            default:
                return '';
        }
    });

    packageSizeLabel = computed(() => {
        const metadata = this.jobMetadata();
        const raw = String(
            metadata['package_size'] ||
            metadata['delivery_details']?.packageSize ||
            this.anyDetails()?.package_size ||
            ''
        ).toLowerCase();

        switch (raw) {
            case 'small':
                return 'Small';
            case 'medium':
                return 'Medium';
            case 'large':
                return 'Large';
            default:
                return '';
        }
    });

    private channel?: RealtimeChannel;

    private jobMetadata(): Record<string, any> {
        const raw = (this.job() as any)?.metadata || {};

        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                return parsed && typeof parsed === 'object' ? parsed : {};
            } catch {
                return {};
            }
        }

        return raw && typeof raw === 'object' ? raw : {};
    }

    constructor() {
        addIcons({
            addOutline,
            alertCircleOutline,
            call,
            callOutline,
            cameraOutline,
            checkmarkCircle,
            checkmarkDone,
            chevronBackOutline,
            navigate,
            receiptOutline,
            walletOutline,
            locationOutline,
            flagOutline,
            cashOutline,
            timeOutline,
            storefrontOutline,
            cubeOutline,
            carOutline,
            homeOutline
        });
    }

    ngOnInit() {
        const id = this.route.snapshot.paramMap.get('id');
        void this.loadJob(id || '');

        if (id) {
            this.channel = this.bookingService.subscribeToBooking(id);
        }
    }

    ngOnDestroy() {
        void this.channel?.unsubscribe();
        this.locationService.stopTracking();
    }

    async loadJob(id: string) {
        this.isLoading.set(true);

        try {
            if (!id) {
                this.driverService.activeJob.set(null);
                return;
            }

            let currentJob = this.job();

            if (!currentJob || currentJob.id !== id) {
                currentJob = await this.bookingService.getBooking(id);
                this.driverService.activeJob.set(currentJob as Booking);
            }

            if (!currentJob) {
                this.driverService.activeJob.set(null);
                return;
            }

            const details = await this.bookingService.getBookingDetails(
                currentJob.id,
                currentJob.service_slug as ServiceTypeEnum
            );

            this.details.set(details as JobDetails | null);

            if (currentJob.service_slug === ServiceTypeEnum.ERRAND) {
                const funding = await this.bookingService.getErrandFunding(currentJob.id);
                this.funding.set(funding);
            } else {
                this.funding.set(null);
            }

            this.ensureLiveLocationTracking(currentJob as Booking);
            void this.renderPickupRoute();
        } catch (error) {
            console.error('Failed to load request details:', error);
            this.driverService.activeJob.set(null);
        } finally {
            this.isLoading.set(false);
        }
    }

    private patchErrandDetails(updatedDetails: Partial<ErrandDetails> | null | undefined) {
        if (!updatedDetails) return;

        this.details.update((current) => ({
            ...((current || {}) as ErrandDetails),
            ...updatedDetails
        }) as JobDetails);
    }

    private patchErrandFunding(partial: Record<string, unknown>) {
        this.funding.update((current) => ({
            ...((current || {}) as ErrandFunding),
            ...partial
        }) as ErrandFunding);
    }

    async updateStatus(status: BookingStatus) {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const loading = await this.loadingCtrl.create({ message: 'Updating status...' });
        await loading.present();

        try {
            const updated = await this.driverService.updateJobStatus(currentJob.id, status);
            this.driverService.activeJob.set(updated as Booking);
            await this.loadJob(currentJob.id);
            void this.renderPickupRoute();
            await this.showToast('Status updated.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Update failed';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    startStatus(): BookingStatus {
        if (this.job()?.service_slug === ServiceTypeEnum.ERRAND) {
            return 'arrived_at_store' as BookingStatus;
        }

        return 'in_progress' as BookingStatus;
    }

    async completeTrip() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        if (currentJob.service_slug === ServiceTypeEnum.ERRAND) {
            const errandDetails = this.details() as ErrandDetails | null;

            if (!errandDetails?.actual_spending || errandDetails.actual_spending <= 0) {
                await this.showToast('Please record the actual spending before completing.', 'warning');
                return;
            }

            if (errandDetails.actual_spending > 0 && !errandDetails.receipt_url) {
                await this.showToast('Please upload a receipt before completing this errand.', 'warning');
                return;
            }

            if (this.funding()?.over_budget_status === 'requested') {
                await this.showToast('Please wait for the customer to approve or reject the extra budget request.', 'warning');
                return;
            }
        }

        const alert = await this.alertCtrl.create({
            header: 'Complete Request',
            message: 'Confirm this request is fully completed. Payment settlement will only continue after completion.',
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Complete',
                    role: 'confirm',
                    handler: () => {
                        void this.executeCompletion();
                    }
                }
            ]
        });

        await alert.present();
    }

    private async executeCompletion() {
        const currentJob = this.job();

        if (!currentJob?.id) return;

        const loading = await this.loadingCtrl.create({ message: 'Completing request...' });
        await loading.present();

        try {
            const completed = await this.driverService.completeJob(currentJob.id);

            if (completed) {
                this.driverService.activeJob.set(completed as Booking);
            } else {
                await this.loadJob(currentJob.id);
            }

            await this.showToast('Request completed.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Could not complete request.';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async recordSpending() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const currentDetails = this.details() as any;

        const alert = await this.alertCtrl.create({
            header: 'Record Spending',
            message: 'Enter the actual amount spent on items.',
            inputs: [
                {
                    name: 'amount',
                    type: 'number',
                    placeholder: 'Amount, e.g. 15.50',
                    min: 0,
                    value: currentDetails?.actual_spending ?? ''
                },
                {
                    name: 'notes',
                    type: 'textarea',
                    placeholder: 'Notes, optional',
                    value: currentDetails?.spending_notes ?? ''
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

                        void this.saveSpending(currentJob.id, amount, data?.notes || '');
                        return true;
                    }
                }
            ]
        });

        await alert.present();
    }

    private async saveSpending(jobId: string, amount: number, notes?: string) {
        const loading = await this.loadingCtrl.create({ message: 'Saving spending...' });
        await loading.present();

        try {
            const updatedDetails = await this.driverService.recordErrandSpending(jobId, amount, notes);
            this.patchErrandDetails(updatedDetails);
            await this.loadJob(jobId);
            await this.showToast('Spending recorded.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to save spending.';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async requestOverBudget() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const alert = await this.alertCtrl.create({
            header: 'Request Extra Budget',
            subHeader: 'Ask the customer to approve additional funds.',
            inputs: [
                {
                    name: 'amount',
                    type: 'number',
                    min: 0,
                    placeholder: 'Additional amount needed'
                },
                {
                    name: 'reason',
                    type: 'textarea',
                    placeholder: 'Reason for extra budget'
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
            this.patchErrandFunding({
                over_budget_status: 'requested',
                over_budget_amount: amount,
                requested_over_budget_amount: amount,
                over_budget_reason: reason,
                status: 'over_budget_requested',
                updated_at: new Date().toISOString()
            });
            await this.loadJob(jobId);
            await this.showToast('Extra budget request sent.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to send request.';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async onReceiptSelected(event: Event) {
        const target = event.target as HTMLInputElement;
        const file = target.files?.[0];

        if (!file) return;

        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            target.value = '';
            return;
        }

        const maxSizeMb = 8;
        const maxBytes = maxSizeMb * 1024 * 1024;

        if (file.size > maxBytes) {
            await this.showToast(`Receipt must be smaller than ${maxSizeMb}MB.`, 'warning');
            target.value = '';
            return;
        }

        const loading = await this.loadingCtrl.create({ message: 'Uploading receipt...' });
        await loading.present();

        try {
            const updatedDetails = await this.driverService.uploadErrandReceipt(currentJob.id, file);
            this.patchErrandDetails(updatedDetails);
            await this.loadJob(currentJob.id);
            await this.showToast('Receipt uploaded.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Upload failed.';
            await this.showToast(message, 'danger');
        } finally {
            target.value = '';
            await loading.dismiss();
        }
    }

    callPhone(phone?: string | null) {
        const safePhone = String(phone || '').trim();

        if (!safePhone) {
            void this.showToast('Phone number is unavailable.', 'warning');
            return;
        }

        window.location.href = `tel:${safePhone}`;
    }

    openMap(address?: string | null) {
        const safeAddress = String(address || '').trim();

        if (!safeAddress) {
            void this.showToast('Address is unavailable.', 'warning');
            return;
        }

        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(safeAddress)}`, '_blank');
    }

    private async renderPickupRoute(): Promise<void> {
        const currentJob = this.job();

        if (!currentJob || !this.pickupMap) {
            setTimeout(() => void this.renderPickupRoute(), 350);
            return;
        }

        const pickupLat = Number((currentJob as any).pickup_lat);
        const pickupLng = Number((currentJob as any).pickup_lng);

        if (!this.isValidCoordinate(pickupLat) || !this.isValidCoordinate(pickupLng)) {
            this.pickupMapReady.set(false);
            return;
        }

        this.pickupMap.addOrUpdateMarker({
            id: 'pickup',
            coordinates: { lat: pickupLat, lng: pickupLng },
            kind: 'pickup',
            serviceType: currentJob.service_slug as ServiceTypeSlug,
            label: this.mapOriginMarkerLabel()
        });

        const position = await this.locationService.getCurrentPosition();

        if (!position) {
            this.pickupMap.setCenter(pickupLng, pickupLat, 14);
            this.pickupMapReady.set(true);
            return;
        }

        const driverPosition = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };

        this.pickupMap.addOrUpdateMarker({
            id: 'driver-current',
            coordinates: driverPosition,
            kind: 'driver',
            serviceType: currentJob.service_slug as ServiceTypeSlug,
            heading: Number(position.coords.heading || 0),
            label: 'YOU'
        });

        this.routing
            .getRoute(driverPosition, { lat: pickupLat, lng: pickupLng })
            .subscribe({
                next: (route) => {
                    if (route) {
                        this.driverPickupDistance.set(route.distanceMeters);
                        this.driverPickupDuration.set(route.durationSeconds);
                        this.pickupMap?.drawRoute(route);

                        if (route.bounds) {
                            this.pickupMap?.fitBounds(route.bounds, {
                                padding: { top: 60, bottom: 60, left: 45, right: 45 },
                                maxZoom: 15,
                                duration: 700
                            });
                        }
                    } else {
                        this.driverPickupDistance.set(null);
                        this.driverPickupDuration.set(null);
                        this.pickupMap?.setCenter(pickupLng, pickupLat, 14);
                    }

                    this.pickupMapReady.set(true);
                },
                error: (error) => {
                    console.warn('Pickup route draw failed:', error);
                    this.driverPickupDistance.set(null);
                    this.driverPickupDuration.set(null);
                    this.pickupMapReady.set(true);
                }
            });
    }

    private ensureLiveLocationTracking(currentJob: Booking): void {
        const tenantId = (currentJob as any).tenant_id;
        const status = String(currentJob.status || '');

        if (tenantId && status !== 'completed' && status !== 'cancelled') {
            this.locationService.startTracking(tenantId);
        }
    }

    pickupMapTitle(): string {
        if (this.driverPickupDuration() !== null) {
            return `${this.formatDuration(this.driverPickupDuration())} to ${this.originTargetLabel()}`;
        }

        return `Route to ${this.originTargetLabel()}`;
    }

    pickupMapSubtitle(): string {
        if (this.driverPickupDistance() !== null) {
            return `${this.formatDistanceMeters(this.driverPickupDistance())} from your current location.`;
        }

        return `Shows the ${this.originTargetLabel()} and route when GPS is available.`;
    }

    navigationSectionLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store navigation';
            case ServiceTypeEnum.DELIVERY:
                return 'Collection navigation';
            case ServiceTypeEnum.VAN:
                return 'Move pickup navigation';
            default:
                return 'Pickup navigation';
        }
    }

    originActionLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store';
            case ServiceTypeEnum.DELIVERY:
                return 'Collect';
            case ServiceTypeEnum.VAN:
                return 'From';
            default:
                return 'Pickup';
        }
    }

    destinationActionLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Customer';
            case ServiceTypeEnum.DELIVERY:
                return 'Recipient';
            case ServiceTypeEnum.VAN:
                return 'To';
            default:
                return 'Destination';
        }
    }

    originLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store / pickup point';
            case ServiceTypeEnum.DELIVERY:
                return 'Collection point';
            case ServiceTypeEnum.VAN:
                return 'Moving from';
            default:
                return 'Pickup';
        }
    }

    destinationLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Customer delivery address';
            case ServiceTypeEnum.DELIVERY:
                return 'Recipient address';
            case ServiceTypeEnum.VAN:
                return 'Moving to';
            default:
                return 'Destination';
        }
    }

    originUnavailableLabel(): string {
        return `${this.originLabel()} unavailable`;
    }

    destinationUnavailableLabel(): string {
        return `${this.destinationLabel()} unavailable`;
    }

    private originTargetLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'store';
            case ServiceTypeEnum.DELIVERY:
                return 'collection point';
            case ServiceTypeEnum.VAN:
                return 'move pickup';
            default:
                return 'pickup';
        }
    }

    private mapOriginMarkerLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'STORE';
            case ServiceTypeEnum.DELIVERY:
                return 'COLLECT';
            case ServiceTypeEnum.VAN:
                return 'FROM';
            default:
                return 'PICKUP';
        }
    }

    customerName(): string {
        const customer = (this.job() as any)?.customer;
        const first = String(customer?.first_name || '').trim();
        const last = String(customer?.last_name || '').trim();

        return first || last || 'Customer';
    }

    customerInitial(): string {
        return this.customerName().charAt(0).toUpperCase() || 'C';
    }

    customerPhone(): string | null {
        const job = this.job() as any;
        const details = this.anyDetails();

        return (
            job?.customer?.phone ||
            details?.customer_phone ||
            details?.recipient_phone ||
            null
        );
    }

    serviceIcon(): string {
        const slug = this.job()?.service_slug;

        if (slug === ServiceTypeEnum.RIDE) return 'car-outline';
        if (slug === ServiceTypeEnum.ERRAND) return 'storefront-outline';
        if (slug === ServiceTypeEnum.DELIVERY) return 'cube-outline';
        if (slug === ServiceTypeEnum.VAN) return 'home-outline';

        return 'wallet-outline';
    }

    formatStatus(status?: string | null): string {
        if (!status) return 'Pending';
        return this.titleCase(status);
    }

    actionTitle(): string {
        switch (this.job()?.status) {
            case 'accepted':
                return `Go to ${this.originTargetLabel()}`;
            case 'arrived':
                if (this.job()?.service_slug === ServiceTypeEnum.ERRAND) return 'Confirm store arrival';
                if (this.job()?.service_slug === ServiceTypeEnum.DELIVERY) return 'Confirm collection arrival';
                if (this.job()?.service_slug === ServiceTypeEnum.VAN) return 'Start the move';
                return 'Start the ride';
            case 'arrived_at_store':
                return 'Start shopping';
            case 'shopping_in_progress':
                return 'Collect all items';
            case 'collected':
                return 'Head to customer';
            case 'en_route_to_customer':
            case 'in_progress':
            case 'delivered':
                return 'Complete the request';
            default:
                return 'Review request details';
        }
    }

    actionHint(): string {
        switch (this.job()?.status) {
            case 'accepted':
                return `Open the ${this.originTargetLabel()}, contact the customer if needed, then mark yourself arrived.`;
            case 'arrived':
                if (this.job()?.service_slug === ServiceTypeEnum.ERRAND) {
                    return 'Confirm you are at the correct store before shopping for the customer.';
                }
                if (this.job()?.service_slug === ServiceTypeEnum.DELIVERY) {
                    return 'Confirm you are at the collection point before collecting the package.';
                }
                if (this.job()?.service_slug === ServiceTypeEnum.VAN) {
                    return 'Confirm you are at the move pickup before starting loading.';
                }
                return 'Only start once the customer is ready for the ride.';
            case 'arrived_at_store':
                return 'Begin shopping after confirming the store and customer notes.';
            case 'shopping_in_progress':
                return 'Record spending and upload a receipt before completing an errand.';
            case 'collected':
                return 'Items are collected. Navigate to the customer and keep the request moving.';
            case 'en_route_to_customer':
            case 'in_progress':
            case 'delivered':
                return 'Confirm the work is fully done before completing the request.';
            default:
                return 'Check route, customer details, and service requirements before taking action.';
        }
    }

    actionProgress(): number {
        switch (this.job()?.status) {
            case 'accepted':
                return 20;
            case 'arrived':
            case 'arrived_at_store':
                return 40;
            case 'shopping_in_progress':
            case 'in_progress':
                return 65;
            case 'collected':
            case 'en_route_to_customer':
            case 'delivered':
                return 85;
            case 'completed':
                return 100;
            default:
                return 10;
        }
    }

    actionBadgeVariant(): 'success' | 'warning' | 'error' | 'info' | 'secondary' | 'primary' {
        switch (this.job()?.status) {
            case 'completed':
                return 'success';
            case 'accepted':
            case 'arrived':
                return 'primary';
            case 'in_progress':
            case 'shopping_in_progress':
            case 'en_route_to_customer':
                return 'info';
            case 'cancelled':
                return 'error';
            default:
                return 'secondary';
        }
    }

    shortId(id?: string | null): string {
        return String(id || '').slice(0, 8) || 'N/A';
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(this.toNumber(amount));
    }

    hasRecordedErrandSpend(): boolean {
        const amount = this.toNumber(this.errandDetails()?.actual_spending);
        return amount > 0;
    }

    showErrandSpendTools(): boolean {
        if (this.job()?.service_slug !== ServiceTypeEnum.ERRAND) return false;

        return [
            'in_progress',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'delivered'
        ].includes(this.job()?.status || '');
    }

    toNumber(value: unknown): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private isValidCoordinate(value: number): boolean {
        return Number.isFinite(value) && Math.abs(value) > 0.000001;
    }

    private formatDuration(seconds: number | null): string {
        if (!seconds || !Number.isFinite(seconds)) return 'ETA unavailable';
        const minutes = Math.max(1, Math.round(seconds / 60));
        return `${minutes} min`;
    }

    private formatDistanceMeters(meters: number | null): string {
        if (!meters || !Number.isFinite(meters)) return 'Distance unavailable';
        if (meters < 1000) return `${Math.round(meters)} m`;
        return `${(meters / 1000).toFixed(1)} km`;
    }

    private titleCase(value: string): string {
        return value
            .replace(/[_-]/g, ' ')
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
        const toast = await this.toastCtrl.create({
            message,
            duration: 2200,
            color,
            position: 'top'
        });

        await toast.present();
    }
}
