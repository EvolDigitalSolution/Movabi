import { Component, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, LoadingController, ToastController } from '@ionic/angular';
import { FormsModule } from '@angular/forms';
import { JobService } from '@core/services/job/job.service';
import { AuthService } from '@core/services/auth/auth.service';
import { Job } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';

@Component({
  selector: 'app-van-jobs',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver"></ion-back-button>
        </ion-buttons>
        <ion-title>Available Moves</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-segment [(ngModel)]="segment" (ionChange)="loadJobs()">
        <ion-segment-button value="available">
          <ion-label>Available</ion-label>
        </ion-segment-button>
        <ion-segment-button value="my-jobs">
          <ion-label>My Jobs</ion-label>
        </ion-segment-button>
      </ion-segment>

      <div class="mt-6">
        @if (jobs().length === 0) {
          <div class="flex flex-col items-center justify-center py-20 text-gray-400">
            <ion-icon name="bus-outline" class="text-6xl mb-4 opacity-20"></ion-icon>
            <p>No jobs found</p>
          </div>
        } @else {
          @for (job of jobs(); track job.id) {
            <ion-card class="m-0 mb-6 rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
              <div class="p-6">
                <div class="flex justify-between items-start mb-4">
                  <div>
                    <h3 class="font-bold text-lg">£{{ job.price }}</h3>
                    <p class="text-xs text-gray-400 uppercase tracking-wider">{{ job.scheduled_time | date:'shortTime' }} Today</p>
                  </div>
                  <ion-badge [color]="getStatusColor(job.status)" class="uppercase">{{ job.status }}</ion-badge>
                </div>

                <div class="space-y-4 mb-6">
                  <div class="flex items-start">
                    <ion-icon name="pin" color="primary" class="mr-3 mt-1"></ion-icon>
                    <div>
                      <p class="text-xs text-gray-400 uppercase">Pickup</p>
                      <p class="font-medium text-sm">{{ job.pickup_address }}</p>
                      @if (job.pickup_lat && currentPos) {
                        <p class="text-xs text-blue-600 font-bold mt-1">
                          {{ calculateDistance(currentPos.lat, currentPos.lng, job.pickup_lat, job.pickup_lng!).toFixed(1) }} km away
                        </p>
                      }
                    </div>
                  </div>
                  <div class="flex items-start">
                    <ion-icon name="flag" color="success" class="mr-3 mt-1"></ion-icon>
                    <div>
                      <p class="text-xs text-gray-400 uppercase">Dropoff</p>
                      <p class="font-medium text-sm">{{ job.dropoff_address }}</p>
                      @if (job.estimated_distance) {
                        <p class="text-xs text-gray-400 mt-1">{{ job.estimated_distance }} km trip</p>
                      }
                    </div>
                  </div>
                </div>

                @if (segment === 'available') {
                  <ion-button expand="block" class="rounded-2xl font-bold" (click)="acceptJob(job.id)">
                    Accept Job
                  </ion-button>
                } @else {
                  <div class="flex gap-2">
                    @if (job.status === 'accepted') {
                      <ion-button expand="block" class="flex-1 rounded-2xl font-bold" (click)="updateStatus(job.id, 'in_progress')">
                        Start Job
                      </ion-button>
                    } @else if (job.status === 'in_progress') {
                      <ion-button expand="block" color="success" class="flex-1 rounded-2xl font-bold" (click)="updateStatus(job.id, 'completed')">
                        Complete Job
                      </ion-button>
                    }
                    <ion-button fill="outline" class="flex-1 rounded-2xl font-bold" (click)="viewDetails(job.id)">
                      Details
                    </ion-button>
                  </div>
                }
              </div>
            </ion-card>
          }
        }
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule]
})
export class VanJobsPage implements OnInit, OnDestroy {
  private jobService = inject(JobService);
  private auth = inject(AuthService);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);
  private nav = inject(NavController);

  segment = 'available';
  jobs = signal<Job[]>([]);
  currentPos: { lat: number, lng: number } | null = null;
  private channel?: RealtimeChannel;

  async ngOnInit() {
    await this.loadJobs();
    this.channel = this.jobService.subscribeToJobs(() => this.loadJobs());
    this.getCurrentLocation();
  }

  ngOnDestroy() {
    this.channel?.unsubscribe();
  }

  getCurrentLocation() {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => this.currentPos = { lat: pos.coords.latitude, lng: pos.coords.longitude },
        (err) => console.error(err)
      );
    }
  }

  calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  async loadJobs() {
    if (this.segment === 'available') {
      this.jobs.set(await this.jobService.getAvailableJobs());
    } else {
      const user = this.auth.currentUser();
      if (user) {
        this.jobs.set(await this.jobService.getDriverJobs(user.id));
      }
    }
  }

  async acceptJob(jobId: string) {
    const user = this.auth.currentUser();
    if (!user) return;

    const loading = await this.loadingCtrl.create({ message: 'Accepting job...' });
    await loading.present();

    try {
      await this.jobService.acceptJob(jobId, user.id);
      await loading.dismiss();
      this.segment = 'my-jobs';
      await this.loadJobs();
      
      const toast = await this.toastCtrl.create({ message: 'Job accepted!', duration: 2000, color: 'success' });
      toast.present();
    } catch (error) {
      await loading.dismiss();
      const toast = await this.toastCtrl.create({ message: 'Failed to accept job', duration: 2000, color: 'danger' });
      toast.present();
    }
  }

  async updateStatus(jobId: string, status: any) {
    await this.jobService.updateJobStatus(jobId, status);
    await this.loadJobs();
  }

  viewDetails(jobId: string) {
    this.nav.navigateForward(['/customer/van-moving/status', jobId]);
  }

  getStatusColor(status: string) {
    switch (status) {
      case 'pending': return 'warning';
      case 'accepted': return 'primary';
      case 'in_progress': return 'tertiary';
      case 'completed': return 'success';
      case 'cancelled': return 'danger';
      default: return 'medium';
    }
  }
}
