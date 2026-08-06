import {Injectable,inject,signal} from '@angular/core';
import {HttpClient,HttpErrorResponse,HttpHeaders} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {ApiUrlService} from './api-url.service';
import {SupabaseService} from './supabase/supabase.service';
export type MarketCapability='customer_app'|'customer_registration'|'driver_registration'|'driver_online'|'quote'|'booking'|'payment';
export interface PublicMarketStatus { code?:string|null;countryCode:string|null;marketCity:string|null;launchStatus:string;customerAppEnabled:boolean;
 customerRegistrationEnabled:boolean;driverRegistrationEnabled:boolean;driverOnlineEnabled:boolean;quoteEnabled:boolean;bookingEnabled:boolean;paymentEnabled:boolean;
 currency:string|null;timezone:string|null;title:string;message:string;waitingListEnabled:boolean;resolutionLevel:'zone'|'city'|'country'|'unavailable'; }
export interface DriverOnlineEligibility {allowed:boolean;code:string;title:string;message:string;action:string|null;blockers:string[];}
@Injectable({providedIn:'root'})
export class MarketAvailabilityClientService{
 private http=inject(HttpClient);private api=inject(ApiUrlService);private supabase=inject(SupabaseService);readonly current=signal<PublicMarketStatus|null>(null);
 async resolve(input:{countryCode?:string|null;marketCity?:string|null;zoneId?:string|null;capability?:MarketCapability}):Promise<PublicMarketStatus>{
  try{const status=await firstValueFrom(this.http.post<PublicMarketStatus>(this.api.getApiUrl('/api/markets/resolve'),input));this.current.set(status);return status;}
  catch(error:any){const status=error?.error as PublicMarketStatus;if(status?.code){this.current.set(status);throw new Error(status.message||status.title||'Movabi is not available in this area yet.');}throw error;}
 }
 async getStatus(input:{countryCode?:string|null;marketCity?:string|null;zoneId?:string|null}):Promise<PublicMarketStatus>{
  const params=new URLSearchParams();if(input.countryCode)params.set('countryCode',input.countryCode);if(input.marketCity)params.set('marketCity',input.marketCity);if(input.zoneId)params.set('zoneId',input.zoneId);
  const status=await firstValueFrom(this.http.get<PublicMarketStatus>(`${this.api.getApiUrl('/api/markets/status')}?${params.toString()}`));this.current.set(status);return status;
 }
 async joinWaitingList(email:string,status:PublicMarketStatus):Promise<void>{await firstValueFrom(this.http.post(this.api.getApiUrl('/api/markets/waitlist'),{email,countryCode:status.countryCode,marketCity:status.marketCity}));}
 async setDriverOnline(input:{online:boolean;countryCode?:string|null;marketCity?:string|null;zoneId?:string|null;locationPermission?:boolean}):Promise<void>{
  const result=await this.authenticatedDriverOnline(input,true);if(!result.allowed)throw result;
 }
 private async authenticatedDriverOnline(input:{online:boolean;countryCode?:string|null;marketCity?:string|null;zoneId?:string|null;locationPermission?:boolean},allowRefresh:boolean):Promise<DriverOnlineEligibility>{
  const{data}=await this.supabase.auth.getSession();const token=data.session?.access_token;if(!token)throw new Error('Your session expired. Please sign in again.');
  try{return await firstValueFrom(this.http.post<DriverOnlineEligibility>(this.api.getApiUrl('/api/markets/driver-online'),input,{headers:new HttpHeaders({Authorization:`Bearer ${token}`})}));}
  catch(error:unknown){if(error instanceof HttpErrorResponse&&error.status===401){if(allowRefresh){const{data:refreshed,error:refreshError}=await this.supabase.auth.refreshSession();if(refreshError||!refreshed.session?.access_token)throw new Error('Your session expired. Please sign in again.');return this.authenticatedDriverOnline(input,false);}throw new Error('Your session expired. Please sign in again.');}const body=error instanceof HttpErrorResponse?error.error:null;if(body?.code&&body?.title&&body?.message)throw body as DriverOnlineEligibility;if(body?.market?.message)throw new Error(body.market.message);throw error;}
 }
 async requireDriverRegistration(input:{countryCode?:string|null;marketCity?:string|null;zoneId?:string|null}):Promise<void>{
  try{await firstValueFrom(this.http.post(this.api.getApiUrl('/api/markets/driver-registration/check'),input));}
  catch(error:any){const body=error?.error;throw new Error(body?.market?.message||body?.error||'Driver onboarding is not available in this area yet.');}
 }
}
