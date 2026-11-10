import { Component, Input, Output, EventEmitter, OnChanges, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminConversationService } from '../../core/services/communication/admin-conversation.service';
import { pollRetryDelay } from '../utils/poll-retry-delay';
@Component({selector:'app-admin-conversation',standalone:true,imports:[CommonModule,FormsModule],template:`
<section class="rounded-2xl border border-slate-200 bg-white p-4 space-y-3" aria-label="Conversation with Vaydu">
 <div class="flex items-center justify-between gap-2"><h3 class="font-bold">{{adminView?'Conversation':'Reply to Vaydu'}}</h3><button type="button" (click)="refresh()" [disabled]="loading()" class="text-sm text-blue-700">Refresh</button></div>
 @if(error()){<p role="alert" class="text-sm text-rose-700">{{error()}}</p>}
 @if(loading()&&!conversation()){<p class="text-sm text-slate-500">Loading conversation…</p>}
 @if(conversation();as thread){
  @if(thread.hasMore){<button type="button" (click)="loadEarlier()" [disabled]="loading()" class="text-sm text-blue-700">Load earlier messages</button>}
  <div class="space-y-3" aria-live="polite">
   @for(message of thread.messages;track message.id){<article class="rounded-xl p-3" [class.bg-blue-50]="message.direction==='admin'" [class.bg-slate-100]="message.direction==='user'">
    <p class="text-xs font-bold">{{message.direction==='admin'?'Vaydu':adminView?'Account holder':'You'}} <span class="font-normal text-slate-500">{{message.created_at | date:'short'}}</span></p>
    <p class="mt-1 whitespace-pre-wrap break-words text-sm">{{message.body}}</p>
    @if(adminView&&message.direction==='admin'&&message.email_status){<p class="mt-1 text-xs text-slate-500">{{message.email_status==='sent'?'Email copy sent':'Email copy queued'}}</p>}
   </article>}
  </div>
  <label class="block text-sm font-bold" [attr.for]="'admin-reply-'+messageId">Your reply</label>
  <textarea [id]="'admin-reply-'+messageId" [(ngModel)]="draft" [disabled]="sending()" maxlength="2000" rows="3" class="w-full rounded-xl border border-slate-300 p-3 text-sm" placeholder="Write your reply"></textarea>
  <button type="button" (click)="send()" [disabled]="sending()||!draft.trim()" class="rounded-xl bg-blue-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{{sending()?'Sending…':'Send reply'}}</button>
  <p role="status" class="text-xs text-slate-500">{{notice()}}</p>
 }
</section>`})
export class AdminConversationComponent implements OnChanges,OnDestroy {
 @Input() messageId='';@Input() adminView=false;@Input() active=true;@Output() read=new EventEmitter<void>();
 private api=inject(AdminConversationService);conversation=signal<any>(null);loading=signal(false);sending=signal(false);error=signal('');notice=signal('');draft='';
 private generation=0;private openedId='';private timer:ReturnType<typeof setInterval>|undefined;private retryAt=0;private busy=false;private reloadQueued=false;private requestId='';private lastDraft='';
 ngOnChanges(){
  this.generation++;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.busy=false;this.reloadQueued=false;this.loading.set(false);this.sending.set(false);
  if(this.messageId!==this.openedId){this.openedId=this.messageId;this.retryAt=0;this.conversation.set(null);this.draft='';this.requestId='';this.lastDraft='';this.notice.set('');this.sending.set(false);}
  if(!this.active)return;
  void this.refresh();this.timer=setInterval(()=>{if(document.visibilityState!=='hidden')void this.refresh();},15000);
 }
 ngOnDestroy(){this.generation++;if(this.timer)clearInterval(this.timer);}
 async refresh(before?:string){
  if(!this.active||!this.messageId||Date.now()<this.retryAt)return;if(this.busy){this.reloadQueued=true;return;}
  const gen=this.generation,id=this.messageId;this.busy=true;this.loading.set(true);
  try {
   const row=await this.api.request('GET','/'+encodeURIComponent(id)+(before?'?before='+encodeURIComponent(before):''));if(gen!==this.generation)return;
   const current=this.conversation();
   if(current?.id===row.id && !(row.hasMore&&row.messages.length&&current.messages.length&&BigInt(row.messages[0].id)>BigInt(current.messages[current.messages.length-1].id))){const merged=new Map<string,any>();for(const m of [...current.messages,...row.messages])merged.set(m.id,m);row.messages=[...merged.values()].sort((a:any,b:any)=>BigInt(a.id)<BigInt(b.id)?-1:1);if(!before)row.hasMore=current.hasMore;}
   this.conversation.set(row);this.error.set('');this.retryAt=0;
   const unread=row.messages.filter((m:any)=>!m.read_at&&m.direction===(this.adminView?'user':'admin')).slice(-100).map((m:any)=>m.id);
   if(unread.length){await this.api.request('POST','/'+encodeURIComponent(row.id)+'/read',{ids:unread});if(gen!==this.generation)return;this.conversation.update((v:any)=>({...v,messages:v.messages.map((m:any)=>unread.includes(m.id)?{...m,read_at:new Date().toISOString()}:m)}));void this.api.refreshInbox();if(!this.adminView)this.read.emit();}
  }catch(error:any){if(gen===this.generation){this.error.set(error?.error?.error || error.message || 'Conversation unavailable.');this.retryAt=Date.now()+pollRetryDelay(error);}}
  finally{if(gen===this.generation){this.busy=false;this.loading.set(false);if(this.reloadQueued){this.reloadQueued=false;void this.refresh();}}}
 }
 loadEarlier(){const row=this.conversation();if(row?.messages.length)void this.refresh(row.messages[0].id);}
 async send(){
  const text=this.draft.trim(),row=this.conversation();if(this.sending()||!row||!text)return;
  const gen=this.generation;if(text!==this.lastDraft||!this.requestId){this.requestId=crypto.randomUUID();this.lastDraft=text;}
  this.sending.set(true);this.error.set('');this.notice.set('');
  try{await this.api.request('POST','/'+encodeURIComponent(row.id)+'/replies',{message:text,requestId:this.requestId});if(gen!==this.generation)return;this.draft='';this.requestId='';this.notice.set('Reply sent.');this.retryAt=0;await this.refresh();void this.api.refreshInbox();}
  catch(error:any){if(gen===this.generation)this.error.set(error?.error?.error || error.message || 'Reply could not be sent. Please retry.');}
  finally{if(gen===this.generation)this.sending.set(false);}
 }
}
