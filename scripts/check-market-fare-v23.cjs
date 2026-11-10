const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
(async()=>{
 let rows=[];const db={from(){const q={select(){return q;},in(){return q;},eq(){return q;},order:async()=>({data:rows,error:null})};return q;}};
 const context=vm.createContext({console:{log(){},warn(){},error(){}},process});
 async function load(file){const m=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'transform'}),{context});await m.link(async()=>new vm.SyntheticModule(['supabaseAdmin'],function(){this.setExport('supabaseAdmin',db);},{context}));await m.evaluate();return m.namespace;}
 const root=path.resolve(__dirname,'..');const {MarketplaceConfigService:service}=await load(path.join(root,'server/services/marketplace-config.service.ts'));
 const {assertMarketFareConfigured:guard}=await load(path.join(root,'server/services/market-fare-guard.ts'));
 const gb={id:'gb',country_code:null,currency_code:'GBP',base_fare:2.75,per_km:.65};
 rows=[gb];let result=await service.getEffectivePricingConfig('errand',{countryCode:'GB',currencyCode:'GBP'});assert.equal(result.pricingConfigId,'gb');
 result=await service.getEffectivePricingConfig('errand',{countryCode:'NG',currencyCode:'NGN'});assert.equal(result.source,'safe_zero_default');
 rows=[gb,{...gb,id:'ng',country_code:'NG',currency_code:'NGN',base_fare:1000}];result=await service.getEffectivePricingConfig('errand',{countryCode:'NG',currencyCode:'NGN'});assert.equal(result.pricingConfigId,'ng');assert.equal(result.currencyCode,'NGN');
 rows=[{...gb,country_code:'NG'}];result=await service.getEffectivePricingConfig('errand',{countryCode:'NG',currencyCode:'NGN'});assert.equal(result.source,'safe_zero_default');
 rows=[{...gb,country_code:'NG',currency_code:'NGN',market_city:'Lagos'}];result=await service.getEffectivePricingConfig('errand',{countryCode:'NG',currencyCode:'NGN',city:'Akure'});assert.equal(result.source,'safe_zero_default');
 rows=[{...gb,id:'ng-default',country_code:'NG',currency_code:'NGN'},{...gb,id:'lagos',country_code:'NG',currency_code:'NGN',market_city:'Lagos'}];result=await service.getEffectivePricingConfig('errand',{countryCode:'NG',currencyCode:'NGN',city:'Lagos'});assert.equal(result.pricingConfigId,'lagos');
 assert.throws(()=>guard({countryCode:'NG',currencyCode:'NGN'},{currencyCode:'NGN',source:'legacy_fallback'}),e=>e.code==='MARKET_PRICING_NOT_CONFIGURED');
 assert.throws(()=>guard({countryCode:'NG',currencyCode:'NGN'},{currencyCode:'GBP',source:'pricing_config'}),e=>e.code==='MARKET_PRICING_CURRENCY_MISMATCH');
 guard({countryCode:'NG',currencyCode:'NGN'},{currencyCode:'NGN',source:'regional_pricing_rule'});
 guard({countryCode:'GB',currencyCode:'GBP'},{currencyCode:'GBP',source:'legacy_fallback'});
 console.log('MARKET_FARE_ACTUAL_LOOKUP_AND_GUARD_CASES=10_PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
