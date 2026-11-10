import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { AdminService } from '../../services/admin.service';

interface Receivable {
    id: string; customer_id: string; job_id: string | null;
    currency_code: string; amount_minor: number; reason: string;
    status: string; policy_version: number | null; dispute_reason: string | null;
    created_at: string;
}
interface AuditRow { id: string; action: string; metadata: any; created_at: string; }

@Component({
    selector: 'app-admin-receivables',
    standalone: true,
    imports: [CommonModule, FormsModule, IonicModule],
    template: `
    <section class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-bold text-slate-950">Customer receivables</h2>
          <p class="text-xs text-slate-500 mt-1">Unpaid fees owed to the platform. 'Paid' requires a verified payment reference — never mark payment success without one.</p>
        </div>
        <div class="flex items-center gap-2">
          <select [(ngModel)]="filter" (change)="load()" class="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold">
            <option value="open">Open</option>
            <option value="disputed">Disputed</option>
            <option value="paid">Paid</option>
            <option value="waived">Waived</option>
            <option value="written_off">Written off</option>
          </select>
          <button type="button" (click)="load()" [disabled]="loading()" class="rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700 disabled:opacity-50">Refresh</button>
        </div>
      </div>

      @if (loading()) { <p role="status" class="text-sm text-slate-500">Loading receivables…</p> }
      @else if (error()) { <p role="alert" class="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{{ error() }}</p> }
      @else if (!rows().length) { <p class="text-sm text-slate-500">No {{ filter }} receivables.</p> }
      @else {
        <div class="overflow-x-auto rounded-xl border border-slate-200">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr><th class="px-3 py-2 text-left">Amount</th><th class="px-3 py-2 text-left">Reason</th><th class="px-3 py-2 text-left">Customer</th><th class="px-3 py-2 text-left">Created</th><th class="px-3 py-2 text-left">Actions</th></tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.id) {
                <tr class="border-t border-slate-100">
                  <td class="px-3 py-2 font-bold">{{ money(r.amount_minor, r.currency_code) }}</td>
                  <td class="px-3 py-2">
                    {{ label(r.reason) }}
                    @if (r.dispute_reason) { <p class="mt-0.5 max-w-[16rem] truncate text-xs text-amber-700" [title]="r.dispute_reason">“{{ r.dispute_reason }}”</p> }
                  </td>
                  <td class="px-3 py-2 font-mono text-xs text-slate-500">{{ r.customer_id.slice(0, 8) }}…</td>
                  <td class="px-3 py-2 text-xs text-slate-500">{{ r.created_at | date:'dd MMM yyyy HH:mm' }}</td>
                  <td class="px-3 py-2">
                    <div class="flex flex-wrap gap-2">
                      <button type="button" (click)="toggleAudit(r)" class="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-bold text-slate-600">Audit</button>
                      @if (filter === 'open' || filter === 'disputed') {
                        <button type="button" (click)="resolve(r, 'waived')" [disabled]="busy() === r.id" class="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">Waive</button>
                        <button type="button" (click)="resolve(r, 'written_off')" [disabled]="busy() === r.id" class="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">Write off</button>
                        <button type="button" (click)="resolve(r, 'paid')" [disabled]="busy() === r.id" class="rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">Mark paid…</button>
                      }
                    </div>
                  </td>
                </tr>
                @if (auditFor() === r.id) {
                  <tr class="border-t border-slate-100 bg-slate-50/60">
                    <td colspan="5" class="px-3 py-2">
                      @if (!audit().length) { <p class="text-xs text-slate-500">No audit events for this receivable.</p> }
                      @for (a of audit(); track a.id) {
                        <p class="text-xs text-slate-600"><span class="font-bold">{{ a.action }}</span> · {{ a.created_at | date:'dd MMM HH:mm:ss' }} · {{ a.metadata | json }}</p>
                      }
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      }
    </section>`,
})
export class AdminReceivablesComponent implements OnInit {
    filter: 'open' | 'disputed' | 'paid' | 'waived' | 'written_off' = 'open';
    rows = signal<Receivable[]>([]);
    audit = signal<AuditRow[]>([]);
    auditFor = signal<string | null>(null);
    loading = signal(true);
    busy = signal<string | null>(null);
    error = signal('');

    private admin = inject(AdminService);

    ngOnInit() { void this.load(); }

    async load() {
        this.loading.set(true); this.error.set('');
        try { this.rows.set(await this.admin.listReceivables(this.filter)); }
        catch (e: any) { this.error.set(e?.message || 'Could not load receivables.'); }
        finally { this.loading.set(false); }
    }

    async resolve(r: Receivable, status: 'paid' | 'waived' | 'written_off') {
        let paymentReference: string | undefined;
        let reason: string | undefined;
        if (status === 'paid') {
            paymentReference = window.prompt(`Payment reference proving ${this.money(r.amount_minor, r.currency_code)} was received (required):`)?.trim();
            if (!paymentReference) return;
        } else {
            reason = window.prompt(`Reason to ${status === 'waived' ? 'waive' : 'write off'} this charge:`)?.trim() || undefined;
        }
        this.busy.set(r.id); this.error.set('');
        try { await this.admin.resolveReceivable(r.id, status, reason, paymentReference); await this.load(); }
        catch (e: any) { this.error.set(e?.message || 'Could not resolve.'); }
        finally { this.busy.set(null); }
    }

    async toggleAudit(r: Receivable) {
        if (this.auditFor() === r.id) { this.auditFor.set(null); this.audit.set([]); return; }
        this.auditFor.set(r.id);
        this.audit.set(await this.admin.receivableAudit(r.id));
    }

    label(reason: string) {
        switch (reason) {
            case 'cancellation_fee': return 'Cancellation fee';
            case 'no_show_fee': return 'No-show fee';
            case 'fare_adjustment': return 'Fare adjustment';
            default: return 'Manual charge';
        }
    }

    money(minor: number, currency: string) {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(minor / 100);
    }
}
