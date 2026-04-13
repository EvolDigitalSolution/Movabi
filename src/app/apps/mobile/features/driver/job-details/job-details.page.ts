import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, LoadingController, ToastController, AlertController, ActionSheetController } from '@ionic/angular';
import { ActivatedRoute } from '@angular/router';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import { DriverService } from '../../../../../core/services/driver/driver.service';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { BookingStatus, ServiceTypeEnum, ErrandDetails, RideDetails, DeliveryDetails, VanDetails, ErrandFunding } from '../../../../../shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';

import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../../shared/ui';

@Component({
  selector: 'app-job-details',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Job Details</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding bg-slate-50">
      <div class="max-w-2xl mx-auto space-y-8 pb-12">
        @if (job()) {
          <!-- Job Summary Card -->
          <div class="bg-blue-600 rounded-[2.5rem] p-10 text-white shadow-2xl shadow-blue-600/20 relative overflow-hidden">
            <div class="relative z-10">
              <div class="flex justify-between items-center mb-8">
                <app-badge variant="primary" class="bg-white/20 text-white border-white/30">{{ job()?.service_type?.name }}</app-badge>
                <span class="text-4xl font-display font-bold">{{ config.formatCurrency(job()?.total_price) }}</span>
              </div>
              <h2 class="text-3xl font-display font-bold capitalize tracking-tight">{{ job()?.status?.replace('_', ' ') }}</h2>
              <p class="text-blue-100/80 font-medium mt-1 text-sm uppercase tracking-widest">ID: {{ job()?.id?.slice(0,8) }}</p>
            </div>
            <ion-icon name="navigate" class="absolute -right-6 -bottom-6 text-[12rem] text-white/10 rotate-12"></ion-icon>
          </div>

          <!-- Customer & Route Card -->
          <app-card class="p-8">
            <h3 class="text-xs font-bold text-slate-400 uppercase tracking-widest mb-6">Customer Information</h3>
            <div class="flex items-center mb-10 group">
              <div class="w-16 h-16 rounded-2xl overflow-hidden mr-5 border-4 border-slate-50 shadow-lg shadow-slate-200/50">
                <img src="https://picsum.photos/seed/customer/200" alt="Customer profile" class="w-full h-full object-cover" />
              </div>
              <div class="flex-1 min-w-0">
                <h4 class="text-xl font-bold text-slate-900 truncate">{{ job()?.customer?.first_name || 'Customer' }}</h4>
                <p class="text-sm text-slate-500 font-medium">Verified Customer</p>
              </div>
              <app-button variant="secondary" size="sm" [fullWidth]="false" class="h-12 w-12 rounded-2xl">
                <ion-icon name="call" slot="icon-only" class="text-xl"></ion-icon>
              </app-button>
            </div>

            <div class="relative pl-8 space-y-8">
              <!-- Vertical Line -->
              <div class="absolute left-[9px] top-2 bottom-2 w-0.5 bg-slate-100"></div>

              <div class="relative">
                <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                <div>
                  <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">Pickup</p>
                  <p class="font-bold text-slate-900 leading-snug">{{ job()?.pickup_address }}</p>
                </div>
              </div>
              <div class="relative">
                <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                <div>
                  <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">Destination</p>
                  <p class="font-bold text-slate-900 leading-snug">{{ job()?.dropoff_address }}</p>
                </div>
              </div>
            </div>

            @if (details()) {
              <div class="mt-10 pt-10 border-t border-slate-50">
                <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-6">Service Requirements</h3>
                
                <div class="space-y-4">
                  @if (job()?.service_slug === ServiceTypeEnum.RIDE) {
                    <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100 flex justify-between items-center">
                      <span class="text-sm font-bold text-slate-600">Passengers</span>
                      <span class="text-xl font-display font-bold text-slate-900">{{ anyDetails()['passenger_count'] }}</span>
                    </div>
                    @if (anyDetails()['notes']) {
                      <div class="p-5 bg-blue-50/50 rounded-3xl border border-blue-100/50">
                        <p class="text-[10px] font-bold text-blue-600 uppercase tracking-widest mb-2">Customer Notes</p>
                        <p class="text-sm text-slate-700 italic leading-relaxed">"{{ anyDetails()['notes'] }}"</p>
                      </div>
                    }
                  }

                  @if (job()?.service_slug === ServiceTypeEnum.ERRAND) {
                    <div class="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
                      <div class="flex justify-between items-center mb-4">
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Shopping List</p>
                        @if (errandDetails()?.receipt_url) {
                          <app-badge variant="primary" class="bg-emerald-100 text-emerald-700 border-emerald-200">
                            <ion-icon name="checkmark-done" class="mr-1"></ion-icon>
                            Receipt Uploaded
                          </app-badge>
                        }
                      </div>
                      <div class="flex flex-wrap gap-2 mb-6">
                        @for (item of itemsList(); track item) {
                          <app-badge variant="primary" class="bg-white border-slate-100 text-slate-600">{{ item }}</app-badge>
                        }
                      </div>
                      
                      <div class="pt-4 border-t border-slate-200/50 space-y-4">
                        <div class="flex items-center justify-between">
                          <div>
                            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Initial Budget</p>
                            <p class="text-lg font-display font-bold text-slate-900">{{ config.formatCurrency(errandDetails()?.estimated_budget) }}</p>
                          </div>
                          <div class="text-right">
                            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Spent</p>
                            <p class="text-lg font-display font-bold" [class.text-emerald-600]="(errandDetails()?.actual_spending || 0) <= (errandDetails()?.estimated_budget || 0)" [class.text-rose-600]="(errandDetails()?.actual_spending || 0) > (errandDetails()?.estimated_budget || 0)">
                              {{ config.formatCurrency(errandDetails()?.actual_spending) }}
                            </p>
                          </div>
                        </div>

                        @if (funding()?.over_budget_status !== 'none') {
                          <div class="p-4 rounded-2xl border" [class]="funding()?.over_budget_status === 'approved' ? 'bg-emerald-50 border-emerald-100' : funding()?.over_budget_status === 'requested' ? 'bg-amber-50 border-amber-100' : 'bg-rose-50 border-rose-100'">
                            <div class="flex justify-between items-center">
                              <span class="text-[10px] font-bold uppercase tracking-widest" [class]="funding()?.over_budget_status === 'approved' ? 'text-emerald-600' : funding()?.over_budget_status === 'requested' ? 'text-amber-600' : 'text-rose-600'">
                                Over Budget: {{ funding()?.over_budget_status }}
                              </span>
                              <span class="font-bold text-slate-900">{{ config.formatCurrency(funding()?.over_budget_amount) }}</span>
                            </div>
                          </div>
                        }
                      </div>

                      @if (job()?.status === 'in_progress') {
                        <div class="grid grid-cols-2 gap-3 pt-6">
                          <app-button variant="secondary" size="sm" (click)="recordSpending()">
                            <ion-icon name="receipt-outline" slot="start"></ion-icon>
                            Record Spend
                          </app-button>
                          <app-button variant="secondary" size="sm" (click)="requestOverBudget()">
                            <ion-icon name="add-outline" slot="start"></ion-icon>
                            Extra Budget
                          </app-button>
                        </div>
                        
                        <div class="mt-3">
                          <input type="file" #receiptInput class="hidden" (change)="onReceiptSelected($event)" accept="image/*">
                          <app-button variant="secondary" size="sm" class="w-full" (click)="receiptInput.click()">
                            <ion-icon name="camera-outline" slot="start"></ion-icon>
                            {{ errandDetails()?.receipt_url ? 'Update Receipt' : 'Upload Receipt' }}
                          </app-button>
                        </div>
                      }
                    </div>

                    <!-- Contact Info -->
                    <div class="grid grid-cols-2 gap-4 mt-6">
                      <app-card class="p-5">
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Customer</p>
                        <div class="flex items-center justify-between">
                          <span class="text-xs font-bold text-slate-900">Call</span>
                          <app-button variant="secondary" size="sm" (click)="callPhone(anyDetails()['customer_phone']?.toString())" class="h-10 w-10">
                            <ion-icon name="call-outline" slot="icon-only"></ion-icon>
                          </app-button>
                        </div>
                      </app-card>

                      @if (anyDetails()['recipient_phone']) {
                        <app-card class="p-5">
                          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Recipient</p>
                          <div class="flex items-center justify-between">
                            <span class="text-xs font-bold text-slate-900">Call</span>
                            <app-button variant="secondary" size="sm" (click)="callPhone(anyDetails()['recipient_phone']?.toString())" class="h-10 w-10">
                              <ion-icon name="call-outline" slot="icon-only"></ion-icon>
                            </app-button>
                          </div>
                        </app-card>
                      }
                    </div>

                    @if (anyDetails()['delivery_instructions']) {
                      <div class="p-5 bg-blue-50/50 rounded-3xl border border-blue-100/50 mt-6">
                        <p class="text-[10px] font-bold text-blue-600 uppercase tracking-widest mb-2">Instructions</p>
                        <p class="text-sm text-slate-700 italic leading-relaxed">"{{ anyDetails()['delivery_instructions'] }}"</p>
                      </div>
                    }
                  }

                  @if (job()?.service_slug === ServiceTypeEnum.VAN) {
                    <div class="grid grid-cols-2 gap-4">
                      <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100">
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Helpers</p>
                        <p class="text-xl font-display font-bold text-slate-900">{{ anyDetails()['helper_count'] }}</p>
                      </div>
                      <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100">
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Floor</p>
                        <p class="text-xl font-display font-bold text-slate-900">{{ anyDetails()['floor_number'] || '0' }}</p>
                      </div>
                    </div>
                  }
                </div>
              </div>
            }
          </app-card>

          <div class="pt-4">
            @switch (job()?.status) {
              @case ('accepted') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-blue-600/20" (click)="updateStatus('arrived')">
                  I Have Arrived
                </app-button>
              }
              @case ('arrived') {
                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-blue-600/20" (click)="updateStatus('in_progress')">
                  Start Trip
                </app-button>
              }
              @case ('in_progress') {
                @if (job()?.service_slug === ServiceTypeEnum.ERRAND) {
                  <div class="space-y-4 mb-6">
                    <div class="p-6 bg-emerald-50 rounded-[2rem] border border-emerald-100">
                      <div class="flex justify-between items-center mb-4">
                        <span class="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Errand Budget</span>
                        <span class="text-xl font-display font-bold text-emerald-700">{{ config.formatCurrency(anyDetails()['estimated_budget']) }}</span>
                      </div>
                      <div class="flex justify-between items-center">
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Actual Spending</span>
                        <span class="text-xl font-display font-bold text-slate-900">{{ config.formatCurrency(anyDetails()['actual_spending']) }}</span>
                      </div>
                    </div>
                    
                    <app-button variant="secondary" size="lg" class="w-full h-14 rounded-2xl border-emerald-200 text-emerald-700 hover:bg-emerald-50" (click)="recordSpending()">
                      <ion-icon name="receipt-outline" slot="start" class="mr-2"></ion-icon>
                      Record Spending
                    </app-button>
                  </div>
                }

                <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-emerald-600/20 bg-emerald-600 border-emerald-600" (click)="completeTrip()">
                  Complete Trip
                </app-button>
              }
              @case ('completed') {
                <div class="bg-emerald-50 p-10 rounded-[2.5rem] text-center border border-emerald-100 animate-in zoom-in duration-500">
                  <div class="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
                    <ion-icon name="checkmark-circle" class="text-5xl text-emerald-600"></ion-icon>
                  </div>
                  <h3 class="text-2xl font-display font-bold text-slate-900 mb-2">Trip Completed!</h3>
                  <p class="text-slate-600 font-medium mb-8">Earnings have been added to your wallet.</p>
                  <app-button variant="secondary" size="lg" (click)="nav.navigateRoot('/driver')" class="w-full">
                    Back to Dashboard
                  </app-button>
                </div>
              }
            }
          </div>
        } @else {
          <div class="flex flex-col items-center justify-center h-full py-20 text-center space-y-8">
            @if (isLoading()) {
              <div class="w-20 h-20 bg-white rounded-[2rem] flex items-center justify-center shadow-2xl shadow-slate-200/50 border border-slate-100">
                <ion-spinner name="crescent" color="primary"></ion-spinner>
              </div>
              <div class="space-y-2">
                <h3 class="text-xl font-display font-bold text-slate-900">Loading job</h3>
                <p class="text-slate-500 font-medium">Retrieving details...</p>
              </div>
            } @else {
              <div class="w-24 h-24 bg-red-50 rounded-[2.5rem] flex items-center justify-center text-red-500 border border-red-100 mb-4">
                <ion-icon name="alert-circle-outline" class="text-5xl"></ion-icon>
              </div>
              <div class="space-y-3">
                <h3 class="text-2xl font-display font-bold text-slate-900">Job Not Found</h3>
                <p class="text-slate-500 font-medium max-w-xs mx-auto leading-relaxed">This job may have been cancelled or assigned to another driver.</p>
              </div>
              <app-button variant="secondary" size="lg" (click)="nav.navigateRoot('/driver')" class="w-full">
                Back to Dashboard
              </app-button>
            }
          </div>
        }
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, CardComponent, ButtonComponent, BadgeComponent]
})
export class JobDetailsPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private driverService = inject(DriverService);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);
  private alertCtrl = inject(AlertController);
  private actionSheetCtrl = inject(ActionSheetController);
  public nav = inject(NavController);
  private bookingService = inject(BookingService);
  public config = inject(AppConfigService);

  ServiceTypeEnum = ServiceTypeEnum;
  job = this.driverService.activeJob;
  details = signal<ErrandDetails | RideDetails | DeliveryDetails | VanDetails | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anyDetails = computed(() => this.details() as any);
  errandDetails = computed(() => this.details() as ErrandDetails);
  funding = signal<ErrandFunding | null>(null);
  isLoading = signal(true);
  itemsList = computed(() => ((this.details() as ErrandDetails)?.items_list as string[]) || []);
  private channel?: RealtimeChannel;

  ngOnInit() {
    const id = this.route.snapshot.params['id'];
    this.loadJob(id);
    if (id) {
      this.channel = this.bookingService.subscribeToBooking(id);
    }
  }

  ngOnDestroy() {
    this.channel?.unsubscribe();
  }

  async loadJob(id: string) {
    if (!id) {
      this.isLoading.set(false);
      return;
    }
    
    this.isLoading.set(true);
    // If not in state, we might need to fetch it (simplified)
    if (!this.job() || this.job()?.id !== id) {
      await this.driverService.fetchAvailableJobs();
    }

    const currentJob = this.job();
    if (currentJob) {
      try {
        const details = await this.bookingService.getBookingDetails(currentJob.id, currentJob.service_slug);
        this.details.set(details as ErrandDetails | RideDetails | DeliveryDetails | VanDetails);

        if (currentJob.service_slug === ServiceTypeEnum.ERRAND) {
          const funding = await this.bookingService.getErrandFunding(currentJob.id);
          this.funding.set(funding);
        }
      } catch (e) {
        console.error('Failed to load job details', e);
      }
    }
    this.isLoading.set(false);
  }

  async updateStatus(status: BookingStatus) {
    const loading = await this.loadingCtrl.create({ message: 'Updating status...' });
    await loading.present();

    try {
      await this.driverService.updateJobStatus(this.job()!.id, status);
      await loading.dismiss();
    } catch (e: unknown) {
      await loading.dismiss();
      const message = e instanceof Error ? e.message : 'Update failed';
      const toast = await this.toastCtrl.create({ message, duration: 2000, color: 'danger' });
      toast.present();
    }
  }

  async completeTrip() {
    if (this.job()?.service_slug === ServiceTypeEnum.ERRAND) {
      const errandDetails = this.details() as ErrandDetails;
      if (!errandDetails.actual_spending || errandDetails.actual_spending <= 0) {
        const toast = await this.toastCtrl.create({
          message: 'Please record the actual spending before completing the trip.',
          duration: 3000,
          color: 'warning'
        });
        toast.present();
        return;
      }

      if (!errandDetails.receipt_url) {
        const confirm = await this.alertCtrl.create({
          header: 'Missing Receipt',
          message: 'You haven\'t uploaded a receipt. Are you sure you want to complete without one?',
          buttons: [
            { text: 'Upload Now', role: 'cancel' },
            { text: 'Complete Anyway', handler: () => this.executeCompletion() }
          ]
        });
        await confirm.present();
        return;
      }
    }

    const alert = await this.alertCtrl.create({
      header: 'Complete Trip',
      message: 'Are you sure you want to complete this trip?',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Complete',
          handler: () => this.executeCompletion()
        }
      ]
    });
    await alert.present();
  }

  private async executeCompletion() {
    await this.updateStatus('completed');
  }

  async recordSpending() {
    const alert = await this.alertCtrl.create({
      header: 'Record Spending',
      message: 'Enter the actual amount spent on items.',
      inputs: [
        {
          name: 'amount',
          type: 'number',
          placeholder: 'Amount (e.g. 15.50)',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          value: (this.details() as any)?.['actual_spending']
        },
        {
          name: 'notes',
          type: 'textarea',
          placeholder: 'Notes (optional)',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          value: (this.details() as any)?.['spending_notes']
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
              await this.loadJob(this.job()!.id); // Refresh
              await loading.dismiss();
              
              const toast = await this.toastCtrl.create({ message: 'Spending recorded successfully', duration: 2000, color: 'success' });
              toast.present();
              return true;
            } catch (e: unknown) {
              await loading.dismiss();
              const message = e instanceof Error ? e.message : 'Failed to save';
              const toast = await this.toastCtrl.create({ message, duration: 2000, color: 'danger' });
              toast.present();
              return false;
            }
          }
        }
      ]
    });
    await alert.present();
  }

  async requestOverBudget() {
    const alert = await this.alertCtrl.create({
      header: 'Request Over Budget',
      subHeader: 'Ask customer to approve additional funds',
      inputs: [
        {
          name: 'amount',
          type: 'number',
          placeholder: 'Additional amount needed (£)',
        },
        {
          name: 'reason',
          type: 'textarea',
          placeholder: 'Reason for over budget',
        }
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Request',
          handler: async (data) => {
            if (!data.amount) return false;
            const loading = await this.loadingCtrl.create({ message: 'Sending request...' });
            await loading.present();
            try {
              await this.driverService.requestOverBudget(this.job()!.id, parseFloat(data.amount), data.reason);
              await this.loadJob(this.job()!.id); // Refresh to show requested status
              await loading.dismiss();
              const toast = await this.toastCtrl.create({ message: 'Request sent to customer', duration: 3000, color: 'success' });
              toast.present();
              return true;
            } catch (error) {
              console.error('Over budget request failed', error);
              await loading.dismiss();
              return false;
            }
          }
        }
      ]
    });
    await alert.present();
  }

  async onReceiptSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    const loading = await this.loadingCtrl.create({ message: 'Uploading receipt...' });
    await loading.present();

    try {
      await this.driverService.uploadErrandReceipt(this.job()!.id, file);
      await this.loadJob(this.job()!.id);
      await loading.dismiss();
      const toast = await this.toastCtrl.create({ message: 'Receipt uploaded successfully', duration: 2000, color: 'success' });
      toast.present();
    } catch (e: unknown) {
      await loading.dismiss();
      const message = e instanceof Error ? e.message : 'Upload failed';
      const toast = await this.toastCtrl.create({ message, duration: 2000, color: 'danger' });
      toast.present();
    }
  }

  callPhone(phone?: string) {
    if (phone) {
      window.open(`tel:${phone}`, '_system');
    }
  }
}
