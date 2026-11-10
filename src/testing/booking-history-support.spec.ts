import {beforeEach,describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({job:null as any,receipt:null as any,readFailure:false,rating:null as any,readCalls:[] as any[]}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{from:(table:string)=>{const c:any={select(){return c;},eq(){return c;},maybeSingle:async()=>({data:table==='jobs'?state.job:table==='profiles'?{full_name:'Driver One'}:state.rating,error:null})};return c;}}}));
vi.mock('../../server/services/stripe.service',()=>({stripe:{paymentIntents:{retrieve:async(id:string)=>{state.readCalls.push(id);if(state.readFailure)throw Error('offline');return state.receipt;}}}}));
import {assertBookingParticipant,BookingHistoryService} from '../../server/services/booking-history.service';
import {validateSupportInput,resolveSupportRecipients} from '../../server/services/booking-support.service';
import {historyPaymentSummary,formatHistoryMoney,historyStatusLabel} from '../app/shared/utils/booking-history-presentation';
const jobId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',requestId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const job=()=>({id:jobId,customer_id:'customer',driver_id:'driver',tenant_id:'tenant',status:'completed',currency_code:'GBP',payment_status:'paid',payment_intent_id:'pi_job',agreed_fare:6.04,total_price:6.71,pickup_address:'Collection address',dropoff_address:'Delivery address',service_type:{slug:'delivery',name:'Deliver'},fare_breakdown:{customerCharge:6.04,platformFeeAmount:.29,driverEntitlement:4.89,driverCommissionAmount:.86},metadata:{completion_pin:'1234'},secret:'do not expose',stripe_transfer_status:'transferred'});
describe('persistent participant booking record',()=>{
 beforeEach(()=>{state.job=job();state.receipt={status:'succeeded',currency:'gbp',amount_received:604,metadata:{jobId}};state.readFailure=false;state.rating={score:4,comment:'Good service'};state.readCalls=[];});
 it('returns recorded journey and actual capture without repricing or exposing secrets',async()=>{const r=await BookingHistoryService.load(jobId,'customer');expect(r).toMatchObject({serviceFare:6.04,pickupAddress:'Collection address',receipt:{verified:true,amount:6.04},rating:{score:4}});expect(JSON.stringify(r)).not.toContain('completion_pin');expect(JSON.stringify(r)).not.toContain('do not expose');expect(r.driverEarnings).toBeNull();});
 it('shows the driver only their frozen earnings and transfer status',async()=>{expect(await BookingHistoryService.load(jobId,'driver')).toMatchObject({viewer:'driver',driverEarnings:4.89,driverCommission:.86,transferStatus:'transferred',canRate:false,canReportLostItem:false});});
 it('does not invent a receipt when Stripe is unavailable',async()=>{state.readFailure=true;const r=await BookingHistoryService.load(jobId,'customer');expect(r.receipt.amount).toBeNull();expect(historyPaymentSummary(r).label).toBe('Payment recorded');});
 it('rejects receipt evidence from another booking',async()=>{state.receipt.metadata.jobId='other';expect((await BookingHistoryService.load(jobId,'customer')).receipt.verified).toBe(false);});
 it('rejects another account before reading payment data',async()=>{await expect(BookingHistoryService.load(jobId,'stranger')).rejects.toThrow('participants');expect(state.readCalls).toHaveLength(0);});
 it('does not grant the previous driver access after reassignment',()=>{expect(()=>assertBookingParticipant({...job(),accepted_driver_id:'old-driver'},'old-driver')).toThrow('participants');});
 it('allows accepted driver fallback only when driver_id is absent',()=>{expect(assertBookingParticipant({...job(),driver_id:null,accepted_driver_id:'driver'},'driver')).toBe('driver');});
 it.each(['cancelled','failed','expired','no_driver_found','settled'])('keeps %s records accessible',async status=>{state.job.status=status;const r=await BookingHistoryService.load(jobId,'customer');expect(r.terminal).toBe(true);expect(r.canRate).toBe(status==='settled');});
 it('does not label authorization as paid',async()=>{state.receipt={status:'requires_capture',currency:'gbp',metadata:{jobId}};state.job.payment_status='authorized';expect(historyPaymentSummary(await BookingHistoryService.load(jobId,'customer'))).toMatchObject({label:'Authorized',amount:null});});
});
describe('truthful history money outcomes',()=>{
 it.each(['pending','failed','wallet_funded','requires_refund','refunded'])('does not invent a paid amount for %s',paymentStatus=>expect(historyPaymentSummary({paymentStatus}).amount).toBeNull());
 it('distinguishes partial refunds',()=>expect(historyPaymentSummary({paymentStatus:'paid',refundedMinor:100}).label).toBe('Partially refunded'));
 it('formats booking currency independently',()=>{expect(formatHistoryMoney(6.04,'GBP')).toBe('£6.04');expect(formatHistoryMoney(100,'JPY')).toContain('100');expect(formatHistoryMoney(null,'GBP')).toBe('Not available');});
 it('keeps cancellation distinct from completion',()=>expect(historyStatusLabel('cancelled')).toBe('Cancelled'));
});
describe('support validation and server-owned routing',()=>{
 beforeEach(()=>vi.unstubAllEnvs());
 it('accepts valid in-app messages',()=>expect(validateSupportInput({jobId,requestId,category:'help',message:'  Help please  '})).toMatchObject({jobId,message:'Help please'}));
 it.each([{jobId:'invalid'}, {requestId:'invalid'}, {category:'admin@example.com'}, {message:'a'}, {message:'x'.repeat(2001)}])('rejects invalid support input %j',bad=>expect(()=>validateSupportInput({jobId,requestId,category:'help',message:'Help please',...bad})).toThrow('required'));
 it('routes to the configured tenant and market',()=>{vi.stubEnv('SUPPORT_MARKET_EMAILS',JSON.stringify({'tenant:GB:bolton':'local@example.com','tenant:GB':'country@example.com'}));vi.stubEnv('SUPPORT_ADMIN_EMAILS','global@example.com');expect(resolveSupportRecipients('tenant','gb','Bolton')).toEqual(['local@example.com']);});
 it('supports other countries',()=>{vi.stubEnv('SUPPORT_ADMIN_EMAILS_NG','nigeria@example.com');expect(resolveSupportRecipients('tenant','NG','Lagos')).toEqual(['nigeria@example.com']);});
 it('deduplicates recipients and rejects header injection',()=>{vi.stubEnv('SUPPORT_ADMIN_EMAILS','a@example.com,A@example.com,bad\nBcc:x@example.com');expect(resolveSupportRecipients(null,null,null)).toEqual(['a@example.com']);});
});
