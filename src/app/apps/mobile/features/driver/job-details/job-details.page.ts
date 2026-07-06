import { Component, ViewChild, ElementRef, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonIcon,
    IonSpinner,
    LoadingController,
    ToastController,
    AlertController,
    NavController
} from '@ionic/angular/standalone';
import { ActivatedRoute } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    addOutline,
    alertCircleOutline,
    call,
    callOutline,
    cameraOutline,
    checkmarkCircle,
    checkmarkDone,
    chevronBackOutline,
    chevronDownOutline,
    navigate,
    receiptOutline,
    walletOutline,
    locationOutline,
    flagOutline,
    cashOutline,
    timeOutline,
    storefrontOutline,
    cubeOutline,
    carOutline,
    homeOutline,
    informationCircleOutline,
    gitBranchOutline,
    bagHandleOutline,
    cardOutline,
    chatbubbleEllipsesOutline,
    ellipsisHorizontalCircleOutline
} from 'ionicons/icons';
import { RealtimeChannel } from '@supabase/supabase-js';

import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import { DriverService } from '../../../../../core/services/driver/driver.service';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { RoutingService } from '../../../../../core/services/maps/routing.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { WalletProvisioningService } from '../../../../../core/services/issuing/wallet-provisioning.service';
import { PaymentService } from '../../../../../core/services/stripe/payment.service';
import { ProfileService } from '../../../../../core/services/profile/profile.service';
import { NotificationOrchestratorService } from '../../../../../core/services/notification/notification-orchestrator.service';
import {
    Booking,
    BookingStatus,
    ServiceTypeEnum,
    ErrandDetails,
    RideDetails,
    DeliveryDetails,
    VanDetails,
    ErrandFunding,
    ErrandIssuingCardStatus
} from '../../../../../shared/models/booking.model';

import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../../shared/ui';
import { MapComponent } from '../../../../../shared/components/map/map.component';
import { CommunicationPanelComponent } from '../../../../../shared/ui/communication-panel';
import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';

type JobDetails = ErrandDetails | RideDetails | DeliveryDetails | VanDetails;
type ErrandMode = 'collect_deliver' | 'quick_buy' | 'shop_deliver';
type DriverRequestTab = 'overview' | 'workflow' | 'shopping' | 'pay' | 'chat' | 'more';

@Component({
    selector: 'app-job-details',
    standalone: true,
    imports: [
        CommonModule,
        IonHeader,
        IonToolbar,
        IonButtons,
        IonBackButton,
        IonTitle,
        IonContent,
        IonIcon,
        IonSpinner,
        CardComponent,
        ButtonComponent,
        BadgeComponent,
        MapComponent,
        CommunicationPanelComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-4 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Request Details
        </ion-title>
      </ion-toolbar>

      @if (job()) {
        <div class="bg-slate-50/95 backdrop-blur border-b border-slate-100">
          <div class="w-full max-w-xl mx-auto px-3 py-2.5">
            <div class="grid grid-cols-3 sm:grid-cols-6 gap-2 rounded-2xl border border-slate-100 bg-slate-100/80 p-1.5">
              @for (tab of requestTabs; track tab.id) {
                <button
                  type="button"
                  (click)="setActiveRequestTab(tab.id)"
                  class="relative min-w-0 h-12 rounded-xl px-1.5 py-1 text-[11px] font-semibold leading-tight border transition-all inline-flex flex-col items-center justify-center gap-0.5 active:scale-[0.98] hover:shadow-sm"
                  [class.bg-amber-500]="activeRequestTab() === tab.id"
                  [class.text-white]="activeRequestTab() === tab.id"
                  [class.border-amber-500]="activeRequestTab() === tab.id"
                  [class.shadow-md]="activeRequestTab() === tab.id"
                  [class.shadow-amber-500/20]="activeRequestTab() === tab.id"
                  [class.bg-white]="activeRequestTab() !== tab.id"
                  [class.text-slate-700]="activeRequestTab() !== tab.id"
                  [class.border-slate-200]="activeRequestTab() !== tab.id"
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
      }
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="w-full max-w-xl mx-auto px-3 pt-4 pb-[calc(env(safe-area-inset-bottom)+8rem)] space-y-4 overflow-x-hidden">
        @if (job()) {
          @if (activeRequestTab() === 'overview') {
            <div class="relative overflow-hidden bg-white rounded-[1.5rem] p-4 text-slate-950 shadow-lg shadow-slate-900/10 border border-slate-200">
              <div class="absolute inset-x-0 top-0 h-1.5 bg-amber-500"></div>
              <div class="flex items-start justify-between gap-4">
                <div class="min-w-0">
                  <app-badge variant="primary">{{ serviceName() }}</app-badge>
                  <h2 class="mt-3 text-xl font-display font-black tracking-tight capitalize text-slate-950">
                    {{ formatStatus(job()?.status) }}
                  </h2>
                  <p class="mt-1 text-xs text-slate-600 font-semibold">ID: {{ shortId(job()?.id) }}</p>
                </div>
                <div class="text-right shrink-0">
                  <p class="text-[10px] uppercase tracking-widest text-slate-500 font-black">Payout</p>
                  <span class="text-lg font-display font-black text-slate-950">
                    {{ formatPrice(job()?.total_price || job()?.price || 0) }}
                  </span>
                </div>
              </div>
            </div>

            <app-card class="overflow-hidden">
              <div class="p-4 border-b border-slate-100">
                <p class="text-[10px] uppercase tracking-widest text-slate-400 font-black">{{ navigationSectionLabel() }}</p>
                <h3 class="mt-1 text-base font-display font-black text-slate-950">{{ pickupMapTitle() }}</h3>
                <p class="mt-1 text-xs text-slate-500 font-semibold">{{ pickupMapSubtitle() }}</p>
              </div>
              <div class="h-64 bg-slate-50">
                <app-map #pickupMap></app-map>
              </div>
              <div class="p-4">
                <button
                  type="button"
                  (click)="openMap(job()?.pickup_address)"
                  class="w-full h-11 rounded-2xl bg-blue-50 border border-blue-100 text-blue-700 font-black flex items-center justify-center gap-2 active:scale-95 transition-all"
                >
                  <ion-icon name="navigate"></ion-icon>
                  Open navigation
                </button>
              </div>
            </app-card>

            <app-card class="p-4 space-y-4">
              <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-2xl overflow-hidden border-4 border-slate-50 shadow-lg shadow-slate-200/50 bg-slate-100 flex items-center justify-center shrink-0">
                  <span class="text-base font-black text-slate-500">{{ customerInitial() }}</span>
                </div>
                <div class="min-w-0">
                  <h4 class="text-base font-display font-black text-slate-950 leading-tight whitespace-normal">{{ customerName() }}</h4>
                  <p class="text-xs text-slate-500 font-semibold">Customer</p>
                </div>
              </div>

              @if (customerPhone()) {
                <button
                  type="button"
                  (click)="callPhone(customerPhone())"
                  class="w-full h-11 rounded-2xl bg-blue-50 border border-blue-100 text-blue-700 font-black flex items-center justify-center gap-2 active:scale-95 transition-all"
                >
                  <ion-icon name="call"></ion-icon>
                  Call customer
                </button>
              }

              <div class="grid gap-3">
                <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                  <p class="text-[10px] uppercase tracking-widest text-slate-400 font-black">{{ originLabel() }}</p>
                  <p class="mt-1 text-sm font-bold text-slate-950 leading-snug">{{ job()?.pickup_address || originUnavailableLabel() }}</p>
                </div>
                <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                  <p class="text-[10px] uppercase tracking-widest text-slate-400 font-black">{{ destinationLabel() }}</p>
                  <p class="mt-1 text-sm font-bold text-slate-950 leading-snug">{{ job()?.dropoff_address || destinationUnavailableLabel() }}</p>
                </div>
                @if (serviceVehicleLabel()) {
                  <div class="rounded-2xl bg-amber-50 border border-amber-100 p-3 flex items-center justify-between gap-3">
                    <span class="text-sm font-bold text-amber-800">Vehicle needed</span>
                    <span class="text-sm font-black text-slate-950">{{ serviceVehicleLabel() }}</span>
                  </div>
                }
              </div>
            </app-card>

            <!-- Shop/Deliver Contact Details -->
            @if (recipientName() || recipientPhone()) {
              <app-card class="p-4 space-y-4 bg-blue-50 border-blue-100">
                <div class="flex items-center gap-3">
                  <div class="w-12 h-12 rounded-2xl bg-blue-500 flex items-center justify-center text-white shadow-lg shadow-blue-200 shrink-0">
                    <ion-icon name="location-outline" class="text-xl"></ion-icon>
                  </div>
                  <div class="min-w-0">
                    <h4 class="text-base font-display font-black text-slate-950 leading-tight whitespace-normal">{{ recipientName() }}</h4>
                    <p class="text-xs text-slate-500 font-semibold">
                      @if (job()?.service_slug === 'errand') { Shop Recipient } @else { Deliver Recipient }
                    </p>
                    @if (recipientPhone()) {
                      <p class="text-xs text-blue-600 font-medium mt-1">{{ recipientPhone() }}</p>
                    }
                  </div>
                </div>

                @if (recipientPhone()) {
                  <a [href]="'tel:' + recipientPhone()" class="block">
                    <button
                      type="button"
                      class="w-full h-11 rounded-2xl bg-blue-500 border border-blue-500 text-white font-black flex items-center justify-center gap-2 active:scale-95 transition-all"
                    >
                      <ion-icon name="call"></ion-icon>
                      Call recipient
                    </button>
                  </a>
                }
              </app-card>
            }

            <!-- Deliver Details -->
            @if (job()?.service_slug === 'delivery' || job()?.service_slug === 'package') {
              @if (deliveryPackageSizeLabel() || packageDescription() || deliveryInstructions()) {
                <app-card class="p-4 space-y-4 bg-amber-50 border-amber-100">
                  <h3 class="text-xs font-black text-amber-600 uppercase tracking-[0.18em]">Deliver Details</h3>
                  
                  @if (deliveryPackageSizeLabel()) {
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-semibold text-slate-600">Parcel Size</span>
                      <span class="text-xs font-black text-slate-950">{{ deliveryPackageSizeLabel() }}</span>
                    </div>
                  }

                  @if (packageDescription()) {
                    <div>
                      <p class="text-xs font-semibold text-slate-600 mb-2">Parcel Details</p>
                      <p class="text-xs text-slate-700 leading-relaxed">{{ packageDescription() }}</p>
                    </div>
                  }

                  @if (deliveryInstructions()) {
                    <div>
                      <p class="text-xs font-semibold text-slate-600 mb-2">Special Instructions</p>
                      <p class="text-xs text-slate-700 leading-relaxed">{{ deliveryInstructions() }}</p>
                    </div>
                  }
                </app-card>
              }
            }

            <!-- Shop Details -->
            @if (job()?.service_slug === 'errand') {
              @if (errandModeDisplay() || errandCustomerPhone() || errandItemsList().length || estimatedBudget() || substitutionRule()) {
                <app-card class="p-4 space-y-4 bg-purple-50 border-purple-100">
                  <h3 class="text-xs font-black text-purple-600 uppercase tracking-[0.18em]">Shop Details</h3>
                  
                  @if (errandModeDisplay()) {
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-semibold text-slate-600">Shop Mode</span>
                      <span class="text-xs font-black text-slate-950">{{ errandModeDisplay() }}</span>
                    </div>
                  }

                  @if (errandCustomerPhone()) {
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-semibold text-slate-600">Customer Phone</span>
                      <div class="flex items-center gap-2">
                        <span class="text-xs text-slate-700">{{ errandCustomerPhone() }}</span>
                        <a [href]="'tel:' + errandCustomerPhone()">
                          <button
                            type="button"
                            class="h-8 px-3 rounded-xl bg-purple-100 border border-purple-200 text-purple-700 font-black text-xs flex items-center justify-center gap-1 active:scale-95 transition-all"
                          >
                            <ion-icon name="call" class="text-sm"></ion-icon>
                            Call
                          </button>
                        </a>
                      </div>
                    </div>
                  }

                  @if (errandItemsList().length > 0) {
                    <div>
                      <p class="text-xs font-semibold text-slate-600 mb-2">Items List</p>
                      <ul class="space-y-1">
                        @for (item of errandItemsList(); track item) {
                          <li class="text-xs text-slate-700 flex items-center gap-2">
                            <div class="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0"></div>
                            {{ item }}
                          </li>
                        }
                      </ul>
                    </div>
                  }

                  @if (estimatedBudget()) {
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-semibold text-slate-600">Estimated Budget</span>
                      <span class="text-xs font-black text-slate-950">{{ formattedEstimatedBudget() }}</span>
                    </div>
                  }

                  @if (substitutionRule()) {
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-semibold text-slate-600">Substitution Rule</span>
                      <span class="text-xs font-black text-slate-950">{{ substitutionRule() }}</span>
                    </div>
                  }
                </app-card>
              }
            }
          }

          @if (activeRequestTab() === 'workflow') {
            <app-card class="p-4 space-y-4">
              <div class="flex items-start gap-3">
                <div class="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 border border-amber-100 flex items-center justify-center shrink-0">
                  <ion-icon [name]="serviceIcon()"></ion-icon>
                </div>
                <div class="min-w-0">
                  <p class="text-[10px] font-black uppercase tracking-widest text-amber-700">{{ serviceWorkEyebrow() }}</p>
                  <h4 class="mt-1 text-base font-display font-black text-slate-950">{{ serviceWorkTitle() }}</h4>
                  <p class="mt-2 text-xs font-semibold text-slate-600 leading-relaxed">{{ serviceWorkMessage() }}</p>
                </div>
              </div>

              <div class="grid gap-2">
                @for (step of driverServiceSteps(); track step.title) {
                  <div class="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-100 p-3">
                    <ion-icon [name]="step.icon" class="text-amber-600 shrink-0"></ion-icon>
                    <div class="min-w-0">
                      <p class="text-xs font-black text-slate-950 whitespace-normal">{{ step.title }}</p>
                      <p class="text-[11px] font-semibold text-slate-500 leading-snug">{{ step.description }}</p>
                    </div>
                  </div>
                }
              </div>
            </app-card>

            @if (job()?.service_slug === ServiceTypeEnum.ERRAND && !isShoppingErrand()) {
              <app-card class="p-4 space-y-3">
                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Collection task</p>
                <p class="text-sm font-semibold text-slate-600 leading-relaxed">
                  Go to the collection location, collect the item or documents, then deliver or return them to the customer. No shopping spend or receipt is needed for this shop job.
                </p>
              </app-card>
            }
          }

          @if (activeRequestTab() === 'shopping') {
            @if (job()?.service_slug === ServiceTypeEnum.ERRAND) {
              <app-card class="p-4 space-y-4">
                <div class="rounded-2xl bg-blue-50 border border-blue-100 p-3 flex justify-between items-center gap-3">
                  <span class="text-sm font-bold text-blue-700">Shop type</span>
                  <span class="text-sm font-black text-slate-950 text-right">{{ errandModeLabel() }}</span>
                </div>

                @if (isShoppingErrand()) {
                  <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                    <div class="flex justify-between items-center gap-3 mb-3">
                      <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Shopping List</p>
                      @if (errandDetails()?.receipt_url) {
                        <app-badge variant="success">Receipt uploaded</app-badge>
                      }
                    </div>

                    @if (itemsList().length > 0) {
                      <div class="flex flex-wrap gap-2">
                        @for (item of itemsList(); track item) {
                          <app-badge variant="secondary">{{ item }}</app-badge>
                        }
                      </div>
                    } @else {
                      <p class="text-sm text-slate-500 font-semibold">No shopping list provided.</p>
                    }
                  </div>

                  <div class="grid grid-cols-2 gap-3">
                    <div class="p-3 bg-white rounded-2xl border border-slate-100">
                      <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Approved budget</p>
                      <p class="text-lg font-display font-black text-slate-950">{{ formatPrice(approvedErrandItemBudget()) }}</p>
                    </div>
                    <div class="p-3 bg-white rounded-2xl border border-slate-100">
                      <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Spent</p>
                      <p
                        class="text-lg font-display font-black"
                        [class.text-amber-600]="!hasRecordedErrandSpend()"
                        [class.text-emerald-600]="hasRecordedErrandSpend() && toNumber(errandDetails()?.actual_spending) <= approvedErrandItemBudget()"
                        [class.text-rose-600]="hasRecordedErrandSpend() && toNumber(errandDetails()?.actual_spending) > approvedErrandItemBudget()"
                      >
                        {{ hasRecordedErrandSpend() ? formatPrice(errandDetails()?.actual_spending || 0) : 'Not recorded' }}
                      </p>
                    </div>
                  </div>

                  @if (funding() && funding()?.over_budget_status !== 'none') {
                    <div class="p-3 rounded-2xl border bg-amber-50 border-amber-100">
                      <div class="flex justify-between items-center gap-3">
                        <span class="text-[10px] font-black uppercase tracking-widest text-slate-600">Extra budget: {{ funding()?.over_budget_status }}</span>
                        <span class="font-black text-slate-950">{{ formatPrice(funding()?.over_budget_amount || 0) }}</span>
                      </div>
                    </div>
                  }

                  @if (showErrandSpendTools()) {
                    <div class="grid grid-cols-2 gap-3 pt-2">
                      <app-button variant="secondary" size="sm" (clicked)="recordSpending()">
                        {{ hasRecordedErrandSpend() ? 'Update Spend' : 'Record Spend' }}
                      </app-button>
                      <app-button variant="secondary" size="sm" (clicked)="requestOverBudget()">
                        Extra Budget
                      </app-button>
                    </div>
                    <div>
                      <input type="file" #receiptInput class="hidden" (change)="onReceiptSelected($event)" accept="image/*,.pdf">
                      <app-button variant="secondary" size="sm" class="w-full" (clicked)="receiptInput.click()">
                        {{ errandDetails()?.receipt_url ? 'Update Receipt' : 'Upload Receipt' }}
                      </app-button>
                    </div>
                  }
                } @else {
                  <div class="rounded-2xl bg-slate-50 border border-slate-100 p-4">
                    <p class="text-sm font-semibold text-slate-600 leading-relaxed">
                      This is a collect & deliver errand. There is no shopping budget, spend record, or receipt needed.
                    </p>
                  </div>
                }
              </app-card>
            } @else {
              <app-card class="p-4">
                <p class="text-sm font-semibold text-slate-600">Shopping tools only apply to shopping errands.</p>
              </app-card>
            }
          }

          @if (activeRequestTab() === 'pay') {
            @if (job()?.service_slug === ServiceTypeEnum.ERRAND && isShoppingErrand() && issuingCardStatus()) {
              <app-card class="p-4">
                <div class="rounded-3xl border border-amber-100 bg-amber-50 p-4 space-y-4">
                  <div class="relative overflow-hidden rounded-[1.65rem] bg-slate-950 p-5 text-white shadow-xl shadow-slate-950/20">
                    <div class="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-amber-400/20"></div>
                    <div class="absolute -bottom-12 left-20 h-32 w-32 rounded-full bg-emerald-400/10"></div>
                    <div class="relative z-10 space-y-6">
                      <div class="flex items-start justify-between gap-3">
                        <div>
                          <p class="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300">Movabi Pay</p>
                          <h4 class="mt-1 text-lg font-display font-black">{{ virtualCardOwnerLabel() }}</h4>
                          <p class="mt-1 text-[10px] font-black uppercase tracking-widest text-white/45">Driver virtual card</p>
                        </div>
                        <div class="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white/80">
                          {{ issuingCardBadgeText() }}
                        </div>
                      </div>
                      <div>
                        <p class="text-[10px] font-black uppercase tracking-widest text-white/45 mb-2">Card number</p>
                        <p class="font-mono text-xl font-black tracking-[0.18em] text-white">{{ virtualCardDisplayNumber() }}</p>
                      </div>
                      <div>
                        <p class="text-[10px] font-black uppercase tracking-widest text-white/40">Cardholder</p>
                        <p class="mt-1 text-base font-display font-black uppercase tracking-[0.06em] text-white whitespace-normal">{{ virtualCardDriverName() }}</p>
                      </div>
                      <div class="grid grid-cols-3 gap-3 text-xs">
                        <div>
                          <p class="font-black uppercase tracking-widest text-white/40">Limit</p>
                          <p class="mt-1 font-display text-base font-black">{{ formatPrice(issuingCardBudgetLimit()) }}</p>
                        </div>
                        <div>
                          <p class="font-black uppercase tracking-widest text-white/40">Use for</p>
                          <p class="mt-1 font-black">Errand</p>
                        </div>
                        <div>
                          <p class="font-black uppercase tracking-widest text-white/40">Spend</p>
                          <p class="mt-1 font-black">Phone wallet</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="space-y-2">
                    <h4 class="text-base font-display font-black text-slate-950">{{ issuingCardTitle() }}</h4>
                    <p class="text-sm font-semibold text-slate-600 leading-relaxed">{{ issuingCardMessage() }}</p>
                    <p class="text-xs font-bold text-slate-500 leading-relaxed">{{ issuingCardNextStep() }}</p>
                  </div>

                  <div class="rounded-2xl border border-amber-100 bg-white/85 p-3 space-y-2 text-sm font-bold text-slate-700">
                    <div class="flex items-center justify-between gap-3">
                      <span>Card status</span>
                      <span class="text-amber-700">{{ issuingCardStatusLabel() }}</span>
                    </div>
                    <div class="flex items-center justify-between gap-3">
                      <span>Next step</span>
                      <span class="text-slate-950 text-right">{{ issuingCardActionLabel() }}</span>
                    </div>
                    <div class="flex items-center justify-between gap-3">
                      <span>Checkout</span>
                      <span class="text-slate-950">Tap phone or use card details</span>
                    </div>
                  </div>

                  @if (canActivateIssuingCard()) {
                    <app-button variant="primary" size="sm" class="w-full mt-4" (clicked)="activateIssuingCard()">Activate card now</app-button>
                  }
                  @if (canSetupIssuingCard()) {
                    <app-button variant="primary" size="sm" class="w-full mt-4" [loading]="isSettingUpIssuingCard()" [disabled]="isSettingUpIssuingCard()" (clicked)="setupIssuingCard()">
                      Set up Movabi Pay card
                    </app-button>
                  }
                  @if (canProvisionIssuingCard()) {
                    <div class="grid grid-cols-1 gap-3 mt-4">
                      <app-button variant="primary" size="sm" class="w-full" [loading]="isProvisioningToWallet()" [disabled]="isProvisioningToWallet()" (clicked)="addIssuingCardToWallet()">
                        Add to {{ phoneWalletName() }}
                      </app-button>
                      <app-button variant="secondary" size="sm" class="w-full" [loading]="isRevealingCardDetails()" [disabled]="isRevealingCardDetails()" (clicked)="revealIssuingCardDetails()">
                        Reveal secure card details
                      </app-button>
                    </div>
                  }
                  @if (cardDetailsVisible()) {
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <p class="text-[10px] font-black uppercase tracking-widest text-slate-400">Secure card details</p>
                          <p class="text-xs font-semibold text-slate-500">Use only for this customer errand.</p>
                        </div>
                        <span class="rounded-full bg-emerald-50 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-700">Protected</span>
                      </div>
                      @if (cardDetailsError()) {
                        <div class="rounded-2xl bg-rose-50 border border-rose-100 p-3 text-sm font-bold text-rose-700">{{ cardDetailsError() }}</div>
                      }
                      <div class="space-y-3">
                        <div class="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                          <p class="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Number</p>
                          <div #issuingCardNumberElement class="min-h-6 text-base font-mono text-slate-950"></div>
                        </div>
                        <div class="grid grid-cols-2 gap-3">
                          <div class="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                            <p class="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Expiry</p>
                            <div #issuingCardExpiryElement class="min-h-6 text-base font-mono text-slate-950"></div>
                          </div>
                          <div class="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                            <p class="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">CVC</p>
                            <div #issuingCardCvcElement class="min-h-6 text-base font-mono text-slate-950"></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  }
                </div>
              </app-card>
            } @else {
              <app-card class="p-4">
                <p class="text-sm font-semibold text-slate-600">Movabi Pay is only shown for shopping errands with an item budget.</p>
              </app-card>
            }
          }

          @if (activeRequestTab() === 'chat') {
            @if (job()?.id && job()?.customer_id) {
              <div class="overflow-hidden rounded-[1.5rem] border border-slate-100 bg-white shadow-xl shadow-slate-900/10">
                <app-communication-panel
                  [jobId]="job()!.id"
                  [receiverId]="job()!.customer_id"
                  [receiverPhone]="customerPhone() || undefined"
                ></app-communication-panel>
              </div>
            }
          }

          @if (activeRequestTab() === 'more') {
            <app-card class="p-4 space-y-4">
              <div>
                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Request ID</p>
                <p class="mt-1 text-sm font-black text-slate-950 break-all">{{ job()?.id }}</p>
              </div>
              <div class="grid gap-3">
                <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                  <p class="text-[10px] uppercase tracking-widest text-slate-400 font-black">Service</p>
                  <p class="mt-1 text-sm font-bold text-slate-950">{{ serviceName() }}</p>
                </div>
                @if (job()?.service_slug === ServiceTypeEnum.RIDE) {
                  <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                    <p class="text-[10px] uppercase tracking-widest text-slate-400 font-black">Passengers</p>
                    <p class="mt-1 text-sm font-bold text-slate-950">{{ anyDetails()?.passenger_count || 1 }}</p>
                  </div>
                }
                @if (job()?.service_slug === ServiceTypeEnum.DELIVERY) {
                  <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                    <p class="text-[10px] uppercase tracking-widest text-slate-400 font-black">Parcel</p>
                    <p class="mt-1 text-sm font-bold text-slate-950">{{ anyDetails()?.item_description || anyDetails()?.package_description || 'Parcel details not provided' }}</p>
                  </div>
                }
                @if (job()?.service_slug === ServiceTypeEnum.VAN) {
                  <div class="grid grid-cols-2 gap-3">
                    <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                      <p class="text-[10px] uppercase tracking-widest text-slate-400 font-black">Helpers</p>
                      <p class="mt-1 text-sm font-bold text-slate-950">{{ anyDetails()?.helper_count || 0 }}</p>
                    </div>
                    <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                      <p class="text-[10px] uppercase tracking-widest text-slate-400 font-black">Floor</p>
                      <p class="mt-1 text-sm font-bold text-slate-950">{{ anyDetails()?.floor_number || 0 }}</p>
                    </div>
                  </div>
                }
                @if (anyDetails()?.notes || anyDetails()?.delivery_instructions) {
                  <div class="rounded-2xl bg-blue-50 border border-blue-100 p-3">
                    <p class="text-[10px] uppercase tracking-widest text-blue-600 font-black">Notes</p>
                    <p class="mt-1 text-sm font-semibold text-slate-700 leading-relaxed">{{ anyDetails()?.notes || anyDetails()?.delivery_instructions }}</p>
                  </div>
                }
              </div>

              @if (canHandoffJob()) {
                <button
                  type="button"
                  class="w-full h-12 rounded-2xl border border-amber-200 bg-amber-50 text-amber-800 text-sm font-black tracking-wide active:scale-[0.98] transition-all"
                  (click)="openHandoffRequest()"
                >
                  I can't continue this request
                </button>
              }
            </app-card>
          }

          @if (showStickyActionForTab()) {
            <div class="sticky bottom-3 z-20">
              @if (job()?.status !== 'completed') {
                <div class="bg-white/95 backdrop-blur rounded-[1.35rem] border border-slate-100 shadow-xl shadow-slate-200/60 p-3 mb-3">
                  <div class="flex items-start justify-between gap-4 mb-3">
                    <div class="min-w-0">
                      <p class="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-1">Next step</p>
                      <h3 class="text-base font-display font-black text-slate-950">{{ actionTitle() }}</h3>
                    </div>
                    <app-badge [variant]="actionBadgeVariant()">{{ formatStatus(job()?.status) }}</app-badge>
                  </div>
                  <div class="h-2 rounded-full bg-slate-100 overflow-hidden mb-3">
                    <div class="h-full rounded-full bg-blue-600 transition-all duration-300" [style.width.%]="actionProgress()"></div>
                  </div>
                  <p class="text-xs text-slate-500 font-semibold leading-relaxed">{{ actionHint() }}</p>
                </div>
              }

              @switch (job()?.status) {
                @case ('accepted') {
                  <app-button variant="primary" size="lg" class="w-full h-14 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus('arrived')">I Have Arrived</app-button>
                }
                @case ('arrived') {
                  <app-button variant="primary" size="lg" class="w-full h-14 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus(startStatus())">Start Request</app-button>
                }
                @case ('arrived_at_store') {
                  <app-button variant="primary" size="lg" class="w-full h-14 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus(nextArrivedAtStoreStatus())">{{ arrivedAtStoreActionLabel() }}</app-button>
                }
                @case ('shopping_in_progress') {
                  <app-button variant="primary" size="lg" class="w-full h-14 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus('collected')">Items Collected</app-button>
                }
                @case ('collected') {
                  <app-button variant="primary" size="lg" class="w-full h-14 rounded-2xl shadow-xl shadow-blue-600/20" (clicked)="updateStatus('en_route_to_customer')">En Route to Customer</app-button>
                }
                @case ('en_route_to_customer') {
                  <app-button variant="primary" size="lg" class="w-full h-14 rounded-2xl shadow-xl shadow-emerald-600/20 bg-emerald-600 border-emerald-600" (clicked)="completeTrip()">Complete Request</app-button>
                }
                @case ('in_progress') {
                  <app-button variant="primary" size="lg" class="w-full h-14 rounded-2xl shadow-xl shadow-emerald-600/20 bg-emerald-600 border-emerald-600" (clicked)="completeTrip()">Complete Request</app-button>
                }
                @case ('delivered') {
                  <app-button variant="primary" size="lg" class="w-full h-14 rounded-2xl shadow-xl shadow-emerald-600/20 bg-emerald-600 border-emerald-600" (clicked)="completeTrip()">Complete Request</app-button>
                }
                @case ('completed') {
                  <div class="bg-emerald-50 p-5 rounded-[1.5rem] text-center border border-emerald-100">
                    <div class="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
                      <ion-icon name="checkmark-circle" class="text-3xl text-emerald-600"></ion-icon>
                    </div>
                    <h3 class="text-lg font-display font-black text-slate-950 mb-2">Request Completed</h3>
                    <p class="text-sm text-slate-600 font-medium mb-4">Earnings will appear once settlement is complete.</p>
                    <app-button variant="secondary" size="lg" (clicked)="nav.navigateRoot('/driver')" class="w-full">Back to Dashboard</app-button>
                  </div>
                }
                @default {
                  <app-button variant="secondary" size="lg" class="w-full h-14 rounded-2xl" (clicked)="nav.navigateRoot('/driver')">Back to Dashboard</app-button>
                }
              }
            </div>
          }
        } @else {
          <div class="min-h-[70vh] flex flex-col items-center justify-center py-20 text-center space-y-8">
            @if (isLoading()) {
              <div class="w-20 h-20 bg-white rounded-[2rem] flex items-center justify-center shadow-2xl shadow-slate-200/50 border border-slate-100">
                <ion-spinner name="crescent" color="primary"></ion-spinner>
              </div>
              <div class="space-y-2">
                <h3 class="text-xl font-display font-black text-slate-950">Loading request</h3>
                <p class="text-slate-500 font-medium">Retrieving details...</p>
              </div>
            } @else {
              <div class="w-24 h-24 bg-red-50 rounded-[2rem] flex items-center justify-center text-red-500 border border-red-100">
                <ion-icon name="alert-circle-outline" class="text-5xl"></ion-icon>
              </div>
              <div class="space-y-3">
                <h3 class="text-lg font-display font-black text-slate-950">Request Not Found</h3>
                <p class="text-slate-500 font-medium max-w-xs mx-auto leading-relaxed">
                  This request may have been cancelled, completed, or assigned to another driver.
                </p>
              </div>
              <app-button variant="secondary" size="lg" (clicked)="nav.navigateRoot('/driver')" class="w-full">
                Back to Dashboard
              </app-button>
            }
          </div>
        }
      </div>
    </ion-content>
  `
})
export class JobDetailsPage implements OnInit, OnDestroy {
    @ViewChild('pickupMap') pickupMap?: MapComponent;
    @ViewChild('issuingCardNumberElement') issuingCardNumberElement?: ElementRef<HTMLElement>;
    @ViewChild('issuingCardExpiryElement') issuingCardExpiryElement?: ElementRef<HTMLElement>;
    @ViewChild('issuingCardCvcElement') issuingCardCvcElement?: ElementRef<HTMLElement>;

    private route = inject(ActivatedRoute);
    private driverService = inject(DriverService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private alertCtrl = inject(AlertController);
    public nav = inject(NavController);
    private bookingService = inject(BookingService);
    private locationService = inject(LocationService);
    private routing = inject(RoutingService);
    private supabase = inject(SupabaseService);
    private walletProvisioning = inject(WalletProvisioningService);
    private paymentService = inject(PaymentService);
    private profileService = inject(ProfileService);
    private notificationOrchestrator = inject(NotificationOrchestratorService);
    public config = inject(AppConfigService);

    ServiceTypeEnum = ServiceTypeEnum;

    job = this.driverService.activeJob;
    details = signal<JobDetails | null>(null);
    anyDetails = computed(() => this.details() as any);
    errandDetails = computed(() => this.details() as ErrandDetails | null);
    funding = signal<ErrandFunding | null>(null);
    issuingCardStatus = signal<ErrandIssuingCardStatus | null>(null);
    isSettingUpIssuingCard = signal(false);
    isProvisioningToWallet = signal(false);
    isRevealingCardDetails = signal(false);
    cardDetailsVisible = signal(false);
    cardDetailsError = signal('');
    isLoading = signal(true);
    driverPickupDistance = signal<number | null>(null);
    driverPickupDuration = signal<number | null>(null);
    pickupMapReady = signal(false);
    activeRequestTab = signal<DriverRequestTab>('overview');
    messageCount = signal(0);
    unreadMessageCount = computed(() => {
        const jobId = this.job()?.id;
        return jobId ? this.notificationOrchestrator.getBadgeCount(jobId) : 0;
    });
    requestTabs: Array<{ id: DriverRequestTab; label: string; icon: string }> = [
        { id: 'overview', label: 'Overview', icon: 'information-circle-outline' },
        { id: 'workflow', label: 'Workflow', icon: 'git-branch-outline' },
        { id: 'shopping', label: 'Shopping', icon: 'bag-handle-outline' },
        { id: 'pay', label: 'Pay', icon: 'card-outline' },
        { id: 'chat', label: 'Chat', icon: 'chatbubble-ellipses-outline' },
        { id: 'more', label: 'More', icon: 'ellipsis-horizontal-circle-outline' }
    ];
    sectionExpanded = signal<Record<string, boolean>>({
        navigation: true,
        customer: false,
        requirements: true
    });

    itemsList = computed((): string[] => {
        const details = this.details() as any;
        const raw: unknown = details?.items_list;

        if (Array.isArray(raw)) {
            return raw.map((item: unknown) => String(item)).filter(Boolean);
        }

        if (typeof raw === 'string') {
            try {
                const parsed: unknown = JSON.parse(raw);

                if (Array.isArray(parsed)) {
                    return parsed.map((item: unknown) => String(item)).filter(Boolean);
                }
            } catch {
                return raw
                    .split(',')
                    .map((item: string) => item.trim())
                    .filter(Boolean);
            }
        }

        return [];
    });

    serviceName = computed(() => {
        const job = this.job() as any;
        const raw = job?.service_type?.name || job?.service_slug || 'Request';
        return this.titleCase(String(raw));
    });

    serviceVehicleLabel = computed(() => {
        const metadata = this.jobMetadata();
        const details = this.anyDetails() || {};
        const raw = String(
            metadata['service_vehicle_class'] ||
            metadata['vehicleClass'] ||
            metadata['vehicle_class'] ||
            metadata['ride_details']?.vehicle_class ||
            metadata['delivery_details']?.vehicleClass ||
            metadata['errand_details']?.vehicleClass ||
            details?.vehicle_class ||
            ''
        ).toLowerCase();

        switch (raw) {
            case 'bike':
                return 'Bike';
            case 'standard':
            case 'car':
                return 'Car';
            case 'xl':
                return 'XL car';
            case 'van':
                return 'Van';
            default:
                return '';
        }
    });

    packageSizeLabel = computed(() => {
        const metadata = this.jobMetadata();
        const raw = String(
            metadata['package_size'] ||
            metadata['delivery_details']?.packageSize ||
            this.anyDetails()?.package_size ||
            ''
        ).toLowerCase();

        switch (raw) {
            case 'small':
                return 'Small';
            case 'medium':
                return 'Medium';
            case 'large':
                return 'Large';
            default:
                return '';
        }
    });

    errandMode(): ErrandMode {
        const metadata = this.jobMetadata();
        const details = this.anyDetails() || {};
        const raw = String(
            metadata['errand_details']?.mode ||
            metadata['errand_mode'] ||
            details?.errand_mode ||
            details?.mode ||
            ''
        ).toLowerCase();

        if (raw === 'collect_deliver' || raw === 'quick_buy' || raw === 'shop_deliver') {
            return raw as ErrandMode;
        }

        const descriptor = [
            metadata['errand_type'],
            metadata['errand_details']?.type,
            metadata['errand_details']?.label,
            details?.errand_type,
            details?.task_type,
            details?.type,
            details?.mode,
            details?.delivery_instructions
        ].map((part) => String(part || '').toLowerCase()).join(' ');

        if (/(collect|collection|pickup|pick up|document|return|deliver only)/.test(descriptor)) {
            return 'collect_deliver';
        }

        if (/(shop|shopping|grocery|groceries|buy|purchase|quick buy)/.test(descriptor)) {
            return 'shop_deliver';
        }

        const legacyBudget = this.firstPositiveMoney(
            details?.estimated_budget,
            metadata['errand_details']?.budget,
            metadata['item_budget']
        );

        return this.itemsList().length > 0 && legacyBudget > 0 ? 'shop_deliver' : 'collect_deliver';
    }

    isShoppingErrand(): boolean {
        const mode = this.errandMode();
        return mode === 'quick_buy' || mode === 'shop_deliver';
    }

    errandModeLabel(): string {
        switch (this.errandMode()) {
            case 'quick_buy':
                return 'Quick buy';
            case 'shop_deliver':
                return 'Shop & deliver';
            default:
                return 'Collect & deliver';
        }
    }

    isSectionExpanded(section: string): boolean {
        return this.sectionExpanded()[section] !== false;
    }

    toggleSection(section: string): void {
        this.sectionExpanded.update((current) => ({
            ...current,
            [section]: !this.isSectionExpanded(section)
        }));
    }

    setActiveRequestTab(tab: DriverRequestTab): void {
        this.activeRequestTab.set(tab);

        if (tab === 'overview') {
            setTimeout(() => void this.renderPickupRoute(), 120);
        }

        if (tab === 'chat') {
            // Mark messages as read using NotificationOrchestrator
            const jobId = this.job()?.id;
            if (jobId) {
                void this.notificationOrchestrator.markAsRead(jobId);
            }
        }
    }

    showStickyActionForTab(): boolean {
        const tab = this.activeRequestTab();
        return tab === 'overview' || tab === 'workflow';
    }

    private channel?: RealtimeChannel;
    private errandFundingChannel?: RealtimeChannel;
    private messagesChannel?: RealtimeChannel;
    private issuingElements: Array<{ unmount: () => void }> = [];

    private jobMetadata(): Record<string, any> {
        const raw = (this.job() as any)?.metadata || {};

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

    private completionPin(): string {
        const metadata = this.jobMetadata();
        return this.normalizeCompletionPin(
            metadata['completion_pin'] ||
            metadata['service_completion_pin'] ||
            metadata['delivery_pin']
        );
    }

    private requiresCompletionPin(): boolean {
        return this.completionPin().length >= 4;
    }

    private normalizeCompletionPin(value: unknown): string {
        return String(value ?? '').replace(/\D/g, '').slice(0, 8);
    }

    constructor() {
        addIcons({
            addOutline,
            alertCircleOutline,
            call,
            callOutline,
            cameraOutline,
            checkmarkCircle,
            checkmarkDone,
            chevronBackOutline,
            chevronDownOutline,
            navigate,
            receiptOutline,
            walletOutline,
            locationOutline,
            flagOutline,
            cashOutline,
            timeOutline,
            storefrontOutline,
            cubeOutline,
            carOutline,
            homeOutline,
            informationCircleOutline,
            gitBranchOutline,
            bagHandleOutline,
            cardOutline,
            chatbubbleEllipsesOutline,
            ellipsisHorizontalCircleOutline
        });
    }

    ngOnInit() {
        const id = this.route.snapshot.paramMap.get('id');

        if (this.route.snapshot.queryParamMap.get('chat') === '1') {
            this.activeRequestTab.set('chat');
        }

        void this.loadJob(id || '');

        if (id) {
            this.channel = this.bookingService.subscribeToBooking(id);
            this.subscribeToErrandFunding(id);
            this.subscribeToJobMessages(id);
            
            // Subscribe to notifications for this job
            this.notificationOrchestrator.subscribeToJob(id);
        }
    }

    ngOnDestroy() {
        void this.channel?.unsubscribe();
        void this.errandFundingChannel?.unsubscribe();
        void this.messagesChannel?.unsubscribe();
        
        // Unsubscribe from notifications
        const jobId = this.job()?.id;
        if (jobId) {
            this.notificationOrchestrator.unsubscribeFromJob(jobId);
        }
        
        this.unmountIssuingCardElements();
        this.locationService.stopTracking();
    }

    async loadJob(id: string) {
        this.isLoading.set(true);

        try {
            if (!id) {
                this.driverService.activeJob.set(null);
                return;
            }

            let currentJob = this.job();

            if (!currentJob || currentJob.id !== id) {
                currentJob = await this.bookingService.getBooking(id);
                this.driverService.activeJob.set(currentJob as Booking);
            }

            if (!currentJob) {
                this.driverService.activeJob.set(null);
                return;
            }

            const details = await this.bookingService.getBookingDetails(
                currentJob.id,
                currentJob.service_slug as ServiceTypeEnum
            );

            // Debug logs to see actual data structure
            console.log('[DriverJobDetails] job', currentJob);
            console.log('[DriverJobDetails] details row', details);
            console.log('[DriverJobDetails] metadata', currentJob.metadata);

            this.details.set(details as JobDetails | null);

            if (currentJob.service_slug === ServiceTypeEnum.ERRAND && this.isShoppingErrand()) {
                const funding = await this.bookingService.getErrandFunding(currentJob.id);
                this.funding.set(funding);
                await this.loadIssuingCardStatus(currentJob.id);
            } else {
                this.funding.set(null);
                this.issuingCardStatus.set(null);
                this.cardDetailsVisible.set(false);
                this.cardDetailsError.set('');
                this.unmountIssuingCardElements();
            }

            this.ensureLiveLocationTracking(currentJob as Booking);
            await this.refreshMessageCount(currentJob.id);
            void this.renderPickupRoute();
        } catch (error) {
            console.error('Failed to load request details:', error);
            this.driverService.activeJob.set(null);
        } finally {
            this.isLoading.set(false);
        }
    }

    private patchErrandDetails(updatedDetails: Partial<ErrandDetails> | null | undefined) {
        if (!updatedDetails) return;

        this.details.update((current) => ({
            ...((current || {}) as ErrandDetails),
            ...updatedDetails
        }) as JobDetails);
    }

    private patchErrandFunding(partial: Record<string, unknown>) {
        this.funding.update((current) => ({
            ...((current || {}) as ErrandFunding),
            ...partial
        }) as ErrandFunding);
    }

    private async loadIssuingCardStatus(jobId: string): Promise<void> {
        try {
            const status = await this.driverService.getErrandIssuingCardStatus(jobId);
            this.issuingCardStatus.set(status);
        } catch (error) {
            console.error('Failed to load Movabi Pay card status:', error);
            this.issuingCardStatus.set({
                enabled: false,
                status: 'error',
                message: 'Movabi Pay card status is unavailable. Use receipt upload for this errand.',
                jobId
            });
        }
    }

    issuingCardTitle(): string {
        const status = this.issuingCardStatus();

        switch (status?.status) {
            case 'active':
                return 'Virtual card ready for the shop';
            case 'ready':
                return 'Virtual card can be activated';
            case 'needs_cardholder':
                return 'Virtual card setup needed';
            case 'not_configured':
                return 'Receipt flow active';
            case 'error':
                return 'Card status unavailable';
            default:
                return 'Movabi Pay protected';
        }
    }

    issuingCardMessage(): string {
        const status = this.issuingCardStatus();

        if (!status) {
            return '';
        }

        if (status.status === 'active') {
            return 'Use the Movabi virtual card only for this customer shop. The card is capped to the approved item budget.';
        }

        return status.message || 'Movabi protects the customer budget and records card spend against this errand.';
    }

    issuingCardBadgeText(): string {
        const status = this.issuingCardStatus()?.status;

        if (status === 'active') return 'Ready';
        if (status === 'ready') return 'Action needed';
        if (status === 'needs_cardholder' || status === 'needs_driver_profile') return 'Setup needed';
        if (status === 'disabled') return 'Disabled';
        if (status === 'error') return 'Check needed';
        return 'Unavailable';
    }

    issuingCardStatusLabel(): string {
        const status = this.issuingCardStatus()?.status;

        if (status === 'active') return 'Ready to use';
        if (status === 'ready') return 'Waiting for driver activation';
        if (status === 'needs_cardholder') return 'Driver card setup needed';
        if (status === 'needs_driver_profile') return 'Driver profile missing';
        if (status === 'not_configured') return 'Receipt flow only';
        if (status === 'disabled') return 'Disabled for this errand';
        if (status === 'error') return 'Status unavailable';
        return 'Not available';
    }

    issuingCardActionLabel(): string {
        const status = this.issuingCardStatus()?.status;

        if (status === 'active') return `Add to ${this.phoneWalletName()}`;
        if (status === 'ready') return 'Tap Activate card now';
        if (status === 'needs_cardholder' || status === 'needs_driver_profile') return 'Tap Set up Movabi Pay card';
        if (status === 'not_configured') return 'Upload receipt after purchase';
        if (status === 'disabled') return 'Use receipt flow';
        if (status === 'error') return 'Refresh or use receipt flow';
        return 'Wait for card setup';
    }

    issuingCardNextStep(): string {
        const status = this.issuingCardStatus()?.status;

        if (status === 'active') {
            return `Add the card to ${this.phoneWalletName()} and tap your phone at checkout. If the shop cannot accept phone wallet payment, use the secure card details.`;
        }

        if (status === 'ready') {
            return 'Tap Activate card now before shopping. Movabi will unlock this card only for the approved customer item budget.';
        }

        if (status === 'needs_cardholder' || status === 'needs_driver_profile') {
            return 'Tap Set up Movabi Pay card. Movabi will prepare a driver virtual card, then you can activate it for this shop budget.';
        }

        return 'Movabi Pay is not available for this shop yet. Use receipt upload so the spend can still be recorded.';
    }

    issuingCardBudgetLimit(): number {
        const metadata = this.jobMetadata();
        const errandMetadata = metadata['errand_details'] || {};
        const paymentSplit = metadata['payment_split'] || {};

        return this.firstPositiveMoney(
            this.approvedErrandItemBudget(),
            this.issuingCardStatus()?.budgetLimit,
            errandMetadata?.budget,
            errandMetadata?.estimated_budget,
            errandMetadata?.wallet_budget,
            paymentSplit?.item_budget
        );
    }

    approvedErrandItemBudget(): number {
        const initialBudget = Math.max(0, this.toNumber(this.errandDetails()?.estimated_budget));
        const currentFunding = this.funding();
        const approvedExtra = currentFunding?.over_budget_status === 'approved'
            ? Math.max(0, this.toNumber(currentFunding.requested_over_budget_amount ?? currentFunding.over_budget_amount))
            : 0;

        return Number((initialBudget + approvedExtra).toFixed(2));
    }

    virtualCardDisplayNumber(): string {
        const last4 = String(this.issuingCardStatus()?.last4 || '').trim();
        return last4 ? `•••• •••• •••• ${last4}` : '•••• •••• •••• ••••';
    }

    virtualCardOwnerLabel(): string {
        const firstName = this.virtualCardDriverName().split(' ')[0];

        return firstName && firstName !== 'DRIVER'
            ? `${this.toTitleCase(firstName)}'s Card`
            : 'Driver Card';
    }

    virtualCardDriverName(): string {
        const profile = this.profileService.profile() as any;
        const fullName = String(profile?.full_name || profile?.display_name || profile?.name || '').trim();
        const firstLast = [profile?.first_name, profile?.last_name]
            .map((part: unknown) => String(part || '').trim())
            .filter(Boolean)
            .join(' ');
        const emailName = String(profile?.email || '')
            .split('@')[0]
            .replace(/[._-]+/g, ' ')
            .trim();

        return this.toTitleCase(fullName || firstLast || emailName || 'Driver');
    }

    private toTitleCase(value: string): string {
        return String(value || '')
            .toLowerCase()
            .replace(/\b(\p{L}|\p{N})/gu, match => match.toUpperCase());
    }

    canActivateIssuingCard(): boolean {
        const status = this.issuingCardStatus();
        return status?.enabled === true && status.status === 'ready';
    }

    canSetupIssuingCard(): boolean {
        const status = this.issuingCardStatus();
        return status?.enabled === true && ['needs_cardholder', 'needs_driver_profile'].includes(status.status);
    }

    canProvisionIssuingCard(): boolean {
        const status = this.issuingCardStatus();
        return status?.enabled === true && status.status === 'active' && !!status.cardId;
    }

    phoneWalletName(): string {
        return this.walletProvisioning.getWalletName();
    }

    async activateIssuingCard(): Promise<void> {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const loading = await this.loadingCtrl.create({ message: 'Activating Movabi Pay virtual card...' });
        await loading.present();

        try {
            const status = await this.driverService.activateErrandIssuingCard(currentJob.id);
            this.issuingCardStatus.set(status);
            await this.showToast('Movabi Pay virtual card is ready for this shop.', 'success');
        } catch (error: unknown) {
            const message = this.getErrorMessage(error, 'Could not activate Movabi Pay virtual card.');
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async setupIssuingCard(): Promise<void> {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        this.isSettingUpIssuingCard.set(true);

        try {
            await this.driverService.ensureMovabiPayVirtualCard();
            await this.loadIssuingCardStatus(currentJob.id);
            await this.showToast('Movabi Pay card setup started. You can activate it once it is ready.', 'success');
        } catch (error: unknown) {
            const message = this.getErrorMessage(error, 'Could not set up Movabi Pay card.');
            await this.showToast(message, 'danger');
        } finally {
            this.isSettingUpIssuingCard.set(false);
        }
    }

    async addIssuingCardToWallet(): Promise<void> {
        const status = this.issuingCardStatus();

        if (!status?.cardId) {
            await this.showToast('Movabi Pay virtual card is not ready yet.', 'warning');
            return;
        }

        this.isProvisioningToWallet.set(true);

        try {
            const result = await this.walletProvisioning.provisionCard({
                cardId: status.cardId,
                cardholderId: status.cardholderId,
                last4: status.last4,
                currency: status.currency || 'GBP',
                spendLimit: this.issuingCardBudgetLimit(),
                displayName: 'Movabi Pay',
                description: 'Movabi Pay shop virtual card'
            });

            if (result.success) {
                await this.showToast(result.message || `Movabi Pay card added to ${result.walletName || this.phoneWalletName()}.`, 'success');
                return;
            }

            await this.showToast(result.message || `${result.walletName || this.phoneWalletName()} is not available yet.`, 'warning');
        } finally {
            this.isProvisioningToWallet.set(false);
        }
    }

    async revealIssuingCardDetails(): Promise<void> {
        const status = this.issuingCardStatus();

        if (!status?.cardId) {
            await this.showToast('Movabi Pay virtual card is not ready yet.', 'warning');
            return;
        }

        this.isRevealingCardDetails.set(true);
        this.cardDetailsError.set('');
        this.cardDetailsVisible.set(true);
        this.unmountIssuingCardElements();

        try {
            await new Promise((resolve) => setTimeout(resolve, 0));

            const stripe = await this.paymentService.getStripe();

            if (!stripe) {
                throw new Error('Stripe secure card display is unavailable.');
            }

            const nonceResult = await stripe.createEphemeralKeyNonce({ issuingCard: status.cardId });

            if (nonceResult.error || !nonceResult.nonce) {
                throw new Error(nonceResult.error?.message || 'Could not start secure card details session.');
            }

            const session = await this.driverService.createIssuingCardDetailsSession(status.cardId, nonceResult.nonce);
            const options = {
                issuingCard: status.cardId,
                ephemeralKeySecret: session.ephemeralKeySecret,
                nonce: nonceResult.nonce,
                style: {
                    base: {
                        color: '#020617',
                        fontSize: '16px',
                        fontFamily: 'Inter, system-ui, sans-serif',
                        fontWeight: '700'
                    }
                }
            };
            const elements = stripe.elements();
            const numberElement = elements.create('issuingCardNumberDisplay', options);
            const expiryElement = elements.create('issuingCardExpiryDisplay', options);
            const cvcElement = elements.create('issuingCardCvcDisplay', options);

            numberElement.mount(this.issuingCardNumberElement?.nativeElement || '#issuing-card-number');
            expiryElement.mount(this.issuingCardExpiryElement?.nativeElement || '#issuing-card-expiry');
            cvcElement.mount(this.issuingCardCvcElement?.nativeElement || '#issuing-card-cvc');

            this.issuingElements = [numberElement, expiryElement, cvcElement];
        } catch (error: unknown) {
            const message = this.getErrorMessage(error, 'Could not reveal secure card details.');
            this.cardDetailsError.set(message);
            await this.showToast(message, 'danger');
        } finally {
            this.isRevealingCardDetails.set(false);
        }
    }

    private unmountIssuingCardElements(): void {
        for (const element of this.issuingElements) {
            try {
                element.unmount();
            } catch {
                // Stripe Elements may already be unmounted when the Angular view changes.
            }
        }

        this.issuingElements = [];
    }

    private subscribeToErrandFunding(id: string): void {
        void this.errandFundingChannel?.unsubscribe();

        this.errandFundingChannel = this.supabase
            .channel(`driver-errand-funding-${id}`)
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
                        this.funding.set(nextFunding);
                    }

                    await this.loadIssuingCardStatus(id);
                    await this.loadJob(id);
                }
            )
            .subscribe((status) => {
                console.log('[driver-job-details] errand funding realtime:', status);
            });
    }

    private subscribeToJobMessages(id: string): void {
        void this.messagesChannel?.unsubscribe();

        this.messagesChannel = this.supabase
            .channel(`driver-job-messages-${id}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'job_messages',
                    filter: `job_id=eq.${id}`
                },
                () => {
                    void this.refreshMessageCount(id);
                }
            )
            .subscribe((status) => {
                console.log('[driver-job-details] messages realtime:', status);
            });
    }

    private async refreshMessageCount(id: string): Promise<void> {
        try {
            const { count, error } = await this.supabase
                .from('job_messages')
                .select('id', { count: 'exact', head: true })
                .eq('job_id', id);

            if (error) {
                console.warn('[driver-job-details] message count failed', error);
                return;
            }

            const nextCount = count || 0;
            const previousCount = this.messageCount();
            this.messageCount.set(nextCount);

            if (this.activeRequestTab() !== 'chat' && nextCount > previousCount) {
                // unreadMessageCount is now computed, cannot update directly
            }
        } catch (error) {
            console.warn('[driver-job-details] message count unavailable', error);
        }
    }

    async updateStatus(status: BookingStatus) {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const loading = await this.loadingCtrl.create({ message: 'Updating status...' });
        await loading.present();

        try {
            const updated = await this.driverService.updateJobStatus(currentJob.id, status);
            this.driverService.activeJob.set(updated as Booking);
            await this.loadJob(currentJob.id);
            void this.renderPickupRoute();
            await this.showToast('Status updated.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Update failed';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    canHandoffJob(): boolean {
        const status = this.job()?.status || '';
        return [
            'assigned',
            'accepted',
            'heading_to_pickup',
            'arrived',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'in_progress',
            'delivered',
            'over_budget_requested'
        ].includes(status);
    }

    async openHandoffRequest(): Promise<void> {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const alert = await this.alertCtrl.create({
            header: "Can't continue?",
            message: 'Use this only if you cannot complete the request. Movabi will protect the customer payment and reassign or review the job.',
            inputs: [
                {
                    name: 'reason',
                    type: 'textarea',
                    placeholder: 'Tell us what happened, e.g. vehicle breakdown, emergency, shop closed'
                }
            ],
            buttons: [
                { text: 'Go back', role: 'cancel' },
                {
                    text: 'Hand off request',
                    role: 'destructive',
                    handler: (data) => {
                        const reason = String(data?.reason || '').trim();

                        if (reason.length < 6) {
                            void this.showToast('Please add a short reason.', 'warning');
                            return false;
                        }

                        void this.handoffRequest(currentJob.id, reason);
                        return true;
                    }
                }
            ]
        });

        await alert.present();
    }

    private async handoffRequest(jobId: string, reason: string): Promise<void> {
        const loading = await this.loadingCtrl.create({ message: 'Handing off request...' });
        await loading.present();

        try {
            const result = await this.driverService.handoffJob(jobId, reason);
            await this.showToast(result.message || 'Request handed off.', result.mode === 'review' ? 'warning' : 'success');
            this.nav.navigateRoot('/driver');
        } catch (error: unknown) {
            const message = this.getErrorMessage(error, 'Could not hand off this request.');
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    startStatus(): BookingStatus {
        if (this.job()?.service_slug === ServiceTypeEnum.ERRAND) {
            return 'arrived_at_store' as BookingStatus;
        }

        return 'in_progress' as BookingStatus;
    }

    nextArrivedAtStoreStatus(): BookingStatus {
        return (this.isShoppingErrand() ? 'shopping_in_progress' : 'collected') as BookingStatus;
    }

    arrivedAtStoreActionLabel(): string {
        return this.isShoppingErrand() ? 'Start Shopping' : 'Item Collected';
    }

    async completeTrip() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        if (currentJob.service_slug === ServiceTypeEnum.ERRAND && this.isShoppingErrand()) {
            const errandDetails = this.details() as ErrandDetails | null;
            const estimatedBudget = Number(errandDetails?.estimated_budget ?? 0);
            const actualSpending = Number(errandDetails?.actual_spending ?? 0);

            // If this errand had an item/shopping budget, the driver must enter actual spend.
            if (estimatedBudget > 0 && actualSpending <= 0) {
                await this.showToast('Please enter the actual amount spent before completing.', 'warning');
                return;
            }

            // If money was spent from the customer budget, a receipt is mandatory.
            if (estimatedBudget > 0 && actualSpending > 0 && !errandDetails?.receipt_url) {
                await this.showToast('Please upload a receipt before completing this errand.', 'warning');
                return;
            }

            if (this.funding()?.over_budget_status === 'requested') {
                await this.showToast('Please wait for the customer to approve or reject the extra budget request.', 'warning');
                return;
            }
        }

        const alert = await this.alertCtrl.create({
            header: 'Complete Request',
            message: this.requiresCompletionPin()
                ? 'Ask the customer for their Movabi completion PIN. Payment settlement will only continue after the correct PIN is entered.'
                : 'Confirm this request is fully completed. Payment settlement will only continue after completion.',
            inputs: this.requiresCompletionPin()
                ? [
                    {
                        name: 'completionPin',
                        type: 'tel',
                        placeholder: '4-digit customer PIN',
                        attributes: {
                            inputmode: 'numeric',
                            maxlength: 6,
                            autocomplete: 'one-time-code'
                        }
                    }
                ]
                : [],
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Complete',
                    role: 'confirm',
                    handler: (data) => {
                        const completionPin = this.normalizeCompletionPin(data?.completionPin);

                        if (this.requiresCompletionPin() && completionPin.length < 4) {
                            void this.showToast('Enter the customer completion PIN.', 'warning');
                            return false;
                        }

                        void this.executeCompletion(completionPin);
                        return true;
                    }
                }
            ]
        });

        await alert.present();
    }

    private async executeCompletion(completionPin?: string) {
        const currentJob = this.job();

        if (!currentJob?.id) return;

        const loading = await this.loadingCtrl.create({ message: 'Completing request...' });
        await loading.present();

        try {
            const completed = await this.driverService.completeJob(currentJob.id, completionPin);

            if (completed) {
                this.driverService.activeJob.set(completed as Booking);
            } else {
                await this.loadJob(currentJob.id);
            }

            await this.showToast('Request completed.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Could not complete request.';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async recordSpending() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const currentDetails = this.details() as any;
        const approvedBudget = this.approvedErrandItemBudget();

        const alert = await this.alertCtrl.create({
            header: 'Record Spending',
            message: `Enter the actual item spend. Maximum approved budget: ${this.formatPrice(approvedBudget)}.`,
            inputs: [
                {
                    name: 'amount',
                    type: 'number',
                    placeholder: 'Amount, e.g. 15.50',
                    min: 0,
                    max: approvedBudget,
                    value: currentDetails?.actual_spending ?? ''
                },
                {
                    name: 'notes',
                    type: 'textarea',
                    placeholder: 'Notes, optional',
                    value: currentDetails?.spending_notes ?? ''
                }
            ],
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Save',
                    handler: (data) => {
                        const amount = Number(data?.amount);

                        if (!Number.isFinite(amount) || amount <= 0) {
                            void this.showToast('Enter a valid amount.', 'warning');
                            return false;
                        }

                        if (amount > approvedBudget) {
                            void this.showToast(
                                `Spending cannot exceed the approved ${this.formatPrice(approvedBudget)} item budget. Request extra budget first.`,
                                'warning'
                            );
                            return false;
                        }

                        void this.saveSpending(currentJob.id, amount, data?.notes || '');
                        return true;
                    }
                }
            ]
        });

        await alert.present();
    }

    private async saveSpending(jobId: string, amount: number, notes?: string) {
        const loading = await this.loadingCtrl.create({ message: 'Saving spending...' });
        await loading.present();

        try {
            const updatedDetails = await this.driverService.recordErrandSpending(jobId, amount, notes);
            this.patchErrandDetails(updatedDetails);
            await this.loadJob(jobId);
            await this.showToast('Spending recorded.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to save spending.';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async requestOverBudget() {
        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            return;
        }

        const alert = await this.alertCtrl.create({
            header: 'Request Extra Budget',
            subHeader: 'Ask the customer to approve additional funds.',
            inputs: [
                {
                    name: 'amount',
                    type: 'number',
                    min: 0,
                    placeholder: 'Additional amount needed'
                },
                {
                    name: 'reason',
                    type: 'textarea',
                    placeholder: 'Reason for extra budget'
                }
            ],
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Request',
                    handler: (data) => {
                        const amount = Number(data?.amount);
                        const reason = String(data?.reason || '').trim();

                        if (!Number.isFinite(amount) || amount <= 0) {
                            void this.showToast('Enter a valid amount.', 'warning');
                            return false;
                        }

                        if (!reason) {
                            void this.showToast('Please enter a reason.', 'warning');
                            return false;
                        }

                        void this.sendOverBudgetRequest(currentJob.id, amount, reason);
                        return true;
                    }
                }
            ]
        });

        await alert.present();
    }

    private async sendOverBudgetRequest(jobId: string, amount: number, reason: string) {
        const loading = await this.loadingCtrl.create({ message: 'Sending request...' });
        await loading.present();

        try {
            await this.driverService.requestOverBudget(jobId, amount, reason);
            this.patchErrandFunding({
                over_budget_status: 'requested',
                over_budget_amount: amount,
                requested_over_budget_amount: amount,
                over_budget_reason: reason,
                status: 'over_budget_requested',
                updated_at: new Date().toISOString()
            });
            await this.loadJob(jobId);
            await this.showToast('Extra budget request sent.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to send request.';
            await this.showToast(message, 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async onReceiptSelected(event: Event) {
        const target = event.target as HTMLInputElement;
        const file = target.files?.[0];

        if (!file) return;

        const currentJob = this.job();

        if (!currentJob?.id) {
            await this.showToast('Request not found.', 'danger');
            target.value = '';
            return;
        }

        const maxSizeMb = 8;
        const maxBytes = maxSizeMb * 1024 * 1024;

        if (file.size > maxBytes) {
            await this.showToast(`Receipt must be smaller than ${maxSizeMb}MB.`, 'warning');
            target.value = '';
            return;
        }

        const loading = await this.loadingCtrl.create({ message: 'Uploading receipt...' });
        await loading.present();

        try {
            const updatedDetails = await this.driverService.uploadErrandReceipt(currentJob.id, file);
            this.patchErrandDetails(updatedDetails);
            await this.loadJob(currentJob.id);
            await this.showToast('Receipt uploaded.', 'success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Upload failed.';
            await this.showToast(message, 'danger');
        } finally {
            target.value = '';
            await loading.dismiss();
        }
    }

    callPhone(phone?: string | null) {
        const safePhone = String(phone || '').trim();

        if (!safePhone) {
            void this.showToast('Phone number is unavailable.', 'warning');
            return;
        }

        window.location.href = `tel:${safePhone}`;
    }

    openMap(address?: string | null) {
        const safeAddress = String(address || '').trim();

        if (!safeAddress) {
            void this.showToast('Address is unavailable.', 'warning');
            return;
        }

        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(safeAddress)}`, '_blank');
    }

    private async renderPickupRoute(): Promise<void> {
        const currentJob = this.job();

        if (!currentJob || !this.pickupMap) {
            setTimeout(() => void this.renderPickupRoute(), 350);
            return;
        }

        const pickupLat = Number((currentJob as any).pickup_lat);
        const pickupLng = Number((currentJob as any).pickup_lng);

        if (!this.isValidCoordinate(pickupLat) || !this.isValidCoordinate(pickupLng)) {
            this.pickupMapReady.set(false);
            return;
        }

        this.pickupMap.addOrUpdateMarker({
            id: 'pickup',
            coordinates: { lat: pickupLat, lng: pickupLng },
            kind: 'pickup',
            serviceType: currentJob.service_slug as ServiceTypeSlug,
            label: this.mapOriginMarkerLabel()
        });

        const position = await this.locationService.getCurrentPosition();

        if (!position) {
            this.pickupMap.setCenter(pickupLng, pickupLat, 14);
            this.pickupMapReady.set(true);
            return;
        }

        const driverPosition = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };

        this.pickupMap.addOrUpdateMarker({
            id: 'driver-current',
            coordinates: driverPosition,
            kind: 'driver',
            serviceType: currentJob.service_slug as ServiceTypeSlug,
            heading: Number(position.coords.heading || 0),
            label: 'YOU'
        });

        this.routing
            .getRoute(driverPosition, { lat: pickupLat, lng: pickupLng })
            .subscribe({
                next: (route) => {
                    if (route) {
                        this.driverPickupDistance.set(route.distanceMeters);
                        this.driverPickupDuration.set(route.durationSeconds);
                        this.pickupMap?.drawRoute(route);

                        if (route.bounds) {
                            this.pickupMap?.fitBounds(route.bounds, {
                                padding: { top: 60, bottom: 60, left: 45, right: 45 },
                                maxZoom: 15,
                                duration: 700
                            });
                        }
                    } else {
                        this.driverPickupDistance.set(null);
                        this.driverPickupDuration.set(null);
                        this.pickupMap?.setCenter(pickupLng, pickupLat, 14);
                    }

                    this.pickupMapReady.set(true);
                },
                error: (error) => {
                    console.warn('Pickup route draw failed:', error);
                    this.driverPickupDistance.set(null);
                    this.driverPickupDuration.set(null);
                    this.pickupMapReady.set(true);
                }
            });
    }

    private ensureLiveLocationTracking(currentJob: Booking): void {
        const tenantId = (currentJob as any).tenant_id;
        const status = String(currentJob.status || '');

        if (tenantId && status !== 'completed' && status !== 'cancelled') {
            this.locationService.startTracking(tenantId);
        }
    }

    pickupMapTitle(): string {
        if (this.driverPickupDuration() !== null) {
            return `${this.formatDuration(this.driverPickupDuration())} to ${this.originTargetLabel()}`;
        }

        return `Route to ${this.originTargetLabel()}`;
    }

    pickupMapSubtitle(): string {
        if (this.driverPickupDistance() !== null) {
            return `${this.formatDistanceMeters(this.driverPickupDistance())} from your current location.`;
        }

        return `Shows the ${this.originTargetLabel()} and route when GPS is available.`;
    }

    navigationSectionLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store navigation';
            case ServiceTypeEnum.DELIVERY:
                return 'Collection navigation';
            case ServiceTypeEnum.VAN:
                return 'Move pickup navigation';
            default:
                return 'Pickup navigation';
        }
    }

    originActionLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store';
            case ServiceTypeEnum.DELIVERY:
                return 'Collect';
            case ServiceTypeEnum.VAN:
                return 'From';
            default:
                return 'Pickup';
        }
    }

    destinationActionLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Customer';
            case ServiceTypeEnum.DELIVERY:
                return 'Recipient';
            case ServiceTypeEnum.VAN:
                return 'To';
            default:
                return 'Destination';
        }
    }

    originLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store / pickup point';
            case ServiceTypeEnum.DELIVERY:
                return 'Collection point';
            case ServiceTypeEnum.VAN:
                return 'Moving from';
            default:
                return 'Pickup';
        }
    }

    destinationLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Customer delivery address';
            case ServiceTypeEnum.DELIVERY:
                return 'Recipient address';
            case ServiceTypeEnum.VAN:
                return 'Moving to';
            default:
                return 'Destination';
        }
    }

    originUnavailableLabel(): string {
        return `${this.originLabel()} unavailable`;
    }

    destinationUnavailableLabel(): string {
        return `${this.destinationLabel()} unavailable`;
    }

    private originTargetLabel(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'store';
            case ServiceTypeEnum.DELIVERY:
                return 'collection point';
            case ServiceTypeEnum.VAN:
                return 'move pickup';
            default:
                return 'pickup';
        }
    }

    private mapOriginMarkerLabel(): string {
        switch (this.job()?.service_slug) {
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

    customerName(): string {
        const customer = (this.job() as any)?.customer;
        const first = String(customer?.first_name || '').trim();
        const last = String(customer?.last_name || '').trim();

        return first || last || 'Customer';
    }

    customerInitial(): string {
        return this.customerName().charAt(0).toUpperCase() || 'C';
    }

    customerPhone(): string | null {
        const job = this.job() as any;
        const details = this.anyDetails();

        return (
            job?.customer?.phone ||
            details?.customer_phone ||
            details?.recipient_phone ||
            null
        );
    }

    ridePassengerName(): string | null {
        const details = this.anyDetails();
        const metadata = (this.job() as any)?.metadata || {};
        const name = String(
            details?.rider_name ||
            metadata?.ride_details?.rider_name ||
            ''
        ).trim();

        const bookedForSomeoneElse = !!(
            details?.booking_for_someone_else ||
            metadata?.ride_details?.booking_for_someone_else
        );

        return bookedForSomeoneElse && name ? name : null;
    }

    serviceIcon(): string {
        const slug = this.job()?.service_slug;

        if (slug === ServiceTypeEnum.RIDE) return 'car-outline';
        if (slug === ServiceTypeEnum.ERRAND) return 'storefront-outline';
        if (slug === ServiceTypeEnum.DELIVERY) return 'cube-outline';
        if (slug === ServiceTypeEnum.VAN) return 'home-outline';

        return 'wallet-outline';
    }

    serviceWorkEyebrow(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Shop workflow';
            case ServiceTypeEnum.DELIVERY:
                return 'Courier workflow';
            case ServiceTypeEnum.VAN:
                return 'Move workflow';
            default:
                return 'Ride workflow';
        }
    }

    serviceWorkTitle(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return this.isShoppingErrand()
                    ? `Shop for ${this.customerName()}`
                    : `Collect and deliver for ${this.customerName()}`;
            case ServiceTypeEnum.DELIVERY:
                return 'Collect and deliver the package';
            case ServiceTypeEnum.VAN:
                return 'Move items safely';
            default:
                return `Pick up ${this.customerName()}`;
        }
    }

    serviceWorkMessage(): string {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return this.isShoppingErrand()
                    ? 'Use the approved budget, keep the receipt, record the spend, and request extra budget before paying more than approved.'
                    : 'Go to the collection location, collect the item or documents, and deliver them to the customer. No item spend is needed.';
            case ServiceTypeEnum.DELIVERY:
                return 'Confirm the parcel at collection, keep the customer updated, then complete only after delivery.';
            case ServiceTypeEnum.VAN:
                return 'Confirm pickup, handle loading carefully, and complete when the customer move is fully done.';
            default:
                return 'Confirm pickup, start the ride only when ready, and complete at the destination.';
        }
    }

    driverServiceSteps(): Array<{ title: string; description: string; icon: string }> {
        switch (this.job()?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                if (!this.isShoppingErrand()) {
                    return [
                        { title: 'Go to collection point', description: 'Use navigation and mark arrived at the pickup location.', icon: 'navigate-outline' },
                        { title: 'Collect item', description: 'Confirm the item or documents with the customer notes.', icon: 'cube-outline' },
                        { title: 'Deliver to customer', description: 'Return or deliver to the customer, then complete the request.', icon: 'checkmark-circle-outline' }
                    ];
                }

                return [
                    { title: 'Go to store', description: 'Use navigation and mark arrived before shopping.', icon: 'navigate-outline' },
                    { title: 'Buy items', description: 'Use Movabi Pay or upload a receipt if card setup is not ready.', icon: 'card-outline' },
                    { title: 'Deliver and complete', description: 'Deliver to the customer, then complete the request.', icon: 'checkmark-circle-outline' }
                ];
            case ServiceTypeEnum.DELIVERY:
                return [
                    { title: 'Collect parcel', description: 'Confirm the right item and recipient details.', icon: 'cube-outline' },
                    { title: 'Travel to recipient', description: 'Keep the route and live location active.', icon: 'navigate-outline' },
                    { title: 'Confirm delivery', description: 'Complete after the parcel is handed over.', icon: 'checkmark-circle-outline' }
                ];
            case ServiceTypeEnum.VAN:
                return [
                    { title: 'Arrive and load', description: 'Confirm the pickup and load items safely.', icon: 'archive-outline' },
                    { title: 'Move to destination', description: 'Follow the route and keep the customer updated.', icon: 'navigate-outline' },
                    { title: 'Unload and finish', description: 'Complete only when the move is finished.', icon: 'checkmark-circle-outline' }
                ];
            default:
                return [
                    { title: 'Go to pickup', description: 'Navigate to the customer and mark arrived.', icon: 'navigate-outline' },
                    { title: 'Start ride', description: 'Begin only when the customer is ready.', icon: 'car-sport-outline' },
                    { title: 'Drop off', description: 'Complete after safe arrival at destination.', icon: 'flag-outline' }
                ];
        }
    }

    formatStatus(status?: string | null): string {
        if (!status) return 'Pending';
        return this.titleCase(status);
    }

    actionTitle(): string {
        switch (this.job()?.status) {
            case 'accepted':
                return `Go to ${this.originTargetLabel()}`;
            case 'arrived':
                if (this.job()?.service_slug === ServiceTypeEnum.ERRAND) {
                    return this.isShoppingErrand() ? 'Confirm store arrival' : 'Confirm collection arrival';
                }
                if (this.job()?.service_slug === ServiceTypeEnum.DELIVERY) return 'Confirm collection arrival';
                if (this.job()?.service_slug === ServiceTypeEnum.VAN) return 'Start the move';
                return 'Start the ride';
            case 'arrived_at_store':
                return this.isShoppingErrand() ? 'Start shopping' : 'Confirm item collected';
            case 'shopping_in_progress':
                return 'Collect all items';
            case 'collected':
                return this.isShoppingErrand() ? 'Head to customer' : 'Deliver to customer';
            case 'en_route_to_customer':
            case 'in_progress':
            case 'delivered':
                return 'Complete the request';
            default:
                return 'Review request details';
        }
    }

    actionHint(): string {
        switch (this.job()?.status) {
            case 'accepted':
                return `Open the ${this.originTargetLabel()}, contact the customer if needed, then mark yourself arrived.`;
            case 'arrived':
                if (this.job()?.service_slug === ServiceTypeEnum.ERRAND) {
                    return this.isShoppingErrand()
                        ? 'Confirm you are at the correct store before shopping for the customer.'
                        : 'Confirm you are at the correct collection point before collecting the item or documents.';
                }
                if (this.job()?.service_slug === ServiceTypeEnum.DELIVERY) {
                    return 'Confirm you are at the collection point before collecting the package.';
                }
                if (this.job()?.service_slug === ServiceTypeEnum.VAN) {
                    return 'Confirm you are at the move pickup before starting loading.';
                }
                return 'Only start once the customer is ready for the ride.';
            case 'arrived_at_store':
                return this.isShoppingErrand()
                    ? 'Begin shopping after confirming the store and customer notes.'
                    : 'Collect the item or documents, then continue to the customer.';
            case 'shopping_in_progress':
                return 'Record spending and upload a receipt before completing an errand.';
            case 'collected':
                return this.isShoppingErrand()
                    ? 'Items are collected. Navigate to the customer and keep the request moving.'
                    : 'Collection is complete. Navigate to the customer and keep the request moving.';
            case 'en_route_to_customer':
            case 'in_progress':
            case 'delivered':
                return 'Confirm the work is fully done before completing the request.';
            default:
                return 'Check route, customer details, and service requirements before taking action.';
        }
    }

    actionProgress(): number {
        switch (this.job()?.status) {
            case 'accepted':
                return 20;
            case 'arrived':
            case 'arrived_at_store':
                return 40;
            case 'shopping_in_progress':
            case 'in_progress':
                return 65;
            case 'collected':
            case 'en_route_to_customer':
            case 'delivered':
                return 85;
            case 'completed':
                return 100;
            default:
                return 10;
        }
    }

    actionBadgeVariant(): 'success' | 'warning' | 'error' | 'info' | 'secondary' | 'primary' {
        switch (this.job()?.status) {
            case 'completed':
                return 'success';
            case 'accepted':
            case 'arrived':
                return 'primary';
            case 'in_progress':
            case 'shopping_in_progress':
            case 'en_route_to_customer':
                return 'info';
            case 'cancelled':
                return 'error';
            default:
                return 'secondary';
        }
    }

    shortId(id?: string | null): string {
        return String(id || '').slice(0, 8) || 'N/A';
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(this.toNumber(amount));
    }

    hasRecordedErrandSpend(): boolean {
        const amount = this.toNumber(this.errandDetails()?.actual_spending);
        return amount > 0;
    }

    showErrandSpendTools(): boolean {
        if (this.job()?.service_slug !== ServiceTypeEnum.ERRAND) return false;
        if (!this.isShoppingErrand()) return false;

        return [
            'in_progress',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'delivered'
        ].includes(this.job()?.status || '');
    }

    toNumber(value: unknown): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private firstPositiveMoney(...values: unknown[]): number {
        for (const value of values) {
            const amount = this.toNumber(value);

            if (amount > 0) {
                return amount;
            }
        }

        return 0;
    }

    private getErrorMessage(error: unknown, fallback: string): string {
        const httpError = error as { error?: unknown; message?: string };
        const body = httpError?.error;

        if (typeof body === 'string' && body.trim()) {
            return body;
        }

        if (body && typeof body === 'object') {
            const apiError = body as { error?: unknown; message?: unknown };

            if (typeof apiError.error === 'string' && apiError.error.trim()) {
                return apiError.error;
            }

            if (typeof apiError.message === 'string' && apiError.message.trim()) {
                return apiError.message;
            }
        }

        if (typeof httpError?.message === 'string' && httpError.message.trim()) {
            return httpError.message;
        }

        return fallback;
    }

    private isValidCoordinate(value: number): boolean {
        return Number.isFinite(value) && Math.abs(value) > 0.000001;
    }

    private formatDuration(seconds: number | null): string {
        if (!seconds || !Number.isFinite(seconds)) return 'ETA unavailable';
        const minutes = Math.max(1, Math.round(seconds / 60));
        return `${minutes} min`;
    }

    private formatDistanceMeters(meters: number | null): string {
        if (!meters || !Number.isFinite(meters)) return 'Distance unavailable';
        if (meters < 1000) return `${Math.round(meters)} m`;
        return `${(meters / 1000).toFixed(1)} km`;
    }

    // Delivery and errand detail helpers with field name flexibility
    private pickValue(source: any, keys: string[]): string {
        if (!source) return '';

        for (const key of keys) {
            const value = source[key];
            if (value !== null && value !== undefined && String(value).trim() !== '') {
                return String(value).trim();
            }
        }

        return '';
    }

    private deliveryDetailsData(): any {
        return this.anyDetails() || this.job()?.metadata?.['delivery_details'] || {};
    }

    private errandDetailsData(): any {
        return this.anyDetails() || this.job()?.metadata?.['errand_details'] || {};
    }

    recipientName(): string {
        const delivery = this.deliveryDetailsData();
        const errand = this.errandDetailsData();

        return this.pickValue(delivery, ['recipient_name', 'recipientName']) ||
               this.pickValue(errand, ['recipient_name', 'recipientName']);
    }

    recipientPhone(): string {
        const delivery = this.deliveryDetailsData();
        const errand = this.errandDetailsData();

        return this.pickValue(delivery, ['recipient_phone', 'recipientPhone']) ||
               this.pickValue(errand, ['recipient_phone', 'recipientPhone']);
    }

    packageDescription(): string {
        const delivery = this.deliveryDetailsData();

        return this.pickValue(delivery, [
            'item_description',
            'itemDescription',
            'package_description',
            'description'
        ]);
    }

    deliveryPackageSizeLabel(): string {
        const delivery = this.deliveryDetailsData();

        const raw = this.pickValue(delivery, [
            'package_size',
            'packageSize'
        ]).toLowerCase();

        if (raw === 'small') return 'Small';
        if (raw === 'medium') return 'Medium';
        if (raw === 'large') return 'Large';
        if (raw === 'extra_large') return 'Extra Large';

        return raw || '';
    }

    deliveryInstructions(): string {
        const delivery = this.deliveryDetailsData();

        return this.pickValue(delivery, [
            'notes',
            'delivery_instructions',
            'deliveryInstructions',
            'instructions'
        ]);
    }

    errandCustomerPhone(): string {
        const errand = this.errandDetailsData();

        return this.pickValue(errand, [
            'customer_phone',
            'customerPhone'
        ]);
    }

    errandModeDisplay(): string {
        const errand = this.errandDetailsData();

        const raw = this.pickValue(errand, [
            'errand_mode',
            'mode',
            'errandMode'
        ]);

        if (raw === 'collect_deliver') return 'Collect & Deliver';
        if (raw === 'quick_buy') return 'Quick Buy';
        if (raw === 'shop_deliver') return 'Shop & Deliver';

        return raw;
    }

    errandItemsList(): string[] {
        const errand = this.errandDetailsData();

        const raw = errand?.items_list ?? errand?.itemsList ?? errand?.items ?? [];

        if (Array.isArray(raw)) return raw.filter(Boolean).map(String);

        return String(raw || '')
            .split(/[,\n]+/)
            .map(v => v.trim())
            .filter(Boolean);
    }

    estimatedBudget(): string {
        const errand = this.errandDetailsData();

        return this.pickValue(errand, [
            'estimated_budget',
            'estimatedBudget',
            'budget'
        ]);
    }

    formattedEstimatedBudget(): string {
        const budget = this.estimatedBudget();
        return this.config.formatCurrency(Number(budget) || 0);
    }

    substitutionRule(): string {
        const errand = this.errandDetailsData();

        const raw = this.pickValue(errand, [
            'substitution_rule',
            'substitutionRule'
        ]);

        if (raw === 'contact_me') return 'Contact me';
        if (raw === 'best_match') return 'Best match';
        if (raw === 'do_not_substitute') return 'Do not substitute';
        if (raw === 'contact_first') return 'Contact First';
        if (raw === 'similar_quality') return 'Similar Quality';
        if (raw === 'any_available') return 'Any Available';
        if (raw === 'no_substitution') return 'No Substitution';

        return raw;
    }

    private titleCase(value: string): string {
        return value
            .replace(/[_-]/g, ' ')
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
        const toast = await this.toastCtrl.create({
            message,
            duration: 2200,
            color,
            position: 'top'
        });

        await toast.present();
    }
}
