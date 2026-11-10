import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import express from 'express';
import {recordJourneyEvidence} from '../../server/services/journey-evidence.service';
import {issueJourneyGrant} from '../../server/services/journey-location.service';
import journeyRoutes from '../../server/routes/journey.routes';
const state=vi.hoisted(()=>({job:null as any,existing:null as any,rpc:vi.fn(),writes:0}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{
  auth:{getUser:async(token:string)=>({data:{user:token==='valid'?{id:'22222222-2222-4222-8222-222222222222'}:null},error:token==='valid'?null:{}})},
  rpc:(...args:any[])=>state.rpc(...args),
  from:(table:string)=>{
    const filters:Record<string,unknown>={};const q:any={select:()=>q,eq:(key:string,value:unknown)=>{filters[key]=value;return q;},
      maybeSingle:async()=>({data:table==='jobs'?(state.job&&Object.entries(filters).every(([key,value])=>state.job[key]===value)?state.job:null):state.existing,error:null}),
      update:()=>{state.writes++;return q;},insert:()=>{state.writes++;return q;},then:(resolve:any)=>resolve({error:null})};return q;
  }
}}));
const grant={jobId:'11111111-1111-4111-8111-111111111111',driverId:'22222222-2222-4222-8222-222222222222',tenantId:'33333333-3333-4333-8333-333333333333',expires:Date.now()+3600000};
const now=Date.parse('2026-10-23T12:00:00Z');
const body=()=>({latitude:53,longitude:-2,accuracy:8,time:Date.now()});
afterEach(()=>{vi.unstubAllEnvs();});
describe('journey evidence side-effect boundary',()=>{
  it('does not contact the database when disabled',async()=>{const rpc=vi.fn();expect(await recordJourneyEvidence({rpc},grant,{},false,now)).toBe('off');expect(rpc).not.toHaveBeenCalled();});
  it('passes only validated coordinates and grant-owned identifiers',async()=>{
    const rpc=vi.fn(async()=>({data:'recorded',error:null}));
    expect(await recordJourneyEvidence({rpc},grant,{latitude:53,longitude:-2,accuracy:8,time:now,jobId:'forged',driverId:'forged',amount:1},true,now)).toBe('recorded');
    expect(rpc).toHaveBeenCalledWith('append_journey_evidence_v23',{p_job_id:grant.jobId,p_driver_id:grant.driverId,p_tenant_id:grant.tenantId,p_lat:53,p_lng:-2,p_accuracy:8,p_sampled_at:new Date(now).toISOString()});
  });
  it.each([{latitude:null},{longitude:181},{time:now-90001},{time:now+30001},{accuracy:101},{accuracy:-1},{latitude:0,longitude:0}])('does not write invalid GPS %j',async override=>{
    const rpc=vi.fn();expect(await recordJourneyEvidence({rpc},grant,{latitude:53,longitude:-2,accuracy:8,time:now,...override},true,now)).toBe('unavailable');expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['recorded','duplicate','out_of_order','throttled','limit_reached'])('returns provider-independent ingestion state %s',async data=>expect(await recordJourneyEvidence({rpc:async()=>({data,error:null})},grant,{latitude:53,longitude:-2,accuracy:8,time:now},true,now)).toBe(data));
  it.each([{data:'recorded',error:{code:'PGRST202'}},{data:'invented',error:null},{data:null,error:null},{data:{secret:'do not expose'},error:null}])('does not treat an unconfirmed write as evidence',async result=>expect(await recordJourneyEvidence({rpc:async()=>result},grant,{latitude:53,longitude:-2,accuracy:8,time:now},true,now)).toBe('unavailable'));
  it('does not propagate connection failures to the map',async()=>expect(await recordJourneyEvidence({rpc:async()=>{throw Error('connection');}},grant,{latitude:53,longitude:-2,accuracy:8,time:now},true,now)).toBe('unavailable'));
});
async function post(path:string,payload:unknown,token?:string,session=false){
  const app=express();app.use(express.json());app.use('/journey',journeyRoutes);const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try{
    const port=(server.address() as any).port;
    const response=await fetch(`http://127.0.0.1:${port}/journey/${grant.jobId}/${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?session?{Authorization:'Bearer '+token}:{'X-Movabi-Journey-Token':token}:{})},body:JSON.stringify(payload)});
    return {status:response.status,body:await response.json()};
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
describe('actual signed journey route with evidence',()=>{
  beforeEach(()=>{
    vi.stubEnv('MOVABI_JOURNEY_TOKEN_SECRET','test-only-secret');vi.stubEnv('VAYDU_JOURNEY_EVIDENCE_V23','true');
    state.job={id:grant.jobId,driver_id:grant.driverId,tenant_id:grant.tenantId,status:'in_progress'};
    state.existing={id:'existing',updated_at:new Date(Date.now()-10000).toISOString()};state.writes=0;state.rpc.mockReset().mockResolvedValue({data:'recorded',error:null});
  });
  const token=()=>issueJourneyGrant({...grant,expires:Date.now()+3600000},'test-only-secret');
  it('does not record evidence without a signed journey grant',async()=>{expect((await post('location',body())).status).toBe(401);expect(state.rpc).not.toHaveBeenCalled();expect(state.writes).toBe(0);});
  it('rejects a forged grant',async()=>{expect((await post('location',body(),issueJourneyGrant({...grant,expires:Date.now()+3600000},'wrong-secret'))).status).toBe(401);expect(state.rpc).not.toHaveBeenCalled();});
  it('rejects a grant scoped to another booking',async()=>{expect((await post('location',body(),issueJourneyGrant({...grant,jobId:'44444444-4444-4444-8444-444444444444',expires:Date.now()+3600000},'test-only-secret'))).status).toBe(401);expect(state.rpc).not.toHaveBeenCalled();});
  it('requires a fresh point before any write',async()=>{expect((await post('location',{...body(),time:Date.now()-100000},token())).status).toBe(422);expect(state.rpc).not.toHaveBeenCalled();});
  it.each(['completed','cancelled','requires_review'])('does not record for terminal or suspended phase %s',async status=>{state.job.status=status;expect((await post('location',body(),token())).status).toBe(403);expect(state.rpc).not.toHaveBeenCalled();});
  it('rejects a changed assignment',async()=>{state.job.driver_id='44444444-4444-4444-8444-444444444444';expect((await post('location',body(),token())).status).toBe(403);expect(state.rpc).not.toHaveBeenCalled();});
  it('rejects a changed tenant',async()=>{state.job.tenant_id='44444444-4444-4444-8444-444444444444';expect((await post('location',body(),token())).status).toBe(403);expect(state.rpc).not.toHaveBeenCalled();});
  it('updates the map without evidence when collection is disabled',async()=>{vi.stubEnv('VAYDU_JOURNEY_EVIDENCE_V23','false');const result=await post('location',body(),token());expect(result).toMatchObject({status:200,body:{accepted:true,evidence:'off'}});expect(state.rpc).not.toHaveBeenCalled();expect(state.writes).toBe(1);});
  it('records a valid point without changing booking or payment state',async()=>{expect(await post('location',body(),token())).toMatchObject({status:200,body:{accepted:true,evidence:'recorded'}});expect(state.rpc).toHaveBeenCalledTimes(1);expect(state.job.status).toBe('in_progress');expect(state.writes).toBe(1);});
  it('keeps live map updates working when the evidence migration is missing',async()=>{state.rpc.mockResolvedValue({data:null,error:{code:'PGRST202'}});expect(await post('location',body(),token())).toMatchObject({status:200,body:{accepted:true,evidence:'unavailable'}});expect(state.writes).toBe(1);});
  it('can retry evidence independently of the older-point map guard',async()=>{const point=body();state.existing.updated_at=new Date(point.time).toISOString();state.rpc.mockResolvedValue({data:'duplicate',error:null});expect(await post('location',point,token())).toMatchObject({status:200,body:{accepted:false,reason:'older_point',evidence:'duplicate'}});expect(state.rpc).toHaveBeenCalledTimes(1);expect(state.writes).toBe(0);});
  it('still issues a session only for an authenticated assigned driver',async()=>{expect((await post('session',{},'invalid',true)).status).toBe(401);expect((await post('session',{},'valid',true)).status).toBe(200);expect(state.rpc).not.toHaveBeenCalled();});
});
