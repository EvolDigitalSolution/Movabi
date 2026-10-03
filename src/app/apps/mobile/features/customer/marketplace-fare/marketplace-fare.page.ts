import {
    Component,
    inject,
    OnInit,
    AfterViewInit,
    signal,
    computed,
    OnDestroy,
    effect,
    ElementRef,
    ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
    canCustomer,
    deadlineKey,
    deadlineRemainingMs,
    formatRemaining as formatDeadlineRemaining,
    getNegotiationState,
    type NegotiationAction,
    type NegotiationState
} from '@shared/marketplace/negotiation-state';
import { IonicModule, IonContent, LoadingController, ToastController } from '@ionic/angular';
import { ActivatedRoute, Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    chevronBackOutline,
    cashOutline,
    timeOutline,
    navigateOutline,
    flashOutline,
    checkmarkCircleOutline,
    closeCircleOutline,
    timerOutline,
    personOutline,
    sparklesOutline,
    trendingUpOutline,
    sendOutline,
    closeOutline,
    cardOutline,
    informationCircleOutline,
    checkmarkOutline,
    chevronDownOutline,
    chevronUpOutline,
    pricetagOutline
} from 'ionicons/icons';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { MarketplaceNegotiationService, FareNegotiation } from '../../../../../core/services/marketplace/marketplace-negotiation.service';
import { MarketplaceHybridService } from '../../../../../core/services/marketplace/marketplace-hybrid.service';
import { MarketplaceConfigService, MarketplaceEffectiveHybridStatus } from '../../../../../core/services/marketplace/marketplace-config.service';
import { PaymentService } from '../../../../../core/services/stripe/payment.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { ProfileService } from '../../../../../core/services/profile/profile.service';
import { Booking } from '../../../../../shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { StripeCardElement } from '@stripe/stripe-js';

@Component({
    selector: 'app-marketplace-fare',
    standalone: true,
    imports: [CommonModule, FormsModule, IonicModule],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Marketplace Fare</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content #ionContent class="movabi-page" [fullscreen]="true">
      @if (booking(); as job) {

        <!-- Progress Indicator -->
        <div class="bg-gradient-to-r from-amber-50 to-orange-50 px-4 py-3 border-b border-amber-100">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <ion-icon name="sparkles-outline" class="text-amber-600 text-lg"></ion-icon>
              <span class="text-xs font-bold text-amber-800 uppercase tracking-wider">Marketplace Status</span>
            </div>
            @if (countdown() > 0) {
              <div class="flex items-center gap-1 text-amber-700">
                <ion-icon name="timer-outline" class="text-sm"></ion-icon>
                <span class="text-xs font-semibold">{{ formatCountdown(countdown()) }}</span>
              </div>
            }
          </div>
          <div class="flex items-center gap-1">
            @for (step of progressSteps(); track step.status) {
              <div class="flex items-center gap-1">
                <div
                  class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300"
                  [class]="{
                    'bg-emerald-500 text-white': step.completed,
                    'bg-amber-500 text-white animate-pulse': step.active,
                    'bg-slate-200 text-slate-500': !step.completed && !step.active
                  }"
                >
                  @if (step.completed) {
                    <ion-icon name="checkmark-outline" class="text-xs"></ion-icon>
                  } @else {
                    {{ step.number }}
                  }
                </div>
                @if (!step.isLast) {
                  <div
                    class="w-8 h-0.5 transition-all duration-300"
                    [class]="{
                      'bg-emerald-400': step.completed,
                      'bg-amber-400': step.active,
                      'bg-slate-200': !step.completed && !step.active
                    }"
                  ></div>
                }
              </div>
            }
          </div>
          <div class="flex justify-between mt-1">
            @for (step of progressSteps(); track step.status) {
              <span
                class="text-xs font-medium transition-all duration-300"
                [class]="{
                  'text-emerald-700': step.completed,
                  'text-amber-700 font-bold': step.active,
                  'text-slate-500': !step.completed && !step.active
                }"
              >
                {{ step.label }}
              </span>
            }
          </div>
        </div>

        <div class="px-4 pt-4 pb-8">

          <!-- ── FARE SUMMARY CARD (always visible) ── -->
          <div class="bg-gradient-to-br from-white to-amber-50 rounded-3xl border border-amber-100 shadow-lg p-5 mb-4 relative overflow-hidden">
            <div class="absolute top-0 right-0 w-28 h-28 bg-gradient-to-bl from-amber-200/20 to-transparent rounded-full -mr-14 -mt-14"></div>
            <div class="relative">

              <!-- Header row -->
              <div class="flex items-center justify-between mb-4">
                <p class="text-[10px] font-black uppercase tracking-widest text-amber-600">Suggested Fare</p>
                @if (dynamicMultiplier() > 1) {
                  <div class="flex items-center gap-1 text-xs font-semibold text-amber-600 bg-amber-100 rounded-full px-3 py-1">
                    <ion-icon name="trending-up-outline"></ion-icon>
                    <span>×{{ dynamicMultiplier() }}</span>
                  </div>
                }
              </div>

              <!-- Always-visible key figures -->
              @if (isErrand()) {
                <!-- Errand: show all three lines prominently -->
                <div class="space-y-3">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Authorisation</p>
                      <p class="text-3xl font-display font-black text-slate-900">{{ formatPrice(paymentTotal()) }}</p>
                    </div>
                    <div class="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
                      <ion-icon name="pricetag-outline" class="text-amber-600 text-lg"></ion-icon>
                    </div>
                  </div>
                  <div class="h-px bg-amber-100/60"></div>
                  <div class="grid grid-cols-2 gap-2">
                    <div class="bg-white/70 rounded-2xl px-3 py-2.5 border border-amber-100/60">
                      <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Service Fare</p>
                      <p class="text-lg font-display font-bold text-slate-900">{{ suggestedFareLabel() }}</p>
                    </div>
                    <div class="bg-emerald-50 rounded-2xl px-3 py-2.5 border border-emerald-100">
                      <p class="text-[9px] font-bold text-emerald-600 uppercase tracking-widest mb-0.5">Shopping Budget</p>
                      <p class="text-lg font-display font-bold text-emerald-900">{{ formatPrice(itemBudget()) }}</p>
                    </div>
                  </div>
                  <p class="text-[10px] text-slate-400 text-center">Shopping budget is reserved separately and not part of the service fare.</p>
                </div>
              } @else {
                <!-- Non-errand: single fare amount -->
                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Fare</p>
                    <p class="text-4xl font-display font-black text-slate-900">{{ suggestedFareLabel() }}</p>
                  </div>
                  <div class="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center">
                    <ion-icon name="pricetag-outline" class="text-amber-600 text-xl"></ion-icon>
                  </div>
                </div>
              }

              <!-- Trip meta -->
              <div class="flex gap-3 mt-4">
                <div class="flex items-center gap-1.5 text-slate-500 text-xs">
                  <ion-icon name="navigate-outline" class="text-amber-500"></ion-icon>
                  <span class="font-medium">{{ distanceKm().toFixed(1) }} km</span>
                </div>
                <div class="flex items-center gap-1.5 text-slate-500 text-xs">
                  <ion-icon name="time-outline" class="text-amber-500"></ion-icon>
                  <span class="font-medium">{{ formatDuration(durationSeconds()) }}</span>
                </div>
                @if (dynamicMultiplier() > 1) {
                  <div class="flex items-center gap-1.5 text-amber-600 text-xs">
                    <ion-icon name="flash-outline" class="text-amber-500"></ion-icon>
                    <span class="font-medium">×{{ dynamicMultiplier() }} surge</span>
                  </div>
                }
              </div>

              <!-- Collapsible breakdown toggle -->
              <button
                type="button"
                (click)="showBreakdown.set(!showBreakdown())"
                class="mt-4 w-full flex items-center justify-between py-2.5 px-3 bg-white/70 border border-amber-100 rounded-2xl text-sm font-semibold text-slate-600 active:bg-amber-50 transition-all"
              >
                <span>{{ showBreakdown() ? 'Hide fare breakdown' : 'View fare breakdown' }}</span>
                <ion-icon [name]="showBreakdown() ? 'chevron-up-outline' : 'chevron-down-outline'" class="text-base text-amber-500"></ion-icon>
              </button>

              <!-- Expanded breakdown -->
              @if (showBreakdown() && fareBreakdown()) {
                <div class="mt-3 bg-white/70 rounded-2xl border border-amber-100/60 p-4 space-y-2.5">
                  @for (row of fareRows(); track row.label) {
                    <div class="flex justify-between items-center">
                      <div class="flex items-center gap-2">
                        <div class="w-2 h-2 rounded-full" [class]="row.dotClass"></div>
                        <span class="text-sm text-slate-600">{{ row.label }}</span>
                      </div>
                      <span class="font-semibold" [class]="row.amountClass">{{ formatPrice(row.amount) }}</span>
                    </div>
                  }
                  @if (false) {
                  @if (fareBreakdown().baseFare !== undefined) {
                    <div class="flex justify-between items-center">
                      <div class="flex items-center gap-2">
                        <div class="w-2 h-2 bg-slate-400 rounded-full"></div>
                        <span class="text-sm text-slate-600">Base fare</span>
                      </div>
                      <span class="font-semibold text-slate-900">{{ formatPrice(fareBreakdown().baseFare) }}</span>
                    </div>
                  }
                  <div class="flex justify-between items-center">
                    <div class="flex items-center gap-2">
                      <div class="w-2 h-2 bg-blue-400 rounded-full"></div>
                      <span class="text-sm text-slate-600">Distance &amp; time</span>
                    </div>
                    <span class="font-semibold text-slate-900">{{ distanceKm().toFixed(1) }} km · {{ formatDuration(durationSeconds()) }}</span>
                  </div>
                  @if (fareBreakdown().distanceCost !== undefined) {
                    <div class="flex justify-between items-center pl-5">
                      <span class="text-xs text-slate-500">Distance/time cost</span>
                      <span class="font-semibold text-slate-900">{{ formatPrice(fareBreakdown().distanceCost) }}</span>
                    </div>
                  }
                  @if (fareBreakdown().dynamicPricingAmount) {
                    <div class="flex justify-between items-center">
                      <div class="flex items-center gap-2">
                        <div class="w-2 h-2 bg-amber-400 rounded-full"></div>
                        <span class="text-sm text-slate-600">Marketplace adjustment</span>
                      </div>
                      <span class="font-semibold text-amber-700">{{ formatPrice(fareBreakdown().dynamicPricingAmount) }}</span>
                    </div>
                  }
                  @if (fareBreakdown().serviceFee || fareBreakdown().platformFee) {
                    <div class="flex justify-between items-center">
                      <div class="flex items-center gap-2">
                        <div class="w-2 h-2 bg-purple-400 rounded-full"></div>
                        <span class="text-sm text-slate-600">Platform / booking fee</span>
                      </div>
                      <span class="font-semibold text-slate-900">{{ formatPrice(fareBreakdown().serviceFee || fareBreakdown().platformFee) }}</span>
                    </div>
                  }
                  }
                  <div class="pt-2 border-t border-amber-100/60 flex justify-between items-center">
                    <span class="text-sm font-bold text-slate-700">Total service fare</span>
                    <span class="text-base font-bold text-slate-900">{{ suggestedFareLabel() }}</span>
                  </div>
                  @if (isErrand() && itemBudget() > 0) {
                    <div class="flex justify-between items-center">
                      <div class="flex items-center gap-2">
                        <div class="w-2 h-2 bg-emerald-400 rounded-full"></div>
                        <span class="text-sm text-slate-600">Shopping budget reserved</span>
                      </div>
                      <span class="font-semibold text-emerald-700">{{ formatPrice(itemBudget()) }}</span>
                    </div>
                  }
                </div>
              }

            </div>
          </div>

          <!-- ── PRIMARY ACTION BUTTONS (pending_fare_confirmation / negotiating) ── -->
          @if (job.status === 'negotiating' || job.status === 'pending_fare_confirmation') {
            <div class="space-y-3 mb-4">
              @if (acceptFareEnabled) {
                <button
                  type="button"
                  (click)="acceptSuggestedFare()"
                  class="w-full py-4 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-3xl font-black text-lg active:scale-95 transition-all shadow-lg flex items-center justify-center gap-3"
                >
                  <ion-icon name="checkmark-circle-outline" class="text-xl"></ion-icon>
                  Accept Fare &amp; Pay
                </button>
              }
              @if (makeOfferEnabled && canCustomer('make_offer')) {
                <button
                  type="button"
                  (click)="openHybridOfferInput()"
                  class="w-full py-4 bg-white border-2 border-amber-500 text-amber-700 rounded-3xl font-black text-lg active:scale-95 transition-all shadow-sm flex items-center justify-center gap-3"
                >
                  <ion-icon name="pricetag-outline" class="text-xl"></ion-icon>
                  Make an Offer
                </button>
              }
              <!--
                Patch 1A: once a customer offer is outstanding, "Make an Offer" is no
                longer permitted by the canonical negotiation state. The persisted state
                is shown instead, and the authority for this is the RPC — not this gate.
              -->
              @if (customerOfferOutstanding()) {
                <div class="bg-amber-50 border border-amber-200 rounded-3xl p-4 space-y-1">
                  <p class="text-sm font-bold text-slate-900">
                    Offer{{ negotiationState().pendingOffer ? ' ' + formatPrice(negotiationState().pendingOffer!.amount) : '' }}
                  </p>
                  <p class="text-xs text-slate-600">
                    {{ awaitingNextDriver() ? 'Finding another driver…' : 'Waiting for a driver response.' }}
                  </p>
                </div>
              }
              @if (canCustomer('cancel_offer')) {
                <button
                  type="button"
                  (click)="cancelHybridRequest()"
                  [disabled]="negotiationBusy()"
                  class="w-full py-3 bg-white border border-rose-200 text-rose-700 rounded-2xl font-bold text-base active:scale-95 transition-all disabled:opacity-50"
                >
                  Cancel Offer
                </button>
              }
            </div>
          }

          <!-- ── HYBRID OFFER INPUT ── -->
          @if (showHybridOfferInput()) {
            <div #offerForm class="bg-white rounded-3xl border border-amber-100 shadow-sm p-5 mb-4 scroll-mt-24">
              <label class="text-sm font-bold text-slate-700 mb-2 block">Your offer</label>
              <div class="bg-amber-50 rounded-2xl border border-amber-100 p-3 mb-3 space-y-1">
                <div class="flex justify-between text-sm">
                  <span class="text-slate-600">Suggested service fare</span>
                  <span class="font-bold text-slate-900">{{ suggestedFareLabel() }}</span>
                </div>
                @if (isErrand() && itemBudget() > 0) {
                  <div class="flex justify-between text-sm">
                    <span class="text-slate-600">Shopping budget reserved</span>
                    <span class="font-bold text-emerald-700">{{ formatPrice(itemBudget()) }}</span>
                  </div>
                }
                <p class="text-xs text-slate-500">Your offer changes the service fare only. The shopping budget stays reserved separately.</p>
                <div class="flex justify-between text-sm pt-1 border-t border-amber-100">
                  <span class="font-semibold text-slate-700">Preview total authorisation</span>
                  <span class="font-black text-slate-900">{{ formatPrice(hybridOfferTotalPreview()) }}</span>
                </div>
              </div>
              <input
                #offerAmountInput
                type="number"
                [ngModel]="hybridOfferAmount()"
                (ngModelChange)="setHybridOfferAmount($event)"
                class="w-full py-3 px-4 border border-slate-200 rounded-2xl font-display font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                placeholder="Enter your offer amount"
              />
              <div class="flex gap-3 mt-4">
                <button
                  type="button"
                  (click)="submitHybridOffer()"
                  [disabled]="!hybridOfferAmount() || hybridOfferAmount() <= 0"
                  class="flex-1 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-2xl font-bold text-base active:scale-95 transition-all shadow-lg"
                >
                  Send Offer
                </button>
                <button
                  type="button"
                  (click)="showHybridOfferInput.set(false)"
                  class="flex-1 py-3 bg-white border border-slate-200 text-slate-700 rounded-2xl font-bold text-base active:scale-95 transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          }

          <!-- ── HYBRID NEGOTIATION STATUS ── -->
          @if (hybridEnabled && hybridSession() && !showHybridOfferInput()) {
            <div class="bg-white rounded-3xl border border-amber-100 shadow-sm p-5 mb-4">
              @if (hybridSession().status === 'open' || hybridSession().status === 'released') {
                <div class="text-center py-6">
                  <ion-icon name="time-outline" class="text-4xl text-amber-500 mb-2"></ion-icon>
                  <p class="text-lg font-bold text-slate-900">Waiting for a driver</p>
                  <p class="text-sm text-slate-500 mt-1">Your offer has been sent. We'll notify you when a driver starts negotiating.</p>
                </div>
              }
              @if (hybridSession().status === 'driver_claimed' || hybridSession().status === 'negotiating') {
                <div class="space-y-4">
                  @if (driverProfile(); as driver) {
                    <div class="bg-amber-50 rounded-2xl border border-amber-100 p-4">
                      <div class="flex items-center gap-3">
                        <div class="w-12 h-12 rounded-full bg-white flex items-center justify-center text-amber-600">
                          <ion-icon name="person-outline" class="text-xl"></ion-icon>
                        </div>
                        <div class="flex-1">
                          <p class="text-sm font-bold text-slate-900">{{ driverName() }}</p>
                          <p class="text-xs text-slate-500">{{ driverCompletedTrips() }} trips · {{ driverRating() }} rating</p>
                        </div>
                      </div>
                      @if (driverVehicleLabel()) {
                        <p class="text-xs text-slate-600 mt-2 font-medium">{{ driverVehicleLabel() }} · {{ driverEta() }}</p>
                      }
                      @if (driverPhone()) {
                        <p class="text-xs text-slate-600 mt-1 font-medium">{{ driverPhone() }}</p>
                      }
                    </div>
                  } @else {
                    <div class="flex items-center gap-3">
                      <div class="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center text-amber-600">
                        <ion-icon name="person-outline" class="text-xl"></ion-icon>
                      </div>
                      <div>
                        <p class="text-sm font-bold text-slate-900">A driver is negotiating</p>
                        <p class="text-xs text-slate-500">Round {{ hybridSession().round_count || 1 }}</p>
                      </div>
                    </div>
                  }

                  <!--
                    Canonical gate: the driver-counter card is rendered ONLY while the
                    canonical state still offers a customer response. Once the lease
                    lapses (phase expires) or the request is released, the stale counter
                    is NOT actionable and these controls disappear immediately.
                  -->
                  @if (canCustomer('accept') || canCustomer('decline')) {
                    @if (hybridSession().driver_counter_offer) {
                      <div class="bg-amber-50 rounded-2xl border border-amber-100 p-4">
                        <p class="text-[10px] font-black uppercase tracking-widest text-amber-600 mb-1">Driver Counter</p>
                        <p class="text-2xl font-display font-black text-amber-900">{{ formatPrice(hybridSession().driver_counter_offer) }}</p>
                      </div>
                    }
                    <div class="grid grid-cols-2 gap-3">
                      @if (canCustomer('accept')) {
                        <button
                          type="button"
                          (click)="acceptDriverCounter()"
                          class="w-full py-3 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl font-bold text-sm active:scale-95 transition-all shadow-lg"
                        >
                          Accept
                        </button>
                      }
                      @if (canCustomer('counter')) {
                        <button
                          type="button"
                          (click)="openHybridOfferInput()"
                          class="w-full py-3 bg-white border border-amber-500 text-amber-700 rounded-2xl font-bold text-sm active:scale-95 transition-all"
                        >
                          Counter
                        </button>
                      }
                    </div>
                    @if (canCustomer('decline')) {
                      <button
                        type="button"
                        (click)="tryAnotherDriver()"
                        class="w-full py-3 bg-white border border-slate-200 text-slate-700 rounded-2xl font-bold text-sm active:scale-95 transition-all"
                      >
                        Try Another Driver
                      </button>
                    }
                  }
                </div>
              }
              @if (hybridSession().status === 'fare_agreed') {
                <div class="text-center py-4">
                  <ion-icon name="checkmark-circle-outline" class="text-4xl text-emerald-500 mb-2"></ion-icon>
                  <p class="text-lg font-bold text-emerald-900">Fare agreed!</p>
                  <p class="text-sm text-emerald-700">Complete payment below to confirm.</p>
                  @if (driverProfile(); as driver) {
                    <div class="bg-white/80 rounded-2xl border border-emerald-100 p-3 mt-4 text-left">
                      <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600">
                          <ion-icon name="person-outline" class="text-lg"></ion-icon>
                        </div>
                        <div class="flex-1">
                          <p class="text-sm font-bold text-slate-900">{{ driverName() }}</p>
                          <p class="text-xs text-slate-500">{{ driverCompletedTrips() }} trips · {{ driverRating() }} rating</p>
                        </div>
                      </div>
                      @if (driverVehicleLabel()) {
                        <p class="text-xs text-slate-600 mt-2 font-medium">{{ driverVehicleLabel() }} · {{ driverEta() }}</p>
                      }
                    </div>
                  }
                </div>
              }
              @if (canCustomer('cancel_offer')) {
                <button
                  type="button"
                  (click)="cancelHybridRequest()"
                  [disabled]="negotiationBusy()"
                  class="w-full mt-4 py-3 bg-white border border-red-200 text-red-700 rounded-2xl font-bold text-sm active:scale-95 transition-all disabled:opacity-50"
                >
                  {{ negotiationState().paymentExpired ? 'Find Another Driver' : 'Cancel Request' }}
                </button>
              }
            </div>
          }

          <!-- ── FARE AGREED STATE ── -->
          @if (job.status === 'fare_agreed') {
            <div class="bg-gradient-to-br from-emerald-50 to-green-50 border border-emerald-200 rounded-3xl p-6 text-center relative overflow-hidden mb-4">
              <div class="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-emerald-200/30 to-transparent rounded-full -mr-16 -mt-16"></div>
              <div class="relative">
                <div class="w-16 h-16 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-4">
                  <ion-icon name="checkmark-circle-outline" class="text-white text-2xl"></ion-icon>
                </div>
                <h3 class="text-xl font-bold text-emerald-900 mb-2">Fare Successfully Agreed!</h3>
                @if (negotiationState().paymentExpired) {
                  <p class="text-rose-700 mb-4 font-semibold">Payment time expired. This fare agreement is no longer valid.</p>
                } @else {
                  <p class="text-emerald-700 mb-1 font-semibold">Fare agreed — complete payment within {{ formatRemaining(paymentCountdown()) }}</p>
                  <p class="text-emerald-700 mb-4">Pay here to confirm your booking and start finding a driver.</p>
                }
                <div class="bg-white/70 rounded-2xl p-4 mb-5 border border-emerald-100 space-y-2 text-left">
                  @if (isErrand()) {
                    <div class="flex justify-between items-center">
                      <span class="text-sm text-emerald-600">Shopping Budget Reserved</span>
                      <span class="font-semibold text-emerald-900">{{ formatPrice(itemBudget()) }}</span>
                    </div>
                  }
                  <div class="flex justify-between items-center">
                    <span class="text-sm text-emerald-600">{{ isErrand() ? 'Service Fare' : 'Agreed Fare' }}</span>
                    <span class="font-semibold text-emerald-900">{{ job.agreed_fare ? formatPrice(job.agreed_fare) : suggestedFareLabel() }}</span>
                  </div>
                  <div class="h-px bg-emerald-100"></div>
                  <div class="flex justify-between items-center">
                    <span class="text-sm font-bold text-emerald-800">{{ isErrand() ? 'Total Authorisation' : 'Total to Pay' }}</span>
                    <span class="text-2xl font-black text-emerald-900">{{ formatPrice(paymentTotal()) }}</span>
                  </div>
                </div>
                @if (hybridEnabled && !negotiationState().paymentExpired) {
                  <div class="bg-white rounded-2xl border border-emerald-100 p-4 mb-4 text-left">
                    <div #cardElementHost class="py-3 px-2 border border-slate-200 rounded-xl bg-white min-h-[50px]"></div>
                    @if (cardError()) {
                      <p class="text-xs text-red-500 mt-2 font-medium">{{ cardError() }}</p>
                    }
                  </div>
                  <button
                    type="button"
                    (click)="payWithCard()"
                    [disabled]="!cardReady() || paymentProcessing() || negotiationState().paymentExpired"
                    class="w-full py-4 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl font-bold text-base active:scale-95 transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-70"
                  >
                    @if (paymentProcessing()) {
                      <span>Processing...</span>
                    } @else {
                      <ion-icon name="card-outline"></ion-icon>
                      <span>Pay {{ formatPrice(paymentTotal()) }}</span>
                    }
                  </button>
                } @else {
                  <button
                    type="button"
                    (click)="continueToPayment()"
                    class="w-full py-4 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl font-bold text-base active:scale-95 transition-all shadow-lg flex items-center justify-center gap-2"
                  >
                    <ion-icon name="card-outline"></ion-icon>
                    Continue to Payment
                  </button>
                }
              </div>
            </div>
          }

        </div>
      } @else {
        <div class="h-full flex items-center justify-center p-6">
          <p class="text-slate-500 font-semibold">Loading fare details...</p>
        </div>
      }
    </ion-content>
  `
})
export class MarketplaceFarePage implements OnInit, AfterViewInit, OnDestroy {
    private route = inject(ActivatedRoute);
    private router = inject(Router);
    private supabase = inject(SupabaseService);
    private config = inject(AppConfigService);
    private bookingService = inject(BookingService);
    private negotiationService = inject(MarketplaceNegotiationService);
    private hybridService = inject(MarketplaceHybridService);
    private paymentService = inject(PaymentService);
    private marketplaceConfig = inject(MarketplaceConfigService);
    private auth = inject(AuthService);
    private profileService = inject(ProfileService);
    private toastCtrl = inject(ToastController);
    private loadingCtrl = inject(LoadingController);

    get hybridEnabled(): boolean {
        return this.effectiveHybridStatus()?.enabled === true;
    }

    get acceptFareEnabled(): boolean {
        return !this.hybridEnabled || this.hybridService.isAcceptFareEnabled();
    }

    get makeOfferEnabled(): boolean {
        return this.hybridEnabled && this.hybridService.isMakeOfferEnabled();
    }

    private cardElementHost: ElementRef<HTMLDivElement> | null = null;

    @ViewChild('cardElementHost')
    set cardElementHostRef(ref: ElementRef<HTMLDivElement> | undefined) {
        if (ref && !this.cardElementHost) {
            this.cardElementHost = ref;
            void this.initializeStripe();
        } else if (!ref) {
            this.cardMounted = false;
            this.cardReady.set(false);
            this.cardComplete.set(false);
            this.cardElementHost = null;
        }
    }

    @ViewChild('ionContent') ionContent?: IonContent;
    @ViewChild('counterInputSection') counterInputSection?: ElementRef;
    @ViewChild('offerForm') offerForm?: ElementRef<HTMLElement>;
    @ViewChild('offerAmountInput') offerAmountInput?: ElementRef<HTMLInputElement>;

    booking = signal<Booking | null>(null);
    effectiveHybridStatus = signal<MarketplaceEffectiveHybridStatus | null>(null);
    negotiations = signal<FareNegotiation[]>([]);
    counterAmount = signal<number>(0);
    showCounterInput = signal(false);
    showBreakdown = signal(false);
    paymentProcessing = signal(false);
    paymentError = signal<string | null>(null);
    cardError = signal<string | null>(null);
    cardComplete = signal(false);
    cardReady = signal(false);
    countdown = signal<number>(0);

    // Hybrid negotiation state
    hybridSession = signal<any>(null);
    hybridEvents = signal<any[]>([]);
    driverProfile = signal<any>(null);
    driverVehicle = signal<any>(null);
    hybridOfferAmount = signal<number>(0);
    showHybridOfferInput = signal(false);
    hybridPaymentVisible = signal(false);
    private hybridSessionChannel?: RealtimeChannel;
    private hybridEventsChannel?: RealtimeChannel;

    private jobChannel?: RealtimeChannel;
    private negotiationChannel?: RealtimeChannel;
    private countdownInterval?: any;
    private card: StripeCardElement | null = null;
    private cardMounted = false;
    private stripeInitializing = false;

    constructor() {
        addIcons({
            chevronBackOutline,
            cashOutline,
            timeOutline,
            navigateOutline,
            flashOutline,
            checkmarkCircleOutline,
            closeCircleOutline,
            timerOutline,
            personOutline,
            sparklesOutline,
            trendingUpOutline,
            sendOutline,
            closeOutline,
            cardOutline,
            informationCircleOutline,
            checkmarkOutline,
            chevronDownOutline,
            chevronUpOutline,
            pricetagOutline
        });

        effect(() => {
            const job = this.booking();
            if (job?.status === 'fare_agreed') {
                this.showToast('Excellent! Your fare has been agreed. Continue to payment to secure your booking.', 'success');
            }
        });
    }

    async ngOnInit() {
        const id = this.route.snapshot.paramMap.get('id');
        if (!id) {
            await this.router.navigate(['/customer']);
            return;
        }

        await this.loadBooking(id);

        // Terminal guard: a stale Activity card, browser history, or a direct
        // route must not make a terminal request actionable. Reconcile the
        // authoritative persisted job first and fail closed to Activity.
        if (this.isTerminalBooking) {
            await this.showToast('This request is no longer active.', 'warning');
            await this.router.navigate(['/customer/activity'], { replaceUrl: true });
            return;
        }

        await this.hybridService.loadSettings();
        await this.loadEffectiveHybridStatus();
        this.subscribeToJob(id);

        if (this.hybridEnabled) {
            await this.loadHybridSession(id);
            this.subscribeToHybridSession(id);
            this.startLeaseTimer();
        }
    }

    ngOnDestroy() {
        // Clean up all subscriptions
        if (this.jobChannel) {
            this.jobChannel.unsubscribe();
            this.jobChannel = undefined;
        }
        if (this.negotiationChannel) {
            this.negotiationChannel.unsubscribe();
            this.negotiationChannel = undefined;
        }
        if (this.hybridSessionChannel) {
            this.hybridSessionChannel.unsubscribe();
            this.hybridSessionChannel = undefined;
        }
        if (this.hybridEventsChannel) {
            this.hybridEventsChannel.unsubscribe();
            this.hybridEventsChannel = undefined;
        }
        // Scoped negotiation subscription: one disposer, no duplicate channels.
        this.disposeHybridSubscription();
        this.stopLeaseTimer();
        this.stopCountdown();

        // Clear signals to free memory
        this.booking.set(null);
        this.negotiations.set([]);
        this.counterAmount.set(0);
        this.showCounterInput.set(false);
        this.showBreakdown.set(false);
        this.countdown.set(0);
        this.hybridSession.set(null);
        this.hybridEvents.set([]);
        this.hybridOfferAmount.set(0);
        this.showHybridOfferInput.set(false);
        this.hybridPaymentVisible.set(false);
        if (this.card) {
            this.card.destroy();
            this.card = null;
        }
        this.cardMounted = false;
    }

    async ngAfterViewInit() {
        await this.initializeStripe();
    }

    isErrand(): boolean {
        const slug = String(this.booking()?.service_slug || '').toLowerCase();
        return ['errand', 'errands', 'shop', 'shopping'].includes(slug);
    }

    itemBudget(): number {
        if (!this.isErrand()) return 0;
        const job = this.booking();
        return Number(
            job?.errand_funding?.amount_reserved ||
            job?.errand_details?.estimated_budget ||
            0
        );
    }

    /**
     * Patch 1A — CANONICAL negotiation state.
     *
     * The phase and the available actions are derived from PERSISTED session +
     * events via the shared helper; the template never re-implements the state
     * machine and never relies on transient component flags. Lifecycle events
     * (session_claimed / session_released / session_expired / payment_completed)
     * do not transfer the negotiation turn.
     */
    readonly negotiationState = computed<NegotiationState>(() =>
        // negotiationClock() is a wall-clock tick: computed() only re-derives when a
        // dependency changes, and Realtime emits nothing merely because time passed.
        // Without it a lapsed lease kept rendering a stale, actionable driver counter.
        getNegotiationState(this.hybridSession(), this.hybridEvents(), this.negotiationClock())
    );

    /** True only when the canonical state permits this customer action. */
    canCustomer(action: NegotiationAction): boolean {
        return canCustomer(this.negotiationState(), action);
    }

    /** A customer offer is awaiting a response (drives the "offer sent" panel). */
    readonly customerOfferOutstanding = computed<boolean>(() => {
        const state = this.negotiationState();
        return state.phase === 'waiting_for_driver' || state.phase === 'driver_turn';
    });

    /**
     * Canonical: the RETAINED customer proposal is waiting for ANOTHER driver after
     * a previous driver's claim ended (released / lease lapsed). The offer stays
     * authoritative and only Cancel is permitted — never a fresh initial proposal.
     */
    readonly awaitingNextDriver = computed<boolean>(() => this.negotiationState().awaitingNextDriver === true);

    /**
     * AUTHORITATIVE payment countdown (ms) — derived from the persisted
     * marketplace_negotiation_sessions.payment_deadline, never from a fresh
     * client-side timer. A 1-second display clock (negotiationClock) makes the
     * computed re-derive; a refresh/re-entry therefore shows the SAME remaining
     * time because the deadline is server-persisted.
     */
    readonly paymentCountdown = computed<number>(() => {
        const session = this.hybridSession();
        if (!session || this.negotiationState().phase !== 'agreed_payment_required') return 0;
        const raw = (session as any)?.payment_deadline ?? (session as any)?.expires_at ?? null;
        return deadlineRemainingMs(raw, this.negotiationClock());
    });

    /**
     * UX-only double-submit guard. This is NOT the authority: the database RPC
     * transitions are the real protection against duplicate or out-of-turn
     * negotiation mutations.
     */
    readonly negotiationBusy = signal<boolean>(false);

    /**
     * Authoritative suggested fare. Returns null when no authoritative fare exists so the
     * UI shows an unavailable state instead of manufacturing a legitimate-looking £0.00.
     */
    suggestedFare(): number | null {
        const job = this.booking();
        const fb = this.fareBreakdown();
        const raw =
            job?.agreed_fare ??
            fb?.['customerServiceTotal'] ??
            fb?.['serviceFare'] ??
            fb?.['total'] ??
            job?.total_price ??
            null;
        if (raw === null || raw === undefined) return null;
        const value = Number(raw);
        return Number.isFinite(value) && value > 0 ? value : null;
    }

    /** True only when an authoritative positive fare is available. */
    suggestedFareAvailable(): boolean {
        return this.suggestedFare() !== null;
    }

    /** Honest display value: never renders a manufactured £0.00 for a missing fare. */
    suggestedFareLabel(): string {
        const fare = this.suggestedFare();
        return fare === null ? 'Fare unavailable' : this.formatPrice(fare);
    }

    paymentTotal(): number {
        const job = this.booking();
        const fb = this.fareBreakdown();

        // MONEY AUTHORITY: for a NEGOTIATED job the agreed fare IS the complete
        // customer service charge — exactly what the server derives through
        // PaymentAuthorityService (`agreed_fare + itemBudget`, no platform fee
        // added). The persisted ORIGINAL quote's `totalAuthorisation` predates the
        // negotiation and must never override the agreed fare.
        const agreed = Number(job?.agreed_fare);
        if (Number.isFinite(agreed) && agreed > 0) {
            return this.toMoney(agreed + this.itemBudget());
        }

        // Non-negotiated: the persisted quote breakdown IS authoritative.
        return Number(
            fb?.['totalAuthorisation'] ||
            (Number(this.suggestedFare()) + this.itemBudget())
        );
    }

    fareBreakdown(): any {
        return (this.booking() as any)?.fare_breakdown || null;
    }

    fareRows(): Array<{ label: string; amount: number; dotClass: string; amountClass: string }> {
        const fb = this.fareBreakdown();
        if (!fb) return [];

        const serviceFare = this.toMoney(this.suggestedFare());
        const baseFare = this.toMoney(fb['baseFare']);
        const distanceFare = this.toMoney(fb['distanceFare'] ?? fb['distanceCost']);
        const durationFare = this.toMoney(fb['durationFare'] ?? fb['durationCost']);
        const extrasFare = this.toMoney(fb['extrasFare'] ?? fb['serviceFee']);
        const minimumFareAdjustment = this.toMoney(fb['minimumFareAdjustment']);
        const maximumFareAdjustment = this.toMoney(fb['maximumFareAdjustment']);
        const platformFee = this.toMoney(fb['platformFeeAmount'] ?? fb['platformFee']);
        let pricingAdjustment = this.toMoney(fb['pricingAdjustmentAmount'] ?? fb['dynamicPricingAmount']);

        if (fb['pricingAdjustmentAmount'] === undefined && fb['serviceFare'] === undefined) {
            const visibleWithoutAdjustment = this.toMoney(
                baseFare + distanceFare + durationFare + extrasFare + minimumFareAdjustment - maximumFareAdjustment + platformFee
            );
            const legacyTotal = this.toMoney(visibleWithoutAdjustment + pricingAdjustment);
            if (Math.abs(legacyTotal - serviceFare) > 0.01) {
                pricingAdjustment = this.toMoney(serviceFare - visibleWithoutAdjustment);
            }
        }

        const rows: Array<{ label: string; amount: number; dotClass: string; amountClass: string }> = [];
        const push = (label: string, amount: number, dotClass: string, amountClass = 'text-slate-900') => {
            if (Math.abs(amount) >= 0.01) rows.push({ label, amount, dotClass, amountClass });
        };

        push('Base fare', baseFare, 'bg-slate-400');
        push('Distance', distanceFare, 'bg-blue-400');
        push('Time', durationFare, 'bg-sky-400');
        push('Service extras', extrasFare, 'bg-violet-400');
        push('Minimum fare adjustment', minimumFareAdjustment, 'bg-amber-400', 'text-amber-700');
        push('Price cap discount', -Math.abs(maximumFareAdjustment), 'bg-emerald-400', 'text-emerald-700');
        push(pricingAdjustment < 0 ? 'Marketplace discount' : 'Dynamic pricing increase', pricingAdjustment, 'bg-amber-400', pricingAdjustment < 0 ? 'text-emerald-700' : 'text-amber-700');
        push('Platform fee', platformFee, 'bg-purple-400');

        return rows;
    }

    dynamicMultiplier() {
        return (this.booking() as any)?.dynamic_pricing_multiplier || 1;
    }

    distanceKm() {
        const job = this.booking() as any;
        if (!job) return 0;
        return job.distance_km ?? job.estimated_distance_km ?? job.metadata?.distance_km ?? 0;
    }

    durationSeconds() {
        const job = this.booking() as any;
        if (!job) return null;
        return job.duration_seconds ?? job.estimated_duration ?? job.metadata?.duration_seconds ?? null;
    }

    latestNegotiation() {
        const list = this.negotiations();
        return list.length > 0 ? list[list.length - 1] : null;
    }

    formatPrice(amount: number | string | null | undefined): string {
        const value = Number(amount || 0);
        return this.config.formatCurrency(value);
    }

    toMoney(value: unknown): number {
        const n = Number(value);
        return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
    }

    setHybridOfferAmount(value: unknown): void {
        this.hybridOfferAmount.set(this.toMoney(value));
    }

    hybridOfferTotalPreview(): number {
        return this.toMoney(this.hybridOfferAmount()) + this.itemBudget();
    }

    formatDuration(seconds: number | null | undefined): string {
        if (!seconds) return '—';
        const mins = Math.round(seconds / 60);
        return `${mins} min`;
    }

    driverName(): string {
        const p = this.driverProfile();
        return p?.full_name || p?.first_name || 'Your driver';
    }

    driverRating(): string {
        const p = this.driverProfile();
        const rating = p?.rating || p?.average_rating || 0;
        return rating ? Number(rating).toFixed(1) : '—';
    }

    driverCompletedTrips(): number {
        const p = this.driverProfile();
        return p?.completed_trips || p?.completed_bookings || 0;
    }

    driverPhone(): string {
        return this.driverProfile()?.phone || this.driverProfile()?.phone_number || '';
    }

    driverVehicleLabel(): string {
        const v = this.driverVehicle();
        if (!v) return '';
        return [v.make, v.model, v.colour, v.color, v.license_plate, v.registration_number]
            .filter(Boolean)
            .join(' ')
            .trim();
    }

    driverEta(): string {
        const seconds = this.durationSeconds();
        if (seconds) return this.formatDuration(seconds);
        const km = this.distanceKm();
        if (km) return `${km.toFixed(1)} km`;
        return '—';
    }

    // Progress indicator methods
    progressSteps() {
        const job = this.booking();
        if (!job) return [];

        const steps = [
            { number: '1', label: 'Requested', status: 'requested', completed: true, active: false, isLast: false },
            { number: '2', label: 'Confirm Fare', status: 'negotiating', completed: false, active: false, isLast: false },
            { number: '3', label: 'Payment', status: 'fare_agreed', completed: false, active: false, isLast: false },
            { number: '4', label: 'Searching', status: 'searching', completed: false, active: false, isLast: false },
            { number: '5', label: 'Assigned', status: 'assigned', completed: false, active: false, isLast: true }
        ];

        const currentStepIndex = steps.findIndex(step => 
            step.status === job.status || 
            (job.status === 'pending_fare_confirmation' && step.status === 'negotiating') ||
            (job.status === 'fare_agreed' && step.status === 'fare_agreed')
        );

        steps.forEach((step, index) => {
            step.completed = index < currentStepIndex;
            step.active = index === currentStepIndex;
        });

        return steps;
    }

    // Countdown timer methods with performance optimizations
    private countdownUpdateTimer?: any;

    // ---------------------------------------------------------------------
    // Lease clock: canonical state must react when expires_at is REACHED.
    // Postgres Realtime generates no event for the passage of time, so the
    // client is responsible for re-deriving at local expiry (never by polling).
    // ---------------------------------------------------------------------

    /** Wall-clock tick fed into getNegotiationState(). */
    private negotiationClock = signal<number>(Date.now());
    private leaseTimer?: any;
    private leaseReconciledFor: string | null = null;

    private startLeaseTimer(): void {
        this.stopLeaseTimer();
        this.leaseTimer = setInterval(() => {
            this.negotiationClock.set(Date.now());

            const session = this.hybridSession();
            const expiresAt = String((session as any)?.expires_at ?? '').trim();
            if (!session || !expiresAt) return;

            const parsed = Date.parse(expiresAt);
            if (!Number.isFinite(parsed) || parsed > Date.now()) {
                this.leaseReconciledFor = null;
                return;
            }

            // Reconcile ONCE per lapsed lease (never a poll loop): the authoritative
            // reload reveals whether the server released the attempt to the market.
            const key = deadlineKey(session.id, expiresAt);
            if (!key || this.leaseReconciledFor === key) return;
            this.leaseReconciledFor = key;

            const jobId = this.booking()?.id || this.route.snapshot.paramMap.get('id') || '';
            const sessionStatus = String((session as any)?.status ?? '').toLowerCase();

            if (sessionStatus === 'fare_agreed') {
                // The PAYMENT window lapsed (expires_at mirrors payment_deadline).
                // Run the AUTHORITATIVE expiry transition exactly ONCE for this
                // deadline, then converge — instead of waiting for another Realtime
                // event, which wall-clock passage never produces.
                void this.hybridService.customerExpireUnpaidAgreement(session.id)
                    .catch((error) => console.warn('[MarketplaceFare] agreement expiry failed', error))
                    .finally(() => {
                        if (jobId) void this.reconcileHybridNegotiation(jobId);
                    });
                return;
            }

            if (jobId) void this.reconcileHybridNegotiation(jobId);
        }, 1000);
    }

    private stopLeaseTimer(): void {
        if (this.leaseTimer) {
            clearInterval(this.leaseTimer);
            this.leaseTimer = undefined;
        }
    }
    
    startCountdown() {
        this.stopCountdown();
        const job = this.booking();
        if (!job?.negotiation_deadline) return;

        // Update immediately, then set up throttled updates
        const updateCountdown = () => {
            const now = new Date().getTime();
            const deadline = new Date(job?.negotiation_deadline || '').getTime();
            const remaining = Math.max(0, deadline - now);
            
            this.countdown.set(remaining);
            
            if (remaining === 0) {
                this.stopCountdown();
            }
        };

        updateCountdown();
        
        // Use throttled updates (every 100ms instead of every second for smoother UX)
        this.countdownUpdateTimer = setInterval(updateCountdown, 100);
    }

    stopCountdown() {
        if (this.countdownUpdateTimer) {
            clearInterval(this.countdownUpdateTimer);
            this.countdownUpdateTimer = undefined;
        }
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = undefined;
        }
    }

    /** Shared zero-padded MM:SS for the AUTHORITATIVE payment countdown. */
    formatRemaining(ms: number): string {
        return formatDeadlineRemaining(ms);
    }

    formatCountdown(milliseconds: number): string {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    openCounterInput() {
        const fare = this.suggestedFare();
        if (fare === null) return;
        this.counterAmount.set(fare);
        this.showCounterInput.set(true);
        setTimeout(() => {
            if (this.ionContent) {
                this.ionContent.scrollToBottom(400);
            }
        }, 80);
    }

    async acceptSuggestedFare() {
        const job = this.booking();
        if (!job) {
            await this.showToast('Unable to load this booking. Please refresh and try again.', 'danger');
            return;
        }

        const fare = this.suggestedFare();
        if (fare === null) {
            // Never lock a fare that is not authoritative - and never do it silently.
            await this.showToast('We cannot confirm a fare for this request right now.', 'warning');
            return;
        }

        try {
            const loading = await this.loadingCtrl.create({ message: 'Locking fare...' });
            await loading.present();
            await this.negotiationService.lockAgreedFare(job.id, fare);
            await loading.dismiss();

            if (this.hybridEnabled) {
                await this.loadBooking(job.id);
                // In-place Stripe init is valid ONLY once an authoritative agreement
                // exists: driver_accept_customer_offer / customer_accept_driver_counter
                // are what move jobs.status to 'fare_agreed'. When the customer simply
                // accepts the authoritative SUGGESTED fare there is no agreement yet,
                // lockAgreedFare() is a deliberate no-op, the job stays
                // 'pending_fare_confirmation', and initializeStripe() returns at its
                // `status !== 'fare_agreed'` guard - so this button silently did
                // nothing. Fall through to the existing payment route in that case.
                if (this.booking()?.status === 'fare_agreed') {
                    await this.initializeStripe();
                    return;
                }
            }

            await this.router.navigate(['/customer/marketplace-payment', job.id]);
        } catch (error) {
            console.error('[MarketplaceFare] accept failed', error);
            await this.showToast('Unable to accept fare. Please check your connection and try again.', 'danger');
        }
    }

    openHybridOfferInput() {
        // CANONICAL GATE: the proposal form may open ONLY when canonical persisted
        // state permits THIS customer to propose — an initial offer (make_offer) or a
        // counter to a live driver counter (counter). After a lease expiry / release
        // / reassignment the retained offer is still authoritative ("finding another
        // driver"), so the form must NOT open and create_customer_offer must be
        // unreachable from the UI. Server authority remains as defence-in-depth.
        const state = this.negotiationState();
        if (!canCustomer(state, 'make_offer') && !canCustomer(state, 'counter')) {
            void this.showToast(
                state.awaitingNextDriver
                    ? 'Finding another driver for your offer.'
                    : 'Your offer is already awaiting a response.',
                'warning'
            );
            return;
        }

        const fare = this.suggestedFare();
        if (fare === null) return;
        this.hybridOfferAmount.set(this.toMoney(fare * 0.9));
        this.showHybridOfferInput.set(true);
        setTimeout(() => {
            const el = this.offerForm?.nativeElement;
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => this.offerAmountInput?.nativeElement?.focus(), 350);
                return;
            }

            void this.ionContent?.scrollToBottom(350);
        }, 0);
    }

    async submitHybridOffer() {
        const job = this.booking();
        const amount = this.hybridOfferAmount();
        if (!job || !amount || amount <= 0) {
            await this.showToast('Please enter a valid offer amount.', 'warning');
            return;
        }

        const suggestedFare = this.suggestedFare();
        if (suggestedFare === null) {
            await this.showToast('We cannot confirm a fare for this request right now.', 'warning');
            return;
        }

        if (this.negotiationBusy()) return;

        let loading: any = null;
        try {
            this.negotiationBusy.set(true);

            // TURN-AWARE DISPATCH from CANONICAL PERSISTED STATE (never a local flag).
            //
            // create_customer_offer is ONLY for the INITIAL customer proposal for a
            // job. Once a session exists and the canonical phase is the customer's
            // turn (a driver counter is live), the next proposal MUST use
            // customer_counter_offer. Calling create_customer_offer again is
            // correctly rejected by the server with
            // 'An offer is already awaiting a response for this request'.
            const session = this.hybridSession();
            const phase = this.negotiationState().phase;
            const isCustomerCounter = !!session && phase === 'customer_turn';

            if (session && !isCustomerCounter && phase !== 'not_started') {
                // waiting_for_driver / driver_turn / agreed_payment_required / paid /
                // cancelled / expired -> this screen may not open another proposal.
                await this.reconcileHybridNegotiation(job.id);
                await this.showToast(
                    phase === 'expired'
                        ? 'This negotiation has expired.'
                        : (phase === 'cancelled' || phase === 'paid' || phase === 'agreed_payment_required')
                            ? 'This negotiation has ended.'
                            : 'Your offer is already awaiting a response.',
                    'warning'
                );
                return;
            }

            loading = await this.loadingCtrl.create({ message: 'Sending offer...' });
            await loading.present();

            const updated = isCustomerCounter
                ? await this.hybridService.customerCounterOffer(session!.id, amount)
                : await this.hybridService.createCustomerOffer(job.id, amount);

            this.hybridSession.set(updated);
            this.showHybridOfferInput.set(false);
            // Always converge on authoritative persisted session + events.
            await this.reconcileHybridNegotiation(job.id);
            await this.showToast(
                isCustomerCounter
                    ? 'Counter offer sent.'
                    : 'Offer sent. Waiting for a driver to start negotiation.',
                'success'
            );
        } catch (error) {
            console.error('[MarketplaceFare] submit offer failed', error);
            await this.showToast('Unable to send offer. Please try again.', 'danger');
            // A controlled rejection is usually stale local state: reconcile authority.
            const jobId = this.booking()?.id;
            if (jobId) await this.reconcileHybridNegotiation(jobId);
        } finally {
            // GUARANTEED cleanup: a rejected RPC can never leave the
            // "Sending offer..." overlay on screen. Previously dismiss() ran only on
            // the success path, so a 400 left the modal up indefinitely.
            if (loading) {
                try { await loading.dismiss(); } catch { /* already dismissed */ }
            }
            this.negotiationBusy.set(false);
        }
    }

    // ---------------------------------------------------------------------
    // Scoped live convergence for THIS negotiation session.
    // ---------------------------------------------------------------------

    private hybridRealtimeDispose: (() => void) | null = null;
    private hybridRealtimeSessionId: string | null = null;
    /** Monotonic token: a stale async reload must never overwrite newer state. */
    private hybridReloadToken = 0;

    /**
     * Authoritative reload of the negotiation session + event ledger (and the
     * driver profile). Realtime callbacks request THIS; they never inject
     * optimistic state. A monotonic token discards a reload that a newer one
     * superseded while it was in flight.
     */
    private async reconcileHybridNegotiation(jobId: string): Promise<void> {
        const token = ++this.hybridReloadToken;
        try {
            const session = await this.hybridService.getSessionByJob(jobId);
            if (token !== this.hybridReloadToken) return;
            this.hybridSession.set(session);

            if (!session) return;

            const events = await this.hybridService.getSessionEvents(session.id);
            if (token !== this.hybridReloadToken) return;
            this.hybridEvents.set(events);
            await this.loadDriverProfile(session.active_driver_id);
            if (token !== this.hybridReloadToken) return;
            this.ensureHybridSubscription(session);
        } catch (error) {
            console.warn('[MarketplaceFare] negotiation reconcile failed', error);
        }
    }

    /**
     * Establish (or RE-establish) the ONE scoped subscription for this session.
     * Idempotent per session id, so re-entry and every successful mutation cannot
     * accumulate duplicate channels.
     */
    private ensureHybridSubscription(session: { id?: string | null } | null | undefined): void {
        const sessionId = String(session?.id ?? '').trim();
        if (!sessionId) return;
        if (this.hybridRealtimeSessionId === sessionId && this.hybridRealtimeDispose) return;

        this.disposeHybridSubscription();
        this.hybridRealtimeSessionId = sessionId;

        const jobId = this.booking()?.id || this.route.snapshot.paramMap.get('id') || '';
        this.hybridRealtimeDispose = this.hybridService.subscribeToNegotiation(sessionId, () => {
            if (jobId) void this.reconcileHybridNegotiation(jobId);
        });
    }

    private disposeHybridSubscription(): void {
        try { this.hybridRealtimeDispose?.(); } catch { /* already disposed */ }
        this.hybridRealtimeDispose = null;
        this.hybridRealtimeSessionId = null;
    }

    async acceptDriverCounter() {
        const session = this.hybridSession();
        if (!session) return;
        try {
            this.negotiationBusy.set(true);
            const updated = await this.hybridService.acceptDriverCounter(session.id);
            this.hybridSession.set(updated);
            await this.loadBooking(session.job_id);
            await this.initializeStripe();
            await this.showToast('Fare agreed! Pay to confirm.', 'success');
        } catch (error) {
            console.error('[MarketplaceFare] accept counter failed', error);
            await this.showToast('Unable to accept. Please try again.', 'danger');
        } finally {
            this.negotiationBusy.set(false);
        }
    }

    async counterDriverOffer() {
        const session = this.hybridSession();
        const amount = this.hybridOfferAmount();
        if (!session || !amount || amount <= 0) return;
        try {
            this.negotiationBusy.set(true);
            const updated = await this.hybridService.customerCounterOffer(session.id, amount);
            this.hybridSession.set(updated);
            await this.showToast('Counter offer sent.', 'success');
        } catch (error) {
            console.error('[MarketplaceFare] counter failed', error);
            await this.showToast('Unable to send counter. Please try again.', 'danger');
        } finally {
            this.negotiationBusy.set(false);
        }
    }

    async tryAnotherDriver() {
        const session = this.hybridSession();
        if (!session) return;
        try {
            this.negotiationBusy.set(true);
            // CUSTOMER-AUTHORITATIVE transition. `release_marketplace_negotiation` is
            // DRIVER-owned and the server correctly rejects it for a customer
            // ("You can only release your own negotiation session").
            // customer_decline_counter IS this action: verify customer ownership,
            // release the active driver, clear the stale driver counter, RETAIN the
            // customer offer, increment attempt_count and return the request to the
            // eligible-driver pool.
            const updated = await this.hybridService.customerDeclineCounter(session.id);
            this.hybridSession.set(updated);
            await this.reconcileHybridNegotiation(session.job_id);
            await this.showToast('Looking for another driver.', 'success');
        } catch (error) {
            console.error('[MarketplaceFare] try another driver failed', error);
            if (session.job_id) await this.reconcileHybridNegotiation(session.job_id);
            await this.showToast('Unable to switch driver. Please try again.', 'danger');
        } finally {
            this.negotiationBusy.set(false);
        }
    }

    async cancelHybridRequest() {
        const session = this.hybridSession();
        if (!session) return;
        if (this.negotiationBusy()) return;

        // CANONICAL GUARD: never invoke a withdrawal RPC the current phase does
        // not permit (that produced the repeated 400 'Negotiation can no longer be
        // cancelled' while the request was already agreed/terminal).
        const state = this.negotiationState();
        if (!canCustomer(state, 'cancel_offer')) {
            if (session.job_id) await this.reconcileHybridNegotiation(session.job_id);
            await this.showToast('This request can no longer be cancelled here.', 'warning');
            return;
        }

        const expiredAgreement = state.paymentExpired === true;

        try {
            this.negotiationBusy.set(true);
            // PHASE-AWARE AUTHORITY: a lapsed UNPAID agreement goes through the
            // expiry transition ("find another driver" / recycle the SAME request);
            // every other cancellable phase is a genuine customer withdrawal.
            await (expiredAgreement
                ? this.hybridService.customerExpireUnpaidAgreement(session.id)
                : this.hybridService.customerCancelOffer(session.id));

            if (expiredAgreement) {
                await this.showToast('Payment time expired. Finding another driver.', 'success');
                await this.reconcileHybridNegotiation(session.job_id);
                return;
            }

            await this.showToast('Request cancelled.', 'success');
            await this.router.navigate(['/customer']);
        } catch (error) {
            console.error('[MarketplaceFare] cancel failed', error);
            // A state-conflict rejection means our view was stale: reconcile
            // authoritative state instead of leaving stale controls actionable.
            if (session.job_id) await this.reconcileHybridNegotiation(session.job_id);
            await this.showToast(
                expiredAgreement
                    ? 'This agreement has already changed. Refreshed.'
                    : 'Unable to cancel. Please try again.',
                'danger'
            );
        } finally {
            this.negotiationBusy.set(false);
        }
    }

    async acceptOffer(offer: FareNegotiation) {
        try {
            await this.negotiationService.acceptNegotiation(offer.id);
            const job = this.booking();
            if (job) {
                this.booking.set({
                    ...job,
                    agreed_fare: Number(offer.amount),
                    status: 'fare_agreed'
                } as Booking);
                await this.loadBooking(job.id);
                setTimeout(() => void this.initializeStripe(), 80);
            }
        } catch (error) {
            console.error('[MarketplaceFare] accept offer failed', error);
            await this.showToast('Unable to accept driver offer. Please try again.', 'danger');
        }
    }

    async submitCounterOffer() {
        const job = this.booking();
        const amount = this.counterAmount();
        if (!job || !amount || amount <= 0) {
            await this.showToast('Please enter a valid counter offer amount.', 'warning');
            return;
        }

        try {
            const latest = this.latestNegotiation();
            await this.negotiationService.createNegotiation({
                jobId: job.id,
                amount,
                message: 'Customer counter offer',
                proposedByRole: 'customer',
                counterToNegotiationId: latest?.id || null
            });
            const now = new Date().toISOString();
            this.booking.set({
                ...job,
                status: 'negotiating',
                negotiated_fare: amount,
                negotiation_deadline: new Date(Date.now() + 120000).toISOString(),
                updated_at: now
            } as Booking);
            this.negotiations.update((list) => [
                ...list,
                {
                    id: `local-${now}`,
                    job_id: job.id,
                    proposed_by: this.auth.currentUser()?.id || '',
                    proposed_by_role: 'customer',
                    amount,
                    message: 'Customer counter offer',
                    status: 'pending',
                    counter_to_negotiation_id: latest?.id || null,
                    round_number: (latest?.round_number || 1) + 1,
                    created_at: now,
                    updated_at: now
                } as FareNegotiation
            ]);
            this.showCounterInput.set(false);
            await this.showToast('Offer sent. Waiting for drivers to accept or counter.', 'success');
            await this.loadBooking(job.id);
            await this.loadNegotiations(job.id);
        } catch (error) {
            console.error('[MarketplaceFare] counter offer failed', error);
            await this.showToast('Unable to send counter offer. Please check your connection and try again.', 'danger');
        }
    }

    async continueToPayment() {
        const job = this.booking();
        if (!job) return;
        await this.router.navigate(['/customer/marketplace-payment', job.id]);
    }

    async payWithCard() {
        const job = this.booking();
        if (!job || !this.card || !this.cardReady()) return;

        if (this.isPaymentHandled(job)) {
            await this.router.navigate(['/customer/tracking', job.id], { replaceUrl: true });
            return;
        }

        this.paymentProcessing.set(true);
        this.paymentError.set(null);

        const loading = await this.loadingCtrl.create({
            message: 'Creating secure payment...'
        });

        try {
            await loading.present();
            const { clientSecret, paymentIntentId, status: intentStatus } = await this.paymentService.createPaymentIntent(
                job.id,
                this.paymentTotal(),
                job.currency_code || 'GBP',
                this.auth.tenantId() || '',
                1
            );

            let finalPaymentIntentId = paymentIntentId || '';
            let finalPaymentIntentStatus = intentStatus;

            if (intentStatus !== 'requires_capture' && intentStatus !== 'succeeded') {
                if (!this.cardComplete()) {
                    this.paymentError.set('Please complete your card details.');
                    await this.showToast('Please complete your card details.', 'danger');
                    try { await loading.dismiss(); } catch { /* noop */ }
                    return;
                }

                loading.message = 'Confirming payment...';
                const paymentIntent = await this.paymentService.confirmPayment(clientSecret, this.card);
                finalPaymentIntentId = paymentIntent.id;
                finalPaymentIntentStatus = paymentIntent.status;
            }

            if (finalPaymentIntentStatus === 'succeeded' || finalPaymentIntentStatus === 'requires_capture') {
                loading.message = 'Finding your driver...';
                await this.bookingService.confirmJobPayment(job.id, finalPaymentIntentId);
                await loading.dismiss();
                await this.showToast('Payment successful! Finding your driver...', 'success');
                await this.router.navigate(['/customer/tracking', job.id], { replaceUrl: true });
                return;
            }

            throw new Error(`Payment not completed (status: ${finalPaymentIntentStatus})`);
        } catch (error: any) {
            console.error('[MarketplaceFare] card payment failed', error);
            this.paymentError.set(error.message || 'Card payment failed. Please try again.');
            await this.showToast('Payment failed. Please try again.', 'danger');
            try { await loading.dismiss(); } catch { /* noop */ }
        } finally {
            this.paymentProcessing.set(false);
        }
    }

    private async loadBooking(id: string) {
        try {
            const job = await this.bookingService.getBooking(id);
            this.booking.set(job);
            await this.loadEffectiveHybridStatus();
        } catch (error) {
            console.error('[MarketplaceFare] load booking failed', error);
            await this.showToast('Unable to load booking details. Please refresh the page.', 'danger');
        }
    }

    private async loadEffectiveHybridStatus(): Promise<void> {
        const serviceSlug = this.booking()?.service_slug;
        if (!serviceSlug) {
            this.effectiveHybridStatus.set(null);
            return;
        }

        try {
            this.effectiveHybridStatus.set(await this.marketplaceConfig.getEffectiveHybridStatus(serviceSlug));
        } catch (error) {
            console.warn('[MarketplaceFare] effective hybrid status unavailable', error);
            this.effectiveHybridStatus.set(null);
        }
    }

    private async loadHybridSession(jobId: string): Promise<void> {
        try {
            const session = await this.hybridService.getSessionByJob(jobId);
            this.hybridSession.set(session);
            if (session) {
                const events = await this.hybridService.getSessionEvents(session.id);
                this.hybridEvents.set(events);
                await this.loadDriverProfile(session.active_driver_id);
            }
        } catch (error) {
            console.warn('[MarketplaceFare] hybrid session not loaded', error);
        }
    }

    private async loadDriverProfile(driverId: string | null | undefined): Promise<void> {
        if (!driverId) {
            this.driverProfile.set(null);
            this.driverVehicle.set(null);
            return;
        }

        try {
            const profile = await this.profileService.fetchDriverProfile(driverId);
            this.driverProfile.set(profile);
            const vehicles = (profile as any)?.vehicles;
            this.driverVehicle.set(Array.isArray(vehicles) ? vehicles[0] : (vehicles || null));
        } catch (error) {
            console.warn('[MarketplaceFare] driver profile load failed', error);
        }
    }

    /**
     * Enter-time convergence for THIS job.
     *
     * Always performs ONE authoritative reconcile, and establishes the scoped
     * subscription from the reconciled session. This also works when NO session
     * exists at page entry (the request is created on this very page): the previous
     * implementation returned early when `getSessionByJob` was null and therefore
     * never subscribed at all — which is exactly why a driver's counter only became
     * visible after leaving and re-entering the screen.
     */
    private subscribeToHybridSession(jobId: string): void {
        void this.reconcileHybridNegotiation(jobId);
    }

    private isPaymentHandled(job: Booking | null | undefined): boolean {
        if (!job) return false;
        return [
            'paid_ready_for_dispatch',
            'active',
            'completed',
            'cancelled'
        ].includes(this.bookingService.getBookingLifecycleState(job));
    }

    /**
     * Fail-closed terminal guard. A persisted job that is already terminal
     * (cancelled / expired / no_driver_found / settled / completed) must never be
     * treated as an actionable fare. The authoritative persisted job wins over any
     * stale quote, session, Activity-card, or browser-history state.
     */
    get isTerminalBooking(): boolean {
        const job = this.booking();
        if (!job) return false;
        const status = String(job.status || '').toLowerCase();
        const expiredAt = String((job as any)?.expired_at || '').trim();
        if (expiredAt || status === 'expired') return true;
        return ['cancelled', 'no_driver_found', 'settled', 'completed'].includes(status);
    }

    private async initializeStripe() {
        if (this.cardMounted || this.stripeInitializing) return;
        if (!this.cardElementHost?.nativeElement) return;
        if (this.booking()?.status !== 'fare_agreed') return;

        this.stripeInitializing = true;
        this.cardReady.set(false);
        this.cardComplete.set(false);
        this.cardError.set(null);

        try {
            const stripe = await this.paymentService.getStripe();
            if (!stripe) {
                this.cardError.set('Payment service is unavailable right now.');
                return;
            }

            if (!this.card) {
                const elements = stripe.elements();
                this.card = elements.create('card', {
                    hidePostalCode: true,
                    style: {
                        base: {
                            fontSize: '16px',
                            color: '#0f172a',
                            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
                            lineHeight: '24px',
                            '::placeholder': { color: '#94a3b8' }
                        },
                        invalid: { color: '#ef4444', iconColor: '#ef4444' }
                    }
                });

                this.card.on('ready', () => {
                    this.cardReady.set(true);
                    this.cardError.set(null);
                });

                this.card.on('change', (event: any) => {
                    this.cardError.set(event.error?.message ?? null);
                    this.cardComplete.set(!!event.complete && !event.error);
                });
            }

            this.card.mount(this.cardElementHost.nativeElement);
            this.cardMounted = true;
        } catch (error) {
            console.error('[MarketplaceFare] Stripe init failed', error);
            this.paymentError.set('Unable to load card input right now.');
            this.cardReady.set(false);
            this.cardMounted = false;
        } finally {
            this.stripeInitializing = false;
        }
    }

    private async loadNegotiations(jobId: string): Promise<void> {
        try {
            const negotiations = await this.negotiationService.getNegotiations(jobId);
            this.negotiations.set(negotiations);
        } catch (error) {
            console.error('[MarketplaceFare] load negotiations failed', error);
        }
    }

    private async playStatusTone(): Promise<void> {
        if (Capacitor.isNativePlatform()) return;

        const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextCtor) return;

        const ctx = new AudioContextCtor();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = 880;
        gain.gain.value = 0.035;
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.14);
        setTimeout(() => void ctx.close().catch(() => undefined), 260);
    }

    private subscribeToJob(id: string) {
        this.jobChannel = this.supabase
            .channel(`marketplace-fare-${id}`)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'jobs',
                filter: `id=eq.${id}`
            }, payload => {
                const current = this.booking();
                if (current) {
                    this.booking.set({ ...current, ...payload.new } as Booking);
                }
            })
            .subscribe();
    }

    private subscribeToNegotiations(jobId: string) {
        this.negotiationChannel = this.supabase
            .channel(`marketplace-fare-negotiations-${jobId}`)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'fare_negotiations',
                filter: `job_id=eq.${jobId}`
            }, async (payload: any) => {
                const current = this.booking();
                if (!current) return;

                await this.loadNegotiations(jobId);

                const newest = payload.new as FareNegotiation | undefined;
                const oldStatus = payload.old?.status;

                if (newest?.status === 'pending' && newest.proposed_by_role === 'driver' && oldStatus !== 'pending') {
                    this.showToast('A driver has sent a counter offer. Review it below to accept or make another offer.', 'warning');
                    this.playStatusTone();
                } else if (newest?.status === 'accepted') {
                    this.showToast('Fantastic! A driver accepted your offer. Continue to payment to confirm your booking.', 'success');
                    this.playStatusTone();
                    await this.loadBooking(jobId);
                }
            })
            .subscribe();
    }

    private async showToast(message: string, color: 'success' | 'warning' | 'danger' = 'success') {
        try {
            const toast = await this.toastCtrl.create({ message, duration: 3000, position: 'top', color });
            await toast.present();
        } catch (error) {
            console.warn('[MarketplaceFare] toast failed', error);
        }
    }
}
