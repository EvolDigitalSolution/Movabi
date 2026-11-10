import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../',import.meta.url),read=n=>readFileSync(new URL(n,root),'utf8');
const url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const service=await import(url(stripTypeScriptTypes(read('server/services/customer-wallet-topup-readiness.ts'))));
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',T='11111111-1111-1111-1111-111111111111';
const make=(currency='NGN',country='NG')=>({
 profiles:{id:A,tenant_id:T,role:'customer',registration_country_code:country,registration_market_city:null,registration_activated_at:'2026-01-01T00:00:00Z'},
 market_availability:[{country_code:country,supported_currency:currency,enabled:true,launch_status:'live',customer_app_enabled:true}],
 wallets:{id:T,user_id:A,currency_code:currency},wallet_collection_config:[],
 market_payment_routes:[{country_code:country,currency_code:currency,provider:'kora',method:'card',preferred:true,enabled:false,merchant_approved:false,adapter_ready:false,capabilities:[],merchant_account_ref:null}]
});
function database(rows){return {calls:[],from(table){const filters=[];const db=this;return {select(columns){db.calls.push({table,columns,filters});return this;},eq(k,v){filters.push([k,v]);return this;},in(k,v){filters.push([k,v]);return this;},maybeSingle(){return this;},then(resolve,reject){return Promise.resolve(rows[table] instanceof Error?{error:rows[table],data:null}:{data:structuredClone(rows[table]),error:null}).then(resolve,reject);}};}};}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
const get=(r)=>service.customerWalletTopupReadiness(database(r),A);
for(const [currency,country] of [['NGN','NG'],['GBP','GB'],['GHS','GH'],['KES','KE'],['EUR','FR'],['JPY','JP'],['BHD','BH'],['USD','US'],['CAD','CA']])await test(currency+' uses registered configured market',async()=>{const r=await get(make(currency,country));assert.equal(r.currency,currency);assert.equal(r.country,country);assert.equal(r.canSubmit,false);assert.ok(r.blockers.includes('collection_disabled'));});
await test('invalid owner never reaches DB',async()=>{const d=database(make());await assert.rejects(()=>service.customerWalletTopupReadiness(d,'bad'));assert.equal(d.calls.length,0);});
await test('pending registration never reads wallet/routes',async()=>{const r=make();r.profiles.registration_activated_at=null;const d=database(r);assert.equal((await service.customerWalletTopupReadiness(d,A)).reason,'registration_not_ready');assert.equal(d.calls.length,1);});
await test('driver role cannot use customer readiness',async()=>{const r=make();r.profiles.role='driver';assert.equal((await get(r)).reason,'registration_not_ready');});
await test('country and wallet are not inferred from address',async()=>{const r=make();r.profiles.country_code='GB';assert.equal((await get(r)).currency,'NGN');});
await test('missing wallet does not create one',async()=>{const r=make();r.wallets=null;const d=database(r);assert.equal((await service.customerWalletTopupReadiness(d,A)).reason,'wallet_not_set_up');assert.ok(d.calls.every(c=>!c.columns.includes('available_balance')));});
await test('stored GBP wallet in NG is mismatch, never relabelled',async()=>{const r=make();r.wallets.currency_code='GBP';const v=await get(r);assert.equal(v.reason,'wallet_currency_mismatch');assert.equal(v.walletCurrency,'GBP');assert.equal(v.currency,'NGN');});
await test('wrong-owner wallet is unavailable',async()=>{const r=make();r.wallets.user_id=T;await assert.rejects(()=>get(r));});
await test('ambiguous markets fail closed',async()=>{const r=make();r.market_availability.push({...r.market_availability[0]});assert.equal((await get(r)).reason,'market_unavailable');});
await test('paused city never falls back to country',async()=>{const r=make();r.profiles.registration_market_city='Lagos';r.market_availability.push({...r.market_availability[0],market_city:'Lagos',launch_status:'paused'});assert.equal((await get(r)).reason,'market_unavailable');});
await test('configured city wins over country',async()=>{const r=make('USD','US');r.profiles.registration_market_city='Test City';r.market_availability.push({...r.market_availability[0],market_city:'Test City',supported_currency:'CAD'});r.wallets.currency_code='CAD';r.market_payment_routes=[];assert.equal((await get(r)).currency,'CAD');});
await test('expired markets are unavailable',async()=>{const r=make();r.market_availability[0].valid_until='2020-01-01';assert.equal((await get(r)).reason,'market_unavailable');});
await test('Kora gaps accurately reflect owner preflight',async()=>{const v=await get(make());assert.deepEqual(v.providers,[{provider:'kora',routeReady:false,reasons:['route_disabled','merchant_not_approved','adapter_not_ready','merchant_reference_missing','collection_capability_missing']}]);assert.ok(v.blockers.includes('currency_limit_missing_or_invalid'));});
function approved(){const r=make();Object.assign(r.market_payment_routes[0],{enabled:true,merchant_approved:true,adapter_ready:true,capabilities:['collect'],merchant_account_ref:'PRIVATE_MERCHANT'});r.wallet_collection_config=[{key:'enabled',value:'true'},{key:'max_amount_minor_NGN',value:'9007199254740993'}];return r;}
await test('exact limit remains string beyond JS safe integer',async()=>{assert.equal((await get(approved())).maxAmountMinor,'9007199254740993');});
await test('ready route does not claim collection implementation',async()=>{const v=await get(approved());assert.equal(v.canSubmit,false);assert.equal(v.collectionAvailable,false);assert.deepEqual(v.blockers,['collection_integration_pending']);});
await test('private merchant references never leave service',async()=>{assert.equal(JSON.stringify(await get(approved())).includes('PRIVATE_MERCHANT'),false);});
await test('ambiguous eligible routes are blocked',async()=>{const r=approved();r.market_payment_routes.push({...r.market_payment_routes[0],provider:'stripe'});assert.ok((await get(r)).blockers.includes('ambiguous_collection_routes'));});
await test('Stripe and Fincra use identical capability checks',async()=>{for(const provider of ['stripe','fincra']){const r=approved();r.market_payment_routes[0].provider=provider;assert.equal((await get(r)).providers[0].provider,provider);}});
await test('malformed/overflow/fractional limits are denied',async()=>{for(const value of ['0','-1','1.5','1e3','9223372036854775808',1000]){const r=approved();r.wallet_collection_config[1].value=value;assert.equal((await get(r)).maxAmountMinor,null);}});
await test('DB errors are unavailable rather than zero or success',async()=>{for(const table of ['profiles','market_availability','wallets','wallet_collection_config','market_payment_routes']){const r=make();r[table]=new Error('PRIVATE_SQL');await assert.rejects(()=>get(r),e=>e.code==='WALLET_TOPUP_READINESS_UNAVAILABLE'&&!e.message.includes('PRIVATE_SQL'));}});
const routes=new Map(),router={post(){},get(p,...f){routes.set(p,f.at(-1));},use(){}};
let rows=make(),auth={data:{user:{id:A}},error:null},d=database(rows),authCalls=0;
const supabase={auth:{async getUser(){authCalls++;return auth;}},from(...args){return d.from(...args);}};
globalThis.__b1iMocks={
 '../services/payments/customer-wallet-sandbox':{CustomerWalletSandbox:class {},WalletSandboxError:class extends Error {}},
 '../services/customer-wallet-topup-readiness':service,'../services/customer-wallet-setup':{},'express-rate-limit':{rateLimit:()=>()=>{}},
 '../services/dispatch.service':{dispatchService:{}},express:{Router:()=>router},'../services/supabase.service':{supabaseAdmin:supabase},
 '../services/payment-authority.service':{},'../services/issuing-capacity.service':{},'../services/market-availability.service':{}
};
const source=stripTypeScriptTypes(read('server/routes/wallet.routes.ts')).replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,(_,names,key)=>{
 assert.ok(globalThis.__b1iMocks[key],key);return `const {${names}}=globalThis.__b1iMocks[${JSON.stringify(key)}];`;
});
await import(url(source));
async function request(header='Bearer valid',query={},body=undefined){const req={headers:{authorization:header},query,body};const res={statusCode:200,headers:{},body:null,setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}};await routes.get('/topup-readiness')(req,res);return res;}
await test('actual GET requires auth before DB with private no-store',async()=>{d=database(make());const r=await request('');assert.equal(r.statusCode,401);assert.equal(r.headers['Cache-Control'],'private, no-store');assert.equal(r.headers.Vary,'Authorization');assert.equal(d.calls.length,0);});
await test('actual GET rejects bad token before DB',async()=>{auth={data:{user:null},error:{}};d=database(make());assert.equal((await request()).statusCode,401);assert.equal(d.calls.length,0);auth={data:{user:{id:A}},error:null};});
await test('actual GET rejects owner/country/currency overrides',async()=>{for(const query of [{owner:T},{country:'GB'},{currency:'GBP'}]){d=database(make());assert.equal((await request('Bearer valid',query)).statusCode,400);assert.equal(d.calls.length,0);}});
await test('actual GET uses verified owner for both personal reads',async()=>{d=database(make());const r=await request();assert.equal(r.statusCode,200);for(const c of d.calls.filter(x=>['profiles','wallets'].includes(x.table)))assert.ok(c.filters.some(([k,v])=>v===A&&['id','user_id'].includes(k)));assert.equal(r.body.canSubmit,false);});
await test('actual GET hides unexpected errors',async()=>{const r=make();r.profiles=new Error('SECRET');d=database(r);const v=await request();assert.equal(v.statusCode,503);assert.equal(JSON.stringify(v.body).includes('SECRET'),false);});
delete globalThis.__b1iMocks;
console.log(`BATCH1I_READINESS_SERVICE_AND_ROUTE_RUNTIME=${count}_PASSED`);
