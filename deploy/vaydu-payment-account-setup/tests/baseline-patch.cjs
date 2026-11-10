'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),{apply,plan}=require('../patch-entry.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vaydu-baseline-patch-'));
function reset(){for(const f of plan.files){const target=path.join(temp,f.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,'baseline',f.path),target);}fs.writeFileSync(path.join(temp,'server/services/supabase.service.ts'),'export const supabaseAdmin={};');}
try{
 reset();assert.equal(apply(temp).patchedFiles,3);assert.equal(apply(temp).alreadyPatched,true);
 const entry=fs.readFileSync(path.join(temp,'server/index.ts'),'utf8');assert(entry.includes("app.use('/api/payment/market-provider', marketProviderLookupRoutes);"));
 assert(!entry.includes('flutterwave-booking-split'));assert(!entry.includes('driver-topup'));
 const before=require('./compiled/before/services/driver-requirement.service.js').DriverRequirementService;
 const after=require('./compiled/after/services/driver-requirement.service.js').DriverRequirementService;
 let unchanged=0;
 for(const country of ['GB','NG','GH'])for(const verified of [true,false])for(const service of ['delivery','ride','van-moving']){
  const input={profile:{id:'unrelated',country_code:country,full_name:'Fixture Driver',phone:'+447700900001',current_address:'Fixture address',date_of_birth:'1990-01-01',driver_service_types:[service],is_verified:verified,stripe_connect_status:verified?'connected':'pending'},authEmailConfirmed:true,now:new Date('2026-10-29T00:00:00Z')};
  assert.deepEqual(after.resolve(input),before.resolve(input));unchanged++;
 }
 const input={profile:{id:'318e6be9-9164-41fa-bb0c-c5ccd3526585',country_code:'NG',driver_service_types:['delivery']},authEmailConfirmed:true,paymentAccountRequired:true};
 const missing=after.resolve(input);assert(missing.automaticRequirements.find(r=>r.code==='payout.payment_account').blockingForSubmission);
 const complete=after.resolve({...input,paymentAccount:{provider:'flutterwave',available:true,state:'completed'}});
 assert(complete.automaticRequirements.find(r=>r.code==='payout.payment_account').completed);
 assert(complete.automaticRequirements.find(r=>r.code==='profile.date_of_birth').blockingForSubmission);
 assert.equal(complete.onlineEligibility.allowed,false);
 reset();const first=plan.files[0];fs.appendFileSync(path.join(temp,first.path),'\n// unknown source');
 assert.throws(()=>apply(temp),/baseline_or_partial/);
 for(const f of plan.files.slice(1))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(temp,f.path))).digest('hex'),f.beforeSha256);
 reset();const f=plan.files[0];let partial=fs.readFileSync(path.join(temp,f.path),'utf8');for(const e of f.operations)partial=partial.replace(e.before,e.after);fs.writeFileSync(path.join(temp,f.path),partial);
 assert.throws(()=>apply(temp),/baseline_or_partial/);
 console.log(JSON.stringify({completed:true,unchangedDeployedRuleCases:unchanged,selectedDriverMandatory:true,identityStillRequired:true,firstRepeatPartialPatchGuards:true,marketProviderRoutePreserved:true}));
}finally{fs.rmSync(temp,{recursive:true});}
