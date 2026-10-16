export type PlaceSearchScope=10|25|'country';
export interface SearchPoint{lat:number;lng:number;}
export interface LocalSearchOptions{scope?:PlaceSearchScope;strict?:boolean;additionalListings?:boolean;}
export interface PlaceSearchPlan{query:string;localPlace:boolean;radiusKm:number|null;origin?:SearchPoint;needsLocation:boolean;}
export function validSearchPoint(point?:SearchPoint|null):SearchPoint|undefined{return point&&Number.isFinite(point.lat)&&Number.isFinite(point.lng)&&Math.abs(point.lat)<=90&&Math.abs(point.lng)<=180?point:undefined;}
export function localPlacePlan(query:string,point?:SearchPoint,scope:PlaceSearchScope=10,postcode=false):PlaceSearchPlan{
 const text=String(query||'').replace(/\bafrica\s+(rest(?:au|ua)rant|restaurant|food|shop|store|grocery)/ig,'African $1').replace(/\brestuarant\b/ig,'restaurant').replace(/\s+/g,' ').trim();
 const near=/\b(?:near|around|close to)\s+(?:me|here)\b|\bnearby\b/i.test(text);
 const explicit=(!near&&text.includes(','))||/\b(?:in|near)\s+(?!me\b|here\b)[\p{L}]/iu.test(text);
 const address=/^\d|\b(street|road|avenue|lane|drive|close|way|walk|crescent|postcode|st|rd|ave|blvd|rue|calle|avenida|strasse|straße)\b/i.test(text);
 const localPlace=near||(!postcode&&!explicit&&!address);
 const origin=validSearchPoint(point),radiusKm=localPlace&&scope!=='country'?(scope===25?25:10):null;
 return {query:text,localPlace,radiusKm,origin,needsLocation:radiusKm!==null&&!origin};
}
export function searchDistanceKm(origin:SearchPoint,point:SearchPoint):number{
 const rad=Math.PI/180,lat=(point.lat-origin.lat)*rad,lng=(point.lng-origin.lng)*rad;
 const a=Math.sin(lat/2)**2+Math.cos(origin.lat*rad)*Math.cos(point.lat*rad)*Math.sin(lng/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(Math.min(1,a)),Math.sqrt(Math.max(0,1-a)));
}
export function searchBoundingBox(origin:SearchPoint,radiusKm:number):[number,number,number,number]|null{
 const angle=radiusKm/6371,latitude=origin.lat*Math.PI/180,deltaLat=angle*180/Math.PI;
 const south=Math.max(-90,origin.lat-deltaLat),north=Math.min(90,origin.lat+deltaLat);
 const ratio=Math.sin(angle)/Math.max(1e-12,Math.cos(latitude));
 const deltaLng=south<=-90||north>=90||ratio>=1?180:Math.asin(ratio)*180/Math.PI;
 const west=origin.lng-deltaLng,east=origin.lng+deltaLng;
 // Do not send an inverted provider bbox at the date line. The distance check
 // still enforces the exact circle for every returned candidate.
 return west< -180||east>180?null:[west,south,east,north];
}
export interface PlaceCategory{kind:string;qualifier:string;}
export function placeCategory(query:string):PlaceCategory|null{
 const text=query.toLowerCase().replace(/\b(?:near|around|close to)\s+(?:me|here)\b|\bnearby\b/g,'').split(',')[0].replace(/\s+(?:in|near)\s+(?!me\b|here\b).+$/i,'').trim();
 const match=text.match(/^(?:(african|nigerian|ghanaian|ethiopian|caribbean|indian|chinese|thai|turkish|italian|mexican|japanese|halal|vegan|vegetarian)\s+)?(restaurant(?:s)?|food|cafe(?:s)?|coffee(?: shop)?|supermarket(?:s)?|grocery(?: store)?|pharmac(?:y|ies)|petrol station|gas station|hospital(?:s)?|shop(?:s)?)$/i);
 if(!match)return null;const word=match[2].toLowerCase();
 const kind=/restaurant|food/.test(word)?'restaurant':/cafe|coffee/.test(word)?'cafe':/grocery|supermarket/.test(word)?'supermarket':/pharmac/.test(word)?'pharmacy':/petrol|gas/.test(word)?'fuel':word.replace(/s$/,'');
 return {kind,qualifier:match[1]||''};
}
export function categoryMatch(category:PlaceCategory,result:{label:string;primaryText?:string;categories?:string[];placeTags?:Record<string,string>;placeType?:string}):boolean{
 const tags=result.placeTags||{},text=[result.label,...(result.categories||[]),...Object.values(tags)].join(' ').toLowerCase().replace(/[_:;-]/g,' ');
 const kinds:Record<string,RegExp>={restaurant:/restaurant|food|cuisine|fast food|takeaway/,cafe:/cafe|coffee/,supermarket:/supermarket|grocery|groceries|convenience/,pharmacy:/pharmacy|chemist|drugstore/,fuel:/fuel|petrol|gas station/,hospital:/hospital/,shop:/shop|store|retail/};
 if(!(kinds[category.kind]?.test(text)))return false;
 if(!category.qualifier)return true;
 return category.qualifier==='african'?/africa|nigerian|ghanaian|ethiopian|somali|kenyan|senegalese|cameroonian|congolese|ugandan|zimbabwean|eritrean|moroccan|tunisian|algerian|egyptian/.test(text):text.includes(category.qualifier);
}
