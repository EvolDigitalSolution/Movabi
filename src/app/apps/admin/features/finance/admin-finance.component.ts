import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { AdminService } from '../../services/admin.service';
import type { FinanceBooking, FinancePayout, FinanceReport } from '@shared/models/admin-finance.model';

type Metric = 'customerPayments' | 'commission' | 'platformFee' | 'platformIncome' | 'driverEarnings' | 'serviceRefunds';
@Component({
 selector: 'app-admin-finance', standalone: true, imports: [CommonModule, IonicModule],
 template: `
 <section id="daily-finance" class="rounded-2xl bg-white border border-slate-100 p-4 sm:p-5 space-y-4">
   <div><h3 class="text-lg font-bold text-slate-950">Daily financial report</h3>
     <p class="text-xs text-slate-500 mt-1">Completed bookings by completion date. Each currency is reported separately. Figures are gross before processing costs and refunds.</p></div>
   <div class="flex flex-wrap items-end gap-3">
     <label class="text-xs font-semibold text-slate-600">Date<input type="date" [value]="date()" (change)="date.set($any($event.target).value); load()" class="block mt-1 border border-slate-200 rounded-lg px-3 py-2"></label>
     <label class="text-xs font-semibold text-slate-600">Reporting timezone<input aria-label="Reporting timezone" [value]="timezone()" (change)="timezone.set($any($event.target).value); load()" list="finance-timezones" class="block mt-1 border border-slate-200 rounded-lg px-3 py-2"></label>
     <datalist id="finance-timezones"><option value="Europe/London"></option><option value="Africa/Lagos"></option><option value="Asia/Dubai"></option><option value="America/New_York"></option><option value="UTC"></option></datalist>
     <label class="text-xs font-semibold text-slate-600">Region<select [value]="country()" (change)="country.set($any($event.target).value)" class="block mt-1 border border-slate-200 rounded-lg px-3 py-2"><option value="all">All regions</option>@for (c of countries(); track c) {<option [value]="c">{{ c }}</option>}</select></label>
     <button type="button" (click)="load()" [disabled]="loading()" class="rounded-lg px-3 py-2 bg-blue-50 text-blue-700 text-xs font-bold disabled:opacity-50">Refresh</button>
   </div>
   @if (loading()) {<p role="status" class="text-sm text-slate-500">Loading financial report…</p>}
   @else if (error()) {<p role="alert" class="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{{ error() }}</p>}
   @else if (report()) {
     @if (report()?.undatedCompletedCount) {<p role="alert" class="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">{{ report()?.undatedCompletedCount }} completed bookings across all regions have no completion date and cannot be included in daily totals. They require review.</p>}
     @if (invalidCount()) {<p role="alert" class="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">{{ invalidCount() }} bookings have incomplete or inconsistent financial splits. Their amounts are excluded from totals; open the booking list below to review them.</p>}
     @for (currency of currencies(); track currency) {
       <div class="space-y-3"><h4 class="text-sm font-bold text-slate-700">{{ currency }} · {{ country() === 'all' ? 'All regions' : country() }}</h4>
         <div class="grid grid-cols-2 lg:grid-cols-3 gap-3">
           @for (m of metrics; track m.key) {
             <button type="button" (click)="openMetric(currency, m.key, m.label)" class="rounded-xl border border-slate-200 p-3 text-left hover:bg-blue-50 focus-visible:outline-blue-600">
               <span class="block text-[11px] font-semibold text-slate-500">{{ m.label }}</span><span class="block text-lg font-bold mt-1 text-slate-950">{{ money(sum(currency, m.key), currency) }}</span><span class="block text-[10px] text-blue-700 mt-1">View bookings by region</span>
             </button>
           }
         </div>
       </div>
     } @empty {<p class="text-sm text-slate-500">No completed bookings for this date and region.</p>}
     <div class="border-t border-slate-100 pt-3">
       <h4 class="text-sm font-bold text-slate-900">Outstanding driver transfers · all dates</h4><p class="text-xs text-slate-500 mt-1">Pending, processing, reconciliation and blocked payouts. These are not confirmed transfers or bank payouts.</p>
       <div class="flex flex-wrap gap-3 mt-3">@for (currency of payoutCurrencies(); track currency) {<button type="button" (click)="openPayout(currency)" class="rounded-xl bg-amber-50 border border-amber-100 px-4 py-3 text-left"><span class="block text-sm font-bold">{{ money(payoutTotal(currency), currency) }}</span><span class="text-xs text-amber-800">{{ currency }} · View transfer queue</span></button>} @empty {<p class="text-xs text-slate-500">No outstanding transfers in this region.</p>}</div>
     </div>
     <button type="button" (click)="openAll()" class="text-xs font-bold text-blue-700">Review all {{ bookings().length }} completed bookings</button>
     <p class="text-[10px] text-slate-400">Report generated {{ report()?.generatedAt | date:'medium' }}. Customer payments are booked fares, not a live Stripe balance. Shopping budgets are excluded. Profit is unavailable until processing costs and refund allocation are reconciled.</p>
   }
 </section>
 <ion-modal [isOpen]="detail() !== null" (didDismiss)="detail.set(null)" class="finance-modal" aria-labelledby="finance-detail-title"><ng-template>
   <ion-header><ion-toolbar><ion-title id="finance-detail-title">{{ detail()?.label }}</ion-title><ion-buttons slot="end"><ion-button (click)="detail.set(null)">Close</ion-button></ion-buttons></ion-toolbar></ion-header>
   <ion-content><div class="p-4 space-y-4">
     <p class="text-xs text-slate-500">{{ date() }} · {{ timezone() }} · {{ detail()?.currency || 'All currencies' }}</p>
     @if (detail()?.payout) {
       <div class="overflow-x-auto"><table class="w-full min-w-[650px] text-xs text-left"><thead><tr class="bg-slate-50"><th class="p-2">Booking</th><th class="p-2">Region</th><th class="p-2">Amount</th><th class="p-2">Status</th><th class="p-2">Reason</th></tr></thead><tbody>@for (p of detailPayouts(); track p.id) {<tr class="border-b border-slate-100"><td class="p-2 font-mono break-all">{{ p.id }}</td><td class="p-2">{{ p.country }}</td><td class="p-2 whitespace-nowrap">{{ money(p.amount, p.currency) }}</td><td class="p-2">{{ p.status }}</td><td class="p-2">{{ p.error || 'Awaiting processing' }}</td></tr>}</tbody></table></div>
     } @else {
       <div class="overflow-x-auto"><table class="w-full min-w-[950px] text-xs text-left"><thead><tr class="bg-slate-50"><th class="p-2">Booking / region</th><th class="p-2">Payment</th><th class="p-2">Fare</th><th class="p-2">Commission</th><th class="p-2">Platform fee</th><th class="p-2">Driver earnings</th><th class="p-2">Service refunds</th><th class="p-2">Transfer</th></tr></thead><tbody>@for (b of detailBookings(); track b.id) {<tr class="border-b border-slate-100"><td class="p-2"><span class="font-mono">{{ b.id }}</span><p>{{ b.country }} · {{ b.currency }}</p><p>{{ completionTime(b.completedAt) }}</p>@if (!b.splitValid) {<p class="text-rose-700 font-bold">Split requires review</p>}</td><td class="p-2">{{ b.paymentMethod }} · {{ b.paymentStatus }}</td><td class="p-2">{{ money(b.customerPayments,b.currency) }}</td><td class="p-2">{{ money(b.commission,b.currency) }}</td><td class="p-2">{{ money(b.platformFee,b.currency) }}</td><td class="p-2">{{ money(b.driverEarnings,b.currency) }}</td><td class="p-2">{{ money(b.serviceRefunds,b.currency) }}</td><td class="p-2">{{ b.transferStatus }}<p class="break-all">{{ b.transferId || 'No confirmed transfer' }}</p></td></tr>}</tbody></table></div>
     }
     <div class="flex justify-between items-center text-xs"><button type="button" [disabled]="detailPage() <= 1" (click)="detailPage.set(detailPage()-1)" class="p-2 rounded-lg border disabled:opacity-40">Previous</button><span>Page {{ detailPage() }} of {{ detailPages() }}</span><button type="button" [disabled]="detailPage() >= detailPages()" (click)="detailPage.set(detailPage()+1)" class="p-2 rounded-lg border disabled:opacity-40">Next</button></div>
   </div></ion-content>
 </ng-template></ion-modal>
 `,
 styles: [`ion-modal.finance-modal { --width: min(96vw, 1100px); --height: 85vh; --border-radius: 1rem; }`]
})
export class AdminFinanceComponent implements OnInit {
 private admin = inject(AdminService);
 report = signal<FinanceReport | null>(null); loading = signal(false); error = signal<string | null>(null);
 timezone = signal('Europe/London'); date = signal(this.localDate()); country = signal('all');
 detail = signal<{ currency: string; key?: Metric; label: string; payout: boolean } | null>(null); detailPage = signal(1);
 metrics: { key: Metric; label: string }[] = [
  {key:'customerPayments',label:'Completed booking fares'}, {key:'commission',label:'Driver commission'}, {key:'platformFee',label:'Customer platform fees'},
  {key:'platformIncome',label:'Platform income before costs'}, {key:'driverEarnings',label:'Driver earnings'}, {key:'serviceRefunds',label:'Recorded service refunds'}
 ];
 countries = computed(() => [...new Set([...(this.report()?.bookings || []).map(b=>b.country),...(this.report()?.outstandingPayouts || []).map(p=>p.country)])].sort());
 bookings = computed(() => (this.report()?.bookings || []).filter(b=>this.country()==='all'||b.country===this.country()));
 payouts = computed(() => (this.report()?.outstandingPayouts || []).filter(p=>this.country()==='all'||p.country===this.country()));
 currencies = computed(() => [...new Set(this.bookings().map(b=>b.currency))].sort());
 payoutCurrencies = computed(() => [...new Set(this.payouts().map(p=>p.currency))].sort());
 invalidCount = computed(() => this.bookings().filter(b=>!b.splitValid).length);
 selectedBookings = computed(() => this.bookings().filter(b=>!this.detail()?.currency||b.currency===this.detail()?.currency));
 selectedPayouts = computed(() => this.payouts().filter(p=>p.currency===this.detail()?.currency));
 detailPages = computed(() => Math.max(1,Math.ceil((this.detail()?.payout?this.selectedPayouts():this.selectedBookings()).length/25)));
 detailBookings = computed(() => this.selectedBookings().slice((this.detailPage()-1)*25,this.detailPage()*25));
 detailPayouts = computed(() => this.selectedPayouts().slice((this.detailPage()-1)*25,this.detailPage()*25));
 private sequence=0;
 completionTime(value:string){return new Intl.DateTimeFormat('en-GB',{timeZone:this.timezone(),dateStyle:'short',timeStyle:'short'}).format(new Date(value));}
 ngOnInit(){void this.load();}
 private localDate(){const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return `${p.find(x=>x.type==='year')?.value}-${p.find(x=>x.type==='month')?.value}-${p.find(x=>x.type==='day')?.value}`;}
 async load(){const id=++this.sequence;this.loading.set(true);this.error.set(null);this.report.set(null);this.detail.set(null);try{const report=await this.admin.getDailyFinance(this.date(),this.timezone());if(id===this.sequence){this.report.set(report);if(this.country()!=='all'&&!this.countries().includes(this.country()))this.country.set('all');}}catch(e){if(id===this.sequence)this.error.set(e instanceof Error?e.message:'Financial report unavailable');}finally{if(id===this.sequence)this.loading.set(false);}}
 private factor(currency:string){return 10 ** (currency==='UNKNOWN'?2:new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits!);}
 sum(currency:string,key:Metric){const factor=this.factor(currency);return this.bookings().filter(b=>b.currency===currency&&b.splitValid).reduce((n,b)=>n+Math.round(b[key]*factor),0)/factor;}
 payoutTotal(currency:string){const factor=this.factor(currency);return this.payouts().filter(p=>p.currency===currency).reduce((n,p)=>n+Math.round(p.amount*factor),0)/factor;}
 money(value:number,currency:string){return currency==='UNKNOWN'?`${value.toFixed(2)} (currency unknown)`:new Intl.NumberFormat('en-GB',{style:'currency',currency,currencyDisplay:'code'}).format(value);}
 openMetric(currency:string,key:Metric,label:string){this.detailPage.set(1);this.detail.set({currency,key,label,payout:false});}
 openPayout(currency:string){this.detailPage.set(1);this.detail.set({currency,label:'Outstanding driver transfers · all dates',payout:true});}
 openAll(){this.detailPage.set(1);this.detail.set({currency:'',label:'Completed booking financial details',payout:false});}
}
