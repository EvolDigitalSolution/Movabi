import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ApiUrlService } from '../api-url.service';
export type DriverInboxKind='messages'|'updates';
export interface DriverInboxItem {id:string;created_at:string;title:string;body:string;unread:boolean;}
export interface DriverInboxCursor {id:string;created_at:string;}
@Injectable({providedIn:'root'})
export class DriverInboxService {
 private http=inject(HttpClient);private auth=inject(AuthService);private db=inject(SupabaseService);private api=inject(ApiUrlService);
 revision=signal(0);
 counts=signal({messages:0,updates:0});countError=signal(false);unread=computed(()=>this.counts().messages+this.counts().updates);
 private owner:string|null=null;private timer?:ReturnType<typeof setInterval>;private channel:any;private countPending=false;private generation=0;private debounce?:ReturnType<typeof setTimeout>;
 async request<T>(path:string,body?:any):Promise<T>{
  const owner=this.auth.currentUser()?.id;if(!owner)throw Error('Please sign in again.');
  const {data}=await this.db.auth.getSession();if(!data.session?.access_token)throw Error('Please sign in again.');
  const options={headers:{Authorization:`Bearer ${data.session.access_token}`}};
  const response=await firstValueFrom((body===undefined?this.http.get<T>(this.api.getApiUrl('/api/communication/inbox'+path),options):this.http.post<T>(this.api.getApiUrl('/api/communication/inbox'+path),body,options)).pipe(timeout(15000)));
  if(this.auth.currentUser()?.id!==owner)throw Error('Session changed');return response;
 }
 start(owner:string){
  this.stop();this.owner=owner;void this.refreshCounts();
  this.timer=setInterval(()=>void this.refreshCounts(),30000);
  const changed=()=>{if(this.debounce)clearTimeout(this.debounce);this.debounce=setTimeout(()=>void this.refreshCounts(),250);};
  this.channel=this.db.channel('driver-inbox-'+owner)
   .on('postgres_changes',{event:'*',schema:'public',table:'notifications',filter:'user_id=eq.'+owner},changed)
   .on('postgres_changes',{event:'*',schema:'public',table:'job_messages',filter:'receiver_id=eq.'+owner},changed).subscribe();
 }
 stop(){this.generation++;this.owner=null;if(this.timer)clearInterval(this.timer);if(this.debounce)clearTimeout(this.debounce);this.timer=undefined;this.debounce=undefined;void this.channel?.unsubscribe();this.channel=undefined;this.countPending=false;this.counts.set({messages:0,updates:0});this.revision.set(0);this.countError.set(false);}
 async refreshCounts(){if(!this.owner||this.countPending)return;const generation=this.generation;this.countPending=true;
  try{const result=await this.request<{messages:number;updates:number}>('/counts');if(generation===this.generation){const previous=this.counts();this.counts.set(result);if(result.messages>previous.messages||result.updates>previous.updates)this.revision.update(n=>n+1);this.countError.set(false);}}
  catch{if(generation===this.generation)this.countError.set(true);}
  finally{if(generation===this.generation)this.countPending=false;}
 }
 page(kind:DriverInboxKind,cursor:DriverInboxCursor|null){return this.request<{items:DriverInboxItem[];cursor:DriverInboxCursor|null}>('?kind='+kind+(cursor?'&cursor='+encodeURIComponent(JSON.stringify(cursor)):''));}
 async read(kind:DriverInboxKind,item:DriverInboxItem){await this.request('/'+kind+'/'+encodeURIComponent(item.id)+'/read',{});if(item.unread){this.counts.update(counts=>({...counts,[kind]:Math.max(0,counts[kind]-1)}));}void this.refreshCounts();}
 target(kind:DriverInboxKind,id:string){return this.request<{route:string|null;label:string}>('/'+kind+'/'+encodeURIComponent(id)+'/target');}
}
