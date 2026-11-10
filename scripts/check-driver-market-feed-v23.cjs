const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
(async()=>{
 const root=path.resolve(__dirname,'..'),effects=[];let actor={id:'gb-driver'},profile={id:actor.id,registration_country_code:'GB',tenant_id:'tenant'},rows=[],pending=null,fail=null,queryCount=0;
 const signal=value=>{const fn=()=>value;fn.set=v=>value=v;fn.update=f=>value=f(value);return fn;};
 const db={from(){queryCount++;const q={select(){return q;},eq(){return q;},or(){return q;},order(){if(pending)return pending;return Promise.resolve({data:rows,error:fail});}};return q;}};
 const auth={currentUser:()=>actor,tenantId:()=>profile.tenant_id,profileService:{profile:()=>profile}};
 const dependencies={SupabaseService:db,AuthService:auth,BookingService:{mapJobToBooking:j=>j,getBooking:async id=>rows.find(j=>j.id===id)},MarketplaceHybridService:{loadSettings:async()=>{}},VehicleCompatibilityService:{isCompatible:()=>true},DriverRequestStateService:{has:()=>false}};
 const context=vm.createContext({console:{log(){},warn(){},error(){}},process,Date,setTimeout,clearTimeout});
 const guard=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path.join(root,'server/services/driver-market-scope.ts'),'utf8')),{context});await guard.link(()=>{});await guard.evaluate();
 let source=fs.readFileSync(path.join(root,'src/app/core/services/driver/driver.service.ts'),'utf8').replace(/@Injectable\(\{[\s\S]*?\}\)\s*/,'');source=stripTypeScriptTypes(source,{mode:'transform'});
 const module=new vm.SourceTextModule(source,{context});
 await module.link(async spec=>{
  const match=[...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].find(m=>m[2]===spec);
  const exports={};
  for(const raw of (match?.[1]||'').split(',')){const name=raw.trim().split(/\s+as\s+/)[0];if(name)exports[name]={name};}
  if(spec==='@angular/core')Object.assign(exports,{signal,inject:token=>dependencies[token.name]||{},effect:f=>{effects.push(f);f();}});
  if(spec==='@shared/utils/driver-market-scope')exports.driverMatchesJobMarket=guard.namespace.driverMatchesJobMarket;
  return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);},{context});
 });await module.evaluate();const driver=new module.namespace.DriverService();
 driver.refreshDeclinedJobs=async()=>{};driver.fetchHybridOpportunities=async()=>[];driver.fetchRecoverableNegotiations=async()=>[];driver.vehicle.set({});
 const job=(id,country,tenant='tenant')=>({id,country_code:country,tenant_id:tenant,status:'searching',payment_status:'authorized',driver_id:null});
 let cases=0;rows=[job('gb','GB'),job('ng','NG'),job('foreign-tenant','GB','another')];await driver.fetchAvailableJobs();assert.deepEqual(Array.from(driver.availableJobs(),j=>j.id),['gb']);cases++;
 assert.equal(driver.isAvailableRequest(job('ng','NG')),false);cases++;
 profile={...profile,registration_country_code:'NG'};await driver.fetchAvailableJobs();assert.deepEqual(Array.from(driver.availableJobs(),j=>j.id),['ng']);cases++;
 fail=Error('database offline');await assert.rejects(driver.fetchAvailableJobs());assert.equal(driver.availableJobs().length,0);fail=null;cases++;
 // A late response for the old owner must never populate the new owner's wallet.
 let resolveOld;pending=new Promise(resolve=>resolveOld=resolve);const old=driver.fetchEarnings();
 actor={id:'ng-driver'};profile={...profile,id:actor.id};effects.forEach(f=>f());pending=null;rows=[{driver_id:actor.id,currency_code:'NGN',amount:100,status:'pending'}];await driver.fetchEarnings();resolveOld({data:[{driver_id:'gb-driver',currency_code:'GBP',amount:999}],error:null});await old;
 assert.equal(driver.earnings()[0].driver_id,'ng-driver');cases++;
 fail=Error('ledger unavailable');await assert.rejects(driver.fetchEarnings());assert.equal(driver.earnings().length,0);assert.match(driver.earningsError(),/could not be loaded/);assert.equal(driver.earningsLoading(),false);fail=null;cases++;
 driver.connectService={getPayoutSettings:async()=>{throw Error('unverified');}};queryCount=0;assert.equal(await driver.fetchStripeAccount(),null);assert.equal(queryCount,0);assert.equal(driver.stripeAccount(),null);cases++;
 actor=null;effects.forEach(f=>f());assert.equal(driver.earnings().length,0);assert.equal(driver.availableJobs().length,0);cases++;
 console.log('ACTUAL_DRIVER_FEED_AND_WALLET_CASES='+cases+'_PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
