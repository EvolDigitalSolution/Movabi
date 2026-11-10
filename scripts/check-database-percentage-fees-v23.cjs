const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
(async()=>{
 const root=path.resolve(__dirname,'..'),context=vm.createContext({console,process});
 const modules=new Map();let stored=null;
 const mocks={
  './city.service':{CityConfig:{}},
  './issuing-capacity.service':{IssuingCapacityService:{assertAvailable:async()=>{throw Error('NO_ISSUING');}}},
  './supabase.service':{supabaseAdmin:{from(){return {update(value){stored=value;return this;},eq(){return this;},select(){return this;},single:async()=>({data:{quote_reference:'q'},error:null})};}}},
  './marketplace-config.service':{MarketplaceConfigService:{canonicalServiceSlug:s=>s},DynamicPricingSettings:{},PlatformFeeMode:{},PlatformFeeSettings:{},EffectiveDynamicPricingSettings:{}},
  './market-pricing.service':{MarketPricingService:{},resolveMarketPricingStrategy:()=>null},
  './fare-split.service':{FareSplitService:{POLICY_VERSION:'fare-split-v1'}},
  './no-show.service':{NoShowService:{}},
 };
 async function load(file){if(modules.has(file))return modules.get(file);const m=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(file,'utf8').replace('PaymentMarginService, PaymentMarginPolicy','PaymentMarginService'),{mode:'transform'}),{context});modules.set(file,m);await m.link(async spec=>{if(mocks[spec])return new vm.SyntheticModule(Object.keys(mocks[spec]),function(){for(const [k,v]of Object.entries(mocks[spec]))this.setExport(k,v);},{context});return load(path.resolve(path.dirname(file),spec+'.ts'));});return m;}
 const mod=await load(path.join(root,'server/services/pricing.service.ts'));await mod.evaluate();const service=mod.namespace.PricingService;
 let supplied;service.resolveUnprotectedPrice=async()=>structuredClone(supplied);
 function fixture(currency='NGN') {return {currencyCode:currency,source:'regional_pricing_rule',totalPrice:6079.5,platformFee:289.5,driverPayout:4921.5,commissionFee:868.5,commissionRateUsed:15,pricingPlanUsed:'starter',fareBreakdown:{serviceFareBeforePlatformFee:5790,platformFeeType:'percentage',platformFeePercent:5,platformFeeFixed:0,platformFeeMaximum:null,platformFeeSource:'marketplace_settings',shoppingBudget:0}};}
 let count=0;for(const currency of ['NGN','GHS','KES','ZAR','USD']){supplied=fixture(currency);const r=await service.resolvePrice({countryCode:currency==='NGN'?'NG':'GH',currencyCode:currency,serviceSlug:'errand'});assert.equal(r.totalPrice,6079.5);assert.equal(r.platformFee,289.5);assert.equal(r.driverPayout,4921.5);assert.equal(r.commissionFee,868.5);assert.equal(r.fareBreakdown.platformFeeType,'percentage');assert.equal(r.fareBreakdown.platformFeeFixed,0);assert.equal(r.fareBreakdown.paymentCostStatus,'not_estimated');assert.equal(r.fareBreakdown.paymentMargin,undefined);assert.equal(r.fareBreakdown.reconciliationValid,true);count++;}
 for(const change of [{platformFeeType:'fixed'},{platformFeeSource:'safe_zero_default'},{platformFeeFixed:20},{platformFeePercent:NaN},{platformFeePercent:100}]){supplied=fixture();Object.assign(supplied.fareBreakdown,change);await assert.rejects(service.resolvePrice({countryCode:'NG',currencyCode:'NGN'}),/Payment cost policy/);count++;}
 supplied=fixture();await service.resolvePrice({countryCode:'NG',currencyCode:'NGN',quoteReference:'q'});assert.equal(stored.protected_fare_snapshot.quoteFeePolicy,'database_percentage_v1');assert.equal(stored.returned_customer_fare,6079.5);count++;
 supplied=fixture('GBP');const gb=await service.resolvePrice({countryCode:'GB',currencyCode:'GBP'});assert.equal(gb.fareBreakdown.paymentMargin.policy.currency,'GBP');assert.equal(gb.fareBreakdown.paymentCostStatus,undefined);assert.equal(gb.fareBreakdown.platformFeeType,'percentage');count++;
 supplied=fixture();await assert.rejects(service.resolvePrice({countryCode:'NG',currencyCode:'NGN',serviceSlug:'errand',budget:100}),/Shopping funding|NO_ISSUING/);count++;
 console.log('DATABASE_PERCENTAGE_ACTUAL_QUOTE_CASES='+count+'_PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
