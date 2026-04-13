import { Component, inject, signal, OnInit, ViewChild, DestroyRef, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { IonicModule, LoadingController, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { 
  chevronBackOutline, 
  navigate, 
  informationCircle, 
  locationOutline, 
  locate, 
  pinOutline, 
  peopleOutline, 
  cartOutline, 
  cashOutline, 
  constructOutline, 
  businessOutline, 
  shieldCheckmark, 
  carOutline, 
  cubeOutline, 
  busOutline, 
  helpCircleOutline,
  searchOutline,
  swapHorizontalOutline,
  closeCircleOutline,
  walletOutline
} from 'ionicons/icons';
import { Router, ActivatedRoute } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { PricingService } from '../../../../../core/services/pricing.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { AnalyticsService } from '../../../../../core/services/analytics/analytics.service';
import { PaymentService } from '../../../../../core/services/stripe/payment.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { WalletService } from '../../../../../core/services/wallet/wallet.service';
import { GeocodingService } from '../../../../../core/services/maps/geocoding.service';
import { RoutingService } from '../../../../../core/services/maps/routing.service';
import { FareCalculationService } from '../../../../../core/services/maps/fare-calculation.service';
import { ServiceType, ServiceTypeEnum, UnifiedLocation } from '../../../../../shared/models/booking.model';
import { ButtonComponent, InputComponent, PriceDisplayComponent } from '../../../../../shared/ui';
import { MapComponent } from '../../../../../shared/components/map/map.component';
import { AutocompleteResult, RouteSummary } from '../../../../../core/models/maps/route-result.model';
import { FareEstimate } from '../../../../../core/models/maps/fare-estimate.model';
import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';
@Component({
  selector: 'app-booking-request',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">{{ getTitle() }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="flex flex-col h-full">
        <!-- Map Section -->
        <div class="w-full h-[40vh] relative z-10 shadow-lg">
          <app-map #map></app-map>
          
          @if (routeResult()) {
            <div class="absolute bottom-6 left-6 right-6 bg-white/95 backdrop-blur-xl p-5 rounded-3xl shadow-2xl border border-white/40 animate-in fade-in slide-in-from-bottom-6">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-200">
                    <ion-icon name="navigate" class="text-2xl"></ion-icon>
                  </div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Estimated Trip</p>
                    <p class="text-lg font-display font-bold text-slate-900">
                      {{ (routeResult()?.distanceMeters! / 1000).toFixed(1) }} km • {{ (routeResult()?.durationSeconds! / 60).toFixed(0) }} mins
                    </p>
                  </div>
                </div>
              </div>
            </div>
          }
        </div>

        <!-- Form Section -->
        <div class="flex-1 bg-white rounded-t-[3rem] -mt-10 relative z-20 shadow-[0_-20px_40px_-15px_rgba(0,0,0,0.1)] p-8 overflow-y-auto">
          <div class="max-w-2xl mx-auto space-y-8 pb-32">
            
            <div class="flex items-center gap-5 p-2">
              <div class="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-900 shadow-sm border border-slate-100">
                <ion-icon [name]="getIcon()" class="text-2xl"></ion-icon>
              </div>
              <div>
                <h2 class="text-2xl font-display font-bold text-slate-900 tracking-tight mb-0.5">{{ getTitle() }}</h2>
                <p class="text-slate-400 font-medium text-sm">Trusted local movement for your needs.</p>
              </div>
            </div>

            @if (locationService.locationError()) {
              <div class="p-5 bg-amber-50 border border-amber-100 rounded-3xl flex items-center gap-4 text-amber-800 text-sm font-medium animate-in fade-in slide-in-from-top-2">
                <ion-icon name="information-circle" class="text-2xl text-amber-500 shrink-0"></ion-icon>
                <div class="flex-1">
                  <p>{{ locationService.locationError() }}</p>
                  <button (click)="locationService.setManualMode()" class="text-blue-600 font-bold uppercase tracking-widest text-[10px] mt-2">Continue with manual address</button>
                </div>
              </div>
            }

            <form [formGroup]="bookingForm" (ngSubmit)="submit()" class="space-y-8">
              <div class="space-y-6">
                <div class="relative">
                  <app-input 
                    label="Pickup Location" 
                    formControlName="pickup_address" 
                    (input)="onAddressInput('pickup', $any($event).target.value)"
                    placeholder="Where should we pick up?"
                    icon="location-outline"
                    (focus)="showPickupResults.set(true)"
                    (blur)="hideResults('pickup')">
                    
                    @if (showPickupResults() && pickupResults().length > 0) {
                      <div dropdown class="absolute z-[9999] left-0 right-0 top-[calc(100%+8px)] bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-y-auto max-h-[280px] animate-in fade-in zoom-in-95 duration-200">
                        @for (result of pickupResults(); track result.label) {
                          <button type="button" 
                                  (mousedown)="selectResult('pickup', result)"
                                  class="w-full px-5 py-4 text-left hover:bg-slate-50 flex items-center gap-3 border-b border-slate-50 last:border-0 transition-colors">
                            <div class="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 shrink-0">
                              <ion-icon name="location-outline" class="text-lg"></ion-icon>
                            </div>
                            <div class="flex-1 min-w-0">
                              <p class="text-sm font-bold text-slate-900 truncate">{{ result.label }}</p>
                              <p class="text-[9px] text-slate-400 truncate uppercase tracking-widest font-bold">Select Location</p>
                            </div>
                          </button>
                        }
                      </div>
                    }
                  </app-input>

                  <button type="button" 
                          (click)="useCurrentLocation('pickup')"
                          class="absolute right-4 top-10 text-blue-600 font-bold text-[10px] uppercase tracking-widest hover:text-blue-700 transition-colors bg-blue-50/50 px-3 py-1 rounded-full z-10">
                    <ion-icon name="locate" class="mr-1 align-middle"></ion-icon>
                    Current
                  </button>
                </div>

                <div class="relative">
                  <app-input 
                    label="Dropoff Location" 
                    formControlName="dropoff_address" 
                    (input)="onAddressInput('dropoff', $any($event).target.value)"
                    placeholder="Where should we deliver?"
                    icon="pin-outline"
                    (focus)="showDropoffResults.set(true)"
                    (blur)="hideResults('dropoff')">

                    @if (showDropoffResults() && dropoffResults().length > 0) {
                      <div dropdown class="absolute z-[9999] left-0 right-0 top-[calc(100%+8px)] bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-y-auto max-h-[280px] animate-in fade-in zoom-in-95 duration-200">
                        @for (result of dropoffResults(); track result.label) {
                          <button type="button" 
                                  (mousedown)="selectResult('dropoff', result)"
                                  class="w-full px-5 py-4 text-left hover:bg-slate-50 flex items-center gap-3 border-b border-slate-50 last:border-0 transition-colors">
                            <div class="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 shrink-0">
                              <ion-icon name="pin-outline" class="text-lg"></ion-icon>
                            </div>
                            <div class="flex-1 min-w-0">
                              <p class="text-sm font-bold text-slate-900 truncate">{{ result.label }}</p>
                              <p class="text-[9px] text-slate-400 truncate uppercase tracking-widest font-bold">Select Destination</p>
                            </div>
                          </button>
                        }
                      </div>
                    }
                  </app-input>

                  <button type="button" 
                          (click)="useCurrentLocation('dropoff')"
                          class="absolute right-4 top-10 text-blue-600 font-bold text-[10px] uppercase tracking-widest hover:text-blue-700 transition-colors bg-blue-50/50 px-3 py-1 rounded-full z-10">
                    <ion-icon name="locate" class="mr-1 align-middle"></ion-icon>
                    Current
                  </button>
                </div>
              </div>

              @if (type === ServiceTypeEnum.RIDE) {
                <div class="p-6 bg-slate-50 rounded-3xl border border-slate-100">
                  <app-input 
                    label="Number of Passengers" 
                    type="number" 
                    formControlName="passenger_count"
                    icon="people-outline">
                  </app-input>
                </div>
              }

              @if (type === ServiceTypeEnum.ERRAND) {
                <div class="p-6 bg-slate-50 rounded-3xl border border-slate-100 space-y-6">
                  <div class="space-y-3">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Errand Type</p>
                    <div class="grid grid-cols-3 gap-2">
                      <button (click)="bookingForm.patchValue({ errand_mode: 'collect_deliver' })"
                              [class.bg-blue-600]="bookingForm.get('errand_mode')?.value === 'collect_deliver'"
                              [class.text-white]="bookingForm.get('errand_mode')?.value === 'collect_deliver'"
                              [class.bg-white]="bookingForm.get('errand_mode')?.value !== 'collect_deliver'"
                              [class.text-slate-600]="bookingForm.get('errand_mode')?.value !== 'collect_deliver'"
                              class="flex flex-col items-center gap-2 p-3 rounded-2xl border border-slate-100 shadow-sm transition-all active:scale-95">
                        <ion-icon name="swap-horizontal-outline" class="text-lg"></ion-icon>
                        <span class="text-[8px] font-bold uppercase text-center leading-tight">Collect & Deliver</span>
                      </button>
                      <button (click)="bookingForm.patchValue({ errand_mode: 'quick_buy' })"
                              [class.bg-blue-600]="bookingForm.get('errand_mode')?.value === 'quick_buy'"
                              [class.text-white]="bookingForm.get('errand_mode')?.value === 'quick_buy'"
                              [class.bg-white]="bookingForm.get('errand_mode')?.value !== 'quick_buy'"
                              [class.text-slate-600]="bookingForm.get('errand_mode')?.value !== 'quick_buy'"
                              class="flex flex-col items-center gap-2 p-3 rounded-2xl border border-slate-100 shadow-sm transition-all active:scale-95">
                        <ion-icon name="cart-outline" class="text-lg"></ion-icon>
                        <span class="text-[8px] font-bold uppercase text-center leading-tight">Quick Buy</span>
                      </button>
                      <button (click)="bookingForm.patchValue({ errand_mode: 'shop_deliver' })"
                              [class.bg-blue-600]="bookingForm.get('errand_mode')?.value === 'shop_deliver'"
                              [class.text-white]="bookingForm.get('errand_mode')?.value === 'shop_deliver'"
                              [class.bg-white]="bookingForm.get('errand_mode')?.value !== 'shop_deliver'"
                              [class.text-slate-600]="bookingForm.get('errand_mode')?.value !== 'shop_deliver'"
                              class="flex flex-col items-center gap-2 p-3 rounded-2xl border border-slate-100 shadow-sm transition-all active:scale-95">
                        <ion-icon name="business-outline" class="text-lg"></ion-icon>
                        <span class="text-[8px] font-bold uppercase text-center leading-tight">Shop & Deliver</span>
                      </button>
                    </div>
                  </div>

                  <div class="space-y-2">
                    <label for="items_list" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Items to Buy</label>
                    <textarea 
                      id="items_list"
                      formControlName="items_list" 
                      placeholder="List the items you need (e.g. Milk, Bread, Eggs...)"
                      class="w-full px-6 py-5 rounded-2xl bg-white border border-slate-100 text-slate-900 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-600/5 focus:border-blue-500 transition-all min-h-[120px] placeholder:text-slate-300 shadow-sm">
                    </textarea>
                  </div>
                  <div class="space-y-2">
                    <app-input 
                      label="Item Cost Budget" 
                      type="number" 
                      formControlName="estimated_budget"
                      icon="cash-outline"
                      placeholder="How much should the driver spend?">
                    </app-input>
                    <p class="px-2 text-[9px] text-slate-400 font-bold uppercase tracking-widest leading-relaxed">
                      This is the amount the driver will spend on your items. This is <strong>separate</strong> from the service fare.
                    </p>
                  </div>

                  <div class="p-6 bg-white rounded-3xl border border-slate-100 space-y-4">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Contact Information</p>
                    <app-input 
                      label="Your Phone" 
                      type="tel" 
                      formControlName="customer_phone"
                      icon="call-outline"
                      placeholder="Your contact number">
                    </app-input>
                    <div class="grid grid-cols-2 gap-4">
                      <app-input 
                        label="Recipient Name" 
                        formControlName="recipient_name"
                        icon="person-outline"
                        placeholder="Optional">
                      </app-input>
                      <app-input 
                        label="Recipient Phone" 
                        type="tel" 
                        formControlName="recipient_phone"
                        icon="call-outline"
                        placeholder="Optional">
                      </app-input>
                    </div>
                  </div>

                  <div class="p-6 bg-white rounded-3xl border border-slate-100 space-y-4">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Substitution Rule</p>
                    <ion-radio-group formControlName="substitution_rule">
                      <div class="space-y-3">
                        <div class="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                          <div class="flex items-center gap-3">
                            <ion-icon name="call-outline" class="text-blue-600"></ion-icon>
                            <span class="text-xs font-bold text-slate-700">Contact me</span>
                          </div>
                          <ion-radio value="contact_me"></ion-radio>
                        </div>
                        <div class="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                          <div class="flex items-center gap-3">
                            <ion-icon name="swap-horizontal-outline" class="text-blue-600"></ion-icon>
                            <span class="text-xs font-bold text-slate-700">Best match</span>
                          </div>
                          <ion-radio value="best_match"></ion-radio>
                        </div>
                        <div class="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                          <div class="flex items-center gap-3">
                            <ion-icon name="close-circle-outline" class="text-blue-600"></ion-icon>
                            <span class="text-xs font-bold text-slate-700">Do not substitute</span>
                          </div>
                          <ion-radio value="do_not_substitute"></ion-radio>
                        </div>
                      </div>
                    </ion-radio-group>
                  </div>
                </div>
              }

              @if (type === ServiceTypeEnum.VAN) {
                <div class="p-6 bg-slate-50 rounded-3xl border border-slate-100 space-y-6">
                  <div class="space-y-3">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Move Size</p>
                    <div class="grid grid-cols-2 gap-3">
                      @for (size of moveSizes; track size.id) {
                        <button type="button"
                                (click)="bookingForm.patchValue({ size: size.id })"
                                [class.bg-blue-600]="bookingForm.get('size')?.value === size.id"
                                [class.text-white]="bookingForm.get('size')?.value === size.id"
                                [class.bg-white]="bookingForm.get('size')?.value !== size.id"
                                [class.text-slate-600]="bookingForm.get('size')?.value !== size.id"
                                class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-slate-100 shadow-sm transition-all active:scale-95">
                          <ion-icon [name]="size.icon" class="text-xl"></ion-icon>
                          <span class="text-[10px] font-bold uppercase tracking-tight">{{ size.label }}</span>
                        </button>
                      }
                    </div>
                  </div>

                  <div class="grid grid-cols-2 gap-4">
                    <app-input 
                      label="Helpers" 
                      type="number" 
                      formControlName="helper_count"
                      icon="people-outline">
                    </app-input>
                    <app-input 
                      label="Floor Number" 
                      type="number" 
                      formControlName="floor_number"
                      icon="business-outline">
                    </app-input>
                  </div>

                  <div class="space-y-3">
                    <div class="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
                      <div class="flex items-center gap-3">
                        <ion-icon name="business-outline" class="text-blue-600"></ion-icon>
                        <span class="text-xs font-bold text-slate-700">Has Elevator?</span>
                      </div>
                      <ion-checkbox formControlName="has_elevator" color="primary"></ion-checkbox>
                    </div>
                    <div class="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
                      <div class="flex items-center gap-3">
                        <ion-icon name="layers-outline" class="text-blue-600"></ion-icon>
                        <span class="text-xs font-bold text-slate-700">Stairs Involved?</span>
                      </div>
                      <ion-checkbox formControlName="stairs_involved" color="primary"></ion-checkbox>
                    </div>
                    <div class="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
                      <div class="flex items-center gap-3">
                        <ion-icon name="shield-checkmark" class="text-blue-600"></ion-icon>
                        <span class="text-xs font-bold text-slate-700">Fragile Items?</span>
                      </div>
                      <ion-checkbox formControlName="fragile_items" color="primary"></ion-checkbox>
                    </div>
                    <div class="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
                      <div class="flex items-center gap-3">
                        <ion-icon name="construct-outline" class="text-blue-600"></ion-icon>
                        <span class="text-xs font-bold text-slate-700">Packing Help?</span>
                      </div>
                      <ion-checkbox formControlName="packing_assistance" color="primary"></ion-checkbox>
                    </div>
                  </div>
                </div>
              }

              <div class="space-y-2">
                <label for="notes" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Special Instructions</label>
                <textarea 
                  id="notes"
                  formControlName="notes" 
                  placeholder="Any extra details for the driver?"
                  class="w-full px-6 py-5 rounded-2xl bg-slate-50 border border-slate-100 text-slate-900 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-600/5 focus:border-blue-500 transition-all min-h-[100px] placeholder:text-slate-300">
                </textarea>
              </div>

              <!-- Pricing -->
              @if (fareEstimate()) {
                <div class="animate-in fade-in slide-in-from-bottom-4 space-y-4">
                  <app-price-display 
                    [total]="fareEstimate()?.total || 0" 
                    [fare]="fareEstimate()?.subtotal || 0" 
                    [serviceFee]="fareEstimate()?.serviceFee || 0"
                    [itemBudget]="bookingForm.get('estimated_budget')?.value || 0"
                    [minimumFareApplied]="fareEstimate()?.minimumFareApplied || false">
                  </app-price-display>

                  @if (type === ServiceTypeEnum.ERRAND) {
                    <div class="p-5 rounded-3xl border transition-all" 
                         [class.bg-emerald-50]="!hasInsufficientFunds()" 
                         [class.border-emerald-100]="!hasInsufficientFunds()"
                         [class.bg-rose-50]="hasInsufficientFunds()"
                         [class.border-rose-100]="hasInsufficientFunds()">
                      <div class="flex items-center justify-between mb-3">
                        <div class="flex items-center gap-3">
                          <div class="w-8 h-8 rounded-xl flex items-center justify-center"
                               [class.bg-emerald-500]="!hasInsufficientFunds()"
                               [class.bg-rose-500]="hasInsufficientFunds()">
                            <ion-icon name="wallet-outline" class="text-white text-lg"></ion-icon>
                          </div>
                          <div>
                            <p class="text-[10px] font-bold uppercase tracking-widest"
                               [class.text-emerald-600]="!hasInsufficientFunds()"
                               [class.text-rose-600]="hasInsufficientFunds()">
                              Wallet Balance
                            </p>
                            <p class="text-sm font-bold text-slate-900">
                              {{ config.formatCurrency(walletService.wallet()?.available_balance || 0) }}
                            </p>
                          </div>
                        </div>
                        @if (hasInsufficientFunds()) {
                          <app-button variant="secondary" size="sm" (click)="router.navigate(['/customer/wallet'])">
                            Top Up
                          </app-button>
                        }
                      </div>

                      @if (hasInsufficientFunds()) {
                        <div class="mt-4 p-4 bg-rose-100/50 rounded-2xl border border-rose-200 animate-pulse">
                          <p class="text-xs font-bold text-rose-700 flex items-center gap-2">
                            <ion-icon name="alert-circle"></ion-icon>
                            Total Reserved Required: {{ config.formatCurrency(estimatedPrice() + (bookingForm.get('estimated_budget')?.value || 0)) }}
                          </p>
                          <p class="text-[10px] font-bold text-rose-600 uppercase tracking-widest leading-relaxed mt-1">
                            Insufficient funds. You need {{ config.formatCurrency((estimatedPrice() + (bookingForm.get('estimated_budget')?.value || 0)) - (walletService.wallet()?.available_balance || 0)) }} more.
                          </p>
                        </div>
                      } @else {
                        <p class="text-[10px] font-bold text-emerald-600 uppercase tracking-widest leading-relaxed">
                          Funds will be reserved from your wallet.
                        </p>
                      }
                    </div>
                  }
                </div>
              }

              <div class="pt-6">
                <app-button type="submit" [disabled]="!bookingForm.valid || submitting() || hasInsufficientFunds()" size="lg" class="w-full shadow-xl shadow-blue-200">
                  {{ submitting() ? 'Processing...' : (type === ServiceTypeEnum.ERRAND ? 'Reserve & Confirm' : 'Confirm & Pay') }}
                </app-button>
                <p class="text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-8 flex items-center justify-center gap-2">
                  <ion-icon name="shield-checkmark" class="text-emerald-500 text-sm"></ion-icon>
                  Secure payment via Movabi Pay
                </p>
              </div>
            </form>
          </div>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, ReactiveFormsModule, ButtonComponent, InputComponent, PriceDisplayComponent, MapComponent]
})
export class BookingRequestPage implements OnInit {
  @ViewChild('map') mapComponent!: MapComponent;

  private fb = inject(FormBuilder);
  private route = inject(ActivatedRoute);
  public router = inject(Router);
  private bookingService = inject(BookingService);
  private pricingService = inject(PricingService);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);
  private paymentService = inject(PaymentService);
  private auth = inject(AuthService);
  public walletService = inject(WalletService);
  public config = inject(AppConfigService);
  public locationService = inject(LocationService);
  private analytics = inject(AnalyticsService);
  private geocoding = inject(GeocodingService);
  private routing = inject(RoutingService);
  private fareCalculator = inject(FareCalculationService);
  private destroyRef = inject(DestroyRef);

  constructor() {
    addIcons({ 
      chevronBackOutline, 
      navigate, 
      informationCircle, 
      locationOutline, 
      locate, 
      pinOutline, 
      peopleOutline, 
      cartOutline, 
      cashOutline, 
      constructOutline, 
      businessOutline, 
      shieldCheckmark, 
      carOutline, 
      cubeOutline, 
      busOutline, 
      helpCircleOutline,
      searchOutline,
      swapHorizontalOutline,
      closeCircleOutline,
      walletOutline
    });
  }

  ServiceTypeEnum = ServiceTypeEnum;
  type: ServiceTypeEnum = ServiceTypeEnum.RIDE;
  bookingForm!: FormGroup;
  estimatedPrice = signal(0);
  submitting = signal(false);
  serviceType = signal<ServiceType | null>(null);

  pickupLocation: UnifiedLocation = { source: 'manual', address: '' };
  dropoffLocation: UnifiedLocation = { source: 'manual', address: '' };

  pickupResults = signal<AutocompleteResult[]>([]);
  dropoffResults = signal<AutocompleteResult[]>([]);
  showPickupResults = signal(false);
  showDropoffResults = signal(false);
  
  routeResult = signal<RouteSummary | null>(null);
  fareEstimate = signal<FareEstimate | null>(null);

  hasInsufficientFunds = computed(() => {
    if (this.type !== ServiceTypeEnum.ERRAND) return false;
    const itemBudget = parseFloat(this.bookingForm?.get('estimated_budget')?.value) || 0;
    const totalRequired = this.estimatedPrice() + itemBudget;
    const balance = this.walletService.wallet()?.available_balance || 0;
    return balance < totalRequired;
  });
  
  moveSizes = [
    { id: 'small', label: 'Small (Few items)', icon: 'cube-outline' },
    { id: 'medium', label: 'Medium (1-2 rooms)', icon: 'business-outline' },
    { id: 'large', label: 'Large (3-4 rooms)', icon: 'home-outline' },
    { id: 'full-house', label: 'Full House', icon: 'storefront-outline' }
  ];

  private pickupSearch$ = new Subject<string>();
  private dropoffSearch$ = new Subject<string>();

  ngOnInit() {
    const typeParam = this.route.snapshot.queryParams['type'];
    this.type = (typeParam as ServiceTypeEnum) || ServiceTypeEnum.RIDE;
    this.initForm();
    this.loadPricing();

    this.pickupSearch$.pipe(
      debounceTime(400),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(query => {
      this.performSearch('pickup', query);
    });

    this.dropoffSearch$.pipe(
      debounceTime(400),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(query => {
      this.performSearch('dropoff', query);
    });
  }

  async useCurrentLocation(type: 'pickup' | 'dropoff') {
    const loading = await this.loadingCtrl.create({ 
      message: 'Locating...',
      spinner: 'crescent'
    });
    await loading.present();

    const pos = await this.locationService.getCurrentPosition();
    if (pos) {
      const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      
      this.geocoding.reverseGeocode(coords.lat, coords.lng).subscribe(address => {
        loading.dismiss();
        const finalAddress = address || `Current Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`;
        
        if (type === 'pickup') {
          this.pickupLocation = this.locationService.normalizeLocation('gps', coords, finalAddress);
          this.bookingForm.patchValue({ pickup_address: finalAddress }, { emitEvent: false });
          this.updateMarker('pickup');
        } else {
          this.dropoffLocation = this.locationService.normalizeLocation('gps', coords, finalAddress);
          this.bookingForm.patchValue({ dropoff_address: finalAddress }, { emitEvent: false });
          this.updateMarker('dropoff');
        }
        this.updateRoute();
      });
    } else {
      await loading.dismiss();
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
          dropoff_address: ['', Validators.required],
          items_list: ['', Validators.required],
          estimated_budget: [0, [Validators.required, Validators.min(1)]],
          errand_mode: ['collect_deliver', Validators.required],
          customer_phone: [this.auth.currentUser()?.phone || '', Validators.required],
          recipient_phone: [''],
          recipient_name: [''],
          substitution_rule: ['contact_me']
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
          size: ['small', Validators.required],
          helper_count: [1, [Validators.required, Validators.min(0)]],
          floor_number: [0],
          has_elevator: [false],
          stairs_involved: [false],
          fragile_items: [false],
          packing_assistance: [false]
        });
        break;
    }

    // No longer using valueChanges for autocomplete to avoid fragile coupling
    this.bookingForm.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.recalculateFare();
    });
  }

  onAddressInput(type: 'pickup' | 'dropoff', query: string) {
    if (type === 'pickup') {
      this.pickupLocation.address = query;
      this.pickupSearch$.next(query);
    } else {
      this.dropoffLocation.address = query;
      this.dropoffSearch$.next(query);
    }
  }

  private performSearch(type: 'pickup' | 'dropoff', query: string) {
    if (!query || query.length < 3) {
      if (type === 'pickup') {
        this.pickupResults.set([]);
        this.showPickupResults.set(false);
      } else {
        this.dropoffResults.set([]);
        this.showDropoffResults.set(false);
      }
      return;
    }

    this.geocoding.autocomplete(query).subscribe(results => {
      if (type === 'pickup') {
        this.pickupResults.set(results);
        this.showPickupResults.set(true);
      } else {
        this.dropoffResults.set(results);
        this.showDropoffResults.set(true);
      }
    });
  }

  hideResults(type: 'pickup' | 'dropoff') {
    setTimeout(() => {
      if (type === 'pickup') this.showPickupResults.set(false);
      else this.showDropoffResults.set(false);
    }, 250);
  }

  selectResult(type: 'pickup' | 'dropoff', result: AutocompleteResult) {
    if (type === 'pickup') {
      this.pickupLocation = this.locationService.normalizeLocation('map', { lat: result.lat, lng: result.lng }, result.label);
      this.bookingForm.patchValue({ pickup_address: result.label }, { emitEvent: false });
      this.showPickupResults.set(false);
      this.updateMarker('pickup');
    } else {
      this.dropoffLocation = this.locationService.normalizeLocation('map', { lat: result.lat, lng: result.lng }, result.label);
      this.bookingForm.patchValue({ dropoff_address: result.label }, { emitEvent: false });
      this.showDropoffResults.set(false);
      this.updateMarker('dropoff');
    }
    this.updateRoute();
  }

  private updateMarker(kind: 'pickup' | 'dropoff') {
    const loc = kind === 'pickup' ? this.pickupLocation : this.dropoffLocation;
    if (loc.latitude && loc.longitude) {
      this.mapComponent.addOrUpdateMarker({
        id: kind,
        kind: kind === 'pickup' ? 'pickup' : 'destination',
        serviceType: this.getServiceSlug(),
        coordinates: { lat: loc.latitude, lng: loc.longitude },
        label: kind === 'pickup' ? 'Pickup' : 'Dropoff'
      });
      
      if (!this.pickupLocation.latitude || !this.dropoffLocation.latitude) {
        this.mapComponent.setCenter(loc.longitude, loc.latitude, 14);
      }
    }
  }

  private updateRoute() {
    if (this.pickupLocation.latitude && this.pickupLocation.longitude && 
        this.dropoffLocation.latitude && this.dropoffLocation.longitude) {
      
      const pickup = { lat: this.pickupLocation.latitude, lng: this.pickupLocation.longitude };
      const dropoff = { lat: this.dropoffLocation.latitude, lng: this.dropoffLocation.longitude };

      // Defensive guard against NaN coordinates
      if (isNaN(pickup.lat) || isNaN(pickup.lng) || isNaN(dropoff.lat) || isNaN(dropoff.lng)) {
        console.warn('[BookingRequest] Invalid coordinates for route update', { pickup, dropoff });
        return;
      }

      this.routing.getRoute(pickup, dropoff).subscribe(result => {
        if (result) {
          this.routeResult.set(result);
          this.mapComponent.drawRoute(result);
          
          // Fit bounds with mobile-safe padding
          this.mapComponent.fitBounds([
            [pickup.lng, pickup.lat],
            [dropoff.lng, dropoff.lat]
          ], { padding: { top: 80, bottom: 320, left: 50, right: 50 } });

          this.recalculateFare();
        } else {
          this.routeResult.set(null);
          this.mapComponent.clearRoute();
          this.recalculateFare();
        }
      });
    } else {
      this.routeResult.set(null);
      this.fareEstimate.set(null);
      this.mapComponent.clearRoute();
    }
  }

  async loadPricing() {
    const types = await this.bookingService.getServiceTypes();
    const selected = types.find((t: ServiceType) => t.slug === this.type);
    if (selected) {
      this.serviceType.set(selected);
    }
  }

  private recalculateFare() {
    const route = this.routeResult();
    const serviceSlug = this.getServiceSlug();

    if (!route) {
      // Fallback if routing fails but we want a base estimate
      const fallbackEstimate = this.fareCalculator.calculateFare({
        serviceType: serviceSlug,
        distanceMeters: 0,
        durationSeconds: 0
      });
      this.fareEstimate.set(fallbackEstimate);
      this.estimatedPrice.set(fallbackEstimate.total);
      return;
    }

    const formVal = this.bookingForm.value;
    const estimate = this.fareCalculator.calculateFare({
      serviceType: serviceSlug,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      basePriceOverride: this.serviceType()?.base_price,
      errandDetails: serviceSlug === 'errand' ? {
        mode: formVal.errand_mode
      } : null,
      moveDetails: serviceSlug === 'van-moving' ? {
        size: formVal.size,
        helperCount: formVal.helper_count,
        stairsInvolved: formVal.stairs_involved,
        packingAssistance: formVal.packing_assistance,
        fragileItems: formVal.fragile_items
      } : null
    });
    this.fareEstimate.set(estimate);
    this.estimatedPrice.set(estimate.total);
  }

  getValidationError(type: 'pickup' | 'dropoff'): string | null {
    const location = type === 'pickup' ? this.pickupLocation : this.dropoffLocation;
    return this.locationService.getLocationValidationMessage(location, type);
  }

  getTitle(): string {
    switch (this.type) {
      case ServiceTypeEnum.RIDE: return 'Ride Request';
      case ServiceTypeEnum.ERRAND: return 'Errand Service';
      case ServiceTypeEnum.DELIVERY: return 'Package Delivery';
      case ServiceTypeEnum.VAN: return 'Van Moving';
      default: return 'Booking Request';
    }
  }

  getIcon(): string {
    switch (this.type) {
      case ServiceTypeEnum.RIDE: return 'car-outline';
      case ServiceTypeEnum.ERRAND: return 'cart-outline';
      case ServiceTypeEnum.DELIVERY: return 'cube-outline';
      case ServiceTypeEnum.VAN: return 'bus-outline';
      default: return 'help-circle-outline';
    }
  }

  async submit() {
    if (this.submitting()) return;

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

    this.submitting.set(true);
    const loading = await this.loadingCtrl.create({ message: 'Processing request...' });
    await loading.present();

    try {
      const formVal = this.bookingForm.value;
      const itemBudget = this.type === ServiceTypeEnum.ERRAND ? (formVal['estimated_budget'] as number || 0) : 0;
      const totalRequired = this.estimatedPrice() + itemBudget;

      // For Errands, we use the Wallet Funded Model
      if (this.type === ServiceTypeEnum.ERRAND) {
        loading.message = 'Checking wallet balance...';
        const wallet = await this.walletService.fetchWallet();
        if (!wallet || wallet.available_balance < totalRequired) {
          throw new Error(`Insufficient wallet balance. You need ${this.config.formatCurrency(totalRequired)} to fund this errand (Fare: ${this.config.formatCurrency(this.estimatedPrice())} + Budget: ${this.config.formatCurrency(itemBudget)}). Please top up your wallet.`);
        }
      }

      const bookingData = {
        pickup_address: formVal.pickup_address,
        pickup_lat: this.pickupLocation.latitude || 0,
        pickup_lng: this.pickupLocation.longitude || 0,
        dropoff_address: formVal.dropoff_address || 'Errand Delivery',
        dropoff_lat: this.dropoffLocation.latitude || 0,
        dropoff_lng: this.dropoffLocation.longitude || 0,
        service_type_id: this.serviceType()?.id,
        total_price: this.estimatedPrice(),
        distance_meters: this.routeResult()?.distanceMeters || 0,
        duration_seconds: this.routeResult()?.durationSeconds || 0,
        metadata: this.getMetadataPayload(formVal)
      };

      const details = this.getDetailsPayload(formVal);

      // 1. Create Job in 'requested' state
      const booking = await this.bookingService.createBooking(bookingData, details, this.type);
      
      if (this.type === ServiceTypeEnum.ERRAND) {
        // 2. Reserve funds from wallet for Errand
        loading.message = 'Reserving funds from wallet...';
        await this.walletService.reserveErrandFunds(booking.id, itemBudget, this.estimatedPrice());

        // 3. Activate Job (Skip Stripe for now if wallet is used)
        loading.message = 'Activating errand...';
        await this.bookingService.confirmJobPayment(booking.id, 'wallet_funded');
      } else {
        // Standard Stripe flow for Ride/Van
        loading.message = 'Initializing payment...';
        // 2. Create Payment Intent
        const { clientSecret } = await this.paymentService.createPaymentIntent(
          booking.id, 
          booking.total_price, 
          this.config.currencyCode,
          this.auth.tenantId() || ''
        );

        // 3. Confirm Payment
        loading.message = 'Confirming payment...';
        const paymentIntent = await this.paymentService.confirmPayment(clientSecret);

        // 4. Activate Job
        loading.message = 'Activating job...';
        await this.bookingService.confirmJobPayment(booking.id, paymentIntent.id);
      }

      this.analytics.track('booking_created', { 
        job_id: booking.id, 
        type: this.type,
        pickup_source: this.pickupLocation.source,
        distance_km: (bookingData.distance_meters / 1000).toFixed(2)
      });

      await loading.dismiss();
      this.router.navigate(['/customer/tracking', booking.id]);
    } catch (e: unknown) {
      await loading.dismiss();
      this.submitting.set(false);
      const message = e instanceof Error ? e.message : 'An error occurred';
      const toast = await this.toastCtrl.create({ message, duration: 3000, color: 'danger' });
      toast.present();
    }
  }

  private getMetadataPayload(formVal: Record<string, unknown>) {
    if (this.type === ServiceTypeEnum.VAN) {
      return {
        move_details: {
          size: formVal['size'] as string,
          helperCount: formVal['helper_count'] as number,
          hasElevator: formVal['has_elevator'] as boolean,
          stairsInvolved: formVal['stairs_involved'] as boolean,
          floorNumber: formVal['floor_number'] as number,
          fragileItems: formVal['fragile_items'] as boolean,
          packingAssistance: formVal['packing_assistance'] as boolean,
          itemSummary: formVal['notes'] as string
        }
      };
    }
    if (this.type === ServiceTypeEnum.ERRAND) {
      return {
        errand_details: {
          items: (formVal['items_list'] as string)?.split(',').map(i => i.trim()) || [],
          budget: formVal['estimated_budget'] as number
        }
      };
    }
    return undefined;
  }

  private getDetailsPayload(formVal: Record<string, string | number | boolean | null | undefined>) {
    switch (this.type) {
      case ServiceTypeEnum.RIDE:
        return { passenger_count: formVal['passenger_count'], notes: formVal['notes'] };
      case ServiceTypeEnum.ERRAND:
        return { 
          items_list: (formVal['items_list'] as string)?.split(',').map(i => i.trim()) || [], 
          estimated_budget: formVal['estimated_budget'], 
          delivery_instructions: formVal['notes'],
          customer_phone: formVal['customer_phone'],
          recipient_phone: formVal['recipient_phone'],
          recipient_name: formVal['recipient_name'],
          substitution_rule: formVal['substitution_rule']
        };
      case ServiceTypeEnum.DELIVERY:
        return { recipient_name: formVal['recipient_name'], recipient_phone: formVal['recipient_phone'], notes: formVal['notes'] };
      case ServiceTypeEnum.VAN:
        return { 
          helper_count: formVal['helper_count'], 
          has_elevator: formVal['has_elevator'], 
          notes: formVal['notes'] 
        };
      default:
        return { notes: formVal['notes'] };
    }
  }

  private getServiceSlug(): ServiceTypeSlug {
    switch (this.type) {
      case ServiceTypeEnum.RIDE: return 'ride';
      case ServiceTypeEnum.ERRAND: return 'errand';
      case ServiceTypeEnum.VAN: return 'van-moving';
      default: return 'ride';
    }
  }
}
