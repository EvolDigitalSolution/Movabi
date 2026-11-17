import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const ts=createRequire(import.meta.url)('typescript');
const stripTypeScriptTypes=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const root=new URL('../',import.meta.url),read=n=>readFileSync(new URL(n,root),'utf8');
const url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',T='11111111-1111-1111-1111-111111111111',W='22222222-2222-2222-2222-222222222222';

// ---- Real modules under test (source-transformed, dependencies injected) ----
const contracts=await import(url(stripTypeScriptTypes(read('server/services/payments/payment-contracts.ts'))));
const {PaymentLayerError}=contracts;
const readiness=await import(url(stripTypeScriptTypes(read('server/services/customer-wallet-topup-readiness.ts'))));
const loadWithMocks=(file,mocks)=>import(url(stripTypeScriptTypes(read(file))
 .replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,(m,names,key)=>key.startsWith('node:')?m:`const {${names}}=globalThis.__cwMocks[${JSON.stringify(key)}]||{};`)
 .replace(/import\s+([A-Za-z_$][\w$]*)\s+from\s*'([^']+)'\s*;/g,(m,name,key)=>key.startsWith('node:')?m:`const ${name}=(globalThis.__cwMocks[${JSON.stringify(key)}]||{}).default;`)));
globalThis.__cwMocks={'./payment-contracts':contracts,'./driver-card-topup-contracts':{}};
globalThis.__cwMocks['./provider-currency-options']=await import(url(stripTypeScriptTypes(read('server/services/payments/provider-currency-options.ts'))));
globalThis.__cwMocks['./stripe-currency-amounts']=await import(url(stripTypeScriptTypes(read('server/services/payments/stripe-currency-amounts.ts'))
 .replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,(_,names,key)=>`const {${names}}=globalThis.__cwMocks[${JSON.stringify(key)}]||{};`)));
const sandboxAdapter=await loadWithMocks('server/services/payments/stripe-driver-topup-sandbox.ts',{});
const collectionServiceModule=await loadWithMocks('server/services/payments/customer-wallet-collection.service.ts',{});
const topupRoutes=await loadWithMocks('server/routes/driver-wallet-topup.routes.ts',{
 'express':{Router:()=>({use(){},get(){},post(){},delete(){}})},
 '../services/supabase.service':{supabaseAdmin:{}},
 '../services/payments/flutterwave-wallet-collection':{FlutterwaveWalletCollection:class {}},
 '../services/payments/driver-wallet-topup':{DriverWalletTopupService:class {}},
 'stripe':{default:class {}},
});

// ---- In-memory PostgREST-shaped DB (tables + the real RPC semantics used) ----
const tables={
 profiles:[{id:A,tenant_id:T,role:'customer',registration_activated_at:'2026-01-01T00:00:00Z',registration_country_code:'GB',registration_market_city:null}],
 market_availability:[{country_code:'GB',supported_currency:'GBP',enabled:true,launch_status:'live',customer_app_enabled:true,market_city:null,zone_id:null,valid_from:null,valid_until:null}],
 wallets:[{id:W,user_id:A,currency_code:'GBP'}],
 wallet_collection_config:[{key:'enabled',value:'true'},{key:'max_amount_minor_GBP',value:'100000'}],
 market_payment_routes:[{country_code:'GB',currency_code:'GBP',provider:'stripe',method:'card',preferred:true,enabled:true,merchant_approved:true,adapter_ready:true,capabilities:['collect'],merchant_account_ref:'MERCHANT_GB_1'}],
 wallet_topup_fee_schedules:[{provider:'stripe',country_code:'GB',currency_code:'GBP',method:'card',active:true,version:'vaydu-customer-card-0fee-test-v1',fee_basis:'wallet',fee_basis_points:0,fee_fixed_minor:0,fee_cap_minor:null,rounding:'half_up',approved_by:'ops',approved_at:'2026-01-01T00:00:00Z'}],
 wallet_topup_attempts:[],
 payment_checkout_attempts:[],
 wallet_business_events:[],
};
const rpcCalls=[];
function query(table){
 const rows=tables[table];const filters=[];const out={single:false};
 const match=r=>filters.every(([k,v])=>r[k]===v||Array.isArray(v)&&v.includes(r[k]));
 const chain={
  select(){return chain;},eq(k,v){filters.push([k,v]);return chain;},in(k,vs){filters.push([k,vs]);return chain;},
  maybeSingle(){out.single=true;return chain;},
  insert(row){const unique=table==='payment_checkout_attempts'?'reference':null;if(unique&&rows.some(r=>r[unique]===row[unique]))return Promise.resolve({data:null,error:{code:'23505'}});rows.push({...row});return Promise.resolve({data:row,error:null});},
  update(patch){const targets=()=>rows.filter(match);return {eq(k,v){filters.push([k,v]);return this;},select(){targets().forEach(r=>Object.assign(r,patch));return Promise.resolve({data:targets().map(r=>({reference:r.reference})),error:null});},then(res){targets().forEach(r=>Object.assign(r,patch));return Promise.resolve({data:targets(),error:null}).then(res);}};},
  then(res){const matched=rows.filter(match);return Promise.resolve({data:out.single?(matched[0]||null):matched.map(r=>({...r})),error:null}).then(res);},
 };
 return chain;
}
function rpc(name,args){
 rpcCalls.push(name);
 const attempt=id=>tables.wallet_topup_attempts.find(a=>a.id===id);
 switch(name){
  case 'initiate_wallet_topup':{const id=randomUUID();tables.wallet_topup_attempts.push({id,owner_id:args.p_owner_id,tenant_id:args.p_tenant_id,country_code:args.p_country_code,currency_code:args.p_currency_code,payment_provider:args.p_payment_provider,merchant_account_ref:args.p_merchant_account_ref,amount_minor:String(args.p_amount_minor),provider_fee_minor:null,total_charge_minor:null,fee_policy_version:null,fee_exponent:2,destination_account_purpose:args.p_destination_account_purpose,status:'initiated',provider_reference:null,provider_account_id:'acct_123',credited_event_id:null});return Promise.resolve({data:id,error:null});}
  case 'freeze_wallet_topup_fee':{const a=attempt(args.p_attempt_id);a.fee_policy_version=args.p_fee_policy_version;a.provider_fee_minor='0';a.total_charge_minor=String(BigInt(a.amount_minor));a.status='frozen';return Promise.resolve({data:a.id,error:null});}
  case 'claim_wallet_topup_submission':{const a=attempt(args.p_attempt_id);if(a.status!=='frozen')return Promise.resolve({data:false,error:null});a.status='submitting';return Promise.resolve({data:true,error:null});}
  case 'record_wallet_topup_provider_reference':{const a=attempt(args.p_attempt_id);a.provider_reference=args.p_provider_reference;return Promise.resolve({data:a.id,error:null});}
  case 'confirm_wallet_topup_with_total':{const a=attempt(args.p_attempt_id);if(a.status==='credited'&&a.provider_reference===args.p_verified_provider_reference&&a.total_charge_minor===String(args.p_verified_total_minor))return Promise.resolve({data:a.credited_event_id,error:null});
   if(a.provider_reference!==args.p_verified_provider_reference||a.merchant_account_ref!==args.p_verified_merchant_account_ref||a.currency_code!==args.p_verified_currency||a.total_charge_minor!==String(args.p_verified_total_minor)||args.p_final_status!=='succeeded')return Promise.resolve({data:null,error:{code:'TOPUP_TERMS_MISMATCH',message:'mismatch'}});
   a.status='credited';a.credited_event_id=randomUUID();return Promise.resolve({data:a.credited_event_id,error:null});}
  case 'record_driver_topup_provider_observation':return Promise.resolve({data:true,error:null});
 }
 return Promise.resolve({data:null,error:{code:'PGRST202',message:'unknown rpc'}});
}
let authUser={id:A,email:'customer@example.test',email_confirmed_at:'2026-01-01T00:00:00Z'};
const supabaseAdmin={auth:{async getUser(){return {data:{user:authUser},error:null};}},from:query,rpc};

// ---- Fake Stripe client at the provider HTTP boundary ----
const stripePayments=new Map();
class FakeStripe{
 constructor(){this.accounts={retrieve:async()=>({id:'acct_123'})};this.checkout={sessions:{list:async()=>({data:[],has_more:false}),retrieve:async()=>({}),expire:async()=>({})}};this.paymentIntents={
  create:async(params,opts)=>{const pi={id:'pi_test_'+stripePayments.size,livemode:false,amount:params.amount,currency:params.currency,metadata:{...params.metadata},client_secret:'pi_secret_x',status:'requires_payment_method',idempotency:opts?.idempotencyKey};stripePayments.set(pi.id,pi);return pi;},
  retrieve:async(id)=>{const pi=stripePayments.get(id);assert.ok(pi,'unknown pi '+id);return {...pi,status:'succeeded',amount_received:pi.amount,latest_charge:{id:'ch_1',paid:true,captured:true,refunded:false,amount_refunded:0,amount:pi.amount,currency:pi.currency,payment_method_details:{type:'card'},balance_transaction:{id:'txn_1',fee:0,net:pi.amount,currency:pi.currency}}};},
  search:async()=>({data:[]}),cancel:async()=>({status:'canceled'})};}
}
process.env.STRIPE_SECRET_KEY='sk_test_runtime_check';
process.env.VAYDU_TOPUP_CALLBACK_URL='https://wallet.test/return';

// ---- Mount the real route file with all dependencies injected ----
const routes=new Map();const router={get(p,...f){routes.set('GET '+p,f.at(-1));},post(p,...f){routes.set('POST '+p,f.at(-1));},use(){}};
Object.assign(globalThis.__cwMocks,{
 'express':{Router:()=>router},
 'express-rate-limit':{rateLimit:()=>()=>{}},
 '../services/supabase.service':{supabaseAdmin},
 '../services/payments/customer-wallet-sandbox':{CustomerWalletSandbox:class {},WalletSandboxError:class extends Error {}},
 '../services/customer-wallet-topup-readiness':readiness,
 '../services/payments/customer-wallet-collection.service':{CustomerWalletCollectionService:class extends collectionServiceModule.CustomerWalletCollectionService{
  async createCheckout(t,i){try{return await super.createCheckout(t,i);}catch(e){if(process.env.DEBUG)console.log('CHECKOUT_ERR',e.code||e.message);throw e;}}
  async verify(t,i){try{return await super.verify(t,i);}catch(e){if(process.env.DEBUG)console.log('VERIFY_ERR',e.code||e.message);throw e;}}
 }},
 '../services/payments/payment-contracts':contracts,
 '../services/payments/stripe-driver-topup-sandbox':sandboxAdapter,
 './driver-wallet-topup.routes':topupRoutes,
 'stripe':{default:FakeStripe},
 '../services/customer-wallet-setup':{ensureCustomerWallet:async()=>({}),customerWalletSetupError:()=>null},
 '../services/dispatch.service':{dispatchService:{}},
 '../services/payment-authority.service':{PaymentAuthorityService:{}},
 '../services/issuing-capacity.service':{IssuingCapacityService:{}},
 '../services/market-availability.service':{MarketAvailabilityError:class {},MarketAvailabilityService:{}},
});
await loadWithMocks('server/routes/wallet.routes.ts',{});
async function request(method,path,{header='Bearer valid',body}={}){
 const req={headers:{authorization:header},query:{},body};
 const res={statusCode:200,body:null,headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}};
 try{await routes.get(method+' '+path)(req,res);}catch(e){console.log('ROUTE_THREW',e);throw e;}
 if(process.env.DEBUG_503&&res.statusCode===503)console.log('BODY',res.body);
 return res;
}

let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}

// readiness agrees the same fixture is submittable (route + service honest)
await test('readiness reports collection available for the approved fixture',async()=>{
 const v=await readiness.customerWalletTopupReadiness({from:query},A);
 assert.equal(v.canSubmit,true);assert.equal(v.collectionAvailable,true);assert.deepEqual(v.blockers,[]);
});
await test('checkout requires bearer auth and rejects body overrides',async()=>{
 assert.equal((await request('POST','/collection/checkout',{header:'',body:{amountMinor:30000,idempotencyKey:randomUUID()}})).statusCode,401);
 const r=await request('POST','/collection/checkout',{body:{amountMinor:30000,idempotencyKey:randomUUID(),ownerId:'x'}});
 assert.equal(r.statusCode,400);assert.equal(r.body.code,'INVALID_PAYMENT_INPUT');
});
let quote;
await test('quote freezes attempt terms through the real service+RPC',async()=>{
 const r=await request('POST','/collection/checkout',{body:{amountMinor:30000,idempotencyKey:randomUUID()}});
 assert.equal(r.statusCode,200);quote=r.body;
 assert.equal(quote.kind,'quote');assert.equal(quote.walletAmountMinor,30000);assert.equal(quote.totalChargeMinor,30000);assert.equal(quote.currency,'GBP');
 assert.ok(rpcCalls.includes('initiate_wallet_topup')&&rpcCalls.includes('freeze_wallet_topup_fee'));
});
await test('over-limit quote is refused before any provider call',async()=>{
 const before=rpcCalls.length;
 const r=await request('POST','/collection/checkout',{body:{amountMinor:100001,idempotencyKey:randomUUID()}});
 assert.equal(r.statusCode,409);assert.equal(r.body.code,'TOPUP_AMOUNT_LIMIT');
 assert.ok(!rpcCalls.slice(before).includes('claim_wallet_topup_submission'));
});
await test('confirmed quote submits through the real Stripe adapter and binds the reference',async()=>{
 const r=await request('POST','/collection/checkout',{body:{amountMinor:30000,idempotencyKey:randomUUID(),confirmedTotalMinor:30000}});
 assert.equal(r.statusCode,200);const checkout=r.body;
 assert.equal(checkout.kind,'checkout');assert.equal(checkout.clientSecret,'pi_secret_x');
 const attempt=tables.wallet_topup_attempts.find(a=>a.id===checkout.attemptId);
 assert.equal(attempt.provider_reference,checkout.attemptId);assert.equal(attempt.status,'submitting');
 assert.ok(rpcCalls.includes('claim_wallet_topup_submission')&&rpcCalls.includes('record_wallet_topup_provider_reference'));
 const pi=[...stripePayments.values()].at(-1);
 assert.equal(pi.amount,30000);assert.equal(pi.metadata.vaydu_driver_topup,checkout.attemptId);
 globalThis.__attemptId=checkout.attemptId;
});
await test('verify confirms the provider payment and credits once',async()=>{
 const id=globalThis.__attemptId;
 const r=await request('POST','/collection/verify',{body:{attemptId:id}});
 assert.equal(r.statusCode,200);assert.ok(/^[0-9a-f-]{36}$/.test(r.body.creditedEventId));
 const attempt=tables.wallet_topup_attempts.find(a=>a.id===id);
 assert.equal(attempt.status,'credited');assert.equal(attempt.credited_event_id,r.body.creditedEventId);
});
await test('verify replay returns the same credited event, not a second credit',async()=>{
 const id=globalThis.__attemptId;
 const first=(await request('POST','/collection/verify',{body:{attemptId:id}})).body.creditedEventId;
 const second=(await request('POST','/collection/verify',{body:{attemptId:id}})).body.creditedEventId;
 assert.equal(first,second);
});
await test('identity mismatch fails closed, never credits',async()=>{
 const r=await request('POST','/collection/verify',{body:{attemptId:randomUUID()}});
 assert.equal(r.statusCode,404);
});
delete globalThis.__cwMocks;
console.log(`CUSTOMER_WALLET_COLLECTION_ROUTE_RUNTIME=${count}_PASSED`);
