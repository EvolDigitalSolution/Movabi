import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ApiUrlService } from '../../core/services/api-url.service';
import { AuthService } from '../../core/services/auth/auth.service';
import { firstValueFrom } from 'rxjs';

interface Debt {
    id: string; job_id: string | null; currency_code: string; amount_minor: number;
    reason: string; status: string; policy_version: number | null; created_at: string;
}

@Component({
    selector: 'app-customer-debts',
    standalone: true,
    imports: [CommonModule],
    template: `
    <section class="space-y-3" data-testid="customer-debts" *ngIf="debts().length">
      <h3 class="text-sm font-black text-slate-900">Outstanding charges</h3>
      <p class="text-xs text-slate-500">These are amounts owed from previous bookings — they are not wallet credit.</p>
      @for (d of debts(); track d.id) {
        <div class="rounded-xl border border-amber-200 bg-amber-50 p-3" [attr.data-testid]="'debt-' + d.id">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm font-bold text-slate-900">{{ formatAmount(d.amount_minor, d.currency_code) }}</p>
              <p class="text-xs text-slate-600">{{ reasonLabel(d.reason) }} · {{ d.status === 'disputed' ? 'Under dispute review' : 'To pay' }}</p>
            </div>
            <div class="flex shrink-0 gap-2">
              @if (d.status === 'open') {
                <button type="button" (click)="repay(d)" [disabled]="busy() === d.id" class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white">Repay</button>
                <button type="button" (click)="dispute(d)" [disabled]="busy() === d.id" class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700">Dispute</button>
              }
            </div>
          </div>
        </div>
      }
      @if (error()) { <p class="text-xs text-red-600" role="alert">{{ error() }}</p> }
    </section>`,
})
export class CustomerDebtsComponent implements OnInit {
    debts = signal<Debt[]>([]);
    busy = signal<string | null>(null);
    error = signal('');

    private http = inject(HttpClient);
    private apiUrl = inject(ApiUrlService);
    private auth = inject(AuthService);

    async ngOnInit() { await this.refresh(); }

    reasonLabel(r: string) {
        switch (r) {
            case 'cancellation_fee': return 'Cancellation fee';
            case 'no_show_fee': return 'No-show fee';
            case 'fare_adjustment': return 'Fare adjustment';
            default: return 'Charge';
        }
    }

    formatAmount(minor: number, currency: string) {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(minor / 100);
    }

    private async headers() {
        const token = this.auth.session()?.access_token || '';
        return { Authorization: `Bearer ${token}` };
    }

    async refresh() {
        try {
            const res = await firstValueFrom(this.http.get<{ debts: Debt[] }>(
                this.apiUrl.getApiUrl('/api/booking/debts'), { headers: await this.headers() }));
            this.debts.set(res.debts || []);
        } catch { this.debts.set([]); }
    }

    async repay(d: Debt) {
        this.busy.set(d.id); this.error.set('');
        try {
            const res = await firstValueFrom(this.http.post<{ clientSecret: string; paymentIntentId: string }>(
                this.apiUrl.getApiUrl(`/api/booking/debts/${d.id}/repay`), {}, { headers: await this.headers() }));
            // Hand off to the existing card-checkout flow with the returned
            // client secret — the webhook marks the debt paid on success.
            (this.auth as any).openCardCheckout?.({ clientSecret: res.clientSecret, purpose: 'debt_repayment' });
            await this.refresh();
        } catch (e: any) {
            this.error.set(e?.error?.error || 'Could not start repayment.');
        } finally {
            this.busy.set(null);
        }
    }

    async dispute(d: Debt) {
        const reason = window.prompt('Why is this charge wrong? (10+ characters)') || '';
        if (reason.trim().length < 10) { this.error.set('Please explain the dispute in 10+ characters.'); return; }
        this.busy.set(d.id); this.error.set('');
        try {
            await firstValueFrom(this.http.post(
                this.apiUrl.getApiUrl(`/api/booking/debts/${d.id}/dispute`), { reason }, { headers: await this.headers() }));
            await this.refresh();
        } catch (e: any) {
            this.error.set(e?.error?.error || 'Could not submit the dispute.');
        } finally {
            this.busy.set(null);
        }
    }
}
