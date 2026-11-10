import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../server/services/driver-cash-credit.ts',import.meta.url),'utf8');
const api=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const driver='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',tenant='11111111-1111-1111-1111-111111111111';
const state=()=>({driverId:driver,tenantId:tenant,country:'NG',currency:'NGN',pilotEnabled:true,enrolled:true,
 balance:{currency:'NGN',consistent:true,availableMinor:'900719925474099300',heldMinor:'0',deficitMinor:'0',eligibleDepositsMinor:'900719925474099300'},
 topupAvailable:false,payoutAvailable:false,acceptanceAuthority:'database'});
const job=()=>({payment_method:'cash',service_type:{slug:'ride'},tenant_id:tenant,country_code:'NG',currency_code:'NGN',metadata:{cash_collection_mode:'full_customer_charge',driver_settlement_method:'transfer'},payment_status:'pending',payment_intent_id:null});
function db(value=state(),error=null){const calls=[];return {calls,async rpc(name,args){calls.push({name,args});return {data:value,error};}};}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code);
await test('NGN cash enrolment uses no Stripe/provider call',async()=>{const d=db();assert.equal(await api.cashRideAcquisitionApproved(d,driver,job()),true);assert.deepEqual(d.calls,[{name:'driver_cash_credit_status_v1f',args:{p_driver_id:driver}}]);});
await test('large minor amounts remain exact strings',async()=>assert.equal((await api.readDriverCashCredit(db(),driver)).balance.availableMinor,'900719925474099300'));
await test('GBP scope follows the same provider-neutral contract',async()=>{const s=state();s.country='GB';s.currency=s.balance.currency='GBP';const j=job();j.country_code='GB';j.currency_code='GBP';assert.equal(await api.cashRideAcquisitionApproved(db(s),driver,j),true);});
await test('disabled pilot retains existing payout checks',async()=>{const s=state();s.pilotEnabled=false;assert.equal(await api.cashRideAcquisitionApproved(db(s),driver,job()),false);});
await test('card leaves existing payout checks untouched',async()=>{const d=db();assert.equal(await api.cashRideAcquisitionApproved(d,driver,{...job(),payment_method:'card'}),false);assert.equal(d.calls.length,0);});
await test('non-Ride leaves existing checks untouched',async()=>{const d=db();assert.equal(await api.cashRideAcquisitionApproved(d,driver,{...job(),service_type:{slug:'errand'}}),false);assert.equal(d.calls.length,0);});
for(const [name,mutate] of [
 ['not enrolled',s=>s.enrolled=false],['wrong tenant',s=>s.tenantId='22222222-2222-2222-2222-222222222222'],
 ['wrong country',s=>s.country='GB'],['wrong currency',s=>{s.currency='GBP';s.balance.currency='GBP';}]
])await test(name+' denies cash acquisition',async()=>{const s=state();mutate(s);await rejects(()=>api.cashRideAcquisitionApproved(db(s),driver,job()),'CE002');});
for(const [name,mutate] of [['missing custody',j=>j.metadata={}],['digital intent',j=>j.payment_intent_id='pi_x'],['paid job',j=>j.payment_status='paid'],['metadata market mismatch',j=>j.metadata.country_code='GB']])
 await test(name+' denies cash acquisition',async()=>{const j=job();mutate(j);await rejects(()=>api.cashRideAcquisitionApproved(db(),driver,j),'CE002');});
for(const [name,mutate] of [['deficit',s=>s.balance.deficitMinor='1'],['inconsistent reserves',s=>s.balance.consistent=false]])
 await test(name+' requires reconciliation',async()=>{const s=state();mutate(s);await rejects(()=>api.cashRideAcquisitionApproved(db(s),driver,job()),'CE006');});
await test('zero credit is not a stale affordability decision; DB enforces frozen fee',async()=>{const s=state();s.balance.availableMinor='0';assert.equal(await api.cashRideAcquisitionApproved(db(s),driver,job()),true);});
await test('numeric/rounded RPC money is rejected',async()=>{const s=state();s.balance.availableMinor=100;await rejects(()=>api.readDriverCashCredit(db(s),driver),'CE006');});
await test('wrong owner RPC response is rejected',async()=>{const s=state();s.driverId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';await rejects(()=>api.readDriverCashCredit(db(s),driver),'CE006');});
await test('invalid principal never queries DB',async()=>{const d=db();await rejects(()=>api.readDriverCashCredit(d,'bad'),'CE002');assert.equal(d.calls.length,0);});
await test('DB outage is explicit and never a success',async()=>await rejects(()=>api.readDriverCashCredit(db(null,{code:'PGRST202'}),driver),'CASH_CREDIT_UNAVAILABLE'));
await test('RPC eligibility denial is preserved without leaking DB detail',async()=>await rejects(()=>api.readDriverCashCredit(db(null,{code:'CE002',message:'private evidence'}),driver),'CE002'));
await test('response whitelist removes private provider evidence',async()=>{const s=state();s.provider_reference='private';s.balance.secret='private';const out=await api.readDriverCashCredit(db(s),driver);assert.equal(JSON.stringify(out).includes('private'),false);});
await test('all six database errors map safely; unknown errors stay unmapped',async()=>{for(let i=1;i<=6;i++){const out=api.mapCashCreditError({code:'CE00'+i,message:'secret',details:'secret'});assert.ok(out);assert.equal(JSON.stringify(out).includes('secret'),false);}assert.equal(api.mapCashCreditError({code:'MB001'}),null);});
console.log(`BATCH1F_SERVICE_RUNTIME=${count}_PASSED`);
// Exercise the actual Express route and auth middleware with mocked external dependencies.
const routeSource=readFileSync(new URL('../server/routes/market-safety.routes.ts',import.meta.url),'utf8');
const routes=new Map();let middleware;
const router={use(fn){middleware=fn;},get(path,fn){routes.set(path,fn);}};
let authResult={data:{user:{id:driver}},error:null},authThrows=false,requestDb=db();
const routeDb={auth:{async getUser(){if(authThrows)throw Error('offline');return authResult;}},rpc(...args){return requestDb.rpc(...args);}};
globalThis.__b1fRouteMocks={
 '../services/driver-cash-credit':api,'express':{Router:()=>router},
 '../services/supabase.service':{supabaseAdmin:routeDb},
 '../services/driver-market-scope':{driverMatchesJobMarket:()=>true},
 '../services/market-availability.service':{MarketAvailabilityService:{}},
 '../services/payments/market-payment-store':{readDatabasePaymentAssignment:()=>{}},
 '../services/payout-eligibility.service':{PayoutEligibilityService:{}},
 '../services/booking-payment-context':{stripeCheckoutMarket:()=>{},bookingQuoteState:()=>{},driverWalletPayoutState:()=>{}},
 '../services/driver-collection-account.service':{DriverCollectionAccountService:{},SETUP_ONLY_COLLECTION_STORE:{}},
 '../services/driver-payment-account.service':{DriverPaymentAccountService:{},sandboxDestinationProvider:()=>{}}
};
let routeCode=stripTypeScriptTypes(routeSource).replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,(_,bindings,name)=>{
 assert.ok(globalThis.__b1fRouteMocks[name],name);
 return `const {${bindings.replace(/\s+as\s+/g,':')}}=globalThis.__b1fRouteMocks[${JSON.stringify(name)}];`;
});
await import('data:text/javascript;base64,'+Buffer.from(routeCode).toString('base64'));
async function request(header='Bearer valid',query={}){
 const req={headers:{authorization:header},query};
 const res={statusCode:200,headers:{},body:null,setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};
 let next=false;await middleware(req,res,()=>{next=true;});
 if(next)await routes.get('/driver-cash-credit')(req,res);
 return res;
}
await test('actual route requires Bearer auth and marks responses private/no-store',async()=>{const r=await request('');assert.equal(r.statusCode,401);assert.equal(r.headers['Cache-Control'],'private, no-store');});
await test('actual route rejects invalid token before financial RPC',async()=>{authResult={data:{user:null},error:{}};requestDb=db();const r=await request();assert.equal(r.statusCode,401);assert.equal(requestDb.calls.length,0);authResult={data:{user:{id:driver}},error:null};});
await test('actual route derives owner from verified token, ignoring supplied scope',async()=>{requestDb=db();const r=await request('Bearer valid',{driverId:'victim',tenantId:'victim',currency:'GBP'});assert.equal(r.statusCode,200);assert.deepEqual(requestDb.calls[0].args,{p_driver_id:driver});assert.equal(r.body.currency,'NGN');});
await test('actual route rejects customer role from authoritative RPC',async()=>{requestDb=db(null,{code:'CE002'});const r=await request();assert.equal(r.statusCode,403);assert.equal(r.body.code,'CASH_CREDIT_NOT_ELIGIBLE');});
await test('actual route returns 503 for missing migration without inventing balance',async()=>{requestDb=db(null,{code:'PGRST202'});const r=await request();assert.equal(r.statusCode,503);assert.equal(r.body.code,'CASH_CREDIT_UNAVAILABLE');assert.equal(r.body.balance,undefined);});
await test('actual route auth outage is fail closed',async()=>{authThrows=true;requestDb=db();const r=await request();assert.equal(r.statusCode,503);assert.equal(requestDb.calls.length,0);authThrows=false;});
delete globalThis.__b1fRouteMocks;
console.log(`BATCH1F_SERVICE_AND_ROUTE_RUNTIME=${count}_PASSED`);
// The production acquisition wrapper itself, with only its DB/payout dependencies injected.
const bookingCode=stripTypeScriptTypes(readFileSync(new URL('../server/routes/booking.routes.ts',import.meta.url),'utf8'));
const start=bookingCode.indexOf('async function requirePayoutEligible('),end=bookingCode.indexOf('\n/**',start);
assert.ok(start>=0&&end>start);
let payouts=0,markets=0;
const acquisition=new Function('supabaseAdmin','assertDriverJobMarket','cashRideAcquisitionApproved','PayoutEligibilityService','mapCashCreditError','DriverPaymentAccountService','sandboxDestinationProvider',
 'return ('+bookingCode.slice(start,end).trim()+');')(
 {rpc(...args){return requestDb.rpc(...args);}},async()=>{markets++;},api.cashRideAcquisitionApproved,
 {async assertEligible(){payouts++;}},api.mapCashCreditError,
 class {async ready(){payouts++;return {currency:'NGN'};}},()=>{});
const response=()=>({statusCode:200,body:null,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}});
await test('actual acquisition wrapper skips Stripe only for enabled approved cash Ride',async()=>{requestDb=db();payouts=markets=0;assert.equal(await acquisition(driver,response(),job()),true);assert.equal(payouts,0);assert.equal(markets,1);});
await test('actual acquisition wrapper preserves payout check while pilot disabled',async()=>{const s=state();s.pilotEnabled=false;requestDb=db(s);payouts=0;assert.equal(await acquisition(driver,response(),job()),true);assert.equal(payouts,1);});
await test('actual acquisition wrapper keeps card payout guard',async()=>{requestDb=db();payouts=0;assert.equal(await acquisition(driver,response(),{...job(),payment_method:'card'}),true);assert.equal(payouts,1);assert.equal(requestDb.calls.length,0);});
await test('actual acquisition wrapper stops on cash reconciliation failure',async()=>{const s=state();s.balance.deficitMinor='1';requestDb=db(s);payouts=0;const r=response();assert.equal(await acquisition(driver,r,job()),false);assert.equal(r.statusCode,409);assert.equal(r.body.code,'CASH_CREDIT_RECONCILIATION_REQUIRED');assert.equal(payouts,0);});
let eligibilityCode=stripTypeScriptTypes(readFileSync(new URL('../server/services/driver-eligibility.service.ts',import.meta.url),'utf8'));
globalThis.__b1fErrorMapper=api.mapCashCreditError;
eligibilityCode=eligibilityCode.replace(/import\s*\{\s*mapCashCreditError\s*\}\s*from\s*'\.\/driver-cash-credit'\s*;/,'const mapCashCreditError=globalThis.__b1fErrorMapper;');
const eligibility=await import('data:text/javascript;base64,'+Buffer.from(eligibilityCode).toString('base64'));
await test('existing acquisition mapper includes all cash database errors',async()=>{for(let i=1;i<=6;i++)assert.deepEqual(eligibility.mapDriverAcquisitionError({code:'CE00'+i}),api.mapCashCreditError({code:'CE00'+i}));});
await test('existing driver-busy contract is preserved',async()=>assert.equal(eligibility.mapDriverAcquisitionError({code:'MB001'}).code,'DRIVER_BUSY'));
await test('existing compliance contract and safe blocking codes are preserved',async()=>{const r=eligibility.mapDriverAcquisitionError({code:'MB002',details:'document.missing,private data'});assert.equal(r.code,'DRIVER_NOT_ELIGIBLE');assert.deepEqual(r.blocking,['document.missing']);});
delete globalThis.__b1fErrorMapper;
console.log(`BATCH1F_ALL_BEHAVIORAL_RUNTIME=${count}_PASSED`);
