const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
(async()=>{
 const root=path.resolve(__dirname,'..'),context=vm.createContext({console,process,Date,Promise});let actor='one',calls=0,marketCalls=0,deferred=null,marketFailure=false;
 const signature=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path.join(root,'src/app/shared/utils/quote-signature.ts'),'utf8'),{mode:'transform'}),{context});await signature.link(()=>{});await signature.evaluate();
 const dependencies={SupabaseService:{auth:{getSession:async()=>({data:{session:actor?{user:{id:actor},access_token:'test-only'}:null}})}},HttpClient:{post:()=>{calls++;return deferred||Promise.resolve({quoteReference:'quote-'+calls,priceLockedUntil:new Date(Date.now()+300000).toISOString()});}},ApiUrlService:{getApiUrl:p=>p},MarketAvailabilityClientService:{resolve:async()=>{marketCalls++;if(marketFailure)throw Error('market blocked');}}};
 let text=fs.readFileSync(path.join(root,'src/app/core/services/pricing/global-ai-pricing-quote.service.ts'),'utf8').replace(/@Injectable\(\{[\s\S]*?\}\)\s*/,'');text=stripTypeScriptTypes(text,{mode:'transform'});const m=new vm.SourceTextModule(text,{context});
 await m.link(async spec=>{
  const match=[...text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].find(m=>m[2]===spec);const values={};for(const raw of (match?.[1]||'').split(',')){const name=raw.trim().split(/\s+as\s+/)[0];if(name)values[name]={name};}
  if(spec==='@angular/core')values.inject=token=>dependencies[token.name];
  if(spec==='rxjs')values.firstValueFrom=p=>Promise.resolve(p);
  if(spec.endsWith('/quote-signature'))values.buildQuoteSignature=signature.namespace.buildQuoteSignature;
  return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});
 });await m.evaluate();const service=new m.namespace.GlobalAiPricingQuoteService();const request={lat:7.325884,lng:5.163355,dropoffLat:7.251028,dropoffLng:5.170483,serviceSlug:'ride',countryCode:'NG',currencyCode:'NGN',distanceKm:9.4,durationMinutes:13.7};let cases=0;
 const both=await Promise.all([service.getQuote(request),service.getQuote(request)]);assert.equal(calls,1);assert.equal(marketCalls,1);assert.equal(both[0].quoteReference,both[1].quoteReference);cases++;
 assert.equal((await service.getQuote(request)).quoteReference,both[0].quoteReference);assert.equal(calls,1);cases++;
 service.startNewRequest();const fresh=await service.getQuote(request);assert.notEqual(fresh.quoteReference,both[0].quoteReference);assert.equal(calls,2);cases++;
 actor='two';await service.getQuote(request);assert.equal(calls,3);cases++;
 service.startNewRequest();let release;deferred=new Promise(resolve=>release=resolve);const old=service.getQuote(request);await new Promise(setImmediate);const oldCount=calls;service.startNewRequest();deferred=null;const current=await service.getQuote(request);release({quoteReference:'late-old-quote'});await old;assert.equal((await service.getQuote(request)).quoteReference,current.quoteReference);assert.equal(calls,oldCount+1);cases++;
 service.startNewRequest();marketFailure=true;const before=calls;await assert.rejects(service.getQuote(request),/market blocked/);assert.equal(calls,before);marketFailure=false;cases++;
 actor=null;await assert.rejects(service.getQuote(request),/sign in/);assert.equal(calls,before);cases++;
 console.log('ACTUAL_FRESH_BOOKING_QUOTE_CASES='+cases+'_PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
