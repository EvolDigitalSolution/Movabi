import {Component,EventEmitter,Output,OnInit,inject,signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {HttpClient,HttpHeaders} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {ApiUrlService} from '../../core/services/api-url.service';
import {SupabaseService} from '../../core/services/supabase/supabase.service';

@Component({selector:'app-driver-payment-account',standalone:true,imports:[FormsModule],template:`
 @if(active()) {
  <section class="w-full max-w-full overflow-x-hidden rounded-2xl border border-slate-200 bg-white p-5 space-y-4" aria-label="Payment account">
   <header class="space-y-1">
    <h2 class="font-bold">Payment account</h2>
    <p class="text-sm text-slate-600">Add and verify your bank account to receive payouts. No money is moved during setup.</p>
   </header>
   <p role="status" aria-live="polite" class="text-sm text-slate-600">{{busy()?'Working…':message()}}</p>
   @if(error()){<p role="alert" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{{error()}}</p>}
   @if(state()==='completed'){
    <div class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-1">
     <p class="font-semibold text-emerald-800">Bank account verified</p>
     <p class="text-sm text-emerald-700">{{bankName()}} · Account ending {{last4()}}</p>
    </div>
   }
   @if(available() && state()!=='completed' && !reconcileOnly()){
    @if(!opened()){
     <button type="button" class="w-full sm:w-auto rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" (click)="open()" [disabled]="busy()">{{state()==='not_started'?'Set up bank account':'Continue setup'}}</button>
    } @else {
     @if(banks().length===0 && !error()){
      <p class="text-sm text-slate-500">Loading banks…</p>
     }
     <form (ngSubmit)="resolve()" class="space-y-4" autocomplete="off">
      <label class="block space-y-1.5">Bank
       <span class="relative block">
        <select aria-label="Bank" name="bank" [(ngModel)]="bank" (ngModelChange)="clearConfirmation()" required [disabled]="busy() || banks().length===0"
         class="w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 py-2.5 pr-9 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10 disabled:opacity-50">
         <option value="">Select your bank</option>
         @for(b of banks();track b.code){<option [value]="b.code">{{b.name}}</option>}
        </select>
        <svg class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
       </span>
      </label>
      <label class="block space-y-1.5">Account number
       <input aria-label="Account number" name="account" [(ngModel)]="account" (ngModelChange)="clearConfirmation()"
        inputmode="numeric" pattern="[0-9]{10}" maxlength="10" autocomplete="off" required [disabled]="busy()"
        placeholder="Enter 10-digit account number"
        class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10 disabled:opacity-50"
        [attr.aria-invalid]="account.length>0 && account.length<10 ? true : null" />
       <span class="block text-xs text-slate-500">Exactly 10 digits.</span>
      </label>
      <div class="flex flex-col sm:flex-row gap-3">
       <button type="submit" class="w-full sm:w-auto rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" [disabled]="busy() || cooldown() > 0 || !bank || account.length!==10">{{cooldown() > 0 ? 'Wait ' + cooldown() + 's' : 'Check account'}}</button>
      </div>
     </form>
     @if(accountName()){
      <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
       <p class="text-sm"><span class="font-semibold">Account name:</span> {{accountName()}}</p>
       <label class="flex items-start gap-2 text-sm"><input type="checkbox" [(ngModel)]="confirmed" [disabled]="busy()" class="mt-0.5"/> I confirm this account name and bank account for my payment-account destination. Setup does not initiate a payment or transfer.</label>
       <button type="button" class="w-full sm:w-auto rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" (click)="save()" [disabled]="busy()||!confirmed">Confirm bank account</button>
      </div>
     }
    }
   }
   @if(reconcileOnly()){
    <p class="text-sm text-slate-600">Setup has already been submitted. Check its status instead of creating another account.</p>
    <button type="button" class="w-full sm:w-auto rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" (click)="reconcile()" [disabled]="busy()">Check setup status</button>
   }
   <div class="flex flex-col sm:flex-row gap-3">
    <button type="button" class="w-full sm:w-auto rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50" (click)="refresh()" [disabled]="busy()">Refresh status</button>
   </div>
  </section>
 }
`})
export class DriverPaymentAccountComponent implements OnInit {
 @Output() providerChange=new EventEmitter<boolean>();
 @Output() setupCompleted=new EventEmitter<void>();
 private http=inject(HttpClient);private api=inject(ApiUrlService);private supabase=inject(SupabaseService);
 active=signal(false);available=signal(false);state=signal('unavailable');last4=signal('');message=signal('');error=signal('');busy=signal(false);opened=signal(false);
 reconcileOnly=signal(false);accountTypes=signal<string[]>(['bank']);accountType='bank';name='';email='';phone='';
 banks=signal<Array<{code:string;name:string}>>([]);accountName=signal('');bankName=signal('');cooldown=signal(0);bank='';account='';confirmed=false;
 private cooldownTimer:any;
 private startCooldown(seconds:number){this.cooldown.set(Math.max(1,seconds));clearInterval(this.cooldownTimer);this.cooldownTimer=setInterval(()=>{const s=this.cooldown()-1;this.cooldown.set(Math.max(0,s));if(s<=0)clearInterval(this.cooldownTimer);},1000);}
 async ngOnInit(){await this.refresh();}
 private async call(path:string,body?:any):Promise<any>{
  const session=(await this.supabase.auth.getSession()).data.session;
  if(!session)throw Error('Sign in required.');
  const headers=new HttpHeaders({Authorization:'Bearer '+session.access_token});const url=this.api.getApiUrl('/api/driver-payment-account'+path);
  const result=await firstValueFrom(body?this.http.post(url,body,{headers}):this.http.get(url,{headers}));
  if((await this.supabase.auth.getSession()).data.session?.user.id!==session.user.id){this.account='';this.accountName.set('');throw Error('Account changed.');}
  return result;
 }
 private fail(e:any,fallback:string){if(e?.error?.errorCode==='PAYMENT_ACCOUNT_RATE_LIMITED'){this.error.set('Too many account checks. Please wait before trying again.');this.startCooldown(Number(e?.error?.retryAfterSeconds)||30);return;}this.error.set(e?.error?.errorCode==='PAYMENT_ACCOUNT_SETUP_FAILED'?'Setup could not be verified right now. Tap Refresh status to retry, or contact support.':e?.message||fallback);}
 async refresh(){if(this.busy())return;this.busy.set(true);this.error.set('');try{
  const s=await this.call('/status');this.active.set(s.provider!=='stripe');this.providerChange.emit(this.active());
  this.available.set(s.available===true);this.state.set(s.state);this.last4.set(s.last4||'');this.reconcileOnly.set(s.reconcileOnly===true||s.state==='reconciliation_required');this.accountTypes.set(s.accountTypes||['bank']);
  this.message.set(s.state==='unavailable'?'Payment account setup is not available in your market yet.':s.state==='action_required'?'Setup needs review. Check setup status to recover safely.':s.state==='in_progress'?'Setup is in progress. Refresh shortly.':'');
 }catch(e){this.fail(e,'Payment account status is unavailable. Please retry.');}finally{this.busy.set(false);}}
 async open(){if(this.busy())return;this.busy.set(true);this.error.set('');try{this.banks.set((await this.call('/banks')).banks);this.opened.set(true);}catch(e){this.fail(e,'Bank list unavailable. Please retry.');}finally{this.busy.set(false);}}
 clearConfirmation(){this.accountName.set('');this.confirmed=false;}
 async resolve(){if(this.busy())return;this.busy.set(true);this.error.set('');this.clearConfirmation();try{this.accountName.set((await this.call('/resolve',{accountType:this.accountType,bankCode:this.bank,accountNumber:this.account})).accountName);this.bankName.set(this.banks().find(b=>b.code===this.bank)?.name||'');}catch(e){this.fail(e,'Could not verify this account. Check the bank and account number.');}finally{this.busy.set(false);}}
 async reconcile(){if(this.busy())return;this.busy.set(true);this.error.set('');try{const s=await this.call('/reconcile',{});this.state.set(s.state);this.last4.set(s.last4||'');this.reconcileOnly.set(s.reconcileOnly===true);this.message.set(s.state==='completed'?'Payment-account destination verified.':'Setup remains under review. No new account was submitted.');if(s.state==='completed')this.setupCompleted.emit();}catch(e){this.fail(e,'Setup could not be verified. Retry the status check or contact support.');}finally{this.busy.set(false);}}
 async save(){if(this.busy()||!this.confirmed||!this.accountName())return;this.busy.set(true);this.error.set('');try{
  const s=await this.call('/setup',{bankCode:this.bank,accountNumber:this.account,accountName:this.accountName(),confirmed:true});this.state.set(s.state);this.last4.set(s.last4);this.reconcileOnly.set(s.reconcileOnly===true);this.account='';this.clearConfirmation();this.opened.set(false);this.message.set(s.state==='completed'?'Payment-account destination verified.':'Setup remains under review. No new account was submitted.');if(s.state==='completed')this.setupCompleted.emit();
 }catch(e){this.opened.set(false);this.account='';this.clearConfirmation();this.fail(e,'Setup needs reconciliation. Check setup status before any further action.');const shown=this.error();this.busy.set(false);await this.refresh();if(!this.error()&&shown)this.error.set(shown);if(this.state()==='not_started'&&this.available()&&!this.reconcileOnly())this.opened.set(true);}finally{this.busy.set(false);}}
}
