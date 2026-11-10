import {Injectable,inject,signal} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {defer,from,map,of,switchMap,catchError,shareReplay,Observable} from 'rxjs';
import {SupabaseService} from '../supabase/supabase.service';
import {ApiUrlService} from '../api-url.service';
import {AppConfigService} from '../config/app-config.service';
import {AutocompleteResult} from '../../models/maps/route-result.model';
import {NavigationRoute} from '../../../shared/utils/journey-progress';
interface Point{lat:number;lng:number;}
interface RemoteConfiguration{search:boolean;routing:boolean;}
@Injectable({providedIn:'root'})
export class RemoteMapsService {
 private http=inject(HttpClient);private auth=inject(SupabaseService);private api=inject(ApiUrlService);private config=inject(AppConfigService);
 readonly searchAttribution=signal('');
 private configurationCache:{until:number;value:Observable<RemoteConfiguration>}|null=null;
 private request<T>(operation:string,body?:any):Observable<T>{return defer(()=>from(this.auth.auth.getSession())).pipe(switchMap(({data})=>{
  const token=data.session?.access_token;if(!token)throw Object.assign(Error('Sign in to use address search and routing.'),{code:'MAP_AUTH_REQUIRED'});
  const url=this.api.getApiUrl('/api/maps-v23/'+operation),options={headers:{Authorization:'Bearer '+token}};
  return body===undefined?this.http.get<T>(url,options):this.http.post<T>(url,body,options);
 }));}
 configuration():Observable<RemoteConfiguration>{
  if(this.configurationCache&&this.configurationCache.until>Date.now())return this.configurationCache.value;
  const value=this.request<RemoteConfiguration>('configuration').pipe(catchError(e=>{
   if(e?.status===404||e?.code==='MAP_AUTH_REQUIRED')return of({search:false,routing:false});throw e;
  }),shareReplay({bufferSize:1,refCount:false}));
  this.configurationCache={until:Date.now()+30000,value};return value;
 }
 search(query:string,origin?:Point):Observable<AutocompleteResult[]>{return this.request<{results:AutocompleteResult[];attribution:string}>('search',{query,global:true,origin}).pipe(map(r=>{this.searchAttribution.set(r.attribution||'© Mapbox');return r.results;}));}
 reverseContext(point:Point):Observable<{label:string;countryCode:string}>{return this.request<{label:string;countryCode:string}>('reverse',{point});}
 reverse(point:Point):Observable<string>{return this.request<{label:string}>('reverse',{point}).pipe(map(r=>r.label));}
 route(start:Point,end:Point):Observable<NavigationRoute&{geometry:any;bounds:[[number,number],[number,number]]}>{return this.request<any>('route',{start,end});}
}
