import {describe,it,expect} from 'vitest';
import {FlutterwaveWalletCollection} from '../../server/services/payments/flutterwave-wallet-collection';
const expected={reference:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',merchantAccountRef:'synthetic-flw',providerAccountId:'17321',currency:'NGN',exponent:2,amountMinor:10500};
function fixture(data:Record<string,unknown>={}){
 let saved:any=null;const observations:any[]=[];let sent:any=null;
 const adapter=new FlutterwaveWalletCollection('FLWSECK_TEST-synthetic','synthetic-flw',{
  begin:async(_reference,request)=>{if(saved)return false;saved={request,state:'started'};return true;},finish:async(_reference,state)=>{saved.state=state;},get:async()=>saved,
  observe:async(_reference,evidence)=>{observations.push(evidence);},
 },'synthetic-webhook',async(_url,init)=>{
  if(String(_url).includes('/transactions/fee'))return new Response(JSON.stringify({status:'success',data:{charge_amount:data.estimate??'105',fee:'7.50',currency:'NGN'}}));
  if(init?.method==='POST'){sent=JSON.parse(String(init.body));return new Response(JSON.stringify({status:'success',data:{link:'https://checkout.flutterwave.com/synthetic'}}));}
  return new Response(JSON.stringify({status:'success',data:{tx_ref:expected.reference,account_id:17321,payment_type:'card',amount:'105',charged_amount:'105',currency:'NGN',status:'successful',app_fee:'7.50',merchant_fee:'0',amount_settled:'97.50',...data}}));
 });
 return {adapter,observations,sent:()=>sent};
}
describe('Flutterwave card fee-passing protection',()=>{
 it('blocks an extra estimated charge before any hosted checkout submission',async()=>{
  const f=fixture({estimate:'106'});await expect(f.adapter.preflight({...expected,email:'driver@example.test',redirectUrl:'https://app.example/return'})).rejects.toMatchObject({code:'PAYMENT_CHECKOUT_TOTAL_MISMATCH'});
  expect(f.sent()).toBeNull();expect(f.observations[0]).toMatchObject({source:'server-fee-query',chargedAmountMajor:'106'});
 });
 it('requests only cards and records actual provider cost separately from the Card fee',async()=>{
  const f=fixture();await f.adapter.createCheckout({...expected,email:'driver@example.test',redirectUrl:'http://localhost:3000/driver-topup-return'});
  expect(f.sent()).toMatchObject({amount:'105',payment_options:'card'});
  expect((await f.adapter.verify(expected)).chargedAmountMinor).toBe(10500);
  expect(f.observations[0]).toMatchObject({chargedAmountMajor:'105',appFeeMajor:'7.50',amountSettledMajor:'97.50'});
  expect(Object.keys(f.observations[0])).not.toContain('customer');
 });
 it.each([{charged_amount:'106'},{charged_amount:null},{amount:'100'},{payment_type:'bank_transfer'},{account_id:999}])('refuses unagreed amount/method/account %j',async mismatch=>{
  const f=fixture(mismatch);await f.adapter.createCheckout({...expected,email:'driver@example.test',redirectUrl:'https://app.example/driver-topup-return'});
  await expect(f.adapter.verify(expected)).rejects.toThrow();expect(f.observations).toHaveLength(1);
 });
 it('preserves raw JSON monetary decimals near the safe integer limit',async()=>{
  let saved:any=null;
  const adapter=new FlutterwaveWalletCollection('FLWSECK_TEST-synthetic','synthetic-flw',{begin:async(_r,request)=>{saved={request,state:'started'};return true;},finish:async()=>{saved.state='submitted';},get:async()=>saved},'synthetic-webhook',async(_url,init)=>new Response(init?.method==='POST'?'{"status":"success","data":{"link":"https://checkout.flutterwave.com/synthetic"}}':`{"status":"success","data":{"tx_ref":"${expected.reference}","account_id":17321,"payment_type":"card","amount":90071992547409.91,"charged_amount":90071992547409.91,"currency":"NGN","status":"successful"}}`));
  const terms={...expected,amountMinor:Number.MAX_SAFE_INTEGER};await adapter.createCheckout({...terms,email:'driver@example.test',redirectUrl:'https://app.example/return'});
  expect((await adapter.verify(terms)).chargedAmountMinor).toBe(Number.MAX_SAFE_INTEGER);
 });
});
