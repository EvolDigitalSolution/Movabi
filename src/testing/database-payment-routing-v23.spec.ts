import {describe,it,vi,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import express from 'express';
import {loadDatabasePaymentPolicies,readDatabasePaymentAssignment} from '../../server/services/payments/market-payment-store';
import {selectMarketPayment} from '../../server/services/payments/market-payment-registry';
import {createMarketPaymentContextRouter} from '../../server/routes/market-payment-context.routes';
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{}}));
const gb=()=>({country_code:'GB',currency_code:'GBP',method:'card',provider:'stripe',merchant_account_ref:'stripe-platform',preferred:true,
 enabled:false,merchant_approved:false,adapter_ready:false,payout_approved:false,capabilities:[] as string[]});
const ng=()=>({...gb(),country_code:'NG',currency_code:'NGN',provider:'kora',merchant_account_ref:null});
const scope={country:'GB',currency:'GBP',method:'card'};
function fixture(data:any[]|null,error:any=null){
 const calls:any[]=[];const db={from:(table:string)=>{calls.push(['from',table]);const q:any={select:(fields:string)=>{calls.push(['select',fields]);return q;},eq:(key:string,value:any)=>{calls.push(['eq',key,value]);return q;},then:(resolve:any,reject:any)=>Promise.resolve({data,error}).then(resolve,reject)};return q;}};return{db,calls};
}
describe('database country/currency/provider mapping',()=>{
 it('resolves assigned GB/GBP to Stripe without treating assignment as approval',async()=>{const f=fixture([gb()]);const view=await readDatabasePaymentAssignment(f.db,scope);assert.equal(view.provider,'stripe');assert.equal(view.assigned,true);assert.equal(view.routeEnabled,false);});
 it('resolves assigned NG/NGN to Kora without an invented merchant account',async()=>{const f=fixture([ng()]);const view=await readDatabasePaymentAssignment(f.db,{country:'NG',currency:'NGN',method:'card'});assert.equal(view.provider,'kora');assert.equal(view.adapterReady,false);assert.deepEqual(await loadDatabasePaymentPolicies(f.db,{country:'NG',currency:'NGN',method:'card'}),[]);});
 it('uses exact country, currency, method and preferred filters',async()=>{const f=fixture([gb()]);await loadDatabasePaymentPolicies(f.db,scope);for(const pair of [['country_code','GB'],['currency_code','GBP'],['method','card'],['preferred',true]])assert.ok(f.calls.some(c=>c[0]==='eq'&&c[1]===pair[0]&&c[2]===pair[1]));});
 it('does not use environment routes as fallback for an empty database mapping',async()=>{vi.stubEnv('VAYDU_MARKET_PAYMENT_ROUTES','invalid-but-must-not-be-read');assert.deepEqual(await loadDatabasePaymentPolicies(fixture([]).db,scope),[]);});
 it('does not turn missing database tables into a Stripe default',async()=>assert.rejects(loadDatabasePaymentPolicies(fixture(null,{code:'42P01'}).db,scope)));
 it('does not turn currency coverage into another country route',async()=>assert.rejects(loadDatabasePaymentPolicies(fixture([{...gb(),country_code:'US'}]).db,scope)));
 it('does not accept a returned currency mismatch',async()=>assert.rejects(loadDatabasePaymentPolicies(fixture([{...gb(),currency_code:'USD'}]).db,scope)));
 it('does not accept another payment method',async()=>assert.rejects(loadDatabasePaymentPolicies(fixture([{...gb(),method:'bank_transfer'}]).db,scope)));
 it('rejects ambiguous preferred records',async()=>assert.rejects(loadDatabasePaymentPolicies(fixture([gb(),gb()]).db,scope)));
 it('requires an explicit merchant account for enabled routes',async()=>assert.rejects(loadDatabasePaymentPolicies(fixture([{...ng(),enabled:true}]).db,{country:'NG',currency:'NGN',method:'card'})));
 it('does not unlock the pending Kora adapter through database configuration',async()=>assert.rejects(loadDatabasePaymentPolicies(fixture([{...ng(),merchant_account_ref:'actual-account',enabled:true,merchant_approved:true,adapter_ready:true,capabilities:['retrieve']}]).db,{country:'NG',currency:'NGN',method:'card'})));
 it('supports an explicitly approved installed Stripe route',async()=>{
  const row={...gb(),enabled:true,merchant_approved:true,adapter_ready:true,capabilities:['authorise','capture','release','refund','retrieve']};
  const policies=await loadDatabasePaymentPolicies(fixture([row]).db,scope);assert.equal(selectMarketPayment({countryCode:'GB',currency:'GBP',paymentEnabled:true},policies,'card',['authorise','capture']).provider,'stripe');
 });
 it('preserves the original account after preference changes',async()=>{
  const row={...gb(),preferred:false,enabled:false,merchant_approved:true,adapter_ready:true,capabilities:['retrieve','refund']};const f=fixture([row]);
  const binding={provider:'stripe' as const,merchantAccountRef:'stripe-platform',country:'GB',currency:'GBP',paymentReference:'pi_original'};
  const policies=await loadDatabasePaymentPolicies(f.db,{...scope,binding});assert.equal(policies[0].merchantAccountRef,'stripe-platform');assert.ok(!f.calls.some(c=>c[0]==='eq'&&c[1]==='preferred'));
 });
 it('does not accept a replacement account for an existing reference',async()=>{
  const binding={provider:'stripe' as const,merchantAccountRef:'original',country:'GB',currency:'GBP',paymentReference:'pi_original'};
  await assert.rejects(loadDatabasePaymentPolicies(fixture([gb()]).db,{...scope,binding}));
 });
 it('does not expose merchant account identifiers in customer assignment output',async()=>assert.ok(!JSON.stringify(await readDatabasePaymentAssignment(fixture([gb()]).db,scope)).includes('stripe-platform')));
 it('returns no assignment when a new country has no explicit mapping',async()=>{const view=await readDatabasePaymentAssignment(fixture([]).db,scope);assert.equal(view.provider,null);assert.equal(view.assigned,false);});
});
afterEach(()=>vi.unstubAllEnvs());
async function http(country='GB',authenticated=true,dbError=false){
 const record=country==='NG'?ng():gb();let owner:string|undefined;
 const db={from:(table:string)=>{const q:any={select:()=>q,eq:(key:string,value:any)=>{if(table==='profiles'&&key==='id')owner=value;return q;},single:async()=>({data:{country_code:country,registration_market_city:null},error:null}),then:(resolve:any,reject:any)=>Promise.resolve({data:[record],error:dbError?{}:null}).then(resolve,reject)};return q;}};
 const app=express();app.use('/provider',createMarketPaymentContextRouter(async()=>authenticated?'session-owner':null,db,async()=>({countryCode:country,currency:country==='NG'?'NGN':'GBP',launchStatus:'live',capabilities:{payment:true}} as any)));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 try{const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/provider?country=US&provider=stripe`);return{status:response.status,body:await response.json(),owner,cache:response.headers.get('cache-control')};}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
describe('authenticated market provider lookup',()=>{
 it('is gated before rollout',async()=>{vi.stubEnv('VAYDU_DATABASE_PAYMENT_ROUTING_V23','false');vi.stubEnv('VAYDU_GLOBAL_PAYMENT_ROUTING_V23','false');assert.equal((await http()).status,404);});
 it('requires an authenticated profile',async()=>{vi.stubEnv('VAYDU_DATABASE_PAYMENT_ROUTING_V23','true');assert.equal((await http('GB',false)).status,401);});
 for(const country of ['GB','NG'])it('derives '+country+' from the profile rather than query parameters',async()=>{
  vi.stubEnv('VAYDU_DATABASE_PAYMENT_ROUTING_V23','true');const result=await http(country);assert.equal(result.status,200);assert.equal(result.owner,'session-owner');assert.equal(result.body.country,country);assert.equal(result.body.provider,country==='GB'?'stripe':'kora');assert.equal(result.body.bookingUsesServiceCountry,true);assert.ok(result.cache?.includes('no-store'));
 });
 it('reports unavailable mapping storage without falling back to another provider',async()=>{vi.stubEnv('VAYDU_DATABASE_PAYMENT_ROUTING_V23','true');assert.equal((await http('GB',true,true)).status,503);});
});

it('selects approved NGN Flutterwave collection without granting payouts',async()=>{
 const row={...ng(),provider:'flutterwave',merchant_account_ref:'approved-test-merchant',enabled:true,merchant_approved:true,adapter_ready:true,payout_approved:false,capabilities:['collect','retrieve']};
 const policies=await loadDatabasePaymentPolicies(fixture([row]).db,{country:'NG',currency:'NGN',method:'card'});
 assert.equal(selectMarketPayment({countryCode:'NG',currency:'NGN',paymentEnabled:true},policies,'card',['collect']).provider,'flutterwave');
 assert.throws(()=>selectMarketPayment({countryCode:'NG',currency:'NGN',paymentEnabled:true},policies,'card',['payout']));
});
