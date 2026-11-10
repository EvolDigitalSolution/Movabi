import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { AdminService } from '../../services/admin.service';

interface PolicyRow {
    id: string; version: number; reference_fare_minor: number;
    debt_threshold_minor: number; grace_seconds: number;
    cancellation_fee_minor: number; fee_cap_minor: number | null;
    driver_compensation_percent: number; compensation_funding: string;
    enabled: boolean; created_at: string;
}

@Component({
    selector: 'app-admin-policy-publish',
    standalone: true,
    imports: [CommonModule, FormsModule, IonicModule],
    template: `
    <section class="space-y-6">
      <div>
        <h2 class="text-lg font-bold text-slate-950">Cancellation policy publication</h2>
        <p class="text-xs text-slate-500 mt-1">Publishing creates a new immutable version — the debt threshold is persisted in minor units at publish and later fare changes never alter it. Existing fare snapshots and history are unaffected.</p>
      </div>

      <!-- Publish form -->
      <div class="rounded-2xl border border-slate-200 p-4 space-y-3">
        <h3 class="text-sm font-bold text-slate-800">New version</h3>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <label class="space-y-1"><span class="font-bold text-slate-600">Tenant ID</span>
            <input [(ngModel)]="form.tenantId" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Market</span>
            <input [(ngModel)]="form.market" placeholder="GB" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Reference fare (minor units)</span>
            <input type="number" [(ngModel)]="form.referenceFareMinor" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Debt threshold (bps)</span>
            <input type="number" [(ngModel)]="form.debtThresholdBps" placeholder="5000" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Grace (seconds)</span>
            <input type="number" [(ngModel)]="form.graceSeconds" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Fee (minor units)</span>
            <input type="number" [(ngModel)]="form.feeMinor" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Fee cap (minor, optional)</span>
            <input type="number" [(ngModel)]="form.feeCapMinor" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
          <label class="space-y-1"><span class="font-bold text-slate-600">Compensation %</span>
            <input type="number" [(ngModel)]="form.compensationPercent" placeholder="80" class="w-full rounded-lg border border-slate-200 px-2 py-1.5"></label>
        </div>
        @if (validationError()) { <p role="alert" class="text-xs text-rose-600">{{ validationError() }}</p> }
        @if (published(); as pub) {
          <p class="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
            Published version {{ pub.version }} — threshold {{ pub.debt_threshold_minor }} minor persisted.</p>
        }
        <div class="flex gap-2">
          <button type="button" (click)="publish()" [disabled]="busy()"
            class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">
            {{ busy() ? 'Publishing…' : 'Publish version' }}</button>
          <button type="button" (click)="loadPolicies()" [disabled]="!form.tenantId || !form.market"
            class="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700">Load versions</button>
        </div>
      </div>

      <!-- Margin preview -->
      <div class="rounded-2xl border border-slate-200 p-4 space-y-3">
        <h3 class="text-sm font-bold text-slate-800">Margin preview</h3>
        <p class="text-xs text-slate-500">Values come from the authoritative fare snapshot — never browser-supplied totals.</p>
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
        <button type="button" (click)="runPreview()" [disabled]="previewBusy()"
          class="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700 disabled:opacity-50">
          {{ previewBusy() ? 'Previewing…' : 'Preview margin' }}</button>
        @if (previewResult()) {
          <div class="rounded-lg bg-slate-50 p-3 text-xs font-mono">
            <div>gross {{ previewResult().grossRevenueMinor }} · discount −{{ previewResult().discountMinor }} · referral −{{ previewResult().referralLiabilityMinor }} · processing −{{ previewResult().processingMinor }}</div>
            <div class="font-bold mt-1" [class.text-rose-600]="previewResult().vayduMarginMinor < 0" [class.text-emerald-700]="previewResult().vayduMarginMinor >= 0">
              Vaydu margin {{ previewResult().vayduMarginMinor }} minor ({{ previewResult().marginBps }} bps)</div>
          </div>
        }
      </div>

      <!-- Versions + audit -->
      @if (policies().length) {
        <div class="rounded-2xl border border-slate-200 p-4">
          <h3 class="text-sm font-bold text-slate-800 mb-2">Versions ({{ form.market }})</h3>
          <table class="w-full text-xs">
            <thead><tr class="text-left text-slate-500">
              <th class="pb-1">v</th><th class="pb-1">Ref fare</th><th class="pb-1">Threshold</th><th class="pb-1">Fee</th><th class="pb-1">Comp %</th><th class="pb-1">On</th></tr></thead>
            <tbody>
              @for (p of policies(); track p.id) {
                <tr class="border-t border-slate-100">
                  <td class="py-1.5 font-bold">{{ p.version }}</td>
                  <td>{{ p.reference_fare_minor }}</td>
                  <td>{{ p.debt_threshold_minor }}</td>
                  <td>{{ p.cancellation_fee_minor }}</td>
                  <td>{{ p.driver_compensation_percent }}%</td>
                  <td>{{ p.enabled ? 'yes' : 'no' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      @if (audit().length) {
        <div class="rounded-2xl border border-slate-200 p-4">
          <h3 class="text-sm font-bold text-slate-800 mb-2">Audit history</h3>
          @for (a of audit(); track a.id) {
            <div class="border-t border-slate-100 py-1.5 text-xs">
              <span class="font-bold">{{ a.action }}</span>
              <span class="text-slate-500 ml-2">{{ a.created_at | date:'short' }}</span>
              <span class="text-slate-400 ml-2">v{{ a.metadata?.version }}</span>
            </div>
          }
        </div>
      }
      @if (error()) { <p role="alert" class="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{{ error() }}</p> }
    </section>
    `
})
export class AdminPolicyPublishComponent implements OnInit {
    private admin = inject(AdminService);
    form = { tenantId: '', market: 'GB', referenceFareMinor: 0, debtThresholdBps: 5000, graceSeconds: 300, feeMinor: 0, feeCapMinor: null as number | null, compensationPercent: 80 };
    preview = { customerCharge: 0, driverCommission: 0, platformFee: 0, driverEntitlement: 0, discountMinor: 0, referralLiabilityMinor: 0, processingMinor: 0 };
    busy = signal(false);
    previewBusy = signal(false);
    error = signal('');
    validationError = signal('');
    published = signal<PolicyRow | null>(null);
    policies = signal<PolicyRow[]>([]);
    audit = signal<any[]>([]);
    previewResult = signal<any>(null);

    async ngOnInit() { await this.loadAudit(); }

    private validate(): string {
        const f = this.form;
        if (!f.tenantId.trim() || !f.market.trim()) return 'Tenant and market are required.';
        if (!Number.isFinite(f.referenceFareMinor) || f.referenceFareMinor <= 0) return 'Reference fare must be a positive minor-unit amount.';
        if (!Number.isFinite(f.debtThresholdBps) || f.debtThresholdBps < 0 || f.debtThresholdBps > 10000) return 'Debt threshold must be 0–10000 basis points.';
        if (Number(f.compensationPercent) < 0 || Number(f.compensationPercent) > 100) return 'Compensation percent must be 0–100.';
        return '';
    }

    async publish() {
        const v = this.validate();
        this.validationError.set(v);
        if (v) return;
        this.busy.set(true); this.error.set(''); this.published.set(null);
        try {
            const policy = await this.admin.publishCancellationPolicy(this.form);
            this.published.set(policy);
            await this.loadPolicies();
            await this.loadAudit();
        } catch (e: any) { this.error.set(e?.message || 'Could not publish.'); }
        finally { this.busy.set(false); }
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

    async loadPolicies() { this.policies.set(await this.admin.listCancellationPolicies(this.form.tenantId, this.form.market)); }
    async loadAudit() { this.audit.set(await this.admin.policyAudit()); }
}
