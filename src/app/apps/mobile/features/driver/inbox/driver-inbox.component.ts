import { Component, OnInit, OnDestroy, EventEmitter, Output, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonInfiniteScroll, IonInfiniteScrollContent } from '@ionic/angular/standalone';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { DriverInboxService, DriverInboxItem, DriverInboxKind, DriverInboxCursor } from '../../../../../core/services/driver/driver-inbox.service';
@Component({selector:'app-driver-inbox',standalone:true,imports:[CommonModule,IonInfiniteScroll,IonInfiniteScrollContent],template:`
 <section class="inbox-panel" aria-label="Driver inbox">
  <div class="inbox-heading"><h2>Inbox</h2><button type="button" [disabled]="loading()" (click)="load(false)">Refresh</button></div>
  <p>Customer messages and updates from Movabi.</p>
  @if(api.countError()){<p role="status">Unread counts are temporarily unavailable.</p>}
  <div class="inbox-tabs" aria-label="Inbox categories">
   <button type="button" [attr.aria-pressed]="kind()==='messages'" (click)="choose('messages')">Messages <span>{{api.counts().messages}} unread</span></button>
   <button type="button" [attr.aria-pressed]="kind()==='updates'" (click)="choose('updates')">Updates <span>{{api.counts().updates}} unread</span></button>
  </div>
  @if(selected();as item){
   <article class="inbox-detail">
    <button type="button" (click)="close()">← Back to inbox</button>
    <h3>{{item.title}}</h3><p class="inbox-date">{{item.created_at | date:'medium'}}</p>
    <p class="inbox-body">{{item.body}}</p>
    @if(readError()){<p role="alert">{{readError()}}</p><button type="button" [disabled]="opening()" (click)="open(item)">Retry</button>}
    @if(opening()){<p role="status">Opening message…</p>}
    @if(target();as action){@if(action.route){<button type="button" class="inbox-action" (click)="follow(action.route!)">{{action.label}}</button>}@else if(action.label){<p>{{action.label}}</p>}}
   </article>
  }@else{
   @if(hasUpdates()){<button type="button" class="inbox-action" [disabled]="loading()" (click)="load(false)">New inbox items — show latest</button>}
   @if(error()){<p role="alert">{{error()}}</p><button type="button" [disabled]="loading()" (click)="load(items().length>0)">Try again</button>}
   @if(loading() && !items().length){<p role="status">Loading inbox…</p>}
   @if(!loading() && !error() && !items().length){<p class="inbox-empty">{{kind()==='messages'?'No customer messages yet.':'No updates yet.'}}</p>}
   @for(item of items();track item.id){
    <button type="button" class="inbox-record" [class.inbox-unread]="item.unread" (click)="open(item)">
     <strong>{{item.title}}</strong>@if(item.unread){<span class="inbox-unread-label">Unread</span>}
     <span class="inbox-date">{{item.created_at | date:'medium'}}</span><span class="inbox-preview">{{item.body}}</span>
    </button>
   }
   <ion-infinite-scroll threshold="120px" [disabled]="!cursor() || !!error()" (ionInfinite)="more($event)"><ion-infinite-scroll-content loadingSpinner="crescent" loadingText="Loading more inbox items…"></ion-infinite-scroll-content></ion-infinite-scroll>
  }
 </section>
 `,styles:[`.inbox-panel{background:white;border:1px solid #e2e8f0;border-radius:1.4rem;padding:1rem;min-width:0;overflow-wrap:anywhere;line-height:1.5}.inbox-heading{display:flex;justify-content:space-between;align-items:center;gap:1rem}.inbox-heading h2{font-size:1.2rem;font-weight:800}.inbox-panel button{font-weight:700}.inbox-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem;margin:1rem 0}.inbox-tabs button{padding:.7rem;border:1px solid #cbd5e1;border-radius:.8rem;font-size:.85rem;min-width:0}.inbox-tabs span{display:block;font-size:.75rem;font-weight:500}.inbox-tabs [aria-pressed=true]{background:#fef3c7;border-color:#f59e0b}.inbox-record{display:grid;gap:.4rem;width:100%;text-align:left;min-width:0;padding:1rem;margin-top:.7rem;border:1px solid #e2e8f0;border-radius:.9rem;background:#f8fafc}.inbox-unread{border-left:4px solid #2563eb}.inbox-unread-label{color:#1d4ed8;font-size:.75rem}.inbox-date{font-size:.75rem;color:#64748b}.inbox-preview{font-size:.85rem;font-weight:400;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.inbox-body{white-space:pre-wrap;margin:1rem 0;font-size:.9rem}.inbox-detail h3{font-size:1.1rem;font-weight:800;margin-top:1rem}.inbox-action{width:100%;padding:.8rem;border-radius:.7rem;background:#fef3c7}.inbox-empty{padding:1.5rem 0;color:#64748b}.inbox-panel button:focus-visible{outline:3px solid #2563eb;outline-offset:3px}`]})
export class DriverInboxComponent implements OnInit,OnDestroy {
 api=inject(DriverInboxService);private auth=inject(AuthService);private router=inject(Router);
 @Output() requests=new EventEmitter<void>();
 kind=signal<DriverInboxKind>('messages');items=signal<DriverInboxItem[]>([]);cursor=signal<DriverInboxCursor|null>(null);loading=signal(false);error=signal('');selected=signal<DriverInboxItem|null>(null);target=signal<{route:string|null;label:string}|null>(null);readError=signal('');opening=signal(false);
 hasUpdates=signal(false);private loadedBatches=0;
 private updates=effect(()=>{const revision=this.api.revision();untracked(()=>this.refreshForNewItems(revision));});
 refreshForNewItems(revision:number){if(!revision||!this.loadedBatches)return;if(this.loadedBatches===1&&!this.selected()&&!this.loading())void this.load(false);else this.hasUpdates.set(true);}
 private generation=0;private openGeneration=0;private owner=this.auth.currentUser()?.id;
 private session=effect(()=>{const owner=this.auth.currentUser()?.id;if(owner!==this.owner){this.owner=owner;this.generation++;this.openGeneration++;this.items.set([]);this.cursor.set(null);this.loadedBatches=0;this.hasUpdates.set(false);this.selected.set(null);this.target.set(null);this.loading.set(false);this.opening.set(false);this.error.set('Please reopen your inbox after signing in.');}});
 ngOnInit(){void this.load(false);}
 ngOnDestroy(){this.generation++;this.openGeneration++;}
 choose(kind:DriverInboxKind){if(kind===this.kind())return;this.generation++;this.kind.set(kind);this.items.set([]);this.cursor.set(null);this.loadedBatches=0;this.hasUpdates.set(false);this.selected.set(null);this.target.set(null);this.loading.set(false);this.close();void this.load(false);}
 async load(append=false){if(this.loading())return;const generation=this.generation,owner=this.auth.currentUser()?.id,revision=this.api.revision();this.loading.set(true);this.error.set('');
  try{const page=await this.api.page(this.kind(),append?this.cursor():null);if(generation!==this.generation||owner!==this.auth.currentUser()?.id)return;
   const merged=append?[...this.items(),...page.items]:page.items;this.items.set([...new Map(merged.map(item=>[item.id,item])).values()]);this.cursor.set(page.cursor);this.loadedBatches=append?this.loadedBatches+1:1;if(!append)this.hasUpdates.set(this.api.revision()!==revision);void this.api.refreshCounts();
  }catch{if(generation===this.generation)this.error.set('Could not load your inbox. Please retry.');}
  finally{if(generation===this.generation)this.loading.set(false);}
 }
 async more(event:Event){try{if(this.cursor())await this.load(true);}finally{await(event.target as HTMLIonInfiniteScrollElement).complete();}}
 close(){this.openGeneration++;this.selected.set(null);this.target.set(null);this.opening.set(false);this.readError.set('');}
 async open(item:DriverInboxItem){if(this.opening())return;const generation=++this.openGeneration,owner=this.auth.currentUser()?.id;this.selected.set(item);this.target.set(null);this.opening.set(true);this.readError.set('');
  try{if(item.unread)await this.api.read(this.kind(),item);if(generation!==this.openGeneration||owner!==this.auth.currentUser()?.id)return;
   this.items.update(rows=>rows.map(row=>row.id===item.id?{...row,unread:false}:row));this.selected.set({...item,unread:false});
   const target=await this.api.target(this.kind(),item.id);if(generation===this.openGeneration&&owner===this.auth.currentUser()?.id)this.target.set(target);
  }catch{if(generation===this.openGeneration)this.readError.set('Could not finish opening this item. Please retry.');}
  finally{if(generation===this.openGeneration)this.opening.set(false);}
 }
 follow(route:string){if(route==='/driver')this.requests.emit();else void this.router.navigateByUrl(route);}
}
