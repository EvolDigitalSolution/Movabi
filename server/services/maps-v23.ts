export interface MapPoint {lat:number;lng:number;}
export function mapPoint(value:any):MapPoint {
 if(!value||typeof value.lat!=='number'||typeof value.lng!=='number'||!Number.isFinite(value.lat)||!Number.isFinite(value.lng)||Math.abs(value.lat)>90||Math.abs(value.lng)>180)throw Error('INVALID_MAP_POINT');
 return {lat:value.lat,lng:value.lng};
}
const country=(v:any)=>{if(typeof v!=='string'||!/^[A-Z]{2}$/.test(v))throw Error('INVALID_MAP_COUNTRY');return v;};
export function searchCountries(value:string):string[]{
 if(typeof value!=='string')throw Error('INVALID_MAP_COUNTRY');
 const codes=value.split(',');if(!codes.length||codes.length>250)throw Error('INVALID_MAP_COUNTRY');
 codes.forEach(country);return [...new Set(codes)].sort();
}
const positive=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
/** Fixed vendor URLs, redacted errors, bounded requests and short-lived route deduplication. */
export class MapsV23 {
 private lookups=new Map<string,{until:number;promise:Promise<any>}>();
 private cooldown=new Map<string,number>();
 private matrices=new Map<string,{until:number;promise:Promise<any>}>();
 private routes=new Map<string,{until:number;promise:Promise<any>}>();
 constructor(private env:Record<string,string|undefined>=process.env,private network:typeof fetch=fetch){}
 configuration(){return {search:this.env.VAYDU_MAPBOX_GEOCODING_V23==='true'&&!!(this.env.MAPBOX_GEOCODING_TOKEN||this.env.TOMTOM_API_KEY),
 routing:this.env.VAYDU_TOMTOM_ROUTING_V23==='true'&&!!(this.env.TOMTOM_API_KEY||this.env.MAPBOX_GEOCODING_TOKEN)};}
 private async json(url:URL,body?:any){
  const product=url.hostname+':'+(url.pathname.startsWith('/search')?'search':'routing');
  if((this.cooldown.get(product)||0)>Date.now())throw Error('MAP_PROVIDER_UNAVAILABLE');
  try{const r=await this.network(url,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
   if(!r.ok){this.cooldown.set(product,Date.now()+([401,403].includes(r.status)?300000:60000));throw Error('UPSTREAM');}const text=await r.text();if(text.length>4_000_000)throw Error('UPSTREAM');return JSON.parse(text);
  }catch{if(!this.cooldown.has(product)||this.cooldown.get(product)!<Date.now())this.cooldown.set(product,Date.now()+60000);throw Error('MAP_PROVIDER_UNAVAILABLE');}
 }
 private mapbox(endpoint:string){if(!this.configuration().search||!this.env.MAPBOX_GEOCODING_TOKEN)throw Error('MAP_SEARCH_DISABLED');const u=new URL('https://api.mapbox.com/search/geocode/v6/'+endpoint);u.searchParams.set('access_token',this.env.MAPBOX_GEOCODING_TOKEN!);u.searchParams.set('permanent','false');return u;}
 private async memo(key:string,run:()=>Promise<any>){
  const hit=this.lookups.get(key);if(hit&&hit.until>Date.now())return hit.promise;
  const promise=run();if(this.lookups.size>=200)this.lookups.delete(this.lookups.keys().next().value!);
  this.lookups.set(key,{until:Date.now()+60000,promise});try{return await promise;}catch(e){this.lookups.delete(key);throw e;}
 }
 async search(query:string,code:string,origin?:MapPoint){
  const allowed=searchCountries(code);code=allowed.join(',');if(typeof query!=='string'||query.trim().length<3||query.length>256||query.includes(';')||query.trim().split(/\s+/).length>20)throw Error('INVALID_MAP_QUERY');
  if(origin)origin=mapPoint(origin);if(!this.configuration().search)throw Error('MAP_SEARCH_DISABLED');
  return this.memo(JSON.stringify(['search',code,query.trim().toLowerCase(),origin?[Number(origin.lat.toFixed(3)),Number(origin.lng.toFixed(3))]:null]),async()=>{
   try{const result=await this.mapboxSearch(query,code,origin);if(result.results.length||!this.env.TOMTOM_API_KEY)return result;}catch{if(!this.env.TOMTOM_API_KEY)throw Error('MAP_PROVIDER_UNAVAILABLE');}
   return this.tomtomSearch(query,code,origin);
  });
 }
 private async mapboxSearch(query:string,code:string,origin?:MapPoint){
  const allowed=searchCountries(code);code=allowed.join(',');if(typeof query!=='string'||query.trim().length<3||query.length>256||query.includes(';')||query.trim().split(/\s+/).length>20)throw Error('INVALID_MAP_QUERY');
  const u=this.mapbox('forward');u.searchParams.set('q',query.trim());u.searchParams.set('country',code.toLowerCase());u.searchParams.set('limit','8');u.searchParams.set('autocomplete','true');u.searchParams.set('types','address,street,postcode,place,locality,neighborhood');
  if(origin){const p=mapPoint(origin);u.searchParams.set('proximity',`${p.lng},${p.lat}`);}
  const data=await this.json(u);if(!Array.isArray(data.features))throw Error('MAP_PROVIDER_RESPONSE_INVALID');
  const results=data.features.flatMap((f:any)=>{const p=f.properties||{},c=String(p.context?.country?.country_code||'').toUpperCase();if(!allowed.includes(c))return [];
   const coords=f.geometry?.coordinates;if(!Array.isArray(coords))return [];let point:MapPoint;try{point=mapPoint({lng:coords[0],lat:coords[1]});}catch{return [];}
   const label=p.full_address||[p.name,p.place_formatted].filter(Boolean).join(', ');if(typeof label!=='string'||!label.trim())return [];
   return [{...point,label:label.slice(0,600),primaryText:String(p.name||label).slice(0,300),secondaryText:String(p.place_formatted||'').slice(0,300),countryCode:c,placeType:p.feature_type||'address',postalCode:p.context?.postcode?.name}];});
  return {results,attribution:typeof data.attribution==='string'?data.attribution:'© Mapbox'};
 }
 async reverse(point:MapPoint){
  const p=mapPoint(point);if(!this.configuration().search)throw Error('MAP_SEARCH_DISABLED');
  return this.memo(JSON.stringify(['reverse',p]),async()=>{
   try{return await this.mapboxReverse(p);}catch{if(!this.env.TOMTOM_API_KEY)throw Error('MAP_PROVIDER_UNAVAILABLE');}
   const u=new URL(`https://api.tomtom.com/search/2/reverseGeocode/${p.lat},${p.lng}.json`);u.searchParams.set('key',this.env.TOMTOM_API_KEY!);
   const data=await this.json(u),address=data.addresses?.[0]?.address;const code=String(address?.countryCode||'').toUpperCase();country(code);
   if(!address?.freeformAddress)throw Error('MAP_COUNTRY_UNRESOLVED');return {label:String(address.freeformAddress).slice(0,600),countryCode:code};
  });
 }
 private async tomtomSearch(query:string,code:string,origin?:MapPoint){
  const u=new URL(`https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json`);
  u.searchParams.set('key',this.env.TOMTOM_API_KEY!);u.searchParams.set('countrySet',code);u.searchParams.set('typeahead','true');u.searchParams.set('limit','8');
  if(origin){u.searchParams.set('lat',String(origin.lat));u.searchParams.set('lon',String(origin.lng));}
  const data=await this.json(u);if(!Array.isArray(data.results))throw Error('MAP_PROVIDER_RESPONSE_INVALID');
  const results=data.results.flatMap((r:any)=>{const actualCountry=String(r.address?.countryCode||'').toUpperCase();if(!searchCountries(code).includes(actualCountry))return [];let p:MapPoint;try{p=mapPoint({lat:r.position?.lat,lng:r.position?.lon});}catch{return [];}
   const label=[r.poi?.name,r.address?.freeformAddress].filter(Boolean).join(', ');if(!label)return [];
   return [{...p,label:label.slice(0,600),primaryText:String(r.poi?.name||r.address.freeformAddress).slice(0,300),secondaryText:String(r.address.freeformAddress).slice(0,300),countryCode:actualCountry,placeType:r.type==='POI'?'poi':'address'}];});
  return {results,attribution:'© TomTom'};
 }
 private async mapboxReverse(point:MapPoint){
  const p=mapPoint(point),u=this.mapbox('reverse');u.searchParams.set('longitude',String(p.lng));u.searchParams.set('latitude',String(p.lat));u.searchParams.set('limit','1');
  const data=await this.json(u),f=data.features?.[0],props=f?.properties;
  const code=String(props?.context?.country?.country_code|| (props?.feature_type==='country'?props?.country_code:'')||'').toUpperCase();country(code);
  const label=props?.full_address||[props?.name,props?.place_formatted].filter(Boolean).join(', ');
  if(!label)throw Error('MAP_COUNTRY_UNRESOLVED');return {label:String(label).slice(0,600),countryCode:code};
 }
 async route(start:MapPoint,end:MapPoint){
  start=mapPoint(start);end=mapPoint(end);if(!this.configuration().routing)throw Error('MAP_ROUTING_DISABLED');
  const key=JSON.stringify([start,end]);const existing=this.routes.get(key);if(existing&&existing.until>Date.now())return existing.promise;
  const promise=this.routeWithFallback(start,end);if(this.routes.size>=200)this.routes.delete(this.routes.keys().next().value!);
  this.routes.set(key,{until:Date.now()+30000,promise});try{return await promise;}catch(e){this.routes.delete(key);throw e;}
 }
 private async routeWithFallback(start:MapPoint,end:MapPoint){
  try{if(!this.env.TOMTOM_API_KEY)throw Error('MAP_ROUTING_DISABLED');return await this.calculateRoute(start,end);}catch{if(!this.env.MAPBOX_GEOCODING_TOKEN)throw Error('MAP_PROVIDER_UNAVAILABLE');}
  const u=new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${start.lng},${start.lat};${end.lng},${end.lat}`);
  u.searchParams.set('access_token',this.env.MAPBOX_GEOCODING_TOKEN!);u.searchParams.set('geometries','geojson');u.searchParams.set('overview','full');u.searchParams.set('steps','true');
  const data=await this.json(u),r=data.routes?.[0];if(!positive(r?.distance)||!positive(r?.duration)||!Array.isArray(r?.geometry?.coordinates)||r.geometry.coordinates.length<2)throw Error('MAP_PROVIDER_RESPONSE_INVALID');
  const coordinates=r.geometry.coordinates.map((p:any)=>{const v=mapPoint({lng:p[0],lat:p[1]});return [v.lng,v.lat];});
  if(coordinates.length>100000)throw Error('MAP_PROVIDER_RESPONSE_INVALID');
  const steps:any[]=[];let previous=0;
  for(const leg of r.legs||[])for(const step of leg.steps||[]){
   const location=step.maneuver?.location;if(!Array.isArray(location))continue;
   let best=Infinity,index=previous;for(let i=previous;i<coordinates.length;i++){const d=(coordinates[i][0]-location[0])**2+(coordinates[i][1]-location[1])**2;if(d<best){best=d;index=i;}}
   if(steps.length)steps[steps.length-1].endIndex=index;
   steps.push({instruction:String(step.maneuver?.instruction||'Follow the route').slice(0,500),distanceMeters:positive(step.distance)?step.distance:0,durationSeconds:positive(step.duration)?step.duration:0,startIndex:index,endIndex:coordinates.length-1});previous=index;
  }
  if(!steps.length)steps.push({instruction:'Follow the route',distanceMeters:r.distance,durationSeconds:r.duration,startIndex:0,endIndex:coordinates.length-1});
  const xs=coordinates.map((p:any)=>p[0]),ys=coordinates.map((p:any)=>p[1]);
  return {coordinates,steps,distanceMeters:r.distance,durationSeconds:r.duration,geometry:{type:'LineString',coordinates},bounds:[[xs.reduce((a:number,b:number)=>Math.min(a,b)),ys.reduce((a:number,b:number)=>Math.min(a,b))],[xs.reduce((a:number,b:number)=>Math.max(a,b)),ys.reduce((a:number,b:number)=>Math.max(a,b))]],provider:'mapbox'};
 }
 private async calculateRoute(start:MapPoint,end:MapPoint){
  const u=new URL(`https://api.tomtom.com/routing/1/calculateRoute/${start.lat},${start.lng}:${end.lat},${end.lng}/json`);
  for(const [k,v] of Object.entries({key:this.env.TOMTOM_API_KEY!,traffic:'true',departAt:'now',travelMode:'car',routeType:'fastest',instructionsType:'text',language:'en-GB',routeRepresentation:'polyline'}))u.searchParams.set(k,v);
  const data=await this.json(u),r=data.routes?.[0];if(!positive(r?.summary?.lengthInMeters)||!positive(r?.summary?.travelTimeInSeconds)||!Array.isArray(r?.legs))throw Error('MAP_PROVIDER_RESPONSE_INVALID');
  const coordinates:number[][]=[];for(const leg of r.legs)for(const p of leg.points||[]){const v=mapPoint({lat:p.latitude,lng:p.longitude});coordinates.push([v.lng,v.lat]);}
  if(coordinates.length<2||coordinates.length>100000)throw Error('MAP_PROVIDER_RESPONSE_INVALID');
  const instructions=r.guidance?.instructions||[];
  const steps=instructions.flatMap((i:any,index:number)=>{if(!Number.isInteger(i.pointIndex)||i.pointIndex<0||i.pointIndex>=coordinates.length)return [];
   const next=instructions[index+1],endIndex=Number.isInteger(next?.pointIndex)?Math.min(coordinates.length-1,Math.max(i.pointIndex,next.pointIndex)):coordinates.length-1;
   return [{instruction:String(i.message||'Continue along the route').slice(0,500),startIndex:i.pointIndex,endIndex,distanceMeters:Math.max(0,(next?.routeOffsetInMeters??r.summary.lengthInMeters)-(i.routeOffsetInMeters||0)),durationSeconds:Math.max(0,(next?.travelTimeInSeconds??r.summary.travelTimeInSeconds)-(i.travelTimeInSeconds||0))}];});
  if(!steps.length)steps.push({instruction:'Follow the route',startIndex:0,endIndex:coordinates.length-1,distanceMeters:r.summary.lengthInMeters,durationSeconds:r.summary.travelTimeInSeconds});
  const lngs=coordinates.map(p=>p[0]),lats=coordinates.map(p=>p[1]);
  const freeFlowSeconds=positive(r.summary.noTrafficTravelTimeInSeconds)?r.summary.noTrafficTravelTimeInSeconds:null;
  const liveSeconds=r.summary.travelTimeInSeconds;
  const congestion=freeFlowSeconds&&freeFlowSeconds>0?Math.round((liveSeconds/freeFlowSeconds)*100)/100:null;
  return {coordinates,steps,distanceMeters:r.summary.lengthInMeters,durationSeconds:liveSeconds,freeFlowSeconds,congestionRatio:congestion,geometry:{type:'LineString',coordinates},bounds:[[lngs.reduce((a,b)=>Math.min(a,b)),lats.reduce((a,b)=>Math.min(a,b))],[lngs.reduce((a,b)=>Math.max(a,b)),lats.reduce((a,b)=>Math.max(a,b))]],provider:'tomtom'};
 }
 async matrix(origins:MapPoint[],destination:MapPoint){
  if(this.env.VAYDU_TOMTOM_MATRIX_V23!=='true'||!this.env.TOMTOM_API_KEY)throw Error('MAP_MATRIX_DISABLED');
  if(!Array.isArray(origins)||!origins.length||origins.length>20)throw Error('INVALID_MAP_MATRIX');
  origins=origins.map(mapPoint);destination=mapPoint(destination);
  const round=(p:MapPoint)=>[Number(p.lat.toFixed(3)),Number(p.lng.toFixed(3))];const key=JSON.stringify([origins.map(round),round(destination)]);const hit=this.matrices.get(key);if(hit&&hit.until>Date.now())return hit.promise;
  const promise=this.calculateMatrix(origins,destination);if(this.matrices.size>=100)this.matrices.delete(this.matrices.keys().next().value!);
  this.matrices.set(key,{until:Date.now()+30000,promise});try{return await promise;}catch(e){this.matrices.delete(key);throw e;}
 }
 private async calculateMatrix(origins:MapPoint[],destination:MapPoint){
  if(this.env.VAYDU_TOMTOM_MATRIX_V23!=='true'||!this.env.TOMTOM_API_KEY)throw Error('MAP_MATRIX_DISABLED');
  if(!Array.isArray(origins)||!origins.length||origins.length>20)throw Error('INVALID_MAP_MATRIX');
  const point=(p:MapPoint)=>{const v=mapPoint(p);return {point:{latitude:v.lat,longitude:v.lng}};};
  const u=new URL('https://api.tomtom.com/routing/matrix/2');u.searchParams.set('key',this.env.TOMTOM_API_KEY);
  const data=await this.json(u,{origins:origins.map(point),destinations:[point(destination)],options:{departAt:'now',traffic:'live',travelMode:'car',routeType:'fastest'}});
  if(!Array.isArray(data.data))throw Error('MAP_PROVIDER_RESPONSE_INVALID');
  const seen=new Set<number>();return data.data.map((cell:any)=>{if(!Number.isInteger(cell.originIndex)||cell.originIndex<0||cell.originIndex>=origins.length||cell.destinationIndex!==0||seen.has(cell.originIndex))throw Error('MAP_PROVIDER_RESPONSE_INVALID');seen.add(cell.originIndex);
   return {index:cell.originIndex,seconds:!cell.detailedError&&positive(cell.routeSummary?.travelTimeInSeconds)?cell.routeSummary.travelTimeInSeconds:null};});
 }
}
export const mapsV23=new MapsV23();
