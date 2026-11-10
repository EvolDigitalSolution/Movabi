import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../',import.meta.url),text=n=>readFileSync(new URL(n,root),'utf8');
const encode=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const money=await import(encode(stripTypeScriptTypes(text('src/app/shared/utils/wallet-recorded-money.ts'))));
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
await test('NGN wallet uses recorded NGN',()=>assert.equal(money.recordedWalletAmount('12.50','NGN'),'NGN 12.50'));
await test('existing GBP is never relabelled as NGN',()=>assert.equal(money.recordedWalletAmount('12.50','GBP'),'GBP 12.50'));
await test('large string balance keeps all digits',()=>assert.equal(money.recordedWalletAmount('9007199254740993123.45','NGN'),'NGN 9,007,199,254,740,993,123.45'));
await test('JPY and KWD use actual currency precision',()=>{assert.equal(money.recordedWalletAmount('12','JPY'),'JPY 12');assert.equal(money.recordedWalletAmount('1.234','KWD'),'KWD 1.234');});
await test('real zero is explicit and currency-scoped',()=>assert.equal(money.recordedWalletAmount(0,'NGN'),'NGN 0.00'));
await test('null amount is not zero',()=>assert.equal(money.recordedWalletAmount(null,'NGN'),'Amount unavailable'));
await test('missing currency has no GBP fallback',()=>assert.equal(money.recordedWalletAmount('10',null),'Currency unavailable'));
await test('invalid precision or unsafe number is not rounded',()=>{assert.equal(money.recordedWalletAmount('1.001','GBP'),'Amount unavailable');assert.equal(money.recordedWalletAmount(1.001,'GBP'),'Amount unavailable');assert.equal(money.recordedWalletAmount(1e20,'NGN'),'Amount unavailable');});
await test('transaction currency comes from its own row',()=>{assert.equal(money.recordedWalletTransaction({amount:'10',currency_code:'GBP'},true),'+GBP 10.00');assert.equal(money.recordedWalletTransaction({amount:'10',currency_code:'NGN'},false),'−NGN 10.00');});
await test('legacy NULL provenance stays unresolved',()=>assert.equal(money.recordedWalletTransaction({amount:'10',currency_code:null},true),'Currency unavailable'));
await test('conflicting transaction currencies are rejected',()=>assert.equal(money.recordedWalletTransaction({amount:'10',currency_code:'NGN',currency:'GBP'},true),'Currency unavailable'));
await test('negative recorded transaction never gets a duplicate sign',()=>assert.equal(money.recordedWalletTransaction({amount:'-10',currency_code:'NGN'},false),'−NGN 10.00'));
const SupabaseService=class {},HttpClient=class {},AuthService=class {},ApiUrlService=class {};
let injections,effects;
function signal(initial){let value=initial;const fn=()=>value;fn.set=x=>{value=x;};return fn;}
globalThis.__walletCurrencyMocks={
 '@shared/utils/wallet-recorded-money':money,'@shared/utils/errand-budget':{approvedErrandBudget:()=>{}},
 '@angular/core':{Injectable:()=>x=>x,inject:x=>injections.get(x),signal,computed:fn=>fn,effect:fn=>{effects.push(fn);fn();}},
 '@angular/common/http':{HttpClient},'rxjs':{firstValueFrom:x=>x,timeout:ms=>({timeoutMs:ms})},'../supabase/supabase.service':{SupabaseService},
 '@shared/models/booking.model':{Wallet:{},ErrandFunding:{}},'../auth/auth.service':{AuthService},'../api-url.service':{ApiUrlService}
};
let code=text('src/app/core/services/wallet/wallet.service.ts').replace(/@Injectable\(\{\s*providedIn:\s*'root'\s*\}\)/,'');
code=stripTypeScriptTypes(code).replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,(_,names,key)=>{
 assert.ok(globalThis.__walletCurrencyMocks[key],key);return `const {${names}}=globalThis.__walletCurrencyMocks[${JSON.stringify(key)}];`;
});
const {WalletService}=await import(encode(code));
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const row=(owner=A,currency='NGN')=>({user_id:owner,currency_code:currency,available_balance:12.5,reserved_balance:0});
const deferred=()=>{let resolve;const promise=new Promise(a=>{resolve=a;});return {promise,resolve};};
function fixture(fetch=async owner=>({data:row(owner),error:null})){
 let owner=A;const calls=[];effects=[];
 const supabase={auth:{async getSession(){return {data:{session:{access_token:'fixture',user:{id:owner}}},error:null};}},from(table){const call={table};calls.push(call);return {select(value){call.select=value;return this;},eq(key,value){call.key=key;call.owner=value;return this;},maybeSingle(){return fetch(call.owner);}};}};
 injections=new Map([[SupabaseService,supabase],[AuthService,{currentUser:()=>owner?{id:owner}:null}],[HttpClient,{post(){return {pipe(){return Promise.reject({error:{code:'CUSTOMER_WALLET_SETUP_DISABLED'}});}};}}],[ApiUrlService,{getApiUrl:p=>p}]]);
 const service=new WalletService(),ownEffects=[...effects];
 return {service,calls,setOwner(id,flush=true){owner=id;if(flush)ownEffects.forEach(fn=>fn());}};
}
await test('production wallet read scopes only to authenticated owner',async()=>{const f=fixture();await f.service.fetchWallet();assert.deepEqual(f.calls,[{table:'wallets',select:'*',key:'user_id',owner:A}]);assert.equal(f.service.walletBalanceText(true),'NGN 12.50');});
await test('no wallet shows setup state instead of GBP zero',async()=>{const f=fixture(async()=>({data:null,error:null}));await f.service.fetchWallet();assert.equal(f.service.walletBalanceText(true),'Wallet');assert.equal(f.service.walletBalanceText(),'Not set up');});
await test('query failure is unavailable instead of zero',async()=>{const f=fixture(async()=>({data:null,error:{message:'private'}}));await f.service.fetchWallet();assert.equal(f.service.walletBalanceText(),'Wallet unavailable');assert.ok(f.service.walletError());assert.equal(f.service.walletError().includes('private'),false);});
await test('stored GBP survives any app-country preference',async()=>{const f=fixture(async owner=>({data:row(owner,'GBP'),error:null}));await f.service.fetchWallet();assert.equal(f.service.walletBalanceText(),'GBP 12.50');});
await test('loading does not show a guessed zero',async()=>{const d=deferred(),f=fixture(()=>d.promise);const p=f.service.fetchWallet();assert.equal(f.service.walletBalanceText(true),'Checking…');d.resolve({data:row(),error:null});await p;});
await test('concurrent wallet reads coalesce',async()=>{const d=deferred(),f=fixture(()=>d.promise);const a=f.service.fetchWallet(),b=f.service.fetchWallet();assert.equal(a,b);await Promise.resolve();assert.equal(f.calls.length,1);d.resolve({data:row(),error:null});await a;});
await test('missing currency never uses profile/default GBP',async()=>{const f=fixture(async()=>({data:row(A,null),error:null}));await f.service.fetchWallet();assert.equal(f.service.wallet(),null);assert.equal(f.service.walletBalanceText(),'Wallet unavailable');});
await test('wrong owner response is discarded',async()=>{const f=fixture(async()=>({data:row(B),error:null}));await f.service.fetchWallet();assert.equal(f.service.wallet(),null);assert.ok(f.service.walletError());});
await test('logout hides wallet before effect flush',async()=>{const f=fixture();await f.service.fetchWallet();f.setOwner(null,false);assert.equal(f.service.wallet(),null);assert.equal(f.service.walletBalanceText(true),'Wallet');});
await test('account change clears prior balance',async()=>{const f=fixture();await f.service.fetchWallet();f.setOwner(B);assert.equal(f.service.wallet(),null);await f.service.fetchWallet();assert.equal(f.service.wallet().user_id,B);});
await test('late old-account response never overwrites new account',async()=>{const d=deferred(),f=fixture(id=>id===A?d.promise:Promise.resolve({data:row(B,'GBP'),error:null}));const a=f.service.fetchWallet();await Promise.resolve();f.setOwner(B);await f.service.fetchWallet();d.resolve({data:row(),error:null});await a;assert.equal(f.service.walletBalanceText(),'GBP 12.50');});
await test('A to B to A rejects the earlier session response',async()=>{const d=deferred();let n=0;const f=fixture(()=>++n===1?d.promise:Promise.resolve({data:{...row(),available_balance:30},error:null}));const a=f.service.fetchWallet();await Promise.resolve();f.setOwner(B);f.setOwner(A);await f.service.fetchWallet();d.resolve({data:row(),error:null});await a;assert.equal(f.service.walletBalanceText(),'NGN 30.00');});
await test('no authenticated owner makes no database call',async()=>{const f=fixture();f.setOwner(null);await f.service.fetchWallet();assert.equal(f.calls.length,0);});
delete globalThis.__walletCurrencyMocks;
console.log(`CUSTOMER_WALLET_CURRENCY_RUNTIME=${count}_PASSED`);
// New 1H fallback exercises the actual production setupMissingWallet path.
function setupFixture(result,code=null){
 let owner=A,session={data:{session:{access_token:'fixture',user:{id:A}}},error:null};const posts=[];effects=[];
 const supabase={auth:{async getSession(){return session;}},from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:null,error:null};}};}};
 const http={post(path,body,options){posts.push({path,body,options});return {pipe(op){assert.equal(op.timeoutMs,15000);return code?Promise.reject({error:{code}}):Promise.resolve(result);}};}};
 injections=new Map([[SupabaseService,supabase],[AuthService,{currentUser:()=>owner?{id:owner}:null}],[HttpClient,http],[ApiUrlService,{getApiUrl:p=>p}]]);
 const service=new WalletService(),ownEffects=[...effects];
 return {service,posts,setOwner(id){owner=id;ownEffects.forEach(fn=>fn());},setSession(v){session=v;}};
}
await test('missing wallet uses empty authenticated setup body',async()=>{const f=setupFixture({wallet:{...row(),available_balance:'0',reserved_balance:'0'}});await f.service.fetchWallet();assert.deepEqual(f.posts,[{path:'/api/wallet/setup',body:{},options:{headers:{Authorization:'Bearer fixture'}}}]);assert.equal(f.service.walletBalanceText(),'NGN 0.00');});
await test('disabled setup remains not set up, not a fabricated balance',async()=>{const f=setupFixture(null,'CUSTOMER_WALLET_SETUP_DISABLED');await f.service.fetchWallet();assert.equal(f.service.walletBalanceText(),'Not set up');assert.equal(f.service.walletError(),'');});
await test('pending registration remains not set up',async()=>{const f=setupFixture(null,'CUSTOMER_WALLET_NOT_READY');await f.service.fetchWallet();assert.equal(f.service.walletBalanceText(),'Not set up');});
await test('unavailable market never falls back to GBP',async()=>{const f=setupFixture(null,'CUSTOMER_WALLET_MARKET_UNAVAILABLE');await f.service.fetchWallet();assert.equal(f.service.walletBalanceText(),'Not set up');});
await test('unknown setup error is unavailable instead of zero',async()=>{const f=setupFixture(null,'OTHER');await f.service.fetchWallet();assert.equal(f.service.walletBalanceText(),'Wallet unavailable');});
await test('wrong session cannot trigger setup',async()=>{const f=setupFixture({wallet:row()});f.setSession({data:{session:{access_token:'other',user:{id:B}}},error:null});await f.service.fetchWallet();assert.equal(f.posts.length,0);assert.equal(f.service.wallet(),null);});
await test('wrong-owner setup response is refused',async()=>{const f=setupFixture({wallet:row(B)});await f.service.fetchWallet();assert.equal(f.service.wallet(),null);assert.equal(f.service.walletBalanceText(),'Wallet unavailable');});
await test('concurrent missing-wallet reads post setup once',async()=>{const f=setupFixture({wallet:{...row(),available_balance:'0',reserved_balance:'0'}});await Promise.all([f.service.fetchWallet(),f.service.fetchWallet()]);assert.equal(f.posts.length,1);});
console.log(`BATCH1H_CLIENT_WALLET_RUNTIME=${count}_PASSED`);
