#!/usr/bin/env node
/*
 * Actual-request verification of the DEPLOYED server address search (MapsV23), run inside the API
 * container so it uses the container's own provider configuration. Read-only: no database access,
 * no configuration change. Makes about 13 provider requests (one per case; no retries).
 *
 *   docker cp scripts/verify-server-place-search.cjs movabi-develop-api:/tmp/verify-server-place-search.cjs
 *   docker exec -e TS_NODE_PROJECT=server/tsconfig.json -w /app movabi-develop-api \
 *     node -r ts-node/register/transpile-only /tmp/verify-server-place-search.cjs --countries GB,NG
 *
 * Never prints provider credentials: every URL is printed with access_token/key replaced, and the
 * whole output is checked against the token values before it is written. Exit code 1 on any failure.
 */
'use strict';
const path=require('node:path');
const args=process.argv.slice(2);
const arg=(name,fallback)=>{const i=args.indexOf('--'+name);return i>=0&&args[i+1]?args[i+1]:fallback;};
const countries=arg('countries','GB').toUpperCase();
const appRoot=arg('app','/app');
const {MapsV23}=require(path.join(appRoot,'server/services/maps-v23'));

const secrets=[process.env.MAPBOX_GEOCODING_TOKEN,process.env.TOMTOM_API_KEY].filter(v=>typeof v==='string'&&v.length>=8);
const redact=u=>{const x=new URL(String(u));for(const k of ['access_token','key'])if(x.searchParams.has(k))x.searchParams.set(k,'REDACTED');return x.toString();};
const lines=[];let failures=0;
const out=s=>lines.push(s);
const check=(ok,label,detail='')=>{out(`${ok?'PASS':'FAIL'}  ${label}${detail?'  ('+detail+')':''}`);if(!ok)failures++;};

const requests=[];
const recording=(block)=>async(url,init)=>{
 const u=new URL(String(url));
 const entry={host:u.hostname,path:u.pathname.replace(/\/search\/2\/search\/.*$/,'/search/2/search/<query>'),url:redact(u),permanent:u.searchParams.getAll('permanent'),ms:0,status:0};
 requests.push(entry);
 if(block&&block(u)){entry.status='blocked-by-test';throw new Error('blocked by verification');}
 const started=Date.now();
 try{const r=await fetch(url,init);entry.status=r.status;return r;}finally{entry.ms=Date.now()-started;}
};
const summary=r=>(r.results||[]).slice(0,3).map(x=>`${x.primaryText} [${x.countryCode}${x.placeType?'/'+x.placeType:''}]`).join(' | ')||'(no results)';

async function run(label,maps,query,code,origin,expect,options){
 const before=requests.length;
 try{
  const r=options?await maps.search(query,code,origin,options):await maps.search(query,code,origin);
  const used=requests.slice(before).map(e=>`${e.host}:${e.status}:${e.ms}ms`).join(', ');
  out(`      ${label}: "${query}" in ${code} -> ${r.results.length} result(s), attribution ${r.attribution}; ${summary(r)}; requests ${used||'cached'}`);
  if(expect)expect(r);
  return r;
 }catch(e){
  out(`      ${label}: "${query}" in ${code} -> error ${String(e&&e.message||e)}`);
  if(expect)check(false,label,'request failed');
  return null;
 }
}

(async()=>{
 const live=new MapsV23(process.env,recording());
 const cfg=live.configuration();
 out(`configuration: search=${cfg.search} routing=${cfg.routing} countries=${countries} mapboxToken=${process.env.MAPBOX_GEOCODING_TOKEN?'set':'missing'} tomtomKey=${process.env.TOMTOM_API_KEY?'set':'missing'}`);
 check(cfg.search===true,'search is configured');
 const bolton={lat:53.5817,lng:-2.4078};
 const codes=countries.split(',');

 await run('address',live,'10 Downing Street','GB',undefined,r=>check(r.results.some(x=>/downing/i.test(x.label)),'address search returns the street',summary(r)));
 await run('postcode',live,'SW1A 2AA','GB',undefined,r=>check(r.results.some(x=>String(x.postalCode||x.label).replace(/\s/g,'').toUpperCase().includes('SW1A2AA')),'postcode search returns the postcode',summary(r)));
 await run('street+origin',live,'High Street','GB',bolton,r=>check(r.results.length>0&&r.results.every(x=>x.countryCode==='GB'),'street search with origin stays in GB',summary(r)));
 await run('isolation',live,'Victoria Island Lagos','GB',undefined,r=>check(r.results.every(x=>x.countryCode==='GB'),'a GB-only search never returns another country',summary(r)));
 await run('configured countries',live,'Victoria Island',codes.join(','),undefined,r=>check(r.results.every(x=>codes.includes(x.countryCode)),'global search returns only configured countries',summary(r)));
 // Landmark, business and category searches must FULFIL the request, not just return HTTP 200:
 // real POIs, the exact terminal, the full business name, provider category data, inside the radius
 // and the market. A build without intent routing fails these checks (that is the correct outcome).
 const km=(a,b)=>{const r=Math.PI/180,dl=(b.lat-a.lat)*r,dn=(b.lng-a.lng)*r,x=Math.sin(dl/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dn/2)**2;return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
 const nameOf=x=>String(x.primaryText||x.label||'');
 const terminalOf=t=>{const m=String(t).match(/\bterminal\s*(\d{1,2}[a-z]?)\b|\bt\s*(\d{1,2}[a-z]?)\b/i);return m?(m[1]||m[2]).toLowerCase():undefined;};
 await run('landmark',live,'Manchester Airport Terminal 2','GB',bolton,r=>{
  check(r.fulfilled===true,'landmark search is fulfilled (intent routing present)',`fulfilled=${r.fulfilled}`);
  check(r.results.length>0&&r.results.every(x=>x.placeType==='poi'&&x.countryCode==='GB'),'landmark results are GB POIs, not roads or areas',summary(r));
  check(r.results.some(x=>terminalOf(nameOf(x))==='2')&&!r.results.some(x=>{const t=terminalOf(nameOf(x));return t&&t!=='2';}),'exact Terminal 2, no other terminal',summary(r));
 },{intent:'landmark'});
 await run('business',live,'Tesco Extra','GB',bolton,r=>{
  check(r.fulfilled===true,'business search is fulfilled',`fulfilled=${r.fulfilled}`);
  check(r.results.length>0&&r.results.every(x=>x.placeType==='poi'&&x.countryCode==='GB'&&/tesco/i.test(nameOf(x))&&/extra/i.test(nameOf(x))),'business results are GB POIs named Tesco Extra (no streets)',summary(r));
 },{intent:'place'});
 await run('category',live,'restaurant','GB',bolton,r=>{
  check(r.fulfilled===true,'category search is fulfilled',`fulfilled=${r.fulfilled}`);
  check(r.results.length>0&&r.results.every(x=>x.placeType==='poi'&&x.countryCode==='GB'&&(x.categories||[]).some(c=>/restaurant|food|cuisine|takeaway/i.test(c))),'category results are GB POIs with restaurant category data (no "Restaurant Terrace")',summary(r));
  check(r.results.every(x=>km(bolton,x)<=10),'category results lie inside the 10 km radius',r.results.map(x=>km(bolton,x).toFixed(1)+'km').join(' '));
 },{intent:'category',radiusKm:10});

 // TomTom fallback with Mapbox unavailable (Mapbox is blocked locally, never called with a bad token).
 if(process.env.TOMTOM_API_KEY){
  const fallback=new MapsV23(process.env,recording(u=>u.hostname==='api.mapbox.com'));
  await run('TomTom fallback',fallback,'Manchester Airport','GB',bolton,r=>check(r.attribution==='© TomTom'&&r.results.length>0&&r.results.every(x=>x.countryCode==='GB'),'TomTom answers when Mapbox is unavailable',summary(r)));
 }else out('SKIP  TomTom fallback (no TOMTOM_API_KEY)');

 // Reverse geocoding (also Mapbox geocoding, so also subject to the permanent guard).
 try{const r=await live.reverse(bolton);out(`      reverse: ${r.label} [${r.countryCode}]`);check(r.countryCode==='GB','reverse geocoding resolves GB');}catch(e){check(false,'reverse geocoding',String(e&&e.message));}

 // Billing guard: every Mapbox geocoding request must carry permanent=false, and nothing may ask for permanent storage.
 const geocoding=requests.filter(e=>e.host==='api.mapbox.com'&&e.path.startsWith('/search/geocode/')&&e.status!=='blocked-by-test');
 check(geocoding.length>0,'Mapbox geocoding was exercised',`${geocoding.length} request(s)`);
 check(geocoding.every(e=>e.permanent.length===1&&e.permanent[0]==='false'),'every Mapbox geocoding request sent permanent=false');
 check(!requests.some(e=>/permanent=true/i.test(e.url)),'no request asked for permanent geocoding');
 out('requests (credentials redacted):');
 for(const e of requests)out(`  ${e.status}\t${e.ms}ms\t${e.url.replace(/\/search\/2\/search\/[^?]*/,'/search/2/search/<query>')}`);

 const text=lines.join('\n');
 if(secrets.some(s=>text.includes(s))){process.stdout.write('FAIL  output contained a provider credential; nothing else printed\n');process.exit(1);}
 process.stdout.write(text+'\n'+(failures?`RESULT: ${failures} check(s) FAILED\n`:'RESULT: all checks passed\n'));
 process.exit(failures?1:0);
})().catch(e=>{process.stdout.write('FAIL  verification crashed: '+String(e&&e.message).replace(/access_token=[^&\s]+|key=[^&\s]+/g,'<redacted>')+'\n');process.exit(1);});
