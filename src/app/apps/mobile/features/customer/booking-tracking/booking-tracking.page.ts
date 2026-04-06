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
      <ion-toolbar class="px-4">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Live Tracking</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      @if (booking()) {
        <div class="flex flex-col h-full">
          <!-- Map Area -->
          <div class="flex-1 bg-slate-100 relative overflow-hidden min-h-[300px]">
            <!-- Mock Map Background -->
            <div class="absolute inset-0 opacity-10 pointer-events-none">
              <div class="absolute inset-0" style="background-image: radial-gradient(#2563eb 1px, transparent 1px); background-size: 40px 40px;"></div>
            </div>

            <div class="absolute inset-0 flex items-center justify-center">
              <div class="text-center space-y-6">
                <div class="relative">
                  <div class="absolute inset-0 bg-blue-600 rounded-full animate-ping opacity-20"></div>
                  <div class="relative w-20 h-20 bg-white rounded-[2rem] shadow-2xl flex items-center justify-center text-blue-600 border border-blue-50/50 mx-auto">
                    <ion-icon name="car-sport" class="text-4xl"></ion-icon>
                  </div>
                </div>
                <div class="bg-white/80 backdrop-blur-xl px-6 py-3 rounded-2xl shadow-xl border border-white/50">
                  <p class="text-xs font-bold text-slate-900 uppercase tracking-widest">Driver is on the way</p>
                </div>
              </div>
            </div>
            
            @if (booking()?.status === 'searching') {
              <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center p-8 z-20">
                <app-card class="max-w-xs w-full text-center">
                  <div class="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 mx-auto mb-6 border border-blue-100">
                    <ion-spinner name="crescent" color="primary"></ion-spinner>
                  </div>
                  <h2 class="text-xl font-display font-bold text-slate-900 mb-2 tracking-tight">Finding a Driver</h2>
                  <p class="text-sm text-slate-500 font-medium">Matching you with the nearest professional. Please wait.</p>
                </app-card>
              </div>
            }
          </div>

          <!-- Info Sheet -->
          <div class="bg-white rounded-t-[3rem] shadow-2xl p-10 space-y-10 -mt-12 relative z-10 max-h-[65%] overflow-y-auto custom-scrollbar border-t border-slate-100">
            <div class="w-16 h-1.5 bg-slate-100 rounded-full mx-auto mb-2"></div>

            <div class="flex justify-between items-start">
              <div>
                <app-badge [variant]="getStatusVariant(booking()?.status || '')" class="mb-3">{{ booking()?.status?.replace('_', ' ') }}</app-badge>
                <h2 class="text-3xl font-display font-bold text-slate-900 tracking-tight">Booking Details</h2>
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">ID: {{ booking()?.id?.slice(0,8) }}</p>
              </div>
              <div class="text-right">
                <p class="text-4xl font-display font-bold text-slate-900">£{{ booking()?.total_price }}</p>
                <p class="text-[10px] font-bold text-emerald-600 uppercase tracking-widest mt-1">Fixed Price</p>
              </div>
            </div>

            @if (booking()?.driver_id) {
              <div class="flex items-center p-6 bg-slate-50 rounded-[2rem] border border-slate-100 group transition-all hover:bg-white hover:shadow-xl hover:shadow-slate-200/50">
                <div class="w-16 h-16 rounded-2xl overflow-hidden mr-5 border-4 border-white shadow-lg shadow-slate-200/50">
                  <img src="https://picsum.photos/seed/driver/200" alt="Driver profile" class="w-full h-full object-cover" />
                </div>
                <div class="flex-1 min-w-0">
                  <h3 class="text-lg font-bold text-slate-900 truncate">{{ booking()?.driver?.first_name }} {{ booking()?.driver?.last_name }}</h3>
                  <p class="text-xs text-slate-500 font-bold uppercase tracking-widest mt-0.5">Arriving in 5 mins</p>
                </div>
                <div class="flex gap-2">
                  <app-button variant="secondary" size="sm" [fullWidth]="false" class="h-12 w-12 rounded-2xl" (onClick)="callDriver()">
                    <ion-icon name="call" slot="icon-only" class="text-xl"></ion-icon>
                  </app-button>
                </div>
              </div>

              <!-- Communication Panel Integration -->
              @if (['accepted', 'arrived', 'in_progress'].includes(booking()?.status || '')) {
                <div class="pt-2">
                  <app-button [variant]="showChat() ? 'outline' : 'secondary'" (onClick)="showChat.set(!showChat())" class="w-full">
                    <ion-icon [name]="showChat() ? 'chevron-down' : 'chatbubbles'" class="mr-2 text-xl"></ion-icon>
                    {{ showChat() ? 'Hide Chat' : 'Message Driver' }}
                  </app-button>
                  
                  @if (showChat()) {
                    <div class="mt-6 h-[500px] border border-slate-100 rounded-[2.5rem] overflow-hidden shadow-2xl shadow-slate-200/50 animate-in slide-in-from-top-4 duration-500">
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

            <div class="space-y-8">
              <div class="relative pl-10 space-y-10">
                <!-- Vertical Line -->
                <div class="absolute left-[13px] top-2 bottom-2 w-0.5 bg-slate-100"></div>

                <!-- Pickup -->
                <div class="relative">
                  <div class="absolute -left-[31px] top-1 w-5 h-5 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Pickup Location</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-snug">{{ booking()?.pickup_address }}</h3>
                  </div>
                </div>

                <!-- Destination -->
                <div class="relative">
                  <div class="absolute -left-[31px] top-1 w-5 h-5 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Destination</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-snug">{{ booking()?.dropoff_address }}</h3>
                  </div>
                </div>
              </div>
            </div>

            @if (details()) {
              <div class="pt-10 border-t border-slate-50">
                <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-6">Service Details</h3>
                
                <div class="grid grid-cols-2 gap-5">
                  @if (booking()?.service_code === ServiceTypeEnum.RIDE) {
                    <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Passengers</p>
                      <p class="text-xl font-display font-bold text-slate-900">{{ details()?.['passenger_count'] }}</p>
                    </div>
                  }

                  @if (booking()?.service_code === ServiceTypeEnum.VAN) {
                    <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Helpers</p>
                      <p class="text-xl font-display font-bold text-slate-900">{{ details()?.['helper_count'] }}</p>
                    </div>
                  }
                </div>

                @if (booking()?.service_code === ServiceTypeEnum.ERRAND) {
                  <div class="p-6 bg-slate-50 rounded-[2rem] border border-slate-100 mt-5">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Items Requested</p>
                    <div class="flex flex-wrap gap-2">
                      @for (item of (details()?.['items_list'] || []); track item) {
                        <app-badge variant="primary" class="bg-white border-slate-100 text-slate-600">{{ item }}</app-badge>
                      }
                    </div>
                    @if (details()?.['estimated_budget']) {
                      <div class="mt-6 pt-6 border-t border-slate-200/50 flex justify-between items-center">
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Budget</span>
                        <span class="text-xl font-display font-bold text-emerald-600">£{{ details()?.['estimated_budget'] }}</span>
                      </div>
                    }
                  </div>
                }
              </div>
            }

            <div class="pt-6 space-y-4">
              @if (booking()?.status === 'completed') {
                <app-button variant="primary" size="lg" (click)="showRating()" class="w-full">
                  Rate Experience
                </app-button>
              } @else if (booking()?.status !== 'cancelled') {
                <app-button variant="outline" color="error" size="lg" (click)="cancelBooking()" class="w-full">
                  Cancel Booking
                </app-button>
              }
            </div>
          </div>
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-full p-10 text-center space-y-8">
          @if (isLoading()) {
            <div class="w-20 h-20 bg-white rounded-[2rem] flex items-center justify-center shadow-2xl shadow-slate-200/50 border border-slate-100">
              <ion-spinner name="crescent" color="primary"></ion-spinner>
            </div>
            <div class="space-y-2">
              <h3 class="text-xl font-display font-bold text-slate-900">Loading details</h3>
              <p class="text-slate-500 font-medium">Retrieving your journey information...</p>
            </div>
          } @else {
            <div class="w-24 h-24 bg-red-50 rounded-[2.5rem] flex items-center justify-center text-red-500 border border-red-100 mb-4">
              <ion-icon name="alert-circle-outline" class="text-5xl"></ion-icon>
            </div>
            <div class="space-y-3">
              <h3 class="text-2xl font-display font-bold text-slate-900">Booking Not Found</h3>
              <p class="text-slate-500 font-medium max-w-xs mx-auto leading-relaxed">We couldn't find this booking. It might have been completed or cancelled.</p>
            </div>
            <app-button variant="secondary" size="lg" (click)="nav.navigateRoot('/customer')" class="w-full">
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
  details = signal<Record<string, string | number | boolean | string[] | null | undefined> | null>(null);
  isLoading = signal(true);
  showChat = signal(false);

  getStatusVariant(status: string): 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' {
    switch (status) {
      case 'searching': return 'warning';
      case 'accepted':
      case 'arrived':
      case 'in_progress': return 'primary';
      case 'completed': return 'success';
      case 'cancelled': return 'error';
      default: return 'secondary';
    }
  }

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
      this.details.set(details as Record<string, string | number | boolean | string[] | null | undefined>);
    } catch (e) {
      console.error('Failed to load booking or details', e);
    } finally {
      this.isLoading.set(false);
    }
  }

  async showRating() {
    const alert = await this.alertCtrl.create({
      header: 'Rate your Trip',
      message: 'How was your experience with Movabi?',
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
