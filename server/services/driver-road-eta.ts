import {mapsV23,mapPoint,MapsV23} from './maps-v23';
/** Reorders only already eligible candidates. No network on previews or when disabled. */
export async function orderDriversByRoadEta<T extends {lat?:number|null;lng?:number|null}>(drivers:T[],pickup:any,client:MapsV23=mapsV23):Promise<T[]>{
 if(process.env.VAYDU_TOMTOM_MATRIX_V23!=='true'||drivers.length<2)return drivers;
 try{
  const candidates=drivers.slice(0,20),origin=candidates.map(d=>mapPoint({lat:d.lat,lng:d.lng}));
  const cells=await client.matrix(origin,mapPoint(pickup));
  if(cells.length!==candidates.length||cells.some(c=>c.seconds===null))return drivers;
  const eta=new Map<number,number>(cells.map((c:any)=>[c.index,c.seconds!]));
  // Keep the existing rating/distance order for candidates within the same ETA minute.
  const sorted=candidates.map((driver,index)=>({driver,index,bucket:Math.floor(eta.get(index)!/60)})).sort((a,b)=>a.bucket-b.bucket||a.index-b.index).map(r=>r.driver);
  return [...sorted,...drivers.slice(20)];
 }catch{return drivers;}
}
