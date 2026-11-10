const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
(async()=>{
 let identity=null,profile=null,retrieved=[],links=[],accountCountry='GB',accountOwner='driver';const routes=new Map(),middleware=[];
 const router={use:f=>middleware.push(f),get:(p,f)=>routes.set('GET '+p,f),post:(p,f)=>routes.set('POST '+p,f)};
 const stripe={accounts:{retrieve:async id=>{retrieved.push(id);return {id,country:accountCountry,metadata:{user_id:accountOwner},charges_enabled:true,payouts_enabled:true,details_submitted:true};},createLoginLink:async id=>{links.push(id);return {url:'https://connect.stripe.com/owned'};}}};
 const db={auth:{getUser:async()=>({data:{user:identity},error:null})},from(){const q={select(){return q;},eq(){return q;},update(){return q;},maybeSingle:async()=>({data:profile,error:null})};return q;}};
 const mocks={express:{Router:()=>router,Request:{},Response:{}},'../services/stripe.service':{stripe},'../services/supabase.service':{supabaseAdmin:db},'../services/driver-onboarding-notification.service':{DriverOnboardingNotificationService:{enqueue:async()=>{}}},'../services/payout-eligibility.service':{PayoutEligibilityService:{isSupportedCountry:c=>String(c).toUpperCase()==='GB'},SUPPORTED_PAYOUT_COUNTRIES:['GB']}};
 const context=vm.createContext({console:{log(){},warn(){},error(){}},process,URL});const source=fs.readFileSync(path.resolve(__dirname,'../server/routes/connect.routes.ts'),'utf8');
 const m=new vm.SourceTextModule(stripTypeScriptTypes(source,{mode:'transform'}),{context});await m.link(async spec=>{const values=mocks[spec];if(!values)throw Error(spec);return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});});await m.evaluate();
 const owned=()=>({id:'driver',role:'driver',registration_country_code:'GB',registration_activated_at:'2026-01-01',stripe_account_id:'acct_own',stripe_connect_status:'connected',tenant_id:'tenant'});
 async function call(route,body={},params={}){const req={headers:identity?{authorization:'Bearer test'}:{},body,params,path:route==='GET /account-status/:accountId'?'/account-status/'+params.accountId:route.slice(route.indexOf(' ')+1)};const res={code:200,setHeader(){},status(v){this.code=v;return this;},json(value){this.value=value;return this;}};let next=false;await middleware[0](req,res,()=>{next=true;});if(next)await routes.get(route)(req,res);return res;}
 let count=0;
 assert.equal((await call('POST /dashboard-link')).code,401);assert.equal(retrieved.length,0);count++;
 identity={id:'driver'};profile=owned();assert.equal((await call('POST /dashboard-link',{accountId:'acct_other'})).code,403);assert.equal(retrieved.length,0);assert.equal(links.length,0);count++;
 assert.equal((await call('GET /account-status/:accountId',{}, {accountId:'acct_other'})).code,403);assert.equal(retrieved.length,0);count++;
 profile={...owned(),registration_country_code:'NG'};assert.equal((await call('POST /dashboard-link')).code,403);assert.equal(retrieved.length,0);count++;
 profile=owned();accountCountry='US';assert.equal((await call('POST /dashboard-link')).code,403);assert.equal(links.length,0);count++;
 accountCountry='GB';accountOwner='another';assert.equal((await call('POST /dashboard-link')).code,403);assert.equal(links.length,0);count++;accountOwner='driver';
 accountCountry='GB';retrieved=[];assert.equal((await call('POST /dashboard-link')).code,200);assert.deepEqual(links,['acct_own']);assert.deepEqual(retrieved,['acct_own']);count++;
 retrieved=[];assert.equal((await call('POST /dashboard-link',{userId:'another'})).code,403);assert.equal(retrieved.length,0);count++;
 profile={...owned(),role:'customer'};assert.equal((await call('POST /dashboard-link')).code,403);count++;
 profile=owned();retrieved=[];assert.equal((await call('GET /account-status/:accountId',{}, {accountId:'acct_own'})).code,200);assert.deepEqual(retrieved,['acct_own']);count++;
 console.log('ACTUAL_WALLET_OWNER_BOUNDARY_CASES='+count+'_PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
