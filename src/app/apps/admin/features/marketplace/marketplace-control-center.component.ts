import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { FormsModule } from '@angular/forms';
import { addIcons } from 'ionicons';
import {
  settingsOutline,
  cashOutline,
  cloudyNightOutline,
  carOutline,
  listOutline,
  chatbubblesOutline,
  peopleOutline,
  hammerOutline,
  shieldCheckmarkOutline,
  saveOutline,
  refreshOutline,
  timeOutline,
  checkmarkCircleOutline,
  notificationsOutline,
  walletOutline,
  cardOutline,
  globeOutline,
  briefcaseOutline,
  alertCircleOutline,
  documentTextOutline,
  shieldOutline,
  trendingUpOutline,
  optionsOutline,
  speedometerOutline,
  cloudUploadOutline
} from 'ionicons/icons';
import { AdminMarketplaceService, MarketplaceAuditLog } from '../../services/admin-marketplace.service';
import {
  MarketplaceConfigService,
  MarketplaceSettings,
  MarketplaceServiceRule,
  MarketplaceNotificationRule
} from '../../../../core/services/marketplace/marketplace-config.service';
import {
  buildFieldGroups,
  MarketplaceFieldGroup,
  SERVICES,
  NOTIFICATION_CUSTOMER_KEYS,
  NOTIFICATION_DRIVER_KEYS
} from './marketplace-control-center.fields';

type MarketplaceTab =
  | 'commission'
  | 'dynamicPricing'
  | 'serviceRules'
  | 'negotiation'
  | 'hybrid'
  | 'bidding'
  | 'smartMatching'
  | 'payment'
  | 'notifications'
  | 'driver'
  | 'emergency'
  | 'marketplace'
  | 'audit';

@Component({
  selector: 'app-marketplace-control-center',
  standalone: true,
  imports: [CommonModule, IonicModule, FormsModule],
  templateUrl: './marketplace-control-center.component.html',
  styleUrls: ['./marketplace-control-center.component.css']
})
export class MarketplaceControlCenterComponent implements OnInit {
  private adminService = inject(AdminMarketplaceService);
  private marketplaceConfig = inject(MarketplaceConfigService);

  activeTab = signal<MarketplaceTab>('commission');
  loading = signal(false);
  saving = signal(false);
  showToast = signal(false);
  toastMessage = signal('');
  toastColor = signal<'success' | 'danger' | 'warning'>('success');

  settings = this.marketplaceConfig.defaultSettings();
  originalSettings = this.deepClone(this.settings);

  auditLogs: MarketplaceAuditLog[] = [];
  auditLoading = signal(false);
  auditOffset = 0;
  auditLimit = 25;

  fieldGroups: MarketplaceFieldGroup[] = buildFieldGroups();

  constructor() {
    addIcons({
      settingsOutline,
      cashOutline,
      cloudyNightOutline,
      carOutline,
      listOutline,
      chatbubblesOutline,
      peopleOutline,
      hammerOutline,
      shieldCheckmarkOutline,
      saveOutline,
      refreshOutline,
      timeOutline,
      checkmarkCircleOutline,
      notificationsOutline,
      walletOutline,
      cardOutline,
      globeOutline,
      briefcaseOutline,
      alertCircleOutline,
      documentTextOutline,
      shieldOutline,
      trendingUpOutline,
      optionsOutline,
      speedometerOutline,
      cloudUploadOutline
    });
  }

  ngOnInit() {
    this.fieldGroups = buildFieldGroups();
    this.loadSettings();
  }

  async loadSettings() {
    this.loading.set(true);
    try {
      const apiSettings = await this.adminService.getSettings();
      const defaults = this.marketplaceConfig.defaultSettings();
      const merged = this.deepMerge(defaults, apiSettings) as MarketplaceSettings;
      this.ensureServiceRules(merged);
      this.ensureNotificationRules(merged);
      this.settings = merged;
      this.originalSettings = this.deepClone(this.settings);
      await this.loadAuditLogs();
    } catch (error) {
      console.error('Failed to load marketplace settings:', error);
      this.triggerToast('Failed to load marketplace settings.', 'danger');
    } finally {
      this.loading.set(false);
    }
  }

  async save() {
    if (!this.validate()) return;

    this.saving.set(true);
    try {
      const saved = await this.adminService.saveSettings(this.settings);
      this.settings = this.deepMerge(this.marketplaceConfig.defaultSettings(), saved) as MarketplaceSettings;
      this.ensureServiceRules(this.settings);
      this.ensureNotificationRules(this.settings);
      this.originalSettings = this.deepClone(this.settings);
      await this.marketplaceConfig.reload();
      await this.adminService.reload();
      await this.loadAuditLogs();
      this.triggerToast('Marketplace settings saved successfully.', 'success');
    } catch (error) {
      console.error('Failed to save marketplace settings:', error);
      this.triggerToast(error instanceof Error ? error.message : 'Failed to save settings.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  reset() {
    this.settings = this.deepClone(this.originalSettings);
    this.triggerToast('Changes reset.', 'success');
  }

  async reloadCache() {
    try {
      await this.adminService.reload();
      await this.marketplaceConfig.reload();
      this.triggerToast('Marketplace cache reloaded.', 'success');
    } catch (error) {
      console.error('Failed to reload cache:', error);
      this.triggerToast('Failed to reload cache.', 'danger');
    }
  }

  validate(): boolean {
    const weights = this.settings.smartMatching;
    const total =
      (weights.ratingWeight || 0) +
      (weights.completionWeight || 0) +
      (weights.distanceWeight || 0) +
      (weights.responseWeight || 0) +
      (weights.etaWeight || 0) +
      (weights.acceptanceRateWeight || 0) +
      (weights.cancellationRateWeight || 0) +
      (weights.responseTimeWeight || 0) +
      (weights.vehicleCompatibilityWeight || 0) +
      (weights.idleTimeWeight || 0);

    if (weights.enabled && Math.abs(total - 1) > 0.01) {
      this.triggerToast(`Smart matching weights must sum to 1.00 (current ${total.toFixed(2)}).`, 'danger');
      return false;
    }

    return true;
  }

  async loadAuditLogs() {
    this.auditLoading.set(true);
    try {
      this.auditLogs = await this.adminService.getAuditLogs(this.auditLimit, this.auditOffset);
    } catch (error) {
      console.error('Failed to load audit logs:', error);
    } finally {
      this.auditLoading.set(false);
    }
  }

  async loadMoreAuditLogs() {
    this.auditOffset += this.auditLimit;
    await this.loadAuditLogs();
  }

  formatStringList(value?: string[] | null): string {
    return (value || []).join(', ');
  }

  parseStringList(value: string): string[] {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }

  getValue(path: string, type?: string): any {
    const parts = path.split('.');
    let current: any = this.settings;
    for (const part of parts) {
      if (current === null || current === undefined) {
        break;
      }
      current = current[part];
    }
    if (current !== undefined && current !== null) return current;
    if (type === 'boolean') return false;
    if (type === 'number') return null;
    return '';
  }

  setValue(path: string, value: any) {
    const parts = path.split('.');
    const last = parts.pop()!;
    let current: any = this.settings;
    for (const part of parts) {
      if (current[part] === undefined || current[part] === null) {
        current[part] = {};
      }
      current = current[part];
    }
    current[last] = value;
  }

  setValueJson(path: string, value: string) {
    try {
      const parsed = value.trim() ? JSON.parse(value) : null;
      this.setValue(path, parsed);
    } catch (error) {
      console.error('Invalid JSON at', path, error);
      this.triggerToast('Invalid JSON for ' + path, 'danger');
    }
  }

  private ensureServiceRules(settings: MarketplaceSettings) {
    if (!settings.serviceRules) {
      settings.serviceRules = {};
    }
    for (const service of SERVICES) {
      if (!settings.serviceRules[service]) {
        settings.serviceRules[service] = this.defaultServiceRule();
      }
    }
  }

  private ensureNotificationRules(settings: MarketplaceSettings) {
    if (!settings.notificationRules) {
      settings.notificationRules = { customer: {}, driver: {} };
    }
    if (!settings.notificationRules.customer) {
      settings.notificationRules.customer = {};
    }
    if (!settings.notificationRules.driver) {
      settings.notificationRules.driver = {};
    }
    for (const key of NOTIFICATION_CUSTOMER_KEYS) {
      if (!settings.notificationRules.customer[key]) {
        settings.notificationRules.customer[key] = this.defaultNotificationRule();
      }
    }
    for (const key of NOTIFICATION_DRIVER_KEYS) {
      if (!settings.notificationRules.driver[key]) {
        settings.notificationRules.driver[key] = this.defaultNotificationRule();
      }
    }
  }

  private defaultServiceRule(): Partial<MarketplaceServiceRule> {
    return {
      enabled: true,
      marketplaceEnabled: true,
      negotiationEnabled: false,
      biddingEnabled: false,
      dynamicPricingEnabled: true,
      smartMatchingEnabled: true,
      minimumDistanceKm: 0,
      maximumDistanceKm: 100,
      minimumFare: 0,
      maximumFare: 0,
      paymentBeforeDispatch: false,
      allowScheduledJobs: false,
      allowMultiStop: false,
      allowHourlyBooking: false
    };
  }

  private defaultNotificationRule(): MarketplaceNotificationRule {
    return {
      pushEnabled: true,
      inAppEnabled: true,
      soundEnabled: true,
      vibrationEnabled: false,
      repeatInterval: 0,
      quietHoursStart: null,
      quietHoursEnd: null
    };
  }

  private deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private deepMerge(target: any, source: any): any {
    if (source === null || source === undefined) return target;
    if (Array.isArray(source)) return source;
    if (typeof source !== 'object') return source;
    if (target === null || target === undefined || typeof target !== 'object' || Array.isArray(target)) {
      target = {};
    }
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] === undefined) continue;
      result[key] = this.deepMerge(result[key], source[key]);
    }
    return result;
  }

  triggerToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
    this.toastMessage.set(message);
    this.toastColor.set(color);
    this.showToast.set(true);
    setTimeout(() => this.showToast.set(false), 2500);
  }
}
