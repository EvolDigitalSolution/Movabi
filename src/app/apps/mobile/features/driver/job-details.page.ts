import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, AlertController, LoadingController } from '@ionic/angular';
import { ActivatedRoute } from '@angular/router';
import { DriverService } from '../../../../core/services/driver/driver.service';
import { BookingStatus } from '../../../../shared/models/booking.model';
import { ButtonComponent, BadgeComponent } from '../../../../shared/ui';
import { CommunicationPanelComponent } from '../../../../shared/ui/communication-panel';

@Component({
  selector: 'app-job-details',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" color="dark"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-text-primary">Job Execution</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-background">
      @if (job()) {
        <div class="flex flex-col h-full">
          <!-- Map Area -->
          <div class="h-1/3 bg-gray-100 relative overflow-hidden">
            <div class="absolute inset-0 opacity-20 pointer-events-none">
              <div class="absolute inset-0" style="background-image: radial-gradient(#22C55E 1px, transparent 1px); background-size: 40px 40px;"></div>
            </div>
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="text-center">
                <ion-icon name="navigate-circle" class="text-5xl text-primary animate-pulse"></ion-icon>
                <p class="text-xs font-bold text-text-secondary uppercase tracking-widest mt-2">Live Navigation</p>
              </div>
            </div>
          </div>

          <!-- Job Info -->
          <div class="bg-white rounded-t-[40px] shadow-[0_-10px_40px_rgba(0,0,0,0.05)] p-8 space-y-8 -mt-10 relative z-10 flex-1 overflow-y-auto">
            <div class="w-12 h-1.5 bg-gray-100 rounded-full mx-auto mb-2"></div>

            <div class="flex justify-between items-start">
              <div>
                <app-badge variant="primary" class="mb-2">{{ job()?.status?.replace('_', ' ') }}</app-badge>
                <h2 class="text-2xl font-display font-bold text-text-primary">Active Job</h2>
                <p class="text-xs font-bold text-text-secondary uppercase tracking-widest">ID: {{ job()?.id?.slice(0,8) }}</p>
              </div>
              <div class="text-right">
                <p class="text-3xl font-display font-bold text-primary">£{{ job()?.total_price }}</p>
                <p class="text-[10px] font-bold text-success uppercase tracking-widest">Your Earning</p>
              </div>
            </div>

            <!-- Customer Info -->
            <div class="flex items-center p-4 bg-gray-50 rounded-3xl border border-gray-100">
              <div class="w-14 h-14 rounded-2xl overflow-hidden mr-4 border-2 border-white shadow-sm">
                <img [src]="job()?.customer?.avatar_url || 'https://picsum.photos/seed/customer/200'" alt="Customer profile" class="w-full h-full object-cover" />
              </div>
              <div class="flex-1">
                <h3 class="font-bold text-text-primary">{{ job()?.customer?.first_name }} {{ job()?.customer?.last_name }}</h3>
                <p class="text-xs text-text-secondary font-medium">Customer</p>
              </div>
              <app-button variant="secondary" size="sm" [fullWidth]="false" class="ml-2" (onClick)="callCustomer()">
                <ion-icon name="call" slot="icon-only"></ion-icon>
              </app-button>
            </div>

            <!-- Communication Panel Integration -->
            @if (['accepted', 'arrived', 'in_progress'].includes(job()?.status || '')) {
              <div class="pt-2">
                <app-button variant="secondary" (onClick)="showChat.set(!showChat())">
                  <ion-icon [name]="showChat() ? 'chevron-down' : 'chatbubbles'" class="mr-2"></ion-icon>
                  {{ showChat() ? 'Hide Chat' : 'Message Customer' }}
                </app-button>
                
                @if (showChat()) {
                  <div class="mt-4 h-[400px] border border-gray-100 rounded-3xl overflow-hidden shadow-sm">
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
                  <div class="w-3 h-3 rounded-full bg-primary ring-4 ring-primary/10"></div>
                  <div class="w-0.5 h-10 bg-gray-100"></div>
                  <div class="w-3 h-3 rounded-full bg-secondary ring-4 ring-secondary/10"></div>
                </div>
                <div class="flex-1 space-y-6">
                  <div>
                    <p class="text-[10px] font-bold text-text-secondary uppercase tracking-widest mb-1">Pickup</p>
                    <h3 class="text-sm font-bold text-text-primary">{{ job()?.pickup_address }}</h3>
                  </div>
                  <div>
                    <p class="text-[10px] font-bold text-text-secondary uppercase tracking-widest mb-1">Destination</p>
                    <h3 class="text-sm font-bold text-text-primary">{{ job()?.dropoff_address }}</h3>
                  </div>
                </div>
              </div>
            </div>

            <!-- Actions -->
            <div class="pt-8">
              @switch (job()?.status) {
                @case ('accepted') {
                  <app-button variant="primary" size="lg" (onClick)="updateStatus('arrived')">I Have Arrived</app-button>
                }
                @case ('arrived') {
                  <app-button variant="primary" size="lg" (onClick)="updateStatus('in_progress')">Start Trip</app-button>
                }
                @case ('in_progress') {
                  <app-button variant="primary" size="lg" (onClick)="confirmCompletion()">Complete Trip</app-button>
                }
              }
            </div>
          </div>
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-full p-8 text-center space-y-6">
          <ion-spinner name="crescent" color="primary"></ion-spinner>
          <p class="text-text-secondary font-medium">Loading job details...</p>
        </div>
      }
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, ButtonComponent, BadgeComponent, CommunicationPanelComponent]
})
export class JobDetailsPage implements OnInit {
  public route = inject(ActivatedRoute);
  private driverService = inject(DriverService);
  private nav = inject(NavController);
  private alertCtrl = inject(AlertController);
  private loadingCtrl = inject(LoadingController);

  job = this.driverService.activeJob;
  showChat = signal(false);

  ngOnInit() {
    const id = this.route.snapshot.params['id'];
    if (id && !this.job()) {
      // If we don't have active job in service, we should fetch it
      // For now we assume it's set by acceptJob or dashboard
    }
  }

  async updateStatus(status: BookingStatus) {
    const loading = await this.loadingCtrl.create({ message: 'Updating status...' });
    await loading.present();
    try {
      await this.driverService.updateJobStatus(this.job()!.id, status);
      await loading.dismiss();
    } catch {
      await loading.dismiss();
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
}
