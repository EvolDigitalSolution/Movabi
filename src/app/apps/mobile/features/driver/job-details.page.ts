import { Component, inject, signal, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, AlertController, LoadingController, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { call, chevronDown, chatbubbles, chevronBack } from 'ionicons/icons';
import { ActivatedRoute } from '@angular/router';
import { DriverService } from '../../../../core/services/driver/driver.service';
import { BookingStatus, DriverLocation } from '../../../../shared/models/booking.model';
import { ButtonComponent, BadgeComponent } from '../../../../shared/ui';
import { CommunicationPanelComponent } from '../../../../shared/ui/communication-panel';
import { MapComponent } from '../../../../shared/components/map/map.component';
import { RoutingService } from '../../../../core/services/maps/routing.service';
import { LocationService } from '../../../../core/services/logistics/location.service';
import { ServiceTypeSlug } from '../../../../core/models/maps/map-marker.model';
import { RealtimeChannel } from '@supabase/supabase-js';

@Component({
  selector: 'app-job-details',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" color="dark" text="" icon="chevron-back"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Job Execution</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      @if (job()) {
        <div class="flex flex-col h-full">
          <!-- Map Area -->
          <div class="h-[30vh] bg-slate-100 relative overflow-hidden z-10 shadow-lg">
            <app-map #map></app-map>
          </div>

          <!-- Job Info -->
          <div class="bg-white rounded-t-[3rem] shadow-[0_-20px_40px_-15px_rgba(0,0,0,0.1)] p-8 space-y-8 -mt-10 relative z-20 flex-1 overflow-y-auto">
            <div class="w-12 h-1.5 bg-slate-100 rounded-full mx-auto mb-2"></div>

            <div class="flex justify-between items-start">
              <div>
                <app-badge variant="primary" class="mb-2 uppercase tracking-widest text-[10px]">{{ job()?.status?.replace('_', ' ') }}</app-badge>
                <h2 class="text-2xl font-display font-bold text-slate-900 tracking-tight">Active Job</h2>
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">ID: {{ job()?.id?.slice(0,8) }}</p>
              </div>
              <div class="text-right">
                <p class="text-3xl font-display font-bold text-blue-600 tracking-tight">£{{ job()?.total_price }}</p>
                <p class="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Your Earning</p>
              </div>
            </div>

            <!-- Errand Funding Info -->
            @if (job()?.service_slug === 'errand' && job()?.errand_funding) {
              <div class="p-6 bg-emerald-50 rounded-3xl border border-emerald-100 space-y-4 animate-in fade-in slide-in-from-top-4">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-200">
                      <ion-icon name="wallet-outline" class="text-xl"></ion-icon>
                    </div>
                    <div>
                      <p class="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Wallet Funded</p>
                      <p class="text-sm font-bold text-slate-900">Reserved: £{{ job()?.errand_funding?.amount_reserved }}</p>
                    </div>
                  </div>
                  @if (job()?.errand_funding?.over_budget_status === 'requested') {
                    <app-badge variant="warning">Over-budget Pending</app-badge>
                  }
                </div>

                @if (job()?.errand_details?.items_list) {
                  <div class="pt-4 border-t border-emerald-100/50">
                    <p class="text-[10px] font-bold text-emerald-600 uppercase tracking-widest mb-2">Items to Buy</p>
                    <ul class="space-y-1">
                      @for (item of job()?.errand_details?.items_list; track item) {
                        <li class="text-xs font-medium text-slate-700 flex items-center gap-2">
                          <div class="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>
                          {{ item }}
                        </li>
                      }
                    </ul>
                  </div>
                }
              </div>
            }

            <!-- Customer Info -->
            <div class="flex items-center p-5 bg-slate-50 rounded-3xl border border-slate-100 shadow-sm">
              <div class="w-14 h-14 rounded-2xl overflow-hidden mr-4 border-2 border-white shadow-md">
                <img [src]="job()?.customer?.avatar_url || 'https://picsum.photos/seed/customer/200'" alt="Customer profile" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
              </div>
              <div class="flex-1">
                <h3 class="font-bold text-slate-900">{{ job()?.customer?.first_name }} {{ job()?.customer?.last_name }}</h3>
                <p class="text-xs text-slate-500 font-medium">Customer</p>
              </div>
              <app-button variant="secondary" size="sm" [fullWidth]="false" class="ml-2" (clicked)="callCustomer()">
                <ion-icon name="call" slot="icon-only"></ion-icon>
              </app-button>
            </div>

            <!-- Communication Panel Integration -->
            @if (['accepted', 'arrived', 'in_progress', 'arrived_at_store', 'shopping_in_progress', 'collected', 'en_route_to_customer'].includes(job()?.status || '')) {
              <div class="pt-2">
                <app-button variant="secondary" (clicked)="showChat.set(!showChat())">
                  <ion-icon [name]="showChat() ? 'chevron-down' : 'chatbubbles'" class="mr-2"></ion-icon>
                  {{ showChat() ? 'Hide Chat' : 'Message Customer' }}
                </app-button>
                
                @if (showChat()) {
                  <div class="mt-4 h-[400px] border border-slate-100 rounded-3xl overflow-hidden shadow-xl animate-in zoom-in-95 duration-300">
                    <app-communication-panel 
                      [jobId]="job()!.id" 
                      [receiverId]="job()!.customer_id!" 
                      [receiverPhone]="job()?.customer?.phone"
                    ></app-communication-panel>
                  </div>
                }
              </div>
            }

            <!-- Addresses -->
            <div class="space-y-6">
              <div class="flex gap-4">
                <div class="flex flex-col items-center gap-1">
                  <div class="w-3 h-3 rounded-full bg-blue-600 ring-4 ring-blue-100"></div>
                  <div class="w-0.5 h-12 bg-slate-100"></div>
                  <div class="w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-100"></div>
                </div>
                <div class="flex-1 space-y-6">
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Pickup</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-tight">{{ job()?.pickup_address }}</h3>
                  </div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Destination</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-tight">{{ job()?.dropoff_address }}</h3>
                  </div>
                </div>
              </div>
            </div>

            <!-- Errand Spending Section -->
            @if (job()?.service_slug === 'errand' && ['shopping_in_progress', 'collected', 'en_route_to_customer', 'delivered'].includes(job()?.status || '')) {
              <div class="p-6 bg-slate-50 rounded-3xl border border-slate-100 space-y-6 animate-in fade-in slide-in-from-bottom-4">
                <div class="flex items-center justify-between">
                  <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Spending Details</h3>
                  @if (job()?.errand_details?.actual_spending) {
                    <app-badge variant="success">Recorded: £{{ job()?.errand_details?.actual_spending }}</app-badge>
                  }
                </div>

                <div class="grid grid-cols-1 gap-4">
                  <app-button variant="outline" size="sm" (clicked)="recordSpend()">
                    <ion-icon name="cash-outline" class="mr-2"></ion-icon>
                    {{ job()?.errand_details?.actual_spending ? 'Update Spend' : 'Record Actual Spend' }}
                  </app-button>
                  
                  <app-button variant="outline" size="sm" (clicked)="uploadReceipt()">
                    <ion-icon name="receipt-outline" class="mr-2"></ion-icon>
                    {{ job()?.errand_details?.receipt_url ? 'Update Receipt' : 'Upload Receipt' }}
                  </app-button>

                  <app-button variant="secondary" size="sm" color="warning" (clicked)="requestOverBudget()">
                    <ion-icon name="alert-circle-outline" class="mr-2"></ion-icon>
                    Request Over-Budget
                  </app-button>
                </div>
              </div>
            }

            <!-- Actions -->
            <div class="pt-8 pb-12">
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
                      {{ submitting() ? 'Updating...' : 'I Have Delivered' }}
                    </app-button>
                  }
                  @case ('delivered') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="confirmCompletion()">
                      {{ submitting() ? 'Completing...' : 'Complete Errand' }}
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
                      {{ submitting() ? 'Starting...' : 'Start Trip' }}
                    </app-button>
                  }
                  @case ('in_progress') {
                    <app-button variant="primary" size="lg" [disabled]="submitting()" (clicked)="confirmCompletion()">
                      {{ submitting() ? 'Completing...' : 'Complete Trip' }}
                    </app-button>
                  }
                }
              }
            </div>
          </div>
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-full p-8 text-center space-y-6">
          <ion-spinner name="crescent" color="primary"></ion-spinner>
          <p class="text-slate-500 font-medium">Loading job details...</p>
        </div>
      }
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, ButtonComponent, BadgeComponent, CommunicationPanelComponent, MapComponent]
})
export class JobDetailsPage implements OnInit, OnDestroy {
  @ViewChild('map') mapComponent!: MapComponent;

  public route = inject(ActivatedRoute);
  private driverService = inject(DriverService);
  private nav = inject(NavController);
  private alertCtrl = inject(AlertController);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);
  private routing = inject(RoutingService);
  private locationService = inject(LocationService);

  job = this.driverService.activeJob;
  showChat = signal(false);
  submitting = signal(false);
  private locationSubscription?: RealtimeChannel;

  constructor() {
    addIcons({ call, chevronDown, chatbubbles, chevronBack });
  }

  ngOnInit() {
    const id = this.route.snapshot.params['id'];
    if (id && !this.job()) {
      // If we don't have active job in service, we should fetch it
      // For now we assume it's set by acceptJob or dashboard
    }
    this.initMap();
    this.subscribeToSelfLocation();
  }

  ngOnDestroy() {
    this.locationSubscription?.unsubscribe();
  }

  initMap() {
    const j = this.job();
    if (!j) return;

    const pickup = { lat: j.pickup_lat || 0, lng: j.pickup_lng || 0 };
    const dropoff = { lat: j.dropoff_lat || 0, lng: j.dropoff_lng || 0 };

    setTimeout(() => {
      if (!this.mapComponent) return;

      this.mapComponent.addOrUpdateMarker({
        id: 'pickup',
        coordinates: pickup,
        kind: 'pickup',
        serviceType: j.service_slug! as ServiceTypeSlug,
        label: 'PICKUP'
      });

      if (j.dropoff_lat) {
        this.mapComponent.addOrUpdateMarker({
          id: 'dropoff',
          coordinates: dropoff,
          kind: 'destination',
          serviceType: j.service_slug! as ServiceTypeSlug,
          label: 'DROPOFF'
        });

        this.routing.getRoute(pickup, dropoff).subscribe(route => {
          if (route) this.mapComponent.drawRoute(route);
        });
      }

      this.mapComponent.setCenter(pickup.lng, pickup.lat, 14);
    }, 500);
  }

  subscribeToSelfLocation() {
    const j = this.job();
    if (!j || !j.driver_id) return;

    this.locationSubscription = this.locationService.subscribeToDriverLocation(j.driver_id, (location) => {
      this.updateDriverMarker(location);
    });
  }

  updateDriverMarker(location: DriverLocation) {
    if (!this.mapComponent) return;
    const j = this.job();
    if (!j) return;

    this.mapComponent.addOrUpdateMarker({
      id: 'driver',
      coordinates: { lat: location.lat, lng: location.lng },
      kind: 'driver',
      serviceType: j.service_slug! as ServiceTypeSlug,
      heading: location.heading
    });
  }

  async updateStatus(status: BookingStatus) {
    if (this.submitting()) return;

    this.submitting.set(true);
    const loading = await this.loadingCtrl.create({ message: 'Updating status...' });
    await loading.present();
    try {
      if (status === 'completed') {
        await this.driverService.completeJob(this.job()!.id);
      } else {
        await this.driverService.updateJobStatus(this.job()!.id, status);
      }
      await loading.dismiss();
      this.submitting.set(false);
    } catch (e: unknown) {
      await loading.dismiss();
      this.submitting.set(false);
      const message = e instanceof Error ? e.message : 'Failed to update status';
      const toast = await this.toastCtrl.create({ 
        message, 
        duration: 2000, 
        color: 'danger' 
      });
      toast.present();
    }
  }

  async confirmCompletion() {
    const alert = await this.alertCtrl.create({
      header: 'Complete Trip?',
      message: 'Confirm that you have reached the destination and delivered the service.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { 
          text: 'Complete', 
          handler: async () => {
            await this.updateStatus('completed');
            this.nav.navigateRoot('/driver');
          }
        }
      ]
    });
    await alert.present();
  }

  callCustomer() {
    const phone = this.job()?.customer?.phone;
    if (phone) {
      window.open(`tel:${phone}`, '_system');
    }
  }

  async recordSpend() {
    const alert = await this.alertCtrl.create({
      header: 'Record Actual Spend',
      message: 'Enter the total amount spent on items.',
      inputs: [
        {
          name: 'amount',
          type: 'number',
          placeholder: 'Amount (e.g. 25.50)',
          value: this.job()?.errand_details?.actual_spending
        },
        {
          name: 'notes',
          type: 'textarea',
          placeholder: 'Spending notes (optional)',
          value: this.job()?.errand_details?.spending_notes
        }
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Save',
          handler: async (data) => {
            if (!data.amount) return false;
            const loading = await this.loadingCtrl.create({ message: 'Saving...' });
            await loading.present();
            try {
              await this.driverService.recordErrandSpending(this.job()!.id, parseFloat(data.amount), data.notes);
              await loading.dismiss();
            } catch {
              await loading.dismiss();
              const toast = await this.toastCtrl.create({ message: 'Failed to save spend', duration: 2000, color: 'danger' });
              toast.present();
            }
            return true;
          }
        }
      ]
    });
    await alert.present();
  }

  async uploadReceipt() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (event: Event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;

      const loading = await this.loadingCtrl.create({ message: 'Uploading receipt...' });
      await loading.present();

      try {
        await this.driverService.uploadErrandReceipt(this.job()!.id, file);
        await loading.dismiss();
        const toast = await this.toastCtrl.create({ message: 'Receipt uploaded successfully', duration: 2000, color: 'success' });
        toast.present();
      } catch {
        await loading.dismiss();
        const toast = await this.toastCtrl.create({ message: 'Failed to upload receipt', duration: 2000, color: 'danger' });
        toast.present();
      }
    };
    input.click();
  }

  async requestOverBudget() {
    const alert = await this.alertCtrl.create({
      header: 'Request Over-Budget',
      message: 'Enter the new total amount required for items.',
      inputs: [
        {
          name: 'amount',
          type: 'number',
          placeholder: 'New Total (e.g. 50.00)'
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
          handler: async (data) => {
            if (!data.amount || !data.reason) return false;
            const loading = await this.loadingCtrl.create({ message: 'Requesting...' });
            await loading.present();
            try {
              await this.driverService.requestOverBudget(this.job()!.id, parseFloat(data.amount), data.reason);
              await loading.dismiss();
              const toast = await this.toastCtrl.create({ message: 'Request sent to customer', duration: 3000, color: 'success' });
              toast.present();
            } catch {
              await loading.dismiss();
              const toast = await this.toastCtrl.create({ message: 'Failed to send request', duration: 2000, color: 'danger' });
              toast.present();
            }
            return true;
          }
        }
      ]
    });
    await alert.present();
  }
}
