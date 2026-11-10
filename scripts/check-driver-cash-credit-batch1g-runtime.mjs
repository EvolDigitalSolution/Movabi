import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../',import.meta.url);
const text=n=>readFileSync(new URL(n,root),'utf8');
const moduleOf=source=>import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const utils=await moduleOf(text('src/app/shared/utils/driver-cash-credit.ts'));
globalThis.__b1gUtils=utils;
const readerSource=text('src/app/core/services/payments/driver-cash-credit-reader.ts');
const readerCode=stripTypeScriptTypes(readerSource).replace(/import\s*\{[^}]+\}\s*from\s*'[^']+';/,'const {parseDriverCashCredit}=globalThis.__b1gUtils;');
const {DriverCashCreditReader}=await import('data:text/javascript;base64,'+Buffer.from(readerCode).toString('base64'));
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',T='11111111-1111-1111-1111-111111111111';
const data=(owner=A)=>({driverId:owner,tenantId:T,country:'NG',currency:'NGN',pilotEnabled:false,enrolled:false,
 balance:{currency:'NGN',consistent:true,availableMinor:'123456',heldMinor:'15000',deficitMinor:'0',eligibleDepositsMinor:'138456'},topupAvailable:false,payoutAvailable:false,acceptanceAuthority:'database'});
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(fetch=async owner=>data(owner)){
 let owner=A,clock=1000;const states=[],calls=[];
 const r=new DriverCashCreditReader(()=>owner,id=>{calls.push(id);return fetch(id);},s=>states.push(s),()=>clock);
 return {r,states,calls,setOwner(id){owner=id;r.reset(id);},advance(ms){clock+=ms;}};
}
await test('NGN and GBP retain response currency',()=>{assert.equal(utils.formatCashCreditMinor('123456','NGN'),'NGN 1,234.56');assert.equal(utils.formatCashCreditMinor('123456','GBP'),'GBP 1,234.56');});
await test('zero and three decimal currencies match ledger exponents',()=>{assert.equal(utils.formatCashCreditMinor('1234','JPY'),'JPY 1,234');assert.equal(utils.formatCashCreditMinor('1234','MGA'),'MGA 1,234');assert.equal(utils.formatCashCreditMinor('1234','BHD'),'BHD 1.234');});
await test('large minor-unit text formats without rounding',()=>assert.equal(utils.formatCashCreditMinor('9007199254740993123','NGN'),'NGN 90,071,992,547,409,931.23'));
await test('sub-unit and zero values are exact',()=>{assert.equal(utils.formatCashCreditMinor('1','KWD'),'KWD 0.001');assert.equal(utils.formatCashCreditMinor('0','GBP'),'GBP 0.00');});
await test('invalid or negative values do not become zero',()=>{for(const v of ['-1','1.2','NaN','01','1e3'])assert.equal(utils.formatCashCreditMinor(v,'NGN'),'Amount unavailable');});
await test('wrong currency code has no invented fallback',()=>assert.equal(utils.formatCashCreditMinor('100','gbp'),'Amount unavailable'));
await test('disabled status is honest',()=>assert.match(utils.cashCreditStatusMessage(data()),/not enabled/));
await test('unapproved account is explicit',()=>{const s=data();s.pilotEnabled=true;assert.match(utils.cashCreditStatusMessage(s),/not approved/);});
await test('enrolment does not promise job acceptance or top-up',()=>{const s=data();s.pilotEnabled=s.enrolled=true;assert.match(utils.cashCreditStatusMessage(s),/checked for each ride/);assert.match(utils.cashCreditStatusMessage(s),/Top-ups are unavailable/);});
await test('deficit and inconsistency override readiness',()=>{const s=data();s.balance.deficitMinor='1';assert.ok(utils.cashCreditNeedsReview(s));assert.match(utils.cashCreditStatusMessage(s),/needs review/);s.balance.deficitMinor='0';s.balance.consistent=false;assert.ok(utils.cashCreditNeedsReview(s));});
await test('validator rejects owner substitution',()=>assert.throws(()=>utils.parseDriverCashCredit(data(B),A)));
await test('validator rejects rounded numeric money',()=>{const s=data();s.balance.availableMinor=123456;assert.throws(()=>utils.parseDriverCashCredit(s,A));});
await test('validator rejects incompatible currency or flags',()=>{const s=data();s.balance.currency='GBP';assert.throws(()=>utils.parseDriverCashCredit(s,A));s.balance.currency='NGN';s.topupAvailable=true;assert.throws(()=>utils.parseDriverCashCredit(s,A));});
await test('validator whitelists server data',()=>{const s=data();s.provider_reference='secret';s.balance.secret='secret';assert.equal(JSON.stringify(utils.parseDriverCashCredit(s,A)).includes('secret'),false);});
await test('initial loading precedes verified balance',async()=>{const d=deferred(),f=fixture(()=>d.promise);const p=f.r.refresh();assert.deepEqual(f.states.at(-1),{owner:A,value:null,loading:true,error:''});d.resolve(data());await p;assert.equal(f.states.at(-1).value.balance.availableMinor,'123456');});
await test('concurrent refreshes coalesce',async()=>{const d=deferred(),f=fixture(()=>d.promise);const a=f.r.refresh(),b=f.r.refresh(true);assert.equal(a,b);await Promise.resolve();assert.equal(f.calls.length,1);d.resolve(data());await a;});
await test('short cache avoids duplicate reads',async()=>{const f=fixture();await f.r.refresh();await f.r.refresh();assert.equal(f.calls.length,1);});
await test('forced refresh skips cache and hides stale balance',async()=>{const f=fixture();await f.r.refresh();const p=f.r.refresh(true);assert.equal(f.states.at(-1).value,null);await p;assert.equal(f.calls.length,2);});
await test('cache expiry reads fresh status',async()=>{const f=fixture();await f.r.refresh();f.advance(15001);await f.r.refresh();assert.equal(f.calls.length,2);});
await test('logout clears balance immediately',async()=>{const f=fixture();await f.r.refresh();f.setOwner(null);assert.equal(f.states.at(-1).value,null);await assert.rejects(f.r.refresh());assert.equal(f.calls.length,1);});
await test('account switch clears balance and cached owner',async()=>{const f=fixture();await f.r.refresh();f.setOwner(B);assert.equal(f.states.at(-1).value,null);await f.r.refresh();assert.deepEqual(f.calls,[A,B]);assert.equal(f.states.at(-1).value.driverId,B);});
await test('late old-owner success cannot overwrite new owner',async()=>{const d=deferred(),f=fixture(id=>id===A?d.promise:Promise.resolve(data(B)));const a=f.r.refresh();await Promise.resolve();f.setOwner(B);await f.r.refresh();d.resolve(data(A));await assert.rejects(a);assert.equal(f.states.at(-1).value.driverId,B);});
await test('late old-owner error cannot clear new balance',async()=>{const d=deferred(),f=fixture(id=>id===A?d.promise:Promise.resolve(data(B)));const a=f.r.refresh();await Promise.resolve();f.setOwner(B);await f.r.refresh();d.reject(Error('old failure'));await assert.rejects(a);assert.equal(f.states.at(-1).value.driverId,B);});
await test('A to B to A invalidates the original A request',async()=>{const d=deferred();let call=0;const f=fixture(()=>++call===1?d.promise:Promise.resolve(data(A)));const old=f.r.refresh();await Promise.resolve();f.setOwner(B);f.setOwner(A);await f.r.refresh();d.resolve(data(A));await assert.rejects(old);assert.equal(f.states.at(-1).error,'');assert.equal(f.calls.length,2);});
await test('request failure clears balance and allows retry',async()=>{let fail=false;const f=fixture(async()=>{if(fail)throw Error('offline');return data();});await f.r.refresh();fail=true;await assert.rejects(f.r.refresh(true));assert.equal(f.states.at(-1).value,null);assert.match(f.states.at(-1).error,/could not be verified/);fail=false;await f.r.refresh();assert.ok(f.states.at(-1).value);});
await test('malformed response shows unavailable, never zero',async()=>{const f=fixture(async()=>({}));await assert.rejects(f.r.refresh());assert.equal(f.states.at(-1).value,null);assert.ok(f.states.at(-1).error);});
await test('switch before fetch starts makes no old-owner request',async()=>{const f=fixture();const p=f.r.refresh();f.setOwner(B);await assert.rejects(p);assert.equal(f.calls.length,0);});
console.log(`BATCH1G_READER_AND_MONEY_RUNTIME=${count}_PASSED`);
// Execute the production Angular service with external Angular/HTTP/session dependencies mocked.
const serviceSource=text('src/app/core/services/payments/driver-cash-credit.service.ts');
const HttpClient=class {},SupabaseService=class {},ApiUrlService=class {},AuthService=class {};
let injections,effects;
function signal(initial){let v=initial;const fn=()=>v;fn.set=x=>{v=x;};return fn;}
globalThis.__b1gServiceMocks={
 '@angular/core':{Injectable:()=>x=>x,inject:token=>injections.get(token),signal,computed:fn=>fn,effect:fn=>{effects.push(fn);fn();}},
 '@angular/common/http':{HttpClient},'rxjs':{firstValueFrom:x=>x,timeout:ms=>({timeoutMs:ms})},
 '../supabase/supabase.service':{SupabaseService},'../api-url.service':{ApiUrlService},'../auth/auth.service':{AuthService},
 './driver-cash-credit-reader':{DriverCashCreditReader}
};
const serviceCode=stripTypeScriptTypes(serviceSource.replace("@Injectable({providedIn:'root'})",'')).replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,(_,names,key)=>{
 assert.ok(globalThis.__b1gServiceMocks[key],key);return `const {${names}}=globalThis.__b1gServiceMocks[${JSON.stringify(key)}];`;
});
const {DriverCashCreditService}=await import('data:text/javascript;base64,'+Buffer.from(serviceCode).toString('base64'));
function angularFixture(){
 let owner=A,session={data:{session:{access_token:'owner-token',user:{id:A}}},error:null};
 let httpValue=data(),sessionFn=async()=>session;const calls=[];effects=[];
 const http={get(url,options){calls.push({url,options});return {pipe(op){calls.at(-1).op=op;return Promise.resolve(httpValue);}};}};
 // Deliberately provide no post/put/payment SDK methods.
 injections=new Map([[HttpClient,http],[SupabaseService,{auth:{getSession:()=>sessionFn()}}],
  [ApiUrlService,{getApiUrl:p=>'https://api.test'+p}],[AuthService,{currentUser:()=>owner?{id:owner}:null}]]);
 const service=new DriverCashCreditService();const ownEffects=[...effects];
 return {service,calls,setOwner(id,flush=true){owner=id;if(flush)ownEffects.forEach(fn=>fn());},setSession(s){session=s;},setSessionFn(fn){sessionFn=fn;},setValue(v){httpValue=v;}};
}
await test('production service sends only verified Bearer token to cash endpoint',async()=>{const f=angularFixture();await f.service.refresh();assert.deepEqual(f.calls[0],{url:'https://api.test/api/market-safety/driver-cash-credit',options:{headers:{Authorization:'Bearer owner-token'}},op:{timeoutMs:15000}});assert.equal(f.service.status().driverId,A);});
await test('production service rejects absent session without HTTP',async()=>{const f=angularFixture();f.setSession({data:{session:null},error:null});await assert.rejects(f.service.refresh());assert.equal(f.calls.length,0);assert.ok(f.service.error());});
await test('production service rejects session owned by another account',async()=>{const f=angularFixture();f.setSession({data:{session:{access_token:'other-token',user:{id:B}}},error:null});await assert.rejects(f.service.refresh());assert.equal(f.calls.length,0);});
await test('production service never sends token after owner changes during session read',async()=>{const f=angularFixture(),d=deferred();f.setSessionFn(()=>d.promise);const p=f.service.refresh();await Promise.resolve();f.setOwner(B);d.resolve({data:{session:{access_token:'owner-token',user:{id:A}}},error:null});await assert.rejects(p);assert.equal(f.calls.length,0);});
await test('production computed status hides previous account before Angular effect flush',async()=>{const f=angularFixture();await f.service.refresh();f.setOwner(B,false);assert.equal(f.service.status(),null);});
await test('production service clears data on logout',async()=>{const f=angularFixture();await f.service.refresh();f.setOwner(null);assert.equal(f.service.status(),null);});
await test('production service rejects unverified response without exposing provider fields',async()=>{const f=angularFixture();f.setValue({...data(),driverId:B,provider_reference:'private'});await assert.rejects(f.service.refresh());assert.equal(f.service.status(),null);assert.equal(f.service.error().includes('private'),false);});
await test('production service keeps payout/earnings endpoints out of cash reads',async()=>{const f=angularFixture();await f.service.refresh();await f.service.refresh(true);assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.url.endsWith('/driver-cash-credit')));});
delete globalThis.__b1gServiceMocks;delete globalThis.__b1gUtils;
console.log(`BATCH1G_ALL_BEHAVIORAL_RUNTIME=${count}_PASSED`);
