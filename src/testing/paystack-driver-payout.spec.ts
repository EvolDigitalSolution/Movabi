import {describe,it,expect,vi} from 'vitest';
import {PaystackDriverPayout} from '../../server/services/payments/paystack-driver-payout';

const KEY='sk_test_abc123';
const FP='synthetic-fingerprint-key-at-least-32-chars';
const BANKS={status:true,message:'Banks retrieved',data:[{name:'Access Bank',code:'044',active:true},{name:'Deleted Bank',code:'999',active:true,is_deleted:true}]};
const RESOLVED={status:true,message:'Account number resolved',data:{account_number:'0123456789',account_name:'Synthetic Driver'}};
const RECIPIENT={status:true,message:'Transfer recipient created',data:{recipient_code:'RCP_abc12345',details:{account_number:'0123456789',bank_code:'044'}}};
const responses=(...bodies:any[])=>{
 const calls:RequestInit[]=[];
 const request=vi.fn(async(_url:string,init?:RequestInit)=>{calls.push(init||{});const b=bodies.shift()||{};return {ok:(b.http??200)<300,status:b.http??200,json:async()=>b} as any});
 return {request,calls};
};
const make=(request:any)=>new PaystackDriverPayout(KEY,FP,request);
describe('paystack driver payout adapter',()=>{
 it('rejects malformed keys',()=>{
  expect(()=>new PaystackDriverPayout('FLWSECK_TEST-x',FP)).toThrow();
  expect(()=>new PaystackDriverPayout(KEY,'short')).toThrow();
 });
 it('lists filtered bank codes',async()=>{
  const {request}=responses(BANKS);const b=await make(request).banks();
  expect(b).toEqual([{code:'044',name:'Access Bank'}]);
 });
 it('resolves account names through the bank endpoint',async()=>{
  const {request}=responses(BANKS,RESOLVED);
  expect(await make(request).resolve('044','0123456789')).toBe('Synthetic Driver');
 });
 it('rejects unlisted banks and malformed inputs',async()=>{
  const {request}=responses(BANKS);
  await expect(make(request).resolve('999','0123456789')).rejects.toThrow('not available');
  await expect(make(request).resolve('044','123')).rejects.toThrow('ten-digit');
 });
 it('creates recipient and verifies via read-back',async()=>{
  const {request,calls}=responses(BANKS,RESOLVED,RECIPIENT,RECIPIENT);
  const b=await make(request).createBeneficiary('044','0123456789');
  expect(b.id).toBe('RCP_abc12345');expect(b.bank_code).toBe('044');expect(b.last4).toBe('6789');
  expect(b.fingerprint).toHaveLength(64);
  const post=calls[2];expect(String(post.body)).toContain('"type":"nuban"');expect(String(post.body)).not.toContain('transfer');
 });
 it('keeps the resolved name when provider returns a different echo',async()=>{
  const echo={...RECIPIENT,data:{...RECIPIENT.data,details:{...RECIPIENT.data.details,account_name:'Other Name'}}};
  const {request}=responses(BANKS,RESOLVED,echo,echo);
  const b=await make(request).createBeneficiary('044','0123456789','Synthetic Driver');
  expect(b.id).toBe('RCP_abc12345');
 });
 it('refuses a confirmed name that differs after re-resolution',async()=>{
  const {request}=responses(BANKS,RESOLVED);
  await expect(make(request).createBeneficiary('044','0123456789','Changed Name')).rejects.toThrow('name changed');
 });
 it('converts upstream rejection and timeout to unavailable',async()=>{
  const {request}=responses({http:400,status:false,message:'error'});
  await expect(make(request).banks()).rejects.toThrow('unavailable');
  const timeout=vi.fn(async()=>{throw Object.assign(new Error('t'),{name:'TimeoutError'})});
  await expect(make(timeout).banks()).rejects.toThrow('unavailable');
 });
 it('keeps transfers disabled even for a valid beneficiary',async()=>{
  await expect(make(vi.fn()).submit()).rejects.toThrow('transfers are disabled');
  const enabled=new PaystackDriverPayout(KEY,FP,vi.fn(),undefined,true);
  await expect(enabled.submit()).rejects.toThrow('transfers are disabled');
 });
 it('rejects read-back when stored identity does not match',async()=>{
  const {request}=responses(BANKS,RESOLVED,RECIPIENT,{status:true,data:{recipient_code:'RCP_abc12345',details:{account_number:'9999999999',bank_code:'044'}}});
  await expect(make(request).createBeneficiary('044','0123456789')).rejects.toThrow('unavailable');
 });
});

import {payoutMarketReady} from '../../server/services/payments/flutterwave-driver-payout';
import {sandboxDestinationProvider,sandboxPaystackProvider} from '../../server/services/driver-payment-account.service';
import {FlutterwaveDriverPayout} from '../../server/services/payments/flutterwave-driver-payout';

const market=(provider:string)=>({country_code:'NG',currency_code:'NGN',provider,merchant_account_ref:'m1',enabled:true,merchant_approved:true,adapter_ready:true,capability_verified_at:'t',capability_evidence_ref:'e',merchant_mode:'test'});
describe('provider selection',()=>{
 it('accepts both configured NG payout providers',()=>{
  expect(payoutMarketReady(market('flutterwave'))).toBe(true);
  expect(payoutMarketReady(market('paystack'))).toBe(true);
  expect(payoutMarketReady(market('kora'))).toBe(false);
 });
 it('dispatches to the matching merchant binding',()=>{
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('VAYDU_DEPLOYMENT_ENV','develop');
  vi.stubEnv('VAYDU_DRIVER_PAYOUT_SANDBOX','true');vi.stubEnv('SUPABASE_URL','http://movabi-develop-kong:8000');
  vi.stubEnv('FLUTTERWAVE_PAYOUT_MERCHANT_REF','flw-merch');vi.stubEnv('FLUTTERWAVE_TEST_SECRET_KEY','FLWSECK_TEST-x');
  vi.stubEnv('FLUTTERWAVE_PAYOUT_CALLBACK_URL','https://movabi-develop.apps.evolsolution.com/api/driver-payment-account/webhook');
  vi.stubEnv('VAYDU_DRIVER_PAYOUT_CALLBACK_APPROVED','true');vi.stubEnv('FLUTTERWAVE_PAYOUT_WEBHOOK_SECRET','synthetic-separate-webhook-32-characters');
  vi.stubEnv('PAYSTACK_PAYOUT_MERCHANT_REF','ps-merch');vi.stubEnv('PAYSTACK_TEST_SECRET_KEY','sk_test_y');
  vi.stubEnv('DRIVER_PAYOUT_FINGERPRINT_KEY','synthetic-fingerprint-key-at-least-32-chars');
  expect(sandboxDestinationProvider('paystack','ps-merch')).toBeInstanceOf(PaystackDriverPayout);
  expect(sandboxDestinationProvider('flutterwave','flw-merch')).toBeInstanceOf(FlutterwaveDriverPayout);
  expect(()=>sandboxPaystackProvider('wrong-merch')).toThrow('merchant binding');
 });
});
