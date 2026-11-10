import {describe,expect,it,vi} from 'vitest';
import {confidenceAdjustedRating,pickupDistanceKm,rankEligibleDrivers,readDriverReviewScores} from '../../server/services/driver-ranking';
const pickup={lat:0,lng:0};
const driver=(id:string,lat=0,lng=0)=>({id,lat,lng});
const scores=(entries:Array<[string,number,number]>)=>new Map(entries.map(([id,average,count])=>[id,{average,count}]));
describe('confidence-aware driver ranking',()=>{
  it('starts a new driver at a neutral prior',()=>expect(confidenceAdjustedRating(undefined)).toBe(4.5));
  it('requires more than one perfect review to dominate',()=>{
    expect(confidenceAdjustedRating({average:5,count:1})).toBeLessThan(confidenceAdjustedRating({average:4.8,count:100}));
  });
  it.each([{average:5,count:0},{average:6,count:5},{average:NaN,count:10},{average:4,count:1.5},{average:4,count:101}])('ignores malformed scores %j',score=>expect(confidenceAdjustedRating(score)).toBe(4.5));
  it('prefers a stronger established rating at equal proximity',()=>{
    const result=rankEligibleDrivers([driver('low'),driver('high')],pickup,scores([['low',3,100],['high',4.9,100]]));
    expect(result.map(d=>d.id)).toEqual(['high','low']);
  });
  it('keeps nearby drivers ahead when the geographic gap exceeds the rating allowance',()=>{
    const result=rankEligibleDrivers([driver('far',0.02),driver('near')],pickup,scores([['near',1,100],['far',5,100]]));
    expect(result[0].id).toBe('near');
  });
  it('lets ratings influence candidates within a short distance',()=>{
    const result=rankEligibleDrivers([driver('near'),driver('slightly-far',0.001)],pickup,scores([['near',2,100],['slightly-far',5,100]]));
    expect(result[0].id).toBe('slightly-far');
  });
  it('does not put every new driver behind experienced drivers',()=>{
    expect(rankEligibleDrivers([driver('established'),driver('new')],pickup,scores([['established',4,100]]))[0].id).toBe('new');
  });
  it('cannot introduce a driver excluded by eligibility',()=>{
    const result=rankEligibleDrivers([driver('eligible')],pickup,scores([['excluded',5,100]]));expect(result.map(d=>d.id)).toEqual(['eligible']);
  });
  it('does not mutate the eligible input',()=>{
    const input=[driver('b'),driver('a')];rankEligibleDrivers(input,pickup,new Map());expect(input.map(d=>d.id)).toEqual(['b','a']);
  });
  it('uses a deterministic ID tie-break independent of input order',()=>{
    for(const input of [[driver('a'),driver('b')],[driver('b'),driver('a')]])expect(rankEligibleDrivers(input,pickup,new Map()).map(d=>d.id)).toEqual(['a','b']);
  });
  it('uses recent activity only after proximity and rating tie',()=>{
    const rows=[{...driver('old'),last_active_at:'2026-10-23T10:00:00Z'},{...driver('recent'),last_active_at:'2026-10-23T11:00:00Z'}];
    expect(rankEligibleDrivers(rows,pickup,new Map(),Date.parse('2026-10-23T12:00:00Z'))[0].id).toBe('recent');
  });
  it('does not reward an invalid future activity timestamp',()=>{
    const rows=[{...driver('future'),last_active_at:'2099-01-01'},{...driver('real'),last_active_at:'2026-10-23T11:00:00Z'}];
    expect(rankEligibleDrivers(rows,pickup,new Map(),Date.parse('2026-10-23T12:00:00Z'))[0].id).toBe('real');
  });
  it.each([null,undefined,NaN,Infinity,91])('places invalid latitude %s after a located driver',lat=>{
    expect(rankEligibleDrivers([{id:'invalid',lat,lng:0},driver('located',1)],pickup,scores([['invalid',5,100]]))[0].id).toBe('located');
  });
  it('handles longitude wrapping across the date line',()=>expect(pickupDistanceKm({lat:0,lng:179.999},driver('across',0,-179.999))).toBeLessThan(0.3));
  it('does not treat absent coordinates as zero',()=>expect(pickupDistanceKm({lat:null,lng:0},driver('d'))).toBe(Infinity));
});
describe('service-only verified review read',()=>{
  it('maps database numeric results and calls only the bounded RPC',async()=>{
    const rpc=vi.fn(async()=>({data:[{driver_id:'a',average_score:'4.8',review_count:'20'}],error:null}));
    const result=await readDriverReviewScores({rpc},['a','a']);
    expect(rpc).toHaveBeenCalledWith('driver_ranking_scores_v23',{p_driver_ids:['a']});expect(result?.get('a')).toEqual({average:4.8,count:20});
  });
  it('does not query an empty candidate list',async()=>{const rpc=vi.fn();expect(await readDriverReviewScores({rpc},[])).toEqual(new Map());expect(rpc).not.toHaveBeenCalled();});
  it('does not query an oversized candidate list',async()=>{const rpc=vi.fn();expect(await readDriverReviewScores({rpc},Array.from({length:41},(_,n)=>String(n)))).toBeNull();expect(rpc).not.toHaveBeenCalled();});
  it('preserves the previous dispatch path when the function is absent',async()=>expect(await readDriverReviewScores({rpc:async()=>({error:{code:'PGRST202'},data:null})},['a'])).toBeNull());
  it('preserves the previous dispatch path on a thrown connection error',async()=>expect(await readDriverReviewScores({rpc:async()=>{throw Error('connection');}},['a'])).toBeNull());
  it.each([
    [{driver_id:'other',average_score:5,review_count:1}],
    [{driver_id:'a',average_score:5,review_count:101}],
    [{driver_id:'a',average_score:null,review_count:1}],
    [{driver_id:'a',average_score:5,review_count:null}],
    [{driver_id:'a',average_score:5,review_count:1},{driver_id:'a',average_score:4,review_count:1}]
  ].map(data=>({data})))('rejects unexpected results %j',async ({data})=>expect(await readDriverReviewScores({rpc:async()=>({data,error:null})},['a'])).toBeNull());
});

// Exercise the real dispatch filtering path with deterministic database/provider stubs.
const dispatchDb=vi.hoisted(()=>({current:null as any}));
const smartSettings=vi.hoisted(()=>({current:{acceptanceRateWeight:0,cancellationRateWeight:0,newDriverExposureKm:0} as any}));
const metricsById=vi.hoisted(()=>({current:{} as Record<string,any>}));
vi.mock('../../server/services/supabase.service',()=>({getSupabaseAdmin:()=>dispatchDb.current}));
vi.mock('../../server/services/market-availability.service',()=>({MarketAvailabilityService:{}}));
vi.mock('../../server/services/event.service',()=>({EventService:{}}));
vi.mock('../../server/services/notification.service',()=>({NotificationService:{}}));
vi.mock('../../server/services/stripe.service',()=>({stripe:{}}));
vi.mock('../../server/services/driver-service-eligibility',()=>({toCanonicalDriverService:()=> 'ride',isDriverEligibleForService:(profile:any)=>profile.allowed!==false}));
vi.mock('../../server/services/payout-eligibility.service',()=>({SUPPORTED_PAYOUT_COUNTRIES:['GB']}));
vi.mock('../../server/services/marketplace-config.service',()=>({MarketplaceConfigService:{getSmartMatchingSettings:async()=>smartSettings.current}}));
vi.mock('../../server/services/driver-offer-metrics.service',()=>({reportDriverOfferMetrics:async(id:string)=>metricsById.current[id]||{acceptanceRate:null,cancellationRate:null}}));
import {DispatchService} from '../../server/services/dispatch.service';
function dispatchFixture(opts:{extraProfiles?:any[],scores?:any[],settings?:any,metrics?:Record<string,any>}={}){
  smartSettings.current=opts.settings??{acceptanceRateWeight:0,cancellationRateWeight:0,newDriverExposureKm:0};
  metricsById.current=opts.metrics??{};
  const profiles=[
    {...driver('low'),allowed:true,registration_country_code:'GB',tenant_id:'t1'},
    {...driver('high'),allowed:true,registration_country_code:'GB',tenant_id:'t1'},
    {...driver('ineligible'),allowed:false,registration_country_code:'GB',tenant_id:'t1'},
    ...(opts.extraProfiles??[])
  ];
  const scores=opts.scores??[{driver_id:'low',average_score:3,review_count:100},{driver_id:'high',average_score:5,review_count:100}];
  const rpc=vi.fn(async()=>({data:scores,error:null}));
  dispatchDb.current={rpc,from:(table:string)=>{
    const q:any={select:()=>q,eq:()=>q,in:()=>q,limit:()=>q,or:()=>q,gte:()=>q,lte:()=>q,
      then:(resolve:any)=>resolve({data:table==='profiles'?profiles:profiles.map(p=>({user_id:p.id,vehicle_class:'car'})),error:null})};return q;
  }};
  return {rpc,find:(strict=false)=>(new DispatchService() as any).findNearbyDrivers({pickup_lat:0,pickup_lng:0,service_slug:'ride',country_code:'GB',tenant_id:'t1'},null,null,strict)};
}
describe('actual dispatch invitation ranking integration',()=>{
  it('does not query reviews when ranking is disabled',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','false');const f=dispatchFixture();expect((await f.find()).map((d:any)=>d.id)).toEqual(['low','high']);expect(f.rpc).not.toHaveBeenCalled();
  });
  it('ranks only candidates surviving the canonical eligibility filter',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','true');const f=dispatchFixture();expect((await f.find()).map((d:any)=>d.id)).toEqual(['high','low']);expect(f.rpc).toHaveBeenCalledWith('driver_ranking_scores_v23',{p_driver_ids:['low','high']});
  });
  it('falls back to original ordering when the review read fails',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','true');const f=dispatchFixture();f.rpc.mockResolvedValue({data:null as any,error:{code:'PGRST202'} as any});expect((await f.find()).map((d:any)=>d.id)).toEqual(['low','high']);
  });
  it('does not add ranking reads to customer availability previews',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','true');const f=dispatchFixture();await f.find(true);expect(f.rpc).not.toHaveBeenCalled();
  });
  it('zero weights preserve rating-only ordering',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','true');const f=dispatchFixture();expect((await f.find()).map((d:any)=>d.id)).toEqual(['high','low']);
  });
  it('acceptance weight reorders a low-acceptance driver behind',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','true');
    const f=dispatchFixture({settings:{acceptanceRateWeight:1,cancellationRateWeight:0,newDriverExposureKm:0},
      metrics:{high:{acceptanceRate:0,cancellationRate:null},low:{acceptanceRate:1,cancellationRate:null}}});
    expect((await f.find()).map((d:any)=>d.id)).toEqual(['low','high']);
  });
  it('cancellation weight reorders a high-cancellation driver behind',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','true');
    const f=dispatchFixture({settings:{acceptanceRateWeight:0,cancellationRateWeight:1,newDriverExposureKm:0},
      metrics:{high:{acceptanceRate:null,cancellationRate:0.9},low:{acceptanceRate:null,cancellationRate:0}}});
    expect((await f.find()).map((d:any)=>d.id)).toEqual(['low','high']);
  });
  it('insufficient reliability history is neutral',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','true');
    const f=dispatchFixture({settings:{acceptanceRateWeight:1,cancellationRateWeight:1,newDriverExposureKm:0},
      metrics:{high:{acceptanceRate:null,cancellationRate:null},low:{acceptanceRate:null,cancellationRate:null}}});
    expect((await f.find()).map((d:any)=>d.id)).toEqual(['high','low']);
  });
  it('a new driver receives bounded exposure',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','true');
    const f=dispatchFixture({extraProfiles:[{...driver('new'),allowed:true,registration_country_code:'GB',tenant_id:'t1'}],
      settings:{acceptanceRateWeight:0,cancellationRateWeight:0,newDriverExposureKm:0.15}});
    // new (no reviews -> prior 4.5 + 0.15 km exposure) outranks both established drivers.
    expect((await f.find()).map((d:any)=>d.id)).toEqual(['new','high','low']);
  });
  it('ineligible drivers stay excluded under weights and exposure',async()=>{
    vi.stubEnv('VAYDU_DRIVER_RANKING_V23','true');
    const f=dispatchFixture({extraProfiles:[{...driver('new'),allowed:true,registration_country_code:'GB',tenant_id:'t1'}],
      settings:{acceptanceRateWeight:1,cancellationRateWeight:1,newDriverExposureKm:0.15},
      metrics:{low:{acceptanceRate:1,cancellationRate:0},high:{acceptanceRate:1,cancellationRate:0}}});
    const ids=(await f.find()).map((d:any)=>d.id);
    expect(ids).not.toContain('ineligible');
  });
});
