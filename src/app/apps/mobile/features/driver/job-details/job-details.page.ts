import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
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
        BadgeComponent
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
          <div class="relative overflow-hidden bg-gradient-to-br from-blue-600 via-blue-700 to-slate-950 rounded-[2rem] p-6 text-white shadow-2xl shadow-blue-600/20">
            <div class="absolute -right-12 -bottom-16 w-48 h-48 rounded-full bg-white/10 blur-2xl"></div>
            <ion-icon name="navigate" class="absolute -right-8 -bottom-8 text-[10rem] text-white/10 rotate-12"></ion-icon>

            <div class="relative z-10">
              <div class="flex items-start justify-between gap-4 mb-8">
                <div class="min-w-0">
                  <app-badge variant="primary">
                    {{ serviceName() }}
                  </app-badge>

                  <h2 class="text-3xl font-display font-black tracking-tight mt-4 capitalize">
                    {{ formatStatus(job()?.status) }}
                  </h2>

                  <p class="text-blue-100/80 font-bold mt-1 text-[10px] uppercase tracking-[0.2em]">
                    ID: {{ shortId(job()?.id) }}
                  </p>
                </div>

                <div class="text-right shrink-0">
                  <p class="text-[10px] uppercase tracking-[0.2em] text-blue-100/80 font-black mb-1">
                    Payout
                  </p>
                  <span class="text-3xl font-display font-black">
                    {{ formatPrice(job()?.total_price || job()?.price || 0) }}
                  </span>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  (click)="openMap(job()?.pickup_address)"
                  class="h-12 rounded-2xl bg-white text-blue-700 font-black text-sm shadow-xl shadow-blue-950/10 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                >
                  <ion-icon name="location-outline"></ion-icon>
                  Pickup
                </button>

                <button
                  type="button"
                  (click)="openMap(job()?.dropoff_address)"
                  class="h-12 rounded-2xl bg-white/10 border border-white/15 text-white font-black text-sm active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                >
                  <ion-icon name="flag-outline"></ion-icon>
                  Destination
                </button>
              </div>
            </div>
          </div>

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
                  <p class="text-xs text-slate-500 font-bold uppercase tracking-widest">
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
                <p class="text-[10px] text-slate-400 uppercase font-black tracking-widest mb-1">Pickup</p>
                <p class="font-bold text-slate-950 leading-snug">{{ job()?.pickup_address || 'Pickup unavailable' }}</p>
              </div>

              <div class="relative">
                <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                <p class="text-[10px] text-slate-400 uppercase font-black tracking-widest mb-1">Destination</p>
                <p class="font-bold text-slate-950 leading-snug">{{ job()?.dropoff_address || 'Destination unavailable' }}</p>
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
                <p class="text-[11px] text-slate-400 font-bold uppercase tracking-widest">
                  {{ serviceName() }}
                </p>
              </div>
            </div>

            @if (details()) {
              @if (job()?.service_slug === ServiceTypeEnum.RIDE) {
                <div class="space-y-3">
                  <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center">
                    <span class="text-sm font-bold text-slate-600">Passengers</span>
                    <span class="text-xl font-display font-black text-slate-950">{{ anyDetails()?.passenger_count || 1 }}</span>
                  </div>

                  @if (anyDetails()?.notes) {
                    <div class="p-4 bg-blue-50 rounded-2xl border border-blue-100">
                      <p class="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-2">Customer Notes</p>
                      <p class="text-sm text-slate-700 leading-relaxed">{{ anyDetails()?.notes }}</p>
                    </div>
                  }
                </div>
              }

              @if (job()?.service_slug === ServiceTypeEnum.DELIVERY) {
                <div class="space-y-3">
                  <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Package</p>
                    <p class="text-sm font-bold text-slate-800">{{ anyDetails()?.package_description || 'Package details not provided' }}</p>
                  </div>

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
                        [class.text-emerald-600]="toNumber(errandDetails()?.actual_spending) <= toNumber(errandDetails()?.estimated_budget)"
                        [class.text-rose-600]="toNumber(errandDetails()?.actual_spending) > toNumber(errandDetails()?.estimated_budget)"
                      >
                        {{ formatPrice(errandDetails()?.actual_spending || 0) }}
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

                  @if (job()?.status === 'in_progress') {
                    <div class="grid grid-cols-2 gap-3 pt-2">
                      <app-button variant="secondary" size="sm" (clicked)="recordSpending()">
                        Record Spend
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
    private route = inject(ActivatedRoute);
    private driverService = inject(DriverService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private alertCtrl = inject(AlertController);
    public nav = inject(NavController);
    private bookingService = inject(BookingService);
    public config = inject(AppConfigService);

    ServiceTypeEnum = ServiceTypeEnum;

    job = this.driverService.activeJob;
    details = signal<JobDetails | null>(null);
    anyDetails = computed(() => this.details() as any);
    errandDetails = computed(() => this.details() as ErrandDetails | null);
    funding = signal<ErrandFunding | null>(null);
    isLoading = signal(true);

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

    private channel?: RealtimeChannel;

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
        } catch (error) {
            console.error('Failed to load request details:', error);
            this.driverService.activeJob.set(null);
        } finally {
            this.isLoading.set(false);
        }
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
            await this.driverService.recordErrandSpending(jobId, amount, notes);
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
            await this.driverService.uploadErrandReceipt(currentJob.id, file);
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

    customerName(): string {
        const customer = (this.job() as any)?.customer;
        const first = String(customer?.first_name || '').trim();
        const last = String(customer?.last_name || '').trim();
        const full = `${first} ${last}`.trim();

        return full || 'Customer';
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

    shortId(id?: string | null): string {
        return String(id || '').slice(0, 8) || 'N/A';
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(this.toNumber(amount));
    }

    toNumber(value: unknown): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
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