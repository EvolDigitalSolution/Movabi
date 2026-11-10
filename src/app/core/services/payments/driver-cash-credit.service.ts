import {Injectable,inject,signal,computed,effect} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom,timeout} from 'rxjs';
import {SupabaseService} from '../supabase/supabase.service';
import {ApiUrlService} from '../api-url.service';
import {AuthService} from '../auth/auth.service';
import {DriverCashCreditReader,type DriverCashCreditViewState} from './driver-cash-credit-reader';
@Injectable({providedIn:'root'})
export class DriverCashCreditService {
 private readonly http=inject(HttpClient);private readonly supabase=inject(SupabaseService);
 private readonly api=inject(ApiUrlService);private readonly auth=inject(AuthService);
 private readonly state=signal<DriverCashCreditViewState>({owner:null,value:null,loading:false,error:''});
 private readonly reader=new DriverCashCreditReader(()=>this.auth.currentUser()?.id||null,owner=>this.fetch(owner),s=>this.state.set(s));
 readonly status=computed(()=>{const owner=this.auth.currentUser()?.id;const state=this.state();return owner&&state.owner===owner?state.value:null;});
 readonly loading=computed(()=>this.state().owner===this.auth.currentUser()?.id&&this.state().loading);
 readonly error=computed(()=>{const owner=this.auth.currentUser()?.id||null;const s=this.state();return s.owner===owner?s.error:'';});
 constructor(){effect(()=>this.reader.reset(this.auth.currentUser()?.id||null));}
 refresh(force=false){return this.reader.refresh(force);}
 private async fetch(owner:string):Promise<unknown> {
  const {data,error}=await this.supabase.auth.getSession();const session=data.session;
  if(error||!session?.access_token||session.user.id!==owner||this.auth.currentUser()?.id!==owner)throw Error('Please sign in again.');
  return firstValueFrom(this.http.get<unknown>(this.api.getApiUrl('/api/market-safety/driver-cash-credit'),
   {headers:{Authorization:'Bearer '+session.access_token}}).pipe(timeout(15000)));
 }
}
