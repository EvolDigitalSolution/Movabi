import {Component,OnInit,OnDestroy,inject,signal,effect} from '@angular/core';
import {CommonModule} from '@angular/common';
import {Capacitor} from '@capacitor/core';
import {Browser} from '@capacitor/browser';
import {WalletSandboxPlatform,isWalletSandboxLoopback,walletSandboxStorage} from '@shared/utils/wallet-sandbox-platform';
import {AuthService} from '@core/services/auth/auth.service';
import {SupabaseService} from '@core/services/supabase/supabase.service';
import {ApiUrlService} from '@core/services/api-url.service';
import {WalletSandboxClient} from '@shared/utils/wallet-sandbox-client';
@Component({selector:'app-customer-wallet-sandbox',standalone:true,imports:[CommonModule],template:`
 @if(view().visible){
 <section class="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2" aria-label="Sandbox payment test">
  <h2 class="text-sm font-bold text-slate-900">Korapay sandbox test</h2>
  <p class="text-xs text-slate-600">Test only. This does not add money to your wallet.</p>
  @if(manualReturn()){<p class="text-xs text-slate-600">After checkout, return to this Wallet or close the checkout browser to check the result.</p>}
  @if(platformMessage()){<p class="text-sm text-slate-700" role="status">{{platformMessage()}}</p>}
  @if(view().message){<p class="text-sm text-slate-800" role="status">{{view().message}}</p>}
  <div class="flex flex-wrap gap-2">
   @if(view().canStart){<button type="button" class="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm disabled:opacity-50" [disabled]="view().busy" (click)="startCheckout()">Test {{view().amount}}</button>}
   @if(view().status && view().status !== 'verified_test_only' && view().status !== 'failed'){<button type="button" class="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50" [disabled]="view().busy" (click)="client.check()">Check test status</button>}
   <button type="button" class="text-sm underline disabled:opacity-50" [disabled]="view().busy" (click)="client.initialize()">Refresh test</button>
  </div>
 </section>
 }
`})
export class CustomerWalletSandboxComponent implements OnInit,OnDestroy{
 private auth=inject(AuthService);private supabase=inject(SupabaseService);private api=inject(ApiUrlService);
 view=signal<any>({visible:false});platformMessage=signal('');
 manualReturn=()=>Capacitor.isNativePlatform()||this.isLocal();
 private isLocal(){return isWalletSandboxLoopback(window.location.origin);}
 private readonly platform=new WalletSandboxPlatform({native:()=>Capacitor.isNativePlatform(),origin:()=>window.location.origin,openPopup:()=>window.open('about:blank','_blank'),openNative:async url=>{await Browser.open({url,windowName:'_blank'});},navigate:url=>window.location.assign(url),addFocus:fn=>window.addEventListener('focus',fn),removeFocus:fn=>window.removeEventListener('focus',fn),listenFinished:fn=>Browser.addListener('browserFinished',fn)},()=>{void this.client.initialize();});
 readonly client=new WalletSandboxClient({
  native:()=>Capacitor.isNativePlatform(),origin:()=>window.location.origin,owner:()=>this.auth.currentUser()?.id||null,
  request:async(path,method,body,owner)=>{const {data,error}=await this.supabase.client.auth.getSession();const session=data.session;if(error||!session||session.user.id!==owner||this.auth.currentUser()?.id!==owner||!session.access_token)throw Error('Sign in required');
   const response=await fetch(this.api.getApiUrl('/api/wallet')+path,{method,headers:{Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000),cache:'no-store'});if(!response.ok)throw Error('Sandbox request unavailable');return response.json();},
  load:k=>walletSandboxStorage(Capacitor.isNativePlatform(),window.location.origin,sessionStorage,localStorage).load(k),save:(k,v)=>walletSandboxStorage(Capacitor.isNativePlatform(),window.location.origin,sessionStorage,localStorage).save(k,v),remove:k=>walletSandboxStorage(Capacitor.isNativePlatform(),window.location.origin,sessionStorage,localStorage).remove(k),id:()=>crypto.randomUUID(),
  returnReference:()=>new URL(window.location.href).searchParams.get('reference'),
  clearReturnReference:()=>{const u=new URL(window.location.href);u.searchParams.delete('reference');history.replaceState(history.state,'',u.href);},
  redirect:url=>this.platform.redirect(url),changed:s=>this.view.set(s)
 });
 constructor(){effect(()=>{this.auth.currentUser();if(this.client.resetOwner())void this.client.initialize();});}
 async startCheckout(){this.platformMessage.set('');try{this.platform.prepare();await this.client.start();}catch{this.platformMessage.set('Allow pop-ups to open the sandbox checkout, then try again.');}finally{this.platform.cleanupPopup();}}
 ngOnInit(){this.platform.start();void this.client.initialize();}
 ngOnDestroy(){this.platform.stop();this.client.dispose();}
}
