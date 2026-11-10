import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AdminConversationService } from '../../../../core/services/communication/admin-conversation.service';
import { AdminConversationComponent } from '../../../../shared/ui/admin-conversation.component';
@Component({selector:'app-admin-messages',standalone:true,imports:[CommonModule,AdminConversationComponent],template:`
<div class="space-y-4"><div class="flex items-center justify-between gap-3"><h1 class="text-xl font-bold">Messages <span class="text-sm">({{messages.unread()}} unread replies)</span></h1><button type="button" (click)="messages.refreshInbox()" class="text-sm text-blue-700">Refresh</button></div>
 @if(messages.inboxError()){<p role="alert" class="text-rose-700">{{messages.inboxError()}}</p>}
 <div class="grid gap-4 lg:grid-cols-2"><div class="space-y-2">
 @for(thread of messages.threads();track thread.id){<button type="button" (click)="selected.set(thread.id)" class="w-full rounded-xl border bg-white p-4 text-left" [class.border-blue-600]="selected()===thread.id">
 <p class="font-bold">{{thread.user_name || thread.user_id}} <span class="text-xs font-normal">{{thread.user_role}}</span></p><p class="text-sm">{{thread.subject}}</p><p class="text-xs text-slate-500">{{thread.updated_at | date:'short'}} @if(thread.unread){<span class="font-bold text-blue-700"> · {{thread.unread}} unread</span>}</p></button>}
 @empty{<p class="text-sm text-slate-500">No conversations yet. Send a message from Users or Drivers to start one.</p>}
 </div><div>@if(selected();as id){<app-admin-conversation [messageId]="id" [adminView]="true"/>}</div></div>
</div>`})
export class AdminMessagesComponent implements OnInit,OnDestroy {
 readonly messages=inject(AdminConversationService);selected=signal('');private stop?:()=>void;
 ngOnInit(){this.stop=this.messages.watchInbox();}ngOnDestroy(){this.stop?.();}
}
