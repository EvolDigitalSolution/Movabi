import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../',import.meta.url),read=n=>readFileSync(new URL(n,root),'utf8');
const url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const service=await import(url(stripTypeScriptTypes(read('server/services/customer-wallet-setup.ts'))));
const readiness=await import(url(stripTypeScriptTypes(read('server/services/customer-wallet-topup-readiness.ts'))));
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',W='11111111-1111-1111-1111-111111111111';
const output=(country='NG',currency='NGN')=>({status:'created',country,currency,currencyMatchesMarket:true,wallet:{id:W,user_id:A,currency_code:currency,available_balance:'0',reserved_balance:'0',created_at:'2026-10-26T00:00:00Z',updated_at:'2026-10-26T00:00:00Z'}});
const db=(value=output(),error=null)=>({calls:[],async rpc(name,args){this.calls.push({name,args});return {data:value,error};}});
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
for(const [country,currency] of [['NG','NGN'],['GB','GBP'],['KE','KES'],['GH','GHS'],['US','USD'],['FR','EUR'],['JP','JPY'],['BH','BHD']])
 await test('server accepts configured '+currency+' without provider contact',async()=>{const d=db(output(country,currency));assert.equal((await service.ensureCustomerWallet(d,A)).wallet.currency_code,currency);assert.deepEqual(d.calls,[{name:'ensure_customer_wallet_v1h',args:{p_user_id:A}}]);});
await test('created wallets cannot contain invented funds',async()=>{const v=output();v.wallet.available_balance='100';await assert.rejects(()=>service.ensureCustomerWallet(db(v),A));});
await test('existing funded currency remains unchanged',async()=>{const v=output();v.status='existing';v.wallet.currency_code='GBP';v.currencyMatchesMarket=false;v.wallet.available_balance='12.50';const r=await service.ensureCustomerWallet(db(v),A);assert.equal(r.wallet.currency_code,'GBP');assert.equal(r.wallet.available_balance,'12.50');});
await test('wrong owner response is refused',async()=>{const v=output();v.wallet.user_id=W;await assert.rejects(()=>service.ensureCustomerWallet(db(v),A));});
await test('rounded numeric money is refused',async()=>{const v=output();v.wallet.available_balance=0;await assert.rejects(()=>service.ensureCustomerWallet(db(v),A));});
await test('bad principal never reaches DB',async()=>{const d=db();await assert.rejects(()=>service.ensureCustomerWallet(d,'bad'));assert.equal(d.calls.length,0);});
await test('disabled/pending/market/authority errors are safe',async()=>{for(const code of ['WH001','WH002','WH004','WH005']){const mapped=service.customerWalletSetupError({code,message:'private'});assert.ok(mapped);assert.equal(JSON.stringify(mapped).includes('private'),false);}assert.equal(service.customerWalletSetupError({code:'OTHER'}),null);});
const routes=new Map();const router={post(path,...fns){routes.set(path,fns.at(-1));},get(){},use(){}};
let auth={data:{user:{id:A}},error:null},requestDb=db();
const Supabase={auth:{async getUser(){return auth;}},rpc(...args){return requestDb.rpc(...args);}};
globalThis.__b1hMocks={
 '../services/payments/customer-wallet-sandbox':{CustomerWalletSandbox:class {},WalletSandboxError:class extends Error {}},
 '../services/customer-wallet-topup-readiness':readiness,
 '../services/customer-wallet-setup':service,'express-rate-limit':{rateLimit:()=>()=>{}},
 '../services/dispatch.service':{dispatchService:{}},'express':{Router:()=>router},
 '../services/supabase.service':{supabaseAdmin:Supabase},'../services/payment-authority.service':{PaymentAuthorityService:{}},
 '../services/issuing-capacity.service':{IssuingCapacityService:{}},'../services/market-availability.service':{MarketAvailabilityError:class {},MarketAvailabilityService:{}}
};
let source=stripTypeScriptTypes(read('server/routes/wallet.routes.ts')).replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,(_,names,key)=>{
 assert.ok(globalThis.__b1hMocks[key],key);return `const {${names}}=globalThis.__b1hMocks[${JSON.stringify(key)}];`;
});
await import(url(source));
async function request(header='Bearer valid',body={}){
 const req={headers:{authorization:header},body};const res={statusCode:200,headers:{},body:null,setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}};
 await routes.get('/setup')(req,res);return res;
}
await test('actual route requires Bearer auth and no-store',async()=>{const r=await request('');assert.equal(r.statusCode,401);assert.equal(r.headers['Cache-Control'],'private, no-store');});
await test('actual route rejects invalid token',async()=>{auth={data:{user:null},error:{}};requestDb=db();const r=await request();assert.equal(r.statusCode,401);assert.equal(requestDb.calls.length,0);auth={data:{user:{id:A}},error:null};});
await test('actual route takes owner only from verified identity',async()=>{requestDb=db();const r=await request();assert.equal(r.statusCode,200);assert.deepEqual(requestDb.calls[0].args,{p_user_id:A});});
await test('actual route refuses client country/currency/amount/owner overrides',async()=>{for(const body of [{country:'GB'},{currency:'GBP'},{amount:500},{userId:W},[],null]){requestDb=db();const r=await request('Bearer valid',body);if(body===null)assert.equal(r.statusCode,200);else{assert.equal(r.statusCode,400);assert.equal(requestDb.calls.length,0);}}});
await test('actual route keeps disabled setup closed',async()=>{requestDb=db(null,{code:'WH004'});const r=await request();assert.equal(r.statusCode,409);assert.equal(r.body.code,'CUSTOMER_WALLET_SETUP_DISABLED');});
await test('actual route hides unknown SQL details',async()=>{requestDb=db(null,{code:'23505',message:'private'});const r=await request();assert.equal(r.statusCode,503);assert.equal(JSON.stringify(r.body).includes('private'),false);});
delete globalThis.__b1hMocks;
console.log(`BATCH1H_SERVER_AND_ROUTE_RUNTIME=${count}_PASSED`);
