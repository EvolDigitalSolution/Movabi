import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, LoadingController, ToastController, AlertController } from '@ionic/angular';
import { ActivatedRoute } from '@angular/router';
import { DriverService } from '../../../../../core/services/driver/driver.service';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { BookingStatus, ServiceTypeEnum } from '../../../../../shared/models/booking.model';

@Component({
  selector: 'app-job-details',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver"></ion-back-button>
        </ion-buttons>
        <ion-title>Job Details</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      @if (job()) {
        <div class="mb-8 p-6 bg-blue-600 rounded-3xl text-white shadow-lg relative overflow-hidden">
          <div class="relative z-10">
            <div class="flex justify-between items-center mb-4">
              <ion-badge color="light" class="uppercase">{{ job()?.service_type?.name }}</ion-badge>
              <span class="text-2xl font-bold">{{ '$' }}{{ job()?.total_price }}</span>
            </div>
            <h2 class="text-3xl font-bold capitalize">{{ job()?.status?.replace('_', ' ') }}</h2>
            <p class="text-blue-100 mt-1">Booking ID: {{ job()?.id?.slice(0,8) }}</p>
          </div>
          <ion-icon name="navigate" class="absolute -right-4 -bottom-4 text-9xl text-white/10 rotate-12"></ion-icon>
        </div>

        <div class="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm mb-8">
          <h3 class="text-lg font-bold mb-4">Customer Details</h3>
          <div class="flex items-center mb-6">
            <ion-avatar slot="start" class="mr-4">
              <img src="https://picsum.photos/seed/customer/200" alt="Customer profile" />
            </ion-avatar>
            <div>
              <h4 class="font-bold">{{ job()?.customer?.first_name || 'Customer' }}</h4>
              <p class="text-sm text-gray-500">Pickup Location</p>
            </div>
            <ion-button fill="clear" slot="end" class="ml-auto">
              <ion-icon name="call" slot="icon-only"></ion-icon>
            </ion-button>
          </div>

          <ion-list lines="none">
            <ion-item>
              <ion-icon name="pin" slot="start" color="primary"></ion-icon>
              <ion-label>
                <p class="text-xs text-gray-400">PICKUP</p>
                <h3 class="font-medium">{{ job()?.pickup_address }}</h3>
              </ion-label>
            </ion-item>
            <ion-item>
              <ion-icon name="flag" slot="start" color="success"></ion-icon>
              <ion-label>
                <p class="text-xs text-gray-400">DESTINATION</p>
                <h3 class="font-medium">{{ job()?.dropoff_address }}</h3>
              </ion-label>
            </ion-item>
          </ion-list>

          @if (details()) {
            <div class="mt-6 pt-6 border-t border-gray-100">
              <h3 class="text-lg font-bold mb-4 text-blue-600">Service Details</h3>
              
              @if (job()?.service_code === ServiceTypeEnum.RIDE) {
                <p class="text-gray-600">Passengers: <span class="font-bold">{{ details().passenger_count }}</span></p>
                @if (details().notes) {
                  <p class="text-sm text-gray-500 mt-2 italic">"{{ details().notes }}"</p>
                }
              }

              @if (job()?.service_code === ServiceTypeEnum.ERRAND) {
                <p class="text-gray-600 font-medium">Items to get:</p>
                <ul class="list-disc ml-5 mt-2 text-gray-700">
                  @for (item of details().items_list; track item) {
                    <li>{{ item }}</li>
                  }
                </ul>
                @if (details().estimated_budget) {
                  <p class="mt-4 text-gray-600">Budget: <span class="font-bold text-green-600">{{ '$' }}{{ details().estimated_budget }}</span></p>
                }
                @if (details().delivery_instructions) {
                  <p class="text-sm text-gray-500 mt-2 italic">"{{ details().delivery_instructions }}"</p>
                }
              }

              @if (job()?.service_code === ServiceTypeEnum.DELIVERY) {
                <p class="text-gray-600">Recipient: <span class="font-bold">{{ details().recipient_name }}</span></p>
                <p class="text-gray-600">Phone: <span class="font-bold">{{ details().recipient_phone }}</span></p>
                @if (details().item_description) {
                  <p class="text-sm text-gray-500 mt-2 italic">"{{ details().item_description }}"</p>
                }
              }

              @if (job()?.service_code === ServiceTypeEnum.VAN) {
                <p class="text-gray-600">Helpers: <span class="font-bold">{{ details().helper_count }}</span></p>
                <p class="text-gray-600">Floor: <span class="font-bold">{{ details().floor_number || 'Ground' }}</span></p>
                <p class="text-gray-600">Elevator: <span class="font-bold">{{ details().has_elevator ? 'Yes' : 'No' }}</span></p>
              }
            </div>
          }
        </div>

        <div class="mt-auto">
          @switch (job()?.status) {
            @case ('accepted') {
              <ion-button expand="block" (click)="updateStatus('arrived')">I Have Arrived</ion-button>
            }
            @case ('arrived') {
              <ion-button expand="block" (click)="updateStatus('in_progress')">Start Trip</ion-button>
            }
            @case ('in_progress') {
              <ion-button expand="block" color="success" (click)="completeTrip()">Complete Trip</ion-button>
            }
            @case ('completed') {
              <div class="bg-green-50 p-6 rounded-2xl text-center border border-green-100">
                <ion-icon name="checkmark-circle" class="text-4xl text-green-500 mb-2"></ion-icon>
                <h3 class="font-bold text-green-900">Trip Completed!</h3>
                <p class="text-green-700 text-sm">Earnings added to your wallet.</p>
                <ion-button fill="clear" class="mt-2" (click)="nav.navigateRoot('/driver')">Back to Dashboard</ion-button>
              </div>
            }
          }
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-full p-8 text-center">
          @if (isLoading()) {
            <ion-spinner name="crescent" color="primary"></ion-spinner>
            <p class="text-gray-500 mt-4">Loading job details...</p>
          } @else {
            <ion-icon name="alert-circle-outline" class="text-6xl text-gray-300 mb-4"></ion-icon>
            <h3 class="font-bold text-gray-900">Job Not Found</h3>
            <p class="text-gray-500 mt-2">This job may have been cancelled or assigned to another driver.</p>
            <ion-button fill="clear" class="mt-4" (click)="nav.navigateRoot('/driver')">Back to Dashboard</ion-button>
          }
        </div>
      }
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule]
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
  details = signal<any>(null);
  isLoading = signal(true);

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
    // If not in state, we might need to fetch it (simplified for MVP)
    if (!this.job() || this.job()?.id !== id) {
      await this.driverService.fetchAvailableJobs();
    }

    const currentJob = this.job();
    if (currentJob) {
      try {
        const details = await this.bookingService.getBookingDetails(currentJob.id, currentJob.service_code);
        this.details.set(details);
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
    } catch {
      await loading.dismiss();
      const toast = await this.toastCtrl.create({ message: 'Update failed', duration: 2000, color: 'danger' });
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
