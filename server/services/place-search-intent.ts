/**
 * Intent-aware suitability for server address/place search. A provider answer (HTTP 200) only
 * fulfils a search when its results genuinely match what was asked for:
 *  - landmark: real POIs; when a terminal is named, the exact terminal (T2 is never T20/Terminal 1);
 *  - place (business/venue): real POIs, or a town/locality, whose NAME carries every distinctive word;
 *  - category: real POIs whose provider category data (never a street label) shows the category and
 *    any requested cuisine;
 * always inside the requested radius and the configured markets (enforced by the caller).
 * Shared query rules come from the same helpers the app uses (src/app/shared/utils/local-place-search).
 */
import {categoryMatch,isNamedLandmark,landmarkTerminal,placeCategory,searchDistanceKm} from '../../src/app/shared/utils/local-place-search';

export type SearchIntent='address'|'postcode'|'place'|'landmark'|'category';
export const SEARCH_INTENTS:readonly SearchIntent[]=['address','postcode','place','landmark','category'];
export interface PlaceResult{lat:number;lng:number;label:string;primaryText?:string;secondaryText?:string;countryCode:string;placeType?:string;postalCode?:string;categories?:string[];}

const GENERIC=new Set(['restaurant','restaurants','cafe','shop','store','hospital','hotel','school','the','and','of','in','near','me','at']);
const LANDMARK_GENERIC=new Set([...GENERIC,'airport','terminal','station','railway','train','bus','university','museum','stadium','shopping','centre','center','international']);
/** Mapbox feature types that can stand for a named place (a town is a valid "place" answer; a street is not). */
const AREA_TYPES=new Set(['place','locality','neighborhood','district','region']);

export function normaliseWords(value:string):string[]{
 return String(value||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(' ').filter(Boolean);
}
/** Prefix match, or one edit for words of five letters or more (keeps "Labuka" ~ "Labuca"). */
export function wordMatches(token:string,word:string):boolean{
 if(word.startsWith(token)||token===word)return true;
 if(token.length<5||Math.abs(token.length-word.length)>1)return false;
 let a=0,b=0,differences=0;
 while(a<token.length&&b<word.length){if(token[a]===word[b]){a++;b++;continue;}if(++differences>1)return false;if(token.length>=word.length)a++;if(word.length>=token.length)b++;}
 return differences+(token.length-a)+(word.length-b)<=1;
}
const firstLine=(query:string)=>String(query||'').split(',')[0];
const terminalWords=/^(?:t\d{1,2}[a-z]?|\d{1,2}[a-z]?|one|two|three|four|five|i|ii|iii|iv|v)$/;
export function distinctiveTokens(query:string,intent:SearchIntent):string[]{
 const generic=intent==='landmark'?LANDMARK_GENERIC:GENERIC;
 return normaliseWords(firstLine(query)).filter(word=>!generic.has(word)&&!(intent==='landmark'&&terminalWords.test(word)));
}
const nameOf=(r:PlaceResult)=>r.primaryText||r.label.split(',')[0];
const allTokensIn=(tokens:string[],text:string)=>{const words=normaliseWords(text);return tokens.every(t=>words.some(w=>wordMatches(t,w)));};

/** Classify a query the same way the app does (used when a caller does not send an intent). */
export function classifyIntent(query:string,postcode:boolean):SearchIntent{
 if(postcode)return 'postcode';
 const text=firstLine(query);
 if(isNamedLandmark(query))return 'landmark';
 if(placeCategory(query))return 'category';
 return /^\d/.test(text.trim())||/\b(street|road|avenue|lane|drive|close|way|walk|crescent|postcode|st|rd|ave|blvd)\b/i.test(text)?'address':'place';
}

export interface SuitabilityInput{query:string;intent:SearchIntent;origin?:{lat:number;lng:number};radiusKm?:number|null;}
/** Keep only results that genuinely answer the query; `fulfilled` is whether anything suitable remains. */
export function suitableResults(results:PlaceResult[],input:SuitabilityInput):{results:PlaceResult[];fulfilled:boolean}{
 const {query,intent,origin,radiusKm}=input;
 const bounded=results.filter(r=>!radiusKm||!origin||searchDistanceKm(origin,r)<=radiusKm);
 if(intent==='address'||intent==='postcode')return {results:bounded,fulfilled:bounded.length>0};
 if(intent==='category'){
  const category=placeCategory(query);
  // Evidence must come from the provider's category data, never from the label (a street called
  // "Restaurant Terrace" is not a restaurant).
  const kept=category?bounded.filter(r=>r.placeType==='poi'&&categoryMatch(category,{label:'',categories:r.categories||[]})):[];
  return {results:kept,fulfilled:kept.length>0};
 }
 const tokens=distinctiveTokens(query,intent);
 if(intent==='landmark'){
  const terminal=landmarkTerminal(query);
  const names=(r:PlaceResult)=>tokens.length>0&&allTokensIn(tokens,`${nameOf(r)} ${r.label}`);
  const parents=bounded.filter(r=>r.placeType==='poi'&&!landmarkTerminal(nameOf(r))&&names(r));
  const kept=bounded.filter(r=>{
   if(r.placeType!=='poi')return false;
   const own=landmarkTerminal(nameOf(r));
   if(terminal&&own&&own!==terminal)return false;
   // The exact terminal may omit the airport name: then it must lie within 15 km of the named parent.
   if(terminal&&own===terminal)return names(r)||parents.some(p=>searchDistanceKm(p,r)<=15);
   return names(r);
  });
  const fulfilled=terminal?kept.some(r=>landmarkTerminal(nameOf(r))===terminal):kept.length>0;
  return {results:fulfilled?kept:[],fulfilled};
 }
 // place: a business/venue POI, or a town/locality, whose name carries every distinctive word.
 const kept=tokens.length?bounded.filter(r=>(r.placeType==='poi'||AREA_TYPES.has(String(r.placeType)))&&allTokensIn(tokens,nameOf(r))):[];
 return {results:kept,fulfilled:kept.length>0};
}
