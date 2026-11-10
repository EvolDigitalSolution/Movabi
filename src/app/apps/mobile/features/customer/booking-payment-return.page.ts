import {Component,inject,signal} from '@angular/core';
import {ActivatedRoute,RouterLink} from '@angular/router';
import {HttpClient,HttpHeaders} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {ApiUrlService} from '@core/services/api-url.service';
import {SupabaseService} from '@core/services/supabase/supabase.service';
@Component({standalone:true,imports:[RouterLink],template:`
 <main class="min-h-screen bg-slate-50 p-6 flex items-center justify-center">
  <section class="bg-white rounded-2xl border border-slate-200 p-6 max-w-md space-y-4" aria-label="Booking payment status">
   <h1 class="text-xl font-bold">Booking payment</h1>
   <p role="status">{{message()}}</p>
   @if(jobId){<button type="button" class="block bg-slate-950 text-white rounded-xl p-3 w-full" [disabled]="busy()" (click)="verify()">Check payment status</button>
    <a class="block border rounded-xl p-3 text-center" [routerLink]="['/customer/tracking',jobId]">Return to booking</a>}
   <a class="block text-center" routerLink="/auth/login">Sign in</a>
  </section>
 </main>
`})
export class BookingPaymentReturnPage {
 private route=inject(ActivatedRoute);private http=inject(HttpClient);private api=inject(ApiUrlService);private auth=inject(SupabaseService);
 // A callback reference identifies a candidate booking only. Status/amount/query transaction IDs are never evidence of payment.
 readonly jobId=/^vaydu-split-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(this.route.snapshot.queryParamMap.get('tx_ref')||'')?.[1]||null;
 busy=signal(false);message=signal('Payment has not been verified. Sign in and check the booking status.');
 async verify(){
  if(this.busy()||!this.jobId)return;this.busy.set(true);
  try{
   const session=(await this.auth.auth.getSession()).data.session;if(!session)throw Error('Sign in required.');
   const headers=new HttpHeaders({Authorization:'Bearer '+session.access_token});
   const result:any=await firstValueFrom(this.http.post(this.api.getApiUrl('/api/payment/flutterwave-booking-split/verify'),{jobId:this.jobId},{headers}));
   if((await this.auth.auth.getSession()).data.session?.user.id!==session.user.id||result.paymentVerified!==true)throw Error('Unverified payment.');
   this.message.set(result.driverSettlement==='settled'?'Payment and settlement verified.':'Payment verified. Driver settlement is still pending confirmation.');
  }catch{this.message.set('Payment is not confirmed. Sign in to the owning customer account and retry; do not pay again while verification is pending.');}
  finally{this.busy.set(false);}
 }
}
