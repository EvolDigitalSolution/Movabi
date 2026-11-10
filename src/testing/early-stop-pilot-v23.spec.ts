import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import express from 'express';
import {executeStopPilot,parseStopRequest,parseStopResponse,stopError} from '../../server/services/early-stop-pilot.service';
import earlyStopRoutes from '../../server/routes/early-stop.routes';
const state=vi.hoisted(()=>({rpc:vi.fn(),actor:'customer-user',authError:false}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{auth:{getUser:async(token:string)=>({data:{user:token==='valid'&&!state.authError?{id:state.actor}:null},error:token==='valid'&&!state.authError?null:{}})},rpc:(...args:any[])=>state.rpc(...args)}}));
const jobId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222';
const view=()=>({enabled:true,viewer:'customer',canRequest:true,canRespond:false,request:null,bookingUpdated:false,fareUpdated:false});
afterEach(()=>vi.unstubAllEnvs());
describe('early-stop input authority',()=>{
  it('accepts a reason and optional note only',()=>expect(parseStopRequest({requestId,reason:'breakdown',note:'  Vehicle stopped  '})).toEqual({requestId,reason:'breakdown',note:'Vehicle stopped'}));
  it.each(['amount','fare','currency','driverId','customerId','location','state','customerConfirmed','provider'])('rejects client-supplied %s',key=>expect(()=>parseStopRequest({requestId,reason:'breakdown',[key]:'forged'})).toThrow());
  it.each([{},null,[],{requestId:'bad',reason:'breakdown'},{requestId,reason:'unrecognised'},{requestId,reason:'safety',note:'x'.repeat(1001)}])('rejects invalid request %j',body=>expect(()=>parseStopRequest(body)).toThrow());
  it('accepts an authenticated actor response without a second actor ID',()=>expect(parseStopResponse({requestId,action:'confirm'})).toEqual({requestId,action:'confirm',note:''}));
  it('requires an explanation for a dispute',()=>{expect(()=>parseStopResponse({requestId,action:'dispute',note:'no'})).toThrow();expect(parseStopResponse({requestId,action:'dispute',note:'Please review'}).action).toBe('dispute');});
  it('cannot send a fare acceptance disguised as stop confirmation',()=>expect(()=>parseStopResponse({requestId,action:'confirm',amount:100})).toThrow());
  it('rejects text attached to a confirmation instead of ignoring it',()=>expect(()=>parseStopResponse({requestId,action:'confirm',note:'Charge 100'})).toThrow());
  it('never supplies a browser participant ID to the database',async()=>{
    const rpc=vi.fn(async()=>({data:view(),error:null}));await executeStopPilot({rpc},'session-owner',jobId,'request',{requestId,reason:'safety',note:'Help'});
    expect(rpc).toHaveBeenCalledWith('journey_stop_pilot_v23',{p_actor:'session-owner',p_job_id:jobId,p_action:'request',p_request_id:requestId,p_reason:'safety',p_note:'Help'});
  });
  it.each([{bookingUpdated:true},{fareUpdated:true},{viewer:'admin'},{enabled:false}])('rejects an unexpected settlement or identity response %j',async override=>expect(executeStopPilot({rpc:async()=>({data:{...view(),...override},error:null})},'owner',jobId,'read')).rejects.toThrow());
  it('does not expose arbitrary database messages',()=>{expect(stopError(Error('password=private'))).toEqual({status:503,error:'The stop request could not be confirmed. Refresh before retrying.',code:'STOP_UNAVAILABLE'});});
  it.each(['STOP_REQUEST_EXISTS','STOP_REQUEST_MISMATCH','STOP_BOOKING_CHANGED','STOP_REVIEW_REQUIRED','STOP_CONFIRMATION_EXPIRED'])('maps persisted conflict %s to refresh/review',code=>expect(stopError(Error(code)).status).toBe(409));
});
async function http(method:string,path:string,body?:unknown,token='valid'){
  const app=express();app.use(express.json());app.use('/stop',earlyStopRoutes);const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try{const port=(server.address() as any).port;const response=await fetch(`http://127.0.0.1:${port}/stop/${path}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
describe('early-stop real HTTP boundary',()=>{
  beforeEach(()=>{vi.stubEnv('VAYDU_EARLY_STOP_PILOT_V23','true');vi.stubEnv('NODE_ENV','test');state.actor='customer-user';state.authError=false;state.rpc.mockReset().mockResolvedValue({data:view(),error:null});});
  it('requires a session for reads and writes',async()=>{expect((await http('GET',jobId,undefined,'')).status).toBe(401);expect((await http('POST',jobId+'/request',{requestId,reason:'safety'},'')).status).toBe(401);expect(state.rpc).not.toHaveBeenCalled();});
  it('rejects invalid Supabase sessions',async()=>{state.authError=true;expect((await http('GET',jobId)).status).toBe(401);expect(state.rpc).not.toHaveBeenCalled();});
  it('is disabled by default',async()=>{vi.stubEnv('VAYDU_EARLY_STOP_PILOT_V23','');expect((await http('GET',jobId)).status).toBe(404);expect(state.rpc).not.toHaveBeenCalled();});
  it('cannot be enabled in a production runtime',async()=>{vi.stubEnv('NODE_ENV','production');expect((await http('GET',jobId)).status).toBe(404);expect(state.rpc).not.toHaveBeenCalled();});
  it('rejects invalid booking IDs before RPC',async()=>{expect((await http('GET','invalid')).status).toBe(400);expect(state.rpc).not.toHaveBeenCalled();});
  it('returns participant-only uncached status',async()=>{const result=await http('GET',jobId);expect(result.status).toBe(200);expect(result.cache).toBe('private, no-store');expect(state.rpc.mock.calls[0][1].p_actor).toBe('customer-user');});
  it('does not turn an outsider into a participant',async()=>{state.rpc.mockResolvedValue({data:null,error:{message:'STOP_NOT_PARTICIPANT'}});expect((await http('GET',jobId)).status).toBe(403);});
  it('sends the authenticated driver identity for their own response',async()=>{state.actor='driver-user';state.rpc.mockResolvedValue({data:{...view(),viewer:'driver'},error:null});expect((await http('POST',jobId+'/response',{requestId,action:'confirm'})).status).toBe(200);expect(state.rpc.mock.calls[0][1]).toMatchObject({p_actor:'driver-user',p_action:'confirm'});});
  it('rejects forged fare or another actor in requests',async()=>{for(const key of ['amount','actor','customerId','driverId'])expect((await http('POST',jobId+'/request',{requestId,reason:'breakdown',[key]:'forged'})).status).toBe(400);expect(state.rpc).not.toHaveBeenCalled();});
  it('does not report a saved request when support creation fails',async()=>{state.rpc.mockResolvedValue({data:null,error:{message:'STOP_SUPPORT_UNAVAILABLE'}});expect((await http('POST',jobId+'/request',{requestId,reason:'safety'})).status).toBe(503);});
  it('keeps expired confirmations out of success responses',async()=>{state.rpc.mockResolvedValue({data:null,error:{message:'STOP_CONFIRMATION_EXPIRED'}});expect((await http('POST',jobId+'/response',{requestId,action:'confirm'})).status).toBe(409);});
});
