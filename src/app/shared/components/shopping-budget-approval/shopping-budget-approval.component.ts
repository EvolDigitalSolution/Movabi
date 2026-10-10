import { AfterViewInit, Component, ElementRef, Input, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, ModalController } from '@ionic/angular/standalone';
import { StripeCardElement } from '@stripe/stripe-js';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PaymentService } from '../../../core/services/stripe/payment.service';
import { SupabaseService } from '../../../core/services/supabase/supabase.service';
import { ApiUrlService } from '../../../core/services/api-url.service';
@Component({
  selector:'app-shopping-budget-approval',standalone:true,
  imports:[IonHeader,IonToolbar,IonTitle,IonButtons,IonButton,IonContent],
  template:`<ion-header><ion-toolbar><ion-title>Approve shopping budget</ion-title><ion-buttons slot="end"><ion-button [disabled]="busy()" (click)="close()">Close</ion-button></ion-buttons></ion-toolbar></ion-header>
  <ion-content><div class="p-5 space-y-5">
    @if (!walletPayment) { <p>Authorize the revised booking total. Your card is charged when the job is completed, for the service and actual shopping spend.</p>
    <p class="text-sm">Your bank may temporarily show the previous hold alongside the new hold until the previous authorization is released.</p>
    }
    <div [hidden]="walletPayment" #cardHost class="rounded-lg border border-slate-300 bg-white p-4 min-h-12"></div>
    @if (error()) { <p role="alert" class="text-red-700">{{error()}}</p> }
    <ion-button expand="block" [disabled]="busy() || !ready()" (click)="approve()">{{busy() ? 'Authorizing…' : 'Authorize revised budget'}}</ion-button>
  </div></ion-content>`
})
export class ShoppingBudgetApprovalComponent implements AfterViewInit, OnDestroy {
  @Input() jobId='';
  @Input() walletPayment=false;
  @ViewChild('cardHost',{static:true}) host!: ElementRef<HTMLElement>;
  private payment=inject(PaymentService); private db=inject(SupabaseService); private http=inject(HttpClient);
  private api=inject(ApiUrlService); private modalController=inject(ModalController);
  private card:StripeCardElement|null=null; private destroyed=false;
  busy=signal(false); ready=signal(false); error=signal('');
  async ngAfterViewInit() {
    if(this.walletPayment){this.ready.set(true);return;}
    try {
      const stripe=await this.payment.getStripe();
      if(!stripe) throw new Error('Card payment is unavailable');
      if(this.destroyed) return;
      this.card=stripe.elements().create('card'); this.card.mount(this.host.nativeElement);
      this.card.on('change',event=>this.ready.set(event.complete));
    } catch(error) { this.error.set(error instanceof Error?error.message:'Card entry unavailable'); }
  }
  async approve() {
    if(this.busy() || (!this.walletPayment && !this.card)) return;
    this.busy.set(true);this.error.set('');
    try {
      const session=await this.db.auth.getSession(); const token=session.data.session?.access_token;
      if(!token) throw new Error('Please sign in again');
      const headers={Authorization:`Bearer ${token}`};
      const url=this.api.getApiUrl(`/api/issuing/budget/${this.jobId}`);
      const prepared=await firstValueFrom(this.http.post<{approved:boolean;clientSecret:string|null;requestId:string|null}>(`${url}/prepare`,{},{headers}));
      if(!prepared.approved) {
        if(!prepared.clientSecret || !prepared.requestId) throw new Error('Budget authorization is unavailable');
        if(!this.card) throw new Error('Card entry is unavailable');
        await this.payment.confirmPayment(prepared.clientSecret,this.card);
        await firstValueFrom(this.http.post(`${url}/approve`,{requestId:prepared.requestId},{headers}));
      }
      await this.modalController.dismiss({approved:true});
    } catch(error:unknown) {
      const response=error as {error?:{error?:string};message?:string};
      this.error.set(response.error?.error || response.message || 'Budget approval failed. Your previous budget remains available.');
    } finally {this.busy.set(false);}
  }
  close(){void this.modalController.dismiss();}
  ngOnDestroy(){this.destroyed=true;this.card?.destroy();}
}
