import {inject,Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom,timeout} from 'rxjs';
import {ApiUrlService} from './api-url.service';
import {SupabaseService} from './supabase/supabase.service';
export interface StopRequestView {
  id:string;state:'awaiting_other'|'stop_agreed'|'disputed'|'expired';reason:string;note:string;
  customerConfirmed:boolean;driverConfirmed:boolean;createdAt:string;expiresAt:string;
  locationRecorded:boolean;supportReference:string;bookingChanged:boolean;
}
export interface StopPilotView {
  enabled:true;viewer:'customer'|'driver';canRequest:boolean;canRespond:boolean;request:StopRequestView|null;
  bookingUpdated:false;fareUpdated:false;
}
export interface FarePilotView {
 enabled:true;viewer:'customer'|'driver';bookingUpdated:false;paymentUpdated:false;
 proposal:null|{id:string;state:'proposed'|'agreed'|'rejected'|'stale'|'expired';currency:string;exponent:number;
 originalMinor:number;amountMinor:number;coveredMetres:number;plannedMetres:number;unusedQuotedMetres:number;
 customerAccepted:boolean;driverAccepted:boolean;expiresAt:string};
}
@Injectable({providedIn:'root'})
export class EarlyStopService {
  private http=inject(HttpClient);private api=inject(ApiUrlService);private supabase=inject(SupabaseService);
  private async options(){const {data}=await this.supabase.auth.getSession();if(!data.session?.access_token)throw Error('Please sign in again.');return {headers:{Authorization:'Bearer '+data.session.access_token}};}
  private url(id:string){return this.api.getApiUrl('/api/booking/early-stop/'+encodeURIComponent(id));}
  async fare(id:string,stopId:string):Promise<FarePilotView>{return firstValueFrom(this.http.get<FarePilotView>(this.url(id)+'/fare/'+encodeURIComponent(stopId),await this.options()).pipe(timeout(15000)));}
  async proposeFare(id:string,stopId:string):Promise<FarePilotView>{return firstValueFrom(this.http.post<FarePilotView>(this.url(id)+'/fare/'+encodeURIComponent(stopId)+'/proposal',{},await this.options()).pipe(timeout(15000)));}
  async voteFare(id:string,stopId:string,input:{proposalId:string;action:'accept'|'reject';note?:string}):Promise<FarePilotView>{return firstValueFrom(this.http.post<FarePilotView>(this.url(id)+'/fare/'+encodeURIComponent(stopId)+'/response',input,await this.options()).pipe(timeout(15000)));}
  async read(id:string):Promise<StopPilotView>{return firstValueFrom(this.http.get<StopPilotView>(this.url(id),await this.options()).pipe(timeout(15000)));}
  async request(id:string,input:{requestId:string;reason:string;note:string}):Promise<StopPilotView>{return firstValueFrom(this.http.post<StopPilotView>(this.url(id)+'/request',input,await this.options()).pipe(timeout(15000)));}
  async respond(id:string,input:{requestId:string;action:'confirm'|'dispute';note?:string}):Promise<StopPilotView>{return firstValueFrom(this.http.post<StopPilotView>(this.url(id)+'/response',input,await this.options()).pipe(timeout(15000)));}
}
