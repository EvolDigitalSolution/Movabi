import {beforeEach, describe, expect, it, vi} from 'vitest';
const state=vi.hoisted(()=>({db:null as any,profiles:[] as any[],rpcError:null as any,pilot:true}));
vi.mock('../../server/services/supabase.service',()=>({getSupabaseAdmin:()=>state.db,supabaseAdmin:{}}));
vi.mock('../../server/services/stripe.service',()=>({stripe:{}}));
import {DispatchService} from '../../server/services/dispatch.service';
const tenant='11111111-1111-4111-8111-111111111111';
const enrolled='22222222-2222-4222-8222-222222222222';
const other='33333333-3333-4333-8333-333333333333';
const job:any={service_slug:'ride',payment_method:'cash',payment_status:'cash_pending',payment_intent_id:null,
 tenant_id:tenant,country_code:'GB',currency_code:'GBP',metadata:{cash_collection_mode:'full_customer_charge'},pickup_lat:51,pickup_lng:0};
function profile(id:string,extra:any={}){return {id,role:'driver',tenant_id:tenant,registration_country_code:'GB',country_code:'GB',lat:51,lng:0,
 is_online:true,is_available:true,charges_enabled:false,payouts_enabled:false,full_name:'Test Driver',phone:'07000000000',current_address:'1 High Street',date_of_birth:'1990-01-01',accepted_driver_agreement_at:'2026-01-01',right_to_work_url:'rtw.pdf',driver_license_url:'dl.pdf',driver_license_expiry:'2030-01-01',insurance_url:'ins.pdf',insurance_expiry:'2030-01-01',driver_service_types:['ride'],is_verified:true,verification_status:'approved',council_name:'Oldham',council_license_number:'C1',taxi_badge_number:'B1',taxi_license_expiry:'2030-01-01',private_hire_vehicle_license_url:'phv.pdf',private_hire_insurance_url:'phi.pdf',...extra};}
beforeEach(()=>{
 state.profiles=[profile(enrolled),profile(other,{charges_enabled:true,payouts_enabled:true})];state.rpcError=null;state.pilot=true;
 state.db={from(table:string){let filters:Array<(r:any)=>boolean>=[];const q:any={select:()=>q,eq:(k:string,v:any)=>{filters.push(r=>r[k]===v);return q;},in:(k:string,v:any[])=>{filters.push(r=>v.includes(r[k]));return q;},gte:()=>q,lte:()=>q,limit:()=>q,or:()=>q,then:(ok:any,no:any)=>{
 const rows=table==='profiles'?state.profiles:table==='vehicles'?state.profiles.map(p=>({id:'v'+p.id,user_id:p.id,vehicle_class:'car',type:'car',make:'Ford',model:'Focus',color:'Blue',year:2020,license_plate:'AB12 CDE',capacity:'standard',service_eligibility:['ride'],status:'saved'})):[];
 return Promise.resolve({data:rows.filter(r=>filters.every(f=>f(r))),error:null}).then(ok,no);}};return q;},rpc:vi.fn(async(_name:string,{p_driver_id:id}:any)=>({error:state.rpcError,data:{driverId:id,tenantId:tenant,country:'GB',currency:'GBP',pilotEnabled:state.pilot,enrolled:id===enrolled,balance:{currency:'GBP',consistent:true,availableMinor:'10000',heldMinor:'0',deficitMinor:'0',eligibleDepositsMinor:'10000'},topupAvailable:false,payoutAvailable:false,acceptanceAuthority:'database'}}))};
});
const candidates=(patch:any={})=>(new DispatchService() as any).findNearbyDrivers({...job,...patch},tenant,null,true);
describe('cash dispatch uses the enrolled native-market cohort',()=>{
 it('offers cash to the enrolled driver without Stripe payouts and excludes an unenrolled Stripe-ready driver',async()=>expect((await candidates()).map((p:any)=>p.id)).toEqual([enrolled]));
 it('card rides retain Stripe payout filters and do not read cash credit',async()=>{expect((await candidates({payment_method:'card'})).map((p:any)=>p.id)).toEqual([other]);expect(state.db.rpc).not.toHaveBeenCalled();});
 it('retains document, account and market/tenant checks',async()=>{state.profiles=[profile(enrolled,{driver_license_url:null}),profile(other,{tenant_id:other})];expect(await candidates()).toEqual([]);});
 it('excludes enrolled drivers outside the service market',async()=>{state.profiles=[profile(enrolled,{registration_country_code:'NG',country_code:'NG'})];expect(await candidates()).toEqual([]);});
 it('pilot off never falls back to Stripe readiness',async()=>{state.pilot=false;expect(await candidates()).toEqual([]);});
 it('unexpected cohort read errors fail a strict availability read',async()=>{state.rpcError={message:'database unavailable'};await expect(candidates()).rejects.toMatchObject({code:'CASH_CREDIT_UNAVAILABLE'});});
 it('cash metadata cannot bypass the full-customer-charge acquisition guard',async()=>expect(await candidates({metadata:{cash_collection_mode:'fee_only'}})).toEqual([]));
});
