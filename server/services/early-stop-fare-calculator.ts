import {currencyDecimals,toCurrencyMinor} from '../../src/app/shared/utils/currency-money';
export const EARLY_FARE_POLICY='early-stop-distance-prorata-v1';
export class FareEvidenceReview extends Error {constructor(readonly reason:string){super(reason);}}
const review=(reason:string):never=>{throw new FareEvidenceReview(reason);};
const finite=(value:unknown):number=>typeof value==='number'&&Number.isFinite(value)?value:review('invalid_terms');
const time=(value:unknown):number=>{const result=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(result)?result:review('missing_timestamps');};
function metres(a:{lat:number;lng:number},b:{lat:number;lng:number}):number{
 const r=(n:number)=>n*Math.PI/180;const h=Math.sin(r(b.lat-a.lat)/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(r(b.lng-a.lng)/2)**2;
 return 6371000*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}
function location(lat:unknown,lng:unknown){const a=finite(lat),b=finite(lng);if(Math.abs(a)>90||Math.abs(b)>180)review('invalid_location');return {lat:a,lng:b};}
export function calculateEarlyFare(frame:any){
 if(!frame?.start||!frame?.stop||!frame?.job)review('missing_start');
 const {start,stop,job}=frame;
 if(start.customer_id!==job.customer_id||start.driver_id!==job.driver_id||stop.customer_id!==job.customer_id||stop.driver_id!==job.driver_id)review('assignment_changed');
 const frozen=start.booking_snapshot;
 if(!frozen||JSON.stringify(frozen.fare_breakdown)!==JSON.stringify(job.fare_breakdown)||frozen.currency_code!==job.currency_code)review('terms_changed');
 const snapshot=job.fare_breakdown,currency=job.currency_code;
 if(snapshot?.policyVersion!=='fare-split-v1'||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency)||snapshot.currency!==currency)review('invalid_terms');
 const minor=(v:unknown)=>{try{return toCurrencyMinor(finite(v),currency);}catch{return review('invalid_terms');}};
 const originalMinor=minor(snapshot.customerCharge),platformMinor=minor(snapshot.platformFeeAmount),commissionMinor=minor(snapshot.driverCommissionAmount),driverMinor=minor(snapshot.driverEntitlement);
 if(originalMinor<=0||driverMinor<=0||platformMinor+commissionMinor+driverMinor!==originalMinor)review('invalid_terms');
 let plannedMetres=0;
 const explicit=frozen.distance_meters,km=frozen.estimated_distance_km;
 if(typeof explicit==='number'&&Number.isFinite(explicit)&&explicit>0)plannedMetres=Math.round(explicit);
 if(typeof km==='number'&&Number.isFinite(km)&&km>0){const converted=Math.round(km*1000);if(plannedMetres&&Math.abs(converted-plannedMetres)>Math.max(10,plannedMetres*.01))review('ambiguous_distance');plannedMetres ||= converted;}
 if(!Number.isSafeInteger(plannedMetres)||plannedMetres<=0||plannedMetres>2_000_000)review('missing_quoted_distance');
 const started=time(start.started_at),stopped=time(stop.created_at);
 if(stopped<=started||stopped-started>20*3600000)review('invalid_journey_window');
 if(!Array.isArray(frame.points)||frame.points.length<2||frame.points.length>7200)review('insufficient_history');
 const pickup=location(frozen.pickup_lat,frozen.pickup_lng);
 let previous:any=null,anchor:any=null,total=0;
 for(const point of frame.points){
  if(point.job_id!==job.id||point.driver_id!==job.driver_id||point.tenant_id!==job.tenant_id||!['in_progress','picked_up','on_trip'].includes(point.booking_phase))review('assignment_changed');
  const at=time(point.sampled_at),received=time(point.received_at),accuracy=finite(point.accuracy_metres),position=location(point.latitude,point.longitude);
  if(accuracy<0||accuracy>30)review('inaccurate_gps');
  if(at<started||at>stopped||received<started||received>stopped||Math.abs(received-at)>90000)review('invalid_journey_window');
  const current={...position,at,accuracy};
  if(!previous){if(at-started>30000||metres(pickup,current)>100)review('missing_start_coverage');anchor=current;}
  else{
   const seconds=(at-previous.at)/1000;
   if(seconds<=0)review('out_of_order');if(seconds>45)review('gps_gap');
   if(metres(previous,current)/seconds>45)review('implausible_movement');
   const travelled=metres(anchor,current);
   if(travelled>Math.max(10,anchor.accuracy+accuracy)){total+=travelled;anchor=current;}
  }
  previous=current;
 }
 if(stopped-previous.at>30000)review('missing_stop_coverage');
 if(total>plannedMetres*1.1)review('route_needs_review');
 const coveredMetres=Math.min(plannedMetres,Math.floor(total));
 const prorate=(amount:number)=>Number(BigInt(amount)*BigInt(coveredMetres)/BigInt(plannedMetres));
 const amountMinor=prorate(originalMinor),platformFeeMinor=prorate(platformMinor),driverCommissionMinor=prorate(commissionMinor);
 return {policyVersion:EARLY_FARE_POLICY,currency,exponent:currencyDecimals(currency),originalMinor,amountMinor,
  coveredMetres,plannedMetres,unusedQuotedMetres:plannedMetres-coveredMetres,
  split:{platformFeeMinor,driverCommissionMinor,driverEntitlementMinor:amountMinor-platformFeeMinor-driverCommissionMinor}};
}
