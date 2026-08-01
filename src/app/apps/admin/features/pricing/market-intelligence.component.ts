import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  addCircleOutline,
  analyticsOutline,
  bulbOutline,
  cashOutline,
  createOutline,
  documentTextOutline,
  flaskOutline,
  peopleOutline,
  refreshOutline,
  shieldCheckmarkOutline,
  trashOutline,
  warningOutline
} from 'ionicons/icons';
import {
  AdminMarketPricingService,
  MarketPricingRow,
  MarketPricingSettingsDto,
  MarketPricingSimulationResult
} from '../../services/admin-market-pricing.service';

type MarketPricingTab = 'strategies' | 'competitors' | 'benchmarks' | 'simulator' | 'settings' | 'audit';

@Component({
  selector: 'app-market-intelligence',
  standalone: true,
  imports: [CommonModule, IonicModule, FormsModule],
  templateUrl: './market-intelligence.component.html',
  styleUrls: ['./market-intelligence.component.css']
})
export class MarketIntelligenceComponent implements OnInit {
  private service = inject(AdminMarketPricingService);

  activeTab = signal<MarketPricingTab>('strategies');
  loading = signal(false);
  saving = signal(false);
  toastMessage = signal('');
  toastColor = signal<'success' | 'danger' | 'warning'>('success');

  strategies = signal<MarketPricingRow[]>([]);
  competitors = signal<MarketPricingRow[]>([]);
  benchmarks = signal<MarketPricingRow[]>([]);
  auditRows = signal<MarketPricingRow[]>([]);
  auditTotal = signal(0);
  settings = signal<MarketPricingSettingsDto | null>(null);
  settingsDraft: MarketPricingSettingsDto | null = null;

  strategyDraft: MarketPricingRow = this.defaultStrategy();
  competitorDraft: MarketPricingRow = this.defaultCompetitor();
  benchmarkDraft: MarketPricingRow = this.defaultBenchmark();

  simulationInput: MarketPricingRow = this.defaultSimulationInput();
  simulationResult = signal<MarketPricingSimulationResult | null>(null);
  simulating = signal(false);

  tabs: Array<{ id: MarketPricingTab; label: string; icon: string }> = [
    { id: 'strategies', label: 'Market Intelligence', icon: 'analytics-outline' },
    { id: 'competitors', label: 'Competitors', icon: 'people-outline' },
    { id: 'benchmarks', label: 'Benchmarks', icon: 'cash-outline' },
    { id: 'simulator', label: 'Simulator', icon: 'flask-outline' },
    { id: 'settings', label: 'Safety Controls', icon: 'shield-checkmark-outline' },
    { id: 'audit', label: 'Audit', icon: 'document-text-outline' }
  ];

  constructor() {
    addIcons({
      addCircleOutline,
      analyticsOutline,
      bulbOutline,
      cashOutline,
      createOutline,
      documentTextOutline,
      flaskOutline,
      peopleOutline,
      refreshOutline,
      shieldCheckmarkOutline,
      trashOutline,
      warningOutline
    });
  }

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const [strategies, competitors, benchmarks, settings, audit] = await Promise.all([
        this.service.getStrategies(),
        this.service.getCompetitors(),
        this.service.getBenchmarks(),
        this.service.getSettings(),
        this.service.getAudit(50, 0)
      ]);

      this.strategies.set(strategies);
      this.competitors.set(competitors);
      this.benchmarks.set(benchmarks);
      this.settings.set(settings);
      this.settingsDraft = { ...settings };
      this.auditRows.set(audit.rows);
      this.auditTotal.set(audit.total);
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to load market pricing data.', 'danger');
    } finally {
      this.loading.set(false);
    }
  }

  // --- Strategies ---

  editingStrategyId: string | null = null;

  async saveStrategy(): Promise<void> {
    this.saving.set(true);
    try {
      if (this.editingStrategyId) {
        await this.service.updateStrategy(this.editingStrategyId, this.strategyDraft);
        this.showToast('Strategy updated. Enabled state is unchanged.', 'success');
      } else {
        await this.service.createStrategy(this.strategyDraft);
        this.showToast('Strategy created (disabled by default). Enable it explicitly when ready.', 'success');
      }
      this.cancelEditStrategy();
      await this.reload();
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to save strategy.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  editStrategy(row: MarketPricingRow): void {
    this.editingStrategyId = row['id'];
    this.strategyDraft = {
      countryCode: row['country_code'],
      marketCity: row['market_city'] ?? null,
      zoneId: row['zone_id'] ?? null,
      serviceType: row['service_type'],
      vehicleClass: row['vehicle_class'] ?? null,
      strategy: row['strategy'],
      targetDifferencePercent: row['target_difference_percent'],
      minimumLaunchTargetFare: row['minimum_launch_target_fare'],
      minimumDriverHourlyRate: row['minimum_driver_hourly_rate'],
      minimumDriverPerKm: row['minimum_driver_per_km'],
      minimumDriverPayout: row['minimum_driver_payout'],
      minimumPlatformMarginPercent: row['minimum_platform_margin_percent'],
      minimumPlatformRevenue: row['minimum_platform_revenue'],
      commissionPercent: row['commission_percent'],
      normalDemandMultiplier: row['normal_demand_multiplier'],
      busyMultiplier: row['busy_multiplier'],
      maximumSurgeMultiplier: row['maximum_surge_multiplier'],
      maximumCustomerDiscountPercent: row['maximum_customer_discount_percent'],
      maximumMarketAdjustmentPercent: row['maximum_market_adjustment_percent'],
      currency: row['currency'],
      validFrom: row['valid_from'] ?? null,
      validUntil: row['valid_until'] ?? null
    };
  }

  cancelEditStrategy(): void {
    this.editingStrategyId = null;
    this.strategyDraft = this.defaultStrategy();
  }

  async toggleStrategy(row: MarketPricingRow): Promise<void> {
    const nextEnabled = !row['enabled'];
    if (nextEnabled && !confirm(
      'You are enabling market-adjusted customer pricing for this strategy. Existing booking, payment and ' +
      'driver payout amounts may be affected for newly generated quotes. Continue?'
    )) {
      return;
    }

    this.saving.set(true);
    try {
      await this.service.setStrategyStatus(row['id'], nextEnabled);
      await this.reload();
      this.showToast(nextEnabled ? 'Strategy enabled.' : 'Strategy disabled.', 'success');
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to update strategy status.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  async deleteStrategy(row: MarketPricingRow): Promise<void> {
    if (!confirm('Delete this strategy? This cannot be undone.')) return;
    this.saving.set(true);
    try {
      await this.service.deleteStrategy(row['id']);
      if (this.editingStrategyId === row['id']) this.cancelEditStrategy();
      await this.reload();
      this.showToast('Strategy deleted.', 'success');
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to delete strategy.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  // --- Competitors ---

  async saveCompetitor(): Promise<void> {
    this.saving.set(true);
    try {
      await this.service.createCompetitor(this.competitorDraft);
      this.competitorDraft = this.defaultCompetitor();
      await this.reload();
      this.showToast('Competitor profile saved.', 'success');
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to save competitor.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  async toggleCompetitor(row: MarketPricingRow): Promise<void> {
    this.saving.set(true);
    try {
      await this.service.updateCompetitor(row['id'], { enabled: !row['enabled'] });
      await this.reload();
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to update competitor.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  async deleteCompetitor(row: MarketPricingRow): Promise<void> {
    if (!confirm('Delete this competitor profile and all of its benchmarks?')) return;
    this.saving.set(true);
    try {
      await this.service.deleteCompetitor(row['id']);
      await this.reload();
      this.showToast('Competitor deleted.', 'success');
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to delete competitor.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  // --- Benchmarks ---

  async saveBenchmark(): Promise<void> {
    if (!this.benchmarkDraft['competitorProfileId']) {
      this.showToast('Select a competitor before adding a benchmark.', 'danger');
      return;
    }
    this.saving.set(true);
    try {
      await this.service.createBenchmark(this.benchmarkDraft);
      this.benchmarkDraft = this.defaultBenchmark();
      await this.reload();
      this.showToast('Benchmark saved.', 'success');
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to save benchmark.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  async deleteBenchmark(row: MarketPricingRow): Promise<void> {
    if (!confirm('Delete this benchmark?')) return;
    this.saving.set(true);
    try {
      await this.service.deleteBenchmark(row['id']);
      await this.reload();
      this.showToast('Benchmark deleted.', 'success');
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to delete benchmark.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  competitorName(id: string): string {
    return this.competitors().find(c => c['id'] === id)?.['competitor_name'] || 'Unknown competitor';
  }

  // --- Simulator ---

  async runSimulation(): Promise<void> {
    this.simulating.set(true);
    this.simulationResult.set(null);
    try {
      const result = await this.service.simulate({
        countryCode: String(this.simulationInput['countryCode'] || '').toUpperCase(),
        marketCity: this.simulationInput['marketCity'] || null,
        zoneId: this.simulationInput['zoneId'] || null,
        serviceType: String(this.simulationInput['serviceType'] || '').toLowerCase(),
        vehicleClass: this.simulationInput['vehicleClass'] || null,
        currency: String(this.simulationInput['currency'] || '').toUpperCase(),
        distanceKm: Number(this.simulationInput['distanceKm'] || 0),
        durationMinutes: Number(this.simulationInput['durationMinutes'] || 0),
        baseServiceFare: Number(this.simulationInput['baseServiceFare'] || 0),
        platformFeePercent: Number(this.simulationInput['platformFeePercent'] || 0),
        driverCommissionPercent: Number(this.simulationInput['driverCommissionPercent'] || 0)
      });
      this.simulationResult.set(result);
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Simulation failed.', 'danger');
    } finally {
      this.simulating.set(false);
    }
  }

  wouldApply(): boolean {
    const result = this.simulationResult();
    if (!result) return false;
    return result.enabled && !result.shadowMode && !result.fallbackReason;
  }

  customerSavingVsMarket(): number | null {
    const result = this.simulationResult();
    if (!result || result.marketReferenceFare === null || result.marketReferenceFare === undefined) return null;
    return Number((result.marketReferenceFare - result.adjustedServiceFare).toFixed(2));
  }

  // --- Settings ---

  async saveSettings(): Promise<void> {
    if (!this.settingsDraft) return;
    const current = this.settings();
    const enablingLive = this.settingsDraft.marketPricingEnabled && !this.settingsDraft.shadowMode;
    const wasLive = current ? current.marketPricingEnabled && !current.shadowMode : false;

    let confirmLiveApplication = false;
    if (enablingLive && !wasLive) {
      confirmLiveApplication = confirm(
        'You are enabling market-adjusted customer pricing. Existing booking, payment and driver payout amounts ' +
        'may be affected for newly generated quotes. Previously generated quotes are not affected. Continue?'
      );
      if (!confirmLiveApplication) return;
    }

    this.saving.set(true);
    try {
      const updated = await this.service.updateSettings({ ...this.settingsDraft, confirmLiveApplication });
      this.settings.set(updated);
      this.settingsDraft = { ...updated };
      this.showToast('Safety settings saved.', 'success');
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to save settings.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  async forceShadowMode(): Promise<void> {
    if (!confirm('Force shadow mode immediately? Live market-adjusted pricing will stop applying to new quotes.')) return;
    this.saving.set(true);
    try {
      const updated = await this.service.updateSettings({ shadowMode: true });
      this.settings.set(updated);
      this.settingsDraft = { ...updated };
      this.showToast('Shadow mode forced on. Rollback complete.', 'success');
    } catch (error: any) {
      this.showToast(error?.error?.error || error?.message || 'Unable to force shadow mode.', 'danger');
    } finally {
      this.saving.set(false);
    }
  }

  // --- Helpers ---

  private showToast(message: string, color: 'success' | 'danger' | 'warning'): void {
    this.toastMessage.set(message);
    this.toastColor.set(color);
    setTimeout(() => this.toastMessage.set(''), 4000);
  }

  private defaultStrategy(): MarketPricingRow {
    return {
      countryCode: '',
      marketCity: null,
      zoneId: null,
      serviceType: '',
      vehicleClass: null,
      strategy: 'manual',
      targetDifferencePercent: null,
      minimumLaunchTargetFare: null,
      minimumDriverHourlyRate: null,
      minimumDriverPerKm: null,
      minimumDriverPayout: null,
      minimumPlatformMarginPercent: null,
      minimumPlatformRevenue: null,
      commissionPercent: null,
      normalDemandMultiplier: null,
      busyMultiplier: null,
      maximumSurgeMultiplier: null,
      maximumCustomerDiscountPercent: null,
      maximumMarketAdjustmentPercent: null,
      currency: ''
    };
  }

  private defaultCompetitor(): MarketPricingRow {
    return {
      countryCode: '',
      marketCity: null,
      competitorName: '',
      serviceType: '',
      vehicleClass: null,
      enabled: false,
      displayOrder: null,
      sourceType: 'manual',
      notes: ''
    };
  }

  private defaultBenchmark(): MarketPricingRow {
    return {
      competitorProfileId: '',
      distanceKm: null,
      durationMinutes: null,
      observedFare: null,
      currency: '',
      fareType: 'typical',
      observedAt: new Date().toISOString().slice(0, 16),
      expiresAt: null,
      confidenceScore: null,
      sourceReference: ''
    };
  }

  private defaultSimulationInput(): MarketPricingRow {
    return {
      countryCode: '',
      marketCity: '',
      zoneId: '',
      serviceType: '',
      vehicleClass: '',
      currency: '',
      distanceKm: null,
      durationMinutes: null,
      baseServiceFare: null,
      platformFeePercent: null,
      driverCommissionPercent: null
    };
  }
}
