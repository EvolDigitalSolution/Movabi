export interface DemandZone {lat:number;lng:number;demand:number;drivers:number;busyDrivers:number;}
export function demandZones(jobs:any[],drivers:any[]) {
 const zones=new Map<string,DemandZone>();
 const point=(lat:any,lng:any)=>typeof lat==='number'&&typeof lng==='number'&&Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180&&!(lat===0&&lng===0);
 const zone=(lat:number,lng:number)=>{const y=Math.floor(lat*100),x=Math.floor(lng*100),key=`${y}:${x}`;if(!zones.has(key))zones.set(key,{lat:(y+.5)/100,lng:(x+.5)/100,demand:0,drivers:0,busyDrivers:0});return zones.get(key)!;};
 for(const job of jobs)if(point(job.pickup_lat,job.pickup_lng))zone(job.pickup_lat,job.pickup_lng).demand++;
 const seen=new Set<string>();
 for(const driver of drivers)if(!seen.has(driver.id)&&point(driver.lat,driver.lng)){seen.add(driver.id);const z=zone(driver.lat,driver.lng);if(driver.is_available)z.drivers++;else z.busyDrivers++;}
 return [...zones.values()];
}
