import {describe,it,expect,vi} from 'vitest';
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{}}));
import {PaymentAuthorityService} from '../../server/services/payment-authority.service';
import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {PaymentMarginService} from '../../server/services/payment-margin.service';
import {FareSplitService} from '../../server/services/fare-split.service';
function pricing(){const c:any={exports:{},console,require:(name:string)=>name.includes('payment-margin')?{PaymentMarginService}:name.includes('fare-split')?{FareSplitService}:name.includes('no-show')?{NoShowService:{computeNoShowSplit:()=>({})}}:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/services/pricing.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,c);return c.exports.PricingService;}
const snapshot={policyVersion:'fare-split-v1',currency:'GBP',customerCharge:6.71,customerServiceTotal:6.71,driverBase:6.39,platformFeeAmount:.32,commissionPercent:15,driverCommissionAmount:.96,driverEntitlement:5.43,shoppingBudget:0,paymentMargin:{policy:{paymentPercent:3.25,paymentFixed:.2,operatingAllowance:.1,minimumContribution:.5}}};
describe('negotiated payment and settlement alignment',()=>{
 it.each(['ride','delivery','errand','van-moving'])('keeps agreed fees consistent for %s',service_slug=>{
  const update=pricing().applyAgreedFare({service_slug,total_price:6.71,commission_rate_used:null,commission_fee:0,currency_code:'GBP',fare_breakdown:snapshot},6.04);
  expect(update).toMatchObject({total_price:6.04,driver_payout:4.89,platform_fee:.29,commission_rate_used:15});
  expect(update.fare_breakdown).toMatchObject({customerCharge:6.04,customerServiceTotal:6.04,driverEntitlement:4.89,driverPayout:4.89,driverCommissionAmount:.86,commissionPercent:15});
  expect(()=>PaymentAuthorityService.assertFrozenServiceFare({...update,currency_code:'GBP'},6.04)).not.toThrow();
 });
 it('rejects the observed stale snapshot before payment',()=>{expect(()=>PaymentAuthorityService.assertFrozenServiceFare({fare_breakdown:snapshot,currency_code:'GBP'},6.04)).toThrow('reconciliation');});
 it('does not waive commission because a database field is null',()=>{const u=pricing().applyAgreedFare({total_price:6.71,commission_rate_used:null,fare_breakdown:snapshot},6.04);expect(u.commission_rate_used).toBe(15);});
 it('replays an already-scaled snapshot without scaling twice',()=>{const p=pricing();const first=p.applyAgreedFare({total_price:6.71,fare_breakdown:snapshot},6.04);const second=p.applyAgreedFare({...first,total_price:6.71},6.04);expect(second.driver_payout).toBe(first.driver_payout);expect(second.platform_fee).toBe(first.platform_fee);});
 it('rejects malformed conservation of customer money',()=>{expect(()=>PaymentAuthorityService.assertFrozenServiceFare({fare_breakdown:{...snapshot,driverEntitlement:6}},6.71)).toThrow('reconciliation');});
 it('retains a frozen subscriber waiver after labels change',()=>{const u=pricing().applyAgreedFare({pricing_plan_used:'starter',fare_breakdown:{...snapshot,commissionPercent:0,driverCommissionAmount:0,driverEntitlement:6.39,paymentMargin:undefined}},6.04);expect(u.driver_payout).toBe(5.75);expect(u.commission_rate_used).toBe(0);});
 it('does not treat an unsupported legacy snapshot as a new policy',()=>{expect(()=>PaymentAuthorityService.assertFrozenServiceFare({fare_breakdown:{}},6.04)).not.toThrow();});
});
function completionFixture(options:any={}) {
 const captures:any[]=[],queues:any[]=[],transfers:any[]=[];
 const adjusted=pricing().applyAgreedFare({total_price:6.71,fare_breakdown:snapshot},6.04);
 const job={...adjusted,id:'job',driver_id:'driver',customer_id:'customer',status:'in_progress',payment_status:'authorized',payment_method:'card',payment_intent_id:'pi_job',currency_code:'GBP',...options.job};
 const db={from:(table:string)=>{const c:any={select:()=>c,eq:()=>c,ilike:()=>c,maybeSingle:async()=>({data:table==='jobs'?job:table==='profiles'?{stripe_account_id:'acct_driver'}:null})};return c;},rpc:async(name:string,args:any)=>{queues.push({name,args});return {data:[{...job,status:'completed'}]};}};
 const stripe={paymentIntents:{retrieve:async()=>({status:'requires_capture',currency:'gbp',amount_capturable:604,...options.intent}),capture:async(id:string,args:any,key:any)=>{captures.push({id,args,key});return {status:'succeeded'};}}};
 const c:any={exports:{},console,require:(name:string)=>{
 if(name.includes('job-payout.service'))return {JobPayoutService:{process:async(id:string)=>transfers.push(id)}};
 if(name.includes('payment-authority'))return {PaymentAuthorityService:{resolve:async()=>{PaymentAuthorityService.assertFrozenServiceFare(job,6.04);return {serviceFareMajor:6.04};},assertFrozenServiceFare:PaymentAuthorityService.assertFrozenServiceFare,isErrand:()=>false}};
 if(name.includes('fare-split'))return {FareSplitService};
 if(name.includes('stripe.service'))return {stripe};
 if(name.includes('supabase'))return {supabaseAdmin:db};
 if(name.includes('audit'))return {AuditService:{logBooking:async()=>{}}};return {};
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/services/logistics.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,c);
 const service=c.exports.LogisticsService;service.assertCompletionPin=async()=>({});
 return {service,captures,queues,transfers};
}
describe('completion capture and immediate payout boundary',()=>{
 it('captures GBP6.04, queues only GBP4.89 driver earnings and attempts transfer immediately',async()=>{
 const t=completionFixture();await t.service.completeJob('job',null,'driver');
 expect(t.captures[0].args.amount_to_capture).toBe(604);
 expect(t.queues[0].args.p_terms).toMatchObject({total:6.04,payout:4.89,platformFee:.29,commission:.86,amountMinor:489});
 expect(t.transfers).toEqual(['job']);
 });
 it('does not call Stripe capture or settlement with the stale GBP6.71 snapshot',async()=>{
 const t=completionFixture({job:{fare_breakdown:snapshot}});await expect(t.service.completeJob('job',null,'driver')).rejects.toThrow('reconciliation');expect(t.captures).toHaveLength(0);expect(t.queues).toHaveLength(0);
 });
 it('does not try a capture larger than the available authorization',async()=>{
 const t=completionFixture({intent:{amount_capturable:600}});await expect(t.service.completeJob('job',null,'driver')).rejects.toThrow('Authorized payment amount');expect(t.captures).toHaveLength(0);expect(t.queues).toHaveLength(0);
 });
 it('resumes a confirmed matching capture without charging again',async()=>{
 const t=completionFixture({intent:{status:'succeeded',amount_received:604}});await t.service.completeJob('job',null,'driver');expect(t.captures).toHaveLength(0);expect(t.transfers).toEqual(['job']);
 });
 it('refuses another driver before any payment side effect',async()=>{
 const t=completionFixture();await expect(t.service.completeJob('job',null,'other')).rejects.toThrow('Only the assigned');expect(t.captures).toHaveLength(0);expect(t.queues).toHaveLength(0);
 });
});
