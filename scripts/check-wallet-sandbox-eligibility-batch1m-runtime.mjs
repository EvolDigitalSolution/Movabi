import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../',import.meta.url),read=f=>readFileSync(new URL(f,root),'utf8'),url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const transport=await import(url(stripTypeScriptTypes(read('server/services/payments/wallet-collection-startup.ts'))));
globalThis.__mTransport=transport;
const service=await import(url(stripTypeScriptTypes(read('server/services/payments/customer-wallet-sandbox.ts')).replace(/import\s*\{([^}]+)\}\s*from\s*'\.\/wallet-collection-startup';/,(_,names)=>`const {${names}}=globalThis.__mTransport;`)));
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const output=()=>({eligible:true,ownerId:A,currency:'NGN',minorExponent:2,limitMinor:'10000',testOnly:true,spendableCredit:false});
let result=output(),calls=[],mode='test',merchant=true;
const db={async rpc(name,args){calls.push({name,args});return {data:result,error:null};}};
const fakeTransport={status(){return {mode,merchantConfigured:merchant};}};
const s=new service.CustomerWalletSandbox(db,fakeTransport);
const old=process.env.KORA_COLLECTION_RETURN_URL;process.env.KORA_COLLECTION_RETURN_URL='https://vaydu.app/customer/wallet';
let n=0;async function test(name,fn){calls=[];result=output();mode='test';merchant=true;await fn();n++;console.log('PASS '+name);}
await test('self-scoped service-only eligibility RPC',async()=>{const r=await s.eligibility(A);assert.equal(r.eligible,true);assert.equal(r.returnOrigin,'https://vaydu.app');assert.deepEqual(calls,[{name:'customer_wallet_sandbox_eligibility_v1m',args:{p_owner:A}}]);});
await test('non-cohort response reveals no account metadata',async()=>{result={eligible:false,private:'do-not-return'};assert.deepEqual(await s.eligibility(A),{eligible:false});});
await test('live key hides sandbox with zero DB reads',async()=>{mode='live';assert.deepEqual(await s.eligibility(A),{eligible:false});assert.equal(calls.length,0);});
await test('missing merchant hides sandbox before DB',async()=>{merchant=false;assert.deepEqual(await s.eligibility(A),{eligible:false});assert.equal(calls.length,0);});
await test('missing callback hides sandbox before DB',async()=>{process.env.KORA_COLLECTION_RETURN_URL='';assert.deepEqual(await s.eligibility(A),{eligible:false});assert.equal(calls.length,0);process.env.KORA_COLLECTION_RETURN_URL='https://vaydu.app/customer/wallet';});
await test('foreign owner eligibility is rejected',async()=>{result={...output(),ownerId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'};await assert.rejects(()=>s.eligibility(A));});
await test('numeric/rounded limit is rejected',async()=>{result={...output(),limitMinor:10000};await assert.rejects(()=>s.eligibility(A));});
await test('spendable-credit claims are rejected',async()=>{result={...output(),spendableCredit:true};await assert.rejects(()=>s.eligibility(A));});
// Exercise the actual route, not a route mirror.
let user={id:A,email_confirmed_at:'2026-01-01'};
const routes=new Map(),router={get(p,...f){routes.set(p,f.at(-1));},post(){},use(){}};
class Bound extends service.CustomerWalletSandbox{constructor(){super(db,fakeTransport);}}
globalThis.__mMocks={'../services/payments/customer-wallet-sandbox':{...service,CustomerWalletSandbox:Bound},express:{Router:()=>router},'express-rate-limit':{rateLimit:()=>()=>{}},'../services/supabase.service':{supabaseAdmin:{auth:{async getUser(){return {data:{user},error:null};}}}}};
const route=stripTypeScriptTypes(read('server/routes/wallet.routes.ts')).replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,(_,names,key)=>`const {${names}}=globalThis.__mMocks[${JSON.stringify(key)}]||{};`);
await import(url(route));
async function request(header='Bearer valid',query={}){const req={headers:{authorization:header},query};const res={statusCode:200,data:null,headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.data=v;return this;}};await routes.get('/sandbox-topups/eligibility')(req,res);return res;}
await test('actual eligibility route requires Bearer and private no-store',async()=>{const r=await request('');assert.equal(r.statusCode,401);assert.equal(r.headers['Cache-Control'],'private, no-store');assert.equal(calls.length,0);});
await test('actual route derives owner and rejects query overrides',async()=>{assert.equal((await request('Bearer valid',{ownerId:'other'})).statusCode,400);assert.equal(calls.length,0);const r=await request();assert.equal(r.statusCode,200);assert.equal(calls[0].args.p_owner,A);});
await test('unconfirmed email gets no eligibility metadata',async()=>{user={id:A};assert.deepEqual((await request()).data,{eligible:false});assert.equal(calls.length,0);user={id:A,email_confirmed_at:'2026-01-01'};});
if(old===undefined)delete process.env.KORA_COLLECTION_RETURN_URL;else process.env.KORA_COLLECTION_RETURN_URL=old;
delete globalThis.__mTransport;delete globalThis.__mMocks;
console.log(`BATCH1M_ELIGIBILITY_SERVICE_AND_ROUTE_RUNTIME=${n}_PASSED`);
