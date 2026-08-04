import{Injectable,inject}from'@angular/core';import{HttpClient,HttpHeaders}from'@angular/common/http';import{firstValueFrom}from'rxjs';
import{ApiUrlService}from'../../../core/services/api-url.service';import{SupabaseService}from'../../../core/services/supabase/supabase.service';
export interface MarketAvailabilityRow{[key:string]:any;id?:string;country_code:string;market_city?:string|null;zone_id?:string|null;launch_status:string;
 supported_currency?:string|null;timezone?:string|null;unavailable_title?:string|null;unavailable_message?:string|null;valid_from?:string|null;enabled:boolean;
 customer_app_enabled?:boolean;customer_registration_enabled?:boolean;driver_registration_enabled?:boolean;driver_online_enabled?:boolean;
 quote_enabled?:boolean;booking_enabled?:boolean;payment_enabled?:boolean;waiting_list_enabled?:boolean;}
@Injectable({providedIn:'root'})export class AdminMarketAvailabilityService{private http=inject(HttpClient);private api=inject(ApiUrlService);private supabase=inject(SupabaseService);
 private async headers(){const{data}=await this.supabase.auth.getSession();return new HttpHeaders({'Content-Type':'application/json',...(data.session?.access_token?{Authorization:`Bearer ${data.session.access_token}`}:{})});}
 async list(){return await firstValueFrom(this.http.get<MarketAvailabilityRow[]>(this.api.getApiUrl('/api/markets/admin'),{headers:await this.headers()}));}
 async save(row:MarketAvailabilityRow){const body={...row};return row.id?await firstValueFrom(this.http.put<MarketAvailabilityRow>(this.api.getApiUrl(`/api/markets/admin/${row.id}`),body,{headers:await this.headers()})):
  await firstValueFrom(this.http.post<MarketAvailabilityRow>(this.api.getApiUrl('/api/markets/admin'),body,{headers:await this.headers()}));}}
