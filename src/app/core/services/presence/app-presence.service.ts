import { DestroyRef, Injectable, effect, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable({providedIn:'root'})
export class AppPresenceService {
 private auth=inject(AuthService);
 private db=inject(SupabaseService).client;
 private destroy=inject(DestroyRef);
 private session=crypto.randomUUID();
 private busy=false;
 constructor() {
  effect(()=>{const user=this.auth.currentUser();if(user)void this.heartbeat();});
  const refresh=()=>{if(document.visibilityState==='visible')void this.heartbeat();};
  const timer=setInterval(refresh,30000);
  document.addEventListener('visibilitychange',refresh);
  window.addEventListener('online',refresh);
  this.destroy.onDestroy(()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',refresh);});
 }
 private async heartbeat() {
  if(this.busy||!this.auth.currentUser()||document.visibilityState!=='visible'||!navigator.onLine)return;
  this.busy=true;
  try {
   const {error}=await this.db.rpc('touch_app_presence',{p_session:this.session}).abortSignal(AbortSignal.timeout(8000));
   if(error)console.warn('[Presence] heartbeat unavailable');
  } catch { /* Expiry is authoritative when connectivity is lost. */ }
  finally {this.busy=false;}
 }
}
