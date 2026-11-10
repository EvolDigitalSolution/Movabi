import { describe, expect, it } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createDriverTopupRouter, type DriverTopupDeps } from '../../server/routes/driver-wallet-topup.routes';
import { FlutterwaveWalletCollection } from '../../server/services/payments/flutterwave-wallet-collection';
import type { DriverTopupDb, DriverTopupConfig } from '../../server/services/payments/driver-wallet-topup';

function qb(data: unknown): any {
  const o: any = {
    then: (resolve: (v: unknown) => void) => resolve({ data, error: null }),
    maybeSingle: () => o, eq: () => o, select: () => o, neq: () => o,
  };
  return o;
}
const owner='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', tenant='11111111-1111-1111-1111-111111111111', attempt='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', event='cccccccc-cccc-cccc-cccc-cccccccccccc';
function fakeSupabase(over: Partial<DriverTopupDb> = {}): DriverTopupDb {
 let claimed=false;
 return {
  authGetUser:async token=>token==='good-token'?{id:owner,email:'driver@example.test'}:null,
  rpc:(async(fn:string)=>{
   if(fn==='driver_card_sandbox_enabled')return true;
   if(fn==='wallet_currency_minor_exponent')return 2;
   if(fn==='driver_cash_credit_status_v1f')return {driverId:owner,tenantId:tenant,country:'NG',currency:'NGN'};
   if(fn==='initiate_wallet_topup')return attempt;
   if(fn==='claim_wallet_topup_submission'){const result=!claimed;claimed=true;return result;}
   if(fn==='confirm_wallet_topup_with_total')return event;
   return null;
  }) as any,
  from:table=>qb(table==='profiles'?{id:owner,tenant_id:tenant,role:'driver',registration_activated_at:'2026-01-01'}:
   table==='market_payment_routes'?[{provider:'flutterwave',merchant_account_ref:'flw-merchant',capabilities:['collect']}]:
   table==='wallet_topup_fee_schedules'?{version:'vaydu-driver-card-5pct-wallet-v1',exponent:2,fee_basis:'wallet',fee_basis_points:500,fee_fixed_minor:0,fee_cap_minor:null,rounding:'half_up'}:
   table==='driver_card_topup_sandbox_scopes'?{id:'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',provider_account_id:'17321',policy_version:'vaydu-driver-card-5pct-wallet-v1',fee_passing_mode:'merchant'}:
   table==='wallet_topup_attempts'?{id:attempt,owner_id:owner,tenant_id:tenant,country_code:'NG',currency_code:'NGN',payment_provider:'flutterwave',merchant_account_ref:'flw-merchant',provider_reference:attempt,amount_minor:10000,provider_fee_minor:500,total_charge_minor:10500,provider_account_id:'17321',fee_policy_version:'vaydu-driver-card-5pct-wallet-v1',fee_exponent:2,destination_account_purpose:'driver_cash_credit',status:'initiated'}:null),...over
 };
}
function fakeConfig(over:Partial<DriverTopupConfig>={}):DriverTopupConfig{return {
 collectionEnabled:async()=>true,flutterwaveSecret:()=>'',flutterwaveWebhookSecret:()=>'',flutterwaveMerchant:()=> 'flw-merchant',callbackUrl:()=> 'http://localhost:3000/driver?topupReturn=1',...over
};}
function adapter(mode='success') {
 const records=new Map<string,any>();
 return new FlutterwaveWalletCollection('FLWSECK_TEST-synthetic','flw-merchant',{
  begin:async(ref,request)=>{if(records.has(ref))return false;records.set(ref,{request,state:'started'});return true;},
  finish:async(ref,state)=>{records.get(ref).state=state;},get:async ref=>records.get(ref)||null
 },'synthetic-webhook',async (_url,init)=>{
  if(init?.method==='POST'){
   if(mode==='timeout')throw Error('synthetic timeout');
   return new Response(JSON.stringify({status:'success',data:{link:'https://checkout.flutterwave.com/test'}}));
  }
  if(String(_url).includes('/transactions/fee'))return new Response(JSON.stringify({status:'success',data:{charge_amount:'105',currency:'NGN',fee:'1.75',merchant_fee:'0'}}));
  return new Response(JSON.stringify({status:'success',data:{tx_ref:mode==='wrong-reference'?'wrong':attempt,currency:mode==='wrong-currency'?'USD':'NGN',account_id:17321,payment_type:'card',amount:'105',charged_amount:mode==='wrong-total'?'100':'105.00',app_fee:'1.75',merchant_fee:'0',amount_settled:'103.25',status:'successful'}}));
 });
}
function app(deps: Partial<DriverTopupDeps> = {}) {
  const e = express();
  e.use(express.json());
  e.use(createDriverTopupRouter({ supabase: fakeSupabase(), config: fakeConfig(), adapter: adapter(), ...deps } as any));
  return e;
}
async function req(e: express.Express, method: string, path: string, body?: unknown, token?: string) {
  const server = http.createServer(e);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  server.close();
  return { status: resp.status, body: data };
}

describe('mounted driver wallet HTTP with real service and Flutterwave adapter',()=>{
 const body={amountMinor:10000,idempotencyKey:'dddddddd-dddd-dddd-dddd-dddddddddddd'};
 it('rejects missing and invalid auth',async()=>{
  expect((await req(app(),'POST','/checkout',body)).status).toBe(401);
  expect((await req(app(),'POST','/checkout',body,'invalid')).status).toBe(401);
 });
 it('returns configured exponent before entry',async()=>{expect((await req(app(),'GET','/availability',undefined,'good-token')).body).toMatchObject({currency:'NGN',exponent:2,feeLabel:'Card fee (5%)'});});
 it('quotes without submission, then checks explicit total and reconciles once',async()=>{
  const e=app();const quote=await req(e,'POST','/checkout',body,'good-token');
  expect(quote.body.kind).toBe('quote');expect(quote.body.exponent).toBe(2);
  expect((await req(e,'POST','/checkout',{...body,confirmedTotalMinor:1},'good-token')).status).toBe(409);
  expect((await req(e,'POST','/checkout',{...body,confirmedTotalMinor:10500},'good-token')).body.checkoutUrl).toBe('https://checkout.flutterwave.com/test');
  expect((await req(e,'POST','/checkout',{...body,confirmedTotalMinor:10500},'good-token')).status).toBe(409);
  expect((await req(e,'POST','/verify',{attemptId:attempt},'good-token')).body.creditedEventId).toBe(event);
  expect((await req(e,'POST','/verify',{attemptId:attempt},'good-token')).body.creditedEventId).toBe(event);
 });
 it('rejects authority overrides and disabled collection',async()=>{
  expect((await req(app(),'POST','/checkout',{...body,provider:'stripe'},'good-token')).status).toBe(400);
  expect((await req(app({config:fakeConfig({collectionEnabled:async()=>false})}),'POST','/checkout',body,'good-token')).status).toBe(409);
 });
 it.each(['timeout','wrong-reference','wrong-currency','wrong-total'])('requires reconciliation for %s',async mode=>{
  const e=app({adapter:adapter(mode)});
  await req(e,'POST','/checkout',{...body,confirmedTotalMinor:10500},'good-token');
  const verification=await req(e,'POST','/verify',{attemptId:attempt},'good-token');
  if(mode==='timeout')expect(verification.body.creditedEventId).toBe(event); // query resolves unknown submission
  else expect(verification.status).toBe(400);
 });
 it('rejects a cross-owner attempt even if a storage adapter returns it',async()=>{
  const db=fakeSupabase();const original=db.from;
  db.from=table=>table==='wallet_topup_attempts'?qb({id:attempt,owner_id:'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',tenant_id:tenant}):original(table);
  expect((await req(app({supabase:db}),'POST','/verify',{attemptId:attempt},'good-token')).status).toBe(404);
 });
});
