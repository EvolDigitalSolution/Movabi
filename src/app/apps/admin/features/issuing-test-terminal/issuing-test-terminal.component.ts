import { Component, inject, OnInit, signal } from '@angular/core';
import { AuthService } from '@core/services/auth/auth.service';
import { AdminService } from '../../services/admin.service';
@Component({selector:'app-issuing-test-terminal',standalone:true,template:`
<section class="rounded-2xl bg-white border border-slate-200 p-5 space-y-4">
 <header><h3 class="text-lg font-bold text-slate-950">Virtual card test checkout</h3>
 <p class="text-sm text-slate-500 mt-1">Simulate a shop purchase using the assigned Movabi card. The normal authorization webhook and budget controls remain active.</p></header>
 <p class="text-sm font-bold">Stripe mode: {{ context()?.mode || 'Checking…' }}</p>
 @if(context() && !context().simulationEnabled){<p class="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Simulated purchases are disabled. Live cards require a real merchant checkout or terminal. Test mode also requires enabled Issuing and confirmed fail-closed authorization.</p>}
 @if(context()?.simulationEnabled){
 <div class="grid sm:grid-cols-2 gap-3">
  <label class="text-sm font-semibold">Shopping job<select class="mt-1 block w-full rounded-xl border border-slate-200 p-3" [value]="jobId()" (change)="jobId.set($any($event.target).value)" [disabled]="locked()">
   <option value="">Choose an active shopping card</option>
   @for(job of context().jobs;track job.job_id){<option [value]="job.job_id">{{job.job_id.slice(0,8)}} · {{job.currency_code}} · Budget {{job.amount_limit}} · Spent {{job.amount_captured}}</option>}
  </select></label>
  <label class="text-sm font-semibold">Purchase amount<input type="number" min="0.01" max="1000" step="0.01" class="mt-1 block w-full rounded-xl border border-slate-200 p-3" [value]="amount()" (input)="amount.set($any($event.target).value)" [disabled]="locked()"></label>
 </div>
 <p class="text-xs text-slate-500">Currency comes from the selected job. Test funds only. No card number or security code is required.</p>
 <div class="flex flex-wrap gap-3"><button class="rounded-xl bg-amber-500 px-5 py-3 text-sm font-bold disabled:opacity-50" [disabled]="busy() || !jobId() || !!result()" (click)="purchase()">{{busy()?'Processing test purchase…':locked()?'Retry same test purchase':'Authorize & capture test purchase'}}</button>
 <button class="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold" [disabled]="busy()" (click)="reset()">New test purchase</button></div>
 }
 @if(result()){<p role="status" class="rounded-xl bg-slate-50 p-3 text-sm">{{result().captured?'Test purchase captured. Spending updates through Stripe webhooks.':'Purchase declined by the card or budget controls.'}} Reference: {{result().authorizationId}}</p>}
 @if(error()){<p role="alert" class="text-sm text-red-700">{{error()}}</p>}
 <button class="text-sm font-semibold text-slate-600 underline" [disabled]="busy()" (click)="load()">Refresh test cards</button>
</section>`})
export class IssuingTestTerminalComponent implements OnInit {
 private admin=inject(AdminService);
 context=signal<any>(null);jobId=signal('');amount=signal('1.00');busy=signal(false);locked=signal(false);error=signal('');result=signal<any>(null);
 private requestId='';private auth=inject(AuthService);
 private storageKey(){return 'movabi-admin-test-pos-'+(this.auth.currentUser()?.id || 'admin');}
 private save(){try{sessionStorage.setItem(this.storageKey(),JSON.stringify({requestId:this.requestId,jobId:this.jobId(),amount:this.amount(),result:this.result()}));}catch{}}
 ngOnInit(){
  this.requestId=crypto.randomUUID();
  try{const saved=JSON.parse(sessionStorage.getItem(this.storageKey()) || 'null');
   if(saved&&/^[0-9a-f-]{36}$/i.test(saved.requestId)){this.requestId=saved.requestId;this.jobId.set(String(saved.jobId));this.amount.set(String(saved.amount));this.result.set(saved.result || null);this.locked.set(true);}
  }catch{}void this.load();
 }
 async load(){try{this.context.set(await this.admin.issuingTestTerminal());}catch{this.error.set('Stripe is unreachable or your admin session expired. Refresh to try again.');}}
 reset(){try{sessionStorage.removeItem(this.storageKey());}catch{}this.requestId=crypto.randomUUID();this.locked.set(false);this.result.set(null);this.error.set('');void this.load();}
 async purchase(){
  if(this.busy()||!this.context()?.simulationEnabled)return;
  const amount=Number(this.amount());if(!Number.isFinite(amount)||amount<=0||amount>1000){this.error.set('Enter a purchase amount above zero and no more than 1000.');return;}
  this.busy.set(true);this.locked.set(true);this.error.set('');this.save();
  try{this.result.set(await this.admin.issuingTestTerminal('/purchase',{jobId:this.jobId(),amount,requestId:this.requestId}));void this.load();}
  catch(error){this.error.set(error instanceof Error ? error.name==='TimeoutError'?'The response timed out. Retry the same purchase to check its result without creating another charge.':error.message:'Test purchase failed.');}
  finally{this.save();this.busy.set(false);}
 }
}
