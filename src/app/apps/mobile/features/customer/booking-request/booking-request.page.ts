import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { IonicModule, NavController, LoadingController, ToastController } from '@ionic/angular';
import { ActivatedRoute } from '@angular/router';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { PricingService } from '../../../../../core/services/pricing.service';
import { ServiceType, ServiceTypeEnum } from '../../../../../shared/models/booking.model';
import { CardComponent, ButtonComponent, InputComponent, PriceDisplayComponent } from '../../../../../shared/ui';

@Component({
  selector: 'app-booking-request',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" color="dark"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-text-primary">{{ getTitle() }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding bg-background">
      <div class="max-w-2xl mx-auto space-y-8 container-padding">
        <!-- Service Info -->
        <div class="text-center space-y-2">
          <div class="w-20 h-20 bg-primary/10 rounded-3xl flex items-center justify-center text-primary mx-auto mb-4">
            <ion-icon [name]="getIcon()" class="text-4xl"></ion-icon>
          </div>
          <h2 class="text-2xl font-display font-bold text-text-primary">{{ getTitle() }}</h2>
          <p class="text-text-secondary text-sm">Fill in the details below to request your service.</p>
        </div>

        <form [formGroup]="bookingForm" (ngSubmit)="submit()" class="space-y-6">
          <app-card title="Location Details">
            <div class="space-y-4">
              <app-input 
                label="Pickup Location" 
                formControlName="pickup_address" 
                placeholder="Enter pickup address"
                icon="location-outline">
              </app-input>

              @if (type !== ServiceTypeEnum.ERRAND) {
                <app-input 
                  label="Dropoff Location" 
                  formControlName="dropoff_address" 
                  placeholder="Enter destination"
                  icon="pin-outline">
                </app-input>
              }
            </div>
          </app-card>

          @if (type === ServiceTypeEnum.RIDE) {
            <app-card title="Ride Details">
              <app-input 
                label="Number of Passengers" 
                type="number" 
                formControlName="passenger_count"
                icon="people-outline">
              </app-input>
            </app-card>
          }

          @if (type === ServiceTypeEnum.ERRAND) {
            <app-card title="Errand Details">
              <div class="space-y-4">
                <div class="space-y-1.5">
                  <label class="text-xs font-bold text-text-secondary uppercase tracking-widest ml-1">Items to Buy</label>
                  <textarea 
                    formControlName="items_list" 
                    placeholder="Milk, Bread, Eggs..."
                    class="w-full px-4 py-3 rounded-2xl bg-gray-50 border border-gray-100 text-text-primary text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all min-h-[100px]">
                  </textarea>
                </div>
                <app-input 
                  label="Estimated Budget (£)" 
                  type="number" 
                  formControlName="estimated_budget"
                  icon="cash-outline">
                </app-input>
              </div>
            </app-card>
          }

          @if (type === ServiceTypeEnum.DELIVERY) {
            <app-card title="Recipient Details">
              <div class="space-y-4">
                <app-input 
                  label="Recipient Name" 
                  formControlName="recipient_name" 
                  placeholder="Who is receiving?"
                  icon="person-outline">
                </app-input>
                <app-input 
                  label="Recipient Phone" 
                  type="tel" 
                  formControlName="recipient_phone" 
                  placeholder="Contact number"
                  icon="call-outline">
                </app-input>
              </div>
            </app-card>
          }

          @if (type === ServiceTypeEnum.VAN) {
            <app-card title="Van Details">
              <div class="space-y-4">
                <app-input 
                  label="Helpers Needed" 
                  type="number" 
                  formControlName="helper_count"
                  icon="construct-outline">
                </app-input>
                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="flex items-center gap-3">
                    <ion-icon name="business-outline" class="text-xl text-text-secondary"></ion-icon>
                    <span class="text-sm font-bold text-text-primary uppercase tracking-tighter">Has Elevator?</span>
                  </div>
                  <ion-checkbox formControlName="has_elevator" color="primary"></ion-checkbox>
                </div>
              </div>
            </app-card>
          }

          <app-card title="Additional Info">
            <div class="space-y-1.5">
              <label class="text-xs font-bold text-text-secondary uppercase tracking-widest ml-1">Special Instructions</label>
              <textarea 
                formControlName="notes" 
                placeholder="Any extra details for the driver?"
                class="w-full px-4 py-3 rounded-2xl bg-gray-50 border border-gray-100 text-text-primary text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all min-h-[80px]">
              </textarea>
            </div>
          </app-card>

          <!-- Pricing -->
          <app-price-display 
            [total]="estimatedPrice()" 
            [driverEarnings]="estimatedPrice() * 0.85"
            [platformFee]="estimatedPrice() * 0.15">
          </app-price-display>

          <div class="pt-4">
            <app-button type="submit" [disabled]="!bookingForm.valid" size="lg">
              Confirm Booking
            </app-button>
          </div>
        </form>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, ReactiveFormsModule, CardComponent, ButtonComponent, InputComponent, PriceDisplayComponent]
})
export class BookingRequestPage implements OnInit {
  private fb = inject(FormBuilder);
  private route = inject(ActivatedRoute);
  private nav = inject(NavController);
  private bookingService = inject(BookingService);
  private pricingService = inject(PricingService);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);

  ServiceTypeEnum = ServiceTypeEnum;
  type: ServiceTypeEnum = ServiceTypeEnum.RIDE;
  bookingForm!: FormGroup;
  estimatedPrice = signal(0);
  serviceType = signal<ServiceType | null>(null);

  ngOnInit() {
    const typeParam = this.route.snapshot.queryParams['type'];
    this.type = (typeParam as ServiceTypeEnum) || ServiceTypeEnum.RIDE;
    this.initForm();
    this.loadPricing();
  }

  getTitle(): string {
    switch (this.type) {
      case ServiceTypeEnum.RIDE: return 'Book a Ride';
      case ServiceTypeEnum.ERRAND: return 'Request Errand';
      case ServiceTypeEnum.DELIVERY: return 'Package Delivery';
      case ServiceTypeEnum.VAN: return 'Request Van';
      default: return 'Booking Request';
    }
  }

  getIcon(): string {
    switch (this.type) {
      case ServiceTypeEnum.RIDE: return 'car-sport';
      case ServiceTypeEnum.ERRAND: return 'basket';
      case ServiceTypeEnum.DELIVERY: return 'cube';
      case ServiceTypeEnum.VAN: return 'bus';
      default: return 'help-circle';
    }
  }

  private initForm() {
    const baseFields = {
      pickup_address: ['', Validators.required],
      notes: ['']
    };

    switch (this.type) {
      case ServiceTypeEnum.RIDE:
        this.bookingForm = this.fb.group({
          ...baseFields,
          dropoff_address: ['', Validators.required],
          passenger_count: [1, [Validators.required, Validators.min(1)]]
        });
        break;
      case ServiceTypeEnum.ERRAND:
        this.bookingForm = this.fb.group({
          ...baseFields,
          items_list: ['', Validators.required],
          estimated_budget: [0]
        });
        break;
      case ServiceTypeEnum.DELIVERY:
        this.bookingForm = this.fb.group({
          ...baseFields,
          dropoff_address: ['', Validators.required],
          recipient_name: ['', Validators.required],
          recipient_phone: ['', Validators.required],
          item_description: ['']
        });
        break;
      case ServiceTypeEnum.VAN:
        this.bookingForm = this.fb.group({
          ...baseFields,
          dropoff_address: ['', Validators.required],
          helper_count: [0, Validators.min(0)],
          has_elevator: [false]
        });
        break;
    }
  }

  async loadPricing() {
    const types = await this.bookingService.getServiceTypes();
    const selected = types.find((t: ServiceType) => t.code === this.type);
    if (selected) {
      this.serviceType.set(selected);
      // Mock distance for MVP preview
      const price = await this.pricingService.calculatePrice(selected.id, this.type, 5);
      this.estimatedPrice.set(price);
    }
  }

  async submit() {
    const loading = await this.loadingCtrl.create({ message: 'Creating booking...' });
    await loading.present();

    try {
      const formVal = this.bookingForm.value;
      const bookingData = {
        pickup_address: formVal.pickup_address,
        pickup_lat: 0, pickup_lng: 0, // Mock coords
        dropoff_address: formVal.dropoff_address || 'Errand Delivery',
        dropoff_lat: 0, dropoff_lng: 0,
        service_type_id: this.serviceType()?.id,
        total_price: this.estimatedPrice()
      };

      const details = this.getDetailsPayload(formVal);

      const booking = await this.bookingService.createBooking(bookingData, details, this.type);
      
      await loading.dismiss();
      this.nav.navigateForward(['/customer/tracking', booking.id]);
    } catch (e: unknown) {
      await loading.dismiss();
      const message = e instanceof Error ? e.message : 'An error occurred';
      const toast = await this.toastCtrl.create({ message, duration: 3000, color: 'danger' });
      toast.present();
    }
  }

  private getDetailsPayload(formVal: any) {
    switch (this.type) {
      case ServiceTypeEnum.RIDE:
        return { passenger_count: formVal.passenger_count, notes: formVal.notes };
      case ServiceTypeEnum.ERRAND:
        return { items_list: formVal.items_list.split(','), estimated_budget: formVal.estimated_budget, delivery_instructions: formVal.notes };
      case ServiceTypeEnum.DELIVERY:
        return { recipient_name: formVal.recipient_name, recipient_phone: formVal.recipient_phone, notes: formVal.notes };
      case ServiceTypeEnum.VAN:
        return { helper_count: formVal.helper_count, has_elevator: formVal.has_elevator, notes: formVal.notes };
      default:
        return { notes: formVal.notes };
    }
  }
}
