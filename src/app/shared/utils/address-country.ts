import {localPlacePlan,placeCategory,type PlaceSearchPlan,type SearchPoint,type PlaceSearchScope} from './local-place-search';
/** Ordinary addresses may be anywhere in configured countries; nearby categories retain radius controls. */
export function addressSearchPlan(query:string,origin?:SearchPoint,scope:PlaceSearchScope=10,postcode=false):PlaceSearchPlan{
 const plan=localPlacePlan(query,origin,scope,postcode);
 return placeCategory(query)||/\bnearby\b|\bnear me\b/i.test(query)?plan:{...plan,localPlace:false,radiusKm:null,needsLocation:false};
}
export function resolvedAddressCountry<T extends {code:string;currency:string}>(code:string,countries:readonly T[]):T{
 if(!/^[A-Z]{2}$/.test(code))throw Error('Could not identify the pickup country. Please choose a precise address.');
 const country=countries.find(c=>c.code===code);
 if(!country||!/^[A-Z]{3}$/.test(country.currency))throw Error('This pickup country is not configured for bookings.');
 return country;
}
