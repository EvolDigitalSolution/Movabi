import { Injectable, inject, effect, signal, untracked } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { BackgroundGeolocation } from '@capgo/background-geolocation';
import { DriverService } from '../driver/driver.service';
import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ApiUrlService } from '../api-url.service';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
export interface JourneyPoint {lat:number;lng:number;accuracy:number;heading:number|null;time:number;}
const active = new Set(['assigned','accepted','heading_to_pickup','over_budget_requested','delivered','en_route','en_route_to_pickup','arrived','arrived_at_pickup','arrived_at_store','shopping_in_progress','shopping_completed','items_collected','collected','en_route_to_customer','arrived_at_customer','in_progress','on_trip']);
@Injectable({providedIn:'root'})
export class JourneyTrackingService {
  private driver=inject(DriverService); private auth=inject(AuthService);
  private supabase=inject(SupabaseService); private api=inject(ApiUrlService); private http=inject(HttpClient);
  readonly point=signal<JourneyPoint|null>(null); readonly error=signal(''); readonly mode=signal<'stopped'|'foreground'|'native'>('stopped');
  private desired=''; private running=''; private serial:Promise<void>=Promise.resolve(); private watch:number|null=null;
  private refresh:ReturnType<typeof setInterval>|null=null; private lastPost=0; private expires=0;
  private activeToken=''; private posting=false;
  constructor() {
    effect(()=>{
      const user=this.auth.currentUser(); const job=this.driver.activeJob();
      const key=user && job && String(job.driver_id)===user.id && active.has(String(job.status)) ? `${user.id}:${job.id}` : '';
      untracked(()=>this.change(key));
    });
  }
  private change(key:string) {
    if(key===this.desired) return;
    this.desired=key;
    this.serial=this.serial.catch(()=>undefined).then(async()=>{
      await this.stop(); if(!key || key!==this.desired) return;
      const jobId=key.split(':')[1];
      try {
        const session=await this.session(jobId);
        if(key!==this.desired) return;
        this.activeToken=session.token; this.expires=session.expires; this.running=key;
        if(Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('BackgroundGeolocation')) {
          await BackgroundGeolocation.start({backgroundTitle:'Movabi journey active',backgroundMessage:'Sharing your location with the customer for this booking.',requestPermissions:true,stale:false,distanceFilter:0,minIntervalMs:10000,url:this.api.getApiUrl(`/api/journey/${jobId}/location`),headers:{'X-Movabi-Journey-Token':session.token}},(location,error)=>{
            if(error){this.error.set('Location permission or GPS is unavailable.');return;}
            if(location && key===this.desired) this.acceptPoint(location.latitude,location.longitude,location.accuracy,location.bearing,location.time);
          });
          this.mode.set('native');
        } else {
          if(!navigator.geolocation) throw new Error('GPS is unavailable');
          this.watch=navigator.geolocation.watchPosition(position=>{
            if(key!==this.desired) return;
            if (!this.acceptPoint(position.coords.latitude,position.coords.longitude,position.coords.accuracy,position.coords.heading,position.timestamp)) return;
            if(Date.now()-this.lastPost<10000 || this.posting || this.expires<=Date.now()) return;
            this.lastPost=Date.now();this.posting=true;
            void firstValueFrom(this.http.post(this.api.getApiUrl(`/api/journey/${jobId}/location`),{latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy,bearing:position.coords.heading,speed:position.coords.speed,time:position.timestamp},{headers:{'X-Movabi-Journey-Token':this.activeToken}})).catch(()=>this.error.set('Waiting for the location connection.')).finally(()=>this.posting=false);
          },()=>this.error.set('Location permission or GPS is unavailable.'),{enableHighAccuracy:true,maximumAge:5000,timeout:15000});
          this.mode.set('foreground');
        }
        this.refresh=setInterval(()=>{void this.refreshSession(key,jobId);},60*60*1000);
      } catch {this.error.set('Journey tracking could not start. Check location permission and connection.');await this.stop();}
    });
  }
  private acceptPoint(lat:number,lng:number,accuracy:number,heading:number|null,time:number|null): boolean {
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180||!Number.isFinite(accuracy)||accuracy>100||accuracy<0||!time||Date.now()-time>90000||time>Date.now()+30000) {
      this.error.set(accuracy > 100 ? 'Waiting for a more accurate GPS position.' : 'Waiting for a fresh GPS position.');
      return false;
    }
    this.point.set({lat,lng,accuracy,heading,time}); this.error.set('');return true;
  }
  private async session(jobId:string):Promise<{token:string;expires:number}> {
    const {data:{session}}=await this.supabase.auth.getSession();
    if(!session) throw new Error('Sign in required');
    return firstValueFrom(this.http.post<{token:string;expires:number}>(this.api.getApiUrl(`/api/journey/${jobId}/session`),{},{headers:{Authorization:`Bearer ${session.access_token}`}}));
  }
  private async refreshSession(key:string,jobId:string) {
    try { const session=await this.session(jobId);if(key!==this.desired) return;
      if(this.mode()==='native') await BackgroundGeolocation.updateHeaders({headers:{'X-Movabi-Journey-Token':session.token}});
      this.activeToken=session.token;this.expires=session.expires;
    } catch { if(this.expires<=Date.now()) {this.error.set('Journey session needs refreshing.'); await this.stop();} }
  }
  private async stop() {
    if(this.refresh) clearInterval(this.refresh);this.refresh=null;
    if(this.watch!==null) navigator.geolocation.clearWatch(this.watch);this.watch=null;
    if(this.running && Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('BackgroundGeolocation')) await BackgroundGeolocation.stop().catch(()=>undefined);
    this.running='';this.activeToken='';this.point.set(null);this.mode.set('stopped');this.lastPost=0;
  }
  retry(){const key=this.desired;this.desired='';this.change(key);}
}
