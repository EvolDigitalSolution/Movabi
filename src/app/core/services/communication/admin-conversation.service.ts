import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { ApiUrlService } from '../api-url.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { pollRetryDelay } from '../../../shared/utils/poll-retry-delay';
@Injectable({providedIn:'root'})
export class AdminConversationService {
 private http=inject(HttpClient);private api=inject(ApiUrlService);private db=inject(SupabaseService);private auth=inject(AuthService);
 threads=signal<any[]>([]);inboxError=signal('');unread=computed(()=>this.threads().reduce((sum,row)=>sum+Number(row.unread || 0),0));
 private inboxPending:Promise<void>|null=null;private retryAt=0;private owner='';
 constructor(){effect(()=>{const id=this.auth.currentUser()?.id || '';if(id!==this.owner){this.owner=id;this.threads.set([]);this.inboxError.set('');this.retryAt=0;this.inboxPending=null;}});}
 async request(method:'GET'|'POST',path:string,body?:any):Promise<any>{
  const owner=this.auth.currentUser()?.id;if(!owner)throw Error('Please sign in again.');
  const session=await this.db.auth.getSession();const token=session.data.session?.access_token;
  if(!token || session.data.session?.user.id!==owner)throw Error('Please sign in again.');
  const url=this.api.getApiUrl('/api/admin-messages'+path),options={headers:{Authorization:`Bearer ${token}`}};
  const result=await firstValueFrom((method==='GET'?this.http.get(url,options):this.http.post(url,body,options)).pipe(timeout(20000)));
  if(owner!==this.auth.currentUser()?.id)throw Error('Account changed. Please reload messages.');return result;
 }
 refreshInbox():Promise<void>{
  if(this.inboxPending)return this.inboxPending;
  if(Date.now()<this.retryAt)return Promise.resolve();
  const owner=this.auth.currentUser()?.id;
  const task=(async()=>{try{const rows=await this.request('GET','');if(owner!==this.auth.currentUser()?.id)return;this.threads.set(rows);this.inboxError.set('');this.retryAt=0;}
   catch(error:any){if(owner!==this.auth.currentUser()?.id)return;this.inboxError.set(error?.error?.error || error.message || 'Messages could not be loaded.');this.retryAt=Date.now()+pollRetryDelay(error);}})();
  this.inboxPending=task;void task.finally(()=>{if(this.inboxPending===task)this.inboxPending=null;});return task;
 }
 watchInbox(){void this.refreshInbox();const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void this.refreshInbox();},30000);return()=>clearInterval(timer);}
}
