import {describe,it,expect,vi,afterEach} from 'vitest';
import express from 'express';
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{}}));
vi.mock('../../server/services/payout-eligibility.service',()=>({PayoutEligibilityService:{}}));
const worker=vi.hoisted(()=>({process:vi.fn(async()=>{})}));
vi.mock('../../server/services/job-payout.service',()=>({JobPayoutService:worker}));
import {driverPaymentAccountRouter} from '../../server/routes/driver-payment-account.routes';
async function http(path:string,options:RequestInit={},queued=true){
 const service:any={status:vi.fn(async()=>({provider:'flutterwave',state:'not_started',available:true})),
  setup:vi.fn(async()=>({state:'completed',last4:'6789'})),resolve:vi.fn(async()=>{throw Error('raw provider/account diagnostics');})};
 const chain:any={select:()=>chain,eq:()=>chain,maybeSingle:async()=>({data:queued?{job_id:'job'}:null})};
 const db:any={auth:{getUser:async(token:string)=>({data:{user:token==='valid'?{id:'owner-driver'}:null}})},from:()=>chain};
 const app=express();app.use(express.json());app.use(driverPaymentAccountRouter(db,service));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',()=>resolve()));
 try{
  const address=server.address() as any;const response=await fetch(`http://127.0.0.1:${address.port}${path}`,options);
  return {status:response.status,text:await response.text(),cache:response.headers.get('cache-control'),service};
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
describe('authenticated payment-account endpoints',()=>{
 it('requires a valid owner JWT',async()=>{expect((await http('/status')).status).toBe(401);expect((await http('/status',{headers:{Authorization:'Bearer invalid'}})).status).toBe(401);});
 it('binds status to the authenticated owner',async()=>{const h=await http('/status?driverId=other',{headers:{Authorization:'Bearer valid'}});expect(h.service.status).toHaveBeenCalledWith('owner-driver');expect(h.cache).toBe('no-store');});
 it('ignores a foreign driver identifier in the setup body',async()=>{const h=await http('/setup',{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify({driverId:'other',bankCode:'044',accountNumber:'0123456789',accountName:'Synthetic Driver',confirmed:true})});expect(h.status).toBe(200);expect(h.service.setup).toHaveBeenCalledWith('owner-driver',expect.objectContaining({bankCode:'044',accountNumber:'0123456789',confirmedName:'Synthetic Driver',accountType:'bank'}));expect(h.text).not.toContain('0123456789');});
 it('requires confirmation',async()=>{const h=await http('/setup',{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:'{}'});expect(h.status).toBe(409);expect(h.service.setup).not.toHaveBeenCalled();});
 it('never returns raw provider diagnostics',async()=>{const h=await http('/resolve',{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:'{}'});expect(h.status).toBe(409);expect(h.text).not.toContain('raw provider');});
});
function sandbox(){
 vi.stubEnv('NODE_ENV','test');vi.stubEnv('VAYDU_DEPLOYMENT_ENV','develop');vi.stubEnv('VAYDU_DRIVER_PAYOUT_SANDBOX','true');
 vi.stubEnv('SUPABASE_URL','http://movabi-develop-kong:8000');
 vi.stubEnv('FLUTTERWAVE_TEST_SECRET_KEY','FLWSECK_TEST-synthetic');vi.stubEnv('DRIVER_PAYOUT_FINGERPRINT_KEY','synthetic-key-for-hmac-at-least-32');
 vi.stubEnv('FLUTTERWAVE_PAYOUT_MERCHANT_REF','synthetic-merchant');vi.stubEnv('FLUTTERWAVE_PAYOUT_CALLBACK_URL','https://movabi-develop.apps.evolsolution.com/api/driver-payment-account/webhook');vi.stubEnv('VAYDU_DRIVER_PAYOUT_CALLBACK_APPROVED','true');
 vi.stubEnv('FLUTTERWAVE_PAYOUT_WEBHOOK_SECRET','synthetic-separate-webhook-32-characters');
}
const callback={method:'POST',headers:{'Content-Type':'application/json','verif-hash':'synthetic-separate-webhook-32-characters'},body:JSON.stringify({data:{reference:'vaydu-11111111-1111-4111-8111-111111111111_PMCK',status:'SUCCESSFUL'}})};
describe('callback hints require provider verification through the leased worker',()=>{
 it('rejects unauthenticated callbacks',async()=>expect((await http('/webhook',{method:'POST'})).status).toBe(401));
 it('does not process foreign/Stripe queue rows',async()=>{sandbox();expect((await http('/webhook',callback,false)).status).toBe(202);expect(worker.process).not.toHaveBeenCalled();});
 it('dispatches authenticated repeated hints without trusting payload status',async()=>{sandbox();await http('/webhook',callback);await http('/webhook',callback);expect(worker.process).toHaveBeenCalledTimes(2);expect(worker.process).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');});
 it('blocks webhook processing in a production runtime',async()=>{sandbox();vi.stubEnv('NODE_ENV','production');expect((await http('/webhook',callback)).status).toBe(503);expect(worker.process).not.toHaveBeenCalled();});
});
afterEach(()=>{vi.unstubAllEnvs();worker.process.mockClear();});
