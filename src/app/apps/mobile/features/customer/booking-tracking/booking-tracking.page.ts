import {
    Component,
    inject,
    OnInit,
    OnDestroy,
    signal,
    ViewChild,
    computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, AlertController } from '@ionic/angular';
import { ActivatedRoute, Router } from '@angular/router';
import { addIcons } from 'ionicons';

import {
    chevronBackOutline,
    call,
    chevronDown,
    chatbubbles,
    alertCircleOutline,
    navigate,
    shieldCheckmark,
    informationCircle,
    receiptOutline,
    timeOutline,
    sparklesOutline,
    carSportOutline,
    refreshOutline,
    closeCircleOutline,
    timerOutline,
    checkmarkCircleOutline,
    searchOutline,
    basketOutline,
    navigateOutline,
    shieldCheckmarkOutline,
    cubeOutline,
    locationOutline,
    archiveOutline,
    flagOutline,
    storefrontOutline,
    homeOutline
} from 'ionicons/icons';

import { RealtimeChannel } from '@supabase/supabase-js';

import { BookingService } from '../../../../../core/services/booking/booking.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { WalletService } from '../../../../../core/services/wallet/wallet.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';

import {
    Booking,
    ServiceTypeEnum,
    DriverLocation,
    ErrandFunding,
    Vehicle
} from '../../../../../shared/models/booking.model';

import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';

import {
    ButtonComponent,
    BadgeComponent
} from '../../../../../shared/ui';

import { CommunicationPanelComponent } from '../../../../../shared/ui/communication-panel';
import { MapComponent } from '../../../../../shared/components/map/map.component';

const DRIVER_SEARCH_WINDOW_SECONDS = 300;

@Component({
    selector: 'app-booking-tracking',
    standalone: true,
    imports: [
        CommonModule,
        IonicModule,
        ButtonComponent,
        BadgeComponent,
        CommunicationPanelComponent,
        MapComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">{{ trackingTitle() }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      @if (booking()) {
        <div class="flex flex-col h-full">
          <div class="bg-slate-100 relative overflow-hidden h-[64vh] min-h-[430px]">
            <app-map #map></app-map>

            @if (booking()?.status === 'searching') {
              <div class="absolute left-3 top-3 z-20 w-[calc(100%_-_5.5rem)] max-w-[20rem] pointer-events-none">
                <div class="bg-white/95 backdrop-blur border border-white/70 rounded-xl shadow-xl shadow-slate-900/12 p-2.5 pointer-events-auto">
                  <div class="flex items-center gap-3">
                    <div class="w-11 h-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shrink-0">
                    <ion-spinner name="crescent" color="primary"></ion-spinner>
                    </div>

                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                          <h2 class="text-sm font-display font-black text-slate-950 truncate">Finding your driver</h2>
                          <p class="text-[11px] text-slate-500 font-semibold truncate">Contacting nearby drivers</p>
                        </div>
                        <span class="text-sm font-display font-black text-blue-700 shrink-0">
                          {{ searchCountdownLabel() }}
                        </span>
                      </div>

                      <div class="mt-2 w-full h-1.5 bg-blue-100 rounded-full overflow-hidden">
                        <div
                          class="h-full bg-blue-600 rounded-full transition-all duration-1000"
                          [style.width.%]="searchProgressPercent()"
                        ></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            }

            @if (booking()?.driver_id && driverLiveLabel()) {
              <div class="absolute left-3 bottom-3 z-20 w-[calc(100%_-_5.5rem)] max-w-[19rem] pointer-events-none">
                <div class="bg-white/94 backdrop-blur rounded-xl border border-white/70 shadow-xl shadow-slate-900/12 p-2.5 pointer-events-auto">
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <div class="w-9 h-9 rounded-xl bg-blue-50 border border-blue-100 text-blue-600 flex items-center justify-center shrink-0 overflow-hidden">
                        @if (getDriverAvatar()) {
                          <img [src]="getDriverAvatar()!" alt="Driver photo" class="w-full h-full object-cover" />
                        } @else {
                          <ion-icon name="car-sport-outline" class="text-xl"></ion-icon>
                        }
                      </div>

                      <div class="min-w-0">
                        <p class="text-[11px] text-slate-500 font-semibold">{{ driverLiveLabel() }}</p>
                        <h3 class="text-sm font-display font-black text-slate-950 truncate">{{ getDriverName() }}</h3>
                        <p class="text-[11px] text-slate-500 font-semibold leading-snug truncate">{{ driverLiveSubtext() }}</p>
                      </div>
                    </div>

                    <app-badge variant="success" class="shrink-0">{{ driverLastSeenLabel() }}</app-badge>
                  </div>
                </div>
              </div>
            }
          </div>

          <div
            class="bg-white rounded-t-[2rem] shadow-2xl p-4 space-y-4 -mt-8 relative z-10 overflow-y-auto border-t border-slate-100 transition-all duration-300"
            [ngClass]="detailsExpanded() ? 'h-[78vh]' : 'h-[34vh]'"
          >
            <button
              type="button"
              class="w-full flex items-center justify-center py-1"
              (click)="detailsExpanded.set(!detailsExpanded())"
              [attr.aria-label]="detailsExpanded() ? 'Collapse details' : 'Expand details'"
            >
              <span class="w-12 h-1 bg-slate-200 rounded-full"></span>
            </button>

            <div class="p-5 rounded-[2rem] border border-slate-100 bg-gradient-to-br from-white to-slate-50 shadow-sm">
              <div class="flex justify-between items-start gap-4">
                <div class="min-w-0">
                  <app-badge [variant]="getStatusVariant(booking()?.status || '')" class="mb-3">
                    {{ getStatusLabel(booking()?.status || '') }}
                  </app-badge>

                  <h2 class="text-2xl font-display font-bold text-slate-900 tracking-tight">
                    Booking Details
                  </h2>

                  <p class="text-xs font-semibold text-slate-500 mt-1">
                    {{ getStatusHint(booking()?.status || '') }}
                  </p>

                  <p class="text-[11px] font-semibold text-slate-400 mt-2">
                    ID: {{ booking()?.id?.slice(0, 8) }}
                  </p>
                </div>

                <div class="text-right shrink-0">
                  <p class="text-3xl font-display font-bold text-slate-900">
                    {{ getDisplayedTotal() }}
                  </p>
                  <p class="text-[11px] font-semibold text-emerald-700 mt-1">
                    {{ paymentAmountLabel() }}
                  </p>
                </div>
              </div>

              @if (booking()?.status === 'searching') {
                <div class="mt-5 grid grid-cols-2 gap-3">
                  <div class="p-4 rounded-2xl bg-blue-50 border border-blue-100">
                    <div class="flex items-center gap-2 mb-1">
                      <ion-icon name="timer-outline" class="text-blue-600"></ion-icon>
                      <p class="text-xs font-semibold text-blue-700">Time left</p>
                    </div>
                    <p class="text-lg font-display font-bold text-slate-900">
                      {{ searchCountdownLabel() }}
                    </p>
                  </div>

                  <div class="p-4 rounded-2xl bg-slate-50 border border-slate-100">
                    <div class="flex items-center gap-2 mb-1">
                      <ion-icon name="refresh-outline" class="text-slate-500"></ion-icon>
                      <p class="text-xs font-semibold text-slate-500">Search status</p>
                    </div>
                    <p class="text-sm font-bold text-slate-900">Looking nearby</p>
                  </div>
                </div>
              }
            </div>

            <div class="p-5 rounded-[2rem] border border-slate-100 bg-white shadow-sm space-y-4">
              <div class="flex items-start gap-3">
                <div class="w-11 h-11 rounded-2xl bg-amber-50 text-amber-600 border border-amber-100 flex items-center justify-center shrink-0">
                  <ion-icon [name]="serviceGuideIcon()" class="text-xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <p class="text-[10px] font-black uppercase tracking-widest text-amber-600">
                    {{ serviceGuideEyebrow() }}
                  </p>
                  <h3 class="mt-1 text-lg font-display font-black text-slate-950">
                    {{ serviceGuideTitle() }}
                  </h3>
                  <p class="mt-2 text-sm font-semibold text-slate-600 leading-relaxed">
                    {{ serviceGuideMessage() }}
                  </p>
                </div>
              </div>

              <div class="grid gap-2">
                @for (step of serviceProgressSteps(); track step.title) {
                  <div
                    class="flex items-center gap-3 rounded-2xl border p-3"
                    [class.bg-emerald-50]="step.state === 'done'"
                    [class.border-emerald-100]="step.state === 'done'"
                    [class.bg-amber-50]="step.state === 'active'"
                    [class.border-amber-100]="step.state === 'active'"
                    [class.bg-slate-50]="step.state === 'pending'"
                    [class.border-slate-100]="step.state === 'pending'"
                  >
                    <div
                      class="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                      [class.bg-emerald-100]="step.state === 'done'"
                      [class.text-emerald-700]="step.state === 'done'"
                      [class.bg-amber-100]="step.state === 'active'"
                      [class.text-amber-700]="step.state === 'active'"
                      [class.bg-white]="step.state === 'pending'"
                      [class.text-slate-400]="step.state === 'pending'"
                    >
                      <ion-icon [name]="step.icon"></ion-icon>
                    </div>
                    <div class="min-w-0">
                      <p class="text-sm font-black text-slate-950 truncate">{{ step.title }}</p>
                      <p class="text-xs font-semibold text-slate-500 leading-snug">{{ step.description }}</p>
                    </div>
                  </div>
                }
              </div>
            </div>

            @if (showPaymentProtectionPanel()) {
              <div class="p-5 rounded-[2rem] border border-amber-100 bg-amber-50 space-y-4">
                <div class="flex items-start gap-3">
                  <div class="w-11 h-11 rounded-2xl bg-white text-amber-600 border border-amber-100 flex items-center justify-center shadow-sm shrink-0">
                    <ion-icon [name]="paymentProtectionIcon()" class="text-xl"></ion-icon>
                  </div>

                  <div class="min-w-0">
                    <p class="text-[10px] font-black uppercase tracking-widest text-amber-700">
                      Movabi payment protection
                    </p>
                    <h3 class="mt-1 text-lg font-display font-black text-slate-950">
                      {{ paymentProtectionTitle() }}
                    </h3>
                    <p class="mt-2 text-sm font-semibold text-slate-700 leading-relaxed">
                      {{ paymentProtectionMessage() }}
                    </p>
                  </div>
                </div>

                <div class="rounded-2xl bg-white/85 border border-amber-100 p-3 space-y-2 text-sm font-bold text-slate-700">
                  <div class="flex items-center justify-between gap-3">
                    <span>Reserved amount</span>
                    <span class="text-slate-950">{{ getDisplayedTotal() }}</span>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <span>Where it returns</span>
                    <span class="text-right text-slate-950">{{ paymentProtectionDestination() }}</span>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <span>Status</span>
                    <span class="text-right text-amber-700">{{ paymentProtectionStatus() }}</span>
                  </div>
                </div>
              </div>
            }

            @if (booking()?.service_slug === ServiceTypeEnum.ERRAND && errandFunding()) {
              <div class="grid grid-cols-2 gap-3">
                <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Service Fee</p>
                  <p class="text-lg font-display font-bold text-slate-900">
                    {{ config.formatCurrency(getErrandServiceFee()) }}
                  </p>
                </div>

                <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Item Budget</p>
                  <p class="text-lg font-display font-bold text-slate-900">
                    {{ config.formatCurrency(getErrandItemBudget()) }}
                  </p>
                </div>

                @if (getErrandReleasedAmount() > 0) {
                  <div class="col-span-2 p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                    <p class="text-[9px] font-bold text-emerald-700 uppercase tracking-widest mb-1">Returned to wallet</p>
                    <p class="text-lg font-display font-bold text-emerald-700">
                      {{ config.formatCurrency(getErrandReleasedAmount()) }}
                    </p>
                  </div>
                }
              </div>
            }

            @if (booking()?.driver_id) {
              @if (errandFunding()?.over_budget_status === 'requested') {
                <div class="p-6 bg-rose-50 rounded-[2rem] border border-rose-100">
                  <div class="flex items-center gap-3 mb-4">
                    <div class="w-10 h-10 rounded-xl bg-rose-500 flex items-center justify-center text-white shadow-lg shadow-rose-200">
                      <ion-icon name="alert-circle-outline" class="text-xl"></ion-icon>
                    </div>
                    <div>
                      <h3 class="text-base font-display font-bold text-slate-900">Budget Increase</h3>
                      <p class="text-[9px] font-bold text-rose-600 uppercase tracking-widest">Action Required</p>
                    </div>
                  </div>

                  <div class="space-y-3 mb-6">
                    <div class="flex justify-between items-center p-3 bg-white rounded-xl border border-rose-100">
                      <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Original</span>
                      <span class="text-base font-display font-bold text-slate-900">
                        {{ config.formatCurrency(errandFunding()?.amount_reserved || 0) }}
                      </span>
                    </div>

                    <div class="flex justify-between items-center p-3 bg-rose-100/50 rounded-xl border border-rose-200">
                      <span class="text-[10px] font-bold text-rose-600 uppercase tracking-widest">New Required</span>
                      <span class="text-base font-display font-bold text-rose-700">
                        {{ config.formatCurrency(errandFunding()?.over_budget_amount || 0) }}
                      </span>
                    </div>

                    @if (getOverBudgetReason()) {
                      <div class="p-3 bg-white rounded-xl border border-rose-100">
                        <p class="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                          Driver message
                        </p>
                        <p class="text-sm font-semibold text-slate-800 leading-relaxed">
                          {{ getOverBudgetReason() }}
                        </p>
                      </div>
                    }

                    @if (getExtraBudgetShortfall() > 0) {
                      <div class="p-3 bg-amber-50 rounded-xl border border-amber-200">
                        <p class="text-[10px] font-bold text-amber-700 uppercase tracking-widest mb-1">
                          Wallet top-up needed
                        </p>
                        <p class="text-sm font-semibold text-slate-700 leading-snug">
                          Add {{ config.formatCurrency(getExtraBudgetShortfall()) }} to approve this extra budget.
                        </p>
                      </div>
                    }
                  </div>

                  <div class="grid grid-cols-2 gap-3">
                    <app-button variant="secondary" color="error" size="md" (clicked)="rejectOverBudget()">
                      Reject
                    </app-button>

                    <app-button variant="primary" color="success" size="md" (clicked)="approveOverBudget()">
                      Approve
                    </app-button>
                  </div>
                </div>
              }

              <div class="p-4 bg-white rounded-[2rem] border border-slate-100 shadow-sm">
                <div class="flex items-start gap-4">
                  <div class="w-14 h-14 rounded-2xl overflow-hidden border-2 border-white shadow-md shrink-0">
                    @if (getDriverAvatar()) {
                      <img [src]="getDriverAvatar()!" alt="Driver photo" class="w-full h-full object-cover" />
                    } @else {
                      <div class="w-full h-full bg-amber-50 text-amber-600 flex items-center justify-center">
                        <ion-icon name="car-sport-outline" class="text-2xl"></ion-icon>
                      </div>
                    }
                  </div>

                  <div class="flex-1 min-w-0">
                    <h3 class="text-base font-bold text-slate-900 truncate">
                      {{ getDriverName() }}
                    </h3>
                    <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1 truncate">
                      {{ getDriverStatusText() }}
                    </p>

                    <div class="mt-3 grid grid-cols-1 gap-2">
                      <div class="rounded-2xl bg-slate-50 border border-slate-100 px-3 py-2">
                        <p class="text-[9px] text-slate-400 font-black uppercase tracking-widest">Transport</p>
                        <p class="text-sm text-slate-900 font-black truncate">{{ getDriverVehicleSummary() }}</p>
                        <p class="text-[11px] text-slate-500 font-semibold truncate">{{ getDriverVehicleMeta() }}</p>
                      </div>
                    </div>
                  </div>

                  @if (booking()?.driver?.phone) {
                    <div class="flex gap-2 shrink-0">
                      <app-button variant="secondary" size="sm" [fullWidth]="false" class="h-11 w-11 rounded-xl" (clicked)="callDriver()">
                        <ion-icon name="call" slot="icon-only" class="text-lg"></ion-icon>
                      </app-button>
                    </div>
                  }
                </div>
              </div>

              @if (['accepted', 'arrived', 'in_progress', 'heading_to_pickup', 'en_route_to_customer'].includes(booking()?.status || '')) {
                <div class="pt-2">
                  <app-button
                    [variant]="showChat() ? 'outline' : 'secondary'"
                    (clicked)="showChat.set(!showChat())"
                    class="w-full"
                  >
                    <ion-icon [name]="showChat() ? 'chevron-down' : 'chatbubbles'" class="mr-2 text-xl"></ion-icon>
                    {{ showChat() ? 'Hide Chat' : 'Message Driver' }}
                  </app-button>

                  @if (showChat()) {
                    <div class="mt-6 h-[500px] border border-slate-100 rounded-[2.5rem] overflow-hidden shadow-2xl shadow-slate-200/50">
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

            <div class="p-5 bg-slate-50 rounded-[2rem] border border-slate-100">
              <div class="flex items-center gap-2 mb-5">
                <div class="w-10 h-10 rounded-xl bg-white border border-slate-100 flex items-center justify-center text-slate-700 shadow-sm">
                  <ion-icon name="navigate" class="text-xl"></ion-icon>
                </div>
                <div>
                  <h3 class="text-base font-display font-bold text-slate-900">{{ routeCardTitle() }}</h3>
                  <p class="text-xs font-semibold text-slate-500">{{ routeCardSubtitle() }}</p>
                </div>
              </div>

              <div class="relative pl-10 space-y-10">
                <div class="absolute left-[13px] top-2 bottom-2 w-0.5 bg-slate-200"></div>

                <div class="relative">
                  <div class="absolute -left-[31px] top-1 w-5 h-5 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-xs font-semibold text-slate-500 mb-1">{{ originLabel() }}</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-snug">
                      {{ booking()?.pickup_address }}
                    </h3>
                  </div>
                </div>

                <div class="relative">
                  <div class="absolute -left-[31px] top-1 w-5 h-5 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-xs font-semibold text-slate-500 mb-1">{{ destinationLabel() }}</p>
                    <h3 class="text-sm font-bold text-slate-900 leading-snug">
                      {{ booking()?.dropoff_address }}
                    </h3>
                  </div>
                </div>
              </div>
            </div>

            @if (details()) {
              <div class="pt-2">
                <div class="flex items-center gap-2 mb-4">
                  <div class="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-700 shadow-sm">
                    <ion-icon name="sparkles-outline" class="text-xl"></ion-icon>
                  </div>
                  <div>
                    <h3 class="text-base font-display font-bold text-slate-900">Service Details</h3>
                    <p class="text-xs font-semibold text-slate-500">Extra information</p>
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-4">
                  @if (booking()?.service_slug === ServiceTypeEnum.RIDE) {
                    <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <p class="text-xs font-semibold text-slate-500 mb-1">Passengers</p>
                      <p class="text-xl font-display font-bold text-slate-900">
                        {{ details()?.['passenger_count'] || 1 }}
                      </p>
                    </div>
                  }

                  @if (booking()?.service_slug === ServiceTypeEnum.VAN) {
                    <div class="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <p class="text-xs font-semibold text-slate-500 mb-1">Helpers</p>
                      <p class="text-xl font-display font-bold text-slate-900">
                        {{ details()?.['helper_count'] || 0 }}
                      </p>
                    </div>
                  }
                </div>

                @if (booking()?.service_slug === ServiceTypeEnum.ERRAND) {
                  <div class="p-4 bg-slate-50 rounded-[2rem] border border-slate-100 mt-4">
                    <div class="flex justify-between items-center mb-4 gap-3">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Items Requested</p>

                      @if (details()?.['actual_spending']) {
                        <app-badge variant="success">
                          {{ config.formatCurrency($any(details()?.['actual_spending']) || 0) }} Spent
                        </app-badge>
                      }
                    </div>

                    <div class="flex flex-wrap gap-2">
                      @for (item of ($any(details()?.['items_list']) || []); track item) {
                        <app-badge variant="primary">{{ item }}</app-badge>
                      }
                    </div>

                    <div class="mt-6 pt-6 border-t border-slate-200/50 space-y-4">
                      <div class="flex justify-between items-center">
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Initial Budget</span>
                        <span class="text-xl font-display font-bold text-emerald-600">
                          {{ config.formatCurrency($any(details()?.['estimated_budget']) || 0) }}
                        </span>
                      </div>

                      @if (details()?.['receipt_url']) {
                        <app-button variant="secondary" size="sm" class="w-full" (clicked)="viewReceipt(details()?.['receipt_url']?.toString())">
                          <ion-icon name="receipt-outline" slot="start" class="mr-2"></ion-icon>
                          View Receipt
                        </app-button>
                      }
                    </div>
                  </div>
                }
              </div>
            }

            <div class="pt-4 space-y-4">
              @if (booking()?.status === 'completed') {
                <app-button variant="primary" size="lg" (clicked)="showRating()" class="w-full">
                  <ion-icon name="checkmark-circle-outline" slot="start" class="mr-2"></ion-icon>
                  Rate Experience
                </app-button>
              } @else if (canManuallyCancel()) {
                <app-button variant="outline" color="error" size="lg" (clicked)="cancelBooking()" class="w-full">
                  <ion-icon name="close-circle-outline" slot="start" class="mr-2"></ion-icon>
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
              <p class="text-slate-500 font-medium max-w-xs mx-auto leading-relaxed">
                We couldn't find this booking. It may have been completed or cancelled.
              </p>
            </div>
            <app-button variant="secondary" size="lg" (clicked)="router.navigate(['/customer'])" class="w-full">
              Back to Home
            </app-button>
          }
        </div>
      }
    </ion-content>
  `
})
export class BookingTrackingPage implements OnInit, OnDestroy {
    @ViewChild('map') mapComponent?: MapComponent;

    private route = inject(ActivatedRoute);
    public router = inject(Router);

    private bookingService = inject(BookingService);
    private supabase = inject(SupabaseService);
    private alertCtrl = inject(AlertController);
    private locationService = inject(LocationService);
    private walletService = inject(WalletService);

    private localSearchFallbackExpiresAt: number | null = null;

    public config = inject(AppConfigService);

    ServiceTypeEnum = ServiceTypeEnum;

    booking = this.bookingService.activeBooking;

    details = signal<Record<string, any> | null>(null);
    errandFunding = signal<ErrandFunding | null>(null);

    isLoading = signal(true);
    showChat = signal(false);
    detailsExpanded = signal(false);
    driverDistanceToPickup = signal<number | null>(null);
    driverEtaToPickup = signal<number | null>(null);
    driverLastSeenAt = signal<Date | null>(null);

    searchCountdownSeconds = signal(DRIVER_SEARCH_WINDOW_SECONDS);

    searchProgressPercent = computed(() => {
        const val = Math.max(0, Math.min(DRIVER_SEARCH_WINDOW_SECONDS, this.searchCountdownSeconds()));
        return (val / DRIVER_SEARCH_WINDOW_SECONDS) * 100;
    });

    private channel?: RealtimeChannel;
    private errandFundingChannel?: RealtimeChannel;
    private locationSubscription?: RealtimeChannel;
    private lastDriverCameraUpdateAt = 0;

    private pollingInterval?: ReturnType<typeof setInterval>;
    private countdownInterval?: ReturnType<typeof setInterval>;

    constructor() {
        addIcons({
            chevronBackOutline,
            call,
            chevronDown,
            chatbubbles,
            alertCircleOutline,
            navigate,
            shieldCheckmark,
            informationCircle,
            receiptOutline,
            timeOutline,
            sparklesOutline,
            carSportOutline,
            refreshOutline,
            closeCircleOutline,
            timerOutline,
            checkmarkCircleOutline,
            searchOutline,
            basketOutline,
            navigateOutline,
            shieldCheckmarkOutline,
            cubeOutline,
            locationOutline,
            archiveOutline,
            flagOutline,
            storefrontOutline,
            homeOutline
        });
    }

    async ngOnInit(): Promise<void> {
        const id = this.route.snapshot.paramMap.get('id');

        if (!id) {
            this.isLoading.set(false);
            return;
        }

        this.channel = this.bookingService.subscribeToBooking(id);
        this.subscribeToErrandFunding(id);

        await this.walletService.fetchWallet();
        await this.loadBookingAndDetails(id, true);
        this.startPolling(id);
    }

    ngOnDestroy(): void {
        this.resetSearchState();

        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = undefined;
        }

        this.channel?.unsubscribe();
        this.errandFundingChannel?.unsubscribe();
        this.locationSubscription?.unsubscribe();
    }

    getStatusVariant(
        status: string
    ): 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' {
        switch (status) {
            case 'searching':
            case 'no_driver_found':
            case 'requires_review':
                return 'warning';
            case 'accepted':
            case 'arrived':
            case 'in_progress':
            case 'heading_to_pickup':
            case 'en_route_to_customer':
                return 'primary';
            case 'completed':
            case 'settled':
                return 'success';
            case 'cancelled':
            case 'canceled':
                return 'error';
            default:
                return 'secondary';
        }
    }

    getStatusLabel(status: string): string {
        if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
            const errandMap: Record<string, string> = {
                searching: 'Finding errand driver',
                accepted: 'Driver assigned',
                assigned: 'Driver assigned',
                heading_to_pickup: 'Heading to store',
                arrived: 'Driver arrived',
                arrived_at_store: 'At the store',
                shopping_in_progress: 'Shopping now',
                collected: 'Items collected',
                en_route_to_customer: 'Delivering to you',
                delivered: 'Delivered',
                completed: 'Errand complete',
                settled: 'Errand settled',
                cancelled: 'Errand cancelled',
                canceled: 'Errand cancelled',
                no_driver_found: 'No driver found',
                requires_review: 'Movabi review'
            };

            if (errandMap[status]) return errandMap[status];
        }

        const map: Record<string, string> = {
            searching: 'Searching for driver',
            accepted: 'Driver assigned',
            assigned: 'Driver assigned',
            heading_to_pickup: 'Heading to pickup',
            arrived: 'Driver arrived',
            in_progress: 'Trip in progress',
            arrived_at_store: 'Driver at store',
            shopping_in_progress: 'Shopping in progress',
            collected: 'Items collected',
            en_route_to_customer: 'On the way',
            delivered: 'Delivered',
            completed: 'Completed',
            settled: 'Settled',
            cancelled: 'Cancelled',
            canceled: 'Cancelled',
            no_driver_found: 'No driver found',
            requires_review: 'Movabi review'
        };

        return map[status] ?? status.replace(/_/g, ' ');
    }

    getStatusHint(status: string): string {
        if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
            const errandMap: Record<string, string> = {
                searching: 'Matching someone to shop and deliver',
                accepted: 'Driver is heading to the store',
                assigned: 'Driver is heading to the store',
                heading_to_pickup: 'Driver is going to the store',
                arrived: 'Driver reached the store area',
                arrived_at_store: 'Driver is ready to shop',
                shopping_in_progress: 'Driver is shopping for your items',
                collected: 'Items are collected and ready for delivery',
                en_route_to_customer: 'Driver is bringing your items',
                delivered: 'Items have been delivered',
                completed: 'Errand is complete',
                settled: 'Wallet funds have been settled',
                cancelled: 'Errand cancelled',
                canceled: 'Errand cancelled',
                no_driver_found: 'No available errand driver',
                requires_review: 'We are checking this errand and payment'
            };

            if (errandMap[status]) return errandMap[status];
        }

        const map: Record<string, string> = {
            searching: 'Matching nearby drivers',
            accepted: 'Driver is coming',
            assigned: 'Driver is coming',
            heading_to_pickup: 'Driver is on the way',
            arrived: 'Driver reached pickup',
            in_progress: 'Journey in progress',
            arrived_at_store: 'Driver reached the store',
            shopping_in_progress: 'Driver is shopping',
            collected: 'Items have been collected',
            en_route_to_customer: 'Driver is on the way',
            delivered: 'Delivery completed',
            completed: 'Trip completed',
            settled: 'Payment settled',
            cancelled: 'Booking cancelled',
            canceled: 'Booking cancelled',
            no_driver_found: 'No available driver',
            requires_review: 'We are checking this booking and payment'
        };

        return map[status] ?? 'Live updates available';
    }

    trackingTitle(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Errand Tracking';
            case ServiceTypeEnum.DELIVERY:
                return 'Delivery Tracking';
            case ServiceTypeEnum.VAN:
                return 'Move Tracking';
            default:
                return 'Live Tracking';
        }
    }

    routeCardTitle(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Errand Route';
            case ServiceTypeEnum.DELIVERY:
                return 'Delivery Route';
            case ServiceTypeEnum.VAN:
                return 'Move Route';
            default:
                return 'Trip Route';
        }
    }

    routeCardSubtitle(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store, shopping, and delivery';
            case ServiceTypeEnum.DELIVERY:
                return 'Collection and recipient details';
            case ServiceTypeEnum.VAN:
                return 'Moving journey details';
            default:
                return 'Live journey details';
        }
    }

    serviceGuideIcon(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'storefront-outline';
            case ServiceTypeEnum.DELIVERY:
                return 'cube-outline';
            case ServiceTypeEnum.VAN:
                return 'home-outline';
            default:
                return 'car-sport-outline';
        }
    }

    serviceGuideEyebrow(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Errand journey';
            case ServiceTypeEnum.DELIVERY:
                return 'Package journey';
            case ServiceTypeEnum.VAN:
                return 'Move journey';
            default:
                return 'Ride journey';
        }
    }

    serviceGuideTitle(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Your shopper is managed step by step';
            case ServiceTypeEnum.DELIVERY:
                return 'Collection and delivery are tracked separately';
            case ServiceTypeEnum.VAN:
                return 'Your move is guided from loading to drop-off';
            default:
                return 'Your driver is matched and tracked';
        }
    }

    serviceGuideMessage(): string {
        const status = String(this.booking()?.status || '');

        if (status === 'no_driver_found') {
            return 'No driver accepted in this search window. Any reserved payment is protected and released according to the payment method shown below.';
        }

        if (status === 'cancelled' || status === 'canceled') {
            return 'This booking is cancelled. Movabi keeps the payment record visible so you can see where any reserved funds return.';
        }

        if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
            return 'Movabi separates the service fee from the item budget. The driver records spending and uploads a receipt before the errand is completed.';
        }

        if (this.booking()?.service_slug === ServiceTypeEnum.DELIVERY) {
            return 'You can follow collection, courier movement, and recipient delivery without reading it like a normal ride.';
        }

        if (this.booking()?.service_slug === ServiceTypeEnum.VAN) {
            return 'The driver follows a move flow: arrive, load, travel, unload, and complete when the move is finished.';
        }

        return 'You can see when the driver is assigned, travelling to pickup, and when the journey is in progress.';
    }

    serviceProgressSteps(): Array<{ title: string; description: string; icon: string; state: 'done' | 'active' | 'pending' }> {
        const service = this.booking()?.service_slug;
        const status = String(this.booking()?.status || '');
        const done = (statuses: string[]) => statuses.includes(status) ? 'active' : this.hasReachedStatus(statuses[statuses.length - 1]) ? 'done' : 'pending';

        if (service === ServiceTypeEnum.ERRAND) {
            return [
                {
                    title: 'Match errand driver',
                    description: 'A nearby eligible driver accepts the shop and delivery.',
                    icon: 'search-outline',
                    state: done(['searching', 'accepted', 'assigned'])
                },
                {
                    title: 'Shop items',
                    description: 'Driver uses the approved item budget and records spending.',
                    icon: 'basket-outline',
                    state: done(['heading_to_pickup', 'arrived', 'arrived_at_store', 'shopping_in_progress'])
                },
                {
                    title: 'Deliver to you',
                    description: 'Receipt and live delivery updates are shown here.',
                    icon: 'navigate-outline',
                    state: done(['collected', 'en_route_to_customer', 'delivered'])
                },
                {
                    title: 'Settle safely',
                    description: 'Unused item budget returns to the wallet or original payment route.',
                    icon: 'shield-checkmark-outline',
                    state: this.isTerminalTrackingStatus(status) ? 'active' : 'pending'
                }
            ];
        }

        if (service === ServiceTypeEnum.DELIVERY) {
            return [
                { title: 'Assign courier', description: 'A compatible driver accepts the package request.', icon: 'search-outline', state: done(['searching', 'accepted', 'assigned']) },
                { title: 'Collect package', description: 'The courier confirms collection before travelling.', icon: 'cube-outline', state: done(['heading_to_pickup', 'arrived', 'in_progress']) },
                { title: 'Deliver package', description: 'Recipient delivery is tracked to completion.', icon: 'location-outline', state: done(['en_route_to_customer', 'delivered', 'completed']) }
            ];
        }

        if (service === ServiceTypeEnum.VAN) {
            return [
                { title: 'Assign vehicle', description: 'A driver with the correct vehicle class accepts the move.', icon: 'search-outline', state: done(['searching', 'accepted', 'assigned']) },
                { title: 'Load at pickup', description: 'Driver arrives and starts the move once ready.', icon: 'archive-outline', state: done(['heading_to_pickup', 'arrived', 'in_progress']) },
                { title: 'Unload and finish', description: 'The move completes only after work is confirmed.', icon: 'checkmark-circle-outline', state: done(['delivered', 'completed', 'settled']) }
            ];
        }

        return [
            { title: 'Match driver', description: 'A nearby driver accepts your ride.', icon: 'search-outline', state: done(['searching', 'accepted', 'assigned']) },
            { title: 'Pickup', description: 'Track the driver as they come to you.', icon: 'car-sport-outline', state: done(['heading_to_pickup', 'arrived']) },
            { title: 'Ride and complete', description: 'Follow the trip until drop-off is confirmed.', icon: 'flag-outline', state: done(['in_progress', 'completed', 'settled']) }
        ];
    }

    private hasReachedStatus(target: string): boolean {
        const order = [
            'searching',
            'accepted',
            'assigned',
            'heading_to_pickup',
            'arrived',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'in_progress',
            'delivered',
            'completed',
            'settled'
        ];
        const currentIndex = order.indexOf(String(this.booking()?.status || ''));
        const targetIndex = order.indexOf(target);

        return currentIndex >= 0 && targetIndex >= 0 && currentIndex > targetIndex;
    }

    originLabel(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store / pickup point';
            case ServiceTypeEnum.DELIVERY:
                return 'Collection point';
            case ServiceTypeEnum.VAN:
                return 'Moving from';
            default:
                return 'Pickup location';
        }
    }

    destinationLabel(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Delivery address';
            case ServiceTypeEnum.DELIVERY:
                return 'Recipient address';
            case ServiceTypeEnum.VAN:
                return 'Moving to';
            default:
                return 'Destination';
        }
    }

    private mapOriginMarkerLabel(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'STORE';
            case ServiceTypeEnum.DELIVERY:
                return 'COLLECT';
            case ServiceTypeEnum.VAN:
                return 'FROM';
            default:
                return 'PICKUP';
        }
    }

    private mapDestinationMarkerLabel(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'DELIVER';
            case ServiceTypeEnum.DELIVERY:
                return 'RECIPIENT';
            case ServiceTypeEnum.VAN:
                return 'TO';
            default:
                return 'DROPOFF';
        }
    }

    getDriverStatusText(): string {
        return this.getStatusHint(this.booking()?.status || '');
    }

    getDriverName(): string {
        const driver = this.booking()?.driver;
        const name = String(driver?.full_name || '').trim() || [driver?.first_name, driver?.last_name]
            .map((part) => String(part || '').trim())
            .filter(Boolean)
            .join(' ');

        return name || 'Your driver';
    }

    getDriverAvatar(): string | null {
        return this.booking()?.driver?.avatar_url || null;
    }

    getDriverVehicleSummary(): string {
        const vehicle = this.getDriverVehicle();
        if (!vehicle) return 'Vehicle details pending';

        const makeModel = [vehicle.make, vehicle.model]
            .map((part) => String(part || '').trim())
            .filter(Boolean)
            .join(' ');

        return makeModel || this.getDriverTransportLabel(vehicle);
    }

    getDriverVehicleMeta(): string {
        const vehicle = this.getDriverVehicle();
        if (!vehicle) return 'We will show transport details as soon as they are confirmed.';

        const parts = [
            this.getVehicleColorLabel(vehicle),
            this.getDriverTransportLabel(vehicle),
            vehicle.license_plate
        ]
            .map((part) => String(part || '').trim())
            .filter(Boolean);

        return parts.length ? parts.join(' • ') : 'Transport confirmed';
    }

    private getVehicleColorLabel(vehicle: Vehicle): string {
        const raw = String((vehicle as Vehicle & { colour?: string }).color || (vehicle as Vehicle & { colour?: string }).colour || '').trim();
        if (!raw) return '';

        return raw
            .replace(/[_-]/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    private getDriverVehicle(): Vehicle | null {
        const driver = this.booking()?.driver as ({ vehicle?: Vehicle | null; vehicles?: Vehicle[] } | undefined);
        return driver?.vehicle || driver?.vehicles?.[0] || null;
    }

    private getDriverTransportLabel(vehicle: Vehicle): string {
        const type = String(vehicle.type || '').replace(/_/g, ' ').trim();
        const capacity = String(vehicle.capacity || '').trim();
        const label = type ? type.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Vehicle';

        return capacity ? `${label} • ${capacity}` : label;
    }

    canManuallyCancel(): boolean {
        const status = this.booking()?.status || '';

        return ['requested', 'searching'].includes(status);
    }

    getDisplayedTotal(): string {
        const bookingTotal = Number(this.booking()?.total_price || 0);

        if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
            return this.config.formatCurrency(this.getErrandTotalReserved());
        }

        return this.config.formatCurrency(bookingTotal);
    }

    paymentAmountLabel(): string {
        if (this.showPaymentProtectionPanel()) {
            return this.paidByWallet() ? 'Wallet Reserved' : 'Card Authorised';
        }

        return this.booking()?.service_slug === ServiceTypeEnum.ERRAND ? 'Total Reserved' : 'Fixed Price';
    }

    showPaymentProtectionPanel(): boolean {
        const booking = this.booking();
        const status = String(booking?.status || '').toLowerCase();

        return ['cancelled', 'canceled', 'no_driver_found', 'requires_review'].includes(status);
    }

    paymentProtectionIcon(): string {
        return this.paymentNeedsReview() ? 'information-circle' : 'checkmark-circle-outline';
    }

    paymentProtectionTitle(): string {
        if (this.paymentNeedsReview()) {
            return 'We are checking your reserved funds';
        }

        return this.paidByWallet()
            ? 'Your wallet reservation is released'
            : 'Your card hold is released';
    }

    paymentProtectionMessage(): string {
        if (this.paymentNeedsReview()) {
            return `This ${this.servicePaymentName()} could not be completed normally. Movabi is checking the reservation and will release any unused funds after review.`;
        }

        if (this.paidByWallet()) {
            return `${this.paymentProtectionReason()} The reserved amount is returned to your Movabi wallet balance.`;
        }

        return `${this.paymentProtectionReason()} The card authorisation is cancelled and the money returns to your original card. Your bank may show the hold for a short time before it disappears.`;
    }

    paymentProtectionDestination(): string {
        if (this.paymentNeedsReview()) return 'Movabi review';
        return this.paidByWallet() ? 'Movabi wallet' : 'Original payment card';
    }

    paymentProtectionStatus(): string {
        if (this.paymentNeedsReview()) return 'Review in progress';
        return this.paidByWallet() ? 'Returned to wallet' : 'Released by Movabi';
    }

    private paidByWallet(): boolean {
        const booking = this.booking() as any;
        const method = String(booking?.payment_method || '').toLowerCase();
        const status = String(booking?.payment_status || '').toLowerCase();

        return method === 'wallet' || status === 'wallet_funded';
    }

    private paymentNeedsReview(): boolean {
        const booking = this.booking() as any;

        return String(booking?.payment_status || '').toLowerCase() === 'requires_review' ||
            String(booking?.status || '').toLowerCase() === 'requires_review';
    }

    private paymentProtectionReason(): string {
        const status = String(this.booking()?.status || '').toLowerCase();
        const service = this.servicePaymentName();

        if (status === 'no_driver_found') {
            return `Movabi could not assign a ${service} driver, so no service happened.`;
        }

        if (status === 'cancelled' || status === 'canceled') {
            return `This ${service} was cancelled before completion.`;
        }

        return `This ${service} did not complete normally.`;
    }

    private servicePaymentName(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'errand';
            case ServiceTypeEnum.DELIVERY:
                return 'delivery';
            case ServiceTypeEnum.VAN:
                return 'moving';
            default:
                return 'ride';
        }
    }

    getErrandItemBudget(): number {
        const details = this.details() || {};
        const metadata = (this.booking() as any)?.metadata || {};
        const paymentSplit = metadata?.payment_split || {};
        const errandDetails = metadata?.errand_details || {};

        return this.toMoney(
            details['estimated_budget'] ||
            paymentSplit['item_budget'] ||
            errandDetails['budget'] ||
            0
        );
    }

    getErrandTotalReserved(): number {
        const reserved = this.toMoney(this.errandFunding()?.amount_reserved || 0);
        const itemBudget = this.getErrandItemBudget();
        const bookingTotal = this.toMoney(this.booking()?.total_price || 0);

        return Math.max(reserved, itemBudget + this.getErrandServiceFee(), bookingTotal);
    }

    getErrandServiceFee(): number {
        const bookingTotal = this.toMoney(this.booking()?.total_price || 0);
        const reserved = this.toMoney(this.errandFunding()?.amount_reserved || 0);
        const itemBudget = this.getErrandItemBudget();
        const metadata = (this.booking() as any)?.metadata || {};
        const paymentSplit = metadata?.payment_split || {};
        const explicitServiceCharge = this.toMoney(paymentSplit['service_charge'] || 0);

        if (explicitServiceCharge > 0) {
            return explicitServiceCharge;
        }

        if (reserved > itemBudget) {
            return this.toMoney(reserved - itemBudget);
        }

        if (itemBudget > 0 && bookingTotal > itemBudget) {
            return this.toMoney(bookingTotal - itemBudget);
        }

        if (itemBudget > 0 && reserved <= itemBudget && bookingTotal <= itemBudget) {
            return 0;
        }

        return bookingTotal;
    }

    getErrandReleasedAmount(): number {
        const metadata = this.errandFunding()?.metadata || {};
        const settlement = metadata['settlement'] as Record<string, unknown> | undefined;

        return this.toMoney(settlement?.['amount_released'] || 0);
    }

    private toMoney(value: unknown): number {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
    }

    searchCountdownLabel(): string {
        const total = Math.max(0, this.searchCountdownSeconds());
        const mins = Math.floor(total / 60);
        const secs = total % 60;

        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    private startSearchCountdown(): void {
        this.stopSearchCountdown();
        this.updateSearchCountdownFromBooking();

        this.countdownInterval = setInterval(() => {
            this.updateSearchCountdownFromBooking();
        }, 1000);
    }

  

    private updateSearchCountdownFromBooking(): void {
        const b: any = this.booking();

        if (!b || b.status !== 'searching') {
            this.localSearchFallbackExpiresAt = null;
            this.searchCountdownSeconds.set(DRIVER_SEARCH_WINDOW_SECONDS);
            return;
        }

        let expiresAt: number | null = null;

        if (b.driver_search_expires_at) {
            const parsed = new Date(b.driver_search_expires_at).getTime();

            if (Number.isFinite(parsed)) {
                expiresAt = parsed;
                this.localSearchFallbackExpiresAt = parsed;
            }
        }

        if (!expiresAt) {
            if (!this.localSearchFallbackExpiresAt) {
                this.localSearchFallbackExpiresAt = Date.now() + DRIVER_SEARCH_WINDOW_SECONDS * 1000;
            }

            expiresAt = this.localSearchFallbackExpiresAt;
        }

        const remain = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));

        this.searchCountdownSeconds.set(
            Math.min(DRIVER_SEARCH_WINDOW_SECONDS, remain)
        );

        if (remain <= 0) {
            this.stopSearchCountdown();
        }
    }

    private stopSearchCountdown(): void {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = undefined;
        }
    }

    private resetSearchState(): void {
        this.stopSearchCountdown();
        this.searchCountdownSeconds.set(DRIVER_SEARCH_WINDOW_SECONDS);
        this.mapComponent?.showSearchingOverlay?.set(false);
    }

    private syncSearchUiState(): void {
        const b = this.booking();

        if (b?.status === 'searching') {
            this.mapComponent?.showSearchingOverlay?.set(false);

            if (!this.countdownInterval) {
                this.startSearchCountdown();
            } else {
                this.updateSearchCountdownFromBooking();
            }

            return;
        }

        this.resetSearchState();
    }

    private syncDriverLiveState(booking: Booking): void {
        if (this.isTerminalTrackingStatus(String(booking.status || ''))) {
            this.clearDriverLiveState();
        }
    }

    private clearDriverLiveState(): void {
        this.driverDistanceToPickup.set(null);
        this.driverEtaToPickup.set(null);
        this.driverLastSeenAt.set(null);
        this.locationSubscription?.unsubscribe();
        this.locationSubscription = undefined;
    }

    private isTerminalTrackingStatus(status: string): boolean {
        return ['completed', 'settled', 'cancelled', 'canceled', 'no_driver_found', 'delivered'].includes(status);
    }

    private startPolling(id: string): void {
        this.pollingInterval = setInterval(() => {
            void this.loadBookingAndDetails(id, false);
        }, 5000);
    }

    private subscribeToErrandFunding(id: string): void {
        this.errandFundingChannel?.unsubscribe();

        this.errandFundingChannel = this.supabase
            .channel(`errand-funding-${id}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'errand_funding',
                    filter: `job_id=eq.${id}`
                },
                async (payload) => {
                    const nextFunding = (payload.new || null) as ErrandFunding | null;

                    if (nextFunding?.job_id === id) {
                        this.errandFunding.set(nextFunding);
                        await this.walletService.fetchWallet();
                    } else {
                        await this.loadBookingAndDetails(id, false);
                    }
                }
            )
            .subscribe((status) => {
                console.log('[booking-tracking] errand funding realtime:', status);
            });
    }

    async loadBookingAndDetails(id: string, showLoading = true): Promise<void> {
        if (showLoading) this.isLoading.set(true);

        try {
            const b = await this.bookingService.getBooking(id);

            if (!b) {
                this.isLoading.set(false);
                return;
            }

            this.bookingService.activeBooking.set(b);
            this.syncSearchUiState();
            this.syncDriverLiveState(b);

            const bookingDetails = await this.bookingService.getBookingDetails(
                b.id,
                b.service_slug as ServiceTypeEnum
            );

            this.details.set(bookingDetails || null);

            if (b.service_slug === ServiceTypeEnum.ERRAND) {
                const funding = await this.bookingService.getErrandFunding(b.id);
                this.errandFunding.set(funding);
                void this.walletService.fetchWallet();
            } else {
                this.errandFunding.set(null);
            }

            this.initMap();

            if (b.driver_id && !this.isTerminalTrackingStatus(String(b.status || ''))) {
                this.subscribeToDriverLocation(b.driver_id);
            } else {
                this.clearDriverLiveState();
            }
        } catch (err) {
            console.error('Load booking failed', err);
        } finally {
            this.isLoading.set(false);
        }
    }

    private initMap(): void {
        const b = this.booking();

        if (!b || !this.mapComponent) return;

        const pickupLat = Number(b.pickup_lat);
        const pickupLng = Number(b.pickup_lng);

        const dropLat = Number(b.dropoff_lat);
        const dropLng = Number(b.dropoff_lng);

        if (!this.isValidCoordinate(pickupLat) || !this.isValidCoordinate(pickupLng)) {
            return;
        }

        setTimeout(() => {
            this.mapComponent?.addOrUpdateMarker({
                id: 'pickup',
                coordinates: { lat: pickupLat, lng: pickupLng },
                kind: 'pickup',
                serviceType: b.service_slug as ServiceTypeSlug,
                label: this.mapOriginMarkerLabel()
            });

            if (this.isValidCoordinate(dropLat) && this.isValidCoordinate(dropLng)) {
                this.mapComponent?.addOrUpdateMarker({
                    id: 'dropoff',
                    coordinates: { lat: dropLat, lng: dropLng },
                    kind: 'destination',
                    serviceType: b.service_slug as ServiceTypeSlug,
                    label: this.mapDestinationMarkerLabel()
                });

                this.fitTrackingBounds({ lat: pickupLat, lng: pickupLng }, [
                    [Math.min(pickupLng, dropLng), Math.min(pickupLat, dropLat)],
                    [Math.max(pickupLng, dropLng), Math.max(pickupLat, dropLat)]
                ]);
            }

            this.fitTrackingBounds();
        }, 300);
    }

    private subscribeToDriverLocation(driverId: string): void {
        this.locationSubscription?.unsubscribe();
        this.lastDriverCameraUpdateAt = 0;

        void this.locationService.getLatestDriverLocation(driverId).then((location) => {
            if (location) {
                this.updateDriverMarker(location);
            }
        });

        this.locationSubscription = this.locationService.subscribeToDriverLocation(
            driverId,
            (location: DriverLocation) => {
                this.updateDriverMarker(location);
            }
        );
    }

    private updateDriverMarker(location: DriverLocation): void {
        const b = this.booking();

        if (!b || !this.mapComponent) return;
        if (this.isTerminalTrackingStatus(String(b.status || ''))) {
            this.clearDriverLiveState();
            return;
        }

        const lat = Number(location.lat);
        const lng = Number(location.lng);

        if (!this.isValidCoordinate(lat) || !this.isValidCoordinate(lng)) return;

        this.mapComponent.addOrUpdateMarker({
            id: 'driver',
            coordinates: { lat, lng },
            kind: 'driver',
            serviceType: b.service_slug as ServiceTypeSlug,
            heading: location.heading == null ? undefined : Number(location.heading)
        });

        this.driverLastSeenAt.set(new Date());

        const now = Date.now();
        if (now - this.lastDriverCameraUpdateAt >= 15000) {
            this.fitTrackingBounds({ lat, lng });
            this.lastDriverCameraUpdateAt = now;
        }

        const routeTarget = this.getDriverRouteTarget(b);

        if (!routeTarget) return;

        this.updateDriverDistanceEstimate({ lat, lng }, routeTarget);
    }

    private updateDriverDistanceEstimate(
        driverLocation: { lat: number; lng: number },
        target: { lat: number; lng: number }
    ): void {
        const distanceKm = this.locationService.calculateDistance(
            driverLocation.lat,
            driverLocation.lng,
            target.lat,
            target.lng
        );
        const distanceMeters = Math.max(0, distanceKm * 1000);
        const urbanMetersPerSecond = 8.3; // roughly 30 km/h in city traffic

        this.driverDistanceToPickup.set(distanceMeters);
        this.driverEtaToPickup.set(Math.max(60, Math.round(distanceMeters / urbanMetersPerSecond)));
    }

    private getDriverRouteTarget(booking: Booking): { lat: number; lng: number } | null {
        const status = String(booking.status || '');
        const dropLat = Number(booking.dropoff_lat);
        const dropLng = Number(booking.dropoff_lng);

        if (
            ['in_progress', 'en_route_to_customer', 'collected'].includes(status) &&
            this.isValidCoordinate(dropLat) &&
            this.isValidCoordinate(dropLng)
        ) {
            return { lat: dropLat, lng: dropLng };
        }

        const pickupLat = Number(booking.pickup_lat);
        const pickupLng = Number(booking.pickup_lng);

        if (this.isValidCoordinate(pickupLat) && this.isValidCoordinate(pickupLng)) {
            return { lat: pickupLat, lng: pickupLng };
        }

        return null;
    }

    private shouldShowLiveDriverRoute(status: string): boolean {
        return [
            'accepted',
            'assigned',
            'arrived',
            'heading_to_pickup',
            'in_progress',
            'en_route_to_customer',
            'collected'
        ].includes(status);
    }

    private fitTrackingBounds(
        driver?: { lat: number; lng: number },
        routeBounds?: [[number, number], [number, number]]
    ): void {
        if (!this.mapComponent) return;

        if (routeBounds) {
            this.mapComponent.fitBounds(routeBounds, {
                padding: { top: 72, bottom: 138, left: 34, right: 34 },
                maxZoom: 16,
                duration: 700
            });
            return;
        }

        const b = this.booking();
        if (!b) return;

        const points: Array<{ lat: number; lng: number }> = [];
        const pickup = { lat: Number(b.pickup_lat), lng: Number(b.pickup_lng) };
        const dropoff = { lat: Number(b.dropoff_lat), lng: Number(b.dropoff_lng) };

        if (driver && this.isValidCoordinate(driver.lat) && this.isValidCoordinate(driver.lng)) {
            points.push(driver);
            const activeTarget = this.getDriverRouteTarget(b);
            if (activeTarget) points.push(activeTarget);
        } else {
            if (this.isValidCoordinate(pickup.lat) && this.isValidCoordinate(pickup.lng)) {
                points.push(pickup);
            }

            if (this.isValidCoordinate(dropoff.lat) && this.isValidCoordinate(dropoff.lng)) {
                points.push(dropoff);
            }
        }

        if (points.length === 0) return;

        if (points.length === 1) {
            this.mapComponent.setCenter(points[0].lng, points[0].lat, driver ? 15 : 14);
            return;
        }

        const lngs = points.map((point) => point.lng);
        const lats = points.map((point) => point.lat);

        this.mapComponent.fitBounds(
            [
                [Math.min(...lngs), Math.min(...lats)],
                [Math.max(...lngs), Math.max(...lats)]
            ],
            {
                padding: { top: 72, bottom: 138, left: 34, right: 34 },
                maxZoom: 16,
                duration: 700
            }
        );
    }

    driverLiveLabel(): string {
        if (this.isTerminalTrackingStatus(String(this.booking()?.status || ''))) {
            return '';
        }

        const status = String(this.booking()?.status || '');
        const eta = this.driverEtaToPickup();

        if (eta !== null) {
            if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
                if (['shopping_in_progress', 'arrived_at_store'].includes(status)) return 'Shopping now';
                if (['collected', 'en_route_to_customer'].includes(status)) return `${this.formatDuration(eta)} to delivery`;
                return `${this.formatDuration(eta)} to store`;
            }

            if (this.booking()?.service_slug === ServiceTypeEnum.DELIVERY) {
                return `${this.formatDuration(eta)} to ${this.activeTrackingTargetLabel()}`;
            }

            if (this.booking()?.service_slug === ServiceTypeEnum.VAN) {
                return `${this.formatDuration(eta)} to move point`;
            }

            return `${this.formatDuration(eta)} away`;
        }

        if (this.driverLastSeenAt()) {
            if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) return 'Errand driver updating';
            if (this.booking()?.service_slug === ServiceTypeEnum.DELIVERY) return 'Courier location updating';
            if (this.booking()?.service_slug === ServiceTypeEnum.VAN) return 'Move driver updating';
            return 'Driver location updating';
        }

        return '';
    }

    driverLiveSubtext(): string {
        if (this.isTerminalTrackingStatus(String(this.booking()?.status || ''))) {
            return this.getStatusHint(this.booking()?.status || '');
        }

        const distance = this.driverDistanceToPickup();
        const target = this.activeTrackingTargetLabel();

        if (distance !== null) {
            return `${this.formatDistanceMeters(distance)} to ${target}`;
        }

        if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
            return `Waiting for the errand location update to ${target}.`;
        }

        if (this.booking()?.service_slug === ServiceTypeEnum.DELIVERY) {
            return `Waiting for the courier location update to ${target}.`;
        }

        return `Waiting for the driver GPS update to ${target}.`;
    }

    driverLastSeenLabel(): string {
        const lastSeen = this.driverLastSeenAt();

        if (!lastSeen) return 'Live';

        const seconds = Math.max(0, Math.round((Date.now() - lastSeen.getTime()) / 1000));

        if (seconds < 10) return 'Now';
        if (seconds < 60) return `${seconds}s`;

        return `${Math.round(seconds / 60)}m`;
    }

    private formatDuration(seconds: number | null): string {
        if (!seconds || !Number.isFinite(seconds)) return 'ETA unavailable';
        const minutes = Math.max(1, Math.round(seconds / 60));
        return `${minutes} min`;
    }

    private formatDistanceMeters(meters: number | null): string {
        if (!meters || !Number.isFinite(meters)) return 'Distance unavailable';
        return `${(meters / 1000).toFixed(1)} km`;
    }

    private activeTrackingTargetLabel(): string {
        const status = this.booking()?.status || '';
        const service = this.booking()?.service_slug;
        const isHeadingToDestination = [
            'in_progress',
            'collected',
            'en_route_to_customer',
            'delivered',
            'completed'
        ].includes(status);

        if (service === ServiceTypeEnum.ERRAND) {
            return isHeadingToDestination ? 'delivery address' : 'store';
        }

        if (service === ServiceTypeEnum.DELIVERY) {
            return isHeadingToDestination ? 'recipient' : 'collection point';
        }

        if (service === ServiceTypeEnum.VAN) {
            return isHeadingToDestination ? 'new address' : 'pickup address';
        }

        return isHeadingToDestination ? 'destination' : 'pickup';
    }

    async cancelBooking(): Promise<void> {
        const b = this.booking();
        if (!b) return;

        const alert = await this.alertCtrl.create({
            header: 'Cancel Booking',
            message: 'Are you sure you want to cancel this booking?',
            inputs: [
                {
                    name: 'reason',
                    type: 'text',
                    placeholder: 'Reason'
                }
            ],
            buttons: [
                {
                    text: 'No',
                    role: 'cancel'
                },
                {
                    text: 'Yes, Cancel',
                    role: 'destructive',
                    handler: async (data) => {
                        try {
                            await this.bookingService.cancelBooking(
                                b.id,
                                data?.reason || 'Customer cancelled'
                            );

                            await this.router.navigate(['/customer']);
                        } catch (error: any) {
                            await this.loadBookingAndDetails(b.id, false);
                            const errorAlert = await this.alertCtrl.create({
                                header: 'Could not cancel',
                                message: error?.message || 'This booking could not be cancelled. It may have already changed status.',
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

    async showRating(): Promise<void> {
        const b = this.booking();
        if (!b) return;

        const alert = await this.alertCtrl.create({
            header: 'Rate Trip',
            inputs: [
                {
                    name: 'score',
                    type: 'number',
                    placeholder: '1-5',
                    min: 1,
                    max: 5
                },
                {
                    name: 'comment',
                    type: 'textarea',
                    placeholder: 'Comment'
                }
            ],
            buttons: [
                {
                    text: 'Skip',
                    role: 'cancel',
                    handler: () => this.router.navigate(['/customer'])
                },
                {
                    text: 'Submit',
                    handler: async (data) => {
                        await this.bookingService.rateBooking(
                            b.id,
                            Number(data.score || 5),
                            data.comment || ''
                        );

                        await this.router.navigate(['/customer']);
                    }
                }
            ]
        });

        await alert.present();
    }

    callDriver(): void {
        const phone = this.booking()?.driver?.phone;

        if (phone) {
            window.open(`tel:${phone}`, '_system');
        }
    }

    async approveOverBudget(): Promise<void> {
        const b = this.booking();
        if (!b) return;

        const shortfall = this.getExtraBudgetShortfall();

        if (shortfall > 0) {
            await this.showWalletShortfallAlert(shortfall);
            return;
        }

        try {
            await this.walletService.approveErrandOverBudget(b.id);
            await this.loadBookingAndDetails(b.id, false);
        } catch (error: unknown) {
            await this.showOverBudgetError(error, 'Could not approve extra budget.');
        }
    }

    async rejectOverBudget(): Promise<void> {
        const b = this.booking();
        if (!b) return;

        try {
            await this.walletService.rejectErrandOverBudget(b.id);
            await this.loadBookingAndDetails(b.id, false);
        } catch (error: unknown) {
            await this.showOverBudgetError(error, 'Could not reject extra budget.');
        }
    }

    getExtraBudgetShortfall(): number {
        const requested = Number(this.errandFunding()?.over_budget_amount || 0);
        const available = Number(this.walletService.wallet()?.available_balance || 0);

        if (!Number.isFinite(requested) || requested <= 0) return 0;
        if (!Number.isFinite(available)) return requested;

        return Math.max(0, Number((requested - available).toFixed(2)));
    }

    getOverBudgetReason(): string {
        return String(this.errandFunding()?.over_budget_reason || '').trim();
    }

    private async showWalletShortfallAlert(shortfall: number): Promise<void> {
        const alert = await this.alertCtrl.create({
            header: 'Wallet top-up needed',
            message: `Add ${this.config.formatCurrency(shortfall)} to your wallet before approving this extra budget.`,
            buttons: [
                { text: 'Not now', role: 'cancel' },
                {
                    text: 'Top up wallet',
                    handler: () => {
                        void this.router.navigate(['/customer/wallet']);
                    }
                }
            ]
        });

        await alert.present();
    }

    private async showOverBudgetError(error: unknown, fallback: string): Promise<void> {
        const message = error instanceof Error && error.message ? error.message : fallback;
        const alert = await this.alertCtrl.create({
            header: fallback,
            message,
            buttons: ['OK']
        });

        await alert.present();
    }

    viewReceipt(path?: string | null): void {
        if (!path) return;

        const { data } = this.supabase.storage
            .from('documents')
            .getPublicUrl(path);

        if (data?.publicUrl) {
            window.open(data.publicUrl, '_blank');
        }
    }

    private isValidCoordinate(value: number): boolean {
        return Number.isFinite(value) && !Number.isNaN(value);
    }
}
