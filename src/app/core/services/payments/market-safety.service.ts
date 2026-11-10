import {Injectable,inject,signal,effect} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom,timeout} from 'rxjs';
import {SupabaseService} from '../supabase/supabase.service';
import {ApiUrlService} from '../api-url.service';
import {AuthService} from '../auth/auth.service';
export interface BookingPaymentContext{jobId:string;provider:string|null;quoteState:string;checkoutAvailable:boolean;message:string;}
export interface DriverWalletContext{marketReviewRequired?:boolean;country:string;currency:string;provider:string|null;payoutIntegrationAvailable:boolean;payoutAvailable:boolean;status:string;message:string;}
@Injectable({providedIn:'root'})
export class MarketSafetyService {
 private http=inject(HttpClient);private supabase=inject(SupabaseService);private api=inject(ApiUrlService);private auth=inject(AuthService);
 readonly wallet=signal<DriverWalletContext|null>(null);readonly walletError=signal('');private walletUntil=0;private walletPending:Promise<DriverWalletContext>|null=null;private owner:string|null=null;
 constructor(){effect(()=>{const owner=this.auth.currentUser()?.id||null;if(owner!==this.owner){this.owner=owner;this.wallet.set(null);this.walletError.set('');this.walletUntil=0;this.walletPending=null;}});}
 private async get<T>(path:string):Promise<T>{const {data}=await this.supabase.auth.getSession();const token=data.session?.access_token;if(!token)throw Error('Please sign in again.');return firstValueFrom(this.http.get<T>(this.api.getApiUrl('/api/market-safety/'+path),{headers:{Authorization:'Bearer '+token}}).pipe(timeout(15000)));}
 booking(id:string):Promise<BookingPaymentContext>{return this.get<BookingPaymentContext>('booking/'+encodeURIComponent(id));}
 async refreshWallet(force=false):Promise<DriverWalletContext>{
  if(!force&&this.wallet()&&this.walletUntil>Date.now())return this.wallet()!;
  if(this.walletPending)return this.walletPending;
  const owner=this.auth.currentUser()?.id;
  const request=this.get<DriverWalletContext>('driver-wallet').then(value=>{if(owner!==this.auth.currentUser()?.id)throw Error('Account changed.');this.wallet.set(value);this.walletError.set('');this.walletUntil=Date.now()+30000;return value;}).catch(error=>{if(owner===this.auth.currentUser()?.id){this.wallet.set(null);this.walletError.set('Payout settings could not be verified. Please retry.');}throw error;});
  this.walletPending=request;try{return await request;}finally{if(this.walletPending===request)this.walletPending=null;}
 }
 async requireStripePayoutMarket(){const context=await this.refreshWallet();if(context.provider!=='stripe'||!context.payoutIntegrationAvailable)throw Error(context.message);return context;}
}
