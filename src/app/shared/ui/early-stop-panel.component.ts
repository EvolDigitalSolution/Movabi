import {CommonModule} from '@angular/common';
import {Component,Input,OnChanges,OnDestroy,inject,signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {EarlyStopService,type StopPilotView,type FarePilotView} from '../../core/services/early-stop.service';
import {BookingHelpService} from '../../core/services/support/booking-help.service';
@Component({selector:'app-early-stop-panel',standalone:true,imports:[CommonModule,FormsModule],template:`
  @if (view() || error()) {
    <section class="m-3 space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4" aria-label="Early stop review">
      <h2 class="text-lg font-bold text-slate-950">Need to end the ride early?</h2>
      <p class="text-sm">In immediate danger, move to safety when possible and contact local emergency services. Vaydu support is not an emergency response service. You do not need the other person's agreement to seek help.</p>
      <button type="button" class="rounded-xl border bg-white p-3 font-bold" (click)="safetyHelp()">Report a safety issue</button>
      <p class="text-sm">This records a stop request and agreement. Booking closure and any revised fare still require support review.</p>
      @if (error()) { <p role="alert" class="text-sm font-semibold text-rose-800">{{error()}}</p> }
      <button type="button" class="rounded-xl border bg-white p-2 text-sm" [disabled]="busy() || loading()" (click)="refresh()">{{ loading() ? 'Refreshing…' : 'Refresh status' }}</button>
      @if (view(); as data) {
        @if (data.request; as request) {
          <p class="font-bold" role="status" aria-live="polite">{{stateLabel(request.state)}}</p>
          <p class="text-sm">Reason: {{reasonLabel(request.reason)}}</p>
          @if (request.note) { <p class="text-sm whitespace-pre-wrap">{{request.note}}</p> }
          <p class="text-sm">Customer: {{request.customerConfirmed ? 'confirmed stop' : 'not confirmed'}}. Driver: {{request.driverConfirmed ? 'confirmed stop' : 'not confirmed'}}.</p>
          <p class="text-sm">{{request.locationRecorded ? 'A recent driver location was captured for review.' : 'No recent journey location was available. Support review is needed.'}}</p>
          <p class="break-all text-xs">Support reference: {{request.supportReference}}. Delivery may be pending.</p>
          @if (request.bookingChanged) { <p class="text-sm font-bold">The booking changed. Contact support before continuing.</p> }

          @if (request.state==='stop_agreed') {
            @if (fareError()) { <p role="alert" class="text-sm font-bold">{{fareError()}}</p> }
            @if (fareView(); as fare) {
              <div class="space-y-3 rounded-xl border bg-white p-3">
                <h3 class="font-bold">Revised fare proposal</h3>
                <p class="text-sm">A distance-based proposal for this test ride. Agreeing to stop does not approve this fare. Both people must approve separately. Booking closure and payment still require review.</p>
                @if (fare.proposal; as proposal) {
                  <p>Original: {{formatFare(proposal.originalMinor,proposal.currency,proposal.exponent)}}. Proposed: <strong>{{formatFare(proposal.amountMinor,proposal.currency,proposal.exponent)}}</strong>.</p>
                  <p class="text-sm">Recorded distance: {{proposal.coveredMetres}} m of {{proposal.plannedMetres}} m quoted. Unused quoted distance: {{proposal.unusedQuotedMetres}} m.</p>
                  <p class="font-bold" role="status">Fare status: {{proposal.state}}</p>
                  <p class="text-sm">Customer: {{proposal.customerAccepted ? 'accepted' : 'not accepted'}}. Driver: {{proposal.driverAccepted ? 'accepted' : 'not accepted'}}.</p>
                  @if (proposal.state==='proposed') {
                    <p class="text-sm">Respond before {{proposal.expiresAt | date:'shortTime'}}.</p>
                    @if (!(fare.viewer==='customer' ? proposal.customerAccepted : proposal.driverAccepted)) {
                      <button type="button" class="rounded-xl bg-slate-900 p-3 text-white" [disabled]="busy() || loading()" (click)="fareAction('accept')">Accept proposed fare</button>
                    }
                    <label class="block text-sm">Reason for fare review
                      <textarea class="block w-full rounded-xl border p-3" maxlength="1000" [(ngModel)]="fareNote" [disabled]="busy()"></textarea>
                    </label>
                    <button type="button" class="rounded-xl border p-3" [disabled]="busy() || loading() || fareNote.trim().length<3" (click)="fareAction('reject')">Reject fare and request review</button>
                  }
                } @else {
                  <button type="button" class="rounded-xl border p-3" [disabled]="busy() || loading()" (click)="fareAction('propose')">Calculate fare proposal</button>
                }
              </div>
            }
          }
          @if (data.canRespond && request.state==='awaiting_other' && !hasConfirmed()) {
            <p class="text-sm">Confirm before {{request.expiresAt | date:'shortTime'}}. This confirms the stop only, not a fare or payment.</p>
            <button type="button" class="rounded-xl bg-slate-900 p-3 font-bold text-white" [disabled]="busy() || loading()" (click)="respond('confirm')">Agree to stop</button>
          }
          @if (data.canRespond && request.state!=='disputed') {
            <label class="block text-sm">Tell support what you disagree with
              <textarea class="mt-1 block w-full rounded-xl border bg-white p-3" maxlength="1000" [(ngModel)]="disputeNote" [disabled]="busy()"></textarea>
            </label>
            <button type="button" class="rounded-xl border bg-white p-3" [disabled]="busy() || loading() || disputeNote.trim().length<3" (click)="respond('dispute')">Request support review</button>
          }
        } @else if (data.canRequest) {
          <label class="block text-sm">Reason for stopping
            <select class="mt-1 block w-full rounded-xl border bg-white p-3" [(ngModel)]="reason" [disabled]="busy() || submitted!==null">
              <option value="breakdown">Vehicle breakdown</option><option value="safety">Safety concern</option><option value="medical">Medical issue</option><option value="other">Other problem</option>
            </select>
          </label>
          <label class="block text-sm">Additional details (optional)
            <textarea class="mt-1 block w-full rounded-xl border bg-white p-3" maxlength="1000" [(ngModel)]="note" [disabled]="busy() || submitted!==null"></textarea>
          </label>
          <p class="text-sm">By requesting a stop, you confirm your own agreement to stop. The other person must confirm separately. This is not agreement to a new fare.</p>
          <button type="button" class="rounded-xl bg-slate-900 p-3 font-bold text-white" [disabled]="busy() || loading()" (click)="requestStop()">{{busy() ? 'Saving…' : submitted ? 'Retry same request' : 'Request a stop'}}</button>
        } @else { <p class="text-sm">Stop requests are available during an active ride. Safety support remains available.</p> }
      }
    </section>
  }
`})
export class EarlyStopPanelComponent implements OnChanges,OnDestroy {
  @Input({required:true})jobId='';
  private api=inject(EarlyStopService);private help=inject(BookingHelpService);
  readonly view=signal<StopPilotView|null>(null);readonly error=signal('');readonly loading=signal(false);readonly busy=signal(false);
  readonly fareView=signal<FarePilotView|null>(null);readonly fareError=signal('');fareNote='';
  reason='breakdown';note='';disputeNote='';submitted:{requestId:string;reason:string;note:string}|null=null;
  private timer:ReturnType<typeof setInterval>|null=null;private generation=0;private destroyed=false;
  ngOnChanges(){this.generation++;this.loading.set(false);this.busy.set(false);this.view.set(null);this.fareView.set(null);this.fareError.set('');this.fareNote='';this.error.set('');this.submitted=null;if(this.timer)clearInterval(this.timer);this.timer=null;if(this.jobId)void this.refresh();}
  ngOnDestroy(){this.destroyed=true;this.generation++;if(this.timer)clearInterval(this.timer);}
  private current(id:string,generation:number){return !this.destroyed&&id===this.jobId&&generation===this.generation;}
  async refresh(){
    if(!this.jobId||this.busy()||this.loading())return;
    const id=this.jobId,generation=this.generation;this.loading.set(true);
    try{
      const result=await this.api.read(id);if(!this.current(id,generation))return;
      this.view.set(result);this.error.set('');if(result.request)this.submitted=null;
      await this.refreshFare(id,generation);
      if(!this.current(id,generation))return;
      if(!this.timer)this.timer=setInterval(()=>void this.refresh(),20000);
    }catch(error:any){
      if(!this.current(id,generation))return;
      if(error?.status===404){this.view.set(null);this.error.set('');if(this.timer)clearInterval(this.timer);this.timer=null;}
      else this.error.set(error?.error?.error||'Could not refresh stop status. Safety support is still available.');
    }finally{if(this.current(id,generation))this.loading.set(false);}
  }

  private async refreshFare(id:string,generation:number){
    const stop=this.view()?.request;if(stop?.state!=='stop_agreed'){this.fareView.set(null);this.fareError.set('');return;}
    try{const value=await this.api.fare(id,stop.id);if(this.current(id,generation)){this.fareView.set(value);this.fareError.set('');}}
    catch(error:any){if(this.current(id,generation)){this.fareView.set(null);this.fareError.set(error?.status===404?'':error?.error?.error||'Fare proposal unavailable. Contact support for review.');}}
  }
  formatFare(minor:number,currency:string,exponent:number){return new Intl.NumberFormat(undefined,{style:'currency',currency,minimumFractionDigits:exponent,maximumFractionDigits:exponent}).format(minor/10**exponent);}
  async fareAction(action:'propose'|'accept'|'reject'){
    const stop=this.view()?.request,proposal=this.fareView()?.proposal;
    if(stop?.state!=='stop_agreed'||this.busy()||this.loading()||(action!=='propose'&&!proposal))return;
    const id=this.jobId,generation=this.generation;this.busy.set(true);this.fareError.set('');
    try{
      const result=action==='propose'?await this.api.proposeFare(id,stop.id):await this.api.voteFare(id,stop.id,{proposalId:proposal!.id,action,...(action==='reject'?{note:this.fareNote.trim()}:{})});
      if(this.current(id,generation)){this.fareView.set(result);this.fareNote='';}
    }catch(error:any){if(this.current(id,generation))this.fareError.set(error?.error?.error||'Fare response unconfirmed. Refresh before retrying.');}
    finally{if(this.current(id,generation))this.busy.set(false);}
  }
  hasConfirmed(){const v=this.view();return !!v?.request&&(v.viewer==='customer'?v.request.customerConfirmed:v.request.driverConfirmed);}
  reasonLabel(reason:string){return ({breakdown:'Vehicle breakdown',safety:'Safety concern',medical:'Medical issue',other:'Other problem'} as Record<string,string>)[reason]||'Other problem';}
  stateLabel(state:string){return ({awaiting_other:'Waiting for the other person to confirm',stop_agreed:'Both parties agreed to stop — closure and fare still need review',disputed:'Support review requested',expired:'Confirmation window expired — contact support'} as Record<string,string>)[state]||'Refresh stop status';}
  async safetyHelp(){await this.help.openSupport(this.jobId,'safety');}
  async requestStop(){
    if(this.busy()||this.loading()||!this.view()?.canRequest)return;
    this.submitted??={requestId:crypto.randomUUID(),reason:this.reason,note:this.note.trim()};
    const id=this.jobId,generation=this.generation;this.busy.set(true);this.error.set('');
    try{const result=await this.api.request(id,this.submitted);if(this.current(id,generation)){this.view.set(result);this.submitted=null;}}
    catch(error:any){if(this.current(id,generation))this.error.set(error?.error?.error||'Request not confirmed. Refresh before retrying the same request.');}
    finally{if(this.current(id,generation))this.busy.set(false);}
    if(this.current(id,generation))await this.refresh();
  }
  async respond(action:'confirm'|'dispute'){
    const request=this.view()?.request;if(!request||!this.view()?.canRespond||this.busy()||this.loading())return;
    const id=this.jobId,generation=this.generation;this.busy.set(true);this.error.set('');
    try{const result=await this.api.respond(id,{requestId:request.id,action,...(action==='dispute'?{note:this.disputeNote.trim()}:{})});if(this.current(id,generation)){this.view.set(result);this.disputeNote='';}}
    catch(error:any){if(this.current(id,generation))this.error.set(error?.error?.error||'Response not confirmed. Refresh before retrying.');}
    finally{if(this.current(id,generation))this.busy.set(false);}
    if(this.current(id,generation))await this.refresh();
  }
}
