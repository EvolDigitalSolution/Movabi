import {describe,it,vi,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import express from 'express';
import {calculateEarlyFare,FareEvidenceReview} from '../../server/services/early-stop-fare-calculator';
import {executeFarePilot,parseFareVote,farePilotError} from '../../server/services/early-stop-fare.service';
import routes from '../../server/routes/early-stop-fare.routes';
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{rpc:async()=>({data:{enabled:true,viewer:'customer',bookingUpdated:false,paymentUpdated:false,proposal:null},error:null})}}));
const jobId='11111111-1111-4111-8111-111111111111',stopId='22222222-2222-4222-8222-222222222222';
function frame(){
 const fare={policyVersion:'fare-split-v1',currency:'NGN',customerCharge:1000,platformFeeAmount:100,driverCommissionAmount:90,driverEntitlement:810};
 const start=Date.parse('2026-10-23T12:00:00Z'),stamp=(seconds:number)=>new Date(start+seconds*1000).toISOString();
 return {job:{id:jobId,customer_id:'customer',driver_id:'driver',tenant_id:'tenant',currency_code:'NGN',fare_breakdown:fare},
 start:{customer_id:'customer',driver_id:'driver',started_at:stamp(0),booking_snapshot:{currency_code:'NGN',fare_breakdown:{...fare},distance_meters:1000,estimated_distance_km:1,pickup_lat:0,pickup_lng:0}},
 stop:{customer_id:'customer',driver_id:'driver',created_at:stamp(60)},
 points:Array.from({length:7},(_,index)=>({job_id:jobId,driver_id:'driver',tenant_id:'tenant',booking_phase:'in_progress',latitude:0,longitude:index*.00075,accuracy_metres:5,sampled_at:stamp(index*10),received_at:stamp(index*10)}))};
}
describe('early stop fare evidence and integer arithmetic',()=>{
 it('prorates the original inclusive charge with balanced minor-unit allocation',()=>{
  const result=calculateEarlyFare(frame());assert.equal(result.coveredMetres,500);assert.equal(result.amountMinor,50000);assert.equal(result.originalMinor,100000);
  assert.equal(Object.values(result.split).reduce((a,b)=>a+b,0),result.amountMinor);assert.equal(result.unusedQuotedMetres,500);
 });
 it('does not bill confirmation waiting time',()=>{const f=frame();const result=calculateEarlyFare(f);assert.equal(result.amountMinor,50000);});
 it('does not count stationary GPS jitter as travelled distance',()=>{const f=frame();for(const p of f.points)p.longitude=.000001;assert.equal(calculateEarlyFare(f).amountMinor,0);});
 for(const currency of ['JPY','KWD'])it('respects '+currency+' precision',()=>{const f=frame();f.job.currency_code=currency;f.job.fare_breakdown.currency=currency;f.start.booking_snapshot.currency_code=currency;f.start.booking_snapshot.fare_breakdown.currency=currency;const r=calculateEarlyFare(f);assert.equal(r.exponent,currency==='JPY'?0:3);assert.equal(r.amountMinor,r.originalMinor/2);});
 const changes:Record<string,(f:any)=>void>={
  'missing start':f=>delete f.start,'changed driver':f=>f.job.driver_id='other',
  'changed original fare':f=>f.job.fare_breakdown.customerCharge=999,
  'unbalanced original split':f=>{f.job.fare_breakdown.driverEntitlement=800;f.start.booking_snapshot.fare_breakdown.driverEntitlement=800;},
  'missing planned distance':f=>{f.start.booking_snapshot.distance_meters=null;f.start.booking_snapshot.estimated_distance_km=null;},
  'ambiguous quoted distance':f=>f.start.booking_snapshot.estimated_distance_km=2,
  'missing history':f=>f.points=[], 'inaccurate GPS':f=>f.points[3].accuracy_metres=31,
  'wrong tenant':f=>f.points[3].tenant_id='other','wrong booking':f=>f.points[3].job_id='other',
  'pickup phase':f=>f.points[3].booking_phase='arrived','out of order':f=>f.points.reverse(),
  'missing start coverage':f=>f.points=f.points.slice(4),'missing stop coverage':f=>f.points=f.points.slice(0,2),
  'backdated later receipt':f=>f.points[2].received_at='2026-10-23T12:02:00Z',
  'GPS teleport':f=>f.points[3].latitude=20,
  'bad pickup':f=>f.start.booking_snapshot.pickup_lat=null,
  'route longer than quote':f=>{f.start.booking_snapshot.distance_meters=200;f.start.booking_snapshot.estimated_distance_km=.2;},
  'GPS gap':f=>f.points=[f.points[0],f.points[6]]
 };
 for(const [name,mutate] of Object.entries(changes))it('requires review for '+name,()=>{const f=frame();mutate(f);assert.throws(()=>calculateEarlyFare(f),FareEvidenceReview);});
});
describe('fare consent boundary',()=>{
 it('requires explicit acceptance separate from proposal creation',()=>assert.deepEqual(parseFareVote({proposalId:stopId,action:'accept'}),{proposalId:stopId,action:'accept',note:''}));
 for(const key of ['amount','distance','customerId','driverId','provider','accepted'])it('rejects supplied '+key,()=>assert.throws(()=>parseFareVote({proposalId:stopId,action:'accept',[key]:true})));
 it('requires a review explanation',()=>assert.throws(()=>parseFareVote({proposalId:stopId,action:'reject',note:'no'})));
 it('uses canonical original payment authority before persisting a proposal',async()=>{
  const calls:any[]=[];const db={rpc:async(name:string,args:any)=>{calls.push([name,args]);return {data:name==='early_stop_fare_context_v23'?{frame:frame(),digest:'frozen-digest',authorityJob:{id:jobId}}:{enabled:true,viewer:'customer',bookingUpdated:false,paymentUpdated:false,proposal:null},error:null};}};
  await executeFarePilot(db,'session-owner',jobId,stopId,'propose',undefined,async job=>{assert.equal(job.id,jobId);return {currency:'NGN',serviceFareMajor:1000,itemBudgetMajor:0,totalAuthorisationMajor:1000};});
  assert.equal(calls.length,2);assert.equal(calls[1][1].p_actor,'session-owner');assert.equal(calls[1][1].p_calculation.amountMinor,50000);assert.equal(calls[1][1].p_proposal_id,null);
 });
 it('does not persist when canonical authority disagrees',async()=>{
  let calls=0;const db={rpc:async()=>{calls++;return{data:{frame:frame(),digest:'x',authorityJob:{}},error:null};}};
  await assert.rejects(executeFarePilot(db,'owner',jobId,stopId,'propose',undefined,async()=>({currency:'GBP',serviceFareMajor:1000,itemBudgetMajor:0,totalAuthorisationMajor:1000})),FareEvidenceReview);assert.equal(calls,1);
 });
 it('does not leak raw internal errors',()=>assert.equal(farePilotError(Error('private database data')).code,'FARE_UNAVAILABLE'));
});
afterEach(()=>vi.unstubAllEnvs());
async function http(method:string,body?:unknown,actor='customer'){
 const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.stopActor=actor;next();});app.use('/fare',routes);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 try{const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/fare/${stopId}${method==='POST'?'/proposal':''}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
describe('real fare HTTP handlers',()=>{
 const enable=()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('VAYDU_EARLY_STOP_PILOT_V23','true');vi.stubEnv('VAYDU_EARLY_STOP_FARE_PILOT_V23','true');};
 it('is off by default',async()=>{enable();vi.stubEnv('VAYDU_EARLY_STOP_FARE_PILOT_V23','false');assert.equal((await http('GET')).status,404);});
 it('is unavailable in production',async()=>{enable();vi.stubEnv('NODE_ENV','production');assert.equal((await http('GET')).status,404);});
 it('requires the authenticated parent actor',async()=>{enable();assert.equal((await http('GET',undefined,'')).status,401);});
 it('reads a restricted public proposal view',async()=>{enable();assert.equal((await http('GET')).status,200);});
 for(const key of ['amount','distance','driverId','callbackUrl'])it('refuses browser '+key,async()=>{enable();assert.equal((await http('POST',{[key]:100})).status,400);});
});
