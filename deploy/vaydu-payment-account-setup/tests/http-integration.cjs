'use strict';
const assert=require('node:assert/strict'),express=require('express');
const {createClient}=require('@supabase/supabase-js');
const cfg=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
if(cfg.integrationHashes)for(const [file,expected] of Object.entries(cfg.integrationHashes)){
 const actual=require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/app/'+file)).digest('hex');
 assert.equal(actual,expected,'candidate reviewed source mismatch: '+file);
}
const closure=cfg.closureRoot||require('node:path').resolve(__dirname,'../api');
const {FlutterwaveDriverPayout}=require(closure+'/services/payments/flutterwave-driver-payout.js');
const mount=require(closure+'/mount.cjs');
const driver='318e6be9-9164-41fa-bb0c-c5ccd3526585';
const transport=async(url,init)=>{
 const u=new URL(url),auth=u.pathname.startsWith('/auth/v1/');u.hostname=auth?(cfg.authHost||'127.0.0.1'):(cfg.restHost||'127.0.0.1');u.port=String(auth?cfg.authPort:cfg.restPort);
 u.pathname=u.pathname.replace(/^\/(auth|rest)\/v1/,'');return fetch(u,init);
};
const db=createClient('http://127.0.0.1:1',cfg.serviceKey,{global:{fetch:transport},auth:{persistSession:false,autoRefreshToken:false}});
let posts=0,mode='success';
const provider=new FlutterwaveDriverPayout('FLWSECK_TEST-synthetic','synthetic-fingerprint-key-at-least-32',async(url,init)=>{
 const path=new URL(url).pathname;let data;
 if(path==='/v3/banks/NG')data=[{code:'044',name:'Fixture Bank',has_branches:false}];
 else if(path==='/v3/accounts/resolve')data={account_number:'0123456789',account_name:'Fixture Driver'};
 else if(path==='/v3/beneficiaries'&&init.method==='POST'){
  posts++;if(mode==='timeout')throw Error('fixture timeout');
  if(mode==='persistence-failure')await sql('REVOKE UPDATE ON public.driver_payment_accounts FROM service_role;');
  data={id:123};
 }else if(path==='/v3/beneficiaries/123'){
  if(mode==='verify-failure')throw Error('fixture unavailable');data={id:123,bank_code:'044',account_number:'0123456789'};
 }else throw Error('Unexpected provider endpoint');
 return new Response(JSON.stringify({status:'success',data}),{status:200});
});
const app=express();app.use(express.json());mount(app,{db,provider:()=>provider,requestLimit:200});
app.use('/api/driver-onboarding',require('./load-onboarding.cjs')(db));
const server=app.listen(0,'127.0.0.1');
async function sql(statement){const r=await fetch(cfg.control,{method:'POST',headers:cfg.controlRpc?{Authorization:'Bearer '+cfg.serviceKey,'Content-Type':'application/json'}:undefined,body:cfg.controlRpc?JSON.stringify({statement}):statement});assert.equal(r.status,200,'fixture SQL operation');if(!cfg.controlRpc)return r.text();const value=await r.json();return value==='true'?'t':value==='false'?'f':value;}
async function call(path,body,token=cfg.driverToken){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/driver-payment-account${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await r.text();let parsed={};try{parsed=JSON.parse(text);}catch{}return {status:r.status,body:parsed};}
const details={bankCode:'044',accountNumber:'0123456789',accountName:'Fixture Driver',confirmed:true};
async function onboard(path,body){
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api/driver-onboarding${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+cfg.driverToken,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};
}
(async()=>{
 await new Promise(r=>server.listening?r():server.once('listening',r));
 const authProbe=await db.auth.getUser(cfg.driverToken);assert.ifError(authProbe.error);
 assert.equal((await call('/status',null,'invalid')).status,401);
 assert.equal((await call('/status',null,cfg.customerToken)).status,409);
 assert.equal((await call('/status',null,cfg.foreignToken)).status,409);
 await sql("UPDATE profiles SET tenant_id='33333333-3333-4333-8333-333333333333' WHERE id='"+driver+"';");
 assert.equal((await call('/status')).status,409,'same authenticated UUID with foreign tenant must be denied');
 await sql("UPDATE profiles SET tenant_id='d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8' WHERE id='"+driver+"';");
 assert.equal((await call('/status')).body.available,false);
 assert.equal((await call('/banks')).status,409);assert.equal(posts,0);
 assert.equal((await call('/setup',details)).status,409);assert.equal(posts,0);
 const bypass=await onboard('/submit-review',{paymentAccountRequired:false,profile:{onboarding_completed:true,is_verified:true,country_code:'GB'},paymentAccount:{provider:'flutterwave',state:'completed',available:true}});
 assert.equal(bypass.status,422);assert(bypass.body.requirements.some(r=>r.code==='payout.payment_account'));
 await sql("UPDATE public.driver_payout_markets SET enabled=true,merchant_approved=true,adapter_ready=true,capability_verified_at=now(),capability_evidence_ref='fixture-only';");
 assert.equal((await call('/banks')).body.banks[0].code,'044');
 for(const forbidden of ['/transfers','/webhook','/subaccounts','/wallet-credit'])assert.equal((await call(forbidden,{})).status,404);
 assert.equal((await call('/resolve',details)).body.accountName,'Fixture Driver');
 assert.equal((await call('/setup',{...details,confirmed:false})).status,409);assert.equal(posts,0);
 // Crash before contact: a lease exists but no durable submission fence.
 const claimSql="SELECT row_to_json(r) FROM public.claim_driver_payment_setup('"+driver+"','d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','NG','NGN','fixture-merchant') r;";
 const stale=JSON.parse(await sql(claimSql));
 await sql("UPDATE public.driver_payment_accounts SET updated_at=now()-interval '6 minutes';");
 const newer=JSON.parse(await sql(claimSql));assert.notEqual(newer.setup_token,stale.setup_token);
 assert.equal(await sql("SELECT public.fence_driver_payment_setup('"+stale.id+"','"+stale.setup_token+"','044','6789','"+'a'.repeat(64)+"');"),'f','stale worker fenced before POST');
 await sql("UPDATE public.driver_payment_accounts SET updated_at=now()-interval '6 minutes';");
 const first=await Promise.all([call('/setup',details),call('/setup',details)]);
 assert(first.some(r=>r.body.state==='completed'));assert.equal(posts,1,'concurrent claims cannot create twice');
 assert.equal((await call('/setup',details)).body.state,'completed');assert.equal(posts,1);
 assert.equal((await call('/reconcile',{})).body.state,'completed');assert.equal(posts,1);
 // Reset is fixture-superuser only; no deployed route can delete history.
 await sql('TRUNCATE public.driver_payment_accounts;');mode='verify-failure';
 assert.equal((await call('/setup',details)).status,409);assert.equal(posts,2);
 assert.equal((await call('/status')).body.state,'reconciliation_required');
 assert.equal((await call('/setup',details)).status,409);assert.equal(posts,2);
 mode='success';assert.equal((await call('/reconcile',{})).body.state,'completed');assert.equal(posts,2);
 await sql('TRUNCATE public.driver_payment_accounts;');mode='persistence-failure';
 assert.equal((await call('/setup',details)).status,409);assert.equal(posts,3);
 await sql('GRANT UPDATE ON public.driver_payment_accounts TO service_role;');
 assert.equal((await call('/setup',details)).status,409);assert.equal(posts,3);
 assert.equal((await call('/reconcile',{})).body.supportRequired,true);
 await sql("SELECT public.bind_driver_payment_recovery(id,'123','fixture-persistence-failure-evidence') FROM public.driver_payment_accounts;");
 mode='success';assert.equal((await call('/reconcile',{})).body.state,'completed');assert.equal(posts,3);
 await sql('TRUNCATE public.driver_payment_accounts;');mode='timeout';
 assert.equal((await call('/setup',details)).status,409);assert.equal(posts,4);
 await sql("UPDATE public.driver_payment_accounts SET updated_at=now()-interval '1 day';");
 assert.equal((await call('/setup',details)).status,409);assert.equal(posts,4);
 assert.equal((await call('/reconcile',{})).body.supportRequired,true);assert.equal(posts,4);
 // Operator-only candidate binding, followed by actual GET verification.
 await sql("SELECT public.bind_driver_payment_recovery(id,'123','fixture-reviewed-provider-evidence') FROM public.driver_payment_accounts;");
 mode='success';assert.equal((await call('/reconcile',{})).body.state,'completed');assert.equal(posts,4);
 // Separate mounts cannot inherit another database/client through require cache.
 const isolated=express();assert.throws(()=>mount(isolated,{db:{}}));
 assert.equal(global.__VAYDU_SUPABASE_ADMIN__,undefined);
 const binding=await db.rpc('bind_driver_payment_recovery',{p_id:stale.id,p_candidate:'123',p_evidence:'untrusted-driver'});assert(binding.error,'manual binding must not be executable by application role');
 assert.equal(await sql("SELECT bool_and(NOT onboarding_completed AND NOT identity_verified) FROM profiles;"),'t');
 const status=await onboard('/status');assert.equal(status.status,200);
 assert.equal(status.body.automaticRequirements.find(r=>r.code==='payout.payment_account').completed,true);
 await sql("UPDATE profiles SET date_of_birth=NULL WHERE id='"+driver+"';");
 const blockedReview=await onboard('/submit-review',{});assert.equal(blockedReview.status,422,'identity still blocks despite completed destination');
 assert.equal(await sql("SELECT onboarding_completed FROM profiles WHERE id='"+driver+"';"),'f');
 await sql("UPDATE profiles SET date_of_birth='1990-01-01' WHERE id='"+driver+"';");
 const submitted=await onboard('/submit-review',{});assert.equal(submitted.status,200,'normal baseline review submission');
 assert.equal(submitted.body.reviewState,'under_review');
 assert.equal(await sql("SELECT onboarding_completed AND NOT identity_verified AND NOT is_verified FROM profiles WHERE id='"+driver+"';"),'t');
 console.log(JSON.stringify({completed:true,realAuth:true,realPostgrest:true,realPostgres:true,packagedMount:true,creationPosts:posts,concurrentClaims:true,completedReplay:true,timeoutNoRetry:true,candidateRecovery:true,complianceUnchanged:true,baselineOnboardingHttp:true,paymentRequirementComplete:true,identityBlocksSubmission:true,normalSubmissionUnderReview:true}));
})().catch(e=>{console.error('integration_failed:',e.stack);process.exitCode=1;}).finally(()=>server.close());
