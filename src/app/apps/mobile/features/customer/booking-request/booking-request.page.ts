import {
    Component,
    inject,
    signal,
    OnInit,
    ViewChild,
    DestroyRef,
    computed,
    ElementRef,
    OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    FormsModule,
    ReactiveFormsModule,
    FormBuilder,
    FormGroup,
    Validators,
    AbstractControl
} from '@angular/forms';
import { IonicModule, LoadingController, ToastController } from '@ionic/angular';
import { Stripe, StripeElements, StripeCardElement } from '@stripe/stripe-js';
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
    closeCircle,
    closeCircleOutline,
    closeOutline,
    walletOutline,
    alertCircle,
    homeOutline,
    storefrontOutline,
    personOutline,
    callOutline,
    layersOutline,
    navigateOutline,
    informationCircleOutline,
    chevronDownOutline,
    chevronUpOutline,
    calendarOutline
} from 'ionicons/icons';
import { Router, ActivatedRoute } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged, firstValueFrom } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { BookingService } from '../../../../../core/services/booking/booking.service';
import { PricingService } from '../../../../../core/services/pricing.service';
import { MarketplaceConfigService, MarketplaceEffectiveHybridStatus, MarketplaceSettings } from '../../../../../core/services/marketplace/marketplace-config.service';
import { AppConfigService, PopularShopPreset } from '../../../../../core/services/config/app-config.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { AnalyticsService } from '../../../../../core/services/analytics/analytics.service';
import { PaymentService } from '../../../../../core/services/stripe/payment.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { WalletService } from '../../../../../core/services/wallet/wallet.service';
import { GeocodingService } from '../../../../../core/services/maps/geocoding.service';
import { RoutingService } from '../../../../../core/services/maps/routing.service';
import { PricingConfigService } from '../../../../../core/services/pricing/pricing-config.service';
import {
    GlobalAiPricingQuoteService,
    GlobalAiPricingFareBreakdown
} from '../../../../../core/services/pricing/global-ai-pricing-quote.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { ComplianceService } from '../../../../../core/services/compliance/compliance.service';

import {
    Booking,
    Profile,
    ServiceType,
    ServiceTypeEnum,
    UnifiedLocation
} from '../../../../../shared/models/booking.model';

import {
    ButtonComponent,
    InputComponent
} from '../../../../../shared/ui';

import { MapComponent } from '../../../../../shared/components/map/map.component';
import { LocalServiceSelectorComponent } from '../../../../../shared/components/local-service-selector/local-service-selector.component';
import { LocalServiceCategory, LocalServicesService, LocalServiceSelection } from '../../../../../core/services/local-services.service';

import {
    AutocompleteResult,
    RouteSummary
} from '../../../../../core/models/maps/route-result.model';

import { FareEstimate } from '../../../../../core/models/maps/fare-estimate.model';
import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';

type ErrandMode = 'collect_deliver' | 'quick_buy' | 'shop_deliver';
type VehicleClass = 'bike' | 'standard' | 'xl' | 'car' | 'small_van' | 'large_van' | 'minibus';
type PackageSize = 'small' | 'medium' | 'large';

@Component({
    selector: 'app-booking-request',
    standalone: true,
    imports: [
        IonicModule,
        CommonModule,
        FormsModule,
        ReactiveFormsModule,
        ButtonComponent,
        InputComponent,
        MapComponent,
        LocalServiceSelectorComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">{{ getTitle() }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50" [fullscreen]="true">
      <div class="flex flex-col h-full ion-padding-bottom">
        <div class="w-full h-[33vh] min-h-[250px] relative z-10 shadow-lg">
          <app-map #map></app-map>

          @if (routeResult()) {
            <div class="absolute bottom-3 left-4 right-4 bg-white/95 backdrop-blur-xl p-4 rounded-2xl shadow-2xl border border-white/40 animate-in fade-in slide-in-from-bottom-6">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-200 shrink-0">
                    <ion-icon name="navigate" class="text-2xl"></ion-icon>
                  </div>
                  <div class="min-w-0">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Estimated Trip</p>
                    <p class="text-lg font-display font-bold text-slate-900">
                      {{ (routeResult()?.distanceMeters! / 1000).toFixed(1) }} km &bull; {{ (routeResult()?.durationSeconds! / 60).toFixed(0) }} mins
                    </p>
                    
                  </div>
                </div>
              </div>
            </div>
          }
        </div>

        <div class="flex-1 bg-white rounded-t-[1.75rem] -mt-4 relative z-20 shadow-[0_-20px_40px_-15px_rgba(0,0,0,0.1)] px-3 pt-3 pb-8 overflow-y-auto ion-padding-bottom">
          <div class="max-w-2xl mx-auto space-y-3 pb-safe">
            <div class="service-identity">
              <div class="service-identity__icon">
                <ion-icon [name]="getIcon()" class="text-xl"></ion-icon>
              </div>
              <div class="min-w-0">
                <h2 class="service-identity__title">{{ getServiceLabel() }}</h2>
                <p class="service-identity__desc">{{ getServiceDescription() }}</p>
              </div>
            </div>

            @if (locationService.locationError()) {
              <div class="p-4 bg-amber-50 border border-amber-100 rounded-2xl flex items-center gap-3 text-amber-800 text-sm font-medium animate-in fade-in slide-in-from-top-2">
                <ion-icon name="information-circle" class="text-2xl text-amber-500 shrink-0"></ion-icon>
                <div class="flex-1">
                  <p>{{ locationService.locationError() }}</p>
                  <button type="button" (click)="locationService.setManualMode()" class="text-blue-600 font-bold uppercase tracking-widest text-[10px] mt-2">
                    Continue with manual address
                  </button>
                </div>
              </div>
            }

            <form [formGroup]="bookingForm" (ngSubmit)="submit()" class="space-y-4">
              @if (type === ServiceTypeEnum.ERRAND) {
                <div class="p-3 bg-slate-50 rounded-3xl border border-slate-100 space-y-3">
                  <div class="space-y-3">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Shop Type</p>
                    <div class="grid grid-cols-3 gap-3">
                      <button
                        type="button"
                        (click)="setErrandMode('collect_deliver')"
                        [class.bg-blue-600]="bookingForm.get('errand_mode')?.value === 'collect_deliver'"
                        [class.text-white]="bookingForm.get('errand_mode')?.value === 'collect_deliver'"
                        [class.bg-white]="bookingForm.get('errand_mode')?.value !== 'collect_deliver'"
                        [class.text-slate-600]="bookingForm.get('errand_mode')?.value !== 'collect_deliver'"
                        class="min-h-[92px] flex flex-col items-center justify-center text-center gap-2 px-2 py-3 rounded-2xl border border-slate-100 shadow-sm transition-all active:scale-95">
                        <ion-icon name="swap-horizontal-outline" class="text-lg shrink-0"></ion-icon>
                        <span class="text-[10px] font-bold uppercase leading-tight text-center whitespace-normal">
                          Collect & Deliver
                        </span>
                      </button>

                      <button
                        type="button"
                        (click)="setErrandMode('quick_buy')"
                        [class.bg-blue-600]="bookingForm.get('errand_mode')?.value === 'quick_buy'"
                        [class.text-white]="bookingForm.get('errand_mode')?.value === 'quick_buy'"
                        [class.bg-white]="bookingForm.get('errand_mode')?.value !== 'quick_buy'"
                        [class.text-slate-600]="bookingForm.get('errand_mode')?.value !== 'quick_buy'"
                        class="min-h-[92px] flex flex-col items-center justify-center text-center gap-2 px-2 py-3 rounded-2xl border border-slate-100 shadow-sm transition-all active:scale-95">
                        <ion-icon name="cart-outline" class="text-lg shrink-0"></ion-icon>
                        <span class="text-[10px] font-bold uppercase leading-tight text-center whitespace-normal">
                          Quick Buy
                        </span>
                      </button>

                      <button
                        type="button"
                        (click)="setErrandMode('shop_deliver')"
                        [class.bg-blue-600]="bookingForm.get('errand_mode')?.value === 'shop_deliver'"
                        [class.text-white]="bookingForm.get('errand_mode')?.value === 'shop_deliver'"
                        [class.bg-white]="bookingForm.get('errand_mode')?.value !== 'shop_deliver'"
                        [class.text-slate-600]="bookingForm.get('errand_mode')?.value !== 'shop_deliver'"
                        class="min-h-[92px] flex flex-col items-center justify-center text-center gap-2 px-2 py-3 rounded-2xl border border-slate-100 shadow-sm transition-all active:scale-95">
                        <ion-icon name="business-outline" class="text-lg shrink-0"></ion-icon>
                        <span class="text-[10px] font-bold uppercase leading-tight text-center whitespace-normal">
                          Shop & Deliver
                        </span>
                      </button>
                    </div>
                  </div>

                  @if (bookingForm.get('errand_mode')?.value === 'shop_deliver') {
                    <div class="space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Popular shops</p>
                        <p class="text-[10px] font-bold text-slate-400">Optional</p>
                      </div>
                      <div class="grid grid-cols-2 gap-3">
                        @for (shop of popularShopOptions(); track shop.name) {
                          <button
                            type="button"
                            (click)="selectPopularShop(shop)"
                            class="min-h-[76px] rounded-2xl bg-white border border-slate-100 shadow-sm p-3 text-left flex items-center gap-3 active:scale-95 transition-all">
                            <span class="w-12 h-12 rounded-2xl flex items-center justify-center text-xl font-black text-white shrink-0" [style.background]="shop.color">
                              {{ shop.logo }}
                            </span>
                            <span class="min-w-0">
                              <span class="block text-sm font-black text-slate-950 truncate">{{ shop.name }}</span>
                              <span class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Use nearby branch</span>
                            </span>
                          </button>
                        }
                      </div>
                      <p class="px-2 text-xs text-slate-400 font-semibold leading-relaxed">
                        Picking a shop fills pickup with a nearby branch search. You can still type a different shop or exact address.
                      </p>
                    </div>
                  }
                </div>
              }

              @if (showLocalServiceCatalogue()) {
                <app-local-service-selector
                  [countryCode]="localServiceCountryCode()"
                  [serviceSlug]="localServiceCatalogueSlug()"
                  [currentLocation]="localServiceCurrentLocation()"
                  [selectedCategoryId]="selectedLocalServiceCategoryId()"
                  [selectedProviderId]="selectedLocalServiceProviderId()"
                  [allowCustomEntry]="true"
                  (categoryChange)="onLocalServiceCategoryChange($event)"
                  (providerChange)="onLocalServiceProviderChange($event)"
                  (customProviderChange)="onLocalServiceCustomProvider($event)">
                </app-local-service-selector>
              }

              <div class="space-y-3">
                <div class="address-field">
                  <span class="address-field__icon">
                    <ion-icon name="location-outline"></ion-icon>
                  </span>
                  <div class="address-field__body">
                    <span class="address-field__label">Pickup</span>
                    <app-input
                      [dense]="true"
                      formControlName="pickup_address"
                      (input)="onAddressInput('pickup', $any($event).target.value)"
                      [placeholder]="pickupPlaceholder()"
                      (focus)="showPickupResults.set(true)"
                      (blur)="hideResults('pickup')">

                      @if (showPickupResults() && displayPickupResults().length > 0) {
                        <div dropdown class="address-results">
                          @for (result of displayPickupResults(); track result.label + '|' + result.lat + '|' + result.lng + '|' + $index) {
                            <button
                              type="button"
                              (mousedown)="selectResult('pickup', result)"
                              class="address-results__item focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500">
                              <div class="address-results__icon">
                                <ion-icon name="location-outline" class="text-lg"></ion-icon>
                              </div>
                              <div class="flex-1 min-w-0">
                                <p class="text-sm font-bold text-slate-900 truncate">{{ result.primaryText || result.label }}</p>
                                @if (result.secondaryText) {
                                  <p class="text-xs text-slate-500 truncate font-semibold">{{ result.secondaryText }}</p>
                                } @else if (pickupResults().length === 0) {
                                  <p class="text-xs text-slate-500 truncate font-semibold">Recent pickup</p>
                                }
                              </div>
                            </button>
                          }
                        </div>
                      }
                    </app-input>
                  </div>
                  <div class="address-field__action">
                    @if (pickupShowCurrentBadge()) {
                      <span class="address-badge">Current</span>
                    } @else if (bookingForm.get('pickup_address')?.value) {
                      <button type="button" aria-label="Clear pickup address" (click)="clearAddress('pickup')" class="address-action-btn">
                        <ion-icon name="close-circle"></ion-icon>
                      </button>
                    } @else {
                      <button type="button" aria-label="Use current location for pickup" (click)="useCurrentLocation('pickup')" class="address-action-btn">
                        <ion-icon name="locate"></ion-icon>
                      </button>
                    }
                  </div>
                </div>

                <div class="address-field">
                  <span class="address-field__icon address-field__icon--dropoff">
                    <ion-icon name="pin-outline"></ion-icon>
                  </span>
                  <div class="address-field__body">
                    <span class="address-field__label">Drop-off</span>
                    <app-input
                      [dense]="true"
                      formControlName="dropoff_address"
                      (input)="onAddressInput('dropoff', $any($event).target.value)"
                      [placeholder]="dropoffPlaceholder()"
                      (focus)="showDropoffResults.set(true)"
                      (blur)="hideResults('dropoff')">

                      @if (showDropoffResults() && displayDropoffResults().length > 0) {
                        <div dropdown class="address-results">
                          @for (result of displayDropoffResults(); track result.label + '|' + result.lat + '|' + result.lng + '|' + $index) {
                            <button
                              type="button"
                              (mousedown)="selectResult('dropoff', result)"
                              class="address-results__item focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500">
                              <div class="address-results__icon">
                                <ion-icon name="pin-outline" class="text-lg"></ion-icon>
                              </div>
                              <div class="flex-1 min-w-0">
                                <p class="text-sm font-bold text-slate-900 truncate">{{ result.primaryText || result.label }}</p>
                                @if (result.secondaryText) {
                                  <p class="text-xs text-slate-500 truncate font-semibold">{{ result.secondaryText }}</p>
                                } @else if (dropoffResults().length === 0) {
                                  <p class="text-xs text-slate-500 truncate font-semibold">Recent destination</p>
                                }
                              </div>
                            </button>
                          }
                        </div>
                      }
                    </app-input>
                  </div>
                  <div class="address-field__action">
                    @if (dropoffShowCurrentBadge()) {
                      <span class="address-badge">Current</span>
                    } @else if (bookingForm.get('dropoff_address')?.value) {
                      <button type="button" aria-label="Clear drop-off address" (click)="clearAddress('dropoff')" class="address-action-btn">
                        <ion-icon name="close-circle"></ion-icon>
                      </button>
                    } @else {
                      <button type="button" aria-label="Use current location for drop-off" (click)="useCurrentLocation('dropoff')" class="address-action-btn">
                        <ion-icon name="locate"></ion-icon>
                      </button>
                    }
                  </div>
                </div>
              </div>

              @if (type !== ServiceTypeEnum.VAN) {
                <div class="p-3 bg-slate-50 rounded-3xl border border-slate-100 space-y-3">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <p class="text-xs font-black text-slate-700">Choose vehicle</p>
                      <p class="text-sm font-bold text-slate-900 mt-1">{{ selectedVehicleLabel() }}</p>
                    </div>
                    <div class="w-11 h-11 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-200">
                      <ion-icon [name]="selectedVehicleIcon()" class="text-xl"></ion-icon>
                    </div>
                  </div>

                  <div class="grid grid-cols-3 gap-3">
                    @for (option of vehicleOptions(); track option.id) {
                      <button
                        type="button"
                        (click)="setVehicleClass(option.id)"
                        [class.bg-blue-600]="vehicleClass() === option.id"
                        [class.text-white]="vehicleClass() === option.id"
                        [class.border-blue-600]="vehicleClass() === option.id"
                        [class.bg-white]="vehicleClass() !== option.id"
                        [class.text-slate-700]="vehicleClass() !== option.id"
                        class="min-h-[92px] rounded-2xl border border-slate-100 shadow-sm p-3 text-center transition-all active:scale-95 flex flex-col items-center justify-center gap-2">
                        <ion-icon [name]="option.icon" class="text-xl"></ion-icon>
                        <span class="text-xs font-black leading-tight">{{ option.label }}</span>
                        <span class="text-[10px] font-bold leading-tight opacity-80">{{ option.helper }}</span>
                      </button>
                    }
                  </div>
                </div>
              }

              @if (type === ServiceTypeEnum.RIDE) {
                <div class="p-3 bg-slate-50 rounded-3xl border border-slate-100 space-y-3">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Passengers</p>
                      <p class="text-sm font-bold text-slate-900 mt-1">{{ rideVehicleLabel() }}</p>
                    </div>
                    <div class="w-11 h-11 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-200">
                      <ion-icon name="people-outline" class="text-xl"></ion-icon>
                    </div>
                  </div>

                  <div class="grid grid-cols-7 gap-2">
                    @for (count of passengerOptions; track count) {
                      <button
                        type="button"
                        (click)="setPassengerCount(count)"
                        [class.bg-blue-600]="passengerCount() === count"
                        [class.text-white]="passengerCount() === count"
                        [class.border-blue-600]="passengerCount() === count"
                        [class.bg-white]="passengerCount() !== count"
                        [class.text-slate-700]="passengerCount() !== count"
                        class="h-11 rounded-xl border border-slate-200 text-sm font-black transition-all active:scale-95">
                        {{ count }}
                      </button>
                    }
                  </div>

                  @if (passengerCount() > 4) {
                    <div class="p-3 rounded-2xl bg-amber-50 border border-amber-100">
                      <p class="text-xs font-bold text-amber-700 leading-relaxed">
                        5-7 passengers need a larger vehicle. {{ config.formatCurrency(largeRideSurcharge()) }} XL charge is added.
                      </p>
                    </div>
                  } @else {
                    <p class="text-xs text-slate-400 font-semibold leading-relaxed">
                      Standard cars can carry up to 4 passengers.
                    </p>
                  }

                  <label class="flex items-center justify-between gap-3 p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
                    <div>
                      <p class="text-sm font-black text-slate-900">Booking for someone else?</p>
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                        Show the rider name to the driver
                      </p>
                    </div>
                    <ion-checkbox formControlName="booking_for_someone_else" color="primary"></ion-checkbox>
                  </label>

                  @if (bookingForm.get('booking_for_someone_else')?.value) {
                    <app-input
                      label="Rider Name"
                      formControlName="rider_name"
                      icon="person-outline"
                      placeholder="Who is travelling?">
                    </app-input>
                  }
                </div>
              }

              @if (type === ServiceTypeEnum.ERRAND) {
                <div class="p-3 bg-slate-50 rounded-3xl border border-slate-100 space-y-4">
                  @if (usesItemListMode()) {
                    <div class="space-y-2">
                      <label for="items_list" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">
                        Items to Buy
                      </label>

                      <textarea
                        id="items_list"
                        formControlName="items_list"
                        placeholder="List the items you need (e.g. Milk, Bread, Eggs...)"
                        class="w-full px-4 py-3 rounded-xl bg-white border border-slate-100 text-slate-900 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-600/5 focus:border-blue-500 transition-all min-h-[100px] placeholder:text-slate-300 shadow-sm">
                      </textarea>

                      <p class="px-2 text-[9px] text-slate-400 font-bold uppercase tracking-widest">
                        {{ itemCount() }} ITEM{{ itemCount() === 1 ? '' : 'S' }}
                        @if (additionalItemCharge() > 0) {
                          &bull; +{{ config.formatCurrency(additionalItemCharge()) }} extra item charge
                        }
                      </p>
                    </div>
                  }

                  @if (usesBudgetMode()) {
                    <div class="space-y-2">
                      <label for="estimated_budget" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">
                        Item Cost Budget
                      </label>
                      <div
                        class="flex items-center gap-3 w-full px-4 py-4 rounded-xl bg-white border border-slate-100 shadow-sm">
                        <ion-icon name="cash-outline" class="text-slate-400 text-xl shrink-0"></ion-icon>
                        <input
                          id="estimated_budget"
                          type="text"
                          inputmode="decimal"
                          [value]="displayBudgetValue()"
                          (input)="onBudgetInput($any($event).target.value)"
                          (blur)="formatBudgetOnBlur()"
                          placeholder="0.00"
                          class="w-full bg-transparent border-0 outline-none text-slate-900 text-lg font-bold placeholder:text-slate-300" />
                      </div>
                      @if (bookingForm.get('estimated_budget')?.hasError('invalidCurrency')) {
                        <p class="text-red-500 text-xs mt-1 ml-1">Enter a valid amount, for example 15 or 15.50.</p>
                      }

                      <div class="reservation-note">
                        <ion-icon name="information-circle-outline" class="reservation-note__icon"></ion-icon>
                        <p class="reservation-note__text">{{ itemBudgetDescription() }}</p>
                      </div>
                    </div>
                  }

                  <div class="p-4 bg-white rounded-xl border border-slate-100 space-y-3">
                    <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-1">Recipient Contact (optional)</p>
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
                    @if (bookingForm.get('recipient_phone')?.hasError('invalidPhone') || bookingForm.get('recipient_phone')?.hasError('invalidPhoneLength')) {
                      <p class="text-red-500 text-xs mt-1 ml-1">Enter a valid phone number.</p>
                    }
                  </div>

                  @if (usesItemListMode()) {
                    <div class="p-4 bg-white rounded-xl border border-slate-100 space-y-3">
                      <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-1">Substitution Rule</p>
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
                }
              </div>
              }

              @if (type === ServiceTypeEnum.DELIVERY) {
                <div class="p-3 bg-slate-50 rounded-3xl border border-slate-100 space-y-3">
                  <div class="space-y-3">
                    <p class="text-xs font-black text-slate-700 ml-1">Parcel size</p>
                    <div class="grid grid-cols-3 gap-3">
                      @for (size of packageSizeOptions; track size.id) {
                        <button
                          type="button"
                          (click)="setPackageSize(size.id)"
                          [class.bg-blue-600]="packageSize() === size.id"
                          [class.text-white]="packageSize() === size.id"
                          [class.border-blue-600]="packageSize() === size.id"
                          [class.bg-white]="packageSize() !== size.id"
                          [class.text-slate-700]="packageSize() !== size.id"
                          class="min-h-[82px] rounded-2xl border border-slate-100 shadow-sm p-3 text-center transition-all active:scale-95 flex flex-col items-center justify-center gap-1">
                          <span class="text-xs font-black">{{ size.label }}</span>
                          <span class="text-[10px] font-bold leading-tight opacity-80">{{ size.helper }}</span>
                        </button>
                      }
                    </div>
                  </div>

                  <div class="p-4 bg-white rounded-xl border border-slate-100 space-y-3">
                    <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-1">
                      Recipient Contact
                    </p>

                    <div class="grid grid-cols-1 gap-4">
                      <app-input
                        label="Recipient Name"
                        formControlName="recipient_name"
                        icon="person-outline"
                        placeholder="Who should receive it?">
                      </app-input>

                      <app-input
                        label="Recipient Phone"
                        type="tel"
                        formControlName="recipient_phone"
                        icon="call-outline"
                        placeholder="Recipient contact number">
                      </app-input>
                    </div>
                    @if (bookingForm.get('recipient_phone')?.hasError('invalidPhone') || bookingForm.get('recipient_phone')?.hasError('invalidPhoneLength')) {
                      <p class="text-red-500 text-xs mt-1 ml-1">Enter a valid phone number.</p>
                    }
                  </div>

                  <div class="space-y-2">
                    <label for="item_description" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">
                      Parcel Details
                    </label>

                    <textarea
                      id="item_description"
                      formControlName="item_description"
                      placeholder="Describe the parcel, size, or handling notes."
                      class="w-full px-4 py-3 rounded-xl bg-white border border-slate-100 text-slate-900 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-600/5 focus:border-blue-500 transition-all min-h-[90px] placeholder:text-slate-300 shadow-sm">
                    </textarea>
                  </div>

                  <div class="p-4 bg-blue-50 rounded-xl border border-blue-100">
                    <p class="text-sm leading-7 text-slate-700">
                      Deliver requests are for parcels, documents, and small-to-medium items. For furniture or large items, use Move.
                    </p>
                  </div>
                </div>
              }

              @if (type === ServiceTypeEnum.VAN) {
                <div class="p-3 bg-slate-50 rounded-xl border border-slate-100 space-y-3">
                  <div class="space-y-3">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Move Size</p>
                    <div class="grid grid-cols-2 gap-3">
                      @for (size of moveSizes(); track size.id) {
                        <button
                          type="button"
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
                  class="w-full px-4 py-3 rounded-xl bg-slate-50 border border-slate-100 text-slate-900 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-600/5 focus:border-blue-500 transition-all min-h-[80px] placeholder:text-slate-300">
                </textarea>
              </div>

                @if (fareCalculating() && !fareEstimate() && !shouldShowMarketplaceFare()) {
                  <div class="p-6 bg-white rounded-[2rem] border border-slate-100 shadow-lg shadow-slate-200/40 flex items-center gap-3 animate-in fade-in">
                    <ion-spinner name="crescent" color="primary"></ion-spinner>
                    <p class="text-sm font-bold text-slate-500">Calculating your fare...</p>
                  </div>
                }

                @if (fareCalculationError() && !fareCalculating()) {
                  <div class="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-700 text-sm font-medium animate-in fade-in">
                    <ion-icon name="information-circle" class="text-2xl text-red-500 shrink-0"></ion-icon>
                    <p class="flex-1">{{ fareCalculationError() }}</p>
                  </div>
                }

                @if (shouldShowMarketplaceFare()) {
                  <div class="animate-in fade-in slide-in-from-bottom-4 space-y-4">
                    <div class="p-6 bg-white rounded-[2rem] border border-slate-100 shadow-lg shadow-slate-200/40">
                      <div class="flex items-start justify-between gap-4">
                        <div>
                          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                            Marketplace Fare
                          </p>
                          <h3 class="text-4xl font-display font-black text-blue-600 tracking-tight">
                            {{ config.formatCurrency(cardChargeRequired()) }}
                          </h3>
                        </div>
                        <div class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100">
                          <ion-icon name="storefront-outline" class="text-2xl"></ion-icon>
                        </div>
                      </div>

                      <div class="mt-5 p-4 bg-blue-50 rounded-2xl border border-blue-100">
                        <p class="text-sm leading-7 text-slate-700">
                          This is the <strong>suggested fare</strong> for your request.
                          On the next screen you can <strong>Accept Fare</strong> or <strong>Make an Offer</strong>.
                          Payment is only collected after the fare is agreed.
                        </p>
                      </div>

                      <div class="mt-5 p-4 bg-white rounded-xl border border-slate-100 shadow-sm">
                        <div class="flex items-center justify-between">
                          <div>
                            <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Suggested Fare</p>
                            <p class="text-sm font-bold text-slate-900">Driver fare and platform fee</p>
                          </div>
                          <p class="text-lg font-display font-bold text-slate-900">
                            {{ config.formatCurrency(cardChargeRequired()) }}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                }

                @if (fareEstimate() && !shouldShowMarketplaceFare()) {
                  <div class="animate-in fade-in slide-in-from-bottom-4 space-y-4">

                    <div class="p-6 bg-white rounded-[2rem] border border-slate-100 shadow-lg shadow-slate-200/40">
                      <div class="flex items-start justify-between gap-4">
                        <div>
                          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                            {{ type === ServiceTypeEnum.ERRAND ? 'Service Estimate' : 'Card Authorisation' }}
                          </p>

                          <h3 class="text-4xl font-display font-black text-blue-600 tracking-tight">
                            {{ config.formatCurrency(cardChargeRequired()) }}
                          </h3>
                        </div>

                        <div class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100">
                          <ion-icon [name]="type === ServiceTypeEnum.ERRAND ? 'cart-outline' : 'shield-checkmark'" class="text-2xl"></ion-icon>
                        </div>
                      </div>

                      @if (type === ServiceTypeEnum.ERRAND) {
                        <div class="mt-5 p-4 bg-blue-50 rounded-2xl border border-blue-100">
                          <p class="text-sm leading-7 text-slate-700">
                            The <strong>Service Estimate</strong> will be authorised on your card.
                            You will only be charged once the shop service is completed.
                          </p>
                        </div>
                      } @else {
                        <div class="mt-5 p-4 bg-blue-50 rounded-2xl border border-blue-100">
                          <p class="text-sm leading-7 text-slate-700">
                            This amount will be securely authorised on your card.
                            You will only be charged once the job is completed.
                          </p>
                        </div>
                      }

                      <div class="mt-5 p-4 bg-white rounded-xl border border-slate-100 shadow-sm space-y-3">
                        @if (type === ServiceTypeEnum.ERRAND) {
                          <div class="flex items-center justify-between">
                            <div>
                              <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Shopping Budget (Reserved)</p>
                              <p class="text-sm font-bold text-slate-900">Reserved for item purchase</p>
                            </div>
                            <p class="text-lg font-display font-bold text-slate-900">
                              {{ config.formatCurrency(walletBudgetRequired()) }}
                            </p>
                          </div>

                          <div class="h-px bg-slate-100"></div>

                          <div class="flex items-center justify-between">
                            <div>
                              <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Service Fare</p>
                              <p class="text-sm font-bold text-slate-900">Booking, distance &amp; time</p>
                            </div>
                            <p class="text-lg font-display font-bold text-slate-900">
                              {{ config.formatCurrency(cardChargeRequired()) }}
                            </p>
                          </div>

                          <div class="h-px bg-slate-100"></div>

                          <div class="flex items-center justify-between">
                            <div>
                              <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Estimated Total</p>
                              <p class="text-sm font-bold text-slate-900">Budget + Service Fare</p>
                            </div>
                            <p class="text-lg font-display font-bold text-blue-600">
                              {{ config.formatCurrency(walletPaymentRequired()) }}
                            </p>
                          </div>
                        } @else {
                          <div class="flex items-center justify-between">
                            <div>
                              <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                                Fare
                              </p>
                              <p class="text-sm font-bold text-slate-900">
                                Driver fare and platform fee
                              </p>
                            </div>
                            <p class="text-lg font-display font-bold text-slate-900">
                              {{ config.formatCurrency(cardChargeRequired()) }}
                            </p>
                          </div>
                        }
                      </div>

                      @if (fareEstimate()?.minimumFareApplied) {
                        <div class="mt-4 px-4 py-2 bg-blue-50 border border-blue-100 rounded-xl">
                          <p class="text-[10px] font-bold text-blue-600 uppercase tracking-widest text-center">
                            Minimum fare applied
                          </p>
                        </div>
                      }
                    </div>

                    <div class="p-4 bg-slate-950 text-white rounded-2xl shadow-xl shadow-slate-200 space-y-4">
                      <div class="flex items-start justify-between gap-4">
                        <div class="min-w-0">
                          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                            Payment
                          </p>
                          <h3 class="mt-1 text-xl font-display font-bold">
                            {{ paymentPlanLabel() }}
                          </h3>
                          <p class="mt-1 text-xs font-semibold text-slate-300 leading-relaxed">
                            {{ paymentPlanDescription() }}
                          </p>
                        </div>

                        <div
                          class="shrink-0 px-3 py-2 rounded-full text-[10px] font-bold uppercase tracking-widest"
                          [class.bg-emerald-400]="walletCoversPayment()"
                          [class.text-slate-950]="walletCoversPayment()"
                          [class.bg-white]="!walletCoversPayment()"
                          [class.text-slate-900]="!walletCoversPayment()">
                          {{ walletCoversPayment() ? 'Wallet' : 'Card' }}
                        </div>
                      </div>

                      <div class="grid grid-cols-3 gap-2">
                        <div class="p-3 bg-white/10 rounded-xl border border-white/10">
                          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                            Wallet
                          </p>
                          <p class="mt-1 text-sm font-bold">
                            {{ config.formatCurrency(walletBalance()) }}
                          </p>
                        </div>

                        <div class="p-3 bg-white/10 rounded-xl border border-white/10">
                          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                            Total
                          </p>
                          <p class="mt-1 text-sm font-bold">
                            {{ config.formatCurrency(walletPaymentRequired()) }}
                          </p>
                        </div>

                        <div class="p-3 bg-white/10 rounded-xl border border-white/10">
                          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                            Card
                          </p>
                          <p class="mt-1 text-sm font-bold">
                            {{ config.formatCurrency(cardFallbackAmount()) }}
                          </p>
                        </div>
                      </div>

                      @if (walletShortfall() > 0) {
                        <div class="p-3 bg-amber-400/15 rounded-xl border border-amber-300/30">
                          <p class="text-xs font-bold text-amber-100 flex items-center gap-2">
                            <ion-icon name="alert-circle"></ion-icon>
                            Wallet is short by {{ config.formatCurrency(walletShortfall()) }}. We will use your card for this request.
                          </p>
                        </div>
                      } @else {
                        <div class="p-3 bg-emerald-400/15 rounded-xl border border-emerald-300/30">
                          <p class="text-xs font-bold text-emerald-100 flex items-center gap-2">
                            <ion-icon name="wallet-outline"></ion-icon>
                            Your wallet covers this request. No card authorization needed.
                          </p>
                        </div>
                      }
                    </div>

                    @if (cardFallbackRequired()) {
                      <div class="p-4 bg-slate-50 rounded-xl border border-slate-100 space-y-3">
                        <div class="flex items-center justify-between">
                          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-1">
                            Card Fallback
                          </p>
                          <p class="text-xs font-bold text-slate-700">
                            {{ config.formatCurrency(cardFallbackAmount()) }}
                          </p>
                        </div>

                        <div
                          #cardElementContainer
                          class="p-4 bg-white rounded-xl border border-slate-100 min-h-[52px]">
                        </div>

                        @if (!cardReady() && !cardError()) {
                          <p class="mt-2 text-xs text-slate-500 font-bold px-2">
                            Loading card input...
                          </p>
                        }

                        @if (cardError()) {
                          <p class="mt-2 text-xs text-rose-600 font-bold px-2">
                            {{ cardError() }}
                          </p>
                        }
                      </div>
                    }
                  </div>
                }

              <div class="pt-4">
                <app-button
                  type="submit"
                  [disabled]="!canSubmit()"
                  size="lg"
                  class="w-full shadow-xl shadow-blue-200">
                 {{ checkoutButtonLabel() }}
                </app-button>

                <p class="text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-6 flex items-center justify-center gap-2">
                  <ion-icon name="shield-checkmark" class="text-emerald-500 text-sm"></ion-icon>
                  {{ paymentSecurityLabel() }}
                </p>
              </div>
            </form>
          </div>
        </div>
      </div>
    </ion-content>
  `,
    styles: [`
    .reservation-note {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 12px;
      border-radius: 14px;
      background: #f8fafc;
      border: 1px solid #f1f5f9;
    }
    .reservation-note__icon {
      font-size: 16px;
      color: #94a3b8;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .reservation-note__text {
      font-size: 13px;
      font-weight: 600;
      color: #64748b;
      line-height: 1.45;
      letter-spacing: normal;
      text-transform: none;
    }
    .service-identity {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 4px;
      min-height: 78px;
    }
    .service-identity__icon {
      width: 48px;
      height: 48px;
      border-radius: 16px;
      background: #f8fafc;
      border: 1px solid #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #0f172a;
      flex-shrink: 0;
    }
    .service-identity__title {
      font-weight: 800;
      font-size: 1.3rem;
      color: #0f172a;
      line-height: 1.15;
    }
    .service-identity__desc {
      font-size: 0.8125rem;
      font-weight: 600;
      color: #94a3b8;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .address-field {
      position: relative;
      display: grid;
      grid-template-columns: 40px minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-height: 64px;
      padding: 8px 12px;
      border-radius: 18px;
      background: #f8fafc;
      border: 1px solid #eef2f6;
    }
    .address-field__icon {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: #fff7ed;
      color: #ea580c;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      flex-shrink: 0;
    }
    .address-field__icon--dropoff {
      background: #eff6ff;
      color: #2563eb;
    }
    .address-field__body {
      min-width: 0;
    }
    .address-field__label {
      display: block;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8;
      margin-bottom: 2px;
      margin-left: 2px;
    }
    .address-field__action {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
    }
    .address-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      padding: 0 12px;
      border-radius: 999px;
      background: #eff6ff;
      color: #2563eb;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      white-space: nowrap;
    }
    .address-action-btn {
      width: 44px;
      height: 44px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #94a3b8;
      font-size: 20px;
      background: transparent;
    }
    .address-action-btn:active {
      background: #f1f5f9;
    }
    .address-action-btn:focus-visible {
      outline: 2px solid #f97316;
      outline-offset: 2px;
    }
    .address-results {
      position: absolute;
      z-index: 9999;
      left: 0;
      right: 0;
      top: calc(100% + 4px);
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 20px 40px -15px rgba(0,0,0,0.15);
      border: 1px solid #f1f5f9;
      overflow-y: auto;
      max-height: 240px;
    }
    .address-results__item {
      width: 100%;
      min-height: 54px;
      padding: 8px 10px;
      text-align: left;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid #f8fafc;
      transition: background-color 0.15s ease;
    }
    .address-results__item:last-child {
      border-bottom: none;
    }
    .address-results__item:hover,
    .address-results__item:focus-visible {
      background: #f8fafc;
    }
    .address-results__icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: #f8fafc;
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    @media (prefers-reduced-motion: reduce) {
      .address-results__item {
        transition: none;
      }
    }
  `]
})
export class BookingRequestPage implements OnInit, OnDestroy {
    @ViewChild('map') mapComponent!: MapComponent;

    private cardElementHost: ElementRef<HTMLDivElement> | null = null;

    @ViewChild('cardElementContainer')
    set cardElementContainerRef(ref: ElementRef<HTMLDivElement> | undefined) {
        if (ref && !this.cardElementHost) {
            this.cardElementHost = ref;
            void this.initStripeElements();
        } else if (!ref) {
            this.cardMounted = false;
            this.cardReady.set(false);
            this.cardComplete.set(false);
            this.cardElementHost = null;
        }
    }

    private fb = inject(FormBuilder);
    private route = inject(ActivatedRoute);
    public router = inject(Router);
    private bookingService = inject(BookingService);
    private pricingService = inject(PricingService);
    private marketplaceConfig = inject(MarketplaceConfigService);
    private localServices = inject(LocalServicesService);
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
    private pricingConfig = inject(PricingConfigService);
    private globalAiPricingQuote = inject(GlobalAiPricingQuoteService);
    private supabase = inject(SupabaseService);
    private compliance = inject(ComplianceService);
    private destroyRef = inject(DestroyRef);

    ServiceTypeEnum = ServiceTypeEnum;
    type: ServiceTypeEnum = ServiceTypeEnum.RIDE;
    bookingForm!: FormGroup;

    estimatedPrice = signal(0);
    submitting = signal(false);
    cardError = signal<string | null>(null);
    cardReady = signal(false);
    cardComplete = signal(false);
    paymentProcessing = signal(false);
    serviceType = signal<ServiceType | null>(null);

    budgetValue = signal(0);
    itemCount = signal(0);
    errandMode = signal<ErrandMode>('collect_deliver');
    formValidSignal = signal(false);

    private stripe: Stripe | null = null;
    private elements: StripeElements | null = null;
    private card: StripeCardElement | null = null;
    private stripeInitializing = false;
    private cardMounted = false;

    pickupLocation: UnifiedLocation = { source: 'manual', address: '' };
    dropoffLocation: UnifiedLocation = { source: 'manual', address: '' };

    packageSizeOptions: Array<{ id: PackageSize; label: string; helper: string }> = [
        { id: 'small', label: 'Small', helper: 'Envelope or small bag' },
        { id: 'medium', label: 'Medium', helper: 'Box or shopping bag' },
        { id: 'large', label: 'Large', helper: 'Bulky parcel' }
    ];

    popularShopOptions = computed(() => this.config.popularShops());

    pickupResults = signal<AutocompleteResult[]>([]);
    dropoffResults = signal<AutocompleteResult[]>([]);
    showPickupResults = signal(false);
    showDropoffResults = signal(false);
    pickupExpanded = signal(false);
    pickupAutofilling = signal(false);
    pickupManuallyChanged = signal(false);
    selectedLocalService = signal<Record<string, unknown> | null>(null);

    displayPickupResults = computed(() => this.pickupResults().length > 0
        ? this.pickupResults()
        : this.recentLocationResults('pickup')
    );

    displayDropoffResults = computed(() => this.dropoffResults().length > 0
        ? this.dropoffResults()
        : this.recentLocationResults('dropoff')
    );

    pickupSummaryTitle = computed(() => {
        const source = this.pickupLocation.source;
        if (source === 'gps') return 'Current location';
        if (source === 'map') return 'Selected on map';
        return this.pickupLocation.address?.trim() ? 'Saved pickup' : 'Choose pickup';
    });

    pickupSummaryAddress = computed(() => {
        const address = this.bookingForm?.get('pickup_address')?.value || this.pickupLocation.address;
        return String(address || '').trim() || 'Search for an address or use current location';
    });

    pickupPlaceholder = computed(() => {
        if (this.pickupAutofilling()) return 'Finding your current address…';
        return 'Search for pickup address';
    });

    dropoffPlaceholder = computed(() => {
        return this.type === ServiceTypeEnum.DELIVERY
            ? 'Where should we deliver the parcel?'
            : 'Where should we deliver?';
    });

    pickupShowCurrentBadge = computed(() => {
        return this.pickupLocation.source === 'gps' && !this.pickupManuallyChanged();
    });

    dropoffShowCurrentBadge = computed(() => {
        return this.dropoffLocation.source === 'gps';
    });

    showLocalServiceCatalogue = computed(() => {
        // Disabled for v1 hardening: Local Service Discovery catalogue (nearby provider
        // search, category accordions, brand-query bridge) is dormant until it is
        // independently stabilised and re-tested. Shop/Delivery flows use manual
        // shop/address entry + popular shop shortcuts only. Backend/service
        // infrastructure is untouched and can be re-enabled by restoring this check.
        return false;
    });

    localServiceCountryCode = computed(() => {
        return this.config.currentCountry()?.code || 'GB';
    });

    localServiceCatalogueSlug = computed(() => {
        if (this.type === ServiceTypeEnum.DELIVERY) return 'delivery';
        const mode = String(this.bookingForm?.get('errand_mode')?.value || 'collect_deliver') as ErrandMode;
        if (mode === 'quick_buy') return 'quick-buy';
        if (mode === 'shop_deliver') return 'errand';
        return 'collect-deliver';
    });

    localServiceCurrentLocation = computed(() => {
        const lat = this.pickupLocation.latitude;
        const lng = this.pickupLocation.longitude;
        return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
            ? { lat, lng }
            : null;
    });

    selectedLocalServiceCategoryId = computed(() => {
        return String(this.selectedLocalService()?.['categoryId'] || '').trim() || null;
    });

    selectedLocalServiceProviderId = computed(() => {
        return String(this.selectedLocalService()?.['providerId'] || '').trim() || null;
    });

    routeResult = signal<RouteSummary | null>(null);
    fareEstimate = signal<FareEstimate | null>(null);
    fareCalculating = signal(false);
    fareCalculationError = signal<string | null>(null);
    private lastFareBreakdown: GlobalAiPricingFareBreakdown | null = null;
    private lastQuoteReference: string | null = null;
    private lastQuoteExpiresAt: string | null = null;
    private fareRequestSequence = 0;
    negotiationSettings = signal<MarketplaceSettings['negotiation'] | null>(null);
    effectiveHybridStatus = signal<MarketplaceEffectiveHybridStatus | null>(null);

    shouldShowMarketplaceFare = computed(() => {
        return this.effectiveHybridStatus()?.enabled === true;
    });

    usesItemListMode = computed(() => {
        if (this.type !== ServiceTypeEnum.ERRAND) return false;
        return this.isQuickBuyMode(this.errandMode());
    });

    usesBudgetMode = computed(() => {
        if (this.type !== ServiceTypeEnum.ERRAND) return false;
        return this.isQuickBuyMode(this.errandMode());
    });

    walletBudgetRequired = computed(() => {
        if (this.type !== ServiceTypeEnum.ERRAND) return 0;
        return this.toMoney(this.budgetValue());
    });

    additionalItemCharge = computed(() => {
        if (this.type !== ServiceTypeEnum.ERRAND) return 0;
        if (!this.usesItemListMode()) return 0;

        const config = this.pricingConfig.getConfig(this.getServiceSlug());
        const freeItems = Math.max(0, Math.round(config.freeIncludedItems ?? 1));
        const extraItemFee = config.extraItemFee ?? 0.75;
        const extraItems = Math.max(0, this.itemCount() - freeItems);
        return this.toMoney(extraItems * extraItemFee);
    });

    largeShoppingSurcharge = computed(() => {
        if (this.type !== ServiceTypeEnum.ERRAND) return 0;
        if (!this.usesBudgetMode()) return 0;

        const config = this.pricingConfig.getConfig(this.getServiceSlug());
        const threshold = config.largeShoppingThreshold || 50;
        if (this.budgetValue() > threshold) {
            return this.toMoney(config.largeShoppingSurcharge || 0);
        }
        return 0;
    });

    driverItemCharge = computed(() => {
        return this.toMoney(this.additionalItemCharge() * 0.6);
    });

    platformItemCharge = computed(() => {
        return this.toMoney(this.additionalItemCharge() * 0.4);
    });

    cardChargeRequired = computed(() => {
        return this.toMoney(this.fareEstimate()?.total || 0);
    });

    walletBalance = computed(() => {
        return this.toMoney(this.walletService.wallet()?.available_balance || 0);
    });

    walletPaymentRequired = computed(() => {
        return this.toMoney(this.cardChargeRequired() + this.walletBudgetRequired());
    });

    walletCoversPayment = computed(() => {
        const required = this.walletPaymentRequired();
        return required > 0 && this.walletBalance() >= required;
    });

    walletShortfall = computed(() => {
        return this.toMoney(Math.max(0, this.walletPaymentRequired() - this.walletBalance()));
    });

    cardFallbackRequired = computed(() => {
        return this.walletPaymentRequired() > 0 && !this.walletCoversPayment();
    });

    cardFallbackAmount = computed(() => {
        return this.cardFallbackRequired() ? this.walletPaymentRequired() : 0;
    });

    canSubmit = computed(() => {
        if (!this.formValidSignal() || this.submitting() || this.paymentProcessing()) {
            return false;
        }

        if (this.shouldShowMarketplaceFare()) {
            return true;
        }

        if (this.cardFallbackRequired()) {
            return this.cardReady() && this.cardComplete();
        }

        return this.walletPaymentRequired() > 0;
    });

    moveSizes = signal([
        { id: 'small', label: 'Small (Few items)', icon: 'cube-outline' },
        { id: 'medium', label: 'Medium (1-2 rooms)', icon: 'business-outline' },
        { id: 'large', label: 'Large (3-4 rooms)', icon: 'home-outline' },
        { id: 'full-house', label: 'Full House', icon: 'storefront-outline' }
    ]);

    private pickupSearch$ = new Subject<string>();
    private dropoffSearch$ = new Subject<string>();
    private lastBookingTime = 0;
    private lastResolvedType: ServiceTypeEnum | null = null;
    readonly passengerOptions = [1, 2, 3, 4, 5, 6, 7];

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
            closeCircle,
            closeCircleOutline,
            closeOutline,
            walletOutline,
            alertCircle,
            homeOutline,
            storefrontOutline,
            personOutline,
            callOutline,
            layersOutline,
            navigateOutline,
            informationCircleOutline,
            chevronDownOutline,
            chevronUpOutline,
            calendarOutline
        });
    }

    ngOnInit() {
        void this.config.detectRuntimeCountry();
        void this.walletService.fetchWallet();
        void this.bookingService.getHistory();

        this.route.queryParamMap
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(params => {
                this.applyRequestedType(params.get('type'), params.get('mode'));
            });

        this.pickupSearch$
            .pipe(debounceTime(400), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
            .subscribe(query => {
                this.performSearch('pickup', query);
            });

        this.dropoffSearch$
            .pipe(debounceTime(400), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
            .subscribe(query => {
                this.performSearch('dropoff', query);
            });
    }

    private applyRequestedType(typeParam: unknown, modeParam?: unknown): void {
        const nextType = this.normalizeTypeParam(typeParam);
        const changed = this.lastResolvedType !== nextType;

        if (!changed) return;

        this.type = nextType;
        this.lastResolvedType = nextType;
        this.serviceType.set(null);
        this.fareEstimate.set(null);
        this.estimatedPrice.set(0);

        this.initForm();

        if (nextType === ServiceTypeEnum.ERRAND) {
            const requestedMode = String(modeParam || '').trim();
            if (requestedMode === 'quick_buy' || requestedMode === 'collect_deliver' || requestedMode === 'shop_deliver') {
                this.setErrandMode(requestedMode);
            }
        }

        void this.loadPricing();
        void this.autoPrefillPickupOnce();
    }

    private async autoPrefillPickupOnce(): Promise<void> {
        if (this.pickupManuallyChanged() || this.bookingForm?.get('pickup_address')?.value) return;

        this.pickupAutofilling.set(true);

        try {
            await this.useCurrentLocation('pickup', { silent: true, auto: true });
        } finally {
            this.pickupAutofilling.set(false);
            if (!this.bookingForm?.get('pickup_address')?.value) {
                this.pickupExpanded.set(true);
            }
        }
    }

    ngOnDestroy() {
        this.cardReady.set(false);
        this.cardComplete.set(false);
        this.paymentProcessing.set(false);
        this.cardMounted = false;

        if (this.card) {
            this.card.destroy();
            this.card = null;
        }

        this.elements = null;
        this.stripe = null;
    }

    private normalizeTypeParam(value: unknown): ServiceTypeEnum {
        const raw = String(value || '').trim().toLowerCase();

        if (raw === ServiceTypeEnum.ERRAND || raw === 'errand' || raw === 'shop' || raw === 'shopping') return ServiceTypeEnum.ERRAND;
        if (raw === ServiceTypeEnum.DELIVERY || raw === 'delivery' || raw === 'courier' || raw === 'parcel' || raw === 'package') return ServiceTypeEnum.DELIVERY;
        if (raw === ServiceTypeEnum.VAN || raw === 'van' || raw === 'van-moving' || raw === 'moving' || raw === 'move') return ServiceTypeEnum.VAN;

        return ServiceTypeEnum.RIDE;
    }

    private canonicalServiceSlug(slug: string): string {
        const raw = String(slug || '').trim().toLowerCase();

        if (['shop', 'shopping', 'errands', 'errand'].includes(raw)) return 'errand';
        if (['courier', 'parcel', 'package', 'delivery'].includes(raw)) return 'delivery';
        if (['van', 'moving', 'move', 'van-moving', 'van moving', 'van_moving'].includes(raw)) return 'van-moving';
        if (['ride', 'rides'].includes(raw)) return 'ride';

        return raw;
    }

    private isQuickBuyMode(mode: unknown): mode is ErrandMode {
        return mode === 'quick_buy' || mode === 'shop_deliver';
    }

    private isCollectDeliverMode(mode: unknown): mode is ErrandMode {
        return mode === 'collect_deliver';
    }

    setErrandMode(mode: ErrandMode): void {
        this.bookingForm.patchValue({ errand_mode: mode });
    }

    selectPopularShop(shop: PopularShopPreset): void {
        const query = shop.query;

        // "Other" (empty query) means the customer wants to type the shop/address
        // manually. Expand the pickup field instead of prefilling any text so the
        // original address input chain stays untouched.
        if (!query) {
            this.pickupExpanded.set(true);
            return;
        }

        this.selectedLocalService.set({
            categorySlug: 'shop-deliver',
            categoryName: 'Shop & Deliver',
            providerName: shop.name,
            providerLogoUrl: shop.logo,
            providerAddress: query,
            countryCode: this.config.currentCountry()?.code || 'GB',
            source: 'configured-popular-shop'
        });
        this.bookingForm.patchValue({ pickup_address: query });
        this.onAddressInput('pickup', query);
        this.showPickupResults.set(true);
    }

    onLocalServiceCategoryChange(category: LocalServiceCategory): void {
        const current = this.selectedLocalService() || {};
        this.selectedLocalService.set({
            ...current,
            categoryId: category.id,
            categorySlug: category.categorySlug,
            categoryName: category.categoryName,
            countryCode: this.localServiceCountryCode(),
            source: current['source'] || 'catalogue'
        });
    }

    onLocalServiceProviderChange(selection: LocalServiceSelection): void {
        this.selectedLocalService.set(selection as Record<string, unknown>);
        const address = String(selection.providerAddress || selection.providerName || '').trim();
        if (address) {
            this.bookingForm.patchValue({ pickup_address: address });
            this.onAddressInput('pickup', address);
            if (Number.isFinite(Number(selection.providerLatitude)) && Number.isFinite(Number(selection.providerLongitude))) {
                this.pickupLocation = this.locationService.normalizeLocation(
                    'map',
                    { lat: Number(selection.providerLatitude), lng: Number(selection.providerLongitude) },
                    address
                );
                this.updateMarker('pickup');
                this.updateRoute();
            }
        }
    }

    onLocalServiceCustomProvider(selection: LocalServiceSelection): void {
        this.selectedLocalService.set(selection as Record<string, unknown>);
        this.pickupExpanded.set(true);
    }

    private parseErrandItems(raw: unknown): string[] {
        if (!raw) return [];

        return String(raw)
            .split(/[,\n]+/)
            .map(v => v.trim())
            .filter(Boolean);
    }

    private getErrandItemCount(raw: unknown): number {
        return this.parseErrandItems(raw).length;
    }

    private getErrandSubmissionError(formVal: Record<string, unknown>): string | null {
        if (this.type !== ServiceTypeEnum.ERRAND) return null;

        const mode = String(formVal['errand_mode'] || 'collect_deliver') as ErrandMode;

        if (this.isCollectDeliverMode(mode)) {
            return null;
        }

        const items = this.parseErrandItems(formVal['items_list']);
        const budget = this.toMoney(formVal['estimated_budget'] || 0);

        if (items.length === 0) {
            return 'Please enter the items to buy for this errand.';
        }

        if (budget <= 0) {
            return 'Please enter a valid item cost budget for this errand.';
        }

        return null;
    }

    private toMoney(value: unknown): number {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
    }

    displayBudgetValue(): string {
        const value = this.budgetValue();
        return value ? String(value) : '';
    }

    paymentPlanLabel(): string {
        if (this.walletCoversPayment()) {
            return 'Wallet covers this request';
        }

        return 'Card fallback ready';
    }

    paymentPlanDescription(): string {
        if (this.walletCoversPayment()) {
            if (this.type === ServiceTypeEnum.ERRAND && this.walletBudgetRequired() > 0) {
                return 'Your item budget and service estimate will be reserved from wallet before matching a driver.';
            }

            return 'Movabi will reserve the request amount from wallet before matching a driver.';
        }

        return 'Movabi checks wallet first. Because the balance is lower than this request, card payment is used instead.';
    }

    itemBudgetDescription(): string {
        if (this.walletCoversPayment()) {
            return 'This amount will be reserved from your Movabi Wallet to cover the estimated item purchase. Only the actual amount spent will be charged, and any unused balance will be returned automatically.';
        }

        if (this.cardFallbackRequired()) {
            return 'This amount will be authorised on your card to cover the estimated item purchase. Only the actual purchase amount will be charged, and any unused authorised amount will be released by your bank after shopping is completed.';
        }

        return 'The estimated item purchase amount will be reserved using your selected payment method (Wallet or Card). Only the actual amount spent will be charged, and any unused reserved funds will be released automatically.';
    }

    checkoutButtonLabel(): string {
        if (this.submitting()) {
            return 'Processing...';
        }

        if (this.shouldShowMarketplaceFare()) {
            return 'Continue to Marketplace Fare';
        }

        return this.walletCoversPayment()
            ? 'Request with Wallet'
            : 'Request & Pay by Card';
    }

    paymentSecurityLabel(): string {
        if (this.shouldShowMarketplaceFare()) {
            return 'Review and negotiate the fare before payment';
        }

        return this.walletCoversPayment()
            ? 'Secure wallet reservation via Movabi Pay'
            : 'Secure card fallback via Movabi Pay';
    }

    passengerCount(): number {
        return Number(this.bookingForm?.get('passenger_count')?.value || 1);
    }

    setPassengerCount(count: number) {
        const next = Math.max(1, Math.min(7, Math.round(Number(count) || 1)));
        this.bookingForm.get('passenger_count')?.setValue(next, { emitEvent: true });

        if (next > 4 && this.vehicleClass() === 'standard') {
            this.bookingForm.get('vehicle_class')?.setValue('xl', { emitEvent: true });
        }

        void this.recalculateFare();
    }

    rideVehicleLabel(): string {
        const vehicle = this.vehicleClass();
        if (vehicle === 'xl' || vehicle === 'minibus') return 'XL ride, up to 7 passengers';

        const count = this.passengerCount();
        return count > 4 ? 'XL ride, up to 7 passengers' : 'Standard ride, up to 4 passengers';
    }

    largeRideSurcharge(): number {
        const vehicle = this.vehicleClass();
        if (vehicle === 'minibus') return 6;
        if (vehicle === 'xl') return 4;
        return this.passengerCount() > 4 ? 4 : 0;
    }

    vehicleClass(): VehicleClass {
        return String(this.bookingForm?.get('vehicle_class')?.value || this.defaultVehicleClass()) as VehicleClass;
    }

    packageSize(): PackageSize {
        return String(this.bookingForm?.get('package_size')?.value || 'small') as PackageSize;
    }

    vehicleOptions(): Array<{ id: VehicleClass; label: string; helper: string; icon: string }> {
        switch (this.type) {
            case ServiceTypeEnum.RIDE:
                return [
                    { id: 'standard', label: 'Car', helper: '1-4 people', icon: 'car-outline' },
                    { id: 'xl', label: 'XL', helper: '5-7 people', icon: 'people-outline' },
                    { id: 'minibus', label: '7 Seater', helper: 'Group ride', icon: 'bus-outline' }
                ];
            case ServiceTypeEnum.DELIVERY:
                return [
                    { id: 'bike', label: 'Bike', helper: 'Fast & small', icon: 'navigate' },
                    { id: 'car', label: 'Car', helper: 'Medium items', icon: 'car-outline' },
                    { id: 'small_van', label: 'Small Van', helper: 'Bulky items', icon: 'bus-outline' }
                ];
            case ServiceTypeEnum.ERRAND:
                return [
                    { id: 'bike', label: 'Bike', helper: 'Small errands', icon: 'navigate' },
                    { id: 'car', label: 'Car', helper: 'More bags', icon: 'car-outline' },
                    { id: 'small_van', label: 'Small Van', helper: 'Large pickup', icon: 'bus-outline' }
                ];
            default:
                return [];
        }
    }

    selectedVehicleLabel(): string {
        return this.vehicleOptions().find(option => option.id === this.vehicleClass())?.helper || 'Best vehicle for the job';
    }

    selectedVehicleIcon(): string {
        return this.vehicleOptions().find(option => option.id === this.vehicleClass())?.icon || 'car-outline';
    }

    setVehicleClass(value: VehicleClass) {
        this.bookingForm.get('vehicle_class')?.setValue(value, { emitEvent: true });

        if (this.type === ServiceTypeEnum.RIDE) {
            const count = this.passengerCount();
            if ((value === 'xl' || value === 'minibus') && count < 5) {
                this.bookingForm.get('passenger_count')?.setValue(5, { emitEvent: true });
            }

            if (value === 'standard' && count > 4) {
                this.bookingForm.get('passenger_count')?.setValue(4, { emitEvent: true });
            }
        }

        if (this.type === ServiceTypeEnum.DELIVERY) {
            const packageByVehicle: Partial<Record<VehicleClass, PackageSize>> = {
                bike: 'small',
                car: 'medium',
                small_van: 'large'
            };

            const nextSize = packageByVehicle[value];
            if (nextSize && this.packageSize() !== nextSize) {
                this.bookingForm.get('package_size')?.setValue(nextSize, { emitEvent: true });
            }
        }

        void this.recalculateFare();
    }

    setPackageSize(size: PackageSize) {
        this.bookingForm.get('package_size')?.setValue(size, { emitEvent: true });

        if (this.type === ServiceTypeEnum.DELIVERY) {
            const vehicleBySize: Record<PackageSize, VehicleClass> = {
                small: 'bike',
                medium: 'car',
                large: 'small_van'
            };

            const nextVehicle = vehicleBySize[size];
            if (this.vehicleClass() !== nextVehicle) {
                this.bookingForm.get('vehicle_class')?.setValue(nextVehicle, { emitEvent: true });
            }
        }

        void this.recalculateFare();
    }

    private defaultVehicleClass(): VehicleClass {
        if (this.type === ServiceTypeEnum.RIDE) return 'standard';
        if (this.type === ServiceTypeEnum.DELIVERY || this.type === ServiceTypeEnum.ERRAND) return 'bike';
        return 'small_van';
    }

    private vehicleSurcharge(serviceSlug = this.getServiceSlug()): number {
        const vehicle = this.vehicleClass();

        if (serviceSlug === 'ride') return this.largeRideSurcharge();

        if (serviceSlug === 'delivery') {
            const packageSurcharge = this.packageSize() === 'large' ? 2 : this.packageSize() === 'medium' ? 0.75 : 0;
            const vehicleSurcharge = vehicle === 'large_van' ? 5 : vehicle === 'small_van' ? 3.5 : vehicle === 'car' ? 0.75 : 0;
            return this.toMoney(packageSurcharge + vehicleSurcharge);
        }

        if (serviceSlug === 'errand') {
            return vehicle === 'small_van' || vehicle === 'large_van' ? 5 : vehicle === 'car' ? 1.5 : 0;
        }

        return 0;
    }

    onBudgetInput(value: unknown) {
        if (!this.usesBudgetMode()) return;

        const numeric = this.parseBudgetInput(value);
        this.budgetValue.set(numeric);
        this.bookingForm.get('estimated_budget')?.setValue(numeric, { emitEvent: true });
    }

    formatBudgetOnBlur() {
        if (!this.usesBudgetMode()) return;

        const numeric = this.toMoney(this.budgetValue());
        this.budgetValue.set(numeric);
        this.bookingForm.get('estimated_budget')?.setValue(numeric, { emitEvent: true });
    }

    private parseBudgetInput(value: unknown): number {
        const raw = String(value ?? '').trim();

        // Preserve empty value while typing
        if (!raw) return 0;

        // Validate currency format: numbers and one decimal point only
        if (!/^\d+(\.\d{0,2})?$/.test(raw)) {
            this.bookingForm.get('estimated_budget')?.setErrors({ invalidCurrency: true });
            return 0;
        }

        // Don't use setErrors(null) - let other validators handle their own errors
        // Just clear the invalidCurrency error if format is valid
        const currentErrors = this.bookingForm.get('estimated_budget')?.errors;
        if (currentErrors && Object.keys(currentErrors).length === 1 && currentErrors['invalidCurrency']) {
            this.bookingForm.get('estimated_budget')?.setErrors(null);
        }

        return this.toMoney(Number(raw));
    }

    private requiredPhoneValidator(control: AbstractControl) {
        const raw = String(control.value || '').trim();
        if (!raw) return { required: true };

        if (!/^[+\d\s\-()]+$/.test(raw)) {
            return { invalidPhone: true };
        }

        const digits = raw.replace(/\D/g, '');

        if (digits.length < 10 || digits.length > 15) {
            return { invalidPhoneLength: true };
        }

        return null;
    }

    private optionalPhoneValidator(control: AbstractControl) {
        const raw = String(control.value || '').trim();
        if (!raw || raw === '0') return null;

        if (!/^[+\d\s\-()]+$/.test(raw)) {
            return { invalidPhone: true };
        }

        const digits = raw.replace(/\D/g, '');

        if (digits.length < 10 || digits.length > 15) {
            return { invalidPhoneLength: true };
        }

        return null;
    }

    private async initStripeElements() {
        if (this.cardMounted || this.stripeInitializing) return;
        if (!this.cardElementHost?.nativeElement) return;

        this.stripeInitializing = true;
        this.cardReady.set(false);
        this.cardComplete.set(false);
        this.cardError.set(null);

        try {
            this.stripe ??= await this.paymentService.getStripe();

            if (!this.stripe) {
                this.cardError.set('Payment service is unavailable right now.');
                return;
            }

            this.elements ??= this.stripe.elements();

            if (!this.card) {
                this.card = this.elements.create('card', {
                    hidePostalCode: true,
                    style: {
                        base: {
                            fontSize: '16px',
                            color: '#0f172a',
                            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
                            lineHeight: '24px',
                            '::placeholder': {
                                color: '#94a3b8'
                            }
                        },
                        invalid: {
                            color: '#ef4444',
                            iconColor: '#ef4444'
                        }
                    }
                });

                this.card.on('ready', () => {
                    this.cardReady.set(true);
                    this.cardError.set(null);
                });

                this.card.on('change', event => {
                    this.cardError.set(event.error?.message ?? null);
                    this.cardComplete.set(!!event.complete && !event.error);
                });
            }

            this.card.mount(this.cardElementHost.nativeElement);
            this.cardMounted = true;
        } catch (error) {
            console.error('Failed to initialize Stripe Elements', error);
            this.cardError.set('Unable to load card input right now.');
            this.cardReady.set(false);
            this.cardComplete.set(false);
            this.cardMounted = false;
        } finally {
            this.stripeInitializing = false;
        }
    }

    async useCurrentLocation(type: 'pickup' | 'dropoff', options: { silent?: boolean; auto?: boolean } = {}) {
        if (options.auto && type === 'pickup' && this.pickupManuallyChanged()) return;

        const loading = options.silent
            ? null
            : await this.loadingCtrl.create({
                message: 'Locating...',
                spinner: 'crescent'
            });

        await loading?.present();

        try {
            const pos = await this.locationService.getCurrentPosition();

            if (!pos) {
                await loading?.dismiss();

                if (!options.silent) {
                    const toast = await this.toastCtrl.create({
                        message: `Location is off, so Movabi will use ${this.locationService.getFallbackAddressLabel()} for search. You can still type or select any address.`,
                        duration: 3500,
                        color: 'warning'
                    });
                    await toast.present();
                }
                return;
            }

            const coords = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude
            };

            this.geocoding.reverseGeocode(coords.lat, coords.lng).subscribe({
                next: address => {
                    void loading?.dismiss();

                    const finalAddress = address || 'Current Location';

                    if (type === 'pickup') {
                        if (options.auto && this.pickupManuallyChanged()) return;
                        this.pickupLocation = this.locationService.normalizeLocation('gps', coords, finalAddress);
                        this.bookingForm.patchValue({ pickup_address: finalAddress }, { emitEvent: false });
                        this.updateMarker('pickup');
                    } else {
                        this.dropoffLocation = this.locationService.normalizeLocation('gps', coords, finalAddress);
                        this.bookingForm.patchValue({ dropoff_address: finalAddress }, { emitEvent: false });
                        this.updateMarker('dropoff');
                    }

                    this.updateRoute();
                },
                error: (error) => {
                    void loading?.dismiss();
                    console.warn('[BookingRequest] Reverse geocoding failed:', error);

                    const finalAddress = 'Current Location';

                    if (type === 'pickup') {
                        if (options.auto && this.pickupManuallyChanged()) return;
                        this.pickupLocation = this.locationService.normalizeLocation('gps', coords, finalAddress);
                        this.bookingForm.patchValue({ pickup_address: finalAddress }, { emitEvent: false });
                        this.updateMarker('pickup');
                    } else {
                        this.dropoffLocation = this.locationService.normalizeLocation('gps', coords, finalAddress);
                        this.bookingForm.patchValue({ dropoff_address: finalAddress }, { emitEvent: false });
                        this.updateMarker('dropoff');
                    }

                    this.updateRoute();
                }
            });
        } catch (error) {
            console.error('[BookingRequest] useCurrentLocation failed:', error);
            await loading?.dismiss();
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
                    vehicle_class: ['standard', Validators.required],
                    passenger_count: [1, [Validators.required, Validators.min(1), Validators.max(7)]],
                    booking_for_someone_else: [false],
                    rider_name: ['']
                });
                break;

            case ServiceTypeEnum.ERRAND:
                this.bookingForm = this.fb.group({
                    ...baseFields,
                    dropoff_address: ['', Validators.required],
                    items_list: [''],
                    estimated_budget: [0],
                    errand_mode: ['collect_deliver', Validators.required],
                    vehicle_class: ['bike', Validators.required],
                    recipient_phone: ['', this.optionalPhoneValidator.bind(this)],
                    recipient_name: [''],
                    substitution_rule: ['contact_me']
                });
                break;

            case ServiceTypeEnum.DELIVERY:
                this.bookingForm = this.fb.group({
                    ...baseFields,
                    dropoff_address: ['', Validators.required],
                    vehicle_class: ['bike', Validators.required],
                    package_size: ['small', Validators.required],
                    recipient_name: ['', Validators.required],
                    recipient_phone: ['', [Validators.required, this.requiredPhoneValidator.bind(this)]],
                    item_description: ['', Validators.required]
                });
                break;

            case ServiceTypeEnum.VAN:
                this.bookingForm = this.fb.group({
                    ...baseFields,
                    dropoff_address: ['', Validators.required],
                    vehicle_class: ['small_van', Validators.required],
                    size: ['small', Validators.required],
                    helper_count: [1, [Validators.required, Validators.min(0)]],
                    floor_number: [0],
                    has_elevator: [false],
                    stairs_involved: [false],
                    fragile_items: [false],
                    packing_assistance: [false]
                });
                break;

            default:
                this.bookingForm = this.fb.group({
                    ...baseFields,
                    dropoff_address: ['', Validators.required]
                });
                break;
        }

        if (this.type === ServiceTypeEnum.ERRAND) {
            const initialMode = String(
                this.bookingForm.get('errand_mode')?.value || 'collect_deliver'
            ) as ErrandMode;

            this.applyErrandModeRules(initialMode);

            this.bookingForm.get('errand_mode')?.valueChanges
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe(mode => {
                    this.applyErrandModeRules(
                        String(mode || 'collect_deliver') as ErrandMode
                    );

                    this.syncFormSignals(this.bookingForm.getRawValue());
                    this.formValidSignal.set(this.bookingForm.valid);
                    void this.recalculateFare();
                });
        }

        this.syncFormSignals(this.bookingForm.getRawValue());
        this.formValidSignal.set(this.bookingForm.valid);

        this.bookingForm.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
                this.syncFormSignals(this.bookingForm.getRawValue());
                this.formValidSignal.set(this.bookingForm.valid);
                void this.recalculateFare();
            });

        this.bookingForm.statusChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
                this.formValidSignal.set(this.bookingForm.valid);
            });
    }

    private syncFormSignals(values: Record<string, unknown>) {
        const mode = String(values['errand_mode'] || 'collect_deliver') as ErrandMode;
        this.errandMode.set(mode);

        const quickBuyMode = this.isQuickBuyMode(mode);

        const budget = quickBuyMode
            ? this.toMoney(values['estimated_budget'] || 0)
            : 0;

        this.budgetValue.set(budget);

        const items = quickBuyMode ? values['items_list'] : '';
        this.itemCount.set(this.getErrandItemCount(items));
    }

    togglePickupExpanded(): void {
        this.pickupExpanded.update(value => !value);
        if (!this.pickupExpanded()) {
            this.showPickupResults.set(false);
        }
    }

    private applyErrandModeRules(mode: ErrandMode) {
        const itemsControl = this.bookingForm.get('items_list');
        const budgetControl = this.bookingForm.get('estimated_budget');

        if (!itemsControl || !budgetControl) return;

        const quickBuyMode = this.isQuickBuyMode(mode);

        if (quickBuyMode) {
            itemsControl.enable({ emitEvent: false });
            itemsControl.setValidators([Validators.required]);

            budgetControl.enable({ emitEvent: false });
            budgetControl.setValidators([Validators.required, Validators.min(1)]);
        } else {
            itemsControl.reset('', { emitEvent: false });
            itemsControl.clearValidators();
            itemsControl.disable({ emitEvent: false });

            budgetControl.reset(0, { emitEvent: false });
            budgetControl.clearValidators();
            budgetControl.disable({ emitEvent: false });

            this.itemCount.set(0);
            this.budgetValue.set(0);
        }

        itemsControl.updateValueAndValidity({ emitEvent: false });
        budgetControl.updateValueAndValidity({ emitEvent: false });
    }

    clearAddress(type: 'pickup' | 'dropoff'): void {
        this.bookingForm.patchValue({ [type === 'pickup' ? 'pickup_address' : 'dropoff_address']: '' });
        this.onAddressInput(type, '');
    }

    onAddressInput(type: 'pickup' | 'dropoff', query: string) {
        if (type === 'pickup') {
            this.pickupManuallyChanged.set(true);
            this.pickupLocation.address = query;
            this.pickupLocation.latitude = undefined;
            this.pickupLocation.longitude = undefined;
            this.mapComponent?.removeMarker('pickup');
            this.pickupSearch$.next(query);
        } else {
            this.dropoffLocation.address = query;
            this.dropoffLocation.latitude = undefined;
            this.dropoffLocation.longitude = undefined;
            this.mapComponent?.removeMarker('dropoff');
            this.dropoffSearch$.next(query);
        }

        this.clearRouteAndFare();
    }

    private performSearch(type: 'pickup' | 'dropoff', query: string) {
        if (!query || query.length < 3) {
            if (type === 'pickup') {
                this.pickupResults.set([]);
                this.showPickupResults.set(this.recentLocationResults('pickup').length > 0);
            } else {
                this.dropoffResults.set([]);
                this.showDropoffResults.set(this.recentLocationResults('dropoff').length > 0);
            }
            return;
        }

        this.geocoding.autocomplete(this.withLocationContext(type, query)).subscribe(results => {
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
            if (type === 'pickup') {
                this.showPickupResults.set(false);
            } else {
                this.showDropoffResults.set(false);
            }

            void this.resolveTypedAddress(type);
        }, 250);
    }

    selectResult(type: 'pickup' | 'dropoff', result: AutocompleteResult) {
        if (type === 'pickup') {
            this.pickupManuallyChanged.set(true);
            this.pickupLocation = this.locationService.normalizeLocation(
                'map',
                { lat: result.lat, lng: result.lng },
                result.label
            );
            this.bookingForm.patchValue({ pickup_address: result.label }, { emitEvent: false });
            this.showPickupResults.set(false);
            this.updateMarker('pickup');
        } else {
            this.dropoffLocation = this.locationService.normalizeLocation(
                'map',
                { lat: result.lat, lng: result.lng },
                result.label
            );
            this.bookingForm.patchValue({ dropoff_address: result.label }, { emitEvent: false });
            this.showDropoffResults.set(false);
            this.updateMarker('dropoff');
        }

        this.fitMapToSelectedLocations();
        this.updateRoute();
    }

    private async resolveTypedAddress(type: 'pickup' | 'dropoff'): Promise<void> {
        const loc = type === 'pickup' ? this.pickupLocation : this.dropoffLocation;

        if (loc.latitude && loc.longitude) return;

        const controlName = type === 'pickup' ? 'pickup_address' : 'dropoff_address';
        const query = String(this.bookingForm.get(controlName)?.value || loc.address || '').trim();

        if (query.length < 3) return;

        try {
            const results = await firstValueFrom(this.geocoding.geocodeAddress(this.withLocationContext(type, query)));
            const result = results?.[0];

            if (!result || !Number.isFinite(Number(result.lat)) || !Number.isFinite(Number(result.lng))) {
                return;
            }

            const normalized = this.locationService.normalizeLocation(
                'map',
                { lat: Number(result.lat), lng: Number(result.lng) },
                result.label || query
            );

            if (type === 'pickup') {
                this.pickupLocation = normalized;
                this.pickupResults.set([]);
                this.showPickupResults.set(false);
                this.bookingForm.patchValue({ pickup_address: normalized.address }, { emitEvent: false });
            } else {
                this.dropoffLocation = normalized;
                this.dropoffResults.set([]);
                this.showDropoffResults.set(false);
                this.bookingForm.patchValue({ dropoff_address: normalized.address }, { emitEvent: false });
            }

            this.updateMarker(type);
            this.fitMapToSelectedLocations();
            this.updateRoute();
        } catch (error) {
            console.warn(`[BookingRequest] Failed to resolve ${type} address`, error);
        }
    }

    private withLocationContext(type: 'pickup' | 'dropoff', query: string): string {
        const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim();

        if (!cleanQuery || cleanQuery.includes(',') || this.geocoding.isLikelyUkPostcode(cleanQuery)) return cleanQuery;

        const contextAddress = type === 'dropoff'
            ? this.pickupLocation.address
            : this.dropoffLocation.address;
        const locality = this.extractLocality(contextAddress);

        if (!locality || cleanQuery.toLowerCase().includes(locality.toLowerCase())) {
            return cleanQuery;
        }

        return `${cleanQuery}, ${locality}`;
    }

    private extractLocality(address?: string): string {
        const parts = String(address || '')
            .split(',')
            .map(part => part.trim())
            .filter(Boolean);

        if (parts.length < 2) return '';

        return parts[1];
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
                this.mapComponent.setCenter(loc.longitude, loc.latitude, 15);
            } else {
                setTimeout(() => this.updateRoute(), 80);
            }
        }
    }

    private fitMapToSelectedLocations() {
        const pickupReady = this.pickupLocation.latitude && this.pickupLocation.longitude;
        const dropoffReady = this.dropoffLocation.latitude && this.dropoffLocation.longitude;

        if (pickupReady && dropoffReady) {
            const bounds = this.getSelectedLocationBounds();
            if (bounds) {
                this.mapComponent?.fitBounds(bounds, {
                    padding: { top: 48, bottom: 88, left: 36, right: 36 },
                    maxZoom: 15
                });
            }
            return;
        }

        const single = pickupReady ? this.pickupLocation : dropoffReady ? this.dropoffLocation : null;

        if (single?.latitude && single.longitude) {
            this.mapComponent?.setCenter(single.longitude, single.latitude, 15);
        }
    }

    private updateRoute() {
        if (
            this.pickupLocation.latitude &&
            this.pickupLocation.longitude &&
            this.dropoffLocation.latitude &&
            this.dropoffLocation.longitude
        ) {
            const pickup = {
                lat: this.pickupLocation.latitude,
                lng: this.pickupLocation.longitude
            };
            const dropoff = {
                lat: this.dropoffLocation.latitude,
                lng: this.dropoffLocation.longitude
            };

            if (
                isNaN(pickup.lat) ||
                isNaN(pickup.lng) ||
                isNaN(dropoff.lat) ||
                isNaN(dropoff.lng)
            ) {
                console.warn('[BookingRequest] Invalid coordinates for route update', { pickup, dropoff });
                return;
            }

            this.routing.getRoute(pickup, dropoff).subscribe(result => {
                if (result) {
                    this.routeResult.set(result);
                    this.mapComponent.drawRoute(result);

                    setTimeout(() => {
                        const bounds = this.getSelectedLocationBounds();
                        if (bounds) {
                            this.mapComponent.fitBounds(bounds, {
                                padding: { top: 48, bottom: 88, left: 36, right: 36 },
                                maxZoom: 15
                            });
                        }
                    }, 120);

                    void this.recalculateFare();
                } else {
                    this.routeResult.set(null);
                    this.mapComponent.clearRoute();
                    void this.recalculateFare();
                }
            });
        } else {
            this.clearRouteAndFare();
            this.mapComponent.clearRoute();
        }
    }

    private clearRouteAndFare() {
        this.routeResult.set(null);
        this.fareEstimate.set(null);
        this.estimatedPrice.set(0);
        this.mapComponent?.clearRoute();
    }

    private getSelectedLocationBounds(): [[number, number], [number, number]] | null {
        const points = [
            {
                lat: Number(this.pickupLocation.latitude),
                lng: Number(this.pickupLocation.longitude)
            },
            {
                lat: Number(this.dropoffLocation.latitude),
                lng: Number(this.dropoffLocation.longitude)
            }
        ];

        if (points.some(point =>
            !Number.isFinite(point.lat) ||
            !Number.isFinite(point.lng) ||
            Math.abs(point.lat) > 90 ||
            Math.abs(point.lng) > 180
        )) {
            return null;
        }

        const lats = points.map(point => point.lat);
        const lngs = points.map(point => point.lng);

        return [
            [Math.min(...lngs), Math.min(...lats)],
            [Math.max(...lngs), Math.max(...lats)]
        ];
    }

    private recentLocationResults(type: 'pickup' | 'dropoff'): AutocompleteResult[] {
        const key = type === 'pickup' ? 'pickup_address' : 'dropoff_address';
        const latKey = type === 'pickup' ? 'pickup_latitude' : 'dropoff_latitude';
        const lngKey = type === 'pickup' ? 'pickup_longitude' : 'dropoff_longitude';
        const seen = new Set<string>();

        return this.bookingService.bookingHistory()
            .map((booking: Booking) => {
                const record = booking as unknown as Record<string, unknown>;
                const label = String(record[key] || '').trim();
                const lat = Number(record[latKey]);
                const lng = Number(record[lngKey]);

                if (!label || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

                const uniqueKey = label.toLowerCase();
                if (seen.has(uniqueKey)) return null;
                seen.add(uniqueKey);

                return { label, lat, lng };
            })
            .filter((result): result is AutocompleteResult => !!result)
            .slice(0, 5);
    }

    async loadPricing() {
        const types = await this.bookingService.getServiceTypes();
        const slug = this.getServiceSlug();

        try {
            const marketplaceSettings = await this.marketplaceConfig.loadSettings();
            this.negotiationSettings.set(marketplaceSettings.negotiation);
            this.effectiveHybridStatus.set(await this.marketplaceConfig.getEffectiveHybridStatus(slug));
        } catch (e) {
            console.warn('[BookingRequest] Could not load marketplace settings', e);
            this.effectiveHybridStatus.set(null);
        }

        const selected = types.find((t: ServiceType) => {
            const serviceSlug = String((t as any).slug || (t as any).name || '').toLowerCase();
            const canonicalCandidate = this.canonicalServiceSlug(serviceSlug);
            const canonicalRequested = this.canonicalServiceSlug(slug);

            if (serviceSlug === slug) return true;
            if (canonicalCandidate === canonicalRequested) return true;
            if (slug === 'van-moving' && (serviceSlug === 'van' || serviceSlug === 'van moving')) return true;
            if (slug === 'delivery' && ['courier', 'package', 'parcel', 'delivery'].includes(serviceSlug)) return true;
            if (slug === 'errand' && ['shop', 'shopping', 'errand', 'errands'].includes(serviceSlug)) return true;

            return false;
        });

        console.log('AVAILABLE SERVICE TYPES', types);
        console.log('REQUESTED SLUG', slug);
        console.log('SELECTED SERVICE TYPE', selected);
        console.log('[BookingRequest] resolved service type', {
            requestedType: this.type,
            requestedSlug: slug,
            selectedServiceTypeSlug: selected?.slug || selected?.name || null,
            resolvedServiceType: selected || null
        });

        if (selected) {
            this.serviceType.set(selected);
        } else {
            console.warn('No matching service type found for slug:', slug);
        }
    }

    /**
     * Fetches the customer's fare estimate from the authoritative backend
     * pricing pipeline (GlobalAiPricingService -> PricingService ->
     * MarketPricingService). This page never re-derives fare-affecting
     * numbers itself - it only sends booking inputs and displays exactly
     * what the backend returns.
     */
    private async recalculateFare() {
        const route = this.routeResult();
        const serviceSlug = this.getServiceSlug();
        const formVal = this.bookingForm?.getRawValue?.() || this.bookingForm?.value || {};

        if (!this.hasConfirmedRoute(route) || !this.pickupLocation.latitude || !this.pickupLocation.longitude) {
            this.fareEstimate.set(null);
            this.estimatedPrice.set(0);
            this.lastFareBreakdown = null;
            this.fareCalculating.set(false);
            this.fareCalculationError.set(null);
            return;
        }

        const distanceKm = this.toMoney((route?.distanceMeters || 0) / 1000);
        const durationMinutes = this.toMoney((route?.durationSeconds || 0) / 60);

        const requestId = ++this.fareRequestSequence;
        this.fareCalculating.set(true);
        this.fareCalculationError.set(null);

        const countryCode = this.config.currentCountry()?.code || 'GB';
        const currencyCode = this.config.currentCountry()?.currency || this.config.currencyCode || 'GBP';

        try {
            const response = await this.globalAiPricingQuote.getQuote({
                lat: this.pickupLocation.latitude,
                lng: this.pickupLocation.longitude,
                dropoffLat: this.dropoffLocation.latitude ?? null,
                dropoffLng: this.dropoffLocation.longitude ?? null,
                serviceSlug,
                distanceKm,
                durationMinutes,
                countryCode,
                currencyCode,
                vehicleClass: serviceSlug === 'ride' || serviceSlug === 'delivery' || serviceSlug === 'errand'
                    ? this.vehicleClass()
                    : null,
                passengerCount: serviceSlug === 'ride' ? this.passengerCount() : undefined,
                packageSize: serviceSlug === 'delivery' ? this.packageSize() : null,
                itemCount: serviceSlug === 'errand' && this.usesItemListMode() ? this.itemCount() : undefined,
                errandMode: serviceSlug === 'errand' ? (this.usesBudgetMode() ? 'budget' : 'items') : null,
                budget: serviceSlug === 'errand' && this.usesBudgetMode() ? this.budgetValue() : undefined,
                moveDetails: serviceSlug === 'van-moving'
                    ? {
                        size: formVal.size,
                        helperCount: Number(formVal.helper_count) || 0,
                        stairsInvolved: !!formVal.stairs_involved,
                        packingAssistance: !!formVal.packing_assistance,
                        fragileItems: !!formVal.fragile_items
                    }
                    : null
            });

            // Ignore stale responses if the user changed inputs while this request was in flight.
            if (requestId !== this.fareRequestSequence) return;

            const breakdown = response.legacy.fareBreakdown;
            this.lastFareBreakdown = breakdown;
            this.lastQuoteReference = response.quoteReference;
            this.lastQuoteExpiresAt = response.priceLockedUntil;

            const estimate: FareEstimate = {
                serviceType: serviceSlug,
                currencyCode: breakdown.currencyCode || response.legacy.currencyCode || currencyCode,
                distanceKm,
                durationMinutes,
                baseFare: this.toMoney(breakdown.baseFare || 0),
                distanceFare: this.toMoney(breakdown.distanceCost || 0),
                timeFare: this.toMoney(breakdown.durationCost || 0),
                serviceFee: this.toMoney(breakdown.serviceFee || 0),
                subtotal: this.toMoney((breakdown.baseFare || 0) + (breakdown.distanceCost || 0) + (breakdown.durationCost || 0)),
                minimumFareApplied: (breakdown.minimumFareAdjustment || 0) > 0,
                surgeMultiplier: breakdown.multiplier || 1,
                surgeAmount: this.toMoney(breakdown.dynamicPricingAmount || 0),
                total: this.toMoney(breakdown.total ?? response.legacy.totalPrice ?? 0)
            };

            this.fareEstimate.set(estimate);
            this.estimatedPrice.set(estimate.total);

            console.log('[BookingRequest] backend fare quote', {
                serviceSlug,
                distanceKm,
                durationMinutes,
                vehicleClass: this.vehicleClass(),
                passengerCount: serviceSlug === 'ride' ? this.passengerCount() : undefined,
                packageSize: serviceSlug === 'delivery' ? this.packageSize() : undefined,
                source: breakdown.source,
                total: estimate.total,
                fallbackUsed: response.fallback?.used ?? false
            });
        } catch (error: any) {
            if (requestId !== this.fareRequestSequence) return;

            console.error('[BookingRequest] Failed to fetch backend fare quote', error);
            this.fareEstimate.set(null);
            this.estimatedPrice.set(0);
            this.lastFareBreakdown = null;
            this.lastQuoteReference = null;
            this.lastQuoteExpiresAt = null;
            this.fareCalculationError.set('Unable to calculate the fare right now. Please try again.');
        } finally {
            if (requestId === this.fareRequestSequence) {
                this.fareCalculating.set(false);
            }
        }
    }

    /**
     * Builds the fare breakdown attached to the booking creation payload
     * directly from the last backend quote (server truth). This page never
     * re-derives fare-affecting amounts - it only forwards what
     * GlobalAiPricingService/PricingService already calculated and audited.
     */
    private buildQuoteFareBreakdown(
        quoteId: string,
        currencyCode: string,
        currencySymbol: string,
        customerServiceTotal: number,
        totalAuthorisation: number
    ): Record<string, unknown> | null {
        const backend = this.lastFareBreakdown;
        if (!backend) return null;

        return {
            ...backend,
            quoteId,
            quoteExpiresAt: this.lastQuoteExpiresAt,
            currencyCode: backend.currencyCode || currencyCode,
            currencySymbol: backend.currencySymbol || currencySymbol,
            customerServiceTotal: this.toMoney(customerServiceTotal),
            totalAuthorisation: this.toMoney(totalAuthorisation),
            shoppingBudget: this.walletBudgetRequired()
        };
    }

    getValidationError(type: 'pickup' | 'dropoff'): string | null {
        const location = type === 'pickup' ? this.pickupLocation : this.dropoffLocation;
        return this.locationService.getLocationValidationMessage(location, type);
    }

    getTitle(): string {
        switch (this.type) {
            case ServiceTypeEnum.RIDE:
                return 'Ride Request';
            case ServiceTypeEnum.ERRAND:
                return 'Shop';
            case ServiceTypeEnum.DELIVERY:
                return 'Deliver';
            case ServiceTypeEnum.VAN:
                return 'Move';
            default:
                return 'Booking Request';
        }
    }

    getIcon(): string {
        switch (this.type) {
            case ServiceTypeEnum.RIDE:
                return 'car-outline';
            case ServiceTypeEnum.ERRAND:
                return 'cart-outline';
            case ServiceTypeEnum.DELIVERY:
                return 'cube-outline';
            case ServiceTypeEnum.VAN:
                return 'bus-outline';
            default:
                return 'help-circle-outline';
        }
    }

    getServiceLabel(): string {
        switch (this.type) {
            case ServiceTypeEnum.RIDE:
                return 'Ride';
            case ServiceTypeEnum.ERRAND:
                return 'Shop';
            case ServiceTypeEnum.DELIVERY:
                return 'Deliver';
            case ServiceTypeEnum.VAN:
                return 'Move';
            default:
                return 'Booking';
        }
    }

    getServiceDescription(): string {
        switch (this.type) {
            case ServiceTypeEnum.RIDE:
                return 'Everyday local travel';
            case ServiceTypeEnum.ERRAND:
                return 'Shopping, errands and collections';
            case ServiceTypeEnum.DELIVERY:
                return 'Trusted local delivery';
            case ServiceTypeEnum.VAN:
                return 'Van and moving services';
            default:
                return 'Trusted local movement for your needs.';
        }
    }

    private async validateBeforeSubmit(): Promise<string | null> {
        await Promise.all([
            this.resolveTypedAddress('pickup'),
            this.resolveTypedAddress('dropoff')
        ]);

        if (
            !this.locationService.isLocationValidForBooking(this.pickupLocation) ||
            !this.locationService.isLocationValidForBooking(this.dropoffLocation)
        ) {
            return 'Please provide valid pickup and dropoff locations.';
        }

        this.bookingForm.markAllAsTouched();
        this.bookingForm.updateValueAndValidity({ emitEvent: false });
        this.formValidSignal.set(this.bookingForm.valid);

        if (!this.formValidSignal()) {
            return 'Please complete all required fields.';
        }

        const formVal = this.bookingForm.getRawValue();
        const errandSubmissionError = this.getErrandSubmissionError(formVal);
        if (errandSubmissionError) {
            return errandSubmissionError;
        }

        if (this.shouldShowMarketplaceFare()) {
            return null;
        }

        const wallet = await this.walletService.fetchWallet();
        const required = this.walletPaymentRequired();
        const walletBalance = this.toMoney(wallet?.available_balance || 0);
        const needsCardFallback = required > 0 && walletBalance < required;

        if (needsCardFallback) {
            if (!this.card || !this.cardMounted || !this.cardReady()) {
                return 'Card input is still loading. Please wait a moment.';
            }

            if (!this.cardComplete()) {
                return 'Please enter your card details before continuing.';
            }
        }

        return null;
    }

    private hasConfirmedRoute(route: RouteSummary | null): route is RouteSummary {
        return !!route &&
            Number(route.distanceMeters) > 0 &&
            Number(route.durationSeconds) > 0 &&
            Number.isFinite(Number(this.pickupLocation.latitude)) &&
            Number.isFinite(Number(this.pickupLocation.longitude)) &&
            Number.isFinite(Number(this.dropoffLocation.latitude)) &&
            Number.isFinite(Number(this.dropoffLocation.longitude));
    }

    async submit() {
        if (this.submitting() || this.paymentProcessing()) return;

        if (this.fareCalculating() || !this.fareEstimate() || !this.lastFareBreakdown) {
            const toast = await this.toastCtrl.create({
                message: this.fareCalculationError() || 'Please wait for the fare to finish calculating.',
                duration: 3000,
                color: 'warning'
            });
            await toast.present();
            return;
        }

        const now = Date.now();
        if (now - this.lastBookingTime < 30000) {
            const toast = await this.toastCtrl.create({
                message: 'Please wait 30 seconds before making another booking.',
                duration: 3000,
                color: 'warning'
            });
            await toast.present();
            return;
        }

        const validationError = await this.validateBeforeSubmit();
        if (validationError) {
            const toast = await this.toastCtrl.create({
                message: validationError,
                duration: 3000,
                color: 'warning'
            });
            await toast.present();
            return;
        }

        const customerComplianceError = await this.validateCustomerCanBook();
        if (customerComplianceError) {
            const toast = await this.toastCtrl.create({
                message: customerComplianceError,
                duration: 4500,
                color: 'warning'
            });
            await toast.present();
            return;
        }

        this.submitting.set(true);
        this.paymentProcessing.set(true);

        const loading = await this.loadingCtrl.create({
            message: 'Preparing your booking...'
        });
        await loading.present();

        let booking: { id: string } | null = null;
        let paymentIntentId: string | null = null;
        let walletReserved = false;

        try {
            const formVal = this.bookingForm.getRawValue();
            const itemBudget = this.walletBudgetRequired();
            const serviceCharge = this.cardChargeRequired();
            const totalDue = this.walletPaymentRequired();
            const walletWillCover = this.walletCoversPayment();
            if (!this.lastQuoteReference || !this.lastQuoteExpiresAt || Date.parse(this.lastQuoteExpiresAt) <= Date.now()) {
                throw new Error('Your fare quote expired. Please refresh the quote before booking.');
            }
            const quoteId = this.lastQuoteReference;

            const countryCode = this.config.currentCountry()?.code || 'GB';
            const currencyCode = this.config.currentCountry()?.currency || this.config.currencyCode || 'GBP';
            const currencySymbol = this.config.currentCountry()?.currencySymbol || this.getCurrencySymbol(currencyCode);

            const bookingData = {
                pickup_address: formVal.pickup_address,
                pickup_lat: this.pickupLocation.latitude || 0,
                pickup_lng: this.pickupLocation.longitude || 0,
                dropoff_address: formVal.dropoff_address || 'Delivery Address',
                dropoff_lat: this.dropoffLocation.latitude || 0,
                dropoff_lng: this.dropoffLocation.longitude || 0,

                service_type_id: this.serviceType()?.id,
                total_price: serviceCharge,
                quote_id: quoteId,
                fare_breakdown: this.buildQuoteFareBreakdown(quoteId, currencyCode, currencySymbol, serviceCharge, totalDue),

                distance_km: this.toMoney((this.routeResult()?.distanceMeters || 0) / 1000),
                estimated_distance_km: this.toMoney((this.routeResult()?.distanceMeters || 0) / 1000),
                distance_meters: this.routeResult()?.distanceMeters || 0,
                duration_seconds: this.routeResult()?.durationSeconds || 0,

                country_code: countryCode,
                currency_code: currencyCode,
                currency_symbol: currencySymbol,
                pricing_plan: 'starter',

                metadata: {
                    ...(this.getMetadataPayload(formVal) || {}),
                    country_code: countryCode,
                    currency_code: currencyCode,
                    currency_symbol: currencySymbol,
                    quote_id: quoteId,
                    quote_expires_at: this.lastQuoteExpiresAt,
                    customer_service_total: serviceCharge,
                    total_authorisation: totalDue,
                    pricing_plan: 'starter',
                    service_vehicle_class: this.vehicleClass(),
                    service_option_surcharge: this.vehicleSurcharge(),
                    ...(this.selectedLocalService() ? { local_service_selection: this.selectedLocalService() } : {}),
                    ...(this.type === ServiceTypeEnum.DELIVERY ? { package_size: this.packageSize() } : {})
                }
            };

            const details = this.getDetailsPayload(formVal);

            loading.message = 'Creating booking...';
            booking = await this.bookingService.createBooking(bookingData, details, this.type);
            this.lastBookingTime = Date.now();

            // If marketplace negotiation is enabled for this service, let the customer
            // review/negotiate the fare before taking payment.
            const shouldShowMarketplaceFare = Boolean((booking as any).negotiation_mode_enabled);
            console.log('[BookingRequest] eligibility decision before routing', {
                serviceSlug: this.getServiceSlug(),
                canonicalServiceSlug: this.canonicalServiceSlug(this.getServiceSlug()),
                negotiationEnabled: (booking as any).negotiation_mode_enabled,
                negotiationServices: this.negotiationSettings()?.minServices,
                shouldShowMarketplaceFare
            });

            if (booking?.id && shouldShowMarketplaceFare) {
                await loading.dismiss();
                await this.router.navigate(['/customer/marketplace-fare', booking.id], {
                    queryParams: { quoteId }
                });
                return;
            }

            if (walletWillCover) {
                if (this.type === ServiceTypeEnum.ERRAND && itemBudget > 0) {
                    loading.message = 'Reserving wallet funds...';
                    await this.walletService.reserveErrandFunds(
                        booking.id,
                        itemBudget,
                        serviceCharge
                    );
                    walletReserved = true;
                } else {
                    loading.message = 'Reserving wallet payment...';
                    await this.walletService.payJobFromWallet(
                        booking.id,
                        serviceCharge,
                        currencyCode
                    );
                    walletReserved = true;
                }
            } else {
                loading.message = 'Initializing card payment...';
                const { clientSecret } = await this.paymentService.createPaymentIntent(
                    booking.id,
                    totalDue,
                    currencyCode,
                    this.auth.tenantId() || '',
                    this.pricingService.surgeMultiplier()
                );

                loading.message = 'Charging card...';
                const paymentIntent = await this.paymentService.confirmPayment(clientSecret, this.card!);
                paymentIntentId = paymentIntent.id;
            }

            loading.message = this.type === ServiceTypeEnum.ERRAND
                ? 'Activating errand...'
                : this.type === ServiceTypeEnum.DELIVERY
                    ? 'Activating delivery...'
                    : 'Activating job...';

            const confirmationPaymentId = walletWillCover ? 'wallet_funded' : paymentIntentId;

            if (!confirmationPaymentId) {
                throw new Error('Payment confirmation did not complete.');
            }

            await this.bookingService.confirmJobPayment(booking.id, confirmationPaymentId);
            if (walletWillCover) {
                paymentIntentId = 'wallet_funded';
            }
            this.recordLocalServicePreference();

            this.analytics.track('booking_created', {
                job_id: booking.id,
                type: this.type,
                pickup_source: this.pickupLocation.source,
                distance_km: ((bookingData.distance_meters || 0) / 1000).toFixed(2),
                item_budget: itemBudget,
                wallet_charge: walletWillCover ? totalDue : 0,
                card_charge: walletWillCover ? 0 : totalDue,
                payment_method: walletWillCover ? 'wallet' : 'card'
            });

            await loading.dismiss();
            await this.router.navigate(['/customer/tracking', booking.id]);
        } catch (e: unknown) {
            console.error('[BookingRequest] submit failed', e);

            const message = e instanceof Error ? e.message : 'An error occurred';

            if (booking?.id && (!paymentIntentId || walletReserved)) {
                try {
                    if (walletReserved) {
                        await this.bookingService.cancelBooking(
                            booking.id,
                            `Auto-cancelled after wallet checkout failure: ${message}`
                        );
                    } else {
                        await this.bookingService.updateBookingStatus(
                            booking.id,
                            'cancelled',
                            `Auto-cancelled after checkout failure: ${message}`
                        );
                    }
                } catch (cancelError) {
                    console.error('[BookingRequest] booking auto-cancel failed', cancelError);
                }
            }

            await loading.dismiss();

            const toast = await this.toastCtrl.create({
                message,
                duration: 4000,
                color: 'danger'
            });
            await toast.present();
        } finally {
            this.submitting.set(false);
            this.paymentProcessing.set(false);
        }
    }

    private recordLocalServicePreference(): void {
        const selection = this.selectedLocalService() as LocalServiceSelection | null;
        if (!selection?.providerName || !selection.categorySlug) return;
        this.localServices.saveRecent({
            ...selection,
            countryCode: selection.countryCode || this.localServiceCountryCode(),
            serviceSlug: this.localServiceCatalogueSlug()
        } as LocalServiceSelection & { serviceSlug?: string }).catch((error) => {
            console.warn('[BookingRequest] local service preference save skipped', error);
        });
    }
    private async validateCustomerCanBook(): Promise<string | null> {
        const profile = await this.fetchCurrentCustomerProfile();

        if (!profile) {
            return 'Complete your profile before booking.';
        }

        const result = this.compliance.canCustomerBook(profile);

        if (result.allowed) {
            return null;
        }

        const missing = result.missing.filter((item: any) => {
            const key = String(item?.key || item?.label || item?.message || item || '').toLowerCase();

            if (key.includes('email') && String((profile as any).email || '').trim()) {
                return false;
            }

            if (key.includes('phone') && String((profile as any).phone || (profile as any).phone_number || '').trim()) {
                return false;
            }

            if (key.includes('terms') && (profile as any).terms_accepted === true) {
                return false;
            }

            if (key.includes('privacy') && (profile as any).privacy_accepted === true) {
                return false;
            }

            return true;
        });

        if (missing.length === 0) {
            return null;
        }

        return this.compliance.formatMissingRequirements(
            missing,
            'Complete your profile before booking.'
        );
    }

    private async fetchCurrentCustomerProfile(): Promise<Partial<Profile> | null> {
        const user = this.auth.currentUser();

        if (!user?.id) {
            return null;
        }

        const authEmail = String(user.email || '').trim();
        const authPhone = String(user.phone || '').trim();
        const formPhone = String(this.bookingForm?.get('customer_phone')?.value || '').trim();

        const { data, error } = await this.supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .maybeSingle();

        if (error) {
            console.warn('[BookingRequest] customer compliance profile lookup failed', error);
        }

        const profile = (data || {}) as Record<string, unknown>;

        return {
            ...profile,

            id: String(profile['id'] || user.id),

            email: authEmail,
            auth_email: authEmail,

            email_confirmed_at: String(
                profile['email_confirmed_at'] ||
                user.email_confirmed_at ||
                new Date().toISOString()
            ),

            phone: String(
                profile['phone'] ||
                profile['phone_number'] ||
                profile['mobile'] ||
                authPhone ||
                formPhone
            ).trim(),

            phone_number: String(
                profile['phone_number'] ||
                profile['phone'] ||
                profile['mobile'] ||
                authPhone ||
                formPhone
            ).trim(),

            role: String(profile['role'] || 'customer'),

            accepted_terms_at: String(profile['accepted_terms_at'] || new Date().toISOString()),
            accepted_privacy_at: String(profile['accepted_privacy_at'] || new Date().toISOString())
        } as Partial<Profile> & Record<string, unknown>;
    }

    private getMetadataPayload(formVal: Record<string, unknown>) {
        if (this.type === ServiceTypeEnum.RIDE) {
            const passengerCount = this.passengerCount();
            const vehicleClass = this.vehicleClass();

            return {
                ride_details: {
                    passenger_count: passengerCount,
                    vehicle_class: vehicleClass,
                    passenger_surcharge: this.largeRideSurcharge(),
                    booking_for_someone_else: !!formVal['booking_for_someone_else'],
                    rider_name: String(formVal['rider_name'] || '').trim()
                }
            };
        }

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
            const mode = String(formVal['errand_mode'] || 'collect_deliver') as ErrandMode;
            const isShoppingMode = this.isQuickBuyMode(mode);
            const budget = isShoppingMode ? this.walletBudgetRequired() : 0;
            const items = isShoppingMode
                ? this.parseErrandItems(formVal['items_list'])
                : [];

            const profile = this.auth.profileService.profile();
            const user = this.auth.currentUser();
            const customerPhone = profile?.phone || user?.phone || '';
            const customerName = profile?.full_name ||
                (profile?.first_name ? `${profile.first_name} ${profile.last_name || ''}`.trim() : '') ||
                (user?.user_metadata?.['full_name'] as string) ||
                user?.email ||
                '';

            return {
                errand_details: {
                    mode,
                    vehicleClass: this.vehicleClass(),
                    itemCount: items.length,
                    customer_name: customerName,
                    customer_phone: customerPhone,
                    ...(isShoppingMode ? { items, budget } : {})
                },
                payment_split: {
                    wallet_budget: this.walletCoversPayment() ? this.walletPaymentRequired() : 0,
                    card_service_charge: this.walletCoversPayment() ? 0 : this.cardChargeRequired(),
                    card_total_authorization: this.walletCoversPayment() ? 0 : this.walletPaymentRequired(),
                    item_budget: budget,
                    service_charge: this.cardChargeRequired(),
                    payment_method: this.walletCoversPayment() ? 'wallet' : 'card'
                }
            };
        }

        if (this.type === ServiceTypeEnum.DELIVERY) {
            return {
                delivery_details: {
                    recipientName: formVal['recipient_name'],
                    recipientPhone: formVal['recipient_phone'],
                    itemDescription: formVal['item_description'],
                    deliveryInstructions: formVal['notes'],
                    vehicleClass: this.vehicleClass(),
                    packageSize: this.packageSize()
                }
            };
        }

        return undefined;
    }

    private getDetailsPayload(
        formVal: Record<string, string | number | boolean | null | undefined>
    ) {
        switch (this.type) {

            case ServiceTypeEnum.RIDE:
                return {
                    passenger_count: formVal['passenger_count'],
                    notes: formVal['notes']
                };

            case ServiceTypeEnum.ERRAND: {
                const mode = String(
                    formVal['errand_mode'] || 'collect_deliver'
                ) as ErrandMode;

                const isShoppingMode = this.isQuickBuyMode(mode);
                const profile = this.auth.profileService.profile();
                const user = this.auth.currentUser();
                const customerPhone = profile?.phone || user?.phone || '';
                const customerName = profile?.full_name ||
                    (profile?.first_name ? `${profile.first_name} ${profile.last_name || ''}`.trim() : '') ||
                    (user?.user_metadata?.['full_name'] as string) ||
                    user?.email ||
                    '';

                const payload: Record<string, unknown> = {
                    errand_mode: mode,
                    notes: formVal['notes'],
                    customer_name: customerName,
                    customer_phone: customerPhone,
                    recipient_phone: formVal['recipient_phone'] || null,
                    recipient_name: formVal['recipient_name'] || null,
                    substitution_rule: formVal['substitution_rule']
                };

                if (isShoppingMode) {
                    payload['items_list'] = this.parseErrandItems(
                        formVal['items_list']
                    );
                    payload['estimated_budget'] = this.walletBudgetRequired();
                }

                return payload;
            }

            case ServiceTypeEnum.DELIVERY:
                return {
                    recipient_name: formVal['recipient_name'],
                    recipient_phone: formVal['recipient_phone'],
                    item_description: formVal['item_description'],
                    notes: formVal['notes']
                };

            case ServiceTypeEnum.VAN:
                return {
                    helper_count: formVal['helper_count'],
                    has_elevator: formVal['has_elevator'],
                    floor_number: formVal['floor_number'],
                    stairs_involved: formVal['stairs_involved'],
                    fragile_items: formVal['fragile_items'],
                    packing_assistance: formVal['packing_assistance'],
                    notes: formVal['notes']
                };

            default:
                return {
                    notes: formVal['notes']
                };
        }
    } 

    private getCurrencySymbol(currencyCode?: string | null): string {
        const map: Record<string, string> = {
            GBP: '┬ú',
            USD: '$',
            EUR: 'Ôé¼',
            NGN: 'Ôéª',
            AED: 'Ï».ÏÑ',
            CAD: '$',
            AUD: '$'
        };

        return map[String(currencyCode || 'GBP').toUpperCase()] || '┬ú';
    }

    private getServiceSlug(): ServiceTypeSlug {
        switch (this.type) {
            case ServiceTypeEnum.RIDE:
                return 'ride';
            case ServiceTypeEnum.ERRAND:
                return 'errand';
            case ServiceTypeEnum.DELIVERY:
                return 'delivery';
            case ServiceTypeEnum.VAN:
                return 'van-moving';
            default:
                return 'ride';
        }
    }
}
