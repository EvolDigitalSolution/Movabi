'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
module.exports=function load(db){
 const file=path.join(__dirname,'compiled/after/routes/driver-onboarding.routes.js'),normal=createRequire(file);
 const deps={
  '../services/supabase.service':{supabaseAdmin:db},
  '../services/gb-mot-monitor.service':{GbMotMonitorService:{}},
  '../services/gb-mot.service':{GbMotService:{enabled:()=>false}},
  '../services/market-availability.service':{MarketAvailabilityService:{requireCapability:async({countryCode})=>{
   const r=await db.from('market_availability').select('supported_currency').eq('country_code',countryCode);
   if(r.error||r.data?.length!==1)throw Error('Fixture market unavailable');
  }}},
  '../services/driver-onboarding-notification.service':{DriverOnboardingNotificationService:{}},
  '../services/driver-eligibility.service':{evaluateDriverServiceEligibility:()=>{throw Error('Unrelated eligibility endpoint is outside this fixture');}},
 };
 const module={exports:{}};
 vm.runInThisContext('(function(require,module,exports,__filename,__dirname){'+fs.readFileSync(file,'utf8')+'\n})',{filename:file})(name=>Object.hasOwn(deps,name)?deps[name]:normal(name),module,module.exports,file,path.dirname(file));
 return module.exports.default;
};
