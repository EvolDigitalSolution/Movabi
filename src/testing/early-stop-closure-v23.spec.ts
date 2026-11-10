import {describe,it,vi,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import express from 'express';
import {parseClosure,closeEarlyStop,closureError} from '../../server/services/early-stop-closure.service';
import fareRoutes from '../../server/routes/early-stop-fare.routes';
import {PaymentAuthorityService} from '../../server/services/payment-authority.service';
const state=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{rpc:(...args:any[])=>state.rpc(...args)}}));
const job='11111111-1111-4111-8111-111111111111',stop='22222222-2222-4222-8222-222222222222',proposal='33333333-3333-4333-8333-333333333333';
const view=()=>({bookingId:job,proposalId:proposal,closed:true,currency:'NGN',amountMinor:50000,paymentVerified:false,driverPayoutEnabled:false,sandbox:true});
describe('early stop closure input and response authority',()=>{
 it('accepts only an existing proposal ID',()=>assert.equal(parseClosure({proposalId:proposal}),proposal));
 for(const key of ['amount','fare','currency','distance','driverId','customerId','paymentVerified','provider','callbackUrl'])it('rejects forged '+key,()=>assert.throws(()=>parseClosure({proposalId:proposal,[key]:'forged'})));
 it('rejects a missing or invalid ID',()=>{for(const body of [null,[],{}, {proposalId:'bad'}])assert.throws(()=>parseClosure(body));});
 it('uses the authenticated actor and the exact approved proposal',async()=>{
  let received:any;const db={rpc:async(name:string,args:any)=>{received={name,args};return{data:view(),error:null};}};
  assert.deepEqual(await closeEarlyStop(db,'session-owner',job,stop,proposal),view());
  assert.deepEqual(received,{name:'close_early_stop_ngn_pilot_v23',args:{p_actor:'session-owner',p_job:job,p_stop:stop,p_proposal:proposal}});
 });
 for(const override of [{bookingId:'other'},{proposalId:'other'},{closed:false},{paymentVerified:true},{driverPayoutEnabled:true},{currency:'GBP'},{sandbox:false},{amountMinor:0},{amountMinor:1.1}])it('rejects unexpected closure result '+JSON.stringify(override),async()=>assert.rejects(closeEarlyStop({rpc:async()=>({data:{...view(),...override},error:null})},'actor',job,stop,proposal)));
 it('maps protected-margin trigger failures to review without exposing internal text',async()=>{
  await assert.rejects(closeEarlyStop({rpc:async()=>({data:null,error:{message:'Agreed fare is below the protected booking minimum'}})},'actor',job,stop,proposal),/CLOSE_REVIEW_REQUIRED/);
  assert.equal(closureError(Error('CLOSE_REVIEW_REQUIRED')).status,409);assert.equal(closureError(Error('private data')).code,'CLOSE_UNCONFIRMED');
 });
 it('keeps balanced revised terms compatible with the actual canonical payment authority',async()=>{
  const result=await PaymentAuthorityService.resolve({id:job,status:'completed',agreed_fare:null,driver_id:'driver',currency_code:'NGN',total_price:500,service_type:{slug:'ride'},fare_breakdown:{policyVersion:'fare-split-v1',currency:'NGN',customerCharge:500,platformFeeAmount:50,driverCommissionAmount:45,driverEntitlement:405}});
  assert.equal(result.totalAuthorisationMajor,500);assert.equal(result.currency,'ngn');assert.equal(result.itemBudgetMajor,0);
 });
});
afterEach(()=>vi.unstubAllEnvs());
async function http(body:unknown,actor='customer'){
 const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.stopActor=actor;next();});app.use('/fare/:jobId',fareRoutes);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 try{const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/fare/${job}/${stop}/close`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
describe('real closure HTTP boundary',()=>{
 const enable=()=>{vi.stubEnv('NODE_ENV','test');for(const flag of ['VAYDU_EARLY_STOP_PILOT_V23','VAYDU_EARLY_STOP_FARE_PILOT_V23','VAYDU_EARLY_STOP_CLOSURE_PILOT_V23'])vi.stubEnv(flag,'true');state.rpc.mockResolvedValue({data:view(),error:null});};
 it('remains off by default',async()=>{enable();vi.stubEnv('VAYDU_EARLY_STOP_CLOSURE_PILOT_V23','false');assert.equal((await http({proposalId:proposal})).status,404);});
 it('cannot run in production',async()=>{enable();vi.stubEnv('NODE_ENV','production');assert.equal((await http({proposalId:proposal})).status,404);});
 it('requires the authenticated parent actor',async()=>{enable();assert.equal((await http({proposalId:proposal},'')).status,401);});
 it('passes both merged route parameters to the RPC',async()=>{enable();assert.equal((await http({proposalId:proposal})).status,200);assert.deepEqual(state.rpc.mock.lastCall,['close_early_stop_ngn_pilot_v23',{p_actor:'customer',p_job:job,p_stop:stop,p_proposal:proposal}]);});
 it('rejects browser fare injection',async()=>{enable();assert.equal((await http({proposalId:proposal,amount:1})).status,400);});
});
