import { Component, DestroyRef, Input, OnInit, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { Browser } from '@capacitor/browser';
import { loadStripe, Stripe, StripeCardElement, StripeElements } from '@stripe/stripe-js';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { SupabaseService } from '../../core/services/supabase/supabase.service';
import { ApiUrlService } from '../../core/services/api-url.service';
import { DriverCashCreditService } from '../../core/services/payments/driver-cash-credit.service';
import { AuthService } from '../../core/services/auth/auth.service';
import { driverTopupMinor, driverTopupMoney } from '../utils/driver-topup-money';
import { formatCashCreditMinor } from '../utils/driver-cash-credit';
import {environment} from '@env/environment';

interface Quote { attemptId: string; walletAmountMinor: number; feeMinor: number; totalChargeMinor: number; currency: string; exponent: number; feePolicyVersion: string; feeLabel?:string; provider?:string; }
interface Saved { key: string; amountMinor: number; quote?: Quote; submitted?: boolean; }
@Component({
  selector: 'app-driver-wallet-topup', standalone: true, imports: [FormsModule],
  template: `
  <section class="rounded-2xl border border-slate-200 bg-white p-4 mt-4" aria-label="Driver wallet credit">
    @if (message()) { <p role="status" class="my-3 text-sm text-slate-600">{{message()}}</p> }
    @if (!embedded() && !open() && available() && !saved()?.quote) {
      <button type="button" class="rounded-xl bg-slate-950 text-white px-4 py-3" (click)="open.set(true)">Top up</button>
    }
    @if (open() || saved()?.quote) {
    <div class="mt-2 border-t border-slate-200 pt-3" aria-label="Top up form">
    @if (saved(); as attempt) {
      @if (attempt.quote; as q) {
        <dl class="my-3 text-sm space-y-2">
          <div>Wallet credit: <strong>{{money(q.walletAmountMinor,q)}}</strong></div>
          <div>{{q.feeLabel || "Card/provider fee"}}: <strong>{{money(q.feeMinor,q)}}</strong></div>
          <div>Total charged: <strong>{{money(q.totalChargeMinor,q)}}</strong></div>
        </dl>
        <p class="text-sm my-3">At checkout, pay only {{money(q.totalChargeMinor,q)}}. If the provider shows a different total, return without paying.</p>
        @if (!attempt.submitted || pi()) {
          <label class="block my-3 text-sm"><input type="checkbox" [(ngModel)]="agreed" [disabled]="busy()"> I agree to pay {{money(q.totalChargeMinor,q)}}.</label>
          @if (pi()) {
            <div id="driver-card-element" class="border rounded-xl p-3 my-3 bg-white" aria-label="Card details"></div>
            <button type="button" class="rounded-xl bg-slate-950 text-white px-4 py-3" [disabled]="busy() || payBusy() || !cardReady" (click)="pay(q)">Pay {{money(q.totalChargeMinor,q)}}</button>
          } @else {
          <button type="button" class="rounded-xl bg-slate-950 text-white px-4 py-3" [disabled]="busy() || !agreed" (click)="checkout()">Continue to secure checkout</button>
          }
        }
      }
      @if (attempt.submitted && !pi()) {
        <p class="text-sm my-3">Payment requires server verification. Returning from checkout does not confirm payment.</p>
        <button type="button" class="rounded-xl border p-3" [disabled]="busy()" (click)="verify()">Check payment status</button>
      } @else {
        <button type="button" class="rounded-xl border p-3 ml-2" [disabled]="busy()" (click)="review()">{{attempt.quote ? 'Refresh quote' : 'Recover quote'}}</button>
        <button type="button" class="p-3" [disabled]="busy()" (click)="clear()">Cancel quote</button>
      }
    } @else if (available(); as market) {
      <label class="block mt-3 text-sm">Amount to credit ({{market.currency}}, {{market.exponent}} decimal places)
        <input class="block w-full border rounded-xl p-3 my-2" type="text" inputmode="decimal" autocomplete="off" [(ngModel)]="amount" [disabled]="busy()">
      </label>
      <button type="button" class="rounded-xl bg-slate-950 text-white px-4 py-3" [disabled]="busy()" (click)="review()">Review fee and total</button>
      <button type="button" class="p-3 ml-2" [disabled]="busy()" (click)="close()">Cancel</button>
    }
    </div>
    }
  </section>`
})
export class DriverWalletTopupComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly supabase = inject(SupabaseService);
  private readonly api = inject(ApiUrlService);
  private readonly cash = inject(DriverCashCreditService);
  private readonly destroy = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  readonly available = signal<{currency:string; exponent:number}|null>(null);
  readonly saved = signal<Saved|null>(null);
  readonly busy = signal(false);
  readonly open = signal(false);
  readonly embedded = signal(false);
  readonly pi = signal<string|null>(null);
  readonly payBusy = signal(false);
  cardReady = false;
  private stripe: Stripe | null = null;
  private card: StripeCardElement | null = null;
  @Input() set hideTrigger(v:boolean){this.embedded.set(!!v);}
  readonly message = signal('Checking top-up availability…');
  amount = ''; agreed = false;
  private owner = ''; private storageKey = '';
  constructor() {
    effect(() => {
      if (this.owner && this.auth.currentUser()?.id !== this.owner) {
        this.saved.set(null); this.available.set(null); this.agreed=false;
        this.message.set('Account changed. Reopen the wallet to continue.');
      }
    });
  }
  async ngOnInit() {
    try {
      const {data} = await this.supabase.auth.getSession();
      if (!data.session) throw Error();
      this.owner = data.session.user.id;
      this.storageKey = 'vaydu-driver-topup:' + this.owner;
      const stored = localStorage.getItem(this.storageKey);
      if (stored) this.saved.set(JSON.parse(stored));
      void this.cash.refresh(true).catch(()=>{});
      this.available.set(await this.call('/availability'));
      this.message.set('');
    } catch { this.message.set('Top-up is currently unavailable. Saved payments can still be checked.'); }
    const resume = () => { if (this.saved()?.submitted && !this.pi() && !this.busy()) void this.verify(); };
    window.addEventListener('focus', resume);
    const listener = await App.addListener('appStateChange', state => { if (state.isActive) resume(); });
    this.destroy.onDestroy(() => { window.removeEventListener('focus', resume); void listener.remove(); });
    resume();
  }
  money(value:number,q:Quote) { return driverTopupMoney(value,q.currency,q.exponent); }
  private async call(path:string,body?:unknown):Promise<any> {
    const {data,error} = await this.supabase.auth.getSession();
    if (error || !data.session || data.session.user.id !== this.owner) throw Error('Account changed');
    const sameOrigin=(environment as typeof environment & {driverCardSandboxSameOrigin?:boolean}).driverCardSandboxSameOrigin===true;
    const url = sameOrigin ? new URL('/api/payment/driver-topup'+path,Capacitor.isNativePlatform()?environment.appUrl:window.location.origin).href : this.api.getApiUrl('/api/payment/driver-topup' + path);
    const options = {headers:{Authorization:'Bearer ' + data.session.access_token}};
    const result = await firstValueFrom((body === undefined ? this.http.get(url,options) : this.http.post(url,body,options)).pipe(timeout(25000)));
    const current = await this.supabase.auth.getSession();
    if (current.data.session?.user.id !== this.owner) throw Error('Account changed');
    return result;
  }
  private persist(attempt:Saved) { localStorage.setItem(this.storageKey,JSON.stringify(attempt)); this.saved.set(attempt); }
  private dropCard(){ try{this.card?.unmount();}catch{} this.card=null; this.stripe=null; this.cardReady=false; }
  clear() { localStorage.removeItem(this.storageKey); this.saved.set(null); this.agreed=false; this.pi.set(null); this.dropCard(); }
  close() { this.open.set(false); this.amount=''; this.agreed=false; this.pi.set(null); this.dropCard(); }
  private async mountCard():Promise<void> {
    const secret=this.pi(); if(!secret)return;
    this.stripe=this.stripe||await loadStripe((environment as any).stripePublicKey);
    if(!this.stripe)return;
    const elements:StripeElements=this.stripe.elements();
    this.card=elements.create('card',{hidePostalCode:true});
    const host=document.getElementById('driver-card-element');
    if(!host)return;
    this.card.mount(host);
    this.card.on('ready',()=>{this.cardReady=true;});
  }
  async pay(q:Quote) {
    const secret=this.pi(); const attempt=this.saved(); if(this.agreed!==true||this.busy())return;
    if(this.payBusy()||!secret||!attempt||!this.stripe||!this.card)return;
    this.payBusy.set(true); this.message.set('');
    try {
      const result=await this.stripe.confirmCardPayment(secret,{payment_method:{card:this.card}});
      if(result.paymentIntent?.status==='succeeded'){ this.persist({...attempt,submitted:true}); this.dropCard(); this.pi.set(null); await this.verify(); }
      else this.message.set(result.error?.message||'Payment could not be confirmed. Keep this attempt and check status later.');
    } catch { this.message.set('Payment could not be confirmed. Keep this attempt and check status later.'); }
    finally { this.payBusy.set(false); }
  }
  readonly credit = this.cash.status;
  formatMinor(value:string|number,currency:string):string { return formatCashCreditMinor(String(value),currency); }
  ngOnInitCredit(){ void this.cash.refresh(true).catch(()=>{}); }
  async review() {
    if (this.busy()) return; this.busy.set(true); this.message.set(''); this.agreed=false;
    try {
      let attempt = this.saved();
      if (!attempt) {
        const market = this.available(); if (!market) throw Error();
        attempt = {key:crypto.randomUUID(),amountMinor:driverTopupMinor(this.amount,market.exponent)};
        this.persist(attempt);
      }
      if (attempt.submitted) throw Error();
      const quote = await this.call('/checkout',{amountMinor:attempt.amountMinor,idempotencyKey:attempt.key});
      this.persist({...attempt,submitted:true});
      if (quote.kind !== 'quote' || quote.walletAmountMinor !== attempt.amountMinor || quote.totalChargeMinor !== quote.walletAmountMinor + quote.feeMinor) throw Error();
      this.persist({...attempt,quote});
    } catch { this.message.set('Could not obtain a quote. Check your amount and retry the saved attempt.'); }
    finally { this.busy.set(false); }
  }
  async checkout() {
    const attempt = this.saved();
    if (this.busy() || !this.agreed || !attempt?.quote || attempt.submitted) return;
    this.busy.set(true);
    try {
      // Persist before contact: a lost response must reconcile this same attempt.
      this.persist({...attempt,submitted:true});
      const result = await this.call('/checkout',{amountMinor:attempt.amountMinor,idempotencyKey:attempt.key,confirmedTotalMinor:attempt.quote.totalChargeMinor});
      // In-app Stripe Elements path: a server-issued PaymentIntent clientSecret.
      if (result.kind === 'checkout' && result.attemptId === attempt.quote.attemptId && typeof result.clientSecret === 'string' && result.clientSecret.startsWith('pi_')) {
        this.pi.set(result.clientSecret);
        setTimeout(()=>void this.mountCard(),0);
        return;
      }
      const url = new URL(result.checkoutUrl);
      if (result.kind !== 'checkout' || result.attemptId !== attempt.quote.attemptId || url.protocol !== 'https:' || url.port || url.username || url.password || !((result.provider==='stripe'&&url.hostname==='checkout.stripe.com')||((result.provider==='flutterwave'||result.provider===undefined)&&['checkout.flutterwave.com','ravemodal-dev.flutterwave.com'].includes(url.hostname)))) throw Error();
      if (Capacitor.isNativePlatform()) await Browser.open({url:url.href});
      else window.location.assign(url.href);
    } catch(error:any) {
      if(['PAYMENT_CHECKOUT_TOTAL_MISMATCH','PAYMENT_PREFLIGHT_UNAVAILABLE'].includes(error?.error?.code)){
        this.persist({...attempt,submitted:false});this.agreed=false;
        this.message.set(error?.error?.code==='PAYMENT_CHECKOUT_TOTAL_MISMATCH'?'Provider total differs from your quote. No checkout was submitted. The merchant settings need review.':'Provider check could not be completed. No checkout was submitted; retry this same quote later.');
      }else this.message.set('Checkout outcome is unknown. Check this saved payment; do not start another charge.');
    }
    finally { this.busy.set(false); }
  }
  async verify() {
    const attempt = this.saved(); if (this.busy() || !attempt?.quote) return;
    this.busy.set(true);
    try {
      const result = await this.call('/verify',{attemptId:attempt.quote.attemptId});
      if (typeof result.creditedEventId !== 'string' || !/^[0-9a-f-]{36}$/i.test(result.creditedEventId)) throw Error();
      this.clear();
      this.message.set('Payment verified. Wallet credit added.');
      try { await this.cash.refresh(true); }
      catch { this.message.set('Payment verified. Wallet credit added. Refresh the wallet to check its balance.'); }
    } catch { this.message.set('Payment has not been confirmed. Keep this attempt and check again later.'); }
    finally { this.busy.set(false); }
  }
}
