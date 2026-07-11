import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  analyticsOutline,
  calendarOutline,
  cashOutline,
  cloudUploadOutline,
  compassOutline,
  flashOutline,
  globeOutline,
  refreshOutline,
  saveOutline,
  shieldCheckmarkOutline,
  timeOutline,
  trendingUpOutline
} from 'ionicons/icons';
import {
  AdminGlobalAiPricingService,
  GlobalAiPricingTable,
  GlobalAiRow
} from '../../services/admin-global-ai-pricing.service';

type GlobalAiTab =
  | 'overview'
  | 'global'
  | 'markets'
  | 'zones'
  | 'services'
  | 'waiting'
  | 'events'
  | 'guardrails'
  | 'shadow'
  | 'audit';

@Component({
  selector: 'app-global-ai-pricing',
  standalone: true,
  imports: [CommonModule, IonicModule, FormsModule],
  templateUrl: './global-ai-pricing.component.html',
  styleUrls: ['./global-ai-pricing.component.css']
})
export class GlobalAiPricingComponent implements OnInit {
  private adminPricing = inject(AdminGlobalAiPricingService);

  activeTab = signal<GlobalAiTab>('overview');
  loading = signal(false);
  saving = signal(false);
  toastMessage = signal('');
  toastColor = signal<'success' | 'danger' | 'warning'>('success');
  selectedCountry = signal('');
  lastSavedAt = signal<string | null>(null);

  markets = signal<GlobalAiRow[]>([]);
  zones = signal<GlobalAiRow[]>([]);
  serviceRules = signal<GlobalAiRow[]>([]);
  waitingRules = signal<GlobalAiRow[]>([]);
  calendarEvents = signal<GlobalAiRow[]>([]);
  audits = signal<GlobalAiRow[]>([]);

  marketDraft: GlobalAiRow = this.defaultMarket();
  zoneDraft: GlobalAiRow = this.defaultZone();
  serviceRuleDraft: GlobalAiRow = this.defaultServiceRule();
  waitingRuleDraft: GlobalAiRow = this.defaultWaitingRule();
  eventDraft: GlobalAiRow = this.defaultEvent();

  globalDraft = {
    ai_pricing_enabled: false,
    shadow_mode_enabled: true,
    experimentation_enabled: false,
    emergency_pricing_disabled: false,
    traffic_percentage: 0,
    confidence_threshold: 0.75,
    request_timeout_ms: 2500,
    fallback_strategy: 'rules',
    global_maximum_increase_percent: 0,
    global_maximum_multiplier: 1,
    model_version: 'global-pricing-v1',
    configuration_version: 1
  };

  tabs: Array<{ id: GlobalAiTab; label: string; icon: string }> = [
    { id: 'overview', label: 'Overview', icon: 'analytics-outline' },
    { id: 'global', label: 'Global Settings', icon: 'flash-outline' },
    { id: 'markets', label: 'Markets', icon: 'globe-outline' },
    { id: 'zones', label: 'Zones', icon: 'compass-outline' },
    { id: 'services', label: 'Service Rules', icon: 'cash-outline' },
    { id: 'waiting', label: 'Waiting Charges', icon: 'time-outline' },
    { id: 'events', label: 'Calendar & Events', icon: 'calendar-outline' },
    { id: 'guardrails', label: 'AI Guardrails', icon: 'shield-checkmark-outline' },
    { id: 'shadow', label: 'Shadow Mode', icon: 'trending-up-outline' },
    { id: 'audit', label: 'Audit & Monitoring', icon: 'cloud-upload-outline' }
  ];

  overview = computed(() => {
    const audits = this.audits();
    const latest = audits[0] || null;
    const fallbackCount = audits.filter((row) => row['fallback_used'] === true).length;
    const cappedCount = audits.filter((row) => row['guardrails']?.wasCapped === true || row['guardrails']?.was_capped === true).length;
    const firstMarket = this.markets()[0] || {};
    return {
      aiEnabled: this.markets().some((row) => row['ai_pricing_enabled'] === true),
      shadowEnabled: this.markets().some((row) => row['shadow_mode_enabled'] !== false),
      liveTraffic: Number(firstMarket['metadata']?.traffic_percentage ?? this.globalDraft.traffic_percentage ?? 0),
      activeMarkets: this.markets().filter((row) => row['market_enabled'] === true).length,
      activeZones: this.zones().filter((row) => row['is_active'] !== false).length,
      activeServices: this.serviceRules().filter((row) => row['is_active'] !== false).length,
      currentModel: String(firstMarket['model_version'] || this.globalDraft.model_version),
      confidenceThreshold: Number(firstMarket['confidence_threshold'] ?? this.globalDraft.confidence_threshold),
      emergencyDisabled: this.markets().some((row) => row['emergency_pricing_disabled'] === true),
      lastUpdated: this.latestDate([...this.markets(), ...this.zones(), ...this.serviceRules(), ...this.waitingRules(), ...this.calendarEvents()]),
      lastAiQuote: latest,
      fallbackRate: audits.length ? Math.round((fallbackCount / audits.length) * 100) : 0,
      errorRate: audits.length ? Math.round((cappedCount / audits.length) * 100) : 0
    };
  });

  constructor() {
    addIcons({
      alertCircleOutline,
      analyticsOutline,
      calendarOutline,
      cashOutline,
      cloudUploadOutline,
      compassOutline,
      flashOutline,
      globeOutline,
      refreshOutline,
      saveOutline,
      shieldCheckmarkOutline,
      timeOutline,
      trendingUpOutline
    });
  }

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const countryCode = this.selectedCountry().trim();
      const [markets, zones, serviceRules, waitingRules, calendarEvents, audits] = await Promise.all([
        this.adminPricing.getRows('markets', { countryCode: countryCode || undefined }),
        this.adminPricing.getRows('zones', { countryCode: countryCode || undefined }),
        this.adminPricing.getRows('serviceRules', { countryCode: countryCode || undefined }),
        this.adminPricing.getRows('waitingRules', { countryCode: countryCode || undefined }),
        this.adminPricing.getRows('calendarEvents', { countryCode: countryCode || undefined }),
        this.adminPricing.getRows('audits', { limit: 100 })
      ]);

      this.markets.set(markets);
      this.zones.set(zones);
      this.serviceRules.set(serviceRules);
      this.waitingRules.set(waitingRules);
      this.calendarEvents.set(calendarEvents);
      this.audits.set(audits);
      this.syncGlobalDraft(markets[0]);
      this.showToast('Global AI pricing controls reloaded.', 'success');
    } catch (error: any) {
      console.error('[Global AI Pricing] reload failed:', error);
      this.showToast(error?.error?.error || error?.message || 'Unable to load AI pricing controls.', 'danger');
    } finally {
      this.loading.set(false);
    }
  }

  resetDrafts(): void {
    this.marketDraft = this.defaultMarket();
    this.zoneDraft = this.defaultZone();
    this.serviceRuleDraft = this.defaultServiceRule();
    this.waitingRuleDraft = this.defaultWaitingRule();
    this.eventDraft = this.defaultEvent();
    this.showToast('Unsaved draft fields reset.', 'success');
  }

  async saveMarket(row: GlobalAiRow): Promise<void> {
    if (!this.validateMarket(row)) return;
    await this.saveRow('markets', this.prepareMarket(row));
  }

  async saveZone(row: GlobalAiRow): Promise<void> {
    if (!this.validateCountry(row['country_code']) || !String(row['zone_id'] || '').trim()) {
      this.showToast('Zone needs a valid country code and zone ID.', 'danger');
      return;
    }
    await this.saveRow('zones', { ...row, enabled_services: this.asStringArray(row['enabled_services']) });
  }

  async saveServiceRule(row: GlobalAiRow): Promise<void> {
    if (!this.validateCountry(row['country_code']) || !String(row['service_slug'] || '').trim()) {
      this.showToast('Service rule needs a valid country code and service.', 'danger');
      return;
    }
    if (this.hasMinMaxError(row['minimum_fare_minor'], row['maximum_fare_minor'])) return;
    await this.saveRow('serviceRules', row);
  }

  async saveWaitingRule(row: GlobalAiRow): Promise<void> {
    if (!this.validateCountry(row['country_code']) || !String(row['service_slug'] || '').trim()) {
      this.showToast('Waiting rule needs a valid country code and service.', 'danger');
      return;
    }
    await this.saveRow('waitingRules', row);
  }

  async saveEvent(row: GlobalAiRow): Promise<void> {
    if (!this.validateCountry(row['country_code']) || !String(row['title'] || '').trim()) {
      this.showToast('Event needs a valid country code and name.', 'danger');
      return;
    }
    if (new Date(row['starts_at']).getTime() > new Date(row['ends_at']).getTime()) {
      this.showToast('Event start must be before event end.', 'danger');
      return;
    }
    await this.saveRow('calendarEvents', row);
  }

  async applyGlobalSettings(): Promise<void> {
    const traffic = Number(this.globalDraft.traffic_percentage);
    const confidence = Number(this.globalDraft.confidence_threshold);
    const multiplier = Number(this.globalDraft.global_maximum_multiplier);

    if (traffic < 0 || traffic > 100) {
      this.showToast('Traffic percentage must be between 0 and 100.', 'danger');
      return;
    }
    if (confidence < 0 || confidence > 1) {
      this.showToast('Confidence threshold must be between 0 and 1.', 'danger');
      return;
    }
    if (multiplier < 1) {
      this.showToast('Global maximum multiplier must be at least 1.', 'danger');
      return;
    }

    const rows = this.markets();
    if (!rows.length) {
      this.showToast('Create at least one market before applying global settings.', 'warning');
      return;
    }

    this.saving.set(true);
    try {
      for (const market of rows) {
        await this.adminPricing.saveRow('markets', this.prepareMarket({
          ...market,
          ai_pricing_enabled: this.globalDraft.ai_pricing_enabled,
          shadow_mode_enabled: this.globalDraft.shadow_mode_enabled,
          experimentation_enabled: this.globalDraft.experimentation_enabled,
          emergency_pricing_disabled: this.globalDraft.emergency_pricing_disabled,
          confidence_threshold: confidence,
          model_version: this.globalDraft.model_version,
          configuration_version: Number(this.globalDraft.configuration_version || 1),
          metadata: {
            ...(market['metadata'] || {}),
            traffic_percentage: traffic,
            request_timeout_ms: Number(this.globalDraft.request_timeout_ms || 2500),
            fallback_strategy: this.globalDraft.fallback_strategy,
            global_maximum_increase_percent: Number(this.globalDraft.global_maximum_increase_percent || 0),
            global_maximum_multiplier: multiplier
          }
        }));
      }
      this.lastSavedAt.set(new Date().toISOString());
      await this.reload();
      this.showToast('Global AI pricing settings applied to loaded markets.', 'success');
    } catch (error: any) {
      console.error('[Global AI Pricing] global save failed:', error);
      this.showToast(error?.error?.error || error?.message || 'Unable to save global settings.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  async emergencyDisable(): Promise<void> {
    if (!confirm('Disable AI pricing globally, force shadow mode, and set traffic to 0 for all loaded markets?')) return;
    this.globalDraft.ai_pricing_enabled = false;
    this.globalDraft.shadow_mode_enabled = true;
    this.globalDraft.experimentation_enabled = false;
    this.globalDraft.emergency_pricing_disabled = true;
    this.globalDraft.traffic_percentage = 0;
    await this.applyGlobalSettings();
  }

  async forceShadowMode(): Promise<void> {
    if (!confirm('Force shadow mode and set live traffic to 0 for all loaded markets?')) return;
    this.globalDraft.shadow_mode_enabled = true;
    this.globalDraft.traffic_percentage = 0;
    await this.applyGlobalSettings();
  }

  async saveRow(table: Exclude<GlobalAiPricingTable, 'audits'>, row: GlobalAiRow): Promise<void> {
    this.saving.set(true);
    try {
      await this.adminPricing.saveRow(table, row);
      this.lastSavedAt.set(new Date().toISOString());
      await this.reload();
      this.showToast('Saved. Changes are available without redeploy.', 'success');
    } catch (error: any) {
      console.error('[Global AI Pricing] save failed:', error);
      this.showToast(error?.error?.error || error?.message || 'Unable to save row.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRow(table: Exclude<GlobalAiPricingTable, 'audits'>, row: GlobalAiRow): Promise<void> {
    const id = table === 'markets' ? String(row['country_code'] || '') : String(row['id'] || '');
    if (!id) {
      this.showToast('This row cannot be deleted until it has been saved.', 'warning');
      return;
    }
    if (!confirm(`Delete this ${table} row? This cannot be undone from the admin UI.`)) return;

    this.saving.set(true);
    try {
      await this.adminPricing.deleteRow(table, id);
      this.lastSavedAt.set(new Date().toISOString());
      await this.reload();
      this.showToast('Deleted.', 'success');
    } catch (error: any) {
      console.error('[Global AI Pricing] delete failed:', error);
      this.showToast(error?.error?.error || error?.message || 'Unable to delete row.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  formatMoneyMinor(value: unknown, currency = 'GBP'): string {
    const amount = Number(value || 0) / 100;
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
    } catch {
      return `${currency} ${amount.toFixed(2)}`;
    }
  }

  serviceSummary(row: GlobalAiRow): string {
    const currency = this.currencyFor(row['country_code']);
    return [
      `Base ${this.formatMoneyMinor(row['base_fare_minor'], currency)}`,
      `Min ${this.formatMoneyMinor(row['minimum_fare_minor'], currency)}`,
      row['maximum_fare_minor'] ? `Max ${this.formatMoneyMinor(row['maximum_fare_minor'], currency)}` : 'No max set'
    ].join(' · ');
  }

  currencyFor(countryCode: unknown): string {
    const market = this.markets().find((row) => row['country_code'] === countryCode);
    return String(market?.['currency_code'] || 'GBP').toUpperCase();
  }

  asCsv(value: unknown): string {
    return Array.isArray(value) ? value.join(', ') : String(value || '');
  }

  setCsv(row: GlobalAiRow, key: string, value: string): void {
    row[key] = this.asStringArray(value);
  }

  jsonPreview(value: unknown): string {
    try {
      return JSON.stringify(value || {}, null, 2);
    } catch {
      return '{}';
    }
  }

  setJson(row: GlobalAiRow, key: string, value: string): void {
    try {
      row[key] = value.trim() ? JSON.parse(value) : {};
    } catch {
      this.showToast(`${key} must be valid JSON.`, 'danger');
    }
  }

  private syncGlobalDraft(market?: GlobalAiRow): void {
    if (!market) return;
    this.globalDraft = {
      ai_pricing_enabled: market['ai_pricing_enabled'] === true,
      shadow_mode_enabled: market['shadow_mode_enabled'] !== false,
      experimentation_enabled: market['experimentation_enabled'] === true,
      emergency_pricing_disabled: market['emergency_pricing_disabled'] === true,
      traffic_percentage: Number(market['metadata']?.traffic_percentage || 0),
      confidence_threshold: Number(market['confidence_threshold'] ?? 0.75),
      request_timeout_ms: Number(market['metadata']?.request_timeout_ms || 2500),
      fallback_strategy: String(market['metadata']?.fallback_strategy || 'rules'),
      global_maximum_increase_percent: Number(market['metadata']?.global_maximum_increase_percent || 0),
      global_maximum_multiplier: Number(market['metadata']?.global_maximum_multiplier || 1),
      model_version: String(market['model_version'] || 'global-pricing-v1'),
      configuration_version: Number(market['configuration_version'] || 1)
    };
  }

  private prepareMarket(row: GlobalAiRow): GlobalAiRow {
    return {
      ...row,
      country_code: String(row['country_code'] || '').trim().toUpperCase(),
      currency_code: String(row['currency_code'] || '').trim().toUpperCase(),
      minimum_charge_unit_minor: Number(row['minimum_charge_unit_minor'] || 1),
      confidence_threshold: Number(row['confidence_threshold'] ?? 0.75),
      configuration_version: Number(row['configuration_version'] || 1)
    };
  }

  private validateMarket(row: GlobalAiRow): boolean {
    if (!this.validateCountry(row['country_code'])) return false;
    if (!/^[A-Z]{3}$/.test(String(row['currency_code'] || '').trim().toUpperCase())) {
      this.showToast('Currency must be a valid 3-letter ISO code.', 'danger');
      return false;
    }
    const confidence = Number(row['confidence_threshold'] ?? 0.75);
    if (confidence < 0 || confidence > 1) {
      this.showToast('Confidence threshold must be between 0 and 1.', 'danger');
      return false;
    }
    return true;
  }

  private validateCountry(value: unknown): boolean {
    if (!/^[A-Z]{2}$/.test(String(value || '').trim().toUpperCase())) {
      this.showToast('Country must be a valid 2-letter ISO code.', 'danger');
      return false;
    }
    return true;
  }

  private hasMinMaxError(min: unknown, max: unknown): boolean {
    if (max === null || max === undefined || max === '') return false;
    if (Number(min || 0) > Number(max)) {
      this.showToast('Minimum fare must be less than or equal to maximum fare.', 'danger');
      return true;
    }
    return false;
  }

  private asStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  }

  private latestDate(rows: GlobalAiRow[]): string | null {
    const dates = rows
      .map((row) => String(row['updated_at'] || row['created_at'] || ''))
      .filter(Boolean)
      .sort()
      .reverse();
    return dates[0] || null;
  }

  private showToast(message: string, color: 'success' | 'danger' | 'warning'): void {
    this.toastMessage.set(message);
    this.toastColor.set(color);
    setTimeout(() => this.toastMessage.set(''), 3500);
  }

  private defaultMarket(): GlobalAiRow {
    return {
      country_code: 'GB',
      currency_code: 'GBP',
      timezone: 'Europe/London',
      distance_unit: 'km',
      tax_inclusive_display: true,
      tax_rate: 0,
      default_language: 'en',
      rounding_rule: {},
      minimum_charge_unit_minor: 1,
      pricing_model: 'rules_shadow',
      market_enabled: false,
      ai_pricing_enabled: false,
      shadow_mode_enabled: true,
      experimentation_enabled: false,
      emergency_pricing_disabled: false,
      confidence_threshold: 0.75,
      model_version: 'global-pricing-v1',
      configuration_version: 1,
      metadata: {}
    };
  }

  private defaultZone(): GlobalAiRow {
    return {
      country_code: 'GB',
      city_name: '',
      zone_id: '',
      polygon: null,
      base_cost_index: 1,
      congestion_index: 1,
      purchasing_power_index: 1,
      driver_cost_index: 1,
      fuel_cost_index: 1,
      insurance_cost_index: 1,
      regulatory_fee_minor: 0,
      airport_fee_minor: 0,
      max_surge_multiplier: 1,
      minimum_driver_earnings_minor: 0,
      enabled_services: ['ride', 'errand', 'delivery', 'van'],
      priority: 100,
      is_active: true,
      metadata: {}
    };
  }

  private defaultServiceRule(): GlobalAiRow {
    return {
      country_code: 'GB',
      zone_id: null,
      service_slug: 'ride',
      vehicle_class: null,
      base_fare_minor: 0,
      per_distance_unit_minor: 0,
      per_minute_minor: 0,
      minimum_fare_minor: 0,
      booking_fee_minor: 0,
      cancellation_fee_minor: 0,
      waiting_fee_per_minute_minor: 0,
      maximum_fare_minor: null,
      maximum_surge_multiplier: 1,
      commission_percent: 0,
      tax_treatment: 'market',
      toll_treatment: 'actual',
      payment_rules: {},
      ai_pricing_enabled: false,
      surge_enabled: false,
      is_active: true,
      metadata: {}
    };
  }

  private defaultWaitingRule(): GlobalAiRow {
    return {
      country_code: 'GB',
      zone_id: null,
      service_slug: 'ride',
      free_waiting_minutes: 0,
      airport_free_waiting_minutes: 0,
      accessibility_free_waiting_minutes: 0,
      per_minute_charge_minor: 0,
      maximum_charge_minor: 0,
      cancellation_threshold_minutes: null,
      partial_minute_rounding: 'ceil',
      is_active: true,
      metadata: {}
    };
  }

  private defaultEvent(): GlobalAiRow {
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    return {
      country_code: 'GB',
      region_code: '',
      zone_id: '',
      event_type: 'public_holiday',
      title: '',
      starts_at: now.toISOString(),
      ends_at: later.toISOString(),
      expected_demand_impact: 0,
      expected_supply_impact: 0,
      source: 'admin',
      is_active: true,
      metadata: {}
    };
  }
}
