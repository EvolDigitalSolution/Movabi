import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminService } from '../../services/admin.service';

interface CampaignRow {
    id: string; code: string; kind: string; market_code: string; currency_code: string;
    service_slug: string; audience: string; enabled: boolean; paused: boolean; version: number;
    value_type: string | null; value: number | null; referral_reward_bps: number;
    budget_minor: number; spent_minor: number; per_user_cap: number; usage_limit: number | null;
    stacking: string; qualification: Record<string, unknown>;
    published_at: string | null; published_by: string | null; created_at: string;
}

@Component({
    selector: 'app-admin-campaigns',
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
    <section class="space-y-6">
      <div>
        <h2 class="text-lg font-bold text-slate-950">Campaigns — promotions, referrals & driver bonuses</h2>
        <p class="text-xs text-slate-500 mt-1">Edits and lifecycle transitions create a new policy version; accepted discounts, reserved budgets and earned/pending rewards are never erased.</p>
      </div>

      <!-- Create / edit form -->
      <div class="rounded-2xl border border-slate-200 p-4 space-y-3">
        <h3 class="text-sm font-bold text-slate-800">{{ editingId ? 'Edit campaign (new version)' : 'New campaign' }}</h3>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <label class="space-y-1"><span class="font-bold text-slate-600">Tenant ID</span>
            <input [(ngModel)]="form.tenantId" [disabled]="!!editingId" class="w-full rounded-lg border border-slate-200 px-2 py-1.5 disabled:opacity-50"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Code</span>
            <input [(ngModel)]="form.code" [disabled]="!!editingId" placeholder="WELCOME5" class="w-full rounded-lg border border-slate-200 px-2 py-1.5 disabled:opacity-50"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Kind</span>
            <select [(ngModel)]="form.kind" class="w-full rounded-lg border border-slate-200 px-2 py-1.5">
              <option value="customer_discount">Customer promotion</option>
              <option value="referral">Referral</option>
              <option value="driver_incentive">Driver incentive</option>
            </select></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Market</span>
            <input [(ngModel)]="form.marketCode" placeholder="GB" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Currency</span>
            <input [(ngModel)]="form.currencyCode" placeholder="GBP" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Service slug</span>
            <input [(ngModel)]="form.serviceSlug" placeholder="ride" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Audience</span>
            <select [(ngModel)]="form.audience" class="w-full rounded-lg border border-slate-200 px-2 py-1.5">
              <option value="customer">customer</option><option value="driver">driver</option><option value="both">both</option>
            </select></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Value type</span>
            <select [(ngModel)]="form.valueType" class="w-full rounded-lg border border-slate-200 px-2 py-1.5">
              <option value="">none</option><option value="percent">percent</option><option value="fixed_minor">fixed (minor)</option>
            </select></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Discount % (default 5)</span>
            <input type="number" [(ngModel)]="form.value" placeholder="5" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Referral reward (bps, 500 = 5%)</span>
            <input type="number" [(ngModel)]="form.referralRewardBps" placeholder="500" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Budget (minor)</span>
            <input type="number" [(ngModel)]="form.budgetMinor" placeholder="0" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Per-user cap</span>
            <input type="number" [(ngModel)]="form.perUserCap" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Usage limit (optional)</span>
            <input type="number" [(ngModel)]="form.usageLimit" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Stacking</span>
            <select [(ngModel)]="form.stacking" class="w-full rounded-lg border border-slate-200 px-2 py-1.5">
              <option value="exclusive">exclusive</option><option value="stackable">stackable</option>
            </select></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Funding party</span>
            <select [(ngModel)]="form.fundingParty" class="w-full rounded-lg border border-slate-200 px-2 py-1.5">
              <option value="platform">platform</option><option value="merchant">merchant</option><option value="partner">partner</option>
            </select></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Valid from</span>
            <input type="datetime-local" [(ngModel)]="form.validFrom" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Valid until</span>
            <input type="datetime-local" [(ngModel)]="form.validUntil" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Min qualifying fare (minor)</span>
            <input type="number" [(ngModel)]="form.minFareMinor" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Max discount (minor)</span>
            <input type="number" [(ngModel)]="form.maxDiscountMinor" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
        </div>
        <label class="flex items-center gap-2 text-xs font-bold text-slate-600">
          <input type="checkbox" [(ngModel)]="form.firstBookingOnly"> First booking only
        </label>
        @if (validationError()) { <p role="alert" class="text-xs text-rose-600">{{ validationError() }}</p> }
        @if (savedVersion()) {
          <p class="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">Saved version {{ savedVersion() }}.</p>
        }
        <div class="flex gap-2">
          <button type="button" (click)="save()" [disabled]="busy()" data-testid="save-campaign"
            class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{{ editingId ? 'Save new version' : 'Create' }}</button>
          @if (editingId) {
            <button type="button" (click)="resetForm()" class="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700">Cancel edit</button>
          }
        </div>
      </div>

      <!-- Margin preview -->
      <div class="rounded-2xl border border-slate-200 p-4 space-y-3">
        <h3 class="text-sm font-bold text-slate-800">Margin preview</h3>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <label class="space-y-1"><span class="font-bold text-slate-600">Customer charge (minor)</span>
            <input type="number" [(ngModel)]="preview.customerCharge" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Driver commission (minor)</span>
            <input type="number" [(ngModel)]="preview.driverCommission" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Platform fee (minor)</span>
            <input type="number" [(ngModel)]="preview.platformFee" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Driver entitlement (minor)</span>
            <input type="number" [(ngModel)]="preview.driverEntitlement" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Discount (minor)</span>
            <input type="number" [(ngModel)]="preview.discountMinor" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Referral liability (minor)</span>
            <input type="number" [(ngModel)]="preview.referralLiabilityMinor" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Processing (minor)</span>
            <input type="number" [(ngModel)]="preview.processingMinor" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
        </div>
        <button type="button" (click)="runPreview()" [disabled]="previewBusy()" class="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700 disabled:opacity-50">Preview margin</button>
        @if (previewResult()) {
          <div class="rounded-lg bg-slate-50 p-3 text-xs font-mono">Vaydu margin {{ previewResult().vayduMarginMinor }} minor ({{ previewResult().marginBps }} bps)</div>
        }
      </div>

      <!-- Campaign list with lifecycle actions -->
      @if (campaigns().length) {
        <div class="rounded-2xl border border-slate-200 p-4">
          <h3 class="text-sm font-bold text-slate-800 mb-2">Campaigns</h3>
          <table class="w-full text-xs">
            <thead><tr class="text-left text-slate-500">
              <th class="pb-1">Code</th><th class="pb-1">Kind</th><th class="pb-1">Rate</th><th class="pb-1">State</th><th class="pb-1">v</th><th class="pb-1"></th>
            </tr></thead>
            <tbody>
              @for (c of campaigns(); track c.id) {
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 font-bold">{{ c.code }}</td>
                  <td>{{ c.kind }}</td>
                  <td>{{ c.kind === 'referral' ? (c.referral_reward_bps / 100) + '%' : (c.value_type === 'percent' ? c.value + '%' : c.value) }}</td>
                  <td>{{ c.paused ? 'paused' : (c.enabled ? 'enabled' : 'disabled') }}</td>
                  <td>{{ c.version }}</td>
                  <td class="text-right space-x-1">
                    <button (click)="edit(c)" class="rounded bg-slate-100 px-2 py-1 font-bold text-slate-700">Edit</button>
                    <button (click)="setStatus(c, 'enabled')" class="rounded bg-emerald-100 px-2 py-1 font-bold text-emerald-700">Enable</button>
                    <button (click)="setStatus(c, 'paused')" class="rounded bg-amber-100 px-2 py-1 font-bold text-amber-700">Pause</button>
                    <button (click)="setStatus(c, 'disabled')" class="rounded bg-rose-100 px-2 py-1 font-bold text-rose-700">Disable</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      <!-- Audit history -->
      @if (audit().length) {
        <div class="rounded-2xl border border-slate-200 p-4">
          <h3 class="text-sm font-bold text-slate-800 mb-2">Audit history</h3>
          @for (a of audit(); track a.id) {
            <div class="border-t border-slate-100 py-1.5 text-xs">
              <span class="font-bold">{{ a.action }}</span>
              <span class="text-slate-500 ml-2">{{ a.created_at | date:'short' }}</span>
              @if (a.metadata?.version) { <span class="text-slate-400 ml-2">v{{ a.metadata.version }}</span> }
            </div>
          }
        </div>
      }

      <div class="flex gap-2">
        <button type="button" (click)="load()" class="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700">Reload</button>
      </div>
      @if (error()) { <p role="alert" class="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{{ error() }}</p> }
    </section>
    `
})
export class AdminCampaignsComponent implements OnInit {
    private admin = inject(AdminService);
    form = {
        tenantId: '', code: '', kind: 'customer_discount', marketCode: 'GB', currencyCode: 'GBP',
        serviceSlug: 'ride', audience: 'customer', valueType: 'percent', value: 5,
        referralRewardBps: 500, budgetMinor: 0, perUserCap: 1, usageLimit: null as number | null,
        stacking: 'exclusive', fundingParty: 'platform', validFrom: '', validUntil: '',
        minFareMinor: 0, maxDiscountMinor: 0, firstBookingOnly: false
    };
    preview = { customerCharge: 0, driverCommission: 0, platformFee: 0, driverEntitlement: 0, discountMinor: 0, referralLiabilityMinor: 0, processingMinor: 0 };
    campaigns = signal<CampaignRow[]>([]);
    audit = signal<any[]>([]);
    busy = signal(false);
    previewBusy = signal(false);
    error = signal('');
    validationError = signal('');
    savedVersion = signal<number | null>(null);
    previewResult = signal<any>(null);
    editingId = '';

    async ngOnInit() { await this.load(); await this.loadAudit(); }

    private payload(): Record<string, unknown> {
        const qualification: Record<string, unknown> = {
            firstBookingOnly: this.form.firstBookingOnly,
            min_qualifying_fare_minor: this.form.minFareMinor || null,
            max_discount_minor: this.form.maxDiscountMinor || null
        };
        return {
            tenant_id: this.form.tenantId, code: this.form.code.trim(), kind: this.form.kind,
            market_code: this.form.marketCode, currency_code: this.form.currencyCode,
            service_slug: this.form.serviceSlug, audience: this.form.audience,
            value_type: this.form.valueType || null, value: this.form.value,
            referral_reward_bps: this.form.referralRewardBps, budget_minor: this.form.budgetMinor,
            per_user_cap: this.form.perUserCap, usage_limit: this.form.usageLimit,
            stacking: this.form.stacking, funding_party: this.form.fundingParty,
            valid_from: this.form.validFrom || null, valid_until: this.form.validUntil || null,
            qualification
        };
    }

    private validate(): string {
        if (!this.form.tenantId.trim() || !this.form.code.trim()) return 'Tenant and code are required.';
        const pct = Number(this.form.value);
        if (this.form.valueType === 'percent' && (!Number.isFinite(pct) || pct < 0 || pct > 100)) return 'Discount percent must be 0–100.';
        return '';
    }

    async save() {
        const v = this.validate();
        this.validationError.set(v);
        if (v) return;
        this.busy.set(true); this.error.set(''); this.savedVersion.set(null);
        try {
            const campaign = this.editingId ? await this.admin.editCampaign(this.editingId, this.payload()) : await this.admin.createCampaign(this.payload());
            this.savedVersion.set(campaign.version);
            this.resetForm();
            await this.load();
            await this.loadAudit();
        } catch (e: any) { this.error.set(e?.message || 'Could not save the campaign.'); }
        finally { this.busy.set(false); }
    }

    edit(c: CampaignRow) {
        this.editingId = c.id;
        this.form = {
            tenantId: (c as any).tenant_id ?? '', code: c.code, kind: c.kind, marketCode: c.market_code,
            currencyCode: c.currency_code, serviceSlug: c.service_slug, audience: c.audience,
            valueType: c.value_type || '', value: c.value ?? 5, referralRewardBps: c.referral_reward_bps,
            budgetMinor: c.budget_minor, perUserCap: c.per_user_cap, usageLimit: c.usage_limit,
            stacking: c.stacking, fundingParty: (c as any).funding_party ?? 'platform', validFrom: '', validUntil: '',
            minFareMinor: Number(c.qualification?.['min_qualifying_fare_minor'] ?? 0) || 0,
            maxDiscountMinor: Number(c.qualification?.['max_discount_minor'] ?? 0) || 0,
            firstBookingOnly: !!c.qualification?.['firstBookingOnly']
        };
        this.validationError.set('');
    }

    resetForm() {
        this.editingId = '';
        this.form = {
            tenantId: '', code: '', kind: 'customer_discount', marketCode: 'GB', currencyCode: 'GBP',
            serviceSlug: 'ride', audience: 'customer', valueType: 'percent', value: 5,
            referralRewardBps: 500, budgetMinor: 0, perUserCap: 1, usageLimit: null,
            stacking: 'exclusive', fundingParty: 'platform', validFrom: '', validUntil: '',
            minFareMinor: 0, maxDiscountMinor: 0, firstBookingOnly: false
        };
    }

    async setStatus(c: CampaignRow, state: 'enabled' | 'paused' | 'disabled') {
        this.error.set('');
        try {
            await this.admin.setCampaignStatus(c.id, state);
            await this.load();
            await this.loadAudit();
        } catch (e: any) { this.error.set(e?.message || 'Could not update the status.'); }
    }

    async runPreview() {
        this.previewBusy.set(true); this.error.set(''); this.previewResult.set(null);
        try {
            this.previewResult.set(await this.admin.previewVayduMargin({
                fareSnapshot: {
                    customerCharge: this.preview.customerCharge,
                    driverCommissionAmount: this.preview.driverCommission,
                    platformFeeAmount: this.preview.platformFee,
                    driverEntitlement: this.preview.driverEntitlement
                },
                discountMinor: this.preview.discountMinor,
                referralLiabilityMinor: this.preview.referralLiabilityMinor,
                processingMinor: this.preview.processingMinor
            }));
        } catch (e: any) { this.error.set(e?.message || 'Preview failed.'); }
        finally { this.previewBusy.set(false); }
    }

    async load() { this.campaigns.set(await this.admin.listCampaigns(this.form.tenantId || (this.campaigns()[0] as any)?.tenant_id || '')); }
    async loadAudit() { this.audit.set(await this.admin.campaignAudit()); }
}
