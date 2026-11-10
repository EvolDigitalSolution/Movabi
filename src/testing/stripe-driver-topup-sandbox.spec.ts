import {describe,it,expect} from 'vitest';
import {StripeDriverTopupSandbox} from '../../server/services/payments/stripe-driver-topup-sandbox';
const input={reference:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',merchantAccountRef:'stripe-platform',providerAccountId:'acct_synthetic',currency:'GBP',exponent:2,amountMinor:10500,walletAmountMinor:10000,feeMinor:500,email:'driver@example.test',redirectUrl:'http://localhost:3000/driver-topup-return'};
function fixture(mode='success'){
 let record:any=null,pi:any=null,posts=0,options:any=null,params:any=null;const observations:any[]=[];
 const store={begin:async(_ref:string,request:any)=>{if(record)return false;record={request,state:'started'};return true;},finish:async(_ref:string,state:string,_url?:string,id?:string)=>{record.state=state;if(id)record.providerSessionId=id;},get:async()=>record,observe:async(_ref:string,e:any)=>{observations.push(e);}};
 const mkPi=(meta:any)=>({id:'pi_synthetic',livemode:false,status:'succeeded',amount:10500,amount_received:10500,currency:'gbp',client_secret:'pi_synthetic_secret_xxx',metadata:meta,latest_charge:{id:'ch_synthetic',amount:10500,currency:'gbp',paid:true,captured:true,refunded:false,amount_refunded:0,payment_method_details:{type:mode==='non-card'?'bank_transfer':'card'},balance_transaction:{id:'txn_synthetic',currency:'gbp',fee:700,net:9800}}});
 const sdk:any={accounts:{retrieve:async()=>({id:mode==='wrong-account'?'acct_other':'acct_synthetic'})},
  checkout:{sessions:{
   list:async()=>({data:[],has_more:false}),
   retrieve:async()=>{throw new Error('no session expected');},
  }},
  paymentIntents:{
   create:async(p:any,o:any)=>{posts++;params=p;options=o;pi=mkPi(p.metadata);if(mode==='timeout')throw Error('synthetic timeout');return pi;},
   retrieve:async()=>{const base=pi||mkPi(params?.metadata||{});return {...base,
    ...(mode==='wrong-total'?{amount:10600}:{})
    ,...(mode==='wrong-currency'?{currency:'usd'}:{})
    ,...(mode==='live'?{livemode:true}:{})
    ,...(mode==='wrong-reference'?{metadata:{...base.metadata,vaydu_driver_topup:'other'}}:{})};},
   search:async()=>({data:pi?[pi]:[]}),
  }};
 const adapter=new StripeDriverTopupSandbox(sdk,'sk_test_synthetic','stripe-platform',store);
 return {adapter,observations,posts:()=>posts,params:()=>params,options:()=>options,store};
}
describe('Stripe driver card sandbox adapter',()=>{
 it('issues an in-app PaymentIntent clientSecret for the fixed card total and verifies the paid amount with provider cost observed separately',async()=>{
  const f=fixture();const result=await f.adapter.createCheckout(input);
  expect(result.providerReference).toBe(input.reference);expect(result.clientSecret).toBe('pi_synthetic_secret_xxx');
  expect(f.params()).toMatchObject({amount:10500,currency:'gbp',payment_method_types:['card'],confirm:false});
  expect(f.params().metadata).toMatchObject({vaydu_driver_topup:input.reference,vaydu_account:'acct_synthetic',vaydu_merchant:'stripe-platform',vaydu_total:'10500'});
  expect(f.options().idempotencyKey).toBe('driver-topup:'+input.reference);
  expect((await f.adapter.verify(input)).chargedAmountMinor).toBe(10500);
  expect(f.observations[0]).toMatchObject({providerFeeApiMinor:'700',settlementNetApiMinor:'9800',settlementCurrency:'GBP'});
  await expect(f.adapter.createCheckout(input)).rejects.toThrow();expect(f.posts()).toBe(1);
 });
 it('reconciles a timed-out create by read-only PaymentIntent search without another create',async()=>{
  const f=fixture('timeout');await expect(f.adapter.createCheckout(input)).rejects.toThrow();
  expect((await f.adapter.verify(input)).finalStatus).toBe('succeeded');expect(f.posts()).toBe(1);
 });
 it.each(['wrong-total','wrong-currency','live','wrong-reference','non-card'])('does not confirm %s',async mode=>{
  const f=fixture(mode);await f.adapter.createCheckout(input);await expect(f.adapter.verify(input)).rejects.toThrow();
 });
 it('rejects wrong merchant key/account before creating checkout',async()=>{
  const f=fixture('wrong-account');await expect(f.adapter.createCheckout(input)).rejects.toThrow();expect(f.posts()).toBe(0);
 });
});
