export interface RankedDriverLocation {
  id: string; lat?: number|null; lng?: number|null; last_active_at?: string|null;
}
export interface DriverReviewScore { average: number; count: number; }
/** Canonical offer/cancellation reliability, null = insufficient data (neutral). */
export interface DriverReliability { acceptanceRate: number|null; cancellationRate: number|null; }
export interface RankingWeights {
  acceptanceRateWeight?: number;   // default 0 (existing behaviour)
  cancellationRateWeight?: number; // default 0 (existing behaviour)
  newDriverExposureKm?: number;    // bounded new-driver boost, default 0
}
const PRIOR_RATING = 4.5;
const PRIOR_REVIEWS = 20;
/** Rating preference can offset at most 600 metres of straight-line proximity. */
const KM_PER_RATING_POINT = 0.15;
/** A full-weight reliability signal can offset at most this many km. */
const RELIABILITY_KM = 1.0;
export const RANKING_REVIEW_WINDOW = 100;

function coordinate(value: unknown, maximum: number): number|null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= maximum ? number : null;
}
export function pickupDistanceKm(pickup: {lat:unknown;lng:unknown}, driver: RankedDriverLocation): number {
  const a=coordinate(pickup.lat,90),b=coordinate(pickup.lng,180),c=coordinate(driver.lat,90),d=coordinate(driver.lng,180);
  if(a===null||b===null||c===null||d===null)return Infinity;
  const rad=(n:number)=>n*Math.PI/180;
  const h=Math.sin(rad(c-a)/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(rad(d-b)/2)**2;
  return 6371*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}
export function confidenceAdjustedRating(score:DriverReviewScore|undefined):number {
  if(!score || !Number.isInteger(score.count) || score.count<1 || score.count>RANKING_REVIEW_WINDOW ||
    !Number.isFinite(score.average)||score.average<1||score.average>5)return PRIOR_RATING;
  return (score.average*score.count+PRIOR_RATING*PRIOR_REVIEWS)/(score.count+PRIOR_REVIEWS);
}

/**
 * Rank eligible drivers by proximity + confidence-adjusted rating, with
 * optional acceptance/cancellation reliability and a bounded new-driver
 * exposure. Zero weights and null (insufficient) reliability are neutral and
 * reproduce the previous ordering exactly. The exposure is bounded to one
 * rating point of km offset and never overrides the caller's eligibility
 * gates (this function only orders already-eligible candidates).
 */
export function rankEligibleDrivers<T extends RankedDriverLocation>(drivers:readonly T[],pickup:{lat:unknown;lng:unknown},
  scores:ReadonlyMap<string,DriverReviewScore>,now=Date.now(),
  reliability?:ReadonlyMap<string,DriverReliability>,
  weights?:RankingWeights):T[] {
  const w={
    acceptanceRateWeight:Math.max(0,weights?.acceptanceRateWeight??0),
    cancellationRateWeight:Math.max(0,weights?.cancellationRateWeight??0),
    newDriverExposureKm:Math.max(0,weights?.newDriverExposureKm??0)
  };
  const ranked=drivers.map(driver=>{
    const distance=pickupDistanceKm(pickup,driver);
    const score=scores.get(driver.id);
    const adjusted=confidenceAdjustedRating(score);
    const isNew=!score;
    const ratingOffset=(5-adjusted)*KM_PER_RATING_POINT;
    // Bounded new-driver exposure: at most one rating point of km offset.
    const newDriverOffset=isNew?-Math.min(w.newDriverExposureKm,KM_PER_RATING_POINT):0;
    const rel=reliability?.get(driver.id);
    // null acceptanceRate/cancellationRate => neutral (insufficient data).
    const acceptanceOffset=w.acceptanceRateWeight*(1-(rel?.acceptanceRate??1))*RELIABILITY_KM;
    const cancellationOffset=w.cancellationRateWeight*(rel?.cancellationRate??0)*RELIABILITY_KM;
    const priority=distance+ratingOffset+newDriverOffset+acceptanceOffset+cancellationOffset;
    const active=Date.parse(String(driver.last_active_at||''));
    return {driver,distance,priority,active:Number.isFinite(active)&&active<=now+30_000?active:0};
  });
  ranked.sort((a,b)=>{
    if(a.priority!==b.priority)return a.priority<b.priority?-1:1;
    if(a.distance!==b.distance)return a.distance<b.distance?-1:1;
    if(a.active!==b.active)return b.active-a.active;
    return a.driver.id<b.driver.id?-1:a.driver.id>b.driver.id?1:0;
  });
  return ranked.map(row=>row.driver);
}
/** Failure is represented by null so dispatch can preserve its previous ordering. */
export async function readDriverReviewScores(db:any,driverIds:readonly string[]):Promise<Map<string,DriverReviewScore>|null> {
  if(!driverIds.length)return new Map();
  const ids=[...new Set(driverIds)];
  if(ids.length>40)return null;
  try {
    const {data,error}=await db.rpc('driver_ranking_scores_v23',{p_driver_ids:ids});
    if(error||!Array.isArray(data))return null;
    const scores=new Map<string,DriverReviewScore>();
    for(const row of data){
      if(!row||!ids.includes(row.driver_id))return null;
      const average=Number(row.average_score),count=Number(row.review_count);
      if(row.average_score==null||row.review_count==null||!Number.isFinite(average)||average<1||average>5||
        !Number.isInteger(count)||count<1||count>RANKING_REVIEW_WINDOW||scores.has(row.driver_id))return null;
      scores.set(row.driver_id,{average,count});
    }
    return scores;
  } catch { return null; }
}
