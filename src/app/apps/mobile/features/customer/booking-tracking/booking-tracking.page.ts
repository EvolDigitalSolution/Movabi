import {
    Component,
    inject,
    OnInit,
    OnDestroy,
    signal,
    ViewChild,
    computed
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
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
    homeOutline,
    informationCircleOutline,
    navigateCircleOutline,
    documentTextOutline,
    chatbubbleEllipsesOutline,
    walletOutline,
    helpCircleOutline
} from 'ionicons/icons';

import { RealtimeChannel } from '@supabase/supabase-js';

import { BookingService } from '../../../../../core/services/booking/booking.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { WalletService } from '../../../../../core/services/wallet/wallet.service';
import { RoutingService } from '../../../../../core/services/maps/routing.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import { NativePlatformService } from '../../../../../core/services/native/native-platform.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { NotificationOrchestratorService } from '../../../../../core/services/notification/notification-orchestrator.service';

import {
    Booking,
    ServiceTypeEnum,
    DriverLocation,
    ErrandFunding,
    Vehicle,
    JobEvent
} from '../../../../../shared/models/booking.model';

import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';

import {
    ButtonComponent,
    BadgeComponent
} from '../../../../../shared/ui';

import { CommunicationPanelComponent } from '../../../../../shared/ui/communication-panel';
import { MapComponent } from '../../../../../shared/components/map/map.component';
import { MapUxHelpers, MapCoordinates, VehicleMarker } from '../../../../../shared/utils/map-ux-helpers';

const DRIVER_SEARCH_WINDOW_SECONDS = 300;
type ErrandMode = 'collect_deliver' | 'quick_buy' | 'shop_deliver';
type SheetState = 'collapsed' | 'medium' | 'expanded' | 'full';
type CustomerTrackingTab = 'overview' | 'route' | 'details' | 'chat' | 'payment' | 'help';

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

    <ion-content class="movabi-page" [fullscreen]="true">
      @if (booking()) {
        <div class="relative h-full overflow-hidden ion-padding-bottom">
          <div class="absolute inset-0 bg-slate-100 overflow-hidden">
            <div class="absolute inset-0" (pointerdown)="onMapUserInteraction()" (wheel)="onMapUserInteraction()">
              <app-map #map></app-map>
            </div>

            <!-- Finding driver status card -->
            @if (booking() && booking()?.status === 'searching') {
              <div class="absolute left-4 right-4 top-3 z-20 pointer-events-none">
                <div class="bg-white/95 backdrop-blur rounded-full shadow-lg px-4 py-3 pointer-events-auto">
                  <div class="flex items-center justify-center gap-3">
                    <div class="flex items-center gap-2">
                      <ion-spinner name="crescent" color="primary" class="w-4 h-4"></ion-spinner>
                      <span class="text-slate-900 font-semibold text-sm">Finding driver</span>
                    </div>
                    <span class="text-xs text-slate-600">We're looking for a nearby driver</span>
                    <span class="text-xs text-blue-600 font-medium">{{ formatFindingDriverTime() }}</span>
                  </div>
                </div>
              </div>
            }

            <!-- Recenter button -->
            @if (!autoFollowEnabled) {
              <button
                type="button"
                (click)="recenterMap()"
                class="absolute right-3 bottom-3 z-20 w-12 h-12 bg-white rounded-full shadow-lg border border-slate-200 flex items-center justify-center hover:bg-slate-50 transition-colors"
                title="Recenter map"
              >
                <ion-icon name="navigate-outline" class="text-xl text-slate-700"></ion-icon>
              </button>
            }

            <!-- Compact status pill -->
            @if (booking() && isLiveTrackingJob()) {
              <div class="absolute left-4 right-4 top-3 z-20 pointer-events-none">
                <div class="bg-white/95 backdrop-blur rounded-full shadow-lg px-4 py-2 pointer-events-auto">
                  <div class="flex items-center justify-center gap-3">
                    <span class="text-slate-900 font-semibold text-sm" style="color: #0f172a;">{{ bookingStatusLabel() }}</span>
                    @if (etaMinutes() !== null && distanceKm() !== null) {
                      <span class="text-xs text-slate-600" style="color: #475569;"> • {{ etaMinutes() }} mins • {{ distanceKm() }} km</span>
                    }
                  </div>
                </div>
              </div>
            }





          </div>
            <div
              class="absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-[2rem] border-t border-slate-100 bg-white p-3 shadow-2xl transition-all duration-300 ion-padding-bottom"
              [class.transition-none]="isDraggingSheet()"
              [style.height.%]="trackingSheetHeight()"
              (focusin)="expandSheetForFocus()"
            >
            <div class="shrink-0 -mx-3 -mt-3 rounded-t-[2rem] bg-white/95 backdrop-blur border-b border-slate-100">
              <button
                type="button"
                class="flex w-full cursor-grab select-none touch-none items-center justify-center rounded-t-[2rem] py-3 active:cursor-grabbing"
                (click)="cycleSheetState()"
                (pointerdown)="startSheetDrag($event)"
                [attr.aria-label]="sheetState() === 'expanded' ? 'Collapse to 40%' : 'Expand to 80%'"
              >
                <span class="w-16 h-1.5 bg-slate-400 rounded-full shadow-md"></span>
              </button>

              <div class="px-3 pb-3">
                <div class="rounded-2xl border border-slate-100 bg-slate-50/80 p-1.5 shadow-inner shadow-slate-200/40">
                  <div class="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  @for (tab of trackingTabs; track tab.id) {
                    <button
                      type="button"
                      (click)="setActiveTrackingTab(tab.id)"
                      class="relative min-w-0 h-12 rounded-xl px-1.5 py-1 text-[11px] font-semibold leading-tight border transition-all inline-flex flex-col items-center justify-center gap-0.5 active:scale-[0.98] hover:shadow-sm"
                      [class.bg-amber-500]="activeTrackingTab() === tab.id"
                      [class.text-white]="activeTrackingTab() === tab.id"
                      [class.border-amber-500]="activeTrackingTab() === tab.id"
                      [class.shadow-md]="activeTrackingTab() === tab.id"
                      [class.shadow-amber-500/20]="activeTrackingTab() === tab.id"
                      [class.bg-white]="activeTrackingTab() !== tab.id"
                      [class.text-slate-700]="activeTrackingTab() !== tab.id"
                      [class.border-slate-200]="activeTrackingTab() !== tab.id"
                    >
                      <ion-icon
                        [name]="tab.icon"
                        class="text-[17px] shrink-0"
                        [attr.aria-label]="tab.label + ' tab icon'"
                      ></ion-icon>
                      <span class="block max-w-full truncate">{{ tab.label }}</span>
                      @if (tab.id === 'chat' && unreadMessageCount() > 0) {
                        <span class="absolute right-1 top-1 inline-flex min-w-4 h-4 items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-black text-white ring-2 ring-white/70">
                          {{ unreadMessageCount() }}
                        </span>
                      }
                    </button>
                  }
                  </div>
                </div>
              </div>
            </div>

            <div class="tracking-sheet-content min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-3 pt-3 pb-[calc(env(safe-area-inset-bottom)+24px)]">

            <div class="movabi-card-compact bg-gradient-to-br from-white to-slate-50" [class.hidden]="activeTrackingTab() !== 'overview'">
              <div class="flex justify-between items-start gap-4">
                <div class="min-w-0">
                  <app-badge [variant]="getStatusVariant(booking()?.status || '')" class="mb-3">
                    {{ getStatusLabel(booking()?.status || '') }}
                  </app-badge>

                  <h2 class="text-sm font-bold text-slate-900">
                    Details
                  </h2>

                  <p class="text-xs text-slate-500 mt-1">
                    {{ getStatusHint(booking()?.status || '') }}
                  </p>

                  @if (statusUpdatedLabel()) {
                    <p class="text-[11px] font-bold text-amber-600 mt-1">
                      {{ statusUpdatedLabel() }}
                    </p>
                  }

                  <p class="text-[11px] font-semibold text-slate-400 mt-2 leading-snug">
                    ID: {{ booking()?.id?.slice(0, 8) }}
                  </p>
                </div>

                <div class="text-right shrink-0">
                  <p class="movabi-price">
                    {{ getDisplayedTotal() }}
                  </p>
                  <p class="text-[11px] font-semibold text-emerald-700 mt-1">
                    {{ paymentAmountLabel() }}
                  </p>
                </div>
              </div>

              @if (booking()?.status === 'searching') {
                <div class="mt-3 grid grid-cols-2 gap-2">
                  <div class="movabi-card-compact bg-blue-50 border-blue-100 shadow-none">
                    <div class="flex items-center gap-2 mb-1">
                      <ion-icon name="timer-outline" class="text-blue-600"></ion-icon>
                      <p class="text-xs font-semibold text-blue-700">Time</p>
                    </div>
                    <p class="text-base font-display font-semibold text-slate-900">
                      {{ searchCountdownLabel() }}
                    </p>
                  </div>

                  <div class="movabi-card-compact bg-slate-50 shadow-none">
                    <div class="flex items-center gap-2 mb-1">
                      <ion-icon name="refresh-outline" class="text-slate-500"></ion-icon>
                      <p class="text-xs font-semibold text-slate-500">Search</p>
                    </div>
                    <p class="text-sm font-bold text-slate-900">Looking</p>
                  </div>
                </div>
              }
            </div>

            <div class="movabi-card-compact space-y-3" [class.hidden]="activeTrackingTab() !== 'overview'">
              <div class="flex items-start gap-3">
                <div class="w-11 h-11 rounded-2xl bg-amber-50 text-amber-600 border border-amber-100 flex items-center justify-center shrink-0">
                  <ion-icon [name]="serviceGuideIcon()" class="text-xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <p class="text-[10px] font-black uppercase tracking-widest text-amber-600">
                    {{ serviceGuideEyebrow() }}
                  </p>
                  <h3 class="mt-1 text-sm font-bold text-slate-900">
                    {{ serviceGuideTitle() }}
                  </h3>
                  <p class="mt-1 text-xs text-slate-500">
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
                      <p class="text-xs font-black text-slate-950 leading-snug break-words">{{ step.title }}</p>
                      <p class="text-[11px] font-semibold text-slate-500 leading-snug">{{ step.description }}</p>
                    </div>
                  </div>
                }
              </div>
            </div>

            <div class="movabi-card-compact bg-white border border-slate-100" [class.hidden]="activeTrackingTab() !== 'payment'">
              <div class="flex items-start justify-between gap-4">
                <div class="min-w-0">
                  <p class="text-[10px] font-black uppercase tracking-widest text-slate-400">Payment</p>
                  <h3 class="mt-1 text-sm font-bold text-slate-900">{{ paymentAmountLabel() }}</h3>
                  <p class="mt-1 text-xs font-semibold text-slate-500 leading-snug">Wallet/card reservation is protected by Movabi until the request is complete.</p>
                </div>
                <p class="movabi-price shrink-0">{{ getDisplayedTotal() }}</p>
              </div>
            </div>
            @if (showPaymentProtectionPanel()) {
              <div class="movabi-card-compact border-amber-100 bg-amber-50 space-y-3" [class.hidden]="activeTrackingTab() !== 'payment'">
                <div class="flex items-start gap-3">
                  <div class="w-11 h-11 rounded-2xl bg-white text-amber-600 border border-amber-100 flex items-center justify-center shadow-sm shrink-0">
                    <ion-icon [name]="paymentProtectionIcon()" class="text-xl"></ion-icon>
                  </div>

                  <div class="min-w-0">
                    <p class="text-[10px] font-black uppercase tracking-widest text-amber-700">
                      Payment protection
                    </p>
                    <h3 class="mt-1 text-sm font-bold text-slate-900">
                      {{ paymentProtectionTitle() }}
                    </h3>
                    <p class="mt-1 text-xs font-semibold text-slate-700 leading-snug">
                      {{ paymentProtectionMessage() }}
                    </p>
                  </div>
                </div>

                <div class="rounded-2xl bg-white/85 border border-amber-100 p-3 space-y-2 text-sm font-bold text-slate-700">
                  <div class="flex items-center justify-between gap-3">
                    <span>Reserved</span>
                    <span class="text-slate-950">{{ getDisplayedTotal() }}</span>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <span>Returns to</span>
                    <span class="text-right text-slate-950">{{ paymentProtectionDestination() }}</span>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <span>Status</span>
                    <span class="text-right text-amber-700">{{ paymentProtectionStatus() }}</span>
                  </div>
                </div>
              </div>
            }

            @if (showCompletionPinPanel()) {
              <div class="movabi-card-compact border-emerald-100 bg-emerald-50 space-y-3" [class.hidden]="activeTrackingTab() !== 'overview'">
                <div class="flex items-start gap-3">
                  <div class="w-11 h-11 rounded-2xl bg-white text-emerald-600 border border-emerald-100 flex items-center justify-center shadow-sm shrink-0">
                    <ion-icon name="shield-checkmark-outline" class="text-xl"></ion-icon>
                  </div>

                  <div class="min-w-0 flex-1">
                    <p class="text-[10px] font-black uppercase tracking-widest text-emerald-700">
                      Handover PIN
                    </p>
                    <div class="mt-2 flex items-center justify-between gap-3">
                      <h3 class="text-sm font-bold text-slate-900">
                        Complete with PIN
                      </h3>
                      <div class="px-4 py-2 rounded-2xl bg-white text-xl font-display font-bold tracking-[0.35em] text-slate-950 border border-emerald-100">
                        {{ completionPinForCustomer() }}
                      </div>
                    </div>
                    <p class="mt-1 text-xs font-semibold text-slate-700 leading-snug">
                      Share this PIN only when the service is finished.
                    </p>
                  </div>
                </div>
              </div>
            }

            @if (booking()?.service_slug === ServiceTypeEnum.ERRAND && errandFunding()) {
              <div class="grid grid-cols-2 gap-3" [class.hidden]="activeTrackingTab() !== 'payment'">
                  <div class="movabi-card-compact bg-slate-50 shadow-none">
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Service Fee</p>
                  <p class="text-base font-display font-semibold text-slate-900">
                    {{ config.formatCurrency(getErrandServiceFee()) }}
                  </p>
                </div>

                  <div class="movabi-card-compact bg-slate-50 shadow-none">
                  <p class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Item Budget</p>
                  <p class="text-base font-display font-semibold text-slate-900">
                    {{ config.formatCurrency(getErrandItemBudget()) }}
                  </p>
                </div>

                @if (getErrandReleasedAmount() > 0) {
                  <div class="col-span-2 movabi-card-compact bg-emerald-50 border-emerald-100 shadow-none">
                    <p class="text-[9px] font-bold text-emerald-700 uppercase tracking-widest mb-1">Returned to wallet</p>
                    <p class="text-base font-display font-semibold text-emerald-700">
                      {{ config.formatCurrency(getErrandReleasedAmount()) }}
                    </p>
                  </div>
                }
              </div>
            }

            @if (booking()?.driver_id) {
              @if (errandFunding()?.over_budget_status === 'requested') {
                <div class="movabi-card-compact bg-rose-50 border-rose-100" [class.hidden]="activeTrackingTab() !== 'payment'">
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
                          Driver note
                        </p>
                        <p class="text-sm font-semibold text-slate-800 leading-relaxed">
                          {{ getOverBudgetReason() }}
                        </p>
                      </div>
                    }

                    @if (getExtraBudgetShortfall() > 0) {
                      <div class="p-3 bg-amber-50 rounded-xl border border-amber-200">
                        <p class="text-[10px] font-bold text-amber-700 uppercase tracking-widest mb-1">
                          Top-up needed
                        </p>
                        <p class="text-sm font-semibold text-slate-700 leading-snug">
                          Add {{ config.formatCurrency(getExtraBudgetShortfall()) }} to approve this extra budget.
                        </p>
                      </div>
                    }
                  </div>

                  <div class="grid grid-cols-2 gap-3" [class.hidden]="activeTrackingTab() !== 'payment'">
                    <app-button variant="secondary" color="error" size="md" (clicked)="rejectOverBudget()">
                      Reject
                    </app-button>

                    <app-button variant="primary" color="success" size="md" (clicked)="approveOverBudget()">
                      Approve
                    </app-button>
                  </div>
                </div>
              }

              <div class="movabi-card-compact" [class.hidden]="activeTrackingTab() !== 'overview'">
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
                    <h3 class="text-base font-bold text-slate-900 leading-tight break-words">
                      {{ getDriverName() }}
                    </h3>
                    <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1 leading-snug break-words">
                      {{ getDriverStatusText() }}
                    </p>

                    <div class="mt-2 grid grid-cols-1 gap-2">
                      <div class="rounded-2xl bg-slate-50 border border-slate-100 px-3 py-2">
                        <p class="text-[9px] text-slate-400 font-black uppercase tracking-widest">Transport</p>
                        <p class="text-sm text-slate-900 font-black leading-tight break-words">{{ getDriverVehicleSummary() }}</p>
                        <p class="text-[11px] text-slate-500 font-semibold leading-snug break-words">{{ getDriverVehicleMeta() }}</p>
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

              <div class="pt-2 space-y-3" [class.hidden]="activeTrackingTab() !== 'chat'">
                @if (booking()?.driver_id) {
                  <div class="h-[min(58vh,520px)] min-h-[360px] border border-slate-100 rounded-[1.5rem] overflow-hidden shadow-lg shadow-slate-200/50">
                    <app-communication-panel
                      [jobId]="booking()!.id"
                      [receiverId]="booking()!.driver_id!"
                      [receiverPhone]="booking()?.driver?.phone"
                    ></app-communication-panel>
                  </div>
                } @else {
                  <div class="movabi-card-compact bg-slate-50 border border-slate-100 text-center">
                    <div class="mx-auto mb-3 w-12 h-12 rounded-2xl bg-white border border-slate-100 flex items-center justify-center text-amber-600 shadow-sm">
                      <ion-icon name="chatbubble-ellipses-outline" class="text-2xl"></ion-icon>
                    </div>
                    <h3 class="text-base font-bold text-slate-900">Chat not available yet</h3>
                    <p class="mt-2 text-sm font-semibold text-slate-500 leading-relaxed">
                      Chat will be available when a driver accepts your request.
                    </p>
                  </div>
                }
              </div>
            }

            <div class="movabi-card-compact bg-slate-50 shadow-none" [class.hidden]="activeTrackingTab() !== 'route'">
              <div class="flex items-center gap-2 mb-4">
                <div class="w-10 h-10 rounded-xl bg-white border border-slate-100 flex items-center justify-center text-slate-700 shadow-sm">
                  <ion-icon name="navigate" class="text-xl"></ion-icon>
                </div>
                <div>
                  <h3 class="text-sm font-bold text-slate-900">{{ routeCardTitle() }}</h3>
                  <p class="text-xs text-slate-500">{{ routeCardSubtitle() }}</p>
                </div>
              </div>

              <div class="relative pl-10 space-y-8">
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

            <div class="movabi-card-compact bg-white border border-slate-100" [class.hidden]="activeTrackingTab() !== 'details'">
              <div class="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p class="text-[10px] font-black uppercase tracking-widest text-slate-400">Request ID</p>
                  <p class="mt-1 font-bold text-slate-900">{{ booking()?.id?.slice(0, 8) }}</p>
                </div>
                <div>
                  <p class="text-[10px] font-black uppercase tracking-widest text-slate-400">Service</p>
                  <p class="mt-1 font-bold text-slate-900 capitalize">{{ booking()?.service_slug || 'Request' }}</p>
                </div>
                <div class="col-span-2">
                  <p class="text-[10px] font-black uppercase tracking-widest text-slate-400">Status</p>
                  <p class="mt-1 font-bold text-slate-900">{{ getStatusLabel(booking()?.status || '') }}</p>
                </div>
              </div>
            </div>
            @if (details()) {
              <div class="pt-2" [class.hidden]="activeTrackingTab() !== 'details'">
                <div class="flex items-center gap-2 mb-4">
                  <div class="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-700 shadow-sm">
                    <ion-icon name="sparkles-outline" class="text-xl"></ion-icon>
                  </div>
                  <div>
                  <h3 class="text-sm font-bold text-slate-900">Details</h3>
                  <p class="text-xs text-slate-500">More info</p>
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-2">
                  @if (booking()?.service_slug === ServiceTypeEnum.RIDE) {
                    <div class="movabi-card-compact bg-slate-50 shadow-none">
                      <p class="text-xs font-semibold text-slate-500 mb-1">Passengers</p>
                      <p class="text-xl font-display font-bold text-slate-900">
                        {{ details()?.['passenger_count'] || 1 }}
                      </p>
                    </div>
                  }

                  @if (booking()?.service_slug === ServiceTypeEnum.VAN) {
                    <div class="movabi-card-compact bg-slate-50 shadow-none">
                      <p class="text-xs font-semibold text-slate-500 mb-1">Helpers</p>
                      <p class="text-xl font-display font-bold text-slate-900">
                        {{ details()?.['helper_count'] || 0 }}
                      </p>
                    </div>
                  }
                </div>

                @if (booking()?.service_slug === ServiceTypeEnum.ERRAND) {
                  <div class="movabi-card-compact bg-slate-50 shadow-none mt-3">
                    <div class="flex justify-between items-center mb-3 gap-3">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Items</p>

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

                    <div class="mt-4 pt-4 border-t border-slate-200/50 space-y-3">
                      <div class="flex justify-between items-center">
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Budget</span>
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

            <div class="pt-4 space-y-3" [class.hidden]="activeTrackingTab() !== 'help'">
              <div class="movabi-card-compact bg-white border border-slate-100 space-y-3">
                <div class="flex items-start gap-3">
                  <div class="w-11 h-11 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-600 shrink-0">
                    <ion-icon name="help-circle-outline" class="text-2xl"></ion-icon>
                  </div>
                  <div class="min-w-0">
                    <h3 class="text-base font-bold text-slate-900">Help & support</h3>
                    <p class="mt-1 text-sm font-semibold text-slate-500 leading-relaxed">
                      Get help with this booking, safety, cancellation, or lost items.
                    </p>
                  </div>
                </div>

                <div class="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    (click)="contactSupport()"
                    class="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left font-bold text-slate-900 flex items-center gap-3 active:scale-[0.99]"
                  >
                    <ion-icon name="chatbubble-ellipses-outline" class="text-xl text-amber-600 shrink-0"></ion-icon>
                    <span>Contact support</span>
                  </button>

                  <button
                    type="button"
                    (click)="reportIssue()"
                    class="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left font-bold text-slate-900 flex items-center gap-3 active:scale-[0.99]"
                  >
                    <ion-icon name="flag-outline" class="text-xl text-amber-600 shrink-0"></ion-icon>
                    <span>Report issue</span>
                  </button>

                  <button
                    type="button"
                    (click)="openSafetyHelp()"
                    class="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left font-bold text-slate-900 flex items-center gap-3 active:scale-[0.99]"
                  >
                    <ion-icon name="shield-checkmark-outline" class="text-xl text-emerald-600 shrink-0"></ion-icon>
                    <span>Safety/help</span>
                  </button>

                  @if (booking()?.status === 'completed') {
                    <button
                      type="button"
                      (click)="reportLostItem()"
                      class="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left font-bold text-slate-900 flex items-center gap-3 active:scale-[0.99]"
                    >
                      <ion-icon name="archive-outline" class="text-xl text-amber-600 shrink-0"></ion-icon>
                      <span>Lost item</span>
                    </button>
                    <app-button variant="primary" size="lg" (clicked)="showRating()" class="w-full">
                      <ion-icon name="checkmark-circle-outline" slot="start" class="mr-2"></ion-icon>
                      Rate Experience
                    </app-button>
                  } @else {
                    <button
                      type="button"
                      disabled
                      class="w-full rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-left font-bold text-slate-400 flex items-start gap-3"
                    >
                      <ion-icon name="archive-outline" class="mt-0.5 text-xl shrink-0"></ion-icon>
                      <span>Lost item <span class="block text-xs font-semibold">{{ lostItemUnavailableReason() }}</span></span>
                    </button>
                  }

                  @if (canManuallyCancel()) {
                    <app-button variant="outline" color="error" size="lg" (clicked)="cancelBooking()" class="w-full">
                      <ion-icon name="close-circle-outline" slot="start" class="mr-2"></ion-icon>
                      Cancel request
                    </app-button>
                  } @else {
                    <button
                      type="button"
                      disabled
                      class="w-full rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-left font-bold text-slate-400 flex items-start gap-3"
                    >
                      <ion-icon name="close-circle-outline" class="mt-0.5 text-xl shrink-0"></ion-icon>
                      <span>Cancel request <span class="block text-xs font-semibold">{{ cancelUnavailableReason() }}</span></span>
                    </button>
                  }
                </div>
              </div>
            </div>
            </div>
          </div>
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
    private routingService = inject(RoutingService);
    private nativePlatform = inject(NativePlatformService);
    private auth = inject(AuthService);
    private notificationOrchestrator = inject(NotificationOrchestratorService);

    private localSearchFallbackExpiresAt: number | null = null;
    private messageCountWarningShown = false;

    public config = inject(AppConfigService);

    ServiceTypeEnum = ServiceTypeEnum;

    booking = this.bookingService.activeBooking;

    details = signal<Record<string, any> | null>(null);
    errandFunding = signal<ErrandFunding | null>(null);

    isLoading = signal(true);
    showChat = signal(false);
    activeTrackingTab = signal<CustomerTrackingTab>('overview');
    messageCount = signal(0);
    unreadMessageCount = computed(() => {
        const bookingId = this.booking()?.id;
        return bookingId ? this.notificationOrchestrator.getBadgeCount(bookingId) : 0;
    });
    trackingTabs: Array<{ id: CustomerTrackingTab; label: string; icon: string }> = [
        { id: 'overview', label: 'Overview', icon: 'information-circle-outline' },
        { id: 'route', label: 'Route', icon: 'navigate-circle-outline' },
        { id: 'details', label: 'Details', icon: 'document-text-outline' },
        { id: 'chat', label: 'Chat', icon: 'chatbubble-ellipses-outline' },
        { id: 'payment', label: 'Payment', icon: 'wallet-outline' },
        { id: 'help', label: 'Help', icon: 'help-circle-outline' }
    ];
    sheetState = signal<SheetState>('medium');
    detailsExpanded = signal(false);
    trackingSheetHeight = signal(40);
    isDraggingSheet = signal(false);
    sheetDragMoved = false;
    sheetDragStartY = 0;
    sheetDragStartHeight = 0;
    driverDistanceToPickup = signal<number | null>(null);
    driverEtaToPickup = signal<number | null>(null);
    driverLastSeenAt = signal<Date | null>(null);
    etaMinutes = signal<number | null>(null);
    distanceKm = signal<number | null>(null);

    searchCountdownSeconds = signal(DRIVER_SEARCH_WINDOW_SECONDS);
    findingDriverElapsedSeconds = signal(0);

    
    searchProgressPercent = computed(() => {
        const val = Math.max(0, Math.min(DRIVER_SEARCH_WINDOW_SECONDS, this.searchCountdownSeconds()));
        return (val / DRIVER_SEARCH_WINDOW_SECONDS) * 100;
    });

    private channel?: RealtimeChannel;
    private errandFundingChannel?: RealtimeChannel;
    private jobEventsChannel?: RealtimeChannel;
    private messageChannel?: RealtimeChannel;
    private locationSubscription?: RealtimeChannel;
    private subscribedDriverLocationId: string | null = null;
    private latestDriverPoint: { lat: number; lng: number } | null = null;
    private activeRouteDrawnFor: string | null = null;
    private hasFitTrackingMap = false;
    private hasAutoFitted = false;
    private lastDriverCameraUpdateAt = 0;
    private lastNotifiedStatus: string | null = null;
    
    // Map control properties
    private userIsInteracting = false;
    private lastUserInteractionTime = 0;
    autoFollowEnabled = true;
    private readonly USER_INTERACTION_TIMEOUT = 30000; // 30 seconds
    
    // New single tracking renderer properties
    hasInitialFit = false;
    userMovedMap = false;
    followMode = true;
    didCleanTrackingMarkers = false;
    private lastStatusEventAt = signal<Date | null>(null);

    private pollingInterval?: ReturnType<typeof setInterval>;
    private countdownInterval?: ReturnType<typeof setInterval>;
    private findingDriverTimerInterval?: ReturnType<typeof setInterval>;

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
            homeOutline,
            informationCircleOutline,
            navigateCircleOutline,
            documentTextOutline,
            chatbubbleEllipsesOutline,
            walletOutline,
            helpCircleOutline
        });
    }

    sheetHeightClass(): string {
        switch (this.sheetState()) {
            case 'expanded':
                return 'h-[80vh]';
            default:
                return 'h-[40vh]';
        }
    }


    setActiveTrackingTab(tab: CustomerTrackingTab): void {
        this.activeTrackingTab.set(tab);
        if (tab === 'chat') {
            this.showChat.set(true);
            // Mark messages as read using NotificationOrchestrator
            const bookingId = this.booking()?.id;
            if (bookingId) {
                void this.notificationOrchestrator.markAsRead(bookingId);
            }
        }
        if (tab === 'route') {
            setTimeout(() => this.recenterMap(), 120);
        }
    }
    cycleSheetState(): void {
        if (this.sheetDragMoved) {
            this.sheetDragMoved = false;
            return;
        }

        // Uber/Bolt-style snap points: 40% -> 80% -> 95% -> 40%
        const currentHeight = this.trackingSheetHeight();
        let nextHeight: number;
        
        if (currentHeight <= 50) {
            nextHeight = 80; // 40% -> 80%
        } else if (currentHeight <= 85) {
            nextHeight = 95; // 80% -> 95%
        } else {
            nextHeight = 40; // 95% -> 40%
        }
        
        this.trackingSheetHeight.set(nextHeight);
        this.updateSheetState(nextHeight);
    }

    expandSheetForFocus(): void {
        if (this.trackingSheetHeight() < 80) {
            this.trackingSheetHeight.set(80);
            this.updateSheetState(80);
        }
    }

    private updateSheetState(height: number): void {
        let newState: SheetState;
        if (height <= 50) {
            newState = 'collapsed';
        } else if (height <= 85) {
            newState = 'medium';
        } else {
            newState = 'expanded';
        }
        this.sheetState.set(newState);
    }

    async ngOnInit(): Promise<void> {
        const id = this.route.snapshot.paramMap.get('id');

        if (!id) {
            this.isLoading.set(false);
            return;
        }

        this.channel = this.bookingService.subscribeToBooking(id);
        this.subscribeToErrandFunding(id);
        this.subscribeToJobEvents(id);
        this.subscribeToJobMessages(id);

        // Subscribe to notifications for this job
        this.notificationOrchestrator.subscribeToJob(id);

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
        this.jobEventsChannel?.unsubscribe();
        this.messageChannel?.unsubscribe();
        
        // Unsubscribe from notifications
        const bookingId = this.booking()?.id;
        if (bookingId) {
            this.notificationOrchestrator.unsubscribeFromJob(bookingId);
        }
        this.locationSubscription?.unsubscribe();
        this.subscribedDriverLocationId = null;
    }

    
    startSheetDrag(event: PointerEvent): void {
        event.preventDefault();
        this.isDraggingSheet.set(true);
        this.sheetDragMoved = false;
        this.sheetDragStartY = event.clientY;
        this.sheetDragStartHeight = this.trackingSheetHeight();

        const move = (moveEvent: PointerEvent) => {
            const delta = Math.abs(moveEvent.clientY - this.sheetDragStartY);
            if (delta > 4) {
                this.sheetDragMoved = true;
            }

            const viewportHeight = Math.max(window.innerHeight, 1);
            const deltaVh = ((this.sheetDragStartY - moveEvent.clientY) / viewportHeight) * 100;
            const nextHeight = Math.max(40, Math.min(95, this.sheetDragStartHeight + deltaVh));
            this.trackingSheetHeight.set(nextHeight);
        };

        const end = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            document.removeEventListener('pointercancel', end);
            
            // Snap to nearest point: 40%, 80%, or 95%
            const currentHeight = this.trackingSheetHeight();
            let snapHeight: number;
            
            if (currentHeight <= 60) {
                snapHeight = 40;
            } else if (currentHeight <= 87) {
                snapHeight = 80;
            } else {
                snapHeight = 95;
            }
            
            this.trackingSheetHeight.set(snapHeight);
            this.updateSheetState(snapHeight);

            window.setTimeout(() => {
                this.isDraggingSheet.set(false);
                this.sheetDragMoved = false;
            }, 0);
        };

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end, { once: true });
        document.addEventListener('pointercancel', end, { once: true });
    }

    onSheetDrag(_event: PointerEvent): void {
        // Kept for template/backward compatibility; drag movement is handled by document listeners.
    }

    endSheetDrag(): void {
        // Kept for template/backward compatibility; drag end is handled by document listeners.
    }

    startDetailsPointerDrag(event: PointerEvent): void {
        this.startSheetDrag(event);
    }

    private async notifyStatusChange(previousStatus: string, booking: Booking): Promise<void> {
        const status = String(booking.status || '');
        if (!status || !previousStatus || previousStatus === status || this.lastNotifiedStatus === status) return;

        this.lastNotifiedStatus = status;
        this.lastStatusEventAt.set(this.toDate((booking as any).updated_at) || new Date());
        
        // Trigger comprehensive notification using notification manager
        await this.triggerStatusNotification(status, booking);
        
        // Keep existing notification for backward compatibility
        await this.notifyTrackingUpdate(status, booking.id);
    }

    private async triggerStatusNotification(status: string, booking: Booking): Promise<void> {
        const statusLabel = this.getStatusLabel(status);
        const jobId = booking.id;
        
        // Map status to notification event type
        const notificationTypeMap: Record<string, any> = {
            'accepted': 'driver_accepted_booking',
            'arrived': 'driver_arrived',
            'in_progress': 'driver_started_trip',
            'shopping_in_progress': 'driver_completed_shopping',
            'collected': 'driver_collected_items',
            'en_route_to_customer': 'driver_en_route',
            'completed': 'driver_completed_trip',
            'cancelled': 'customer_cancelled',
            'canceled': 'customer_cancelled',
            'over_budget_requested': 'extra_budget_requested'
        };

        const notificationType = notificationTypeMap[status];
        if (notificationType) {
            // Notification is now handled by NotificationOrchestrator
        }
    }

    private async notifyTrackingUpdate(status: string, bookingId: string): Promise<void> {
        const title = this.trackingTitle();
        const body = this.getStatusHint(status) || this.getStatusLabel(status);

        await Promise.allSettled([
            this.nativePlatform.showForegroundNotification(title, body, {
                route: `/customer/tracking/${bookingId}`,
                bookingId,
                status
            }),
            this.playStatusTone()
        ]);
    }

    private async playStatusTone(): Promise<void> {
        if (this.nativePlatform.isNative) return;

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

    getStatusVariant(
        status: string
    ): 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' {
        switch (status) {
            case 'pending_fare_confirmation':
            case 'negotiating':
            case 'searching':
            case 'no_driver_found':
            case 'requires_review':
                return 'warning';
            case 'fare_agreed':
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
            const errandMap: Record<string, string> = this.isShoppingErrand()
                ? {
                    pending_fare_confirmation: 'Confirm fare',
                    negotiating: 'Negotiating',
                    fare_agreed: 'Fare agreed',
                    searching: 'Finding driver',
                    accepted: 'Assigned',
                    assigned: 'Assigned',
                    heading_to_pickup: 'To store',
                    arrived: 'Arrived',
                    arrived_at_store: 'At store',
                    shopping_in_progress: 'Shopping',
                    collected: 'Collected',
                    en_route_to_customer: 'On the way',
                    delivered: 'Delivered',
                    completed: 'Complete',
                    settled: 'Settled',
                    over_budget_requested: 'Budget needed',
                    cancelled: 'Cancelled',
                    canceled: 'Cancelled',
                    no_driver_found: 'No driver',
                    requires_review: 'Review'
                }
                : {
                    pending_fare_confirmation: 'Confirm fare',
                    negotiating: 'Negotiating',
                    fare_agreed: 'Fare agreed',
                    searching: 'Finding driver',
                    accepted: 'Assigned',
                    assigned: 'Assigned',
                    heading_to_pickup: 'To collection',
                    arrived: 'Arrived',
                    arrived_at_store: 'At pickup',
                    shopping_in_progress: 'Collecting',
                    collected: 'Collected',
                    en_route_to_customer: 'On the way',
                    delivered: 'Delivered',
                    completed: 'Complete',
                    settled: 'Settled',
                    over_budget_requested: 'Budget needed',
                    cancelled: 'Cancelled',
                    canceled: 'Cancelled',
                    no_driver_found: 'No driver',
                    requires_review: 'Review'
                };

            if (errandMap[status]) return errandMap[status];
        }

        const map: Record<string, string> = {
            pending_fare_confirmation: 'Confirm fare',
            negotiating: 'Negotiating',
            fare_agreed: 'Fare agreed',
            searching: 'Searching',
            accepted: 'Assigned',
            assigned: 'Assigned',
            heading_to_pickup: 'To pickup',
            arrived: 'Arrived',
            in_progress: 'In progress',
            arrived_at_store: 'At store',
            shopping_in_progress: 'Shopping',
            collected: 'Collected',
            en_route_to_customer: 'On the way',
            delivered: 'Delivered',
            completed: 'Completed',
            settled: 'Settled',
            cancelled: 'Cancelled',
            canceled: 'Cancelled',
            no_driver_found: 'No driver',
            requires_review: 'Review'
        };

        return map[status] ?? status.replace(/_/g, ' ');
    }

    getStatusHint(status: string): string {
        if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
            const errandMap: Record<string, string> = this.isShoppingErrand()
                ? {
                    pending_fare_confirmation: 'Please confirm the fare.',
                    negotiating: 'Fare is being negotiated.',
                    fare_agreed: 'Fare agreed. Finding a driver.',
                    searching: 'Finding a shopper.',
                    accepted: 'Driver is going to the store..',
                    assigned: 'Driver is going to the store..',
                    heading_to_pickup: 'Driver is going to the store.',
                    arrived: 'Driver is at the store.',
                    arrived_at_store: 'Driver is ready to shop.',
                    shopping_in_progress: 'Shopping in progress.',
                    collected: 'Items collected.',
                    en_route_to_customer: 'Driver is on the way..',
                    delivered: 'Items have been delivered',
                    completed: 'Shop is complete',
                    settled: 'Wallet funds have been settled',
                    over_budget_requested: 'Extra budget needed.',
                    cancelled: 'Cancelled',
                    canceled: 'Cancelled',
                    no_driver_found: 'No available shop driver',
                    requires_review: 'Under review.'
                }
                : {
                    pending_fare_confirmation: 'Please confirm the fare.',
                    negotiating: 'Fare is being negotiated.',
                    fare_agreed: 'Fare agreed. Finding a driver.',
                    searching: 'Finding a driver.',
                    accepted: 'Driver is going to collect.',
                    assigned: 'Driver is going to collect.',
                    heading_to_pickup: 'Driver is going to collect.',
                    arrived: 'Driver is at pickup.',
                    arrived_at_store: 'Driver is collecting.',
                    shopping_in_progress: 'Collection in progress.',
                    collected: 'Item collected.',
                    en_route_to_customer: 'Driver is on the way..',
                    delivered: 'Item has been delivered',
                    completed: 'Shop is complete',
                    settled: 'Payment has been settled',
                    over_budget_requested: 'Driver needs your approval before continuing',
                    cancelled: 'Cancelled',
                    canceled: 'Cancelled',
                    no_driver_found: 'No available shop driver',
                    requires_review: 'Under review.'
                };

            if (errandMap[status]) return errandMap[status];
        }

        const map: Record<string, string> = {
            pending_fare_confirmation: 'Please confirm the fare.',
            negotiating: 'Fare is being negotiated.',
            fare_agreed: 'Fare agreed. Finding a driver.',
            searching: 'Finding nearby drivers.',
            accepted: 'Driver is coming.',
            assigned: 'Driver is coming.',
            heading_to_pickup: 'Driver is on the way.',
            arrived: 'Driver arrived.',
            in_progress: 'In progress.',
            arrived_at_store: 'Driver at store.',
            shopping_in_progress: 'Shopping.',
            collected: 'Items have been collected',
            en_route_to_customer: 'Driver is on the way.',
            delivered: 'Delivered.',
            completed: 'Completed.',
            settled: 'Settled.',
            cancelled: 'Cancelled.',
            canceled: 'Cancelled.',
            no_driver_found: 'No driver available.',
            requires_review: 'Under review.'
        };

        return map[status] ?? 'Live updates.';
    }

    trackingTitle(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Shop Tracking';
            case ServiceTypeEnum.DELIVERY:
                return 'Deliver Tracking';
            case ServiceTypeEnum.VAN:
                return 'Move Tracking';
            default:
                return 'Live Tracking';
        }
    }

    routeCardTitle(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Route';
            case ServiceTypeEnum.DELIVERY:
                return 'Route';
            case ServiceTypeEnum.VAN:
                return 'Route';
            default:
                return 'Route';
        }
    }

    routeCardSubtitle(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return this.isShoppingErrand() ? 'Shop to delivery' : 'Collection to delivery';
            case ServiceTypeEnum.DELIVERY:
                return 'Collection to recipient';
            case ServiceTypeEnum.VAN:
                return 'Move route';
            default:
                return 'Route details';
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
                return 'Errand';
            case ServiceTypeEnum.DELIVERY:
                return 'Delivery';
            case ServiceTypeEnum.VAN:
                return 'Move';
            default:
                return 'Ride';
        }
    }

    serviceGuideTitle(): string {
        switch (this.booking()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return this.isShoppingErrand()
                    ? 'Shop & deliver'
                    : 'Collect & deliver';
            case ServiceTypeEnum.DELIVERY:
                return 'Tracked delivery';
            case ServiceTypeEnum.VAN:
                return 'Move tracking';
            default:
                return 'Live tracking';
        }
    }

    serviceGuideMessage(): string {
        const status = String(this.booking()?.status || '');

        if (status === 'no_driver_found') {
            return 'No driver accepted. Any reserved payment is protected.';
        }

        if (status === 'cancelled' || status === 'canceled') {
            return 'Booking cancelled. Reserved funds are shown below.';
        }

        if (this.booking()?.service_slug === ServiceTypeEnum.ERRAND) {
            return this.isShoppingErrand()
                ? 'Item budget is separate. Driver records spend and uploads receipt.'
                : 'Driver collects and delivers. No shopping receipt needed.';
        }

        if (this.booking()?.service_slug === ServiceTypeEnum.DELIVERY) {
            return 'Track collection, courier movement, and delivery.';
        }

        if (this.booking()?.service_slug === ServiceTypeEnum.VAN) {
            return 'Track arrival, loading, travel, unloading, and completion.';
        }

        return 'See assignment, pickup, and trip progress.';
    }

    serviceProgressSteps(): Array<{ title: string; description: string; icon: string; state: 'done' | 'active' | 'pending' }> {
        const service = this.booking()?.service_slug;
        const status = String(this.booking()?.status || '');
        const done = (statuses: string[]) => statuses.includes(status) ? 'active' : this.hasReachedStatus(statuses[statuses.length - 1]) ? 'done' : 'pending';

        if (service === ServiceTypeEnum.ERRAND) {
            if (!this.isShoppingErrand()) {
                return [
                    {
                        title: 'Match errand driver',
                        description: 'Driver accepts the job.',
                        icon: 'search-outline',
                        state: done(['searching', 'accepted', 'assigned'])
                    },
                    {
                        title: 'Collect item',
                        description: 'Driver collects the item.',
                        icon: 'cube-outline',
                        state: done(['heading_to_pickup', 'arrived', 'arrived_at_store', 'collected'])
                    },
                    {
                        title: 'Deliver to you',
                        description: 'Track the delivery.',
                        icon: 'navigate-outline',
                        state: done(['en_route_to_customer', 'delivered'])
                    },
                    {
                        title: 'Complete safely',
                        description: 'Complete after handover.',
                        icon: 'shield-checkmark-outline',
                        state: this.isTerminalTrackingStatus(status) ? 'active' : 'pending'
                    }
                ];
            }

            return [
                {
                    title: 'Match errand driver',
                    description: 'Driver accepts the shop.',
                    icon: 'search-outline',
                    state: done(['searching', 'accepted', 'assigned'])
                },
                {
                    title: 'Shop items',
                    description: 'Driver shops and records spend.',
                    icon: 'basket-outline',
                    state: done(['heading_to_pickup', 'arrived', 'arrived_at_store', 'shopping_in_progress'])
                },
                {
                    title: 'Deliver to you',
                    description: 'Receipt and delivery updates show here.',
                    icon: 'navigate-outline',
                    state: done(['collected', 'en_route_to_customer', 'delivered'])
                },
                {
                    title: 'Settle safely',
                    description: 'Unused budget is returned.',
                    icon: 'shield-checkmark-outline',
                    state: this.isTerminalTrackingStatus(status) ? 'active' : 'pending'
                }
            ];
        }

        if (service === ServiceTypeEnum.DELIVERY) {
            return [
                { title: 'Assign courier', description: 'Courier accepts the request.', icon: 'search-outline', state: done(['searching', 'accepted', 'assigned']) },
                { title: 'Collect package', description: 'Courier confirms collection.', icon: 'cube-outline', state: done(['heading_to_pickup', 'arrived', 'in_progress']) },
                { title: 'Deliver package', description: 'Track to delivery.', icon: 'location-outline', state: done(['en_route_to_customer', 'delivered', 'completed']) }
            ];
        }

        if (service === ServiceTypeEnum.VAN) {
            return [
                { title: 'Assign vehicle', description: 'Correct vehicle accepts the move.', icon: 'search-outline', state: done(['searching', 'accepted', 'assigned']) },
                { title: 'Load at pickup', description: 'Driver arrives and loads.', icon: 'archive-outline', state: done(['heading_to_pickup', 'arrived', 'in_progress']) },
                { title: 'Unload and finish', description: 'Complete after unload.', icon: 'checkmark-circle-outline', state: done(['delivered', 'completed', 'settled']) }
            ];
        }

        return [
            { title: 'Match driver', description: 'Driver accepts your ride.', icon: 'search-outline', state: done(['searching', 'accepted', 'assigned']) },
            { title: 'Pickup', description: 'Track pickup.', icon: 'car-sport-outline', state: done(['heading_to_pickup', 'arrived']) },
            { title: 'Ride and complete', description: 'Track to drop-off.', icon: 'flag-outline', state: done(['in_progress', 'completed', 'settled']) }
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
                return this.isShoppingErrand() ? 'Store / pickup point' : 'Collection point';
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
                return this.isShoppingErrand() ? 'STORE' : 'COLLECT';
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
        if (this.paymentNeedsReview()) return 'Review';
        return this.paidByWallet() ? 'Movabi wallet' : 'Original payment card';
    }

    paymentProtectionStatus(): string {
        if (this.paymentNeedsReview()) return 'Review in progress';
        return this.paidByWallet() ? 'Returned to wallet' : 'Released by Movabi';
    }

    completionPinForCustomer(): string {
        const metadata = this.bookingMetadata();
        return this.normalizeCompletionPin(
            metadata['completion_pin'] ||
            metadata['service_completion_pin'] ||
            metadata['delivery_pin']
        );
    }

    showCompletionPinPanel(): boolean {
        const booking = this.booking() as any;
        const status = String(booking?.status || '').toLowerCase();

        if (!booking?.driver_id || !this.completionPinForCustomer()) return false;

        return !['requested', 'searching', 'completed', 'settled', 'cancelled', 'canceled', 'no_driver_found', 'requires_review'].includes(status);
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

    servicePaymentName(): string {
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

    private bookingMetadata(): Record<string, any> {
        const raw = (this.booking() as any)?.metadata || {};

        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                return parsed && typeof parsed === 'object' ? parsed : {};
            } catch {
                return {};
            }
        }

        return raw && typeof raw === 'object' ? raw : {};
    }

    private errandMode(): ErrandMode {
        const metadata = this.bookingMetadata();
        const details = this.details() || {};
        const raw = String(
            metadata['errand_details']?.mode ||
            metadata['errand_mode'] ||
            details['errand_mode'] ||
            details['mode'] ||
            ''
        ).toLowerCase();

        if (raw === 'collect_deliver' || raw === 'quick_buy' || raw === 'shop_deliver') {
            return raw as ErrandMode;
        }

        const descriptor = [
            metadata['errand_type'],
            metadata['errand_details']?.type,
            metadata['errand_details']?.label,
            details['errand_type'],
            details['task_type'],
            details['type'],
            details['mode'],
            details['delivery_instructions']
        ].map((part) => String(part || '').toLowerCase()).join(' ');

        if (/(collect|collection|pickup|pick up|document|return|deliver only)/.test(descriptor)) {
            return 'collect_deliver';
        }

        if (/(shop|shopping|grocery|groceries|buy|purchase|quick buy)/.test(descriptor)) {
            return 'shop_deliver';
        }

        const itemBudget = this.toMoney(
            details['estimated_budget'] ||
            metadata['payment_split']?.item_budget ||
            metadata['errand_details']?.budget ||
            0
        );
        const items = details['items_list'];
        const hasItems = Array.isArray(items)
            ? items.length > 0
            : String(items || '').trim().length > 0;

        return hasItems && itemBudget > 0 ? 'shop_deliver' : 'collect_deliver';
    }

    private isShoppingErrand(): boolean {
        const mode = this.errandMode();
        return mode === 'quick_buy' || mode === 'shop_deliver';
    }

    private normalizeCompletionPin(value: unknown): string {
        return String(value ?? '').replace(/\D/g, '').slice(0, 8);
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

    private startFindingDriverTimer(): void {
        this.findingDriverElapsedSeconds.set(0);
        this.findingDriverTimerInterval = setInterval(() => {
            this.findingDriverElapsedSeconds.set(this.findingDriverElapsedSeconds() + 1);
        }, 1000);
    }

    private stopFindingDriverTimer(): void {
        if (this.findingDriverTimerInterval) {
            clearInterval(this.findingDriverTimerInterval);
            this.findingDriverTimerInterval = undefined;
        }
    }

    formatFindingDriverTime(): string {
        const seconds = this.findingDriverElapsedSeconds();
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (minutes > 0) {
            return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
        }
        return `${seconds}s`;
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

            // Start finding driver timer
            if (!this.findingDriverTimerInterval) {
                this.startFindingDriverTimer();
            }

            return;
        }

        this.resetSearchState();
        this.stopFindingDriverTimer();
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
        this.latestDriverPoint = null;
        this.activeRouteDrawnFor = null;
        
        // Remove tracking driver marker
        if (this.mapComponent) {
            this.mapComponent.removeMarker('tracking-driver');
        }
        
        this.locationSubscription?.unsubscribe();
        this.locationSubscription = undefined;
        this.subscribedDriverLocationId = null;
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
                        await this.notifyFundingUpdate(nextFunding);
                    } else {
                        await this.loadBookingAndDetails(id, false);
                    }
                }
            )
            .subscribe((status) => {
                console.log('[booking-tracking] errand funding realtime:', status);
            });
    }

    private subscribeToJobEvents(id: string): void {
        this.jobEventsChannel?.unsubscribe();

        this.jobEventsChannel = this.supabase
            .channel(`tracking-job-events-${id}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'job_events',
                    filter: `job_id=eq.${id}`
                },
                async (payload) => {
                    const event = payload.new as JobEvent;
                    this.lastStatusEventAt.set(this.toDate(event.created_at) || new Date());

                    const eventStatus = String(event.metadata?.['to'] || '').trim();
                    if (eventStatus && this.lastNotifiedStatus !== eventStatus) {
                        this.lastNotifiedStatus = eventStatus;
                        await this.notifyTrackingUpdate(eventStatus, id);
                    }

                    // Update booking status immediately
                    this.onBookingRealtimeUpdate(payload);
                    
                    await this.loadBookingAndDetails(id, false);
                }
            )
            .subscribe((status) => {
                console.log('[booking-tracking] job events realtime:', status);
            });
    }

    private subscribeToJobMessages(id: string): void {
        this.messageChannel?.unsubscribe();
        void this.refreshMessageCount(id);

        this.messageChannel = this.supabase
            .channel(`tracking-job-messages-${id}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'job_messages',
                    filter: `job_id=eq.${id}`
                },
                () => {
                    void this.refreshMessageCount(id);
                }
            )
            .subscribe((status) => {
                console.log('[booking-tracking] job messages realtime:', status);
            });
    }

    private async refreshMessageCount(id: string): Promise<void> {
        const receiverId = this.currentMessageReceiverId();

        if (!receiverId) {
            this.messageCount.set(0);
            // unreadMessageCount is now computed, cannot set directly
            return;
        }

        try {
            const { data, error } = await this.supabase
                .from('job_messages')
                .select('id, read_at, receiver_id, created_at')
                .eq('job_id', id)
                .eq('receiver_id', receiverId)
                .is('read_at', null)
                .order('created_at', { ascending: false })
                .limit(50);

            if (error) {
                this.warnMessageCountUnavailable(error);
                return;
            }

            const nextCount = data?.length || 0;
            this.messageCount.set(nextCount);
            // unreadMessageCount is now computed, cannot set directly
        } catch (error) {
            this.warnMessageCountUnavailable(error);
        }
    }

    private currentMessageReceiverId(): string {
        return String(this.auth.currentUser()?.id || this.booking()?.customer_id || '').trim();
    }

    private async markCurrentMessagesRead(): Promise<void> {
        const b = this.booking();
        const receiverId = this.currentMessageReceiverId();

        if (!b?.id || !receiverId) {
            return;
        }

        try {
            const { error } = await this.supabase
                .from('job_messages')
                .update({ read_at: new Date().toISOString() })
                .eq('job_id', b.id)
                .eq('receiver_id', receiverId)
                .is('read_at', null);

            if (error) {
                this.warnMessageCountUnavailable(error);
                return;
            }

            this.messageCount.set(0);
            // unreadMessageCount is now computed, cannot set directly
        } catch (error) {
            this.warnMessageCountUnavailable(error);
        }
    }

    private warnMessageCountUnavailable(error: unknown): void {
        this.messageCount.set(0);
        // unreadMessageCount is now computed, cannot set directly

        if (this.messageCountWarningShown) {
            return;
        }

        this.messageCountWarningShown = true;
        const safeError = error && typeof error === 'object'
            ? {
                code: (error as { code?: unknown }).code,
                message: (error as { message?: unknown }).message,
                status: (error as { status?: unknown }).status
            }
            : undefined;
        console.warn('[booking-tracking] chat unread badge unavailable; showing 0', safeError);
    }
    async loadBookingAndDetails(id: string, showLoading = true): Promise<void> {
        if (showLoading) this.isLoading.set(true);

        try {
            const previousStatus = String(this.booking()?.status || '');
            const b = await this.bookingService.getBooking(id);

            if (!b) {
                this.isLoading.set(false);
                return;
            }

            this.bookingService.activeBooking.set(b);
            await this.notifyStatusChange(previousStatus, b);
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
            
            if (err instanceof Error && err.message === 'Booking not found') {
                const alert = await this.alertCtrl.create({
                    header: 'Booking Not Found',
                    message: 'The booking you\'re looking for doesn\'t exist or has been removed.',
                    buttons: [
                        {
                            text: 'Go Back',
                            handler: () => {
                                void this.router.navigate(['/customer']);
                            }
                        }
                    ]
                });
                
                await alert.present();
            }
        } finally {
            this.isLoading.set(false);
        }
    }

    private initMap(): void {
        const b = this.booking();

        if (!b || !this.mapComponent) return;

        setTimeout(() => this.renderTrackingMap('init', true), 250);
    }

    private getPickupPoint(booking: Booking): { lat: number; lng: number } | null {
        const point = { lat: Number(booking.pickup_lat), lng: Number(booking.pickup_lng) };
        return this.isValidCoordinate(point.lat) && this.isValidCoordinate(point.lng) ? point : null;
    }

    private getDropoffPoint(booking: Booking): { lat: number; lng: number } | null {
        const point = { lat: Number(booking.dropoff_lat), lng: Number(booking.dropoff_lng) };
        return this.isValidCoordinate(point.lat) && this.isValidCoordinate(point.lng) ? point : null;
    }

    private subscribeToDriverLocation(driverId: string): void {
        if (this.subscribedDriverLocationId === driverId && this.locationSubscription) {
            return;
        }

        this.locationSubscription?.unsubscribe();
        this.subscribedDriverLocationId = driverId;

        // Get latest location first, then subscribe for updates
        void this.locationService.getLatestDriverLocation(driverId).then((location) => {
            if (location) {
                this.latestDriverPoint = { lat: Number(location.lat), lng: Number(location.lng) };
                this.renderTrackingMap('driver-initial', false);
            }
        }).catch((error) => {
            console.warn('[booking-tracking] Failed to get latest driver location:', error);
        });

        // Subscribe to real-time location updates
        this.locationSubscription = this.locationService.subscribeToDriverLocation(
            driverId,
            (location: DriverLocation) => {
                const coords = { lat: Number(location.lat), lng: Number(location.lng) };
                console.log('[CT] driver location update', coords);
                this.latestDriverPoint = coords;
                
                // Update driver marker and recalculate route
                this.updateDriverMarkerAndRoute(coords);
                
                this.renderTrackingMap('driver-location', false);
            }
        );

        console.log('[booking-tracking] driver location realtime: SUBSCRIBED', driverId);
    }

    private updateDriverMarkerAndRoute(coords: { lat: number; lng: number }): void {
        // Update driver marker as car
        if (this.mapComponent) {
            this.mapComponent.upsertMarker('ct-driver', coords, { type: 'car' });
        }
        
        // Recalculate route from driver to pickup/dropoff based on booking status
        const driverCoords = coords;
        const pickupCoords = this.getPickupCoords();
        const dropoffCoords = this.getDropoffCoords();
        const booking = this.booking();
        
        if (booking && pickupCoords) {
            // Determine route target based on status
            let targetCoords = pickupCoords;
            if (booking.status === 'en_route_to_customer') {
                targetCoords = dropoffCoords || pickupCoords;
            }
            
            if (targetCoords) {
                // Draw route and update ETA
                void this.drawTrackingRoute(driverCoords, targetCoords, 'driver-update');
            }
        }
    }

    // OLD METHOD DISABLED - replaced by renderTrackingMap
    private updateDriverMarker(location: DriverLocation): void {
        // This method is no longer used - replaced by renderTrackingMap
        console.warn('[booking-tracking] updateDriverMarker called but disabled - using renderTrackingMap instead');
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
                padding: { top: 86, bottom: this.detailsExpanded() ? 320 : 230, left: 34, right: 34 },
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
                padding: { top: 86, bottom: this.detailsExpanded() ? 320 : 230, left: 34, right: 34 },
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
                if (this.isShoppingErrand() && ['shopping_in_progress', 'arrived_at_store'].includes(status)) return 'Shopping';
                if (['collected', 'en_route_to_customer'].includes(status)) return `${this.formatDuration(eta)} to delivery`;
                return `${this.formatDuration(eta)} to ${this.isShoppingErrand() ? 'store' : 'collection point'}`;
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

    statusUpdatedLabel(): string {
        const date = this.lastStatusEventAt() || this.toDate((this.booking() as any)?.updated_at);
        if (!date) return '';

        const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
        if (seconds < 45) return 'Updated just now';
        if (seconds < 90) return 'Updated 1 min ago';
        if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)} mins ago`;
        return `Updated ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    private async notifyFundingUpdate(funding: ErrandFunding | null): Promise<void> {
        const booking = this.booking();
        if (!booking?.id || !funding) return;

        if (String(funding.over_budget_status || '') === 'requested') {
            await this.notifyTrackingUpdate('over_budget_requested', booking.id);
        }
    }

    private toDate(value: unknown): Date | null {
        if (!value) return null;
        const date = value instanceof Date ? value : new Date(String(value));
        return Number.isFinite(date.getTime()) ? date : null;
    }

    driverLastSeenLabel(): string {
        const lastSeen = this.driverLastSeenAt();

        if (!lastSeen) return 'Live';

        const seconds = Math.max(0, Math.round((Date.now() - lastSeen.getTime()) / 1000));

        if (seconds < 10) return 'Now';
        if (seconds < 60) return `${seconds}s`;

        return `${Math.round(seconds / 60)}m`;
    }

    formatDuration(seconds: number | null): string {
        if (!seconds || !Number.isFinite(seconds)) return 'ETA unavailable';
        const minutes = Math.max(1, Math.round(seconds / 60));
        return `${minutes} min`;
    }

    formatDistance(meters: number | null): string {
        return this.formatDistanceMeters(meters);
    }

    bookingStatusLabel(): string {
        const b = this.booking();
        const status = String(
            (b as any)?.delivery_status ||
            (b as any)?.errand_status ||
            b?.status ||
            ''
        ).toLowerCase();

        switch (status) {
            case 'pending':
                return 'Waiting for driver';
            case 'accepted':
                return 'Driver accepted';
            case 'arrived':
                return 'Driver arrived';
            case 'collected':
                return 'Collected';
            case 'in_progress':
            case 'on_the_way':
            case 'enroute':
                return 'On the way';
            case 'delivered':
            case 'completed':
                return 'Completed';
            case 'cancelled':
                return 'Cancelled';
            default:
                return 'Tracking active';
        }
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
            return isHeadingToDestination
                ? 'delivery address'
                : this.isShoppingErrand()
                    ? 'store'
                    : 'collection point';
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

    contactSupport(): void {
        const b = this.booking();
        this.openSupportEmail(
            'Movabi support request',
            [
                'Hello Movabi Support,',
                '',
                'I need help with my booking.',
                '',
                `Booking ID: ${b?.id || 'Not available'}`,
                `Status: ${this.getStatusLabel(b?.status || '')}`,
                `Service: ${b?.service_slug || 'Request'}`
            ].join('\n')
        );
    }

    async reportIssue(): Promise<void> {
        const alert = await this.alertCtrl.create({
            header: 'Report an issue',
            message: 'Tell Movabi support what happened. We will include this booking reference so the team can help faster.',
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Contact Support',
                    handler: () => this.openSupportEmail(
                        'Movabi booking issue',
                        [
                            'Hello Movabi Support,',
                            '',
                            'I want to report an issue with this booking.',
                            '',
                            `Booking ID: ${this.booking()?.id || 'Not available'}`,
                            `Status: ${this.getStatusLabel(this.booking()?.status || '')}`,
                            '',
                            'Issue:'
                        ].join('\n')
                    )
                }
            ]
        });

        await alert.present();
    }

    async openSafetyHelp(): Promise<void> {
        const alert = await this.alertCtrl.create({
            header: 'Safety help',
            message: 'If you feel unsafe, move to a safe public place and contact local emergency services. Movabi support can also help with this booking.',
            buttons: [
                { text: 'OK', role: 'cancel' },
                {
                    text: 'Contact Support',
                    handler: () => this.openSupportEmail(
                        'Movabi safety support',
                        [
                            'Hello Movabi Support,',
                            '',
                            'I need safety help with this booking.',
                            '',
                            `Booking ID: ${this.booking()?.id || 'Not available'}`,
                            `Status: ${this.getStatusLabel(this.booking()?.status || '')}`
                        ].join('\n')
                    )
                }
            ]
        });

        await alert.present();
    }

    reportLostItem(): void {
        this.openSupportEmail(
            'Movabi lost item report',
            [
                'Hello Movabi Support,',
                '',
                'I think I left or lost an item during this booking.',
                '',
                `Booking ID: ${this.booking()?.id || 'Not available'}`,
                `Completed status: ${this.getStatusLabel(this.booking()?.status || '')}`,
                '',
                'Item description:'
            ].join('\n')
        );
    }

    cancelUnavailableReason(): string {
        const status = this.getStatusLabel(this.booking()?.status || '');

        if (this.isTerminalTrackingStatus(String(this.booking()?.status || ''))) {
            return 'This booking is already finished.';
        }

        return status ? `Not available while status is ${status}.` : 'Not available for this booking.';
    }

    lostItemUnavailableReason(): string {
        return 'Available after the booking is complete.';
    }

    private openSupportEmail(subject: string, body: string): void {
        const mailto = `mailto:support@movabi.app?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.open(mailto, '_system');
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
            header: 'Top-up needed',
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

    private toLngLat(input: any): { lat: number; lng: number } | null {
        if (!input) return null;
        
        let lat: number | undefined;
        let lng: number | undefined;
        
        // Handle different coordinate formats
        if (typeof input === 'object') {
            // { lat, lng }
            if (input.lat !== undefined && input.lng !== undefined) {
                lat = Number(input.lat);
                lng = Number(input.lng);
            }
            // { latitude, longitude }
            else if (input.latitude !== undefined && input.longitude !== undefined) {
                lat = Number(input.latitude);
                lng = Number(input.longitude);
            }
            // { coords: { lat, lng } }
            else if (input.coords && input.coords.lat !== undefined && input.coords.lng !== undefined) {
                lat = Number(input.coords.lat);
                lng = Number(input.coords.lng);
            }
            // { coordinates: [lng, lat] }
            else if (Array.isArray(input.coordinates) && input.coordinates.length >= 2) {
                lng = Number(input.coordinates[0]);
                lat = Number(input.coordinates[1]);
            }
        }
        // Handle string coordinates
        else if (typeof input === 'string') {
            const parts = input.split(',').map(p => p.trim());
            if (parts.length >= 2) {
                lat = Number(parts[0]);
                lng = Number(parts[1]);
            }
        }
        
        // Validate coordinates
        if (lat === undefined || lng === undefined) return null;
        if (!this.isValidCoordinate(lat) || !this.isValidCoordinate(lng)) return null;
        if (lat === 0 && lng === 0) return null; // Reject zero coordinates
        
        return { lat, lng };
    }

    private getTrackingMapPadding() {
        const sheetPercent = this.trackingSheetHeight(); // 40 or 80
        return {
            top: 80,
            left: 48,
            right: 48,
            bottom: sheetPercent === 80 ? 520 : 360
        };
    }

    // NEW SINGLE TRACKING RENDERER - replaces all old tracking map methods
    private renderTrackingMap(reason: string, fit = false): void {
        if (!this.mapComponent) return;

        const driver = this.getDriverCoords();
        const pickup = this.getPickupCoords();
        const dropoff = this.getDropoffCoords();

        const routePoints = [
            ...(driver ? [driver] : []),
            ...(pickup ? [pickup] : []),
            ...(dropoff ? [dropoff] : [])
        ];

        // Clean up old markers only once
        if (!this.didCleanTrackingMarkers) {
            const oldMarkerIds = ['driver', 'pickup', 'dropoff', 'customer', 'destination', 'tracking-driver', 'tracking-pickup', 'tracking-dropoff'];
            oldMarkerIds.forEach(id => {
                if (this.mapComponent) {
                    this.mapComponent.removeMarker(id);
                }
            });
            this.didCleanTrackingMarkers = true;
        }

        // Update ct-* markers with smooth movement (only for live jobs, not searching)
        if (this.isLiveTrackingJob()) {
            if (driver) {
                this.updateMarkerPosition('ct-driver', driver, { type: 'driver' });
            }
        } else {
            // Hide driver marker for searching, completed, and other non-live jobs
            if (this.mapComponent) {
                this.mapComponent.removeMarker('ct-driver');
            }
        }

        if (pickup) {
            this.updateMarkerPosition('ct-pickup', pickup, { type: 'pickup' });
        }

        if (dropoff) {
            this.updateMarkerPosition('ct-dropoff', dropoff, { type: 'dropoff' });
        }

        // Draw road route with fallback to direct line (only for live jobs)
        if (routePoints.length >= 2 && this.isLiveTrackingJob()) {
            void this.drawTrackingRoadRoute(routePoints);
        }

        // Fit bounds only on initial load or explicit recenter
        const shouldFit =
            fit ||
            !this.hasInitialFit ||
            reason === 'recenter';

        if (shouldFit && routePoints.length >= 2) {
            this.mapComponent.fitTrackingBounds(routePoints);
            if (!this.hasInitialFit) {
                this.hasInitialFit = true;
            }
        }
    }

    private updateMarkerPosition(id: string, coords: { lat: number; lng: number }, options: { type: string }): void {
        // Always use upsertMarker to ensure correct marker type/icon
        if (this.mapComponent) {
            this.mapComponent.upsertMarker(id, coords, options);
        }
    }

    private onBookingRealtimeUpdate(payload: any): void {
        if (!payload?.new) return;

        // Update booking signal with new status
        const currentBooking = this.booking();
        if (currentBooking) {
            this.booking.set({
                ...currentBooking,
                ...payload.new
            });
        }

        // Re-render map with updated status
        this.renderTrackingMap('booking-update', false);
    }

    private onDriverLocationUpdate(payload: any): void {
        // Only process driver updates for live jobs
        if (!this.isLiveTrackingJob()) return;

        const coords = this.toLngLat(payload?.new || payload);
        if (!coords) return;

        const previous = this.latestDriverPoint;
        this.latestDriverPoint = coords;
        this.driverLastSeenAt.set(new Date());

        // Update driver marker position with correct vehicle icon
        if (this.mapComponent) {
            this.mapComponent.upsertMarker('ct-driver', coords, { type: 'driver' });
        }

        // Only redraw route if driver moved more than 25 metres (but don't fit bounds)
        if (!previous || this.distanceMeters(previous, coords) > 25) {
            const routePoints = this.getTrackingPoints();
            if (routePoints.length >= 2) {
                void this.drawTrackingRoadRoute(routePoints);
            }
        }
    }

    private getTrackingPoints(): Array<{ lat: number; lng: number }> {
        const driver = this.getDriverCoords();
        const pickup = this.getPickupCoords();
        const dropoff = this.getDropoffCoords();

        return [
            ...(driver ? [driver] : []),
            ...(pickup ? [pickup] : []),
            ...(dropoff ? [dropoff] : [])
        ];
    }

    private getRouteGeometry(result: any): number[][] {
        const coords =
            result?.geometry?.coordinates ||
            result?.route?.geometry?.coordinates ||
            result?.features?.[0]?.geometry?.coordinates ||
            result?.routes?.[0]?.geometry?.coordinates ||
            result?.coordinates ||
            [];

        return Array.isArray(coords) ? coords : [];
    }

    private async drawTrackingRoadRoute(points: Array<{ lat: number; lng: number }>) {
        const valid = points.filter(Boolean);
        if (valid.length < 2) return;

        const allCoords: number[][] = [];
        let totalDistanceMeters = 0;
        let totalDurationSeconds = 0;

        try {
            for (let i = 0; i < valid.length - 1; i++) {
                const from = valid[i];
                const to = valid[i + 1];

                const result = await firstValueFrom(
                    this.routingService.getRoute(from, to)
                );

                console.log('[CT_ROUTE_DEBUG]', {
                    from,
                    to,
                    result,
                    geometry: result?.geometry,
                    distance: result?.distanceMeters,
                    duration: result?.durationSeconds
                });

                // Handle geometry - it can be string (encoded polyline) or object (GeoJSON)
                let coords: number[][] = [];
                if (result?.geometry) {
                    if (typeof result.geometry === 'string') {
                        // Decode polyline string to coordinates
                        coords = this.decodePolyline(result.geometry);
                    } else if (result.geometry.coordinates) {
                        // GeoJSON coordinates
                        coords = result.geometry.coordinates;
                    }
                }

                const distance = result?.distanceMeters ?? 0;
                const duration = result?.durationSeconds ?? 0;

                console.log('[CT_ROUTE_DEBUG]', {
                    extractedGeometry: coords,
                    geometryLength: coords.length
                });

                if (coords.length >= 2) {
                    allCoords.push(...(allCoords.length ? coords.slice(1) : coords));
                }

                totalDistanceMeters += Number(distance) || 0;
                totalDurationSeconds += Number(duration) || 0;
            }

            if (allCoords.length >= 2 && this.mapComponent) {
                console.log('[CT_ROUTE_DEBUG]', {
                    finalGeometryLength: allCoords.length,
                    totalDistance: totalDistanceMeters,
                    totalDuration: totalDurationSeconds
                });
                
                this.mapComponent.drawRouteGeometry('ct-route', allCoords);
                this.distanceKm.set(Math.round((totalDistanceMeters / 1000) * 10) / 10);
                this.etaMinutes.set(Math.max(1, Math.round(totalDurationSeconds / 60)));
                return;
            }

            throw new Error('No routed geometry returned');
        } catch (error) {
            console.error('[CT_ROUTE_FAILED]', error);
            if (this.mapComponent) {
                this.mapComponent.drawLineString('ct-route', valid);
            }
            if (valid.length >= 2) {
                this.calculateFallbackEtaAndDistance(valid[0], valid[valid.length - 1]);
            }
        }
    }

    private decodePolyline(encoded: string): number[][] {
        if (!encoded) return [];
        
        const coords: number[][] = [];
        let index = 0;
        let lat = 0;
        let lng = 0;
        
        while (index < encoded.length) {
            let shift = 0;
            let result = 0;
            let byte;
            
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            
            const deltaLat = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lat += deltaLat;
            
            shift = 0;
            result = 0;
            
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            
            const deltaLng = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lng += deltaLng;
            
            coords.push([lng / 1e5, lat / 1e5]);
        }
        
        return coords;
    }

    private distanceMeters(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
        const R = 6371000; // Earth's radius in meters
        const dLat = this.toRadians(to.lat - from.lat);
        const dLng = this.toRadians(to.lng - from.lng);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(this.toRadians(from.lat)) * Math.cos(this.toRadians(to.lat)) *
                  Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    private toRadians(degrees: number): number {
        return degrees * (Math.PI / 180);
    }

    private getDriverCoords(): { lat: number; lng: number } | null {
        if (!this.latestDriverPoint) return null;
        return {
            lat: Number(this.latestDriverPoint.lat),
            lng: Number(this.latestDriverPoint.lng)
        };
    }

    private getPickupCoords(): { lat: number; lng: number } | null {
        const booking = this.booking();
        if (!booking) return null;
        return this.isValidCoordinate(Number(booking.pickup_lat)) && this.isValidCoordinate(Number(booking.pickup_lng))
            ? { lat: Number(booking.pickup_lat), lng: Number(booking.pickup_lng) }
            : null;
    }

    private getDropoffCoords(): { lat: number; lng: number } | null {
        const booking = this.booking();
        if (!booking) return null;
        return this.isValidCoordinate(Number(booking.dropoff_lat)) && this.isValidCoordinate(Number(booking.dropoff_lng))
            ? { lat: Number(booking.dropoff_lat), lng: Number(booking.dropoff_lng) }
            : null;
    }

    isLiveTrackingJob(): boolean {
        const status = String(
            this.booking()?.status ||
            ''
        ).toLowerCase();

        return [
            'accepted',
            'assigned',
            'arrived',
            'heading_to_pickup',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'in_progress'
        ].includes(status);
    }

    // OLD METHOD DISABLED - replaced by renderTrackingMap with direct drawLineString
    private async drawRouteWithFallback(routePoints: { lat: number; lng: number }[]): Promise<void> {
        console.warn('[booking-tracking] drawRouteWithFallback called but disabled - using renderTrackingMap instead');
    }

    // OLD METHOD DISABLED - replaced by renderTrackingMap with fitTrackingBounds
    private fitTrackingBoundsWithPadding(points: { lat: number; lng: number }[]): void {
        console.warn('[booking-tracking] fitTrackingBoundsWithPadding called but disabled - using renderTrackingMap instead');
    }

    recenterMap(): void {
        console.log('[booking-tracking] Recentering map and enabling auto-follow');
        this.userMovedMap = false;
        this.followMode = true;
        MapUxHelpers.recenter(this.mapComponent!);
        this.renderTrackingMap('recenter', true);
    }

    onMapUserInteraction(): void {
        console.log('[booking-tracking] User interacting with map, disabling follow mode');
        this.userMovedMap = true;
        this.followMode = false;
        if (this.mapComponent) {
            MapUxHelpers.pauseFollowOnUserGesture(this.mapComponent);
        }
    }

    private async drawRouteBetweenPoints(
        from: { lat: number; lng: number },
        to: { lat: number; lng: number }
    ): Promise<void> {
        await this.drawTrackingRoute(from, to, 'manual');
    }

    private async drawTrackingRoute(
        from: { lat: number; lng: number },
        to: { lat: number; lng: number },
        routeScope: string
    ): Promise<void> {
        if (!this.mapComponent) return;
        if (!this.isValidCoordinate(from.lat) || !this.isValidCoordinate(from.lng)) return;
        if (!this.isValidCoordinate(to.lat) || !this.isValidCoordinate(to.lng)) return;

        const routeKey = [
            routeScope,
            from.lat.toFixed(5),
            from.lng.toFixed(5),
            to.lat.toFixed(5),
            to.lng.toFixed(5)
        ].join(':');

        if (this.activeRouteDrawnFor === routeKey) {
            return;
        }

        this.activeRouteDrawnFor = routeKey;

        try {
            const route = await this.routingService.getRoute(from, to).toPromise();
            console.log('[CT] route result raw', route);
            
            if (route && route.geometry) {
                this.mapComponent!.drawRoute(route);
                
                // Support all route result shapes for duration and distance
                const durationSeconds =
                    route?.durationSeconds ??
                    (route as any)?.duration_seconds ??
                    (route as any)?.duration ??
                    (route as any)?.summary?.duration ??
                    (route as any)?.routes?.[0]?.duration ??
                    0;

                const distanceMeters =
                    route?.distanceMeters ??
                    (route as any)?.distance_meters ??
                    (route as any)?.distance ??
                    (route as any)?.summary?.distance ??
                    (route as any)?.routes?.[0]?.distance ??
                    0;

                // Store ETA and distance from route result
                if (durationSeconds > 0 && distanceMeters > 0) {
                    this.etaMinutes.set(Math.max(1, Math.round(durationSeconds / 60)));
                    this.distanceKm.set(Math.round((distanceMeters / 1000) * 10) / 10);
                    console.log('[CT] ETA set', this.etaMinutes(), 'mins, distance:', this.distanceKm(), 'km');
                } else {
                    console.log("[booking-tracking] Route drawn successfully but no ETA/distance data, using fallback");
                    this.calculateFallbackEtaAndDistance(from, to);
                }
            } else {
                throw new Error("No route geometry returned");
            }
        } catch (error) {
            console.warn("[booking-tracking] Failed to draw route, using fallback line:", error);
            // Calculate fallback straight-line distance and ETA
            this.calculateFallbackEtaAndDistance(from, to);
            
            // Draw simple fallback route object
            const fallbackRoute = {
                geometry: {
                    type: "LineString",
                    coordinates: [
                        [from.lng, from.lat],
                        [to.lng, to.lat]
                    ]
                },
                distanceMeters: 0,
                durationSeconds: 0
            };
            this.mapComponent.drawRoute(fallbackRoute);
        }
    }

    private calculateFallbackEtaAndDistance(
        from: { lat: number; lng: number },
        to: { lat: number; lng: number }
    ): void {
        // Calculate straight-line distance using LocationService
        const distanceKm = this.locationService.calculateDistance(
            from.lat,
            from.lng,
            to.lat,
            to.lng
        );
        
        // Estimate ETA using 25 km/h city speed
        const citySpeedKmh = 25;
        const estimatedMinutes = Math.max(1, Math.round((distanceKm / citySpeedKmh) * 60));
        
        // Store with approximate values (using ~ prefix concept in template)
        this.distanceKm.set(Math.round(distanceKm * 10) / 10);
        this.etaMinutes.set(estimatedMinutes);
        
        console.log("[booking-tracking] Fallback ETA calculated:", estimatedMinutes, "mins and distance:", Math.round(distanceKm * 10) / 10, "km");
    }
}
