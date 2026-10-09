import { ServiceTypeSlug } from '../../../../../core/models/maps/map-marker.model';
import { Component, Input, OnDestroy, inject, signal } from '@angular/core';
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
 template:`<ion-header><ion-toolbar><ion-title>Journey navigation</ion-title><ion-buttons slot="end"><ion-button (click)="close()">Close</ion-button></ion-buttons></ion-toolbar></ion-header>
 <ion-content><div class="flex min-h-full flex-col bg-slate-50">
 <div class="border-b border-slate-200 bg-white p-4"><p class="text-xs font-bold uppercase text-slate-500">{{label}}</p><p class="mt-1 text-sm font-semibold text-slate-900">{{address}}</p></div>
 <div style="height:52dvh"><app-map (ready)="ready($event)"></app-map></div>
 <div class="space-y-3 p-4 pb-8"><div class="rounded-2xl border border-amber-200 bg-amber-50 p-4"><p class="text-lg font-bold text-slate-900">{{instruction()}}</p><p class="mt-2 text-sm text-slate-600">{{summary()}}</p></div>
 @if(error()){<p class="rounded-xl bg-white p-3 text-sm text-slate-600">{{error()}}</p><button class="rounded-xl bg-amber-500 px-4 py-3 font-bold" (click)="retry()">Retry route</button>}
 <div class="flex gap-3"><button class="flex-1 rounded-xl border border-slate-200 bg-white p-3 font-bold text-slate-800" (click)="voice.set(!voice())">Voice {{voice()?'on':'off'}}</button><button class="flex-1 rounded-xl border border-slate-200 bg-white p-3 font-bold text-slate-800" (click)="external()">Other maps</button></div>
 <p class="text-xs text-slate-500">Road directions and estimated travel time. Follow road signs and current conditions.</p></div></div></ion-content>`})
export class JourneyNavigationComponent implements OnDestroy {
 @Input() serviceType:ServiceTypeSlug='ride';
 @Input() destination!:{lat:number;lng:number}; @Input() address='';@Input() label='Destination';
 readonly journey=inject(JourneyTrackingService);private locations=inject(LocationService);private routing=inject(RoutingService);private modal=inject(ModalController);
 readonly instruction=signal('Finding your route…');readonly summary=signal('Waiting for GPS');readonly error=signal('');readonly voice=signal(false);
 private map:MapComponent|null=null;private timer:ReturnType<typeof setInterval>|null=null;private route:NavigationRoute|null=null;
 private index=0;private requestAt=0;private busy=false;private destroyed=false;private lastPoint:{lat:number;lng:number}|null=null;private offRouteCount=0;private spoken='';private fallbackPoint:ReturnType<JourneyTrackingService['point']>=null;private gpsRequestAt=0;private gpsBusy=false;
 async ready(map:MapComponent){this.map=map;this.timer=setInterval(()=>{void this.tick();},2000);await this.tick();}
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
    this.map?.drawRoute({distanceMeters:route.distanceMeters,durationSeconds:route.durationSeconds,geometry:{type:'LineString',coordinates:route.coordinates}});
  }catch{this.error.set('Directions are unavailable right now. Retry or choose Other maps.');}finally{this.busy=false;}
 }
 retry(){this.requestAt=0;this.route=null;void this.tick();}
 external(){window.open(`https://www.google.com/maps/dir/?api=1&destination=${this.destination.lat},${this.destination.lng}`,'_blank','noopener,noreferrer');}
 close(){void this.modal.dismiss();}
 ngOnDestroy(){this.destroyed=true;if(this.timer)clearInterval(this.timer);if(this.voice()&&typeof speechSynthesis!=='undefined')speechSynthesis.cancel();}
}
