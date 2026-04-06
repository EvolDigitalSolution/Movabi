import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, LoadingController, ToastController, AlertController } from '@ionic/angular';
import { ActivatedRoute } from '@angular/router';
import { DriverService } from '../../../../../core/services/driver/driver.service';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { BookingStatus, ServiceTypeEnum } from '../../../../../shared/models/booking.model';

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
                <span class="text-4xl font-display font-bold">£{{ job()?.total_price }}</span>
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
                  @if (job()?.service_code === ServiceTypeEnum.RIDE) {
                    <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100 flex justify-between items-center">
                      <span class="text-sm font-bold text-slate-600">Passengers</span>
                      <span class="text-xl font-display font-bold text-slate-900">{{ details()!['passenger_count'] }}</span>
                    </div>
                    @if (details()!['notes']) {
                      <div class="p-5 bg-blue-50/50 rounded-3xl border border-blue-100/50">
                        <p class="text-[10px] font-bold text-blue-600 uppercase tracking-widest mb-2">Customer Notes</p>
                        <p class="text-sm text-slate-700 italic leading-relaxed">"{{ details()!['notes'] }}"</p>
                      </div>
                    }
                  }

                  @if (job()?.service_code === ServiceTypeEnum.ERRAND) {
                    <div class="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Shopping List</p>
                      <div class="flex flex-wrap gap-2 mb-6">
                        @for (item of itemsList(); track item) {
                          <app-badge variant="primary" class="bg-white border-slate-100 text-slate-600">{{ item }}</app-badge>
                        }
                      </div>
                      @if (details()!['estimated_budget']) {
                        <div class="flex justify-between items-center pt-4 border-t border-slate-200/50">
                          <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Budget</span>
                          <span class="text-xl font-display font-bold text-emerald-600">£{{ details()!['estimated_budget'] }}</span>
                        </div>
                      }
                    </div>
                    @if (details()!['delivery_instructions']) {
                      <div class="p-5 bg-blue-50/50 rounded-3xl border border-blue-100/50">
                        <p class="text-[10px] font-bold text-blue-600 uppercase tracking-widest mb-2">Instructions</p>
                        <p class="text-sm text-slate-700 italic leading-relaxed">"{{ details()!['delivery_instructions'] }}"</p>
                      </div>
                    }
                  }

                  @if (job()?.service_code === ServiceTypeEnum.VAN) {
                    <div class="grid grid-cols-2 gap-4">
                      <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100">
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Helpers</p>
                        <p class="text-xl font-display font-bold text-slate-900">{{ details()!['helper_count'] }}</p>
                      </div>
                      <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100">
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Floor</p>
                        <p class="text-xl font-display font-bold text-slate-900">{{ details()!['floor_number'] || '0' }}</p>
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
export class JobDetailsPage implements OnInit {
  private route = inject(ActivatedRoute);
  private driverService = inject(DriverService);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);
  private alertCtrl = inject(AlertController);
  public nav = inject(NavController);
  private bookingService = inject(BookingService);

  ServiceTypeEnum = ServiceTypeEnum;
  job = this.driverService.activeJob;
  details = signal<Record<string, string | number | boolean | string[] | null | undefined> | null>(null);
  isLoading = signal(true);
  itemsList = computed(() => (this.details()?.['items_list'] as string[]) || []);

  ngOnInit() {
    const id = this.route.snapshot.params['id'];
    this.loadJob(id);
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
        const details = await this.bookingService.getBookingDetails(currentJob.id, currentJob.service_code);
        this.details.set(details as Record<string, string | number | boolean | string[] | null | undefined>);
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
    const alert = await this.alertCtrl.create({
      header: 'Complete Trip',
      message: 'Are you sure you want to complete this trip?',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Complete',
          handler: async () => {
            await this.updateStatus('completed');
          }
        }
      ]
    });
    await alert.present();
  }
}
