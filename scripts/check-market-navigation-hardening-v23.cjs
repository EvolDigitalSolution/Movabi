const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
(async()=>{
 const root=path.resolve(__dirname,'..'),context=vm.createContext({console,process,URL,AbortSignal,fetch,setTimeout,clearTimeout,structuredClone});let cases=0;
 async function load(relative,mocks={}){
  const text=fs.readFileSync(path.join(root,relative),'utf8');
  const m=new vm.SourceTextModule(stripTypeScriptTypes(text,{mode:'transform'}),{context});
  await m.link(async spec=>{const values=mocks[spec];if(!values)throw Error('Unexpected dependency '+spec);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});});await m.evaluate();return m.namespace;
 }
 const {driverMatchesJobMarket:matches,assertDriverJobMarket:check}=await load('server/services/driver-market-scope.ts');
 const gb={id:'driver',role:'driver',registration_country_code:'GB',country_code:'GB',tenant_id:'tenant'};
 const ngJob={id:'job',country_code:'NG',tenant_id:'tenant',metadata:{country_code:'NG'}};
 assert.equal(matches(gb,ngJob),false);cases++;
 assert.equal(matches({...gb,country_code:'NG'},ngJob),false);cases++;
 assert.equal(matches({...gb,registration_country_code:'NG',country_code:'NG'},ngJob),true);cases++;
 for(const profile of [{...gb,registration_country_code:'',country_code:''},{...gb,tenant_id:''},{...gb,tenant_id:'another'}]){assert.equal(matches(profile,ngJob),false);cases++;}
 assert.equal(matches({...gb,registration_country_code:'NG'},{...ngJob,metadata:{country_code:'GB'}}),false);cases++;
 const db=profile=>({from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:profile,error:null})})});
 await assert.rejects(check(db(gb),'driver',ngJob),e=>e.code==='DRIVER_MARKET_MISMATCH');cases++;
 await assert.rejects(check(db(null),'driver',ngJob),e=>e.code==='DRIVER_MARKET_MISMATCH');cases++;
 await check(db({...gb,registration_country_code:'NG'}),'driver',ngJob);cases++;
 const {stripeCheckoutMarket,bookingQuoteState,driverWalletPayoutState}=await load('server/services/booking-payment-context.ts');
 for(const [country,currency,expected]of [['NG','NGN',false],['GH','GHS',false],['GB','NGN',false],['GB','GBP',true],['','GBP',false]]){assert.equal(stripeCheckoutMarket({country_code:country,currency_code:currency}),expected);cases++;}
 assert.equal(stripeCheckoutMarket({country_code:'GB',currency_code:'GBP',metadata:{country_code:'NG'}}),false);cases++;
 for(const [supported,eligibility,label,available]of [[false,null,'Payout setup pending',false],[true,{eligible:true},'Payout account connected',true],[true,{code:'ACCOUNT_UNVERIFIABLE'},'Payout verification unavailable',false],[true,{code:'PAYOUT_ACCOUNT_OWNER_MISMATCH'},'Payout account needs review',false],[true,{code:'NO_STRIPE_ACCOUNT'},'Payout setup required',false]]){const state=driverWalletPayoutState(supported,eligibility);assert.equal(state.status,label);assert.equal(state.payoutAvailable,available);cases++;}
 const now=Date.now(),job={status:'requested',quote_id:'q',metadata:{quote_expires_at:new Date(now+300000).toISOString()},fare_breakdown:{calculationVersion:'marketplace-v1'}};
 assert.equal(bookingQuoteState(job,now),'current');cases++;
 assert.equal(bookingQuoteState(job,now+300001),'expired');cases++;
 assert.equal(bookingQuoteState({...job,status:'expired'},now),'expired');cases++;
 assert.equal(bookingQuoteState({...job,metadata:{quote_expires_at:'bad'}},now),'unavailable');cases++;
 assert.equal(bookingQuoteState({...job,quote_id:null},now),'unavailable');cases++;
 const {earningsSummary,recordedPayoutLabel,recordedEarningAmount}=await load('src/app/shared/utils/earnings-currency.ts');
 const rows=[{currency_code:'GBP',status:'paid',amount:'59.46'},{currency_code:'NGN',status:'paid',amount:'3528.54'},{currency_code:'GBP',status:'processing',amount:'15.97'}];
 const summary=earningsSummary(rows,'paid');assert.match(summary,/GBP.*59\.46/);assert.match(summary,/NGN.*3,528\.54/);cases++;
 assert.match(earningsSummary(rows,'pending'),/GBP.*15\.97/);cases++;
 assert.equal(recordedEarningAmount({amount:99}),'Currency unavailable');cases++;
 assert.equal(recordedPayoutLabel({status:'unknown'}),'Payout needs reconciliation');cases++;
 assert.equal(recordedPayoutLabel({status:'paid',stripe_transfer_id:'tr_original'}),'Transferred to Stripe account');cases++;
 assert.match(earningsSummary([{currency_code:'NGN',status:'unknown',amount:'1200'}],'review'),/1,200/);cases++;
 const {MapsV23}=await load('server/services/maps-v23.ts');
 const env={VAYDU_MAPBOX_GEOCODING_V23:'true',VAYDU_TOMTOM_ROUTING_V23:'true',MAPBOX_GEOCODING_TOKEN:'test-only',TOMTOM_API_KEY:'test-only'};
 const start={lat:7.325884,lng:5.163355},end={lat:7.251028,lng:5.170483},hosts=[];
 const response=data=>({ok:true,text:async()=>JSON.stringify(data)});
 const tomtom={routes:[{summary:{lengthInMeters:9400,travelTimeInSeconds:822},legs:[{points:[{latitude:start.lat,longitude:start.lng},{latitude:end.lat,longitude:end.lng}]}]}]};
 const mapbox={routes:[{distance:9400,duration:822,geometry:{coordinates:[[start.lng,start.lat],[end.lng,end.lat]]},legs:[]}]};
 let maps=new MapsV23(env,async u=>{hosts.push(u.hostname);return response(tomtom);});
 assert.equal((await maps.route(start,end)).provider,'tomtom');assert.deepEqual(hosts,['api.tomtom.com']);cases++;
 hosts.length=0;maps=new MapsV23(env,async u=>{hosts.push(u.hostname);if(u.hostname==='api.tomtom.com')return {ok:false,status:503};return response(mapbox);});
 const results=await Promise.all([maps.route(start,end),maps.route(start,end)]);assert.equal(results[0].provider,'mapbox');assert.deepEqual(hosts,['api.tomtom.com','api.mapbox.com']);cases++;
 await maps.route(start,end);assert.equal(hosts.length,2);cases++;
 hosts.length=0;maps=new MapsV23(env,async u=>{hosts.push(u.hostname);return {ok:false,status:503};});
 await assert.rejects(maps.route(start,end),/MAP_PROVIDER_UNAVAILABLE/);assert.deepEqual(hosts,['api.tomtom.com','api.mapbox.com']);cases++;
 hosts.length=0;await assert.rejects(maps.route(start,end));assert.equal(hosts.length,0);cases++;
 hosts.length=0;maps=new MapsV23(env,async u=>{hosts.push(u.hostname);if(u.hostname==='api.mapbox.com')return {ok:false,status:503};return response({results:[{position:{lat:start.lat,lon:start.lng},address:{freeformAddress:'Obele Estate Road, Akure',countryCode:'NG',streetName:'Obele Estate Road'}}]});});
 const search=await maps.search('Obele Estate Road','NG',start);assert.equal(search.results[0].countryCode,'NG');assert.deepEqual(hosts,['api.mapbox.com','api.tomtom.com']);cases++;
 await maps.search('Obele Estate Road','NG',start);assert.equal(hosts.length,2);cases++;
 console.log('MARKET_NAVIGATION_HARDENING_CASES='+cases+'_PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
