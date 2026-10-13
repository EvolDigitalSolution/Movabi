import { DriverRequestFeedService } from '@core/services/driver/driver-request-feed.service';
import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';
import { Component, Input, OnDestroy, inject, signal, effect } from '@angular/core';
import { IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, ModalController } from '@ionic/angular/standalone';
import { MapComponent } from '../../../../../shared/components/map/map.component';
import { MapRendererService } from '../../../../../core/services/maps/map-renderer.service';
import { RoutingService } from '../../../../../core/services/maps/routing.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { JourneyTrackingService } from '../../../../../core/services/logistics/journey-tracking.service';
import { NavigationRoute, journeyProgress, distanceMeters } from '../../../../../shared/utils/journey-progress';
import { firstValueFrom } from 'rxjs';
@Component({selector:'app-journey-navigation',standalone:true,
 imports:[IonHeader,IonToolbar,IonTitle,IonButtons,IonButton,IonContent,MapComponent],providers:[MapRendererService],
 styles:[`
 .nav-shell{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#f8fafc;overflow:hidden}
 .nav-meta{padding:10px 14px;background:white;border-bottom:1px solid #e2e8f0}
 .nav-name{font-size:14px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0}
 .nav-label{font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;margin:3px 0}
 .nav-address{font-size:12px;line-height:1.4;color:#334155;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
 .nav-map{min-height:0;position:relative}.nav-map app-map{display:block;width:100%;height:100%}
 .nav-controls{padding:10px 14px calc(env(safe-area-inset-bottom) + 10px);background:white;border-top:1px solid #e2e8f0}
 .nav-instruction{font-size:14px;line-height:1.35;font-weight:700;margin:0;color:#0f172a;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
 .nav-summary{font-size:12px;color:#64748b;margin:4px 0 8px}.nav-tools{display:flex;gap:8px;margin-top:8px}
 .nav-tools button{flex:1;font-size:12px;font-weight:600;padding:10px 6px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;color:#334155}
 .nav-action{width:100%;padding:12px;border:0;border-radius:12px;background:#f59e0b;color:#0f172a;font-size:13px;font-weight:700}
 .nav-error{font-size:11px;line-height:1.3;margin:4px 0;color:#b45309;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
 @media(max-height:500px) and (min-width:600px){.nav-shell{grid-template-columns:minmax(0,1fr) 240px;grid-template-rows:auto minmax(0,1fr)}.nav-meta{grid-column:1/-1}.nav-controls{min-height:0;padding:8px}.nav-tools button{padding:8px 4px}}
 `],
 template:`<ion-header><ion-toolbar><ion-title style="font-size:16px">Directions</ion-title><ion-buttons slot="end"><ion-button (click)="close()">Close</ion-button></ion-buttons></ion-toolbar></ion-header>
 <ion-content [scrollY]="false"><div class="nav-shell">
 <div class="nav-meta"><p class="nav-name" [title]="customerName">{{customerName}}</p><p class="nav-label">{{label}}</p><p class="nav-address" [title]="address">{{address}}</p></div>
 <div class="nav-map"><app-map (ready)="ready($event)"></app-map></div>
 <div class="nav-controls"><p class="nav-instruction" [title]="instruction()">{{instruction()}}</p><p class="nav-summary">{{summary()}}</p>
 @if(error()){<p class="nav-error" role="status">{{error()}}</p>}
 @if(actionLabel){<button class="nav-action" [disabled]="acting()" (click)="performAction()">{{acting()?'Opening job action…':actionLabel}}</button>}
 <div class="nav-tools"><button (click)="voice.set(!voice())">Voice {{voice()?'on':'off'}}</button>@if(error()){<button (click)="retry()">Retry</button>}<button (click)="external()">Other maps</button></div>
 </div></div></ion-content>`})
export class JourneyNavigationComponent implements OnDestroy {
 @Input() customerName='Customer'; @Input() actionLabel=''; @Input() onJobAction?:()=>Promise<void>;
 readonly requestFeed=inject(DriverRequestFeedService);
 private requestMarkers=new Set<string>();
 constructor(){effect(()=>{this.requestFeed.mapJobs();this.syncRequestMarkers();});}
 private syncRequestMarkers(){
   if(!this.map||this.destroyed)return;
   const next=new Set<string>();const groups=new Map<string,{job:ReturnType<DriverRequestFeedService['mapJobs']>[number];lat:number;lng:number;count:number}>();
   for(const job of this.requestFeed.mapJobs()){
     if(job.pickup_lat==null||job.pickup_lng==null)continue;
     const lat=Number(job.pickup_lat),lng=Number(job.pickup_lng);
     if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)continue;
     const key=`${lat.toFixed(6)},${lng.toFixed(6)}`;const group=groups.get(key);
     if(group)group.count++;else groups.set(key,{job,lat,lng,count:1});
   }
   for(const {job,lat,lng,count} of groups.values()){
     const id=`journey-request-${job.id}`;next.add(id);
     const slug=job.service_slug;
     const serviceType:ServiceTypeSlug=slug==='errand'||slug==='delivery'||slug==='van-moving'?slug:'ride';
     this.map.addOrUpdateMarker({id,coordinates:{lat,lng},kind:'pickup',serviceType,
       label:count>1?`${count} requests`:'Request',onClick:()=>this.requestFeed.show(job.id)});
   }
   for(const id of this.requestMarkers)if(!next.has(id))this.map.removeMarker(id);
   this.requestMarkers=next;
 }
 readonly acting=signal(false);
 async performAction(){if(this.acting()||!this.onJobAction)return;this.acting.set(true);try{await this.modalController.dismiss();await this.onJobAction();}finally{this.acting.set(false);}}
 @Input() serviceType:ServiceTypeSlug='ride';
 @Input() destination!:{lat:number;lng:number}; @Input() address='';@Input() label='Destination';
 readonly journey=inject(JourneyTrackingService);private locations=inject(LocationService);private routing=inject(RoutingService);private modalController=inject(ModalController);
 readonly instruction=signal('Finding your route…');readonly summary=signal('Waiting for GPS');readonly error=signal('');readonly voice=signal(false);
 private map:MapComponent|null=null;private timer:ReturnType<typeof setInterval>|null=null;private route:NavigationRoute|null=null;
 private index=0;private requestAt=0;private busy=false;private destroyed=false;private lastPoint:{lat:number;lng:number}|null=null;private offRouteCount=0;private spoken='';private fallbackPoint:ReturnType<JourneyTrackingService['point']>=null;private gpsRequestAt=0;private gpsBusy=false;
 async ready(map:MapComponent){this.map=map;this.syncRequestMarkers();map.setCenter(this.destination.lng,this.destination.lat,14);map.addOrUpdateMarker({id:'journey-destination',coordinates:this.destination,kind:'destination',serviceType:this.serviceType,label:this.label});this.timer=setInterval(()=>{void this.tick();},2000);await this.tick();}
 private async tick(){
  if(this.destroyed||!this.map) return;
  let point=this.journey.point() || this.fallbackPoint;
  if((!point || Date.now()-point.time>15000) && !this.gpsBusy && Date.now()-this.gpsRequestAt>15000){
    this.gpsBusy=true;this.gpsRequestAt=Date.now();
    try{const position=await this.locations.getCurrentPosition();if(position){this.fallbackPoint={lat:position.coords.latitude,lng:position.coords.longitude,accuracy:position.coords.accuracy,heading:position.coords.heading,time:position.timestamp};point=this.fallbackPoint;}}catch{this.error.set('GPS is unavailable. Check location permission.');}finally{this.gpsBusy=false;}
  }
  if(this.destroyed) return;
  if(!point||Date.now()-point.time>45000){this.summary.set('Waiting for a fresh GPS position');return;}
  this.map.addOrUpdateMarker({id:'journey-driver',coordinates:point,kind:'driver',serviceType:this.serviceType,heading:point.heading||0,label:'YOU'});
  this.map.addOrUpdateMarker({id:'journey-destination',coordinates:this.destination,kind:'destination',serviceType:this.serviceType,label:this.label});
  if(!this.route){await this.load(point);return;}
  const progress=journeyProgress(this.route,point,this.index);this.index=progress.index;
  if(progress.offRoute){this.offRouteCount++;if(this.offRouteCount>=2 && Date.now()-this.requestAt>=30000) await this.load(point);return;}
  this.offRouteCount=0;this.error.set('');
  const arriving=(progress.remainingMeters||0)<30 && distanceMeters([point.lng,point.lat],[this.destination.lng,this.destination.lat])<40;
  const instruction=arriving?'You are near the destination':progress.step?.instruction||'Continue along the route';this.instruction.set(instruction);
  this.summary.set(`${((progress.remainingMeters||0)/1000).toFixed(1)} km · approximately ${Math.max(1,Math.ceil((progress.remainingSeconds||0)/60))} min`);
  if(this.voice() && this.spoken!==instruction && typeof speechSynthesis!=='undefined'){this.spoken=instruction;speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(instruction));}
  if(!this.lastPoint||distanceMeters([point.lng,point.lat],[this.lastPoint.lng,this.lastPoint.lat])>10){this.map.setCenter(point.lng,point.lat,16);this.lastPoint=point;}
 }
 private async load(point:{lat:number;lng:number}){
  if(this.busy || this.destroyed || (this.requestAt && Date.now()-this.requestAt<30000)) return;
  this.busy=true;this.requestAt=Date.now();
  try{const route=await firstValueFrom(this.routing.getNavigationRoute(point,this.destination));if(this.destroyed) return;if(!route) throw new Error('Route unavailable');
    this.route=route;this.index=0;this.offRouteCount=0;this.error.set('');this.instruction.set(route.steps[0]?.instruction||'Follow the route');
    this.map?.setCenter(point.lng,point.lat,16);
    this.map?.drawRoute({distanceMeters:route.distanceMeters,durationSeconds:route.durationSeconds,geometry:{type:'LineString',coordinates:route.coordinates}});
  }catch{this.error.set('Directions are unavailable right now. Retry or choose Other maps.');}finally{this.busy=false;}
 }
 retry(){this.requestAt=0;this.route=null;void this.tick();}
 external(){window.open(`https://www.google.com/maps/dir/?api=1&destination=${this.destination.lat},${this.destination.lng}`,'_blank','noopener,noreferrer');}
 close(){void this.modalController.dismiss();}
 ngOnDestroy(){this.destroyed=true;if(this.timer)clearInterval(this.timer);if(this.voice()&&typeof speechSynthesis!=='undefined')speechSynthesis.cancel();}
}
