import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, AlertController } from '@ionic/angular';
import { ActivatedRoute } from '@angular/router';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { ServiceTypeEnum } from '../../../../../shared/models/booking.model';
import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../../shared/ui';
import { CommunicationPanelComponent } from '../../../../../shared/ui/communication-panel';

@Component({
  selector: 'app-booking-tracking',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" color="dark"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-text-primary">Live Tracking</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-background">
      @if (booking()) {
        <div class="flex flex-col h-full">
          <!-- Map Area -->
          <div class="flex-1 bg-gray-100 relative overflow-hidden">
            <!-- Mock Map Background -->
            <div class="absolute inset-0 opacity-20 pointer-events-none">
              <div class="absolute inset-0" style="background-image: radial-gradient(#22C55E 1px, transparent 1px); background-size: 40px 40px;"></div>
            </div>

            <div class="absolute inset-0 flex items-center justify-center">
              <div class="text-center space-y-4">
                <div class="w-16 h-16 bg-white rounded-full shadow-xl flex items-center justify-center text-primary animate-bounce-slow mx-auto">
                  <ion-icon name="car-sport" class="text-3xl"></ion-icon>
                </div>
                <div class="bg-white/90 backdrop-blur-sm px-4 py-2 rounded-full shadow-sm border border-white">
                  <p class="text-xs font-bold text-text-primary uppercase tracking-widest">Driver is on the way</p>
                </div>
              </div>
            </div>
            
            @if (booking()?.status === 'searching') {
              <div class="absolute inset-0 bg-secondary/40 backdrop-blur-[2px] flex items-center justify-center p-6">
                <app-card class="max-w-xs w-full text-center animate-pulse">
                  <div class="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center text-primary mx-auto mb-4">
                    <ion-spinner name="crescent"></ion-spinner>
                  </div>
                  <h2 class="text-lg font-display font-bold text-text-primary">Finding a Driver...</h2>
                  <p class="text-xs text-text-secondary mt-1">Broadcasted to nearby drivers. Please wait a moment.</p>
                </app-card>
              </div>
            }
          </div>

          <!-- Info Sheet -->
          <div class="bg-white rounded-t-[40px] shadow-[0_-10px_40px_rgba(0,0,0,0.05)] p-8 space-y-8 -mt-10 relative z-10 max-h-[60%] overflow-y-auto">
            <div class="w-12 h-1.5 bg-gray-100 rounded-full mx-auto mb-2"></div>

            <div class="flex justify-between items-start">
              <div>
                <app-badge variant="primary" class="mb-2">{{ booking()?.status?.replace('_', ' ') }}</app-badge>
                <h2 class="text-2xl font-display font-bold text-text-primary">Booking Details</h2>
                <p class="text-xs font-bold text-text-secondary uppercase tracking-widest">ID: {{ booking()?.id?.slice(0,8) }}</p>
              </div>
              <div class="text-right">
                <p class="text-3xl font-display font-bold text-text-primary">£{{ booking()?.total_price }}</p>
                <p class="text-[10px] font-bold text-success uppercase tracking-widest">Fixed Price</p>
              </div>
            </div>

            @if (booking()?.driver_id) {
              <div class="flex items-center p-4 bg-gray-50 rounded-3xl border border-gray-100 group">
                <div class="w-14 h-14 rounded-2xl overflow-hidden mr-4 border-2 border-white shadow-sm">
                  <img src="https://picsum.photos/seed/driver/200" alt="Driver profile" class="w-full h-full object-cover" />
                </div>
                <div class="flex-1">
                  <h3 class="font-bold text-text-primary">{{ booking()?.driver?.first_name }} {{ booking()?.driver?.last_name }}</h3>
                  <p class="text-xs text-text-secondary font-medium">Arriving in approx. 5 mins</p>
                </div>
                <app-button variant="secondary" size="sm" [fullWidth]="false" class="ml-2" (onClick)="callDriver()">
                  <ion-icon name="call" slot="icon-only"></ion-icon>
                </app-button>
              </div>

              <!-- Communication Panel Integration -->
              @if (['accepted', 'arrived', 'in_progress'].includes(booking()?.status || '')) {
                <div class="pt-2">
                  <app-button variant="secondary" (onClick)="showChat.set(!showChat())">
                    <ion-icon [name]="showChat() ? 'chevron-down' : 'chatbubbles'" class="mr-2"></ion-icon>
                    {{ showChat() ? 'Hide Chat' : 'Message Driver' }}
                  </app-button>
                  
                  @if (showChat()) {
                    <div class="mt-4 h-[450px] border border-gray-100 rounded-3xl overflow-hidden shadow-sm">
                      <app-communication-panel 
                        [jobId]="booking()!.id" 
                        [receiverId]="booking()!.driver_id!" 
                        [receiverPhone]="booking()?.driver?.phone"
                      ></app-communication-panel>
                    </div>
                  }
                </div>
              }
            }

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
                    <h3 class="text-sm font-bold text-text-primary">{{ booking()?.pickup_address }}</h3>
                  </div>
                  <div>
                    <p class="text-[10px] font-bold text-text-secondary uppercase tracking-widest mb-1">Destination</p>
                    <h3 class="text-sm font-bold text-text-primary">{{ booking()?.dropoff_address }}</h3>
                  </div>
                </div>
              </div>
            </div>

            @if (details()) {
              <div class="pt-6 border-t border-gray-50">
                <h3 class="text-xs font-bold text-text-secondary uppercase tracking-widest mb-4">Service Details</h3>
                
                <div class="grid grid-cols-2 gap-4">
                  @if (booking()?.service_code === ServiceTypeEnum.RIDE) {
                    <div class="p-4 bg-gray-50 rounded-2xl border border-gray-100">
                      <p class="text-[10px] font-bold text-text-secondary uppercase tracking-widest mb-1">Passengers</p>
                      <p class="text-lg font-bold text-text-primary">{{ details().passenger_count }}</p>
                    </div>
                  }

                  @if (booking()?.service_code === ServiceTypeEnum.VAN) {
                    <div class="p-4 bg-gray-50 rounded-2xl border border-gray-100">
                      <p class="text-[10px] font-bold text-text-secondary uppercase tracking-widest mb-1">Helpers</p>
                      <p class="text-lg font-bold text-text-primary">{{ details().helper_count }}</p>
                    </div>
                  }
                </div>

                @if (booking()?.service_code === ServiceTypeEnum.ERRAND) {
                  <div class="p-4 bg-gray-50 rounded-2xl border border-gray-100 mt-4">
                    <p class="text-[10px] font-bold text-text-secondary uppercase tracking-widest mb-2">Items Requested</p>
                    <div class="flex flex-wrap gap-2">
                      @for (item of details().items_list; track item) {
                        <app-badge variant="secondary" class="text-[8px]">{{ item }}</app-badge>
                      }
                    </div>
                    @if (details().estimated_budget) {
                      <div class="mt-4 pt-4 border-t border-gray-200/50 flex justify-between items-center">
                        <span class="text-xs font-bold text-text-secondary uppercase tracking-widest">Budget</span>
                        <span class="text-sm font-bold text-success">£{{ details().estimated_budget }}</span>
                      </div>
                    }
                  </div>
                }
              </div>
            }

            <div class="pt-4 space-y-3">
              @if (booking()?.status === 'completed') {
                <app-button variant="primary" (click)="showRating()">
                  Rate Experience
                </app-button>
              } @else if (booking()?.status !== 'cancelled') {
                <app-button variant="ghost" class="text-error" (click)="cancelBooking()">
                  Cancel Booking
                </app-button>
              }
            </div>
          </div>
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-full p-8 text-center space-y-6">
          @if (isLoading()) {
            <div class="w-16 h-16 bg-primary/10 rounded-3xl flex items-center justify-center text-primary animate-pulse">
              <ion-spinner name="crescent"></ion-spinner>
            </div>
            <p class="text-text-secondary font-medium">Loading booking details...</p>
          } @else {
            <div class="w-20 h-20 bg-error/10 rounded-3xl flex items-center justify-center text-error mb-4">
              <ion-icon name="alert-circle-outline" class="text-5xl"></ion-icon>
            </div>
            <h3 class="text-2xl font-display font-bold text-text-primary">Booking Not Found</h3>
            <p class="text-text-secondary max-w-xs mx-auto">We couldn't find this booking. It might have been completed or cancelled.</p>
            <app-button variant="secondary" (click)="nav.navigateRoot('/customer')">
              Back to Home
            </app-button>
          }
        </div>
      }
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, CardComponent, ButtonComponent, BadgeComponent, CommunicationPanelComponent]
})
export class BookingTrackingPage implements OnInit {
  private route = inject(ActivatedRoute);
  private bookingService = inject(BookingService);
  private alertCtrl = inject(AlertController);
  public nav = inject(NavController);

  ServiceTypeEnum = ServiceTypeEnum;
  booking = this.bookingService.activeBooking;
  details = signal<any>(null);
  isLoading = signal(true);
  showChat = signal(false);

  ngOnInit() {
    const id = this.route.snapshot.params['id'];
    if (id) {
      this.bookingService.subscribeToBooking(id);
      this.loadBookingAndDetails(id);
    }
  }

  async loadBookingAndDetails(id: string) {
    this.isLoading.set(true);
    try {
      const b = await this.bookingService.getBooking(id);
      this.bookingService.activeBooking.set(b);
      
      const details = await this.bookingService.getBookingDetails(b.id, b.service_code);
      this.details.set(details);
    } catch (e) {
      console.error('Failed to load booking or details', e);
    } finally {
      this.isLoading.set(false);
    }
  }

  async showRating() {
    const alert = await this.alertCtrl.create({
      header: 'Rate your Trip',
      message: 'How was your experience with MoveMate?',
      inputs: [
        { name: 'score', type: 'number', placeholder: 'Score (1-5)', min: 1, max: 5 },
        { name: 'comment', type: 'textarea', placeholder: 'Optional comment' }
      ],
      buttons: [
        { text: 'Skip', role: 'cancel', handler: () => this.nav.navigateRoot('/customer') },
        {
          text: 'Submit',
          handler: async (data) => {
            await this.bookingService.rateBooking(this.booking()!.id, data.score, data.comment);
            this.nav.navigateRoot('/customer');
          }
        }
      ]
    });
    await alert.present();
  }

  async cancelBooking() {
    const alert = await this.alertCtrl.create({
      header: 'Cancel Booking',
      message: 'Are you sure you want to cancel this booking?',
      inputs: [
        { name: 'reason', type: 'text', placeholder: 'Reason for cancellation' }
      ],
      buttons: [
        { text: 'No', role: 'cancel' },
        {
          text: 'Yes, Cancel',
          role: 'destructive',
          handler: async (data) => {
            try {
              await this.bookingService.cancelBooking(this.booking()!.id, data.reason || 'No reason provided');
              this.nav.navigateRoot('/customer');
            } catch (e) {
              const errorAlert = await this.alertCtrl.create({
                header: 'Error',
                message: (e as Error).message,
                buttons: ['OK']
              });
              await errorAlert.present();
            }
          }
        }
      ]
    });
    await alert.present();
  }

  callDriver() {
    const phone = this.booking()?.driver?.phone;
    if (phone) {
      window.open(`tel:${phone}`, '_system');
    }
  }
}
