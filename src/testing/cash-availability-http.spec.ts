import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import express from 'express';
const state=vi.hoisted(()=>({tenant:'11111111-1111-4111-8111-111111111111',country:'GB',currency:'GBP',negotiation:false,bidding:false,market:true,fees:true,profileError:false,fare:true}));
vi.mock('../../server/services/stripe.service',()=>({stripe:{}}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{auth:{getUser:async(token:string)=>({data:{user:token==='customer'?{id:'customer'}:null},error:null})},
 from(table:string){let filters:Array<[string,any]>=[];const result=()=>{
  const rows:any[]=table==='profiles'?[{id:'customer',tenant_id:state.tenant,role:'customer',account_status:'active'}]:table==='quote_market_adjustments'?[{quote_reference:'quote-cash-test',country_code:state.country,currency:state.currency,service_type:'ride',returned_customer_fare:10,protected_fare_snapshot:state.fare?{policyVersion:'fare-split-v1',platformFeeType:'percentage',commissionPercent:10,platformFeePercent:2}:null}]:table==='market_payment_routes'?[{country_code:'GB',currency_code:'GBP',method:'card',provider:'stripe',merchant_account_ref:'stripe-platform',preferred:true,enabled:true,merchant_approved:true,adapter_ready:true,payout_approved:false,capabilities:['authorise','capture','release']}]:[];
  return {data:rows.filter(r=>filters.every(([k,v])=>r[k]===v)),error:table==='profiles'&&state.profileError?{message:'fixture database unavailable'}:null};
 };const q:any={select:()=>q,eq:(k:string,v:any)=>{filters.push([k,v]);return q;},maybeSingle:async()=>({...result(),data:result().data[0]||null}),then:(ok:any,no:any)=>Promise.resolve(result()).then(ok,no)};return q;},
 rpc:async(name:string)=>name==='driver_cash_credit_market_enabled_v1e'?{data:state.market,error:null}:name==='active_cancellation_policy'?{data:state.fees?{enabled:true,fee_minor:300,fee_cap_minor:300,version:1}:null,error:null}:{data:null,error:null}
}}));
vi.mock('../../server/services/marketplace-config.service',()=>({MarketplaceConfigService:{determineJobModes:vi.fn(async()=>({negotiation:state.negotiation,bidding:state.bidding}))}}));
vi.mock('../../server/services/no-show.service',()=>({NoShowService:{getEnabledConfig:async()=>({noShowEnabled:false}),computeCurrentNoShowSplit:()=>({feeMinor:0})}}));
import bookingRouter from '../../server/routes/booking.routes';
import {MarketplaceConfigService} from '../../server/services/marketplace-config.service';
async function request(body:any={quoteId:'quote-cash-test'},token='customer'){
 const app=express();app.use(express.json());app.use('/api/booking',bookingRouter);const s=app.listen(0,'127.0.0.1');await new Promise<void>(r=>s.once('listening',r));
 try{const r=await fetch(`http://127.0.0.1:${(s.address() as any).port}/api/booking/cash/availability`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};}
 finally{await new Promise<void>(r=>s.close(()=>r()));}
}
beforeEach(()=>{Object.assign(state,{tenant:'11111111-1111-4111-8111-111111111111',country:'GB',currency:'GBP',negotiation:false,bidding:false,market:true,fees:true,profileError:false,fare:true});vi.stubEnv('VAYDU_CASH_RIDE_BOOKING','true');});
afterEach(()=>vi.unstubAllEnvs());
describe('real authenticated cash availability route and service policy',()=>{
 it('eligible GB fixed immediate ride returns market/native tenant and separate hold',async()=>{const r=await request();expect(r.status).toBe(200);expect(r.body).toMatchObject({available:true,holdAmountMinor:300,currency:'GBP',provider:'stripe',context:{countryCode:'GB',currency:'GBP',tenantId:state.tenant,serviceSlug:'ride'}});expect(r.cache).toContain('no-store');});
 it('does not use forged tenant, country or currency request fields',async()=>{const r=await request({quoteId:'quote-cash-test',tenantId:'other',country:'NG',currency:'NGN'});expect(r.body.context).toMatchObject({tenantId:state.tenant,countryCode:'GB',currency:'GBP'});expect(MarketplaceConfigService.determineJobModes).toHaveBeenLastCalledWith('ride',state.tenant);});
 it('no authenticated customer: hard 401',async()=>expect((await request(undefined,'')).status).toBe(401));
 it('unknown quote stays a real 404, not market unavailability',async()=>expect(await request({quoteId:'missing'})).toMatchObject({status:404,body:{code:'QUOTE_NOT_VERIFIED'}}));
 it('feature flag remains required',async()=>{vi.stubEnv('VAYDU_CASH_RIDE_BOOKING','false');expect((await request()).body).toMatchObject({available:false,code:'CASH_BOOKING_DISABLED'});});
 it('market enablement remains required',async()=>{state.market=false;expect((await request()).body).toMatchObject({available:false,code:'CASH_MARKET_NOT_ENABLED'});});
 it('missing native tenant is specifically unavailable',async()=>{state.tenant='';expect((await request()).body).toMatchObject({available:false,code:'CASH_MARKET_UNAVAILABLE'});});
 it.each(['negotiation','bidding'] as const)('%s fare cannot be offered cash',async mode=>{state[mode]=true;expect((await request()).body).toMatchObject({available:false,code:'CASH_FIXED_FARE_ONLY'});});
 it('scheduled ride is specifically refused',async()=>expect((await request({quoteId:'quote-cash-test',scheduledTime:new Date(Date.now()+3600000).toISOString()})).body).toMatchObject({available:false,code:'CASH_IMMEDIATE_ONLY'}));
 it('missing canonical fare terms are reported before creation',async()=>{state.fare=false;expect((await request()).body).toMatchObject({available:false,code:'CASH_FARE_TERMS_UNAVAILABLE'});});
 it('missing native-tenant fee terms never creates a zero hold',async()=>{state.fees=false;expect((await request()).body).toMatchObject({available:false,code:'CASH_FEE_TERMS_UNAVAILABLE',reason:'No fee terms apply, so a cash ride cannot be secured'});});
});
