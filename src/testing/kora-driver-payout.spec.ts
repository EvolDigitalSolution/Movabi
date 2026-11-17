import {describe,it,expect,vi} from 'vitest';
import {KoraDriverPayout} from '../../server/services/payments/kora-driver-payout';
import type {FrozenTransfer} from '../../server/services/payments/flutterwave-driver-payout';

const KEY='sk_test_abc123';
const FP='synthetic-fingerprint-key-at-least-32-chars';
const BANKS={status:true,message:'ok',data:[{name:'Access Bank',code:'044'},{name:'Bad Bank',code:'XX1'}]};
const RESOLVED={status:true,message:'ok',data:{account_number:'0123456789',account_name:'Synthetic Driver',bank_code:'044'}};
// The real API echoes the merchant reference back in data.reference and carries
// no separate payout id (trace_id is Kora-internal only).
const TX=(status:string,extra:any={})=>({status:true,message:'ok',data:{reference:'vaydu-aaaa_PMCK',trace_id:'14530184957',status,currency:'NGN',amount:120,fee:25,...extra}});
const responses=(...bodies:any[])=>{
 const calls:RequestInit[]=[];
 const request=vi.fn(async(_url:string,init?:RequestInit)=>{calls.push(init||{});const b=bodies.shift()||{};
  return {ok:(b.http??200)<300,status:b.http??200,json:async()=>b} as any});
 return {request,calls};
};
const make=(request:any,allow=false)=>new KoraDriverPayout(KEY,FP,request,allow);
const transfer=(adapter:KoraDriverPayout):FrozenTransfer=>({reference:'vaydu-aaaa_PMCK',amountMinor:12000,currency:'NGN',
 beneficiary:{id:'0123456789',bank_code:'044',last4:'6789',fingerprint:adapter.fingerprint('044','0123456789')}});

describe('kora driver payout adapter',()=>{
 it('rejects live-shaped keys and short fingerprint keys',()=>{
  expect(()=>new KoraDriverPayout('sk_live_abc',FP)).toThrow();
  expect(()=>new KoraDriverPayout(KEY,'short')).toThrow();
 });
 it('lists NGN bank codes, filtering malformed entries',async()=>{
  const {request}=responses(BANKS);
  expect(await make(request).banks()).toEqual([{code:'044',name:'Access Bank'}]);
 });
 it('resolves the account name through the banks/resolve endpoint',async()=>{
  const {request,calls}=responses(RESOLVED);
  expect(await make(request).resolve('044','0123456789')).toBe('Synthetic Driver');
  expect(String(calls[0].body)).toContain('"account":"0123456789"');
 });
 it('rejects malformed bank and account inputs before any call',async()=>{
  await expect(make(vi.fn()).resolve('044','123')).rejects.toThrow('ten-digit');
  await expect(make(vi.fn()).resolve('x','0123456789')).rejects.toThrow();
 });
 it('binds the beneficiary to the verified account with a frozen fingerprint',async()=>{
  const {request}=responses(RESOLVED,RESOLVED);
  const b=await make(request).createBeneficiary('044','0123456789');
  expect(b.id).toBe('0123456789');expect(b.bank_code).toBe('044');expect(b.last4).toBe('6789');
  expect(b.fingerprint).toHaveLength(64);
 });
 it('refuses a confirmed name that differs on re-resolution',async()=>{
  const {request}=responses(RESOLVED);
  await expect(make(request).createBeneficiary('044','0123456789','Changed Name')).rejects.toThrow('name changed');
 });
 it('returns null when the provider has no record of the reference',async()=>{
  const {request}=responses({http:404});
  expect(await make(request).lookup(transfer(make(vi.fn())))).toBeNull();
 });
 it('maps processing to pending and success to completed with the provider id',async()=>{
  const a=make(vi.fn());const t=transfer(a);
  const {request:r1}=responses(TX('processing'));
  expect((await make(r1).lookup(t))!.state).toBe('pending');
  const {request:r2}=responses(TX('success'));
  const done=await make(r2).lookup(t);
  expect(done!.state).toBe('completed');expect(done!.id).toBe('vaydu-aaaa_PMCK');expect(done!.fee).toBe('25');
 });
 it('maps failed to failed — a definitive outcome the worker may reverse',async()=>{
  const a=make(vi.fn());const {request}=responses(TX('failed'));
  expect((await make(request).lookup(transfer(a)))!.state).toBe('failed');
 });
 it('does not trust a record that is not bound to our merchant reference',async()=>{
  const a=make(vi.fn());const {request}=responses(TX('success',{reference:'vaydu-OTHER_PMCK'}));
  expect((await make(request).lookup(transfer(a)))!.state).toBe('unknown');
 });
 it('returns no settle id when the echoed reference is foreign even if another field binds',async()=>{
  const a=make(vi.fn());const {request}=responses(TX('success',{reference:'vaydu-aaaa_PMCK',merchant_reference:'vaydu-aaaa_PMCK'}));
  const ok=await make(request).lookup(transfer(a));
  expect(ok!.id).toBe('vaydu-aaaa_PMCK');
  const {request:r2}=responses(TX('success',{reference:'KPY-D-99001',merchant_reference:'vaydu-aaaa_PMCK'}));
  const foreign=await make(r2).lookup(transfer(a));
  expect(foreign!.state).toBe('completed');expect(foreign!.id).toBeUndefined();
 });
 it('keeps transfers disabled unless the explicit flag is set',async()=>{
  await expect(make(vi.fn()).submit(transfer(make(vi.fn())))).rejects.toThrow('transfers are disabled');
 });
 it('disburses the frozen beneficiary with the merchant reference when enabled',async()=>{
  const {request,calls}=responses(RESOLVED,{status:true,data:{reference:'vaydu-aaaa_PMCK',status:'processing'}});
  const a=make(request,true);
  await a.submit(transfer(a));
  const post=calls[1];const body=JSON.parse(String(post.body));
  expect(body.reference).toBe('vaydu-aaaa_PMCK');
  expect(body.destination.bank_account).toEqual({bank:'044',account:'0123456789'});
  expect(body.destination.amount).toBe(120);
  // destination.customer is required by the Kora disburse API; the verified
  // account name from the fresh re-resolution is what we send.
  expect(body.destination.customer).toEqual({name:'Synthetic Driver'});
 });
 it('converts upstream rejection and timeout to unavailable — never definitive failure',async()=>{
  const a=make(vi.fn());const t=transfer(a);
  const {request}=responses({http:502});
  await expect(make(request,true).submit(t)).rejects.toThrow('unavailable');
  const timeout=vi.fn(async()=>{throw new Error('timeout')});
  await expect(make(timeout,true).submit(t)).rejects.toThrow('unavailable');
 });
});
