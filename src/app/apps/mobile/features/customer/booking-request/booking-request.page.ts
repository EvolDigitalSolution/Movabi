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
    Validators
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
    closeCircleOutline,
    walletOutline,
    alertCircle,
    homeOutline,
    storefrontOutline,
    personOutline,
    callOutline,
    layersOutline
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
import {
    ServiceType,
    ServiceTypeEnum,
    UnifiedLocation
} from '../../../../../shared/models/booking.model';
import {
    ButtonComponent,
    InputComponent,
    PriceDisplayComponent
} from '../../../../../shared/ui';
import { MapComponent } from '../../../../../shared/components/map/map.component';
import {
    AutocompleteResult,
    RouteSummary
} from '../../../../../core/models/maps/route-result.model';
import { FareEstimate } from '../../../../../core/models/maps/fare-estimate.model';
import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';

type ErrandMode = 'collect_deliver' | 'quick_buy' | 'shop_deliver';

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
                      {{ (routeResult()?.distanceMeters! / 1000).toFixed(1) }} km • {{ (routeResult()?.durationSeconds! / 60).toFixed(0) }} mins
                    </p>
                    <p class="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">
                      Route auto-focused on map
                    </p>
                  </div>
                </div>
              </div>
            </div>
          }
        </div>

        <div class="flex-1 bg-white rounded-t-[2rem] -mt-4 relative z-20 shadow-[0_-20px_40px_-15px_rgba(0,0,0,0.1)] px-5 pt-5 pb-8 overflow-y-auto">
          <div class="max-w-2xl mx-auto space-y-5 pb-24">
            <div class="flex items-center gap-4 p-1">
              <div class="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-900 shadow-sm border border-slate-100 shrink-0">
                <ion-icon [name]="getIcon()" class="text-2xl"></ion-icon>
              </div>
              <div>
                <h2 class="text-2xl font-display font-bold text-slate-900 tracking-tight mb-0.5">{{ getTitle() }}</h2>
                <p class="text-slate-400 font-medium text-sm">Trusted local movement for your needs.</p>
              </div>
            </div>

            @if (locationService.locationError()) {
              <div class="p-4 bg-amber-50 border border-amber-100 rounded-2xl flex items-center gap-3 text-amber-800 text-sm font-medium animate-in fade-in slide-in-from-top-2">
                <ion-icon name="information-circle" class="text-2xl text-amber-500 shrink-0"></ion-icon>
                <div class="flex-1">
                  <p>{{ locationService.locationError() }}</p>
                  <button (click)="locationService.setManualMode()" class="text-blue-600 font-bold uppercase tracking-widest text-[10px] mt-2">
                    Continue with manual address
                  </button>
                </div>
              </div>
            }

            <form [formGroup]="bookingForm" (ngSubmit)="submit()" class="space-y-5">
              <div class="space-y-5">
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
                          <button
                            type="button"
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

                  <button
                    type="button"
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
                          <button
                            type="button"
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

                  <button
                    type="button"
                    (click)="useCurrentLocation('dropoff')"
                    class="absolute right-4 top-10 text-blue-600 font-bold text-[10px] uppercase tracking-widest hover:text-blue-700 transition-colors bg-blue-50/50 px-3 py-1 rounded-full z-10">
                    <ion-icon name="locate" class="mr-1 align-middle"></ion-icon>
                    Current
                  </button>
                </div>
              </div>

              @if (type === ServiceTypeEnum.RIDE) {
                <div class="p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <app-input
                    label="Number of Passengers"
                    type="number"
                    formControlName="passenger_count"
                    icon="people-outline">
                  </app-input>
                </div>
              }

              @if (type === ServiceTypeEnum.ERRAND) {
                <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100 space-y-5">
                  <div class="space-y-3">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Errand Type</p>
                    <div class="grid grid-cols-3 gap-3">
                      <button
                        type="button"
                        (click)="bookingForm.patchValue({ errand_mode: 'collect_deliver' })"
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
                        (click)="bookingForm.patchValue({ errand_mode: 'quick_buy' })"
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
                        (click)="bookingForm.patchValue({ errand_mode: 'shop_deliver' })"
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

                  <div class="space-y-2">
                    <label for="items_list" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">
                      Items to Buy
                    </label>

                    <textarea
                      id="items_list"
                      formControlName="items_list"
                      [attr.placeholder]="usesItemListMode() ? 'List the items you need (e.g. Milk, Bread, Eggs...)' : 'Disabled for Collect & Deliver'"
                      [disabled]="!usesItemListMode()"
                      [class.opacity-50]="!usesItemListMode()"
                      [class.cursor-not-allowed]="!usesItemListMode()"
                      class="w-full px-4 py-3 rounded-xl bg-white border border-slate-100 text-slate-900 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-600/5 focus:border-blue-500 transition-all min-h-[100px] placeholder:text-slate-300 shadow-sm">
                    </textarea>

                    @if (!usesItemListMode()) {
                      <p class="px-2 text-[9px] text-slate-400 font-bold uppercase tracking-widest leading-relaxed">
                        Items to Buy is enabled only for Quick Buy and Shop & Deliver.
                      </p>
                    } @else {
                      <p class="px-2 text-[9px] text-slate-400 font-bold uppercase tracking-widest">
                        {{ itemCount() }} ITEM{{ itemCount() === 1 ? '' : 'S' }}
                        @if (additionalItemCharge() > 0) {
                          • +{{ config.formatCurrency(additionalItemCharge()) }} extra item charge
                        }
                      </p>
                    }
                  </div>

                  <div class="space-y-2">
                    <label for="estimated_budget" class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">
                      Item Cost Budget
                    </label>
                    <div
                      class="flex items-center gap-3 w-full px-4 py-4 rounded-xl bg-white border border-slate-100 shadow-sm"
                      [class.opacity-50]="!usesBudgetMode()"
                      [class.cursor-not-allowed]="!usesBudgetMode()">
                      <ion-icon name="cash-outline" class="text-slate-400 text-xl shrink-0"></ion-icon>
                      <input
                        id="estimated_budget"
                        type="text"
                        inputmode="decimal"
                        [value]="displayBudgetValue()"
                        (input)="onBudgetInput($any($event).target.value)"
                        (blur)="formatBudgetOnBlur()"
                        [disabled]="!usesBudgetMode()"
                        [placeholder]="usesBudgetMode() ? '0.00' : 'Disabled for Collect & Deliver'"
                        class="w-full bg-transparent border-0 outline-none text-slate-900 text-lg font-bold placeholder:text-slate-300" />
                    </div>

                    @if (usesBudgetMode()) {
                      <p class="px-2 text-[9px] text-slate-400 font-bold uppercase tracking-widest leading-relaxed">
                        This amount must be available in your wallet and will be reserved for item purchase only.
                      </p>
                    } @else {
                      <p class="px-2 text-[9px] text-slate-400 font-bold uppercase tracking-widest leading-relaxed">
                        Item Cost Budget is enabled only for Quick Buy and Shop & Deliver.
                      </p>
                    }
                  </div>

                  <div class="p-4 bg-white rounded-xl border border-slate-100 space-y-3">
                    <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-1">Contact Information</p>
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
                </div>
              }

              @if (type === ServiceTypeEnum.VAN) {
                <div class="p-4 bg-slate-50 rounded-xl border border-slate-100 space-y-4">
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

              @if (fareEstimate()) {
                <div class="animate-in fade-in slide-in-from-bottom-4 space-y-4">
                  <app-price-display
                    [total]="cardChargeRequired()"
                    [fare]="fareEstimate()?.subtotal || 0"
                    [serviceFee]="fareEstimate()?.serviceFee || 0"
                    [itemBudget]="walletBudgetRequired()"
                    [minimumFareApplied]="fareEstimate()?.minimumFareApplied || false">
                  </app-price-display>

                  @if (type === ServiceTypeEnum.ERRAND) {
                    <div class="grid gap-4">
                      <div class="p-4 bg-blue-50 rounded-xl border border-blue-100">
                        <p class="text-sm leading-8 text-slate-700">
                          The <strong>Service Estimate</strong> is paid to the driver, and the <strong>Item Budget</strong> is available for them to spend on your behalf. This total will be reserved from your wallet now.
                        </p>
                      </div>

                      <div
                        class="p-4 rounded-xl border transition-all"
                        [class.bg-emerald-50]="!hasInsufficientFunds()"
                        [class.border-emerald-100]="!hasInsufficientFunds()"
                        [class.bg-rose-50]="hasInsufficientFunds()"
                        [class.border-rose-100]="hasInsufficientFunds()">

                        <div class="flex items-center justify-between mb-3">
                          <div class="flex items-center gap-3">
                            <div
                              class="w-8 h-8 rounded-xl flex items-center justify-center"
                              [class.bg-emerald-500]="!hasInsufficientFunds()"
                              [class.bg-rose-500]="hasInsufficientFunds()">
                              <ion-icon name="wallet-outline" class="text-white text-lg"></ion-icon>
                            </div>
                            <div>
                              <p
                                class="text-[10px] font-bold uppercase tracking-widest"
                                [class.text-emerald-600]="!hasInsufficientFunds()"
                                [class.text-rose-600]="hasInsufficientFunds()">
                                Wallet for Item Budget
                              </p>
                              <p class="text-sm font-bold text-slate-900">
                                Balance: {{ config.formatCurrency(walletService.wallet()?.available_balance || 0) }}
                              </p>
                              <p class="text-xs text-slate-500 font-semibold">
                                Required: {{ config.formatCurrency(walletBudgetRequired()) }}
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
                          <div class="mt-4 p-4 bg-rose-100/60 rounded-2xl border border-rose-200">
                            <p class="text-xs font-bold text-rose-700 flex items-center gap-2">
                              <ion-icon name="alert-circle"></ion-icon>
                              You need {{ config.formatCurrency(walletBudgetRequired() - (walletService.wallet()?.available_balance || 0)) }} more in your wallet.
                            </p>
                          </div>
                        } @else {
                          <p class="text-[10px] font-bold text-emerald-600 uppercase tracking-widest leading-relaxed">
                            Item budget will be reserved from your wallet. Service fare and platform fee will be charged to your card.
                          </p>
                        }
                      </div>

                      <div class="p-4 bg-slate-50 rounded-xl border border-slate-100 space-y-3">
                        <div class="flex items-center justify-between">
                          <div>
                            <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Service Estimate</p>
                            <p class="text-sm font-bold text-slate-900">
                              Fare & Platform Fee: {{ config.formatCurrency(cardChargeRequired()) }}
                            </p>
                          </div>
                          <span class="text-[10px] font-bold uppercase tracking-widest text-blue-600">
                            {{ itemCount() }} ITEM{{ itemCount() === 1 ? '' : 'S' }}
                          </span>
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
                    </div>
                  } @else {
                    <div class="p-4 bg-slate-50 rounded-xl border border-slate-100 space-y-3">
                      <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-1">Payment Method</p>
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
                  {{
                    submitting()
                      ? 'Processing...'
                      : (
                          type === ServiceTypeEnum.ERRAND
                            ? 'Reserve Budget & Pay Service Fee'
                            : 'Confirm & Pay'
                        )
                  }}
                </app-button>

                <p class="text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-6 flex items-center justify-center gap-2">
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
    imports: [
        IonicModule,
        CommonModule,
        FormsModule,
        ReactiveFormsModule,
        ButtonComponent,
        InputComponent,
        PriceDisplayComponent,
        MapComponent
    ]
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
            walletOutline,
            alertCircle,
            homeOutline,
            storefrontOutline,
            personOutline,
            callOutline,
            layersOutline
        });
    }

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

    pickupResults = signal<AutocompleteResult[]>([]);
    dropoffResults = signal<AutocompleteResult[]>([]);
    showPickupResults = signal(false);
    showDropoffResults = signal(false);

    routeResult = signal<RouteSummary | null>(null);
    fareEstimate = signal<FareEstimate | null>(null);

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

        const extraItems = Math.max(0, this.itemCount() - 1);
        return this.toMoney(extraItems * 0.75);
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

    hasInsufficientFunds = computed(() => {
        if (this.type !== ServiceTypeEnum.ERRAND) return false;
        const budgetRequired = this.walletBudgetRequired();
        const balance = this.toMoney(this.walletService.wallet()?.available_balance || 0);
        return balance < budgetRequired;
    });

    canSubmit = computed(() => {
        if (!this.formValidSignal() || this.submitting() || this.paymentProcessing()) {
            return false;
        }

        if (this.type === ServiceTypeEnum.ERRAND) {
            return !this.hasInsufficientFunds() && this.cardReady() && this.cardComplete();
        }

        return this.cardReady() && this.cardComplete();
    });

    moveSizes = signal([
        { id: 'small', label: 'Small (Few items)', icon: 'cube-outline' },
        { id: 'medium', label: 'Medium (1-2 rooms)', icon: 'business-outline' },
        { id: 'large', label: 'Large (3-4 rooms)', icon: 'home-outline' },
        { id: 'full-house', label: 'Full House', icon: 'storefront-outline' }
    ]);

    private isQuickBuyMode(mode: unknown): mode is ErrandMode {
        return mode === 'quick_buy' || mode === 'shop_deliver';
    }

    private isCollectDeliverMode(mode: unknown): mode is ErrandMode {
        return mode === 'collect_deliver';
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

    private pickupSearch$ = new Subject<string>();
    private dropoffSearch$ = new Subject<string>();
    private lastBookingTime = 0;

    ngOnInit() {
        const typeParam = this.route.snapshot.queryParams['type'];
        this.type = (typeParam as ServiceTypeEnum) || ServiceTypeEnum.RIDE;

        this.initForm();
        void this.loadPricing();

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

    private toMoney(value: unknown): number {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
    }

    displayBudgetValue(): string {
        const value = this.budgetValue();
        return value ? String(value) : '';
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
        if (value === null || value === undefined) return 0;

        const cleaned = String(value).replace(/[^0-9.]/g, '');
        const parsed = Number(cleaned);

        return Number.isFinite(parsed) ? this.toMoney(parsed) : 0;
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
                void loading.dismiss();
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
                    items_list: [''],
                    estimated_budget: [0],
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
            if (type === 'pickup') {
                this.showPickupResults.set(false);
            } else {
                this.showDropoffResults.set(false);
            }
        }, 250);
    }

    selectResult(type: 'pickup' | 'dropoff', result: AutocompleteResult) {
        if (type === 'pickup') {
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
                this.mapComponent.setCenter(loc.longitude, loc.latitude, 16);
            } else {
                setTimeout(() => this.updateRoute(), 80);
            }
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
                        this.mapComponent.fitBounds(
                            [
                                [pickup.lng, pickup.lat],
                                [dropoff.lng, dropoff.lat]
                            ],
                            {
                                padding: {
                                    top: 70,
                                    bottom: 240,
                                    left: 50,
                                    right: 50
                                }
                            }
                        );
                    }, 120);

                    void this.recalculateFare();
                } else {
                    this.routeResult.set(null);
                    this.mapComponent.clearRoute();
                    void this.recalculateFare();
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
        const slug = this.getServiceSlug();
        const selected = types.find((t: ServiceType) => t.slug === slug);

        console.log('AVAILABLE SERVICE TYPES', types);
        console.log('REQUESTED SLUG', slug);
        console.log('SELECTED SERVICE TYPE', selected);

        if (selected) {
            this.serviceType.set(selected);
        } else {
            console.warn('No matching service type found for slug:', slug);
        }
    }

    private async recalculateFare() {
        const route = this.routeResult();
        const serviceSlug = this.getServiceSlug();
        const formVal = this.bookingForm?.getRawValue?.() || this.bookingForm?.value || {};
        const pickup = this.pickupLocation;

        let surge = 1.0;
        let backendTotal = 0;

        if (pickup.latitude && pickup.longitude) {
            const dbPrice = await this.pricingService.calculatePrice(
                this.serviceType()?.id || '',
                serviceSlug as ServiceTypeEnum,
                (route?.distanceMeters || 0) / 1000,
                pickup.latitude,
                pickup.longitude
            );

            console.log('DB PRICING RESPONSE', dbPrice);

            surge = this.pricingService.surgeMultiplier() || 1;
            backendTotal = this.toMoney(dbPrice || 0);
        }

        const localEstimate = this.fareCalculator.calculateFare({
            serviceType: serviceSlug,
            distanceMeters: route?.distanceMeters || 0,
            durationSeconds: route?.durationSeconds || 0,
            basePriceOverride: this.serviceType()?.base_price,
            surgeMultiplier: surge,
            errandDetails: serviceSlug === 'errand'
                ? { mode: formVal.errand_mode }
                : null,
            moveDetails: serviceSlug === 'van-moving'
                ? {
                    size: formVal.size,
                    helperCount: formVal.helper_count,
                    stairsInvolved: formVal.stairs_involved,
                    packingAssistance: formVal.packing_assistance,
                    fragileItems: formVal.fragile_items
                }
                : null
        });

        const baseTotal = backendTotal > 0
            ? backendTotal
            : this.toMoney(localEstimate.total);

        const baseServiceFee =
            serviceSlug === 'errand'
                ? this.toMoney(baseTotal >= 25 ? 1.5 : 1.0)
                : this.toMoney(localEstimate.serviceFee || 0);

        const baseFare = this.toMoney(Math.max(0, baseTotal - baseServiceFee));

        const extraDriverCharge =
            serviceSlug === 'errand' && this.usesItemListMode()
                ? this.driverItemCharge()
                : 0;

        const extraPlatformCharge =
            serviceSlug === 'errand' && this.usesItemListMode()
                ? this.platformItemCharge()
                : 0;

        const subtotal = this.toMoney(baseFare + extraDriverCharge);
        const serviceFee = this.toMoney(baseServiceFee + extraPlatformCharge);
        const finalTotal = this.toMoney(subtotal + serviceFee);

        const estimate: FareEstimate = {
            ...localEstimate,
            subtotal,
            serviceFee,
            total: finalTotal
        };

        this.fareEstimate.set(estimate);
        this.estimatedPrice.set(estimate.total);
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
                return 'Errand Service';
            case ServiceTypeEnum.DELIVERY:
                return 'Package Delivery';
            case ServiceTypeEnum.VAN:
                return 'Van Moving';
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

    private async validateBeforeSubmit(): Promise<string | null> {
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

        if (!this.card || !this.cardMounted || !this.cardReady()) {
            return 'Card input is still loading. Please wait a moment.';
        }

        if (!this.cardComplete()) {
            return 'Please enter your card details before continuing.';
        }

        if (this.type === ServiceTypeEnum.ERRAND) {
            const wallet = await this.walletService.fetchWallet();
            const itemBudget = this.walletBudgetRequired();

            if (!wallet || this.toMoney(wallet.available_balance) < itemBudget) {
                return `Insufficient wallet balance for item budget. You need ${this.config.formatCurrency(itemBudget)} in your wallet.`;
            }
        }

        return null;
    }

    async submit() {
        if (this.submitting() || this.paymentProcessing()) return;

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

        this.submitting.set(true);
        this.paymentProcessing.set(true);

        const loading = await this.loadingCtrl.create({
            message: 'Preparing your booking...'
        });
        await loading.present();

        let booking: { id: string } | null = null;
        let paymentIntentId: string | null = null;

        try {
            const formVal = this.bookingForm.getRawValue();
            const itemBudget = this.walletBudgetRequired();
            const cardCharge = this.cardChargeRequired();

            const countryCode = this.config.currentCountry()?.code || 'GB';
            const currencyCode = this.config.currentCountry()?.currency || this.config.currencyCode || 'GBP';
            const currencySymbol = this.config.currentCountry()?.currencySymbol || this.getCurrencySymbol(currencyCode);

            const bookingData = {
                pickup_address: formVal.pickup_address,
                pickup_lat: this.pickupLocation.latitude || 0,
                pickup_lng: this.pickupLocation.longitude || 0,
                dropoff_address: formVal.dropoff_address || 'Errand Delivery',
                dropoff_lat: this.dropoffLocation.latitude || 0,
                dropoff_lng: this.dropoffLocation.longitude || 0,

                service_type_id: this.serviceType()?.id,
                total_price: cardCharge,

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
                    pricing_plan: 'starter'
                }
            };

            const details = this.getDetailsPayload(formVal);

            loading.message = 'Creating booking...';
            booking = await this.bookingService.createBooking(bookingData, details, this.type);
            this.lastBookingTime = Date.now();

            if (this.type === ServiceTypeEnum.ERRAND && itemBudget > 0) {
                loading.message = 'Reserving item budget from wallet...';
                await this.walletService.reserveErrandFunds(
                    booking.id,
                    itemBudget,
                    0
                );
            }

            loading.message = 'Initializing card payment...';
            const { clientSecret } = await this.paymentService.createPaymentIntent(
                booking.id,
                cardCharge,
                currencyCode,
                this.auth.tenantId() || '',
                this.pricingService.surgeMultiplier()
            );

            loading.message = 'Charging card...';
            const paymentIntent = await this.paymentService.confirmPayment(clientSecret, this.card!);
            paymentIntentId = paymentIntent.id;

            loading.message = this.type === ServiceTypeEnum.ERRAND
                ? 'Activating errand...'
                : 'Activating job...';

            await this.bookingService.confirmJobPayment(booking.id, paymentIntentId);

            this.analytics.track('booking_created', {
                job_id: booking.id,
                type: this.type,
                pickup_source: this.pickupLocation.source,
                distance_km: ((bookingData.distance_meters || 0) / 1000).toFixed(2),
                item_budget: itemBudget,
                card_charge: cardCharge
            });

            await loading.dismiss();
            await this.router.navigate(['/customer/tracking', booking.id]);
        } catch (e: unknown) {
            console.error('[BookingRequest] submit failed', e);

            const message = e instanceof Error ? e.message : 'An error occurred';

            if (booking?.id && !paymentIntentId) {
                try {
                    await this.bookingService.updateBookingStatus(
                        booking.id,
                        'cancelled',
                        `Auto-cancelled after checkout failure: ${message}`
                    );
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
            const mode = String(formVal['errand_mode'] || 'collect_deliver') as ErrandMode;
            const isShoppingMode = this.isQuickBuyMode(mode);
            const budget = isShoppingMode ? this.walletBudgetRequired() : 0;
            const items = isShoppingMode
                ? this.parseErrandItems(formVal['items_list'])
                : [];

            return {
                errand_details: {
                    mode,
                    itemCount: items.length,
                    ...(isShoppingMode ? { items, budget } : {})
                },
                payment_split: {
                    wallet_budget: budget,
                    card_service_charge: this.cardChargeRequired()
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
                const mode = String(formVal['errand_mode'] || 'collect_deliver') as ErrandMode;
                const isShoppingMode = this.isQuickBuyMode(mode);

                const payload: Record<string, unknown> = {
                    errand_mode: mode,
                    delivery_instructions: formVal['notes'],
                    customer_phone: formVal['customer_phone'],
                    recipient_phone: formVal['recipient_phone'],
                    recipient_name: formVal['recipient_name'],
                    substitution_rule: formVal['substitution_rule']
                };

                if (isShoppingMode) {
                    payload['items_list'] = this.parseErrandItems(formVal['items_list']);
                    payload['estimated_budget'] = this.walletBudgetRequired();
                }

                return payload;
            }

            case ServiceTypeEnum.DELIVERY:
                return {
                    recipient_name: formVal['recipient_name'],
                    recipient_phone: formVal['recipient_phone'],
                    notes: formVal['notes']
                };

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

    private getCurrencySymbol(currencyCode?: string | null): string {
        const map: Record<string, string> = {
            GBP: '£',
            USD: '$',
            EUR: '€',
            NGN: '₦',
            AED: 'د.إ',
            CAD: '$',
            AUD: '$'
        };

        return map[String(currencyCode || 'GBP').toUpperCase()] || '£';
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