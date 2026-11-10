import {mapPoint,mapsV23,MapsV23} from './maps-v23';
export async function mapQuoteContext(body:any,client:MapsV23=mapsV23){
 const start=mapPoint({lat:body.lat??body.pickupLat,lng:body.lng??body.pickupLng});
 const location=await client.reverse(start);
 if(body.dropoffLat==null||body.dropoffLng==null)throw Error('MAP_QUOTE_DESTINATION_REQUIRED');
 const route=await client.route(start,mapPoint({lat:body.dropoffLat,lng:body.dropoffLng}));
 return {countryCode:location.countryCode,distanceKm:route.distanceMeters/1000,durationMinutes:route.durationSeconds/60};
}
