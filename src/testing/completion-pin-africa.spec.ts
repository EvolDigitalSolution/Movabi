import {beforeEach,describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({tables:{} as Record<string,any[]>,settlements:0}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{from(table:string){
 const filters:Array<(r:any)=>boolean>=[];const rows=()=> (state.tables[table]||[]).filter(r=>filters.every(f=>f(r)));
 const q:any={select:()=>q,eq:(k:string,v:any)=>{filters.push(r=>r[k]===v);return q;},
 maybeSingle:async()=>({data:rows()[0]||null,error:null}),then:(ok:any,no:any)=>Promise.resolve({data:rows(),error:null}).then(ok,no)};return q;
},rpc:async(name:string,a:any)=>{
 if(name==='record_pin_attempt')return {data:a.p_pin===a.p_expected?'ok':'wrong',error:null};
 if(name==='complete_job_with_pending_payout'){
  const j=state.tables.jobs.find(j=>j.id===a.p_job_id);
  if(!state.tables.job_payout_queue.length){state.settlements++;state.tables.job_payout_queue.push({job_id:j.id});j.status='completed';j.payment_status='paid';}
  return {data:[j],error:null};
 }throw Error('unexpected RPC '+name);
}}}));
// Only the external payout boundary/DB transport are fixtures. Actual PIN, ownership, state,
// frozen fare and completion logic run. No real provider integration/transfer is claimed.
vi.mock('../../server/services/driver-payment-account.service',()=>({DriverPaymentAccountService:class{async ready(){return {country:'NG',currency:'NGN',tenant:'t1',account:{id:'account'},market:{merchant_account_ref:'test'}};}},sandboxPayoutProvider:()=>({})}));
vi.mock('../../server/services/job-payout.service',()=>({JobPayoutService:{process:async()=>{}}}));
vi.mock('../../server/services/audit.service',()=>({AuditService:{logBooking:async()=>{}}}));
vi.mock('../../server/services/stripe.service',()=>({stripe:{paymentIntents:{retrieve:()=>{throw Error('unexpected capture');}}}}));
import {LogisticsService} from '../../server/services/logistics.service';
import {FareSplitService} from '../../server/services/fare-split.service';
import {marketPinPolicy,bookingPinMetadata} from '../../server/services/completion-pin-policy';
const countries=['NG','GH','KE','ZA','UG','TZ','RW','MW','EG','CM','CI','SN','ZM'];
const setting={markets:Object.fromEntries([...countries.map(c=>[c,'disabled']),['GB','required']])};
const id='71500000-0000-4000-8000-000000000001';
function job(country='NG'){
 const currency=country==='GB'?'GBP':'NGN';const split=FareSplitService.compute({baseServiceFare:20,currency,platformFee:null as any,driverCommissionPercent:10,isPro:false});
 const policy=marketPinPolicy(setting,country);
 const j={id,driver_id:'d1',customer_id:'c1',tenant_id:'t1',country_code:country,currency_code:currency,status:'in_progress',payment_method:'card',payment_status:'paid',service_slug:'ride',price:split.customerCharge,total_price:split.customerCharge,fare_breakdown:split,
 metadata:{...bookingPinMetadata(policy),completion_pin_effective:policy,completion_pin_driver_id:'d1',driver_settlement_method:'transfer'}};
 state.tables={jobs:[j],profiles:[{id:'d1',country_code:country,stripe_account_id:'acct_test'}],job_payout_queue:[],referrals:[],job_completion_secrets:country==='GB'?[{job_id:id,completion_pin:'1234'}]:[]};return j;
}
beforeEach(()=>{state.settlements=0;job();});
describe('explicit African market defaults through actual completion service',()=>{
 it('NG completes without PIN and a retry settles once (eligible provider fixture)',async()=>{
  expect((await LogisticsService.completeJob(id,undefined,'d1')).status).toBe('completed');
  await LogisticsService.completeJob(id,undefined,'d1');expect(state.settlements).toBe(1);
 });
 it('GB missing/wrong PIN rejected before settlement, correct PIN completes',async()=>{
  job('GB');await expect(LogisticsService.completeJob(id,undefined,'d1')).rejects.toThrow(/PIN is required/);
  await expect(LogisticsService.completeJob(id,'9999','d1')).rejects.toThrow(/incorrect/);expect(state.settlements).toBe(0);
  expect((await LogisticsService.completeJob(id,'1234','d1')).status).toBe('completed');expect(state.settlements).toBe(1);
 });
 it('disabled PIN never bypasses assignment, ownership or completion readiness',async()=>{
  await expect(LogisticsService.completeJob(id,undefined,'other')).rejects.toThrow(/assigned driver/);
  const j=state.tables.jobs[0];j.status='searching';await expect(LogisticsService.completeJob(id,undefined,'d1')).rejects.toThrow(/not ready/);
  j.driver_id=null;await expect(LogisticsService.completeJob(id,undefined,'d1')).rejects.toThrow(/without an assigned/);expect(state.settlements).toBe(0);
 });
 it('explicit codes do not classify every foreign market as Africa',()=>{
  for(const c of countries)expect(marketPinPolicy(setting,c)).toBe('disabled');
  for(const c of ['GB','FR','US','IN','AE','',null])expect(marketPinPolicy(setting,c)).toBe('required');
 });
});
