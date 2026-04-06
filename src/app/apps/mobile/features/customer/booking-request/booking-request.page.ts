import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { IonicModule, NavController, LoadingController, ToastController } from '@ionic/angular';
import { ActivatedRoute } from '@angular/router';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { PricingService } from '../../../../../core/services/pricing.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { AnalyticsService } from '../../../../../core/services/analytics/analytics.service';
import { ServiceType, ServiceTypeEnum, UnifiedLocation } from '../../../../../shared/models/booking.model';
import { CardComponent, ButtonComponent, InputComponent, PriceDisplayComponent } from '../../../../../shared/ui';

@Component({
  selector: 'app-booking-request',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">{{ getTitle() }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding bg-slate-50">
      <div class="max-w-2xl mx-auto space-y-10 pb-12">
        <!-- Service Info -->
        <div class="text-center space-y-4 py-6">
          <div class="w-24 h-24 bg-white rounded-[2rem] flex items-center justify-center text-blue-600 mx-auto mb-4 shadow-xl shadow-blue-600/10 border border-blue-50/50">
            <ion-icon [name]="getIcon()" class="text-4xl"></ion-icon>
          </div>
          <div>
            <h2 class="text-3xl font-display font-bold text-slate-900 tracking-tight">{{ getTitle() }}</h2>
            <p class="text-slate-500 font-medium mt-1">Professional service at your fingertips.</p>
          </div>
        </div>

        @if (locationService.locationError()) {
          <div class="p-4 bg-amber-50 border border-amber-100 rounded-2xl flex items-center gap-3 text-amber-700 text-xs font-medium animate-in fade-in slide-in-from-top-2">
            <ion-icon name="information-circle-outline" class="text-lg shrink-0"></ion-icon>
            <div class="flex-1">
              <p>{{ locationService.locationError() }}</p>
              <button (click)="locationService.setManualMode()" class="text-blue-600 font-bold uppercase tracking-widest mt-1">Continue with manual address</button>
            </div>
          </div>
        }

        <form [formGroup]="bookingForm" (ngSubmit)="submit()" class="space-y-8">
          <app-card title="Location Details">
            <div class="space-y-6">
              <div class="relative">
                <app-input 
                  label="Pickup Location" 
                  formControlName="pickup_address" 
                  placeholder="Where should we pick up?"
                  icon="location-outline">
                </app-input>
                @if (getValidationError('pickup')) {
                  <p class="text-[10px] text-rose-500 font-bold mt-1 uppercase tracking-wider ml-1">{{ getValidationError('pickup') }}</p>
                }
                <button type="button" 
                        (click)="useCurrentLocation('pickup')"
                        class="absolute right-4 top-10 text-blue-600 font-bold text-[10px] uppercase tracking-widest hover:text-blue-700 transition-colors">
                  <ion-icon name="locate-outline" class="mr-1 align-middle"></ion-icon>
                  Use my location
                </button>
              </div>

              @if (type !== ServiceTypeEnum.ERRAND) {
                <div class="relative">
                  <app-input 
                    label="Dropoff Location" 
                    formControlName="dropoff_address" 
                    placeholder="Where are we going?"
                    icon="pin-outline">
                  </app-input>
                  @if (getValidationError('dropoff')) {
                    <p class="text-[10px] text-rose-500 font-bold mt-1 uppercase tracking-wider ml-1">{{ getValidationError('dropoff') }}</p>
                  }
                  <button type="button" 
                          (click)="useCurrentLocation('dropoff')"
                          class="absolute right-4 top-10 text-blue-600 font-bold text-[10px] uppercase tracking-widest hover:text-blue-700 transition-colors">
                    <ion-icon name="locate-outline" class="mr-1 align-middle"></ion-icon>
                    Use my location
                  </button>
                </div>
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
              <div class="space-y-6">
                <div class="space-y-2">
                  <label for="items_list" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Items to Buy</label>
                  <textarea 
                    id="items_list"
                    formControlName="items_list" 
                    placeholder="List the items you need (e.g. Milk, Bread, Eggs...)"
                    class="w-full px-5 py-4 rounded-2xl bg-slate-50 border border-slate-100 text-slate-900 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-600/5 focus:border-blue-500 transition-all min-h-[120px] placeholder:text-slate-300">
                  </textarea>
                </div>
                <app-input 
                  [label]="'Estimated Budget (' + config.currencySymbol + ')'" 
                  type="number" 
                  formControlName="estimated_budget"
                  icon="cash-outline">
                </app-input>
              </div>
            </app-card>
          }

          @if (type === ServiceTypeEnum.DELIVERY) {
            <app-card title="Recipient Details">
              <div class="space-y-6">
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
                  [phoneCode]="config.currentCountry().phoneCode"
                  icon="call-outline">
                </app-input>
              </div>
            </app-card>
          }

          @if (type === ServiceTypeEnum.VAN) {
            <app-card title="Van Details">
              <div class="space-y-6">
                <app-input 
                  label="Helpers Needed" 
                  type="number" 
                  formControlName="helper_count"
                  icon="construct-outline">
                </app-input>
                <div class="flex items-center justify-between p-5 bg-slate-50 rounded-2xl border border-slate-100">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-slate-400 shadow-sm border border-slate-100">
                      <ion-icon name="business-outline" class="text-xl"></ion-icon>
                    </div>
                    <span class="text-sm font-bold text-slate-900 uppercase tracking-tighter">Has Elevator?</span>
                  </div>
                  <ion-checkbox formControlName="has_elevator" color="primary"></ion-checkbox>
                </div>
              </div>
            </app-card>
          }

          <app-card title="Additional Info">
            <div class="space-y-2">
              <label for="notes" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Special Instructions</label>
              <textarea 
                id="notes"
                formControlName="notes" 
                placeholder="Any extra details for the driver?"
                class="w-full px-5 py-4 rounded-2xl bg-slate-50 border border-slate-100 text-slate-900 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-600/5 focus:border-blue-500 transition-all min-h-[100px] placeholder:text-slate-300">
              </textarea>
            </div>
          </app-card>

          <!-- Pricing -->
          <app-price-display 
            [total]="estimatedPrice() * 1.05" 
            [fare]="estimatedPrice()" 
            [serviceFee]="estimatedPrice() * 0.05">
          </app-price-display>

          <div class="pt-6">
            <app-button type="submit" [disabled]="!bookingForm.valid" size="lg" class="w-full">
              Confirm Booking
            </app-button>
            <p class="text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-6">
              Secure payment processed via Movabi Pay
            </p>
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
  public config = inject(AppConfigService);
  public locationService = inject(LocationService);
  private analytics = inject(AnalyticsService);

  ServiceTypeEnum = ServiceTypeEnum;
  type: ServiceTypeEnum = ServiceTypeEnum.RIDE;
  bookingForm!: FormGroup;
  estimatedPrice = signal(0);
  serviceType = signal<ServiceType | null>(null);

  pickupLocation: UnifiedLocation = { source: 'manual', address: '' };
  dropoffLocation: UnifiedLocation = { source: 'manual', address: '' };

  getTitle(): string {
    switch (this.type) {
      case ServiceTypeEnum.RIDE: return 'Book a Ride';
      case ServiceTypeEnum.ERRAND: return 'Request Errand';
      case ServiceTypeEnum.DELIVERY: return 'Send Delivery';
      case ServiceTypeEnum.VAN: return 'Van Moving';
      default: return 'New Booking';
    }
  }

  getIcon(): string {
    switch (this.type) {
      case ServiceTypeEnum.RIDE: return 'car-outline';
      case ServiceTypeEnum.ERRAND: return 'basket-outline';
      case ServiceTypeEnum.DELIVERY: return 'cube-outline';
      case ServiceTypeEnum.VAN: return 'bus-outline';
      default: return 'add-circle-outline';
    }
  }

  ngOnInit() {
    const typeParam = this.route.snapshot.queryParams['type'];
    this.type = (typeParam as ServiceTypeEnum) || ServiceTypeEnum.RIDE;
    this.initForm();
    this.loadPricing();
  }

  async useCurrentLocation(type: 'pickup' | 'dropoff') {
    const loading = await this.loadingCtrl.create({ message: 'Getting location...' });
    await loading.present();

    const pos = await this.locationService.getCurrentPosition();
    await loading.dismiss();

    if (pos) {
      const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const address = `Current Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`;
      
      if (type === 'pickup') {
        this.pickupLocation = this.locationService.normalizeLocation('gps', coords, address);
        this.bookingForm.patchValue({ pickup_address: address });
      } else {
        this.dropoffLocation = this.locationService.normalizeLocation('gps', coords, address);
        this.bookingForm.patchValue({ dropoff_address: address });
      }
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

    // Sync manual changes back to unified model
    this.bookingForm.get('pickup_address')?.valueChanges.subscribe(val => {
      if (this.pickupLocation.address !== val) {
        this.pickupLocation = { source: 'manual', address: val };
      }
    });

    this.bookingForm.get('dropoff_address')?.valueChanges.subscribe(val => {
      if (this.dropoffLocation.address !== val) {
        this.dropoffLocation = { source: 'manual', address: val };
      }
    });
  }

  async loadPricing() {
    const types = await this.bookingService.getServiceTypes();
    const selected = types.find((t: ServiceType) => t.code === this.type);
    if (selected) {
      this.serviceType.set(selected);
      // Estimated price based on distance
      const price = await this.pricingService.calculatePrice(selected.id, this.type, 5);
      this.estimatedPrice.set(price);
    }
  }

  getValidationError(type: 'pickup' | 'dropoff'): string | null {
    const location = type === 'pickup' ? this.pickupLocation : this.dropoffLocation;
    return this.locationService.getLocationValidationMessage(location, type);
  }

  async submit() {
    if (!this.locationService.isLocationValidForBooking(this.pickupLocation) || 
        (this.type !== ServiceTypeEnum.ERRAND && !this.locationService.isLocationValidForBooking(this.dropoffLocation))) {
      const toast = await this.toastCtrl.create({ 
        message: 'Please provide valid pickup and dropoff locations.', 
        duration: 2000, 
        color: 'warning' 
      });
      toast.present();
      return;
    }

    const loading = await this.loadingCtrl.create({ message: 'Creating booking...' });
    await loading.present();

    try {
      const formVal = this.bookingForm.value;
      const bookingData = {
        pickup_address: formVal.pickup_address,
        pickup_lat: this.pickupLocation.latitude || 0,
        pickup_lng: this.pickupLocation.longitude || 0,
        dropoff_address: formVal.dropoff_address || 'Errand Delivery',
        dropoff_lat: this.dropoffLocation.latitude || 0,
        dropoff_lng: this.dropoffLocation.longitude || 0,
        service_type_id: this.serviceType()?.id,
        total_price: this.estimatedPrice()
      };

      const details = this.getDetailsPayload(formVal);

      const booking = await this.bookingService.createBooking(bookingData, details, this.type);
      
      // Track booking creation with source info
      const eventName = this.pickupLocation.source === 'gps' ? 'booking_created_with_gps' :
                        this.pickupLocation.source === 'map' ? 'booking_created_with_map_selection' :
                        'booking_created_with_manual_address';
      
      this.analytics.track(eventName, { 
        booking_id: booking.id, 
        type: this.type,
        pickup_source: this.pickupLocation.source,
        dropoff_source: this.dropoffLocation.source
      });

      await loading.dismiss();
      this.nav.navigateForward(['/customer/tracking', booking.id]);
    } catch (e: unknown) {
      await loading.dismiss();
      const message = e instanceof Error ? e.message : 'An error occurred';
      const toast = await this.toastCtrl.create({ message, duration: 3000, color: 'danger' });
      toast.present();
    }
  }

  private getDetailsPayload(formVal: Record<string, string | number | boolean | null | undefined>) {
    switch (this.type) {
      case ServiceTypeEnum.RIDE:
        return { passenger_count: formVal['passenger_count'], notes: formVal['notes'] };
      case ServiceTypeEnum.ERRAND:
        return { items_list: (formVal['items_list'] as string)?.split(',') || [], estimated_budget: formVal['estimated_budget'], delivery_instructions: formVal['notes'] };
      case ServiceTypeEnum.DELIVERY:
        return { recipient_name: formVal['recipient_name'], recipient_phone: formVal['recipient_phone'], notes: formVal['notes'] };
      case ServiceTypeEnum.VAN:
        return { helper_count: formVal['helper_count'], has_elevator: formVal['has_elevator'], notes: formVal['notes'] };
      default:
        return { notes: formVal['notes'] };
    }
  }
}
