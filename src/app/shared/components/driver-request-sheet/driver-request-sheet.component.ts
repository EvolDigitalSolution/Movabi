import { DriverEarningsPreviewComponent } from '@shared/ui/driver-earnings-preview.component';
import { Component, inject, signal } from '@angular/core';
import { IonModal, IonContent } from '@ionic/angular/standalone';
import { DriverRequestFeedService } from '@core/services/driver/driver-request-feed.service';
import { AppConfigService } from '@core/services/config/app-config.service';

@Component({
    selector: 'app-driver-request-sheet', standalone: true, imports: [IonModal, IonContent, DriverEarningsPreviewComponent],
    styles: [`
      ion-modal { --request-sheet-height: min(680px, calc(100dvh - env(safe-area-inset-top, 0px) - 24px)); --height: var(--request-sheet-height); --max-height: calc(100dvh - 24px); --border-radius: 28px 28px 0 0; --box-shadow: 0 -12px 48px #0f172a22; }
      .request-card { font-size:14px; }
      .request-card p { margin:0; }
      .request-card .request-address { font-size:14px!important;line-height:1.4!important;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }
      .request-card .request-price { font-size:24px!important;color:#0f172a!important;font-weight:800; }
      .request-actions { position:absolute;bottom:var(--request-footer-offset, 0px);left:0;right:0;display:grid;grid-template-columns:1fr 2fr;gap:10px;padding:12px 20px max(20px, env(safe-area-inset-bottom));background:white;border-top:1px solid #e2e8f0;z-index:5; }
      .request-actions button { min-height:48px;font-size:14px!important;font-weight:700;border-radius:14px; }
      .request-actions .request-pass { background:#f1f5f9;color:#0f172a;border:1px solid #cbd5e1; }
      .request-actions button:disabled { opacity:.5; }
      .request-launcher { position: fixed; right: 16px; bottom: calc(env(safe-area-inset-bottom) + 100px); z-index: 40000;
        border: 0; border-radius: 999px; padding: 14px 18px; background: #0f172a; color: white;
        box-shadow: 0 6px 24px #0f172a33; font-weight: 700; font-size: 14px; }
    `],
    template: `
      @if (feed.count() && !feed.open()) {
        <button type="button" class="request-launcher" (click)="feed.show()" aria-haspopup="dialog">
          {{ feed.count() }} {{ feed.count() === 1 ? 'request' : 'requests' }} · View
        </button>
      }
      <ion-modal [isOpen]="feed.open() && feed.count() > 0" [initialBreakpoint]="1"
        [breakpoints]="[0, 0.65, 1]" (ionBreakpointDidChange)="requestBreakpoint.set($event.detail.breakpoint)" [handle]="true" [canDismiss]="canDismiss"
        (didDismiss)="feed.close()" aria-label="Available driver requests">
        <ng-template>
          <ion-content [scrollY]="true" [style.--request-footer-offset]="footerOffset()" [style.--padding-bottom]="footerOffset()">
            <section class="px-5 pt-3 pb-8" style="padding-bottom: calc(env(safe-area-inset-bottom) + 110px)">
              <header class="flex items-center justify-between gap-3 mb-4">
                <div><p class="text-xs uppercase tracking-wide font-bold text-amber-700">Driver requests</p>
                  <h2 class="text-xl font-bold text-slate-950 mt-1">{{ feed.count() }} available {{ feed.count() === 1 ? 'request' : 'requests' }}</h2></div>
                <button type="button" (click)="feed.close()" [disabled]="feed.busy()" class="rounded-full bg-slate-100 px-4 py-3 text-sm font-semibold">Close</button>
              </header>
              @if (feed.count() > 1) {
              <div class="flex gap-2 overflow-x-auto pb-3" aria-label="Choose request">
                @for (id of feed.ids(); track id; let i = $index) {
                  <button type="button" (click)="feed.show(id)" [disabled]="feed.busy()"
                    [attr.aria-pressed]="feed.selectedId() === id"
                    class="shrink-0 rounded-full px-4 py-2 text-sm font-semibold border"
                    [class.bg-amber-100]="feed.selectedId() === id" [class.border-amber-400]="feed.selectedId() === id">
                    {{ feed.title(id) }} · {{ i + 1 }}
                  </button>
                }
              </div>
              }
              @let job = feed.selectedJob();
              @let offer = feed.selectedOffer();
              <article class="request-card rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
                <div class="flex items-start justify-between gap-4">
                  <div><p class="text-sm font-bold text-slate-950">{{ feed.title(feed.selectedId()) }}</p>
                    <p class="text-xs text-slate-500 mt-1">{{ offer ? 'Customer offer · negotiate or agree' : 'Ready to accept' }}</p></div>
                </div>
                <app-driver-earnings-preview [jobId]="feed.selectedId()" [amount]="offer ? (offer.customer_offer ?? offer.suggested_fare) : undefined"></app-driver-earnings-preview>
                <div class="space-y-4 border-t border-slate-100 pt-4">
                  <div class="flex gap-3"><span class="text-emerald-600 font-bold" aria-hidden="true">●</span><div class="min-w-0"><p class="text-xs font-semibold text-slate-500">{{ (offer?.service_slug || job?.service_slug) === 'errand' ? 'Shop / collection' : 'Pickup' }}</p><p class="request-address text-slate-950">{{ offer?.pickup_address || job?.pickup_address || 'Location unavailable' }}</p></div></div>
                  <div class="flex gap-3"><span class="text-amber-600 font-bold" aria-hidden="true">●</span><div class="min-w-0"><p class="text-xs font-semibold text-slate-500">Destination</p><p class="request-address text-slate-950">{{ offer?.dropoff_address || job?.dropoff_address || 'Destination unavailable' }}</p></div></div>
                </div>
                @if (job?.estimated_distance_km || offer?.distance_km) {
                  <p class="text-xs text-slate-500">{{ job?.estimated_distance_km || offer?.distance_km }} km · {{ offer ? 'Distance to pickup' : 'Estimated journey' }}</p>
                }
                @if (job?.errand_details?.items_list?.length) {
                  <div class="rounded-xl bg-slate-50 p-3"><p class="text-xs font-semibold text-slate-500 mb-2">Shopping list</p>
                    @for (item of job!.errand_details!.items_list; track $index) { <p class="text-sm text-slate-800 break-words">• {{ item }}</p> }
                  </div>
                }
                @if (job?.errand_details?.estimated_budget != null) {
                  <p class="text-sm text-slate-600">Shopping budget: <strong>{{ money(job!.errand_details!.estimated_budget!, job!.currency_code) }}</strong></p>
                }
                @if (job?.errand_details?.delivery_instructions) { <p class="text-sm text-slate-600 break-words">{{ job!.errand_details!.delivery_instructions }}</p> }
                @if (feed.occupied()) {
                  <p class="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Finish your current job or negotiation before accepting another request. You can keep browsing.</p>
                }
                @if (feed.error()) { <p role="alert" class="text-sm text-red-700">{{ feed.error() }}</p> }

              </article>
            </section>
                <div slot="fixed" class="request-actions">
                  <button type="button" class="request-pass" (click)="feed.pass()" [disabled]="feed.busy()">
                    {{ feed.passing() ? 'Passing...' : 'Pass' }}
                  </button>
                  <button type="button" (click)="feed.accept()" [disabled]="feed.busy() || feed.occupied()"
                    class="bg-amber-500 text-slate-950">
                    {{ feed.busy() && !feed.passing() ? 'Checking...' : feed.selectedOffer() ? 'Review offer' : 'Accept request' }}
                  </button>
                </div>
          </ion-content>
        </ng-template>
      </ion-modal>
    `
})
export class DriverRequestSheetComponent {
    readonly requestBreakpoint = signal(1);
    footerOffset(): string { return 'calc(var(--request-sheet-height) * ' + Math.max(0, 1 - this.requestBreakpoint()) + ')'; }
    readonly feed = inject(DriverRequestFeedService);
    private config = inject(AppConfigService);
    readonly canDismiss = async (_data?: unknown, role?: string): Promise<boolean> => !this.feed.busy() || !role;
    money(amount: number, currency?: string): string {
        try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || this.config.currencyCode }).format(Number(amount) || 0); }
        catch { return String(amount); }
    }
}
