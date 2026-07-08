import {
    Component,
    inject,
    OnInit,
    signal,
    OnDestroy,
    effect,
    ElementRef,
    ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule, IonContent, ToastController } from '@ionic/angular';
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
import { Booking } from '../../../../../shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';

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
                      <p class="text-lg font-display font-bold text-slate-900">{{ formatPrice(suggestedFare()) }}</p>
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
                    <p class="text-4xl font-display font-black text-slate-900">{{ formatPrice(suggestedFare()) }}</p>
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
                <span>View fare breakdown</span>
                <ion-icon [name]="showBreakdown() ? 'chevron-up-outline' : 'chevron-down-outline'" class="text-base text-amber-500"></ion-icon>
              </button>

              <!-- Expanded breakdown -->
              @if (showBreakdown() && fareBreakdown()) {
                <div class="mt-3 bg-white/70 rounded-2xl border border-amber-100/60 p-4 space-y-2.5">
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
                  <div class="pt-2 border-t border-amber-100/60 flex justify-between items-center">
                    <span class="text-sm font-bold text-slate-700">Total service fare</span>
                    <span class="text-base font-bold text-slate-900">{{ formatPrice(suggestedFare()) }}</span>
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

          <!-- ── LATEST NEGOTIATION CARD ── -->
          @if (latestNegotiation(); as offer) {
            <div class="bg-white rounded-3xl border border-slate-200 shadow-md p-5 mb-4">
              <div class="flex items-center justify-between mb-3">
                <p class="text-xs font-bold text-slate-500 uppercase tracking-wider">
                  {{ offer.proposed_by_role === 'driver' ? 'Driver Offer' : 'Your Offer' }}
                </p>
                <div class="flex items-center gap-1">
                  <ion-icon name="person-outline" class="text-sm text-slate-400"></ion-icon>
                  <span class="text-xs text-slate-500">{{ offer.proposed_by_role === 'driver' ? 'Driver' : 'You' }}</span>
                </div>
              </div>
              <p class="text-3xl font-display font-black text-slate-900 mb-2">{{ formatPrice(offer.amount) }}</p>
              @if (offer.message) {
                <div class="bg-slate-50 rounded-xl p-3 mb-4">
                  <p class="text-sm text-slate-600 italic">"{{ offer.message }}"</p>
                </div>
              }
              @if (offer.proposed_by_role === 'driver' && offer.status === 'pending') {
                <div class="flex gap-3 mt-3">
                  <button
                    type="button"
                    (click)="acceptOffer(offer)"
                    class="flex-1 py-3 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl font-bold text-sm active:scale-95 transition-all shadow flex items-center justify-center gap-2"
                  >
                    <ion-icon name="checkmark-circle-outline"></ion-icon>
                    Accept Offer
                  </button>
                  <button
                    type="button"
                    (click)="openCounterInput()"
                    class="flex-1 py-3 bg-white border-2 border-slate-200 text-slate-700 rounded-2xl font-bold text-sm active:scale-95 transition-all flex items-center justify-center gap-2"
                  >
                    <ion-icon name="cash-outline"></ion-icon>
                    Challenge Price
                  </button>
                </div>
              }
            </div>
          }

          <!-- ── PRIMARY ACTION BUTTONS (negotiating / pending_fare_confirmation) ── -->
          @if (job.status === 'negotiating' || job.status === 'pending_fare_confirmation') {
            <div class="space-y-3 mb-4">
              <!-- Accept -->
              <button
                type="button"
                (click)="acceptSuggestedFare()"
                class="w-full py-4 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-3xl font-black text-lg active:scale-95 transition-all shadow-lg flex items-center justify-center gap-3"
              >
                <ion-icon name="checkmark-circle-outline" class="text-xl"></ion-icon>
                Accept Suggested Fare
              </button>

              <!-- Challenge – always a real button, never just text -->
              <button
                type="button"
                (click)="openCounterInput()"
                class="w-full py-4 bg-gradient-to-r from-amber-400 to-orange-400 text-white rounded-3xl font-black text-lg active:scale-95 transition-all shadow-md flex items-center justify-center gap-3"
              >
                <ion-icon name="cash-outline" class="text-xl"></ion-icon>
                Make an Offer / Challenge Price
              </button>

              @if (isErrand()) {
                <p class="text-xs text-center text-slate-400 px-4">You can suggest a different service fare. Your shopping budget stays reserved separately.</p>
              }
            </div>
          }

          <!-- ── COUNTER OFFER INPUT (appears below action buttons) ── -->
          @if (showCounterInput()) {
            <div #counterInputSection class="bg-gradient-to-br from-amber-50 to-orange-50 rounded-3xl border border-amber-200 shadow-md p-5 mb-4">
              <div class="flex items-center gap-2 mb-1">
                <ion-icon name="cash-outline" class="text-amber-600 text-lg"></ion-icon>
                <p class="text-sm font-bold text-amber-800">Your Service Fare Offer</p>
              </div>
              @if (isErrand()) {
                <p class="text-xs text-amber-600 mb-3">This offer applies to the service fare only. Shopping budget ({{ formatPrice(itemBudget()) }}) stays reserved.</p>
              }
              <div class="relative mb-4">
                <span class="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-bold text-amber-600">£</span>
                <input
                  type="number"
                  [ngModel]="counterAmount()"
                  (ngModelChange)="counterAmount.set(+$event)"
                  class="w-full rounded-2xl border-2 border-amber-200 pl-10 pr-4 py-4 text-xl font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition-all"
                  placeholder="Enter service fare amount"
                  inputmode="decimal"
                />
              </div>
              @if (isErrand() && counterAmount() > 0) {
                <div class="bg-white/70 rounded-xl px-3 py-2 mb-4 border border-amber-100 flex justify-between items-center">
                  <span class="text-xs text-slate-500">Total authorisation after agreement</span>
                  <span class="text-sm font-bold text-slate-900">{{ formatPrice(counterAmount() + itemBudget()) }}</span>
                </div>
              }
              <div class="flex gap-3">
                <button
                  type="button"
                  (click)="submitCounterOffer()"
                  class="flex-1 py-4 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-2xl font-bold text-base active:scale-95 transition-all shadow-lg flex items-center justify-center gap-2"
                >
                  <ion-icon name="send-outline"></ion-icon>
                  Send Offer
                </button>
                <button
                  type="button"
                  (click)="showCounterInput.set(false)"
                  class="py-4 px-5 bg-white border-2 border-slate-200 text-slate-700 rounded-2xl font-bold text-base active:scale-95 transition-all flex items-center justify-center gap-2"
                >
                  <ion-icon name="close-outline"></ion-icon>
                </button>
              </div>
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
                <p class="text-emerald-700 mb-4">Your fare is locked in. Continue to payment to confirm your booking.</p>
                <div class="bg-white/70 rounded-2xl p-4 mb-5 border border-emerald-100 space-y-2 text-left">
                  @if (isErrand()) {
                    <div class="flex justify-between items-center">
                      <span class="text-sm text-emerald-600">Shopping Budget Reserved</span>
                      <span class="font-semibold text-emerald-900">{{ formatPrice(itemBudget()) }}</span>
                    </div>
                  }
                  <div class="flex justify-between items-center">
                    <span class="text-sm text-emerald-600">{{ isErrand() ? 'Service Fare' : 'Agreed Fare' }}</span>
                    <span class="font-semibold text-emerald-900">{{ formatPrice(job.agreed_fare || suggestedFare()) }}</span>
                  </div>
                  <div class="h-px bg-emerald-100"></div>
                  <div class="flex justify-between items-center">
                    <span class="text-sm font-bold text-emerald-800">{{ isErrand() ? 'Total Authorisation' : 'Total to Pay' }}</span>
                    <span class="text-2xl font-black text-emerald-900">{{ formatPrice(paymentTotal()) }}</span>
                  </div>
                </div>
                <button
                  type="button"
                  (click)="continueToPayment()"
                  class="w-full py-4 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl font-bold text-base active:scale-95 transition-all shadow-lg flex items-center justify-center gap-2"
                >
                  <ion-icon name="card-outline"></ion-icon>
                  Continue to Payment
                </button>
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
export class MarketplaceFarePage implements OnInit, OnDestroy {
    private route = inject(ActivatedRoute);
    private router = inject(Router);
    private supabase = inject(SupabaseService);
    private config = inject(AppConfigService);
    private bookingService = inject(BookingService);
    private negotiationService = inject(MarketplaceNegotiationService);
    private toastCtrl = inject(ToastController);

    @ViewChild('ionContent') ionContent?: IonContent;
    @ViewChild('counterInputSection') counterInputSection?: ElementRef;

    booking = signal<Booking | null>(null);
    negotiations = signal<FareNegotiation[]>([]);
    counterAmount = signal<number>(0);
    showCounterInput = signal(false);
    showBreakdown = signal(false);
    countdown = signal<number>(0);
    private jobChannel?: RealtimeChannel;
    private negotiationChannel?: RealtimeChannel;
    private countdownInterval?: any;

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
        this.subscribeToJob(id);
        this.subscribeToNegotiations(id);
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
        this.stopCountdown();
        
        // Clear signals to free memory
        this.booking.set(null);
        this.negotiations.set([]);
        this.counterAmount.set(0);
        this.showCounterInput.set(false);
        this.showBreakdown.set(false);
        this.countdown.set(0);
    }

    isErrand(): boolean {
        return String(this.booking()?.service_slug || '').toLowerCase() === 'errand';
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

    suggestedFare() {
        const job = this.booking();
        return job?.agreed_fare || job?.negotiated_fare || job?.total_price || 0;
    }

    paymentTotal(): number {
        return Number(this.suggestedFare()) + this.itemBudget();
    }

    fareBreakdown() {
        return (this.booking() as any)?.fare_breakdown || null;
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

    formatDuration(seconds: number | null | undefined): string {
        if (!seconds) return '—';
        const mins = Math.round(seconds / 60);
        return `${mins} min`;
    }

    // Progress indicator methods
    progressSteps() {
        const job = this.booking();
        if (!job) return [];

        const steps = [
            { number: '1', label: 'Requested', status: 'requested', completed: true, active: false, isLast: false },
            { number: '2', label: 'Negotiating', status: 'negotiating', completed: false, active: false, isLast: false },
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

    formatCountdown(milliseconds: number): string {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    openCounterInput() {
        this.counterAmount.set(this.suggestedFare());
        this.showCounterInput.set(true);
        setTimeout(() => {
            if (this.ionContent) {
                this.ionContent.scrollToBottom(400);
            }
        }, 80);
    }

    async acceptSuggestedFare() {
        const job = this.booking();
        if (!job) return;

        try {
            await this.negotiationService.lockAgreedFare(job.id, this.suggestedFare());
            await this.continueToPayment();
        } catch (error) {
            console.error('[MarketplaceFare] accept failed', error);
            await this.showToast('Unable to accept fare. Please check your connection and try again.', 'danger');
        }
    }

    async acceptOffer(offer: FareNegotiation) {
        try {
            await this.negotiationService.acceptNegotiation(offer.id);
            await this.continueToPayment();
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
            this.showCounterInput.set(false);
            await this.showToast('Your counter offer has been sent to nearby drivers. You\'ll be notified if they accept.', 'success');
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

    private async loadBooking(id: string) {
        try {
            const job = await this.bookingService.getBooking(id);
            this.booking.set(job);
            await this.loadNegotiations(id);
            this.startCountdown();
        } catch (error) {
            console.error('[MarketplaceFare] load booking failed', error);
            await this.showToast('Unable to load booking details. Please refresh the page.', 'danger');
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
