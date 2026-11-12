/**
 * Address/place search on the CURRENT pipeline: GeocodingService -> RemoteMapsService ->
 * /api/maps-v23 -> MapsV23 (Mapbox Geocoding v6, TomTom fallback, configured countries only).
 *
 * These tests carry over the behavioural requirements of the older client-pipeline suites
 * (business-place-search, heigit-place-search, local-place-geofence, local-shop-search,
 * named-landmark-search), which exercise legacySearchPlaces — code the app no longer calls.
 * Mapping of each old requirement: docs/ROADMAP_COMPLETION_MATRIX.md, "Address search (D11)".
 *
 * Provider requests here are fakes. Passing these tests is NOT evidence that real requests
 * work; that needs scripts/verify-server-place-search.mjs on the API host.
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {firstValueFrom,of,throwError} from 'rxjs';
import {MapsV23} from '../../server/services/maps-v23';

// ---------------------------------------------------------------- server adapter
const MAPBOX='test-mapbox-secret-token',TOMTOM='test-tomtom-secret-key';
const env={VAYDU_MAPBOX_GEOCODING_V23:'true',MAPBOX_GEOCODING_TOKEN:MAPBOX,TOMTOM_API_KEY:TOMTOM,VAYDU_TOMTOM_ROUTING_V23:'true'};
const ok=(data:unknown)=>({ok:true,status:200,text:async()=>JSON.stringify(data)}) as any;
const fail=(status:number)=>({ok:false,status,text:async()=>'{}'}) as any;
const mbFeature=(name:string,country:string,lng:number,lat:number,type='address',postcode?:string)=>({geometry:{coordinates:[lng,lat]},properties:{name,full_address:`${name}, Town`,place_formatted:'Town',feature_type:type,context:{country:{country_code:country},...(postcode?{postcode:{name:postcode}}:{})}}});
const ttResult=(name:string,country:string,lat:number,lon:number,categories?:string[])=>({type:'POI',poi:{name,...(categories?{categories}:{})},address:{freeformAddress:`1 High Street, Town`,countryCode:country,postalCode:'BL1 1AA'},position:{lat,lon}});
type Seen={url:URL;init:any};
const recorder=(handler:(url:URL)=>any)=>{const seen:Seen[]=[];const network=(async(url:any,init:any)=>{const u=new URL(String(url));seen.push({url:u,init});return handler(u);}) as typeof fetch;return {seen,network};};
const isMapboxGeocoding=(u:URL)=>u.hostname==='api.mapbox.com'&&u.pathname.startsWith('/search/geocode/');

describe('server search: Mapbox permanent-geocoding guard (billing)',()=>{
 it('every Mapbox geocoding request (forward, postcode, reverse) sends permanent=false and never true',async()=>{
  const {seen,network}=recorder(u=>ok(u.pathname.includes('/reverse')?{features:[mbFeature('1 High Street','gb',-2.43,53.58)]}:{features:[mbFeature('High Street','gb',-2.43,53.58)]}));
  const maps=new MapsV23(env,network);
  await maps.search('High Street','GB',{lat:53.58,lng:-2.43});
  await maps.search('BL1 1AA','GB');
  await maps.search('Labuka','GB,NG');
  await maps.reverse({lat:53.58,lng:-2.43});
  const geocoding=seen.filter(s=>isMapboxGeocoding(s.url));
  expect(geocoding.length).toBe(4);
  for(const s of geocoding){
   expect(s.url.searchParams.getAll('permanent')).toEqual(['false']);
   expect(s.url.search).not.toMatch(/permanent=true/i);
  }
 });
 it('no other Mapbox URL builder can produce a geocoding request without the guard',async()=>{
  // Fallback directions is not geocoding (no permanent storage parameter exists for it).
  const {seen,network}=recorder(u=>u.hostname==='api.tomtom.com'?fail(500):ok({routes:[{distance:1000,duration:100,geometry:{coordinates:[[-2.43,53.58],[-2.42,53.59]]},legs:[]}]}));
  await new MapsV23(env,network).route({lat:53.58,lng:-2.43},{lat:53.59,lng:-2.42});
  expect(seen.filter(s=>isMapboxGeocoding(s.url))).toHaveLength(0);
  expect(seen.some(s=>s.url.pathname.startsWith('/directions/'))).toBe(true);
 });
});

describe('server search: addresses, postcodes and country isolation',()=>{
 it('asks Mapbox for address/street/postcode/place types with longitude-first proximity and the configured countries together',async()=>{
  const {seen,network}=recorder(()=>ok({features:[mbFeature('High Street','gb',-2.43,53.58)]}));
  await new MapsV23(env,network).search('High Street','NG,GB',{lat:53.58,lng:-2.43});
  const u=seen[0].url;
  expect(u.searchParams.get('types')).toBe('address,street,postcode,place,locality,neighborhood');
  expect(u.searchParams.get('country')).toBe('gb,ng');
  expect(u.searchParams.get('proximity')).toBe('-2.43,53.58');
  expect(u.searchParams.get('limit')).toBe('8');
 });
 it('returns the postcode of a postcode result and sends no proximity when the caller gives no origin',async()=>{
  const {seen,network}=recorder(()=>ok({features:[mbFeature('BL1 1AA','gb',-2.43,53.58,'postcode','BL1 1AA')]}));
  const r=await new MapsV23(env,network).search('BL1 1AA','GB');
  expect(seen[0].url.searchParams.has('proximity')).toBe(false);
  expect(r.results[0]).toMatchObject({postalCode:'BL1 1AA',countryCode:'GB',placeType:'postcode'});
 });
 it('drops results outside the requested countries from both providers',async()=>{
  const {network}=recorder(u=>u.hostname==='api.mapbox.com'?ok({features:[mbFeature('Victoria Island','ng',3.42,6.43)]}):ok({results:[ttResult('Victoria Island Cafe','NG',6.43,3.42),ttResult('Victoria Cafe','GB',51.5,-.12)]}));
  const r=await new MapsV23(env,network).search('Victoria','GB');
  expect(r.results.map((x:any)=>x.countryCode)).toEqual(['GB']);
 });
 it('rejects a request for an unconfigured or malformed country before any provider call',async()=>{
  const {seen,network}=recorder(()=>ok({features:[]}));
  await expect(new MapsV23(env,network).search('High Street','gb')).rejects.toThrow('INVALID_MAP_COUNTRY');
  expect(seen).toHaveLength(0);
 });
});

describe('server search: TomTom fallback and POI data',()=>{
 it('falls back to TomTom when Mapbox returns no usable result, keeping the business name, categories and country set',async()=>{
  const {seen,network}=recorder(u=>u.hostname==='api.mapbox.com'?ok({features:[]}):ok({results:[ttResult('Labuka Restaurant','GB',53.581,-2.431,['restaurant','african'])]}));
  const r=await new MapsV23(env,network).search('Labuka','GB',{lat:53.58,lng:-2.43});
  const tomtom=seen.find(s=>s.url.hostname==='api.tomtom.com')!.url;
  expect(tomtom.searchParams.get('countrySet')).toBe('GB');
  expect(tomtom.searchParams.get('lat')).toBe('53.58');
  expect(r.attribution).toBe('© TomTom');
  expect(r.results[0]).toMatchObject({primaryText:'Labuka Restaurant',label:'Labuka Restaurant, 1 High Street, Town',placeType:'poi',categories:['restaurant','african'],postalCode:'BL1 1AA'});
 });
 it('does not call TomTom when Mapbox has results (no extra provider spend)',async()=>{
  const {seen,network}=recorder(()=>ok({features:[mbFeature('High Street','gb',-2.43,53.58)]}));
  await new MapsV23(env,network).search('High Street','GB');
  expect(seen.every(s=>s.url.hostname==='api.mapbox.com')).toBe(true);
 });
 it('without a TomTom key an empty Mapbox answer is a real empty result, not an error',async()=>{
  const {network}=recorder(()=>ok({features:[]}));
  const r=await new MapsV23({...env,TOMTOM_API_KEY:undefined},network).search('Nowhere Lane','GB');
  expect(r.results).toEqual([]);
 });
});

describe('server search: timeouts, failures and caching',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('every provider request carries an abort signal (bounded deadline) and refuses redirects',async()=>{
  const {seen,network}=recorder(()=>ok({features:[mbFeature('High Street','gb',-2.43,53.58)]}));
  await new MapsV23(env,network).search('High Street','GB');
  expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
  expect(seen[0].init.redirect).toBe('error');
 });
 it('a Mapbox timeout falls back to TomTom; both timing out is a provider error distinct from no match',async()=>{
  const abort=()=>{throw Object.assign(new Error('The operation was aborted due to timeout'),{name:'TimeoutError'});};
  const tomtomOk=recorder(u=>u.hostname==='api.mapbox.com'?abort():ok({results:[ttResult('Labuka Restaurant','GB',53.58,-2.43)]}));
  expect((await new MapsV23(env,tomtomOk.network).search('Labuka','GB')).results).toHaveLength(1);
  const both=recorder(()=>abort());
  await expect(new MapsV23(env,both.network).search('Labuka','GB')).rejects.toThrow('MAP_PROVIDER_UNAVAILABLE');
 });
 it('never exposes provider credentials in errors or results',async()=>{
  const leaking=recorder(()=>{throw new Error(`fetch failed for https://api.mapbox.com/?access_token=${MAPBOX}&key=${TOMTOM}`);});
  const error=await new MapsV23(env,leaking.network).search('Labuka','GB').catch(e=>e);
  expect(String(error?.message)).toBe('MAP_PROVIDER_UNAVAILABLE');
  const good=recorder(u=>u.hostname==='api.mapbox.com'?ok({features:[]}):ok({results:[ttResult('Labuka','GB',53.58,-2.43)]}));
  const text=JSON.stringify(await new MapsV23(env,good.network).search('Labuka','GB'));
  expect(text).not.toContain(MAPBOX);expect(text).not.toContain(TOMTOM);
 });
 it('caches an empty answer for at most one minute and never caches failures',async()=>{
  let now=1_000_000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const {seen,network}=recorder(()=>ok({features:[]}));
  const maps=new MapsV23({...env,TOMTOM_API_KEY:undefined},network);
  await maps.search('Another shop','GB');await maps.search('Another shop','GB');
  expect(seen).toHaveLength(1);
  now+=61_000;await maps.search('Another shop','GB');
  expect(seen).toHaveLength(2);
 });
 it('keys the cache by location, so another town is a new lookup',async()=>{
  const {seen,network}=recorder(()=>ok({features:[mbFeature('Tesco','gb',-2.43,53.58)]}));
  const maps=new MapsV23(env,network);
  await maps.search('Tesco','GB',{lat:53.58,lng:-2.43});await maps.search('Tesco','GB',{lat:51.5,lng:-.12});
  expect(seen).toHaveLength(2);
 });
 it('rejects invalid caller coordinates instead of searching around NaN',async()=>{
  const {seen,network}=recorder(()=>ok({features:[]}));
  await expect(new MapsV23(env,network).search('Labuka','GB',{lat:NaN,lng:-2.43} as any)).rejects.toThrow('INVALID_MAP_POINT');
  expect(seen).toHaveLength(0);
 });
});

// ---------------------------------------------------------------- client pipeline on the server path
const m=vi.hoisted(()=>({
 search:vi.fn(),config:{search:true,routing:true},
 country:{code:'GB',name:'United Kingdom',currency:'GBP',defaultCenter:{lat:51.5,lng:-.12}}
}));
vi.mock('../app/core/services/maps/remote-maps.service',()=>({RemoteMapsService:class RemoteMapsService{}}));
vi.mock('../app/core/services/maps/map-provider.service',()=>({MapProviderService:class MapProviderService{}}));
vi.mock('../app/core/services/config/app-config.service',()=>({AppConfigService:class AppConfigService{}}));
vi.mock('@angular/common/http',()=>({HttpClient:class HttpClient{}}));
vi.mock('@angular/core',()=>({Injectable:()=>()=>{},signal:(v:any)=>{const s:any=()=>v;s.set=(n:any)=>{v=n;};return s;},
 inject:(token:any)=>token?.name==='RemoteMapsService'
  ?{searchAttribution:()=>'',configuration:()=>of(m.config),search:(...args:any[])=>m.search(...args)}
  :{currentCountry:()=>m.country,getMapTilerApiKey:()=>'',getOpenRouteServiceApiKey:()=>'',get:()=>{throw new Error('legacy provider must not be called');}}}));
import {GeocodingService} from '../app/core/services/maps/geocoding.service';

const origin={lat:53.58,lng:-2.43};
const hit=(primaryText:string,lat:number,lng:number,extra:Record<string,unknown>={})=>({primaryText,label:`${primaryText}, Town`,lat,lng,countryCode:'GB',placeType:'poi',...extra});
const serve=(results:unknown[])=>m.search.mockReturnValue(of(results));
const run=(query:string,o:any=origin,options:any={})=>firstValueFrom(new GeocodingService().autocomplete(query,o,options));

describe('client on the server path: location and radius rules',()=>{
 beforeEach(()=>{m.search.mockReset();serve([]);m.config={search:true,routing:true};});
 it('returns a location-required error before any server call for a nearby category search without location',async()=>{
  await expect(run('restaurant near me',null,{strict:true})).rejects.toMatchObject({code:'location_required'});
  expect(await run('restaurant near me',null)).toEqual([]);
  expect(m.search).not.toHaveBeenCalled();
 });
 it('keeps a category search inside the selected 10 km and widens only when 25 km is explicitly chosen',async()=>{
  serve([hit('Near Restaurant',53.585,-2.43,{categories:['restaurant']}),hit('Far Restaurant',53.75,-2.43,{categories:['restaurant']})]);
  expect((await run('restaurant near me')).map(r=>r.primaryText)).toEqual(['Near Restaurant']);
  expect((await run('restaurant near me',origin,{scope:25})).map(r=>r.primaryText)).toEqual(['Near Restaurant','Far Restaurant']);
 });
 it('requires evidence of the category and the cuisine for a category search',async()=>{
  serve([hit('Tesco Express',53.581,-2.43,{categories:['supermarket']}),hit('Mama Africa',53.582,-2.43,{categories:['restaurant','african']}),hit('Pizza Place',53.583,-2.43,{categories:['restaurant','italian']})]);
  expect((await run('African restaurant near me')).map(r=>r.primaryText)).toEqual(['Mama Africa']);
 });
 it('does not clip ordinary street searches to the local radius and sends the origin as a ranking hint',async()=>{
  serve([{label:'High Street, Leeds',primaryText:'High Street',lat:53.8,lng:-1.55,countryCode:'GB',placeType:'street'}]);
  expect(await run('High Street')).toHaveLength(1);
  expect(m.search.mock.calls[0][1]).toEqual(origin);
 });
 it('looks up a postcode without any proximity bias from the current position',async()=>{
  serve([{label:'BL1 1AA, Bolton',primaryText:'BL1 1AA',lat:53.58,lng:-2.43,countryCode:'GB',placeType:'postcode',postalCode:'BL1 1AA'}]);
  expect(await run('bl11aa')).toHaveLength(1);
  expect(m.search.mock.calls[0][0]).toBe('BL1 1AA');
  expect(m.search.mock.calls[0][1]).toBeUndefined();
 });
 it('does not guess a radius for a country-wide category search',async()=>{
  serve([hit('Far Restaurant',51.5,-.12,{categories:['restaurant']})]);
  expect(await run('restaurant near me',origin,{scope:'country'})).toHaveLength(1);
 });
 it('does not silently broaden after a valid empty local answer (one request, no wider retry)',async()=>{
  serve([]);
  expect(await run('restaurant near me',origin,{strict:true})).toEqual([]);
  expect(m.search).toHaveBeenCalledTimes(1);
 });
 it.each([['CA','H3A 1B2',45.5,-73.57],['IE','D02 X285',53.34,-6.26],['NG','100001',6.45,3.4],['NL','1012 AB',52.37,4.89],['US','10001',40.75,-73.99]])('keeps the %s postcode %s outside any business radius and without proximity',async(code,postcode,lat,lng)=>{
  m.country={...m.country,code,name:code};
  serve([{label:`${postcode}, City`,primaryText:postcode,lat,lng,countryCode:code,placeType:'postcode',postalCode:postcode}]);
  try{
   expect(await run(postcode)).toHaveLength(1);
   expect(m.search.mock.calls[0][1]).toBeUndefined();
  }finally{m.country={code:'GB',name:'United Kingdom',currency:'GBP',defaultCenter:{lat:51.5,lng:-.12}};}
 });
 it('never asks for a second provider: "additional listings" makes no server call',async()=>{
  expect(await run('restaurant near me',origin,{additionalListings:true,strict:true})).toEqual([]);
  expect(m.search).not.toHaveBeenCalled();
 });
});

describe('client on the server path: relevance and ranking',()=>{
 beforeEach(()=>{m.search.mockReset();serve([]);m.config={search:true,routing:true};});
 it('does not show unrelated locations returned by a provider',async()=>{
  serve([hit('United',53.58,-2.43),hit('Labuka Restaurant',53.59,-2.44)]);
  expect((await run('Labuka')).map(r=>r.primaryText)).toEqual(['Labuka Restaurant']);
 });
 it('retains a small spelling variation',async()=>{
  serve([hit('Labuca Restaurant',53.581,-2.431)]);
  expect((await run('Labuka Restaurant'))[0].primaryText).toBe('Labuca Restaurant');
 });
 it('places the nearer matching business before a distant branch, with its distance',async()=>{
  serve([hit('Labuka Restaurant',51.5,-.12),hit('Labuka Restaurant',53.581,-2.431)]);
  const r=await run('Labuka');
  expect(r[0].lat).toBe(53.581);expect(r[0].distanceKm).toBeLessThan(1);
 });
 it('does not let proximity override an explicitly typed town',async()=>{
  serve([{...hit('Labuka Restaurant',53.581,-2.431),label:'Labuka Restaurant, Bolton'},{...hit('Labuka Restaurant',51.5,-.12),label:'Labuka Restaurant, London'}]);
  expect((await run('Labuka, London'))[0].label).toContain('London');
 });
 it('drops results with invalid coordinates instead of sorting by NaN',async()=>{
  serve([hit('Labuka',1000,-2.4),hit('Labuka',NaN,-2.4),hit('Labuka',53.58,-2.43)]);
  expect(await run('Labuka')).toHaveLength(1);
 });
 it('never suggests a different explicit house number',async()=>{
  serve([{label:'12 High Street, Bolton',primaryText:'12 High Street',lat:53.58,lng:-2.43,countryCode:'GB',placeType:'address'},{label:'10 High Street, Bolton',primaryText:'10 High Street',lat:53.7,lng:-2.43,countryCode:'GB',placeType:'address'}]);
  expect((await run('10 High Street')).map(r=>r.label)).toEqual(['10 High Street, Bolton']);
 });
 it('merges the same venue returned twice without losing category metadata',async()=>{
  serve([hit('Mama Africa',53.582,-2.43,{categories:['restaurant']}),hit('Mama Africa',53.582,-2.43,{categories:['african']})]);
  const r=await run('Mama Africa');
  expect(r).toHaveLength(1);expect(r[0].categories).toEqual(['restaurant','african']);
 });
});

describe('client on the server path: named landmarks',()=>{
 const bolton={lat:53.58173,lng:-2.40783};
 beforeEach(()=>{m.search.mockReset();serve([]);m.config={search:true,routing:true};});
 it('finds Terminal 2 beyond the local radius and prefers it over the airport parent and other terminals',async()=>{
  serve([hit('Manchester Airport',53.36518,-2.27203),hit('Terminal 1',53.36179,-2.27425),hit('Terminal 2',53.36782,-2.27933)]);
  const r=await run('Manchester Airport Terminal 2',bolton,{strict:true});
  expect(r[0].primaryText).toBe('Terminal 2');expect(r[0].distanceKm).toBeGreaterThan(10);
  expect(r.some(x=>x.primaryText==='Terminal 1')).toBe(false);
 });
 it('does not substitute a different terminal when the requested one is absent',async()=>{
  serve([hit('Terminal 1',53.36,-2.27),hit('Terminal 20',53.36,-2.27)]);
  expect(await run('Manchester Airport Terminal 2',bolton)).toEqual([]);
 });
 it('does not confuse T2 with T20',async()=>{
  serve([hit('Terminal 20',53.36,-2.27),hit('T2',53.36,-2.27)]);
  const r=await run('Heathrow T2',bolton);
  expect(r.map(x=>x.primaryText)).toEqual(['T2']);
 });
 it('rejects Terminal 2 at a distant airport when the named airport is present',async()=>{
  serve([hit('Manchester Airport',53.36518,-2.27203),hit('Terminal 2',51.47,-.45),hit('Terminal 2',53.36782,-2.27933)]);
  const r=await run('Manchester Airport Terminal 2',bolton);
  expect(r[0].lat).toBe(53.36782);expect(r.some(x=>x.lat===51.47)).toBe(false);
 });
 it('still excludes distant terminals when near-me is explicitly requested',async()=>{
  serve([hit('Terminal 2',53.36782,-2.27933)]);
  expect(await run('Manchester Airport Terminal 2 near me',bolton)).toEqual([]);
 });
});

describe('client on the server path: failures',()=>{
 beforeEach(()=>{m.search.mockReset();m.config={search:true,routing:true};});
 it('turns a server failure into a coded, user-safe error distinct from an empty result',async()=>{
  m.search.mockReturnValue(throwError(()=>({status:503,message:'Http failure response for https://api.example.test/api/maps-v23/search: 503'})));
  const error=await run('Labuka',origin,{strict:true}).catch(e=>e);
  expect(error.code).toBe('provider_unavailable');
  expect(error.message).not.toMatch(/http|api\./i);
  m.search.mockReturnValue(of([]));
  expect(await run('Labuka',origin,{strict:true})).toEqual([]);
 });
 it('maps rate limiting and bad input to their own messages',async()=>{
  m.search.mockReturnValue(throwError(()=>({status:429})));
  expect((await run('Labuka').catch(e=>e)).code).toBe('rate_limited');
  m.search.mockReturnValue(throwError(()=>({status:400})));
  expect((await run('Labuka').catch(e=>e)).code).toBe('invalid_query');
 });
 it('reports search as unavailable (not "no results") when the server has search switched off',async()=>{
  m.config={search:false,routing:false};
  expect((await run('Labuka').catch(e=>e)).code).toBe('provider_unavailable');
  expect(m.search).not.toHaveBeenCalled();
 });
});
