import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ApiUrlService } from '../../core/services/api-url.service';
import { SupabaseService } from '../../core/services/supabase/supabase.service';
import { firstValueFrom } from 'rxjs';

interface ReferralCampaign { id: string; code: string; market_code: string; currency_code: string; }
interface ReferralRow { id: string; campaign_id: string; status: string; reward_minor: number | null; created_at: string; }

@Component({
    selector: 'app-referral-panel',
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
    <section class="space-y-4" data-testid="referral-panel">
      <h3 class="text-sm font-black text-slate-900">Refer a friend</h3>

      @if (loading()) { <p class="text-xs text-slate-500" role="status">Loading…</p> }
      @else if (error()) { <p class="text-xs text-red-600" role="alert">{{ error() }}</p> }
      @else if (!campaign()) {
        <p class="text-xs text-slate-500">No referral offer is currently available for your market.</p>
      }
      @else {
        <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div class="flex flex-col items-start gap-3">
            <div>
              <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Your referral code</p>
              <p class="text-lg font-display font-black text-slate-900 tracking-widest" data-testid="referral-code">{{ campaign()!.code }}</p>
            </div>
            <button type="button" (click)="share()" [disabled]="busy()"
              class="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
              data-testid="share-referral">Share</button>
          </div>
          @if (shareNotice()) { <p class="text-xs text-emerald-600">{{ shareNotice() }}</p> }
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Have a code?</p>
          <div class="flex gap-2">
            <input type="text" [(ngModel)]="redeemInput" placeholder="CODE:referrer-id"
              class="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold focus:border-blue-400 focus:outline-none"
              data-testid="redeem-input" />
            <button type="button" (click)="redeem()" [disabled]="busy() || !redeemInput.trim()"
              class="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 disabled:opacity-50"
              data-testid="redeem-btn">Use code</button>
          </div>
          @if (redeemNotice()) { <p class="text-xs" [class.text-emerald-600]="redeemOk()" [class.text-red-600]="!redeemOk()">{{ redeemNotice() }}</p> }
        </div>
      }

      @if (referrals().length) {
        <div class="rounded-xl border border-slate-200 bg-white p-4" data-testid="referral-status">
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Your referrals</p>
          @for (r of referrals(); track r.id) {
            <div class="flex items-center justify-between py-1.5 border-b border-slate-50 last:border-0">
              <p class="text-xs font-bold text-slate-900">{{ r.reward_minor != null ? (r.reward_minor / 100) + ' ' : '' }}reward</p>
              <p class="text-xs font-semibold" [ngClass]="statusClass(r.status)">{{ statusLabel(r.status) }}</p>
            </div>
          }
        </div>
      }
    </section>`,
})
export class ReferralPanelComponent implements OnInit {
    loading = signal(true);
    error = signal('');
    busy = signal(false);
    campaign = signal<ReferralCampaign | null>(null);
    referrals = signal<ReferralRow[]>([]);
    redeemInput = '';
    redeemNotice = signal('');
    redeemOk = signal(false);
    shareNotice = signal('');

    private http = inject(HttpClient);
    private apiUrl = inject(ApiUrlService);
    private supabase = inject(SupabaseService);

    async ngOnInit() {
        try {
            const [avail, mine] = await Promise.all([
                firstValueFrom(this.http.get<{ campaigns: ReferralCampaign[] }>(
                    this.apiUrl.getApiUrl('/api/booking/referrals/available'), { headers: await this.headers() })),
                firstValueFrom(this.http.get<{ referrals: ReferralRow[] }>(
                    this.apiUrl.getApiUrl('/api/booking/referrals/mine'), { headers: await this.headers() })),
            ]);
            this.campaign.set(avail.campaigns?.[0] || null);
            this.referrals.set(mine.referrals || []);
        } catch (e: any) {
            this.error.set(e?.error?.error || 'Could not load referrals.');
        } finally {
            this.loading.set(false);
        }
    }

    private async headers(): Promise<HttpHeaders> {
        const { data } = await this.supabase.client.auth.getSession();
        if (!data.session?.access_token) throw new Error('Please sign in again.');
        return new HttpHeaders({ Authorization: `Bearer ${data.session.access_token}` });
    }

    statusLabel(s: string) {
        switch (s) {
            case 'pending': return 'Waiting for their first trip';
            case 'earned': return 'Reward earned';
            case 'released': return 'Reward released';
            case 'reversed': return 'Reward reversed';
            case 'rejected': return 'Not eligible';
            default: return s;
        }
    }
    statusClass(s: string) {
        if (s === 'earned' || s === 'released') return 'text-emerald-600';
        if (s === 'reversed' || s === 'rejected') return 'text-red-500';
        return 'text-slate-500';
    }

    async share() {
        const c = this.campaign(); if (!c) return;
        this.busy.set(true); this.shareNotice.set('');
        const userId = this.supabase.client.auth.getSession
            ? (await this.supabase.client.auth.getSession()).data.session?.user?.id
            : undefined;
        const text = `Try Vaydu with my referral code ${c.code}:${userId || ''}`;
        try {
            if ((navigator as any).share) {
                await (navigator as any).share({ title: 'Vaydu referral', text });
            } else {
                await navigator.clipboard.writeText(text);
            }
            this.shareNotice.set('Referral copied — share it with a friend.');
        } catch { /* user dismissed the share sheet */ }
        this.busy.set(false);
    }

    async redeem() {
        const raw = this.redeemInput.trim();
        const [code, referrerId] = raw.split(':').map(p => p.trim());
        if (!code || !referrerId) {
            this.redeemNotice.set('Paste the full code in CODE:referrer-id form.');
            this.redeemOk.set(false);
            return;
        }
        this.busy.set(true); this.redeemNotice.set('');
        try {
            await firstValueFrom(this.http.post(
                this.apiUrl.getApiUrl('/api/booking/referrals/redeem'),
                { code, referrerId }, { headers: await this.headers() }));
            this.redeemNotice.set('Code applied — your reward unlocks after your first completed trip.');
            this.redeemOk.set(true);
            this.redeemInput = '';
        } catch (e: any) {
            this.redeemNotice.set(e?.error?.error || 'That code could not be used.');
            this.redeemOk.set(false);
        } finally {
            this.busy.set(false);
        }
    }
}
