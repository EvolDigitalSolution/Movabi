import { Component, Input, OnChanges, OnDestroy, inject, signal } from '@angular/core';
import { DriverService } from '@core/services/driver/driver.service';
@Component({
  selector:'app-driver-earnings-preview', standalone:true,
  template:`<div class="rounded-xl bg-slate-50 p-3 text-sm" aria-live="polite">
    @if (preview(); as p) {
      <div class="flex justify-between gap-3"><span>Total</span><strong>{{ money(p.gross,p.currency) }}</strong></div>
      <div class="mt-2 flex justify-between gap-3"><span>Commission</span><strong>{{ p.deductions > 0 ? '- ' : '' }}{{ money(p.deductions,p.currency) }}</strong></div>
      <div class="mt-3 flex justify-between items-center gap-3 border-t border-slate-200 pt-3"><span class="font-bold text-slate-950">Driver earnings</span><strong class="text-2xl text-slate-950">{{ money(p.net,p.currency) }}</strong></div>
      @if (p.offerAllowed === false) {
        <p class="mt-3 rounded-lg bg-amber-50 p-2 text-xs font-semibold text-amber-900" role="status">This customer offer must increase before agreement.
          @if (p.suggestedCustomerFare) { Suggested valid customer fare: {{ money(p.suggestedCustomerFare,p.currency) }}. }</p>
      }
      @if (p.estimated) { <p class="mt-2 text-xs text-slate-500">Estimate. Finalised on assignment.</p> }
    } @else {
      <p class="font-semibold text-slate-700">{{ loading() ? 'Checking your earnings…' : errorMessage() }}</p>
      @if (!loading()) { <button type="button" class="mt-2 underline font-bold" (click)="refresh()">Retry earnings preview</button> }
    }
  </div>`
})
export class DriverEarningsPreviewComponent implements OnChanges, OnDestroy {
  @Input() jobId: string | null | undefined;
  @Input() amount: number | null | undefined;
  private driver=inject(DriverService);
  preview=signal<{gross:number;net:number;deductions:number;currency:string;estimated:boolean;offerAllowed?:boolean;suggestedCustomerFare?:number}|null>(null);
  loading=signal(false);
  errorMessage=signal('Earnings preview unavailable');
  private revision=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  ngOnChanges():void { this.refresh(); }
  refresh():void {
    const revision=++this.revision;
    if(this.timer)clearTimeout(this.timer);
    this.preview.set(null);
    this.errorMessage.set('Earnings preview unavailable');
    const id=this.jobId, amount=this.amount == null ? undefined : Number(this.amount);
    if(!id || (amount !== undefined && (!Number.isFinite(amount)||amount<=0))){this.loading.set(false);return;}
    this.loading.set(true);
    this.timer=setTimeout(()=>{void this.driver.previewEarnings(id,amount).then(p=>{
      if(revision===this.revision)this.preview.set(p);
    }).catch(error=>{
      if(revision!==this.revision)return;
      const code=error?.error?.code;
      if(code==='FARE_BELOW_MINIMUM')this.errorMessage.set('This offer is below the protected minimum. Review or increase the offer.');
      else if(code==='REQUEST_UNAVAILABLE')this.errorMessage.set('This request is no longer available.');
    }).finally(()=>{if(revision===this.revision)this.loading.set(false);});},250);
  }
  ngOnDestroy():void {++this.revision;if(this.timer)clearTimeout(this.timer);}
  money(n:number,currency:string):string { return new Intl.NumberFormat('en-GB',{style:'currency',currency:currency||'GBP'}).format(n); }
}
