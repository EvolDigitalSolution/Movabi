import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonContent } from '@ionic/angular/standalone';
import { NotificationService } from '@core/services/notification.service';
import { adminMessageRoute } from '@shared/utils/admin-message-route';

@Component({selector:'app-messages',standalone:true,
 imports:[CommonModule,IonHeader,IonToolbar,IonTitle,IonButtons,IonBackButton,IonContent],
 template:`
 <ion-header><ion-toolbar><ion-buttons slot="start"><ion-back-button defaultHref="/account/settings"></ion-back-button></ion-buttons><ion-title>Messages from Movabi</ion-title></ion-toolbar></ion-header>
 <ion-content class="bg-slate-50"><div class="mx-auto max-w-xl space-y-4 p-4">
   <div class="flex items-center justify-between"><p class="text-sm font-bold">{{notices.unreadAdminMessageCount()}} unread</p><button class="text-sm font-bold text-blue-600" [disabled]="loading()" (click)="refresh()">Refresh</button></div>
   @if(error()){<p role="alert" class="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{{error()}}</p>}
   @if(selected(); as message){<article class="rounded-2xl border border-blue-200 bg-white p-5"><h2 class="text-lg font-bold">{{message.title}}</h2><p class="mt-2 text-xs text-slate-500">{{message.created_at | date:'medium'}}</p><p class="mt-4 whitespace-pre-wrap text-sm text-slate-800">{{message.body}}</p></article>}
   @else if(messageId() && !loading()){<p class="text-sm text-slate-500">This message is unavailable for your account.</p>}
   @for(message of notices.adminMessages();track message.id){<button type="button" class="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left" (click)="openMessage(message.id)"><div class="flex justify-between gap-2"><span class="text-sm font-bold">{{message.title}}</span>@if(!message.is_read){<span class="rounded-full bg-blue-100 px-2 py-1 text-xs font-bold text-blue-700">Unread</span>}</div><p class="mt-2 text-xs text-slate-500">{{message.created_at | date:'medium'}}</p></button>}
   @empty{<p class="p-4 text-sm text-slate-500">{{loading()?'Loading messages...':'No messages yet.'}}</p>}
 </div></ion-content>`
})
export class MessagesPage implements OnInit {
 readonly notices=inject(NotificationService);
 private router=inject(Router);
 private route=inject(ActivatedRoute);
 private params=toSignal(this.route.queryParamMap,{initialValue:this.route.snapshot.queryParamMap});
 readonly messageId=computed(()=>this.params().get('messageId'));
 readonly selected=computed(()=>this.notices.adminMessages().find(message=>message.id===this.messageId()) || null);
 readonly loading=signal(false);
 readonly error=signal('');
 private marking=new Set<string>();
 constructor(){effect(()=>{
    const message=this.selected();
    if(message && !message.is_read && !this.marking.has(message.id)){
      this.marking.add(message.id);
      void this.notices.markAsRead(message.id).catch(()=>this.error.set('Could not mark this message as read.')).finally(()=>this.marking.delete(message.id));
    }
 });}
 async ngOnInit(){this.notices.initialize();await this.refresh();}
 async ionViewWillEnter(){if(!this.loading())await this.refresh();}
 async refresh(){if(this.loading())return;this.loading.set(true);this.error.set('');try{await this.notices.fetchNotifications();}catch{this.error.set('Could not load messages. Please try again.');}finally{this.loading.set(false);}}
 openMessage(id:string){const route=adminMessageRoute(id);if(route)void this.router.navigateByUrl(route);}
}
