import { beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({session:{status:'fare_agreed',active_driver_id:'driver',agreed_fare:9} as any,error:null as any,offers:[] as any[]}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{from:(table:string)=>{
 const chain:any={select(){return this;},eq(){return this;},maybeSingle:async()=>table==='marketplace_negotiation_sessions'?{data:state.session,error:state.error}:table==='errand_funding'?{data:{item_budget:10}}:{data:{estimated_budget:10}},then(resolve:any){return Promise.resolve({data:state.offers}).then(resolve);}};return chain;
}}}));
import { PaymentAuthorityService } from '../../server/services/payment-authority.service';
const job={id:'job',driver_id:'driver',agreed_fare:9,total_price:9.39,service_slug:'errand',currency_code:'GBP',payment_status:'authorized'};
describe('agreed fare after payment and assignment',()=>{
 beforeEach(()=>{state.session={status:'fare_agreed',active_driver_id:'driver',agreed_fare:9};state.error=null;state.offers=[];});
 it.each(['assigned','accepted','arrived_at_store','shopping_in_progress','collected','en_route_to_customer','delivered','completed'])('keeps GBP19 authoritative at %s',async(status)=>{expect(await PaymentAuthorityService.resolve({...job,status})).toMatchObject({serviceFareMajor:9,itemBudgetMajor:10,totalAuthorisationMajor:19});});
 it('fails closed for an unverified agreed fare',async()=>{state.session=null;await expect(PaymentAuthorityService.resolve({...job,status:'accepted'})).rejects.toThrow('reconciliation');});
 it('rejects a different negotiated driver',async()=>{state.session.active_driver_id='other';await expect(PaymentAuthorityService.resolve({...job,status:'accepted'})).rejects.toThrow('reconciliation');});
 it('rejects a different persisted agreement amount',async()=>{state.session.agreed_fare=8;await expect(PaymentAuthorityService.resolve({...job,status:'accepted'})).rejects.toThrow('reconciliation');});
 it('fails closed when agreement lookup fails',async()=>{state.error={message:'offline'};await expect(PaymentAuthorityService.resolve({...job,status:'accepted'})).rejects.toThrow('verified');});
 it('supports a matching accepted legacy offer',async()=>{state.session=null;state.offers=[{driver_id:'driver',amount:9,status:'accepted'}];expect((await PaymentAuthorityService.resolve({...job,status:'accepted'})).totalAuthorisationMajor).toBe(19);});
 it('keeps an unnegotiated original quote',async()=>{expect((await PaymentAuthorityService.resolve({...job,agreed_fare:null,status:'accepted'})).totalAuthorisationMajor).toBe(19.39);});
});
