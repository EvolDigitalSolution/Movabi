import {Component,inject,computed,signal,OnInit} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom,timeout} from 'rxjs';
import {SupabaseService} from '@core/services/supabase/supabase.service';
import {ApiUrlService} from '@core/services/api-url.service';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {IonHeader,IonToolbar,IonTitle,IonContent,IonButtons,IonBackButton,IonIcon,IonList,IonItem,IonLabel,IonNote,IonRefresher,IonRefresherContent} from '@ionic/angular/standalone';
import {addIcons} from 'ionicons';
import {receiptOutline} from 'ionicons/icons';
import {RouterLink} from '@angular/router';
import {DriverWalletTopupComponent} from '@shared/ui/driver-wallet-topup.component';
import {DriverCashCreditService} from '@core/services/payments/driver-cash-credit.service';
import {formatCashCreditMinor} from '@shared/utils/driver-cash-credit';

interface CashCreditAttempt {id:string;status:string;amount_minor:number;currency_code:string;created_at:string;credited_event_id:string|null;state:string;}

// Driver wallet follows the customer "My Wallet" template. The top-up credits
// CASH-RIDE credit (driver_cash_credit purpose) — labelled as such; it is not
// the ordinary wallet balance and is never merged with driver earnings.
@Component({
  selector:'app-driver-wallet',
  standalone:true,
  imports:[CommonModule,FormsModule,RouterLink,DriverWalletTopupComponent,IonHeader,IonToolbar,IonTitle,IonContent,IonButtons,IonBackButton,IonIcon,IonList,IonItem,IonLabel,IonNote,IonRefresher,IonRefresherContent],
  template:`
  <ion-header>
    <ion-toolbar>
      <ion-buttons slot="start"><ion-back-button defaultHref="/driver"></ion-back-button></ion-buttons>
      <ion-title>My Wallet</ion-title>
    </ion-toolbar>
  </ion-header>

  <ion-content class="ion-padding">
    <ion-refresher slot="fixed" (ionRefresh)="handleRefresh($event)">
      <ion-refresher-content></ion-refresher-content>
    </ion-refresher>

    <div class="relative mb-6 overflow-hidden rounded-[2rem] bg-white px-6 py-8 text-center shadow-lg shadow-slate-900/10 border border-slate-200">
      <div class="absolute inset-x-0 top-0 h-1.5 bg-blue-600"></div>
      <p class="relative text-slate-600 text-sm font-black mb-3">Cash-ride credit</p>
      @if (credit(); as c) {
        <h1 class="relative text-slate-950 font-display font-black tracking-tight break-words text-5xl">{{amount(c.balance.availableMinor,c.currency)}}</h1>
        <p class="mt-2 text-xs font-semibold text-slate-500">{{c.currency}} · usable for cash rides · Held: {{amount(c.balance.heldMinor,c.currency)}}</p>
      } @else {
        <h1 class="relative text-slate-950 font-display font-black tracking-tight break-words text-lg">{{creditLabel()}}</h1>
      }
      <div class="relative mt-4 flex justify-center gap-3">
        <button type="button" class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold" [disabled]="cash.loading()" (click)="refreshCredit()">Refresh</button>
        <button type="button" class="rounded-xl bg-slate-950 text-white px-4 py-2 text-sm font-bold" [disabled]="!credit()" (click)="topupRef.open.set(true)">Top up</button>
      </div>
      <app-driver-wallet-topup #topupRef [hideTrigger]="true" />
    </div>

    <div class="space-y-6">
      <div class="mt-8">
        <h2 class="text-lg font-bold mb-4">Transaction History</h2>
        <ion-list class="bg-transparent">
          @if (txLoading()) {
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 text-sm text-slate-500">Loading activity…</div>
          } @else if (txError()) {
            <p role="alert" class="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 text-sm text-red-700">{{txError()}}</p>
          } @else {
          @for (tx of transactions(); track txId(tx)) {
            <ion-item lines="full" class="bg-white rounded-xl mb-2 overflow-hidden">
              <ion-label>
                <div class="flex justify-between items-center mb-1 gap-3">
                  <span class="font-bold text-slate-900 truncate">{{txLabel(tx)}}</span>
                  <span class="shrink-0 text-emerald-600 font-bold">+{{txAmount(tx)}}</span>
                </div>
                <div class="flex justify-between items-center gap-3">
                  <ion-note class="text-xs">{{txDate(tx) | date:'medium'}}</ion-note>
                  <ion-note class="text-[10px] uppercase tracking-tighter">{{txState(tx)}}</ion-note>
                </div>
              </ion-label>
            </ion-item>
          } @empty {
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 flex items-center justify-center shrink-0">
                <ion-icon name="receipt-outline" class="text-xl"></ion-icon>
              </div>
              <div class="min-w-0">
                <p class="text-sm font-black text-slate-900">No transactions yet</p>
                <p class="text-xs font-semibold text-slate-500 truncate">Verified top-ups will appear here.</p>
              </div>
            </div>
          }
          }
        </ion-list>
      </div>
    </div>
  </ion-content>
  `
})
export class DriverWalletPage implements OnInit {
  readonly cash=inject(DriverCashCreditService);
  private readonly http=inject(HttpClient);
  private readonly supabase=inject(SupabaseService);
  private readonly api=inject(ApiUrlService);
  readonly txLoading=signal(false);
  readonly txError=signal('');
  private readonly owner=signal<string>('');
  private readonly storedTx=signal<Record<string,unknown>[]>([]);
  readonly transactions=computed(()=>this.owner()?this.storedTx():[]);
  constructor(){addIcons({receiptOutline});}
  credit=computed(()=>this.cash.status());
  amount(v:string|number,c:string){return formatCashCreditMinor(String(v),c);}
  creditLabel(){
    if(this.cash.loading())return 'Checking credit…';
    return this.cash.error()||'Cash-ride credit could not be loaded yet.';
  }
  ngOnInit(){void this.refresh();}
  private async refresh(){
    this.txLoading.set(true);this.txError.set('');
    try{
      const {data,error}=await this.supabase.auth.getSession();
      if(error||!data.session?.access_token)throw Error('Sign in required.');
      this.owner.set(data.session.user.id);
      const res=await firstValueFrom(this.http.get<{attempts?:CashCreditAttempt[]}>(this.api.getApiUrl('/api/market-safety/driver-cash-credit/activity'),{headers:{Authorization:'Bearer '+data.session.access_token}}).pipe(timeout(15000)));
      this.storedTx.set(Array.isArray(res?.attempts)?res.attempts as unknown as Record<string,unknown>[]:[]);
    }catch{ this.storedTx.set([]);this.txError.set('Activity could not be loaded. Pull to refresh.'); }
    finally{this.txLoading.set(false);}
  }
  refreshCredit(){void Promise.all([this.cash.refresh(true),this.refresh()]).catch(()=>{});}
  async handleRefresh(ev:any){try{await Promise.all([this.cash.refresh(true),this.refresh()]);}catch{}ev?.target?.complete?.();}
  txId(tx:Record<string,unknown>):string{return String(tx['id']);}
  txState(tx:Record<string,unknown>):string{return String(tx['state']||tx['status']);}
  txDate(tx:Record<string,unknown>):string{return String(tx['created_at']);}
  txLabel(tx:Record<string,unknown>):string{return 'Cash-ride credit top-up';}
  txAmount(tx:Record<string,unknown>):string{
    return formatCashCreditMinor(String(tx['amount_minor']??0),String(tx['currency_code']||'GBP'));
  }
}
