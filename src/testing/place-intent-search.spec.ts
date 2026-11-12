/**
 * Intent-aware landmark, business and category search (D11 follow-up, 2026-11-12).
 *
 * The develop host check showed provider HTTP 200 answers that did not fulfil the search:
 * "Manchester Airport Terminal 2" -> roads/neighbourhoods, "Tesco Extra" -> a street,
 * "restaurant" -> "Restaurant Terrace". These tests pin that such answers are rejected
 * (fulfilled:false), that genuine POIs are found through the provider capability that has them
 * (TomTom poiSearch/categorySearch), and that exact terminal identity, real business/category
 * types, location boundaries, market isolation and Mapbox permanent=false all hold.
 * Provider responses are fakes; real-request evidence comes from scripts/verify-server-place-search.cjs.
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {firstValueFrom,of} from 'rxjs';
import {MapsV23} from '../../server/services/maps-v23';
import {classifyIntent,suitableResults} from '../../server/services/place-search-intent';

const MAPBOX='test-mapbox-secret-token',TOMTOM='test-tomtom-secret-key';
const env={VAYDU_MAPBOX_GEOCODING_V23:'true',MAPBOX_GEOCODING_TOKEN:MAPBOX,TOMTOM_API_KEY:TOMTOM};
const ok=(data:unknown)=>({ok:true,status:200,text:async()=>JSON.stringify(data)}) as any;
const fail=(status:number)=>({ok:false,status,text:async()=>'{}'}) as any;
const bolton={lat:53.5817,lng:-2.4078};
// Mapbox v6 features
const mb=(name:string,type:string,lng:number,lat:number,country='gb')=>({geometry:{coordinates:[lng,lat]},properties:{name,full_address:`${name}, ${type==='place'?'England':'Manchester'}`,place_formatted:'Manchester',feature_type:type,context:{country:{country_code:country}}}});
// TomTom results: POIs and non-POI geography/streets
const poi=(name:string,lat:number,lon:number,opts:{country?:string;categories?:string[];classes?:Array<[string,string[]]>;address?:string}={})=>({type:'POI',poi:{name,...(opts.categories?{categories:opts.categories}:{}),...(opts.classes?{classifications:opts.classes.map(([code,names])=>({code,names:names.map(n=>({nameLocale:'en-GB',name:n}))}))}:{})},address:{freeformAddress:opts.address||'Ringway, Manchester',countryCode:opts.country||'GB'},position:{lat,lon}});
const street=(name:string,lat:number,lon:number,type='Street')=>({type,address:{freeformAddress:`${name}, Manchester`,streetName:name,countryCode:'GB'},position:{lat,lon}});
type Seen={url:URL};
const providers=(handlers:{mapbox?:(u:URL)=>any;tomtom?:(u:URL)=>any})=>{
 const seen:Seen[]=[];
 const network=(async(url:any)=>{const u=new URL(String(url));seen.push({url:u});
  if(u.hostname==='api.mapbox.com'){if(!handlers.mapbox)throw new Error('Mapbox must not be called');return handlers.mapbox(u);}
  if(u.hostname==='api.tomtom.com'){if(!handlers.tomtom)throw new Error('TomTom must not be called');return handlers.tomtom(u);}
  throw new Error('unexpected host '+u.hostname);}) as typeof fetch;
 return {seen,network,maps:new MapsV23(env,network),mapbox:()=>seen.filter(s=>s.url.hostname==='api.mapbox.com'),tomtom:()=>seen.filter(s=>s.url.hostname==='api.tomtom.com')};
};
const names=(r:any)=>r.results.map((x:any)=>x.primaryText);

describe('landmarks: exact terminal identity through POI data',()=>{
 it('host case: roads and neighbourhoods for "Manchester Airport Terminal 2" are not a match (fulfilled:false)',async()=>{
  const p=providers({tomtom:()=>ok({results:[street('Terminal Road North',53.36,-2.27),street('Ringway',53.36,-2.28,'Geography'),poi('Terminal 1',53.3618,-2.2743),poi('Terminal 20 Car Park',53.36,-2.27)]})});
  const r=await p.maps.search('Manchester Airport Terminal 2','GB',bolton,{intent:'landmark'});
  expect(r).toMatchObject({fulfilled:false,intent:'landmark'});
  expect(r.results).toEqual([]);
 });
 it('uses TomTom poiSearch (not Mapbox, which has no POI layer) and returns the exact terminal, never another terminal',async()=>{
  const p=providers({tomtom:()=>ok({results:[poi('Manchester Airport',53.36518,-2.27203),poi('Terminal 1',53.36179,-2.27425),poi('Terminal 2',53.36782,-2.27933),street('Terminal Road',53.36,-2.27)]})});
  const r=await p.maps.search('Manchester Airport Terminal 2','GB',bolton,{intent:'landmark'});
  expect(p.mapbox()).toHaveLength(0);
  expect(p.tomtom()[0].url.pathname).toMatch(/^\/search\/2\/poiSearch\//);
  expect(r.fulfilled).toBe(true);
  expect(names(r)).toContain('Terminal 2');
  expect(names(r)).not.toContain('Terminal 1');
  expect(names(r)).not.toContain('Terminal Road');
 });
 it('does not confuse T2 with T20',async()=>{
  const p=providers({tomtom:()=>ok({results:[poi('Heathrow Terminal 20',51.47,-.45,{address:'Hounslow, London'}),poi('Heathrow Terminal 2',51.4713,-.4524,{address:'Hounslow, London'})]})});
  const r=await p.maps.search('Heathrow T2','GB',undefined,{intent:'landmark'});
  expect(names(r)).toEqual(['Heathrow Terminal 2']);
 });
 it('rejects a Terminal 2 at a different airport',async()=>{
  const p=providers({tomtom:()=>ok({results:[poi('Manchester Airport',53.36518,-2.27203),poi('Terminal 2',51.4713,-.4524,{address:'Hounslow, London'})]})});
  const r=await p.maps.search('Manchester Airport Terminal 2','GB',bolton,{intent:'landmark'});
  expect(r.fulfilled).toBe(false);expect(r.results).toEqual([]);
 });
 it('does not substitute a different terminal when the requested one is absent',async()=>{
  const p=providers({tomtom:()=>ok({results:[poi('Manchester Airport Terminal 1',53.36,-2.27),poi('Manchester Airport Terminal 3',53.36,-2.27)]})});
  const r=await p.maps.search('Manchester Airport Terminal 2','GB',bolton,{intent:'landmark'});
  expect(r).toMatchObject({fulfilled:false,results:[]});
 });
 it('a near-me landmark search stays inside the radius at the provider and in the answer',async()=>{
  const p=providers({tomtom:()=>ok({results:[poi('Manchester Airport Terminal 2',53.36782,-2.27933)]})});
  const r=await p.maps.search('Manchester Airport Terminal 2','GB',bolton,{intent:'landmark',radiusKm:10});
  expect(p.tomtom()[0].url.searchParams.get('radius')).toBe('10000');
  expect(r).toMatchObject({fulfilled:false,results:[]});
 });
});

describe('businesses: genuine POIs whose name carries every distinctive word',()=>{
 it('host case: a street for "Tesco Extra" does not fulfil the search; TomTom poiSearch finds the store',async()=>{
  const p=providers({
   mapbox:()=>ok({features:[mb('Extra Street','street',-2.43,53.58)]}),
   tomtom:()=>ok({results:[poi('Tesco Express',53.582,-2.43,{categories:['supermarket']}),poi('Tesco Extra',53.578,-2.44,{categories:['supermarket'],address:'Trinity Street, Bolton'})]})
  });
  const r=await p.maps.search('Tesco Extra','GB',bolton,{intent:'place'});
  expect(p.tomtom()[0].url.pathname).toMatch(/^\/search\/2\/poiSearch\//);
  expect(r.fulfilled).toBe(true);
  expect(names(r)).toEqual(['Tesco Extra']);
  expect(r.results.every((x:any)=>x.placeType==='poi')).toBe(true);
 });
 it('a town is a valid place answer from Mapbox, and then TomTom is not called',async()=>{
  const p=providers({mapbox:()=>ok({features:[mb('Bolton','place',-2.43,53.58)]})});
  const r=await p.maps.search('Bolton','GB',undefined,{intent:'place'});
  expect(r).toMatchObject({fulfilled:true});expect(names(r)).toEqual(['Bolton']);
  expect(p.tomtom()).toHaveLength(0);
 });
 it('only streets and partial-name POIs leave a business search unfulfilled',async()=>{
  const p=providers({mapbox:()=>ok({features:[mb('Tesco Road','street',-2.43,53.58)]}),tomtom:()=>ok({results:[poi('Tesco Express',53.58,-2.43),street('Tesco Road',53.58,-2.43)]})});
  const r=await p.maps.search('Tesco Extra','GB',bolton,{intent:'place'});
  expect(r).toMatchObject({fulfilled:false,results:[]});
 });
 it('keeps a one-letter spelling variation of a business name',async()=>{
  const p=providers({mapbox:()=>ok({features:[]}),tomtom:()=>ok({results:[poi('Labuca Restaurant',53.581,-2.431)]})});
  expect(names(await p.maps.search('Labuka Restaurant','GB',bolton,{intent:'place'}))).toEqual(['Labuca Restaurant']);
 });
});

describe('categories: provider category data, never a street label',()=>{
 it('host case: "Restaurant Terrace" is not a restaurant (fulfilled:false)',async()=>{
  const p=providers({tomtom:()=>ok({results:[street('Restaurant Terrace',53.58,-2.42),poi('Restaurant Terrace Car Park',53.58,-2.42,{categories:['parking garage']})]})});
  const r=await p.maps.search('restaurant','GB',bolton,{intent:'category',radiusKm:10});
  expect(r).toMatchObject({fulfilled:false,results:[]});
 });
 it('uses TomTom categorySearch with the location and radius, and keeps only real restaurants inside it',async()=>{
  const p=providers({tomtom:()=>ok({results:[poi('Nandos',53.579,-2.43,{categories:['restaurant']}),poi('Far Diner',53.75,-2.43,{categories:['restaurant']}),poi('Vue Cinema',53.58,-2.43,{categories:['cinema']})]})});
  const r=await p.maps.search('restaurant','GB',bolton,{intent:'category',radiusKm:10});
  const u=p.tomtom()[0].url;
  expect(u.pathname).toBe('/search/2/categorySearch/restaurant.json');
  expect(u.searchParams.get('radius')).toBe('10000');
  expect(u.searchParams.get('lat')).toBe('53.5817');
  expect(p.mapbox()).toHaveLength(0);
  expect(names(r)).toEqual(['Nandos']);
 });
 it('requires the requested cuisine in the provider classification',async()=>{
  const p=providers({tomtom:()=>ok({results:[poi('Mama Africa',53.582,-2.43,{categories:['restaurant'],classes:[['RESTAURANT',['african']]]}),poi('Pizza Place',53.583,-2.43,{categories:['restaurant'],classes:[['RESTAURANT',['italian']]]})]})});
  expect(names(await p.maps.search('African restaurant','GB',bolton,{intent:'category',radiusKm:10}))).toEqual(['Mama Africa']);
 });
});

describe('location boundaries and market isolation',()=>{
 it('a radius needs a location and stays within 1–50 km; invalid input makes no provider call',async()=>{
  const p=providers({});
  await expect(p.maps.search('restaurant','GB',undefined,{intent:'category',radiusKm:10})).rejects.toThrow('INVALID_MAP_QUERY');
  await expect(p.maps.search('restaurant','GB',bolton,{intent:'category',radiusKm:500})).rejects.toThrow('INVALID_MAP_QUERY');
  await expect(p.maps.search('restaurant','GB',bolton,{intent:'everything'})).rejects.toThrow('INVALID_MAP_QUERY');
  expect(p.seen).toHaveLength(0);
 });
 it('never returns a POI outside the requested markets, for every intent',async()=>{
  const p=providers({mapbox:()=>ok({features:[]}),tomtom:()=>ok({results:[
   poi('Tesco Extra',6.45,3.4,{country:'NG',categories:['supermarket','restaurant']}),
   poi('Manchester Airport Terminal 2',6.45,3.4,{country:'NG'}),
   poi('Tesco Extra',53.578,-2.44,{categories:['supermarket']})]})});
  for(const [query,intent] of [['Tesco Extra','place'],['Manchester Airport Terminal 2','landmark'],['restaurant','category']] as const){
   const r=await p.maps.search(query,'GB',bolton,{intent});
   expect(r.results.every((x:any)=>x.countryCode==='GB')).toBe(true);
   expect(p.tomtom().at(-1)!.url.searchParams.get('countrySet')).toBe('GB');
  }
 });
});

describe('failures stay distinct from "no suitable match"',()=>{
 it('a TomTom failure on a landmark/category search is a provider error, and Mapbox is not asked (it cannot answer)',async()=>{
  const p=providers({tomtom:()=>fail(500)});
  await expect(p.maps.search('restaurant','GB',bolton,{intent:'category',radiusKm:10})).rejects.toThrow('MAP_PROVIDER_UNAVAILABLE');
  expect(p.mapbox()).toHaveLength(0);
 });
 it('without a TomTom key, landmark/category search reports the provider as unavailable rather than showing streets',async()=>{
  const network=(async()=>{throw new Error('no request expected');}) as typeof fetch;
  await expect(new MapsV23({...env,TOMTOM_API_KEY:undefined},network).search('Manchester Airport Terminal 2','GB',bolton,{intent:'landmark'})).rejects.toThrow('MAP_PROVIDER_UNAVAILABLE');
 });
 it('callers that send no intent keep the original address behaviour exactly',async()=>{
  const p=providers({mapbox:()=>ok({features:[mb('High Street','street',-2.43,53.58)]})});
  const r:any=await p.maps.search('High Street','GB');
  expect(r.fulfilled).toBeUndefined();expect(names(r)).toEqual(['High Street']);
 });
});

describe('Mapbox permanent geocoding stays off on every search path (billing)',()=>{
 it('every Mapbox request across address, postcode, place, landmark and category paths sends permanent=false, never true',async()=>{
  const p=providers({mapbox:()=>ok({features:[mb('Some Street','street',-2.43,53.58)]}),tomtom:()=>ok({results:[]})});
  for(const [q,intent] of [['10 High Street','address'],['BL1 1AA','postcode'],['Tesco Extra','place'],['Bolton','place'],['Manchester Airport Terminal 2','landmark'],['restaurant','category'],['Old client','']] as const)
   await p.maps.search(q,'GB',bolton,intent?{intent}:{}).catch(()=>null);
  await p.maps.reverse(bolton).catch(()=>null);
  expect(p.mapbox().length).toBeGreaterThan(0);
  for(const s of p.mapbox()){expect(s.url.searchParams.getAll('permanent')).toEqual(['false']);expect(s.url.search).not.toMatch(/permanent=true/i);}
 });
 it('no source file can switch permanent geocoding on',()=>{
  const files:string[]=[];
  const walk=(dir:string)=>{for(const name of readdirSync(dir)){if(name==='node_modules'||name.startsWith('.'))continue;const path=join(dir,name);if(statSync(path).isDirectory())walk(path);else if(/\.(ts|js|cjs|mjs)$/.test(name))files.push(path);}};
  walk(resolve('server'));walk(resolve('src/app'));
  const offenders=files.filter(f=>{const text=readFileSync(f,'utf8');return /permanent['"]?\s*[,:=]\s*['"]?true|permanent=true/i.test(text);});
  expect(offenders).toEqual([]);
  const adapter=readFileSync(resolve('server/services/maps-v23.ts'),'utf8');
  expect(adapter.match(/searchParams\.set\('permanent','false'\)/g)).toHaveLength(1);
  expect(adapter.match(/geocode\/v6\//g)).toHaveLength(1);
 });
 it('the host check rejects permanent=true and never prints credentials',()=>{
  const script=readFileSync(resolve('scripts/verify-server-place-search.cjs'),'utf8');
  expect(script).toContain("check(!requests.some(e=>/permanent=true/i.test(e.url)),'no request asked for permanent geocoding');");
  expect(script).toContain("x.searchParams.set(k,'REDACTED')");
 });
});

describe('intent classification',()=>{
 it.each([
  ['Manchester Airport Terminal 2',false,'landmark'],['Heathrow T5',false,'landmark'],['Tesco Extra',false,'place'],['Bolton',false,'place'],
  ['restaurant',false,'category'],['African restaurant',false,'category'],['10 High Street',false,'address'],['High Street',false,'address'],['BL1 1AA',true,'postcode']
 ])('%s -> %s',(query,postcode,intent)=>{expect(classifyIntent(query,postcode)).toBe(intent);});
 it('suitability never passes a street for a place, landmark or category query',()=>{
  const road={lat:53.58,lng:-2.43,label:'Restaurant Terrace, Bolton',primaryText:'Restaurant Terrace',countryCode:'GB',placeType:'street'};
  for(const [query,intent] of [['Restaurant Terrace','place'],['Manchester Airport Terminal 2','landmark'],['restaurant','category']] as const)
   expect(suitableResults([road],{query,intent}).fulfilled).toBe(false);
 });
});

// ---------------------------------------------------------------- client sends intent and radius
const m=vi.hoisted(()=>({search:vi.fn(),country:{code:'GB',name:'United Kingdom',currency:'GBP',defaultCenter:{lat:51.5,lng:-.12}}}));
vi.mock('../app/core/services/maps/remote-maps.service',()=>({RemoteMapsService:class RemoteMapsService{}}));
vi.mock('../app/core/services/maps/map-provider.service',()=>({MapProviderService:class MapProviderService{}}));
vi.mock('../app/core/services/config/app-config.service',()=>({AppConfigService:class AppConfigService{}}));
vi.mock('@angular/common/http',()=>({HttpClient:class HttpClient{}}));
vi.mock('@angular/core',()=>({Injectable:()=>()=>{},signal:(v:any)=>{const s:any=()=>v;s.set=(n:any)=>{v=n;};return s;},
 inject:(token:any)=>token?.name==='RemoteMapsService'
  ?{searchAttribution:()=>'',configuration:()=>of({search:true,routing:true}),search:(...args:any[])=>m.search(...args)}
  :{currentCountry:()=>m.country,getMapTilerApiKey:()=>'',getOpenRouteServiceApiKey:()=>'',get:()=>{throw new Error('legacy provider must not be called');}}}));
import {GeocodingService} from '../app/core/services/maps/geocoding.service';

describe('client sends the search intent and radius',()=>{
 beforeEach(()=>{m.search.mockReset().mockReturnValue(of([]));});
 it.each([
  ['Manchester Airport Terminal 2','landmark',null],
  ['Manchester Airport Terminal 2 near me','landmark',10],
  ['Tesco Extra','place',null],
  ['Tesco near me','place',10],
  ['restaurant near me','category',10],
  ['10 High Street','address',null],
 ])('%s -> %s (radius %s)',async(query,intent,radius)=>{
  await firstValueFrom(new GeocodingService().autocomplete(query,bolton));
  expect(m.search).toHaveBeenCalledTimes(1);
  expect(m.search.mock.calls[0][2]).toBe(intent);
  expect(m.search.mock.calls[0][3]??null).toBe(radius);
 });
 it('a postcode is sent as a postcode, with no location',async()=>{
  await firstValueFrom(new GeocodingService().autocomplete('BL1 1AA',bolton));
  expect(m.search.mock.calls[0].slice(1,3)).toEqual([undefined,'postcode']);
 });
});
