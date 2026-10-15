import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PaymentMarginService } from '../../server/services/payment-margin.service';
function loadWorker(options: any = {}) {
  const updates: any[] = [], creates: any[] = [], finishes: any[] = [];
  const row = {job_id:'job',driver_id:'driver',destination:'acct_driver',amount_minor:624,currency:'gbp',status:'processing',attempt:1,token:'token',attempted_at:new Date().toISOString(),...options.row};
  const db = { rpc: async (name:string,args:any) => {
    if (name==='claim_queued_job_payout') return {data: options.noClaim?[]:[row]};
    finishes.push(args); return {data:!options.finishFailure,error:options.finishFailure?{}:null};
  }, from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:options.job || {payment_method:'wallet',payment_status:'paid'},error:options.jobError}),update:(value:any)=>{ updates.push(value); const chain:any={eq:()=>chain,in:()=>chain,select:async()=>({data:options.persistFailure?[]:[{job_id:'job'}]})};return chain;}})};
  const stripe = {paymentIntents:{retrieve:async()=>options.payment || {status:'succeeded',currency:'gbp',latest_charge:'ch_customer'}},charges:{retrieve:async()=>options.charge || {id:'ch_customer',payment_intent:'pi_customer',paid:true,captured:true,currency:'gbp',amount_captured:4100,amount_refunded:0}},transfers:{list:async()=>({data:options.transfers || [],has_more:!!options.hasMore}),create:async(payload:any,headers:any)=>{creates.push({payload,headers});if(options.failure)throw options.failure;return {id:'tr_new'};}},balance:{retrieve:async()=>({available:[{currency:'gbp',amount:options.balance ?? 1000}]})}};
  const context:any={exports:{},console,Date,setInterval,require:(name:string)=>name.includes('stripe.service')?{stripe}:name.includes('supabase.service')?{supabaseAdmin:db}:{PayoutEligibilityService:{assertEligible:async()=>{if(options.ineligible)throw Error('blocked');}}}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/services/job-payout.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {worker:context.exports.JobPayoutService,updates,creates,finishes};
}
describe('durable payout retries',()=>{
 it('sends only driver earnings from the captured card charge with zero available balance',async()=>{
  const t=loadWorker({balance:0,job:{payment_method:'card',payment_status:'paid',payment_intent_id:'pi_customer'}});
  await t.worker.process('job');expect(t.creates[0].payload).toMatchObject({amount:624,source_transaction:'ch_customer',destination:'acct_driver'});
  expect(t.updates[0].terms.payout_source_transaction).toBe('ch_customer');expect(t.finishes).toHaveLength(1);
 });
 it('never submits a transfer if its charge source cannot be persisted',async()=>{
  const t=loadWorker({persistFailure:true,job:{payment_method:'card',payment_status:'paid',payment_intent_id:'pi_customer'}});
  await expect(t.worker.process('job')).rejects.toThrow('source was not persisted');expect(t.creates).toHaveLength(0);
 });
 it('preserves a frozen charge on an ambiguous retry',async()=>{
  const t=loadWorker({balance:0,row:{status:'reconcile',terms:{payout_source_transaction:'ch_frozen'}}});await t.worker.process('job');
  expect(t.creates[0].payload.source_transaction).toBe('ch_frozen');expect(t.creates[0].headers.idempotencyKey).toBe('job-payout-v2-job-1');
 });
 it('keeps old ambiguous attempts balance-funded without changing their parameters',async()=>{
  const t=loadWorker({row:{status:'reconcile'},job:{payment_method:'card',payment_intent_id:'pi_customer',payment_status:'paid'}});
  await t.worker.process('job');expect(t.creates[0].payload.source_transaction).toBeUndefined();
 });
 it.each([
  {status:'requires_capture',currency:'gbp',latest_charge:'ch_customer'},
  {status:'succeeded',currency:'usd',latest_charge:'ch_customer'},
  {status:'succeeded',currency:'gbp',latest_charge:null},
  {status:'succeeded',currency:'gbp',latest_charge:'ch_customer',transfer_data:{destination:'acct_driver'}}
 ])('blocks an unsafe customer payment source',async(payment)=>{
  const t=loadWorker({payment,job:{payment_method:'card',payment_intent_id:'pi_customer',payment_status:'paid'}});
  await t.worker.process('job');expect(t.creates).toHaveLength(0);expect(t.updates[0].status).toBe('blocked');
 });
 it('blocks a refunded charge with insufficient remaining value',async()=>{
  const t=loadWorker({charge:{id:'ch_customer',payment_intent:'pi_customer',paid:true,captured:true,currency:'gbp',amount_captured:4100,amount_refunded:4000},job:{payment_method:'card',payment_intent_id:'pi_customer',payment_status:'paid'}});
  await t.worker.process('job');expect(t.creates).toHaveLength(0);expect(t.updates[0].status).toBe('blocked');
 });
 it('does not fall back to wallet funds when the card source lookup fails',async()=>{
  const t=loadWorker({jobError:{message:'offline'}});await t.worker.process('job');expect(t.creates).toHaveLength(0);expect(t.updates[0].last_error).toBe('payment_source_lookup_unavailable');
 });
 it('does nothing without a database lease',async()=>{const t=loadWorker({noClaim:true});await t.worker.process('job');expect(t.creates).toHaveLength(0);});
 it('keeps earnings pending when Stripe funds are unavailable',async()=>{const t=loadWorker({balance:0});await t.worker.process('job');expect(t.creates).toHaveLength(0);expect(t.updates[0].status).toBe('pending');});
 it('uses the persisted attempt as the idempotency key',async()=>{const t=loadWorker({row:{attempt:3}});await t.worker.process('job');expect(t.creates[0].headers.idempotencyKey).toBe('job-payout-v2-job-3');expect(t.finishes[0].p_transfer_id).toBe('tr_new');});
 it('reconciles a successful transfer without transferring again',async()=>{const t=loadWorker({transfers:[{id:'tr_existing',destination:'acct_driver',amount:624,currency:'gbp'}]});await t.worker.process('job');expect(t.creates).toHaveLength(0);expect(t.finishes[0].p_transfer_id).toBe('tr_existing');});
 it('blocks a mismatched existing transfer',async()=>{const t=loadWorker({transfers:[{id:'tr_existing',destination:'acct_driver',amount:600,currency:'gbp'}]});await t.worker.process('job');expect(t.creates).toHaveLength(0);expect(t.updates[0].status).toBe('blocked');});
 it('retains the same key after an ambiguous failure',async()=>{const t=loadWorker({failure:{statusCode:500}});await t.worker.process('job');expect(t.updates[0].status).toBe('reconcile');});
 it('allows a fresh attempt only after definitive balance rejection',async()=>{const t=loadWorker({failure:{statusCode:400,code:'balance_insufficient'}});await t.worker.process('job');expect(t.updates[0].status).toBe('pending');});
 it('blocks ambiguous retries outside the safe key window',async()=>{const t=loadWorker({row:{status:'reconcile',attempted_at:new Date(Date.now()-21*3600000).toISOString()}});await t.worker.process('job');expect(t.creates).toHaveLength(0);expect(t.updates[0].status).toBe('blocked');});
 it('does not create a fresh key when eligibility blocks an ambiguous attempt',async()=>{const t=loadWorker({row:{status:'reconcile'},ineligible:true});await t.worker.process('job');expect(t.updates[0].status).toBe('reconcile');});
 it('reports a local commit failure for reconciliation',async()=>{const t=loadWorker({finishFailure:true});await expect(t.worker.process('job')).rejects.toThrow('reconciliation');expect(t.creates).toHaveLength(1);});
});
describe('upfront payment margin protection',()=>{
 const policy={version:'test',currency:'GBP',paymentPercent:3.25,paymentFixed:.20,operatingAllowance:.10,minimumContribution:.50};
 it('protects the observed small fare without reducing driver earnings',()=>{const p=PaymentMarginService.protect(7.07,6.24,0,policy);expect(p.customerCharge).toBe(7.28);expect(p.contribution).toBeGreaterThanOrEqual(.50);});
 it('includes processing costs on shopping funds, without treating them as revenue',()=>{const p=PaymentMarginService.protect(10,9,100,policy);expect(p.customerCharge).toBeGreaterThan(13);expect(p.passes).toBe(true);});
 it('does not increase a quote already covering the allowance',()=>{expect(PaymentMarginService.protect(10,8,0,policy).adjustment).toBe(0);});
 it('rejects malformed frozen policies',()=>{expect(()=>PaymentMarginService.evaluate(10,8,0,{...policy,paymentPercent:NaN})).toThrow();});
 it('rejects negative shopping funding',()=>{expect(()=>PaymentMarginService.protect(10,8,-1,policy)).toThrow();});
});
function pricingFixture(issuing='false', cap=0) {
 const context:any={exports:{},console,process:{env:{STRIPE_ISSUING_ENABLED:issuing}},require:(name:string)=>{
  if(name.includes('issuing-capacity'))return {IssuingCapacityService:{assertAvailable:async()=>{}}};
  if(name.includes('payment-margin'))return {PaymentMarginService};
  if(name.includes('fare-split'))return {FareSplitService:{POLICY_VERSION:'fare-split-v1'}};
  if(name.includes('marketplace-config'))return {MarketplaceConfigService:{canonicalServiceSlug:(s:string)=>s}};
  return {};
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/services/pricing.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 const pricing=context.exports.PricingService;
 pricing.resolveUnprotectedPrice=async()=>({totalPrice:7.07,platformFee:.14,commissionFee:.69,commissionRateUsed:10,driverPayout:6.24,currencyCode:'GBP',pricingPlanUsed:'starter',fareBreakdown:{serviceFareBeforePlatformFee:6.93,platformFeePercent:2,platformFeeFixed:0,platformFeeMaximum:cap}});
 return pricing;
}
describe('canonical protected quote snapshot',()=>{
 it('keeps quote, capture and settlement numbers aligned',async()=>{
  const result=await pricingFixture().resolvePrice({serviceSlug:'ride'});
  expect(result.totalPrice).toBe(7.99);expect(result.driverPayout).toBe(6.24);
  expect(result.fareBreakdown.driverEntitlement).toBe(6.24);expect(result.fareBreakdown.driverCommissionAmount).toBe(.69);
  expect(result.fareBreakdown.customerCharge).toBe(7.99);expect(result.fareBreakdown.reconciliationValid).toBe(true);
  const potentialSubscribedPayout=result.driverPayout+result.commissionFee;
  expect(PaymentMarginService.evaluate(result.totalPrice,potentialSubscribedPayout,0,result.fareBreakdown.paymentMargin.policy).passes).toBe(true);
 });
 it('does not quote purchase funding when virtual-card funding is disabled',async()=>{
  await expect(pricingFixture().resolvePrice({serviceSlug:'errand',budget:10})).rejects.toThrow('temporarily unavailable');
 });
 it('preserves the requested budget even when base pricing uses a fallback',async()=>{
  const result=await pricingFixture('true').resolvePrice({serviceSlug:'errand',budget:10});
  expect(result.fareBreakdown.shoppingBudget).toBe(10);
  expect(result.fareBreakdown.totalAuthorisation).toBe(Math.round((result.totalPrice+10)*100)/100);
 });
 it('rejects an impossible protected quote instead of exceeding the fee cap',async()=>{
  await expect(pricingFixture('false',.20).resolvePrice({serviceSlug:'ride'})).rejects.toThrow('fee cap');
 });
});
