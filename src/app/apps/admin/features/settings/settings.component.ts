import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { FormsModule } from '@angular/forms';
import { addIcons } from 'ionicons';
import {
    settingsOutline,
    globeOutline,
    trashOutline,
    addCircleOutline,
    saveOutline,
    refreshOutline,
    checkmarkCircleOutline,
    helpCircleOutline,
    notificationsOutline,
    keyOutline,
    sendOutline,
    cloudUploadOutline
} from 'ionicons/icons';
import { SystemConfigService } from '../../../../core/services/config/system-config.service';
import { AppConfigService, CountryConfig } from '../../../../core/services/config/app-config.service';
import { OnboardingTourService } from '../../../../core/services/onboarding-tour/onboarding-tour.service';
import { SupabaseService } from '../../../../core/services/supabase/supabase.service';
import { ApiUrlService } from '../../../../core/services/api-url.service';
import {
    MarketplaceConfigService,
    MarketplaceSettings
} from '../../../../core/services/marketplace/marketplace-config.service';

type SettingsTab = 'general' | 'countries' | 'notifications' | 'appVersion' | 'marketplace';

@Component({
    selector: 'app-admin-settings',
    standalone: true,
    imports: [CommonModule, IonicModule, FormsModule],
    template: `
    <div class="w-full min-h-screen bg-slate-50 overflow-y-auto">
      <div class="max-w-6xl mx-auto p-5 md:p-8 space-y-6 pb-12">

        <div class="bg-white border border-slate-100 rounded-[2rem] shadow-sm p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div>
            <h1 class="text-2xl md:text-3xl font-display font-bold text-slate-950">System Settings</h1>
            <p class="text-sm text-slate-500 font-medium mt-1">
              Configure countries, currencies, regional map settings and push notifications.
            </p>
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <button type="button" (click)="restartAdminTour()" class="secondary-btn">
              <ion-icon name="help-circle-outline"></ion-icon>
              Restart Tour
            </button>

            <button type="button" (click)="resetChanges()" [disabled]="saving()" class="secondary-btn">
              <ion-icon name="refresh-outline"></ion-icon>
              Reset
            </button>

            <button type="button" (click)="saveAll()" [disabled]="saving()" class="primary-btn">
              <ion-icon name="save-outline"></ion-icon>
              {{ saving() ? 'Saving...' : 'Save Changes' }}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div class="lg:col-span-1">
            <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm p-3 lg:sticky lg:top-5 space-y-2">
              <button type="button" (click)="activeTab.set('general')" [class]="activeTab() === 'general' ? 'nav-btn active' : 'nav-btn'">
                <ion-icon name="settings-outline"></ion-icon>
                <span>General Defaults</span>
              </button>

              <button type="button" (click)="activeTab.set('countries')" [class]="activeTab() === 'countries' ? 'nav-btn active' : 'nav-btn'">
                <ion-icon name="globe-outline"></ion-icon>
                <span>Countries & Currencies</span>
                <span class="ml-auto text-[10px] px-2 py-1 rounded-full bg-slate-100 text-slate-500">
                  {{ countries.length }}
                </span>
              </button>

              <button type="button" (click)="activeTab.set('notifications')" [class]="activeTab() === 'notifications' ? 'nav-btn active' : 'nav-btn'">
                <ion-icon name="notifications-outline"></ion-icon>
                <span>Push Notifications</span>
                @if (notificationConfig.configured) {
                  <span class="ml-auto text-[10px] px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">
                    Ready
                  </span>
                }
              </button>

              <button type="button" (click)="activeTab.set('marketplace')" [class]="activeTab() === 'marketplace' ? 'nav-btn active' : 'nav-btn'">
                <ion-icon name="settings-outline"></ion-icon>
                <span>Marketplace Engine</span>
              </button>

              <button type="button" (click)="activeTab.set('appVersion')" [class]="activeTab() === 'appVersion' ? 'nav-btn active' : 'nav-btn'">
                <ion-icon name="cloud-upload-outline"></ion-icon>
                <span>App Version & Updates</span>
                @if (appVersionConfig.updateRequired || appVersionConfig.updateSeverity === 'critical') {
                  <span class="ml-auto text-[10px] px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                    Required
                  </span>
                }
              </button>
            </div>
          </div>

          <div class="lg:col-span-3 space-y-6">
            @if (loading()) {
              <div class="bg-white rounded-[1.5rem] border border-slate-100 p-20 text-center">
                <ion-spinner name="crescent"></ion-spinner>
                <p class="text-sm text-slate-500 font-semibold mt-4">Loading settings...</p>
              </div>
            } @else {
              @if (activeTab() === 'general') {
                <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm overflow-hidden">
                  <div class="p-6 border-b border-slate-100">
                    <h3 class="text-lg font-bold text-slate-950">General Configuration</h3>
                    <p class="text-sm text-slate-500 font-medium mt-1">
                      These settings control default country and map fallback values.
                    </p>
                  </div>

                  <div class="p-6 space-y-6">
                    <div class="grid md:grid-cols-2 gap-5">
                      <div>
                        <label class="field-label">Default Country</label>
                        <select [(ngModel)]="generalConfig.defaultCountryCode" (ngModelChange)="onDefaultCountryChange()" class="field-control">
                          @for (country of countries; track trackCountry(country, $index)) {
                            <option [value]="country.code">
                              {{ country.code || 'N/A' }} - {{ country.name || 'Unnamed country' }}
                            </option>
                          }
                        </select>
                      </div>

                      <div>
                        <label class="field-label">Default Currency Preview</label>
                        <div class="field-control bg-slate-50 flex items-center justify-between">
                          <span>{{ getDefaultCountry()?.currency || 'GBP' }}</span>
                          <strong>{{ getDefaultCountry()?.currencySymbol || '£' }}</strong>
                        </div>
                      </div>
                    </div>

                    <div class="pt-5 border-t border-slate-100">
                      <h4 class="text-sm font-bold text-slate-900 mb-4">Map Defaults</h4>

                      <div class="grid md:grid-cols-2 gap-5">
                        <div>
                          <label class="field-label">Default Latitude</label>
                          <input type="number" step="0.000001" [(ngModel)]="generalConfig.mapLat" class="field-control">
                        </div>

                        <div>
                          <label class="field-label">Default Longitude</label>
                          <input type="number" step="0.000001" [(ngModel)]="generalConfig.mapLng" class="field-control">
                        </div>
                      </div>
                    </div>

                    <div class="rounded-2xl bg-blue-50 border border-blue-100 p-5 flex items-start gap-4">
                      <div class="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
                        <ion-icon name="checkmark-circle-outline" class="text-xl"></ion-icon>
                      </div>
                      <div>
                        <h4 class="text-sm font-bold text-blue-950">Tip</h4>
                        <p class="text-sm text-blue-800 font-medium mt-1">
                          Changing the default country also updates the map latitude and longitude from that country’s saved centre.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              }

              @if (activeTab() === 'notifications') {
                <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm overflow-hidden">
                  <div class="p-6 border-b border-slate-100">
                    <h3 class="text-lg font-bold text-slate-950">Push Notifications</h3>
                    <p class="text-sm text-slate-500 font-medium mt-1">
                      Configure OneSignal securely. The REST API key is never displayed after saving.
                    </p>
                  </div>

                  <div class="p-6 space-y-6">
                    <div class="rounded-2xl bg-amber-50 border border-amber-100 p-5">
                      <h4 class="text-sm font-bold text-amber-900">Security Notice</h4>
                      <p class="text-sm text-amber-800 font-medium mt-1 leading-relaxed">
                        The OneSignal REST API key must stay on the server only. This page sends it to a secure backend endpoint and never stores it in frontend code or localStorage.
                      </p>
                    </div>

                    <div class="grid md:grid-cols-2 gap-5">
                      <div>
                        <label class="field-label">Provider</label>
                        <div class="field-control bg-slate-50 flex items-center justify-between">
                          <span>OneSignal</span>
                          <ion-icon name="notifications-outline"></ion-icon>
                        </div>
                      </div>

                      <div>
                        <label class="field-label">Push Notifications</label>
                        <select [(ngModel)]="notificationConfig.enabled" class="field-control">
                          <option [ngValue]="true">Enabled</option>
                          <option [ngValue]="false">Disabled</option>
                        </select>
                      </div>

                      <div>
                        <label class="field-label">OneSignal App ID</label>
                        <input [(ngModel)]="notificationConfig.appId" class="field-control" placeholder="OneSignal App ID">
                      </div>

                      <div>
                        <label class="field-label">REST API Key Status</label>
                        <div class="field-control bg-slate-50 flex items-center justify-between">
                          <span>{{ notificationConfig.configured ? 'REST API key configured' : 'Not configured' }}</span>
                          <ion-icon name="key-outline"></ion-icon>
                        </div>
                      </div>

                      <div class="md:col-span-2">
                        <label class="field-label">Paste New REST API Key</label>
                        <input
                          type="password"
                          [(ngModel)]="notificationConfig.restApiKey"
                          autocomplete="new-password"
                          class="field-control"
                          placeholder="Paste new REST API key to update"
                        >
                        <p class="text-xs text-slate-500 font-medium mt-2">
                          Leave blank to keep the existing server key.
                        </p>
                      </div>
                    </div>

                    <div class="pt-5 border-t border-slate-100 space-y-4">
                      <h4 class="text-sm font-bold text-slate-900">Test Notification</h4>

                      <div class="grid md:grid-cols-[1fr_auto] gap-4">
                        <div>
                          <label class="field-label">Test User ID</label>
                          <input [(ngModel)]="notificationConfig.testUserId" class="field-control" placeholder="Driver/customer user ID">
                        </div>

                        <button type="button" (click)="sendTestNotification()" [disabled]="testingNotification()" class="primary-btn self-end">
                          <ion-icon name="send-outline"></ion-icon>
                          {{ testingNotification() ? 'Sending...' : 'Send Test' }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              }

              @if (activeTab() === 'marketplace') {
                <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm overflow-hidden">
                  <div class="p-6 border-b border-slate-100">
                    <h3 class="text-lg font-bold text-slate-950">Marketplace Engine</h3>
                    <p class="text-sm text-slate-500 font-medium mt-1">
                      Configure commission, dynamic pricing, negotiation, bidding and smart matching.
                    </p>
                  </div>

                  <div class="p-6 space-y-8">
                    <div>
                      <h4 class="text-sm font-bold text-slate-900 mb-4">Commission</h4>
                      <div class="grid md:grid-cols-3 gap-5">
                        <div>
                          <label class="field-label">Commission %</label>
                          <input type="number" step="0.01" min="0" max="100" [(ngModel)]="marketplaceConfig.commission.percent" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Min Fee</label>
                          <input type="number" step="0.01" min="0" [(ngModel)]="marketplaceConfig.commission.minFee" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Max Fee (optional)</label>
                          <input type="number" step="0.01" min="0" [(ngModel)]="marketplaceConfig.commission.maxFee" class="field-control" placeholder="No max">
                        </div>
                      </div>
                    </div>

                    <div class="pt-6 border-t border-slate-100">
                      <h4 class="text-sm font-bold text-slate-900 mb-4">Dynamic Pricing</h4>
                      <div class="grid md:grid-cols-2 gap-5">
                        <div>
                          <label class="field-label">Enabled</label>
                          <select [(ngModel)]="marketplaceConfig.dynamicPricing.enabled" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>
                        <div>
                          <label class="field-label">Max Surge Multiplier</label>
                          <input type="number" step="0.1" min="1" [(ngModel)]="marketplaceConfig.dynamicPricing.maxSurge" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Time-of-Day Pricing</label>
                          <select [(ngModel)]="marketplaceConfig.dynamicPricing.timeOfDayEnabled" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>
                        <div>
                          <label class="field-label">Demand/Supply Pricing</label>
                          <select [(ngModel)]="marketplaceConfig.dynamicPricing.demandSupplyEnabled" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>
                        <div>
                          <label class="field-label">Traffic Multiplier</label>
                          <input type="number" step="0.05" min="0" [(ngModel)]="marketplaceConfig.dynamicPricing.trafficMultiplier" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Weather Multiplier</label>
                          <input type="number" step="0.05" min="0" [(ngModel)]="marketplaceConfig.dynamicPricing.weatherMultiplier" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Demand Multiplier</label>
                          <input type="number" step="0.05" min="0" [(ngModel)]="marketplaceConfig.dynamicPricing.demandMultiplier" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Fuel Multiplier</label>
                          <input type="number" step="0.05" min="0" [(ngModel)]="marketplaceConfig.dynamicPricing.fuelMultiplier" class="field-control">
                        </div>
                      </div>
                    </div>

                    <div class="pt-6 border-t border-slate-100">
                      <h4 class="text-sm font-bold text-slate-900 mb-4">Negotiation</h4>
                      <div class="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
                        <div>
                          <label class="field-label">Enabled</label>
                          <select [(ngModel)]="marketplaceConfig.negotiation.enabled" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>
                        <div>
                          <label class="field-label">Timeout (seconds)</label>
                          <input type="number" min="10" [(ngModel)]="marketplaceConfig.negotiation.timeoutSeconds" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Max Rounds</label>
                          <input type="number" min="1" [(ngModel)]="marketplaceConfig.negotiation.maxRounds" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Services</label>
                          <input
                            type="text"
                            [ngModel]="marketplaceConfig.negotiation.minServices.join(', ')"
                            (ngModelChange)="updateNegotiationServices($event)"
                            class="field-control"
                            placeholder="errand, delivery, van-moving"
                          >
                        </div>
                      </div>
                      <p class="text-xs text-slate-500 font-medium mt-2">
                        Default services: errand, delivery, van-moving. Add ride to enable negotiation for rides.
                      </p>
                    </div>

                    <div class="pt-6 border-t border-slate-100">
                      <h4 class="text-sm font-bold text-slate-900 mb-4">Hybrid Negotiation</h4>
                      <div class="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
                        <div>
                          <label class="field-label">Enabled</label>
                          <select [(ngModel)]="marketplaceConfig.hybridNegotiation.enabled" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>
                        <div>
                          <label class="field-label">Timeout (seconds)</label>
                          <input type="number" min="10" [(ngModel)]="marketplaceConfig.hybridNegotiation.timeoutSeconds" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Max Rounds</label>
                          <input type="number" min="1" [(ngModel)]="marketplaceConfig.hybridNegotiation.maxRounds" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Max Driver Attempts</label>
                          <input type="number" min="1" [(ngModel)]="marketplaceConfig.hybridNegotiation.maxDriverAttempts" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Enabled Services</label>
                          <input
                            type="text"
                            [ngModel]="marketplaceConfig.hybridNegotiation.enabledServices.join(', ')"
                            (ngModelChange)="updateHybridNegotiationEnabledServices($event)"
                            class="field-control"
                            placeholder="shop, errand, delivery, van, ride"
                          >
                        </div>
                        <div>
                          <label class="field-label">Claim Timeout (seconds)</label>
                          <input type="number" min="10" [(ngModel)]="marketplaceConfig.hybridNegotiation.claimTimeoutSeconds" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Ride Min Distance (km)</label>
                          <input type="number" min="0" [(ngModel)]="marketplaceConfig.hybridNegotiation.rideMinimumDistanceKm" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Make Offer</label>
                          <select [(ngModel)]="marketplaceConfig.hybridNegotiation.makeOfferEnabled" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>
                        <div>
                          <label class="field-label">Accept Fare</label>
                          <select [(ngModel)]="marketplaceConfig.hybridNegotiation.acceptFareEnabled" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>
                        <div class="md:col-span-2 lg:col-span-3">
                          <label class="field-label">Test Allowlist (User IDs)</label>
                          <input
                            type="text"
                            [ngModel]="(marketplaceConfig.hybridNegotiation.allowlist || []).join(', ')"
                            (ngModelChange)="updateHybridNegotiationAllowlist($event)"
                            class="field-control"
                            placeholder="uuid-1, uuid-2"
                          >
                        </div>
                      </div>
                      <p class="text-xs text-slate-500 font-medium mt-2">
                        When global hybrid is disabled, only allowlisted users can access the hybrid flow. While the global flag is off, use this list to test the experience with specific customer and driver accounts. Empty allowlist and disabled global flag means hybrid is off for everyone.
                      </p>
                    </div>

                    <div class="pt-6 border-t border-slate-100">
                      <h4 class="text-sm font-bold text-slate-900 mb-4">Bidding</h4>
                      <div class="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
                        <div>
                          <label class="field-label">Enabled</label>
                          <select [(ngModel)]="marketplaceConfig.bidding.enabled" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>
                        <div>
                          <label class="field-label">Timeout (seconds)</label>
                          <input type="number" min="10" [(ngModel)]="marketplaceConfig.bidding.timeoutSeconds" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Max Bids Per Job</label>
                          <input type="number" min="1" [(ngModel)]="marketplaceConfig.bidding.maxBids" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Services</label>
                          <input
                            type="text"
                            [ngModel]="marketplaceConfig.bidding.enabledServices.join(', ')"
                            (ngModelChange)="updateBiddingServices($event)"
                            class="field-control"
                            placeholder="van, van_moving"
                          >
                        </div>
                      </div>
                      <p class="text-xs text-slate-500 font-medium mt-2">
                        Default bidding services: van, van_moving.
                      </p>
                    </div>

                    <div class="pt-6 border-t border-slate-100">
                      <h4 class="text-sm font-bold text-slate-900 mb-4">Smart Matching</h4>
                      <div class="grid md:grid-cols-2 gap-5">
                        <div>
                          <label class="field-label">Enabled</label>
                          <select [(ngModel)]="marketplaceConfig.smartMatching.enabled" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>
                        <div>
                          <label class="field-label">Max Distance (km)</label>
                          <input type="number" min="1" [(ngModel)]="marketplaceConfig.smartMatching.maxDistanceKm" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Rating Weight</label>
                          <input type="number" step="0.05" min="0" max="1" [(ngModel)]="marketplaceConfig.smartMatching.ratingWeight" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Completion Weight</label>
                          <input type="number" step="0.05" min="0" max="1" [(ngModel)]="marketplaceConfig.smartMatching.completionWeight" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Distance Weight</label>
                          <input type="number" step="0.05" min="0" max="1" [(ngModel)]="marketplaceConfig.smartMatching.distanceWeight" class="field-control">
                        </div>
                        <div>
                          <label class="field-label">Response Weight</label>
                          <input type="number" step="0.05" min="0" max="1" [(ngModel)]="marketplaceConfig.smartMatching.responseWeight" class="field-control">
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              }

              @if (activeTab() === 'appVersion') {
                <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm overflow-hidden">
                  <div class="p-6 border-b border-slate-100">
                    <h3 class="text-lg font-bold text-slate-950">App Version & Updates</h3>
                    <p class="text-sm text-slate-500 font-medium mt-1">
                      Control minimum supported app versions and require refresh/update when production releases need it.
                    </p>
                  </div>

                  <div class="p-6 space-y-6">
                    <div class="rounded-2xl bg-slate-50 border border-slate-100 p-5">
                      <div class="grid md:grid-cols-3 gap-4">
                        <div>
                          <label class="field-label">Current Web Version</label>
                          <input [(ngModel)]="appVersionConfig.currentWebVersion" class="field-control" placeholder="1.0.8">
                        </div>
                        <div>
                          <label class="field-label">Minimum Web Version</label>
                          <input [(ngModel)]="appVersionConfig.minimumWebVersion" class="field-control" placeholder="1.0.8">
                        </div>
                        <div>
                          <label class="field-label">Web Reload Required</label>
                          <select [(ngModel)]="appVersionConfig.webReloadRequired" class="field-control">
                            <option [ngValue]="true">Yes</option>
                            <option [ngValue]="false">No</option>
                          </select>
                        </div>

                        <div>
                          <label class="field-label">Current Android Version</label>
                          <input [(ngModel)]="appVersionConfig.currentAndroidVersion" class="field-control" placeholder="1.0.8">
                        </div>
                        <div>
                          <label class="field-label">Minimum Android Version</label>
                          <input [(ngModel)]="appVersionConfig.minimumAndroidVersion" class="field-control" placeholder="1.0.7">
                        </div>
                        <div>
                          <label class="field-label">Android Update URL</label>
                          <input [(ngModel)]="appVersionConfig.androidUpdateUrl" class="field-control" placeholder="https://play.google.com/store/apps/details?id=com.movabi.app">
                        </div>

                        <div>
                          <label class="field-label">Current iOS Version</label>
                          <input [(ngModel)]="appVersionConfig.currentIosVersion" class="field-control" placeholder="1.0.8">
                        </div>
                        <div>
                          <label class="field-label">Minimum iOS Version</label>
                          <input [(ngModel)]="appVersionConfig.minimumIosVersion" class="field-control" placeholder="1.0.7">
                        </div>
                        <div>
                          <label class="field-label">iOS Update URL</label>
                          <input [(ngModel)]="appVersionConfig.iosUpdateUrl" class="field-control" placeholder="https://apps.apple.com/app/movabi">
                        </div>
                      </div>
                    </div>

                    <div class="grid md:grid-cols-2 gap-5">
                      <div>
                        <label class="field-label">Update Severity</label>
                        <select [(ngModel)]="appVersionConfig.updateSeverity" class="field-control">
                          <option value="optional">Optional</option>
                          <option value="recommended">Recommended</option>
                          <option value="required">Required</option>
                          <option value="critical">Critical</option>
                        </select>
                      </div>

                      <div>
                        <label class="field-label">Force Update</label>
                        <select [(ngModel)]="appVersionConfig.updateRequired" class="field-control">
                          <option [ngValue]="false">No</option>
                          <option [ngValue]="true">Yes</option>
                        </select>
                      </div>

                      <div class="md:col-span-2">
                        <label class="field-label">Update Title</label>
                        <input [(ngModel)]="appVersionConfig.updateTitle" class="field-control" placeholder="Important Movabi update">
                      </div>

                      <div class="md:col-span-2">
                        <label class="field-label">Update Message</label>
                        <textarea [(ngModel)]="appVersionConfig.updateMessage" rows="3" class="field-control min-h-24" placeholder="A new version is required to continue using Movabi."></textarea>
                      </div>

                      <div class="md:col-span-2">
                        <label class="field-label">Release Notes</label>
                        <textarea [(ngModel)]="appVersionConfig.releaseNotes" rows="4" class="field-control min-h-28" placeholder="Improved driver verification and push notifications."></textarea>
                      </div>
                    </div>

                    <div class="rounded-2xl bg-amber-50 border border-amber-100 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <h4 class="text-sm font-bold text-amber-950">Notify users</h4>
                        <p class="text-sm text-amber-800 font-medium mt-1">
                          Sends an in-app/push notice when the update is required. Saving still succeeds if push is unavailable.
                        </p>
                      </div>
                      <label class="inline-flex items-center gap-3 text-sm font-bold text-amber-950">
                        <input type="checkbox" [(ngModel)]="appVersionConfig.sendNotification" class="w-5 h-5 accent-amber-500">
                        Send notification on save
                      </label>
                    </div>
                  </div>
                </div>
              }

              @if (activeTab() === 'countries') {
                <div class="bg-white border border-slate-100 rounded-[1.5rem] shadow-sm overflow-hidden">
                  <div class="p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 class="text-lg font-bold text-slate-950">Countries & Currencies</h3>
                      <p class="text-sm text-slate-500 font-medium mt-1">
                        Manage supported countries, currency symbols, phone codes and map centres.
                      </p>
                    </div>

                    <button type="button" (click)="addCountry()" class="primary-btn h-10 text-xs">
                      <ion-icon name="add-circle-outline"></ion-icon>
                      Add Country
                    </button>
                  </div>

                  <div class="p-6 space-y-5">
                    @for (country of countries; track trackCountry(country, $index); let i = $index) {
                      <div class="rounded-[1.25rem] border border-slate-100 bg-slate-50/60 p-5">
                        <div class="flex items-start justify-between gap-4 mb-5">
                          <div>
                            <h4 class="text-base font-bold text-slate-950">
                              {{ country.name || 'New Country' }}
                              <span class="text-xs text-slate-400 font-semibold ml-2">{{ country.code || 'NO CODE' }}</span>
                            </h4>
                            <p class="text-xs text-slate-500 font-medium mt-1">
                              {{ country.currency || 'Currency missing' }} · {{ country.currencySymbol || 'Symbol missing' }} · {{ country.phoneCode || 'Phone missing' }}
                            </p>
                          </div>

                          <button type="button" (click)="askRemoveCountry(i)" class="icon-danger-btn" title="Remove country">
                            <ion-icon name="trash-outline" class="text-lg"></ion-icon>
                          </button>
                        </div>

                        <div class="grid md:grid-cols-2 gap-4">
                          <div>
                            <label class="field-label">Country Name</label>
                            <input [(ngModel)]="country.name" placeholder="United Kingdom" class="field-control">
                          </div>

                          <div>
                            <label class="field-label">ISO Code</label>
                            <input [(ngModel)]="country.code" (ngModelChange)="country.code = normaliseCode(country.code)" placeholder="GB" maxlength="3" class="field-control uppercase">
                          </div>

                          <div>
                            <label class="field-label">Currency Code</label>
                            <select [(ngModel)]="country.currency" (ngModelChange)="onCurrencyChange(country)" class="field-control">
                              <option value="GBP">GBP - British Pound</option>
                              <option value="USD">USD - US Dollar</option>
                              <option value="EUR">EUR - Euro</option>
                              <option value="NGN">NGN - Nigerian Naira</option>
                              <option value="CAD">CAD - Canadian Dollar</option>
                              <option value="AUD">AUD - Australian Dollar</option>
                              <option value="AED">AED - UAE Dirham</option>
                            </select>
                          </div>

                          <div>
                            <label class="field-label">Currency Symbol</label>
                            <input [(ngModel)]="country.currencySymbol" placeholder="£" maxlength="4" class="field-control">
                          </div>

                          <div>
                            <label class="field-label">Locale</label>
                            <input [(ngModel)]="country.locale" placeholder="en-GB" class="field-control">
                          </div>

                          <div>
                            <label class="field-label">Phone Code</label>
                            <input [(ngModel)]="country.phoneCode" placeholder="+44" class="field-control">
                          </div>
                        </div>

                        <div class="mt-5 pt-5 border-t border-slate-200">
                          <p class="field-label mb-3">Default Map Center</p>

                          <div class="grid md:grid-cols-2 gap-4">
                            <div>
                              <label class="field-label">Latitude</label>
                              <input type="number" step="0.000001" [(ngModel)]="country.defaultCenter.lat" class="field-control">
                            </div>

                            <div>
                              <label class="field-label">Longitude</label>
                              <input type="number" step="0.000001" [(ngModel)]="country.defaultCenter.lng" class="field-control">
                            </div>
                          </div>
                        </div>
                      </div>
                    }
                  </div>
                </div>
              }
            }
          </div>
        </div>
      </div>
    </div>

    @if (confirmRemoveIndex() !== null) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-xl w-full max-w-md p-6">
          <h3 class="text-lg font-bold text-slate-900">Remove Country</h3>
          <p class="text-sm text-slate-500 mt-2">
            Remove "{{ countries[confirmRemoveIndex()!]?.name || 'this country' }}"?
          </p>

          <div class="mt-6 flex gap-3">
            <button type="button" (click)="confirmRemoveIndex.set(null)" class="flex-1 h-11 rounded-xl bg-slate-100 font-bold">
              Cancel
            </button>

            <button type="button" (click)="removeCountryNow()" class="flex-1 h-11 rounded-xl bg-rose-600 text-white font-bold">
              Remove
            </button>
          </div>
        </div>
      </div>
    }

    @if(showToast()) {
      <div class="fixed top-5 right-5 z-[11000]">
        <div
          class="px-5 py-3 rounded-2xl shadow-xl text-white text-sm font-semibold"
          [class.bg-emerald-600]="toastColor()==='success'"
          [class.bg-rose-600]="toastColor()==='danger'"
          [class.bg-amber-500]="toastColor()==='warning'"
        >
          {{ toastMessage() }}
        </div>
      </div>
    }
  `,
    styles: [`
    :host {
      display: block;
      width: 100%;
      min-height: 100%;
    }

    .nav-btn {
      width: 100%;
      padding: 0.9rem 1rem;
      border-radius: 1rem;
      text-align: left;
      font-weight: 800;
      font-size: 0.875rem;
      transition: all 150ms ease;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      color: rgb(71 85 105);
      background: white;
    }

    .nav-btn:hover {
      background: rgb(248 250 252);
    }

    .nav-btn.active {
      background: rgb(37 99 235);
      color: white;
      box-shadow: 0 10px 25px rgb(37 99 235 / 0.2);
    }

    .field-label {
      display: block;
      font-size: 10px;
      font-weight: 800;
      color: rgb(148 163 184);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 0.5rem;
    }

    .field-control {
      width: 100%;
      min-height: 2.75rem;
      background: white;
      border: 1px solid rgb(226 232 240);
      border-radius: 0.85rem;
      padding: 0.7rem 0.9rem;
      font-size: 0.875rem;
      font-weight: 700;
      color: rgb(15 23 42);
      outline: none;
    }

    .field-control:focus {
      border-color: rgb(59 130 246 / 0.55);
      box-shadow: 0 0 0 4px rgb(59 130 246 / 0.10);
    }

    .primary-btn {
      min-height: 2.75rem;
      padding: 0 1.25rem;
      border-radius: 0.75rem;
      background: rgb(37 99 235);
      color: white;
      font-size: 0.875rem;
      font-weight: 800;
      transition: all 150ms ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .secondary-btn {
      min-height: 2.75rem;
      padding: 0 1.25rem;
      border-radius: 0.75rem;
      background: rgb(248 250 252);
      border: 1px solid rgb(226 232 240);
      color: rgb(51 65 85);
      font-size: 0.875rem;
      font-weight: 800;
      transition: all 150ms ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .icon-danger-btn {
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.75rem;
      background: white;
      color: rgb(148 163 184);
      border: 1px solid rgb(241 245 249);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 150ms ease;
    }

    .icon-danger-btn:hover {
      background: rgb(225 29 72);
      color: white;
    }
  `]
})
export class AdminSettingsComponent implements OnInit {
    private systemConfig = inject(SystemConfigService);
    private appConfig = inject(AppConfigService);
    private tour = inject(OnboardingTourService);
    private supabase = inject(SupabaseService);
    private apiUrl = inject(ApiUrlService);
    private marketplaceService = inject(MarketplaceConfigService);

    activeTab = signal<SettingsTab>('general');
    saving = signal(false);
    loading = signal(true);
    testingNotification = signal(false);
    confirmRemoveIndex = signal<number | null>(null);

    toastMessage = signal('');
    toastColor = signal<'success' | 'danger' | 'warning'>('success');
    showToast = signal(false);

    generalConfig = {
        defaultCountryCode: 'GB',
        mapLat: 51.5074,
        mapLng: -0.1278
    };

    notificationConfig = {
        provider: 'onesignal',
        appId: '952c6d19-656c-4dab-90f3-6e253e2c9151',
        restApiKey: '',
        enabled: true,
        configured: false,
        testUserId: ''
    };

    appVersionConfig = {
        currentWebVersion: '1.0.0',
        minimumWebVersion: '1.0.0',
        currentAndroidVersion: '1.0.0',
        minimumAndroidVersion: '1.0.0',
        currentIosVersion: '1.0.0',
        minimumIosVersion: '1.0.0',
        updateRequired: false,
        updateSeverity: 'optional' as 'optional' | 'recommended' | 'required' | 'critical',
        updateTitle: 'Movabi update available',
        updateMessage: 'A new version of Movabi is available.',
        releaseNotes: '',
        androidUpdateUrl: '',
        iosUpdateUrl: '',
        webReloadRequired: false,
        sendNotification: false
    };

    marketplaceConfig: MarketplaceSettings = {
        commission: { percent: 5.0, minFee: 0, maxFee: null },
        dynamicPricing: {
            enabled: true,
            maxSurge: 3.0,
            trafficMultiplier: 1,
            weatherMultiplier: 1,
            demandMultiplier: 1,
            fuelMultiplier: 1,
            timeOfDayEnabled: true,
            demandSupplyEnabled: true,
            weatherEnabled: false,
            trafficEnabled: false,
            eventMultiplierEnabled: false
        },
        negotiation: {
            enabled: true,
            timeoutSeconds: 120,
            maxRounds: 3,
            minServices: ['errand', 'delivery', 'van-moving']
        },
        hybridNegotiation: {
            enabled: false,
            maxRounds: 3,
            timeoutSeconds: 120,
            maxDriverAttempts: 5,
            claimTimeoutSeconds: 60,
            enabledServices: ['shop', 'errand'],
            rideMinimumDistanceKm: 30,
            makeOfferEnabled: true,
            acceptFareEnabled: true,
            allowlist: []
        },
        bidding: {
            enabled: false,
            enabledServices: ['van', 'van_moving'],
            timeoutSeconds: 300,
            maxBids: 10,
            defaultServices: ['van', 'van_moving']
        },
        smartMatching: {
            enabled: true,
            maxDistanceKm: 10,
            ratingWeight: 0.25,
            completionWeight: 0.35,
            distanceWeight: 0.30,
            responseWeight: 0.10
        }
    };
    private originalMarketplaceConfig: MarketplaceSettings = { ...this.marketplaceConfig };

    countries: CountryConfig[] = [];
    private originalCountries: CountryConfig[] = [];

    constructor() {
        addIcons({
            settingsOutline,
            globeOutline,
            trashOutline,
            addCircleOutline,
            saveOutline,
            refreshOutline,
            checkmarkCircleOutline,
            helpCircleOutline,
            notificationsOutline,
            keyOutline,
            sendOutline,
            cloudUploadOutline
        });
    }

    async ngOnInit() {
        await this.loadSettings();
        this.tour.startIfNeeded('admin');
    }

    restartAdminTour() {
        this.tour.restart('admin');
    }

    async loadSettings() {
        this.loading.set(true);

        try {
            await this.systemConfig.loadConfigs();

            const appCountries = this.appConfig.countries();
            const loadedCountries = Array.isArray(appCountries) && appCountries.length
                ? appCountries
                : this.getDefaultCountries();

            this.countries = this.mergeCountries(
                this.cloneCountries(loadedCountries).map(country => this.normaliseCountry(country)),
                this.getDefaultCountries().map(country => this.normaliseCountry(country))
            );

            this.originalCountries = this.cloneCountries(this.countries);

            this.generalConfig.defaultCountryCode = this.normaliseCode(
                this.systemConfig.getConfig('default_country_code', this.countries[0]?.code || 'GB')
            );

            if (!this.countries.find(c => c.code === this.generalConfig.defaultCountryCode)) {
                this.generalConfig.defaultCountryCode = this.countries[0]?.code || 'GB';
            }

            this.notificationConfig.appId = this.systemConfig.getConfig(
                'onesignal_app_id',
                '952c6d19-656c-4dab-90f3-6e253e2c9151'
            );

            this.notificationConfig.enabled = Boolean(this.systemConfig.getConfig('push_notifications_enabled', true));
            await this.loadNotificationSecretStatus();
            await this.loadAppVersionConfig();
            await this.loadMarketplaceConfig();

            this.onDefaultCountryChange();
        } catch (error) {
            console.error('Failed to load settings:', error);

            this.countries = this.getDefaultCountries();
            this.originalCountries = this.cloneCountries(this.countries);
            this.generalConfig.defaultCountryCode = 'GB';
            this.onDefaultCountryChange();

            this.triggerToast('Settings loaded with defaults.', 'warning');
        } finally {
            this.loading.set(false);
        }
    }

    async saveAll() {
        if (!this.validateSettings()) return;
        if (!this.validateNotificationSettings()) return;
        if (!this.validateAppVersionSettings()) return;
        if (!this.validateMarketplaceSettings()) return;

        this.saving.set(true);

        try {
            const normalisedCountries = this.countries.map(country => this.normaliseCountry(country));

            await this.systemConfig.setConfig('countries', normalisedCountries);
            await this.systemConfig.setConfig('default_country_code', this.normaliseCode(this.generalConfig.defaultCountryCode));
            await this.systemConfig.setConfig('default_map_center', {
                lat: Number(this.generalConfig.mapLat || 0),
                lng: Number(this.generalConfig.mapLng || 0)
            });

            await this.systemConfig.setConfig('onesignal_app_id', this.notificationConfig.appId.trim());
            await this.systemConfig.setConfig('push_notifications_enabled', this.notificationConfig.enabled);

            await this.saveNotificationSecret();
            await this.saveAppVersionConfig();
            await this.saveMarketplaceConfig();

            await this.appConfig.refreshConfigs();

            this.countries = this.cloneCountries(normalisedCountries);
            this.originalCountries = this.cloneCountries(normalisedCountries);
            this.notificationConfig.restApiKey = '';
            this.appVersionConfig.sendNotification = false;

            this.triggerToast('Settings saved successfully.', 'success');
        } catch (error) {
            console.error('Error saving settings:', error);
            this.triggerToast(error instanceof Error ? error.message : JSON.stringify(error), 'danger');
        } finally {
            this.saving.set(false);
        }
    }

    private async loadNotificationSecretStatus(): Promise<void> {

        try {

            const headers = await this.getAdminApiHeaders();

            const response = await fetch(
                `${this.apiUrl.getBaseUrl()}/api/admin/settings/secrets/onesignal/status`,
                {
                    method: 'GET',
                    headers
                }
            );

            if (response.status === 401) {
                throw new Error('Administrator authentication required.');
            }

            if (!response.ok) {
                throw new Error('Unable to load OneSignal configuration.');
            }

            const data = await response.json();

            this.notificationConfig.configured = !!data.configured;

            if (data.appId) {
                this.notificationConfig.appId = data.appId;
            }

            if (typeof data.enabled === 'boolean') {
                this.notificationConfig.enabled = data.enabled;
            }

        } catch (err) {

            console.error(err);

            this.notificationConfig.configured = false;
        }
    }

    private async saveNotificationSecret(): Promise<void> {

        const headers = await this.getAdminApiHeaders(true);

        const response = await fetch(
            `${this.apiUrl.getBaseUrl()}/api/admin/settings/secrets/onesignal`,
            {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    appId: this.notificationConfig.appId.trim(),
                    restApiKey: this.notificationConfig.restApiKey.trim() || undefined,
                    enabled: this.notificationConfig.enabled
                })
            }
        );

        if (response.status === 401) {
            throw new Error('Administrator authentication required.');
        }

        if (!response.ok) {

            let message = 'Unable to save OneSignal configuration.';

            try {
                const body = await response.json();
                message = body.error || body.message || message;
            } catch { }

            throw new Error(message);
        }

        const data = await response.json();

        this.notificationConfig.configured = !!data.configured;
        this.notificationConfig.restApiKey = '';

        this.triggerToast(
            data.message || 'OneSignal configuration saved.',
            'success'
        );
    }

    async sendTestNotification(): Promise<void> {

        const userId = this.notificationConfig.testUserId.trim();

        if (!userId) {
            this.triggerToast('Enter a user ID first.', 'warning');
            return;
        }

        this.testingNotification.set(true);

        try {

            const headers = await this.getAdminApiHeaders(true);

            const response = await fetch(
                `${this.apiUrl.getBaseUrl()}/api/admin/notifications/test`,
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        userId,
                        title: 'Movabi Test Notification',
                        body: 'Push notifications are configured correctly.'
                    })
                }
            );

            if (!response.ok) {

                let message = 'Test notification failed.';

                try {
                    const body = await response.json();
                    message = body.error || body.message || message;
                } catch { }

                throw new Error(message);
            }

            this.triggerToast(
                'Test notification sent successfully.',
                'success'
            );

        } catch (err: any) {

            this.triggerToast(
                err?.message || 'Unable to send test notification.',
                'danger'
            );

        } finally {

            this.testingNotification.set(false);
        }
    }

    validateMarketplaceSettings(): boolean {
        const weights = this.marketplaceConfig.smartMatching;
        const totalWeight = weights.ratingWeight + weights.completionWeight + weights.distanceWeight + weights.responseWeight;
        if (Math.abs(totalWeight - 1) > 0.01) {
            this.triggerToast('Smart matching weights must sum to 1.0.', 'warning');
            this.activeTab.set('marketplace');
            return false;
        }

        if (this.marketplaceConfig.commission.percent < 0 || this.marketplaceConfig.commission.percent > 100) {
            this.triggerToast('Commission percent must be between 0 and 100.', 'warning');
            this.activeTab.set('marketplace');
            return false;
        }

        return true;
    }

    private async saveMarketplaceConfig(): Promise<void> {
        const settings = this.deepCloneMarketplaceSettings(this.marketplaceConfig);
        await this.marketplaceService.saveSettings(settings);
        this.originalMarketplaceConfig = settings;
    }

    validateNotificationSettings(): boolean {
        if (!this.notificationConfig.appId.trim()) {
            this.triggerToast('OneSignal App ID is required.', 'warning');
            this.activeTab.set('notifications');
            return false;
        }

        if (!this.notificationConfig.configured && !this.notificationConfig.restApiKey.trim()) {
            this.triggerToast('No REST API key entered. If the server env is configured, Movabi will keep using it.', 'warning');
        }

        return true;
    }

    validateAppVersionSettings(): boolean {
        const fields = [
            this.appVersionConfig.currentWebVersion,
            this.appVersionConfig.minimumWebVersion,
            this.appVersionConfig.currentAndroidVersion,
            this.appVersionConfig.minimumAndroidVersion,
            this.appVersionConfig.currentIosVersion,
            this.appVersionConfig.minimumIosVersion
        ];

        if (fields.some(value => !String(value || '').trim())) {
            this.triggerToast('All current and minimum app versions are required.', 'warning');
            this.activeTab.set('appVersion');
            return false;
        }

        if (!this.appVersionConfig.updateTitle.trim() || !this.appVersionConfig.updateMessage.trim()) {
            this.triggerToast('Update title and message are required.', 'warning');
            this.activeTab.set('appVersion');
            return false;
        }

        return true;
    }

    private normaliseUpdateSeverity(value: unknown): 'optional' | 'recommended' | 'required' | 'critical' {
        const severity = String(value || '').toLowerCase();
        return ['optional', 'recommended', 'required', 'critical'].includes(severity)
            ? severity as 'optional' | 'recommended' | 'required' | 'critical'
            : 'optional';
    }

    private async loadMarketplaceConfig(): Promise<void> {
        try {
            const settings = await this.marketplaceService.loadSettings();
            this.marketplaceConfig = this.deepCloneMarketplaceSettings(settings);
            this.originalMarketplaceConfig = this.deepCloneMarketplaceSettings(settings);
        } catch (error) {
            console.error('Failed to load marketplace settings:', error);
            this.triggerToast('Marketplace settings loaded with defaults.', 'warning');
        }
    }

    updateNegotiationServices(value: string): void {
        this.marketplaceConfig.negotiation.minServices = value
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
    }

    updateBiddingServices(value: string): void {
        const services = value
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
        this.marketplaceConfig.bidding.enabledServices = services;
        this.marketplaceConfig.bidding.defaultServices = services;
    }

    updateHybridNegotiationEnabledServices(value: string): void {
        this.marketplaceConfig.hybridNegotiation.enabledServices = value
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
    }

    updateHybridNegotiationAllowlist(value: string): void {
        this.marketplaceConfig.hybridNegotiation.allowlist = value
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
    }

    private deepCloneMarketplaceSettings(settings: MarketplaceSettings): MarketplaceSettings {
        return JSON.parse(JSON.stringify(settings)) as MarketplaceSettings;
    }

    private async loadAppVersionConfig(): Promise<void> {
        try {
            const headers = await this.getAdminApiHeaders();
            const response = await fetch(`${this.apiUrl.getBaseUrl()}/api/admin/app-version`, {
                method: 'GET',
                headers
            });

            if (!response.ok) {
                throw new Error('Unable to load app version settings.');
            }

            const data = await response.json();
            const config = data.config || {};

            this.appVersionConfig = {
                ...this.appVersionConfig,
                currentWebVersion: config.current_web_version || this.appVersionConfig.currentWebVersion,
                minimumWebVersion: config.minimum_web_version || this.appVersionConfig.minimumWebVersion,
                currentAndroidVersion: config.current_android_version || this.appVersionConfig.currentAndroidVersion,
                minimumAndroidVersion: config.minimum_android_version || this.appVersionConfig.minimumAndroidVersion,
                currentIosVersion: config.current_ios_version || this.appVersionConfig.currentIosVersion,
                minimumIosVersion: config.minimum_ios_version || this.appVersionConfig.minimumIosVersion,
                updateRequired: !!config.update_required,
                updateSeverity: this.normaliseUpdateSeverity(config.update_severity),
                updateTitle: config.update_title || this.appVersionConfig.updateTitle,
                updateMessage: config.update_message || this.appVersionConfig.updateMessage,
                releaseNotes: config.release_notes || '',
                androidUpdateUrl: config.android_update_url || '',
                iosUpdateUrl: config.ios_update_url || '',
                webReloadRequired: !!config.web_reload_required,
                sendNotification: false
            };
        } catch (error) {
            console.error('Failed to load app version settings:', error);
            this.triggerToast('App version settings loaded with defaults.', 'warning');
        }
    }

    private async saveAppVersionConfig(): Promise<void> {
        const headers = await this.getAdminApiHeaders(true);
        const response = await fetch(`${this.apiUrl.getBaseUrl()}/api/admin/app-version`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                currentWebVersion: this.appVersionConfig.currentWebVersion.trim(),
                minimumWebVersion: this.appVersionConfig.minimumWebVersion.trim(),
                currentAndroidVersion: this.appVersionConfig.currentAndroidVersion.trim(),
                minimumAndroidVersion: this.appVersionConfig.minimumAndroidVersion.trim(),
                currentIosVersion: this.appVersionConfig.currentIosVersion.trim(),
                minimumIosVersion: this.appVersionConfig.minimumIosVersion.trim(),
                updateRequired: this.appVersionConfig.updateRequired,
                updateSeverity: this.appVersionConfig.updateSeverity,
                updateTitle: this.appVersionConfig.updateTitle.trim(),
                updateMessage: this.appVersionConfig.updateMessage.trim(),
                releaseNotes: this.appVersionConfig.releaseNotes.trim(),
                androidUpdateUrl: this.appVersionConfig.androidUpdateUrl.trim(),
                iosUpdateUrl: this.appVersionConfig.iosUpdateUrl.trim(),
                webReloadRequired: this.appVersionConfig.webReloadRequired,
                sendNotification: this.appVersionConfig.sendNotification
            })
        });

        if (!response.ok) {
            let message = 'Unable to save app version settings.';
            try {
                const body = await response.json();
                message = body.error || body.message || message;
            } catch { }
            throw new Error(message);
        }

        const data = await response.json();
        const config = data.config || {};
        this.appVersionConfig.sendNotification = false;
        this.appVersionConfig.updateRequired = !!config.update_required;
        this.appVersionConfig.updateSeverity = this.normaliseUpdateSeverity(config.update_severity);
    }

    private async getAdminApiHeaders(
        includeJson = false
    ): Promise<Record<string, string>> {

        const {
            data: { session }
        } = await this.supabase.auth.getSession();

        if (!session?.access_token) {
            throw new Error('Your administrator session has expired. Please sign in again.');
        }

        const headers: Record<string, string> = {
            Authorization: `Bearer ${session.access_token}`
        };

        if (includeJson) {
            headers['Content-Type'] = 'application/json';
        }

        return headers;
    }

    private mergeCountries(saved: CountryConfig[], defaults: CountryConfig[]): CountryConfig[] {
        const map = new Map<string, CountryConfig>();

        for (const country of defaults) map.set(country.code, country);

        for (const country of saved) {
            map.set(country.code, {
                ...map.get(country.code),
                ...country,
                defaultCenter: {
                    ...(map.get(country.code)?.defaultCenter || { lat: 0, lng: 0 }),
                    ...(country.defaultCenter || { lat: 0, lng: 0 })
                }
            });
        }

        return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    addCountry() {
        this.countries.push({
            code: 'GB',
            name: 'New Country',
            currency: 'GBP',
            currencySymbol: '£',
            locale: 'en-GB',
            phoneCode: '+44',
            defaultCenter: { lat: 51.5074, lng: -0.1278 }
        });

        this.activeTab.set('countries');
    }

    askRemoveCountry(index: number) {
        this.confirmRemoveIndex.set(index);
    }

    removeCountryNow() {
        const index = this.confirmRemoveIndex();

        if (index === null || index < 0 || index >= this.countries.length) {
            this.confirmRemoveIndex.set(null);
            return;
        }

        this.countries.splice(index, 1);

        if (!this.countries.find(c => c.code === this.generalConfig.defaultCountryCode)) {
            this.generalConfig.defaultCountryCode = this.countries[0]?.code || 'GB';
            this.onDefaultCountryChange();
        }

        this.confirmRemoveIndex.set(null);
        this.triggerToast('Country removed.', 'success');
    }

    resetChanges() {
        this.countries = this.cloneCountries(this.originalCountries);
        this.generalConfig.defaultCountryCode = this.countries[0]?.code || 'GB';
        this.onDefaultCountryChange();
        this.marketplaceConfig = this.deepCloneMarketplaceSettings(this.originalMarketplaceConfig);
        this.notificationConfig.restApiKey = '';
        this.triggerToast('Changes reset.', 'success');
    }

    onDefaultCountryChange() {
        const country = this.getDefaultCountry();

        if (country?.defaultCenter) {
            this.generalConfig.mapLat = Number(country.defaultCenter.lat || 0);
            this.generalConfig.mapLng = Number(country.defaultCenter.lng || 0);
        }
    }

    onCurrencyChange(country: CountryConfig) {
        country.currency = this.normaliseCode(country.currency);
        country.currencySymbol = this.symbolFromCode(country.currency);

        if (!country.locale) {
            country.locale = this.localeFromCountry(country.code);
        }
    }

    validateSettings(): boolean {
        if (!this.countries.length) {
            this.triggerToast('Add at least one country.', 'warning');
            return false;
        }

        const codes = new Set<string>();

        for (const country of this.countries) {
            const normalised = this.normaliseCountry(country);
            Object.assign(country, normalised);

            if (!country.code || !country.name || !country.currency || !country.currencySymbol) {
                this.triggerToast('Country name, code, currency and symbol are required.', 'warning');
                return false;
            }

            if (codes.has(country.code)) {
                this.triggerToast(`Duplicate country code: ${country.code}`, 'warning');
                return false;
            }

            codes.add(country.code);
        }

        this.generalConfig.defaultCountryCode = this.normaliseCode(this.generalConfig.defaultCountryCode);

        if (!codes.has(this.generalConfig.defaultCountryCode)) {
            this.triggerToast('Default country must exist in countries list.', 'warning');
            return false;
        }

        return true;
    }

    getDefaultCountry(): CountryConfig | undefined {
        return this.countries.find(c => c.code === this.generalConfig.defaultCountryCode) || this.countries[0];
    }

    trackCountry(country: CountryConfig, index: number): string {
        return `${country.code || 'new'}-${index}`;
    }

    normaliseCode(value?: string | null): string {
        return String(value || '').trim().toUpperCase();
    }

    symbolFromCode(code?: string | null): string {
        const map: Record<string, string> = {
            GBP: '£',
            USD: '$',
            EUR: '€',
            NGN: '₦',
            CAD: '$',
            AUD: '$',
            AED: 'د.إ'
        };

        return map[this.normaliseCode(code)] || '£';
    }

    localeFromCountry(code?: string | null): string {
        const map: Record<string, string> = {
            GB: 'en-GB',
            US: 'en-US',
            NG: 'en-NG',
            CA: 'en-CA',
            AU: 'en-AU',
            AE: 'ar-AE',
            EU: 'en-IE',
            IE: 'en-IE',
            FR: 'fr-FR',
            DE: 'de-DE',
            ES: 'es-ES',
            IT: 'it-IT',
            NL: 'nl-NL',
            BE: 'nl-BE',
            PT: 'pt-PT'
        };

        return map[this.normaliseCode(code)] || 'en-GB';
    }

    private normaliseCountry(country: CountryConfig): CountryConfig {
        const code = this.normaliseCode(country?.code || 'GB');
        const currency = this.normaliseCode(country?.currency || 'GBP');

        return {
            code,
            name: country?.name || code,
            currency,
            currencySymbol: country?.currencySymbol || this.symbolFromCode(currency),
            locale: country?.locale || this.localeFromCountry(code),
            phoneCode: country?.phoneCode || '',
            defaultCenter: {
                lat: Number(country?.defaultCenter?.lat || 0),
                lng: Number(country?.defaultCenter?.lng || 0)
            }
        };
    }

    private cloneCountries(countries: CountryConfig[]): CountryConfig[] {
        return JSON.parse(JSON.stringify(countries || []));
    }

    private getDefaultCountries(): CountryConfig[] {
        return [
            { code: 'GB', name: 'United Kingdom', currency: 'GBP', currencySymbol: '£', locale: 'en-GB', phoneCode: '+44', defaultCenter: { lat: 51.5074, lng: -0.1278 } },
            { code: 'US', name: 'United States', currency: 'USD', currencySymbol: '$', locale: 'en-US', phoneCode: '+1', defaultCenter: { lat: 38.9072, lng: -77.0369 } },
            { code: 'NG', name: 'Nigeria', currency: 'NGN', currencySymbol: '₦', locale: 'en-NG', phoneCode: '+234', defaultCenter: { lat: 6.5244, lng: 3.3792 } },
            { code: 'IE', name: 'Ireland', currency: 'EUR', currencySymbol: '€', locale: 'en-IE', phoneCode: '+353', defaultCenter: { lat: 53.3498, lng: -6.2603 } },
            { code: 'FR', name: 'France', currency: 'EUR', currencySymbol: '€', locale: 'fr-FR', phoneCode: '+33', defaultCenter: { lat: 48.8566, lng: 2.3522 } },
            { code: 'DE', name: 'Germany', currency: 'EUR', currencySymbol: '€', locale: 'de-DE', phoneCode: '+49', defaultCenter: { lat: 52.52, lng: 13.405 } },
            { code: 'ES', name: 'Spain', currency: 'EUR', currencySymbol: '€', locale: 'es-ES', phoneCode: '+34', defaultCenter: { lat: 40.4168, lng: -3.7038 } },
            { code: 'IT', name: 'Italy', currency: 'EUR', currencySymbol: '€', locale: 'it-IT', phoneCode: '+39', defaultCenter: { lat: 41.9028, lng: 12.4964 } },
            { code: 'NL', name: 'Netherlands', currency: 'EUR', currencySymbol: '€', locale: 'nl-NL', phoneCode: '+31', defaultCenter: { lat: 52.3676, lng: 4.9041 } },
            { code: 'BE', name: 'Belgium', currency: 'EUR', currencySymbol: '€', locale: 'nl-BE', phoneCode: '+32', defaultCenter: { lat: 50.8503, lng: 4.3517 } },
            { code: 'PT', name: 'Portugal', currency: 'EUR', currencySymbol: '€', locale: 'pt-PT', phoneCode: '+351', defaultCenter: { lat: 38.7223, lng: -9.1393 } },
            { code: 'CA', name: 'Canada', currency: 'CAD', currencySymbol: '$', locale: 'en-CA', phoneCode: '+1', defaultCenter: { lat: 45.4215, lng: -75.6972 } },
            { code: 'AU', name: 'Australia', currency: 'AUD', currencySymbol: '$', locale: 'en-AU', phoneCode: '+61', defaultCenter: { lat: -35.2809, lng: 149.13 } },
            { code: 'AE', name: 'United Arab Emirates', currency: 'AED', currencySymbol: 'د.إ', locale: 'ar-AE', phoneCode: '+971', defaultCenter: { lat: 25.2048, lng: 55.2708 } }
        ];
    }

    triggerToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
        this.toastMessage.set(message);
        this.toastColor.set(color);
        this.showToast.set(true);

        setTimeout(() => {
            this.showToast.set(false);
        }, 2500);
    }
}
