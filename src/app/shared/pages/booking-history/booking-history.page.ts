import { CommunicationService } from '../../../core/services/communication/communication.service';
import { AuthService } from '../../../core/services/auth/auth.service';
import {Component,inject,signal,computed,OnInit} from '@angular/core';
import {CommonModule} from '@angular/common';
import {IonicModule} from '@ionic/angular';
import {ActivatedRoute,Router} from '@angular/router';
import {BookingHelpService,BookingSupportCategory} from '../../../core/services/support/booking-help.service';
import {formatHistoryMoney,historyPaymentSummary,historyStatusLabel} from '../../utils/booking-history-presentation';
@Component({selector:'app-booking-history',standalone:true,imports:[CommonModule,IonicModule],template:`
<ion-header class="ion-no-border"><ion-toolbar><ion-buttons slot="start"><ion-back-button [defaultHref]="backUrl()"></ion-back-button></ion-buttons><ion-title>Booking record</ion-title></ion-toolbar></ion-header>
<ion-content><main class="booking-record">
 @if(loading()){<p role="status">Loading booking…</p>}
 @if(error()){<section role="alert"><p>{{error()}}</p><button type="button" (click)="load()">Try again</button></section>}
 @if(record();as r){
 <section><p class="eyebrow">{{r.serviceName}}</p><h1>{{statusLabel(r.status)}}</h1><p>{{r.createdAt | date:'medium'}}</p><p class="reference">Booking reference: {{r.id}}</p>
 @if(!r.terminal){<button type="button" (click)="continueBooking()">Continue active booking</button>}
 </section>
 <section><h2>Journey details</h2><dl><dt>Pickup / collection</dt><dd>{{r.pickupAddress || 'Not recorded'}}</dd><dt>Destination</dt><dd>{{r.dropoffAddress || 'Not recorded'}}</dd>
 @if(r.driverName){<dt>Driver</dt><dd>{{r.driverName}}</dd>}
 @if(r.completedAt){<dt>Completed</dt><dd>{{r.completedAt | date:'medium'}}</dd>}
 @if(r.cancelledAt){<dt>Cancelled</dt><dd>{{r.cancelledAt | date:'medium'}}</dd>}
 @if(r.cancellationReason){<dt>Cancellation reason</dt><dd>{{r.cancellationReason}}</dd>}
 </dl><p class="muted">This is the recorded journey. Live driver location is not tracked here.</p></section>
 <section><h2>{{r.viewer==='driver'?'Payment & earnings':'Payment & receipt'}}</h2><h3>{{payment().label}}</h3><p>{{payment().detail}}</p>
 @if(payment().amount!==null){<p class="amount">{{money(payment().amount,r.currency)}}</p>}
 @if(payment().amount===null && r.receipt.verified && r.receipt.status==='succeeded'){<p>Original captured payment: {{money(r.receipt.amount,r.currency)}}</p>}
 @if(r.refundedAmount>0){<p>Recorded refund: {{money(r.refundedAmount,r.currency)}}</p>}
 <dl><dt>Agreed service fare</dt><dd>{{money(r.serviceFare,r.currency)}}</dd>
 @if(r.shoppingBudget>0){<dt>Approved shopping budget</dt><dd>{{money(r.shoppingBudget,r.currency)}}<span class="muted">Budget allowance; actual captured spending may be lower.</span></dd>}
 @if(r.platformFee!==null){<dt>Platform fee included in service fare</dt><dd>{{money(r.platformFee,r.currency)}}</dd>}
 @if(r.viewer==='driver'){<dt>Driver commission</dt><dd>{{money(r.driverCommission,r.currency)}}</dd><dt>Driver earnings</dt><dd>{{money(r.driverEarnings,r.currency)}}</dd><dt>Connect transfer</dt><dd>{{transferLabel(r.transferStatus)}}</dd>}
 </dl>
 @if(r.receipt.verified && r.receipt.status==='succeeded'){<button type="button" (click)="printReceipt()">Print / save receipt</button>}
 </section>
 @if(r.rating){<section><h2>Your rating</h2><p>{{r.rating.score}} / 5</p><p>{{r.rating.comment}}</p></section>}
 <section><h2>Saved messages</h2><p class="muted">Past messages are read-only. Use Get help or Report a lost item to start a new request.</p><button type="button" (click)="loadMessages()" [disabled]="messagesLoading()">{{messagesLoading()?'Loading messages…':'View saved messages'}}</button>
 @if(messagesError()){<p role="alert">{{messagesError()}}</p>}
 @if(messagesLoaded() && messages().length===0){<p>No saved messages.</p>}
 @for(message of messages();track message.id){<div class="saved-message"><strong>{{message.sender_id===userId()?'You':'Other participant'}}</strong><p>{{message.message}}</p><small>{{message.created_at | date:'medium'}}</small></div>}
 </section>
 <section class="actions"><h2>Help with this booking</h2><button type="button" (click)="help('help')">Get help</button><button type="button" (click)="help('payment')">Payment help</button>
 @if(r.canReportLostItem){<button type="button" (click)="help('lost_item')">Report a lost item</button>}
 @if(r.canRate){<button type="button" (click)="rate()">{{r.rating?'Update rating':'Rate the service'}}</button>}
 @if(r.viewer==='customer' && r.terminal){<button type="button" (click)="bookAgain()">Book again</button>}
 </section>
 }
</main></ion-content>`,styles:[`
:host{display:block;min-width:0}.booking-record{box-sizing:border-box;max-width:44rem;margin:auto;padding:1rem 1rem calc(2rem + env(safe-area-inset-bottom));color:#0f172a;overflow-wrap:anywhere}
.saved-message{border-top:1px solid #e2e8f0;padding:1rem 0}.saved-message p{white-space:pre-wrap}section{background:white;border:1px solid #e2e8f0;border-radius:1.2rem;padding:1.25rem;margin-bottom:1rem;min-width:0}h1{font-size:1.6rem;font-weight:800}h2{font-size:1.15rem;font-weight:800;margin-bottom:.7rem}h3{font-weight:800}p{margin:.45rem 0;line-height:1.5}dl{display:grid;gap:.4rem;margin-top:1rem}dt{font-weight:700;color:#475569;margin-top:.6rem}dd{margin:0;min-width:0}.eyebrow,.muted{color:#64748b}.muted{display:block;font-size:.85rem;line-height:1.4}.reference{font-size:.8rem}.amount{font-size:1.8rem;font-weight:800}.actions{display:grid;gap:.7rem}button{min-height:2.75rem;background:#f59e0b;color:#0f172a;border-radius:.8rem;padding:.75rem 1rem;font-weight:700;white-space:normal;text-align:left;line-height:1.4;max-width:100%}button:focus-visible{outline:3px solid #2563eb;outline-offset:3px}@media print{ion-header,.actions,button{display:none!important}.booking-record{padding:0}section{break-inside:avoid}}
`]})
export class BookingHistoryPage implements OnInit {
 private chat=inject(CommunicationService);private auth=inject(AuthService);userId=computed(()=>this.auth.currentUser()?.id);
 private api=inject(BookingHelpService);private route=inject(ActivatedRoute);private router=inject(Router);
 record=signal<any>(null);loading=signal(false);error=signal('');payment=computed(()=>historyPaymentSummary(this.record() || {}));
 messages=signal<any[]>([]);messagesLoading=signal(false);messagesLoaded=signal(false);messagesError=signal('');
 async loadMessages(){if(this.messagesLoading() || !this.record())return;this.messagesLoading.set(true);this.messagesError.set('');try{this.messages.set(await this.chat.getJobMessages(this.record().id));this.messagesLoaded.set(true);}catch{this.messagesError.set('Messages could not be loaded. Please retry.');}finally{this.messagesLoading.set(false);}}
 money=formatHistoryMoney;statusLabel=historyStatusLabel;
 backUrl(){return (this.record()?.viewer==='driver' || this.route.pathFromRoot.some(r=>r.snapshot.data['role']==='driver'))?'/driver':'/customer/activity';}
 ngOnInit(){void this.load();}ionViewWillEnter(){void this.load();}
 async load(){if(this.loading())return;const id=this.route.snapshot.paramMap.get('id');if(!id){this.error.set('Booking reference is missing.');return;}this.loading.set(true);this.error.set('');try{this.record.set(await this.api.getHistory(id));}catch(e:any){this.record.set(null);this.error.set(e?.error?.error || 'Could not load this booking. Please retry.');}finally{this.loading.set(false);}}
 help(category:BookingSupportCategory){const r=this.record();if(r)void this.api.openSupport(r.id,category);}
 async rate(){const r=this.record();if(r?.canRate && await this.api.rate(r.id,r.rating))await this.load();}
 continueBooking(){const r=this.record();if(r)void this.router.navigate([r.viewer==='driver'?'/driver/job-details':'/customer/tracking',r.id]);}
 bookAgain(){void this.router.navigate(['/customer/request']);}
 printReceipt(){window.print();}
 transferLabel(status:string){return ['paid','transferred','succeeded'].includes(status)?'Transferred to your Stripe account':status==='reversed'?'Transfer reversed':['failed','blocked','reconcile','unknown'].includes(status)?'Transfer needs review':'Transfer pending';}
}
