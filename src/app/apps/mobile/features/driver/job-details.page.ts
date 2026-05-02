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
import { BookingStatus, DriverLocation, Booking } from '../../../../shared/models/booking.model';
import { ButtonComponent, BadgeComponent } from '../../../../shared/ui';
import { CommunicationPanelComponent } from '../../../../shared/ui/communication-panel';
import { MapComponent } from '../../../../shared/components/map/map.component';
import { RoutingService } from '../../../../core/services/maps/routing.service';
import { LocationService } from '../../../../core/services/logistics/location.service';
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
                  <button type="button" (click)="openMap(job()?.pickup_address)" class="block text-left w-full">
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Pickup</p>
                    <h3 class="text-sm font-black text-slate-950 leading-tight">{{ job()?.pickup_address || 'Pickup unavailable' }}</h3>
                    <p class="text-xs text-blue-600 font-bold mt-1">Open map</p>
                  </button>

                  <button type="button" (click)="openMap(job()?.dropoff_address)" class="block text-left w-full">
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Destination</p>
                    <h3 class="text-sm font-black text-slate-950 leading-tight">{{ job()?.dropoff_address || 'Destination unavailable' }}</h3>
                    <p class="text-xs text-emerald-600 font-bold mt-1">Open map</p>
                  </button>
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
    public nav = inject(NavController);
    private alertCtrl = inject(AlertController);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private routing = inject(RoutingService);
    private locationService = inject(LocationService);
    private config = inject(AppConfigService);

    job = this.driverService.activeJob;
    showChat = signal(false);
    submitting = signal(false);
    loadingJob = signal(true);

    private locationSubscription?: RealtimeChannel;
    private routeId: string | null = null;
    private mapReady = false;

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
            }

            this.initMap();
        } catch (error) {
            console.error('Failed to load request:', error);
            this.driverService.activeJob.set(null);
        } finally {
            this.loadingJob.set(false);
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

        return `${first} ${last}`.trim() || 'Customer';
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

    openMap(address?: string | null) {
        const safeAddress = String(address || '').trim();

        if (!safeAddress) {
            void this.showToast('Address is unavailable.', 'warning');
            return;
        }

        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(safeAddress)}`, '_blank');
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