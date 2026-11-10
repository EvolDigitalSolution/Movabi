import {describe,it,vi,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import {planEarlyStopReconciliation} from '../../server/services/early-stop-reconciliation';
import {previewEarlyStopReconciliation} from '../../server/services/early-stop-reconciliation.service';
import type {MarketPaymentRoute} from '../../server/services/payments/market-payment-registry';
const state=vi.hoisted(()=>({payment:true}));
vi.mock('../../server/services/market-availability.service',()=>({MarketAvailabilityService:{resolveMarket:async()=>({capabilities:{payment:state.payment}})}}));
function input(country='GB',currency='GBP',exponent=2):any{
 return {job:{country_code:country,currency_code:currency,payment_status:'pending',payment_intent_id:null,payment_method:'card',fare_breakdown:{policyVersion:'fare-split-v1',currency,customerCharge:1000}},
 calculation:{policyVersion:'early-stop-distance-prorata-v1',currency,exponent,originalMinor:1000*10**exponent,amountMinor:500*10**exponent},binding:null,marketPaymentEnabled:true,
 policies:[{country,currency,provider:'stripe',merchantAccountRef:'original-account',enabled:true,merchantApproved:true,adapterReady:true,payoutApproved:false,methods:['card'],capabilities:['authorise','capture','release','refund','retrieve']}]};
}
function bound(value:any,provider='stripe'){
 value.binding={country:value.job.country_code,currency:value.job.currency_code,provider,merchantAccountRef:'original-account',paymentReference:'original-payment'};
 value.policies[0].provider=provider;return value;
}
describe('multi-market early-stop reconciliation preview',()=>{
 for(const [country,currency,exponent] of [['GB','GBP',2],['NG','NGN',2],['GH','GHS',2],['KE','KES',2],['US','USD',2],['UG','UGX',0],['JP','JPY',0],['KW','KWD',3]] as const){
  it('preserves '+country+'/'+currency+' precision without a country restriction',()=>{
   const plan=planEarlyStopReconciliation(input(country,currency,exponent));assert.equal(plan.country,country);assert.equal(plan.currency,currency);assert.equal(plan.exponent,exponent);assert.equal(plan.amountMinor,500*10**exponent);assert.equal(plan.action,(['KWD','GHS'] as readonly string[]).includes(currency)?'review':'authorise_then_capture');assert.equal(plan.executionEnabled,false);
  });
 }
 it('previews UGX provider units separately from the stored ledger units',()=>{const plan=planEarlyStopReconciliation(input('UG','UGX',0));assert.equal(plan.amountMinor,500);assert.equal(plan.providerAmountPreview?.apiAmount,50000);});
 it('does not turn synthetic test route coverage into a live market approval',()=>{const value=input('NG','NGN');value.policies[0].enabled=false;assert.equal(planEarlyStopReconciliation(value).action,'review');});
 it('does not invent a country or currency',()=>{for(const field of ['country_code','currency_code']){const value=input();value.job[field]=null;assert.throws(()=>planEarlyStopReconciliation(value));}});
 for(const change of [{amountMinor:1.1},{amountMinor:-1},{amountMinor:100001},{originalMinor:1},{currency:'NGN'},{exponent:0}])it('rejects incompatible terms '+JSON.stringify(change),()=>{const value=input();Object.assign(value.calculation,change);assert.throws(()=>planEarlyStopReconciliation(value));});
 it('does not choose a provider when route configuration is absent',()=>{const value=input();value.policies=[];assert.equal(planEarlyStopReconciliation(value).reason,'PAYMENT_ROUTE_NOT_CONFIGURED');});
 it('rejects two approved new-payment routes instead of guessing',()=>{const value=input();value.policies.push({...value.policies[0],merchantAccountRef:'another-account'});assert.equal(planEarlyStopReconciliation(value).reason,'AMBIGUOUS_PAYMENT_ROUTE');});
 it('requires merchant and adapter approval',()=>{for(const key of ['merchantApproved','adapterReady']){const value=input();value.policies[0][key]=false;assert.equal(planEarlyStopReconciliation(value).action,'review');}});
 it('blocks new collection in a disabled market',()=>{const value=input();value.marketPaymentEnabled=false;assert.equal(planEarlyStopReconciliation(value).reason,'NEW_PAYMENTS_DISABLED_FOR_MARKET');});
 it('does not pretend the pending Kora adapter can collect in another currency',()=>{const value=input('GH','GHS');value.policies[0].provider='kora';assert.equal(planEarlyStopReconciliation(value).reason,'KORA_COLLECTION_ADAPTER_REQUIRED');});
 it('uses a bound Stripe authorisation only after provider verification',()=>{const value=bound(input());value.job.payment_status='authorized';value.job.payment_intent_id='original-payment';assert.equal(planEarlyStopReconciliation(value).action,'verify_before_capture');});
 it('plans release for a zero fare instead of a zero capture',()=>{const value=bound(input());value.job.payment_status='authorized';value.calculation.amountMinor=0;assert.equal(planEarlyStopReconciliation(value).action,'verify_before_release');});
 it('does not require a provider collection for an unbound zero fare',()=>{const value=input();value.calculation.amountMinor=0;value.policies=[];assert.equal(planEarlyStopReconciliation(value).action,'no_collection');});
 for(const [country,currency,provider] of [['GB','GBP','stripe'],['NG','NGN','kora'],['GH','GHS','kora']] as const)it('plans original-account refund verification for '+country+'/'+provider,()=>{
  const value=bound(input(country,currency),provider);value.job.payment_status='paid';const plan=planEarlyStopReconciliation(value);assert.equal(plan.action,'verify_before_refund');assert.equal(plan.adjustmentMinor,50000);assert.equal(plan.provider,provider);
 });
 it('can preview remediation of existing money after new payments are paused',()=>{const value=bound(input());value.job.payment_status='paid';value.marketPaymentEnabled=false;value.policies[0].enabled=false;assert.equal(planEarlyStopReconciliation(value).action,'verify_before_refund');});
 it('does not infer a legacy payment binding from the country or intent',()=>{const value=input();value.job.payment_intent_id='pi_legacy';assert.equal(planEarlyStopReconciliation(value).reason,'ORIGINAL_PAYMENT_BINDING_REQUIRED');});
 it('does not fall back to another account when the original route is missing',()=>{const value=bound(input());value.policies[0].merchantAccountRef='replacement';assert.equal(planEarlyStopReconciliation(value).reason,'ORIGINAL_ROUTE_NOT_CONFIGURED');});
 it('does not accept another payment reference',()=>{const value=bound(input());value.job.payment_intent_id='different';assert.equal(planEarlyStopReconciliation(value).reason,'ORIGINAL_BINDING_MISMATCH');});
 it('does not accept currency or country rotation',()=>{for(const key of ['country','currency']){const value=bound(input());value.binding[key]='OTHER';assert.equal(planEarlyStopReconciliation(value).reason,'ORIGINAL_BINDING_MISMATCH');}});
 it('requires exact operation capabilities',()=>{const value=bound(input());value.job.payment_status='paid';value.policies[0].capabilities=['retrieve'];assert.equal(planEarlyStopReconciliation(value).reason,'PAYMENT_CAPABILITY_UNAVAILABLE');});
 it('does not treat Kora authorisation as implemented hold/capture',()=>{const value=bound(input('NG','NGN'),'kora');value.job.payment_status='authorized';assert.equal(planEarlyStopReconciliation(value).reason,'PROVIDER_AUTHORISATION_NOT_IMPLEMENTED');});
 it('reconciles an uncertain existing reference before creating another collection',()=>{const value=bound(input());assert.equal(planEarlyStopReconciliation(value).action,'verify_original_payment');});
 it('does not expose merchant accounts or payment references in the public plan',()=>{const plan=planEarlyStopReconciliation(bound(input()));assert.ok(!JSON.stringify(plan).includes('original-account'));assert.ok(!JSON.stringify(plan).includes('original-payment'));});
 it('never reports a booking or payment mutation',()=>{const plan=planEarlyStopReconciliation(input());assert.equal(plan.bookingUpdated,false);assert.equal(plan.paymentUpdated,false);assert.equal(plan.executionEnabled,false);});
});
afterEach(()=>vi.unstubAllEnvs());
describe('reconciliation preview service authority',()=>{
 function fixture(overrides:any={}){
  const value=input();let calls:any[]=[];
  const proposal={id:'proposal',state:'agreed',source_digest:'digest',customer_accepted_at:'yes',driver_accepted_at:'yes',calculation:value.calculation,...overrides};
  const db={rpc:async(name:string,args:any)=>{calls.push([name,args]);return{data:{digest:'digest',authorityJob:value.job},error:null};},from:(table:string)=>{const chain:any={select:()=>chain,eq:()=>chain,then:(resolve:any,reject:any)=>Promise.resolve({data:[],error:null}).then(resolve,reject),maybeSingle:async()=>({data:table==='journey_fare_proposals_v23'?proposal:null,error:null})};return chain;}};
  return{db,calls};
 }
 it('authorises the participant through the installed context RPC before reading bindings',async()=>{
  vi.stubEnv('VAYDU_MARKET_PAYMENT_ROUTES','');const f=fixture();const result=await previewEarlyStopReconciliation(f.db,'signed-in-user','job','stop','proposal');
  assert.deepEqual(f.calls,[['early_stop_fare_context_v23',{p_actor:'signed-in-user',p_job_id:'job',p_stop_id:'stop'}]]);assert.equal(result.reason,'PAYMENT_ROUTE_NOT_CONFIGURED');assert.equal(result.previewOnly,true);
 });
 for(const override of [{state:'proposed'},{source_digest:'changed'},{customer_accepted_at:null},{driver_accepted_at:null}])it('requires unchanged two-party fare consent '+JSON.stringify(override),async()=>{const f=fixture(override);await assert.rejects(previewEarlyStopReconciliation(f.db,'actor','job','stop','proposal'),/RECONCILIATION_FARE_AGREEMENT_REQUIRED/);});
});
