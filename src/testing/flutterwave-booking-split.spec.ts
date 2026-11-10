import {describe,it,expect} from 'vitest';
import {FareSplitService} from '../../server/services/fare-split.service';
import {frozenBookingSplit,FlutterwaveBookingSplit} from '../../server/services/payments/flutterwave-booking-split';
import {FlutterwaveCollectionSubaccount} from '../../server/services/payments/flutterwave-collection-subaccount';
import {FlutterwaveBookingSplitService} from '../../server/services/flutterwave-booking-split.service';
function context(pro=false){
 const fare=FareSplitService.compute({baseServiceFare:10000,currency:'NGN',platformFee:{enabled:true,type:'fixed',percent:0,fixedAmount:300,minFee:0,maxFee:null,applyToServices:[],source:'test',configVersion:'configured-test'} as any,driverCommissionPercent:12,isPro:pro});
 const job:any={id:'11111111-1111-4111-8111-111111111111',customer_id:'customer',driver_id:'driver',tenant_id:'tenant',status:'completed',metadata:{driver_settlement_method:'split'},payment_status:'pending',payment_method:'card',country_code:'NG',currency_code:'NGN',price:fare.customerCharge,total_price:fare.customerCharge,fare_breakdown:fare};
 const scope:any={driverId:'driver',tenant:'tenant',country:'NG',currency:'NGN',account:{id:'account',subaccount_id:'RS_DRIVER'},market:{merchant_account_ref:'test-merchant',environment:'test',split_collection_approved:true,split_semantics_verified:true,fee_passing_verified:true,settlement_verified:true,provider_fee_budget_minor:10000,max_charge_minor:2000000}};
 return {job,scope,plan:()=>frozenBookingSplit(job,scope)};
}
describe('frozen booking fare controls splits, not wallet top-up fees',()=>{
 it('derives the exact fixed driver allocation from the existing configured fare authority',()=>{const h=context();const p=h.plan();expect(p.driverMinor).toBe(880000);expect(p.totalMinor).toBe(1030000);expect(p.vayduGrossMinor).toBe(150000);expect(p.platformFeeMinor).toBe(30000);expect(p.commissionMinor).toBe(120000);expect(p.subaccounts).toEqual([{id:'RS_DRIVER',transaction_charge_type:'flat_subaccount',transaction_charge:'8800'}]);expect(p.totalMinor).toBe(p.driverMinor+p.vayduGrossMinor);});
 it('preserves the configured Pro commission waiver',()=>{const p=context(true).plan();expect(p.commissionMinor).toBe(0);expect(p.driverMinor).toBe(1000000);});
 it.each([{metadata:{}},{metadata:{driver_settlement_method:'transfer'}},{status:'in_progress'},{status:'cancelled'},{driver_id:null},{driver_id:'other'},{tenant_id:'other'},{currency_code:'GBP'},{country_code:'GH'},{payment_method:'wallet'},{payment_method:'cash'},{payment_intent_id:'pi_existing'},{payment_status:'paid'},{no_show_status:'fee_charged'},{total_refunded_minor:1},{payout_transfer_id:'transfer'},{service_slug:'errand'}])('rejects unsuitable split booking %j',change=>{const h=context();Object.assign(h.job,change);expect(h.plan).toThrow();});
 it('does not replace frozen terms with a newly changed fare',()=>{const h=context();h.job.total_price++;expect(h.plan).toThrow();});
 it('rejects a nonconserving frozen breakdown',()=>{const h=context();h.job.fare_breakdown.driverEntitlement++;expect(h.plan).toThrow();});
 it('requires a reviewed margin for all provider deductions',()=>{const h=context();h.scope.market.provider_fee_budget_minor=150001;expect(h.plan).toThrow('deductions');});
 it.each(['split_semantics_verified','fee_passing_verified','settlement_verified','split_collection_approved'])('requires merchant evidence: %s',key=>{const h=context();h.scope.market[key]=false;expect(h.plan).toThrow('unverified');});
});
function provider(options:any={}){
 const calls:any[]=[];const h=context();const plan=h.plan(),reference='vaydu-split-'+h.job.id;
 const request:any=async(url:string,init:any)=>{
  const path=url.replace('https://api.flutterwave.com/v3','');const body=init.body?JSON.parse(init.body):null;calls.push({path,body});let data:any,meta:any;
  if(path.startsWith('/transactions/fee'))data={currency:'NGN',charge_amount:options.extraCharge?10301:10300,fee:10};
  else if(path==='/payments'){if(options.timeout)throw Error('timeout');data={link:'https://checkout.flutterwave.com/test'};}
  else if(path.startsWith('/transactions/verify'))data={id:77,status:'successful',tx_ref:reference,currency:'NGN',account_id:123,amount:10300,charged_amount:options.extraCharge?10301:10300,payment_type:'card',app_fee:10};
  else if(path.startsWith('/settlements?')){data=[{id:9}];meta={page_info:{total_pages:1}};}
  else if(path==='/settlements/9')data={id:9,status:options.pending?'pending':'completed',currency:'NGN',transactions:[{id:77,tx_ref:reference,status:'successful',currency:'NGN',subaccount_settlement:options.zeroAllocation?0:8800,app_fee:10,stampduty_charge:50}]};
  else throw Error('Unexpected request');return new Response(JSON.stringify({status:'success',data,meta}));
 };
 return {adapter:new FlutterwaveBookingSplit(new FlutterwaveCollectionSubaccount('FLWSECK_TEST-synthetic','synthetic-fingerprint-key-at-least-32',request),'123'),calls,plan,reference};
}
describe('Flutterwave split collection and settlement are distinct',()=>{
 it('uses the frozen flat_subaccount override, card only, and no transfer API',async()=>{const h=provider();await h.adapter.preflight(h.plan);await h.adapter.checkout(h.plan,h.reference,'customer@example.test','https://movabi-develop.apps.evolsolution.com/booking-payment-return');expect(h.calls.find(c=>c.path==='/payments').body).toMatchObject({payment_options:'card',subaccounts:h.plan.subaccounts});expect(h.calls.some(c=>c.path.includes('/transfers'))).toBe(false);});
 it('prevents additional provider fees being passed to the customer',async()=>{const h=provider({extraCharge:true});await expect(h.adapter.preflight(h.plan)).rejects.toThrow('unconfirmed');await expect(h.adapter.verify(h.plan,h.reference)).rejects.toThrow('not confirmed');});
 it('collection success does not establish driver settlement',async()=>{const h=provider({pending:true});expect(await h.adapter.verify(h.plan,h.reference)).toMatchObject({id:'77'});await expect(h.adapter.settlement(h.plan,h.reference,'77')).rejects.toThrow('pending');});
 it('requires exact driver allocation in a completed settlement',async()=>{const h=provider();expect(await h.adapter.settlement(h.plan,h.reference,'77')).toMatchObject({batchId:'9',driverMinor:880000,subaccountId:'RS_DRIVER'});});
 it('refuses the documented zero-allocation case instead of silently transferring',async()=>{const h=provider({zeroAllocation:true});await expect(h.adapter.settlement(h.plan,h.reference,'77')).rejects.toThrow('allocation');expect(h.calls.some(c=>c.path.includes('/transfers'))).toBe(false);});
});
describe('booking submission is durable and owner-bound',()=>{
 it('a timeout leaves the reservation submitted; a retry never calls checkout again',async()=>{
  const h=context();let state='reserved',submits=0;
  const chain:any={select:()=>chain,eq:()=>chain,single:async()=>({data:h.job})};
  const db:any={from:()=>chain,rpc:async(name:string,args:any)=>{
   if(name==='reserve_flutterwave_booking_split')return {data:[{terms:args.p_terms,state,reference:'vaydu-split-'+h.job.id}]};
   if(name==='claim_flutterwave_split_submission'){if(state!=='reserved')return {data:false};state='submitting';return {data:true};}throw Error('Unexpected RPC');}};
  const accounts:any={ready:async()=>h.scope};const adapter:any={preflight:async()=>{},checkout:async()=>{submits++;throw Error('timeout');}};
  const service=new FlutterwaveBookingSplitService(db,accounts,()=>adapter);
  await expect(service.checkout('customer',h.job.id,'customer@example.test',1030000)).rejects.toThrow();
  await expect(service.checkout('customer',h.job.id,'customer@example.test',1030000)).rejects.toThrow('already submitted');expect(submits).toBe(1);
 });
 it('rejects another customer even if a database fixture ignores owner filters',async()=>{const h=context();const chain:any={select:()=>chain,eq:()=>chain,single:async()=>({data:h.job})};const s=new FlutterwaveBookingSplitService({from:()=>chain} as any,{} as any,()=>{throw Error('must not create');});await expect(s.quote('other',h.job.id)).rejects.toThrow('unavailable');});
});
