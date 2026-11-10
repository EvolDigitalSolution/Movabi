import {describe,it,expect,vi} from 'vitest';
import express from 'express';
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{}}));
import {driverWalletDevelopRouter,parseWalletFile,WALLET_DRIVER as D,WALLET_TENANT as T,WALLET_RETURN} from '../../server/routes/driver-wallet-develop.routes';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',E='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const creds={VAYDU_DRIVER_TOPUP_API:'false',FLUTTERWAVE_SECRET_KEY:'FLWSECK_TEST-synthetic',FLUTTERWAVE_WEBHOOK_SECRET:'synthetic-separate-hook',FLUTTERWAVE_MERCHANT_REF:'synthetic-alias',FLUTTERWAVE_PROVIDER_ACCOUNT_ID:'17321',VAYDU_TOPUP_CALLBACK_URL:WALLET_RETURN};
const config=()=>({NODE_ENV:'production',VAYDU_DEPLOYMENT_ENV:'develop',VAYDU_DRIVER_WALLET_COHOST_DEVELOP:'true',VAYDU_DRIVER_TOPUP_API:'true',VAYDU_DRIVER_WALLET_EVIDENCE_APPROVED:'true',VAYDU_DRIVER_WALLET_FILE_OWNER_UID:'1000'});
function fixture(options:any={}){
 let submission=false,stored:any=null;const events=new Set<string>();const providerCalls:any[]=[],tables:string[]=[];
 const driver=options.driver||D,tenant=options.tenant||T;
 const attempt={id:A,owner_id:driver,tenant_id:tenant,country_code:'NG',currency_code:'NGN',payment_provider:'flutterwave',merchant_account_ref:'synthetic-alias',provider_reference:A,
  amount_minor:10000,provider_fee_minor:500,total_charge_minor:10500,provider_account_id:options.firstAccount||options.nullScope?null:'17321',fee_policy_version:'vaydu-driver-card-5pct-wallet-v1',fee_exponent:2,destination_account_purpose:'driver_cash_credit',status:'initiated'};
 const scope={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',provider:'flutterwave',merchant_account_ref:'synthetic-alias',provider_account_id:options.firstAccount||options.nullScope?null:'17321',policy_version:'vaydu-driver-card-5pct-wallet-v1',fee_passing_mode:'merchant'};
 const db:any={supabaseUrl:options.target||'http://movabi-develop-kong:8000',auth:{getUser:async token=>({data:{user:token==='owner'?{id:driver,email:'synthetic@example.test'}:null}})},
  rpc:async(fn:string)=>{let data:any=null;if(fn==='driver_card_sandbox_enabled')data=true;if(fn==='wallet_currency_minor_exponent')data=2;if(fn==='driver_cash_credit_status_v1f')data={driverId:driver,tenantId:tenant,country:'NG',currency:'NGN'};if(fn==='initiate_wallet_topup')data=A;if(fn==='claim_wallet_topup_submission'){data=!submission;submission=true;}if(fn==='confirm_wallet_topup_with_total'){events.add(A);data=E;}return {data};},
  from:(table:string)=>{tables.push(table);if(/subaccount|collection_setup|driver_payout/.test(table)||table==='market_payment_routes')throw Error('Unrelated route/subaccount/payout dependency');
   let update:any=null,insert:any=null;const chain:any={select:()=>chain,eq:()=>chain,update:(v:any)=>{update=v;return chain;},insert:(v:any)=>{insert=v;return chain;},maybeSingle:()=>chain,
    then:(resolve:any)=>{let data:any=null,error:any=null;
     if(table==='profiles')data={id:driver,tenant_id:tenant,role:'driver',registration_activated_at:'synthetic'};
     if(table==='driver_card_topup_sandbox_scopes')data=scope;
     if(table==='wallet_topup_fee_schedules')data={version:'vaydu-driver-card-5pct-wallet-v1',exponent:2,fee_basis:'wallet',fee_basis_points:500,fee_fixed_minor:0,fee_cap_minor:null,rounding:'half_up'};
     if(table==='wallet_topup_attempts')data=attempt;
     if(table==='payment_checkout_attempts'){
      if(insert){if(stored)error={code:'23505'};else stored={...insert};}
      if(update){Object.assign(stored,update);data=[{reference:A}];}else if(!insert)data=stored;
     }return Promise.resolve({data,error}).then(resolve);}};return chain;}};
 const fileCreds=options.firstAccount?{...creds,FLUTTERWAVE_PROVIDER_ACCOUNT_ID:'',VAYDU_FLUTTERWAVE_FIRST_TEST_ACCOUNT:'true'}:creds;
 const loader=vi.fn(()=>parseWalletFile(Object.entries(fileCreds).map(([k,v])=>k+'='+v).join('\n')));
 const request:any=async(url:string,init:any)=>{providerCalls.push({url,body:init.body?JSON.parse(init.body):null});
  if(url.includes('/transactions/fee'))return Response.json({status:'success',data:{currency:'NGN',charge_amount:options.extraFee?'106':'105',fee:'1.75'}});
  if(init.method==='POST')return Response.json({status:'success',data:{link:'https://checkout.flutterwave.com/synthetic'}});
  return Response.json({status:'success',data:{tx_ref:A,account_id:options.missingAccount?null:options.wrongAccount?'999':'17321',payment_type:options.wrongMethod?'bank_transfer':'card',amount:options.wrongAmount?'100':'105',charged_amount:'105',currency:'NGN',status:'successful',app_fee:'1.75',merchant_fee:'0',amount_settled:'103.25'}});
 };
 const app=express();app.use(express.json());app.use(driverWalletDevelopRouter(db,{...config(),...options.env},loader,request));
 return {app,loader,events,providerCalls,tables};
}
async function session(h:ReturnType<typeof fixture>,fn:(call:(path:string,body?:any,hook?:string)=>Promise<any>)=>Promise<void>){const s=h.app.listen(0,'127.0.0.1');await new Promise<void>(r=>s.once('listening',r));try{await fn(async(path,body,hook)=>{const r=await fetch(`http://127.0.0.1:${(s.address() as any).port}${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer owner',...(hook?{'verif-hash':hook}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json().catch(()=>null)};});}finally{await new Promise<void>(r=>s.close(()=>r()));}}
describe('co-hosted wallet-only develop scope',()=>{
 it('quotes, confirms and credits once through reload/duplicate callbacks without global routes/subaccounts',async()=>{const h=fixture();await session(h,async call=>{
  expect((await call('/availability')).body.currency).toBe('NGN');
  const q=(await call('/checkout',{amountMinor:10000,idempotencyKey:A})).body;expect(q).toMatchObject({kind:'quote',walletAmountMinor:10000,feeMinor:500,totalChargeMinor:10500});expect(h.providerCalls).toHaveLength(0);
  expect((await call('/checkout',{amountMinor:10000,idempotencyKey:A,confirmedTotalMinor:10500})).body.kind).toBe('checkout');
  const post=h.providerCalls.find(c=>c.body);expect(post.body).not.toHaveProperty('subaccounts');expect(post.body.redirect_url).toBe(WALLET_RETURN);
  expect((await call('/verify',{attemptId:A})).body.creditedEventId).toBe(E);
  for(let i=0;i<2;i++)expect((await call('/webhook',{data:{tx_ref:A,status:'forged',charged_amount:999999}},creds.FLUTTERWAVE_WEBHOOK_SECRET)).status).toBe(200);
  expect((await call('/verify',{attemptId:A})).body.creditedEventId).toBe(E);expect(h.events.size).toBe(1);
 });});
 it('rejects additional charges before the creation POST',async()=>{const h=fixture({extraFee:true});await session(h,async call=>{const r=await call('/checkout',{amountMinor:10000,idempotencyKey:A,confirmedTotalMinor:10500});expect(r.body.code).toBe('PAYMENT_CHECKOUT_TOTAL_MISMATCH');expect(h.providerCalls.every(c=>!c.body)).toBe(true);expect(h.events.size).toBe(0);});});
 it('rejects a different account result without credit',async()=>{const h=fixture({wrongAccount:true});await session(h,async call=>{await call('/checkout',{amountMinor:10000,idempotencyKey:A,confirmedTotalMinor:10500});expect((await call('/verify',{attemptId:A})).status).not.toBe(200);expect(h.events.size).toBe(0);});});
 it.each([{driver:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},{tenant:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}])('blocks another scope %j',async options=>{const h=fixture(options);await session(h,async call=>{expect((await call('/availability')).status).not.toBe(200);expect((await call('/checkout',{amountMinor:10000,idempotencyKey:A})).status).not.toBe(200);expect(h.providerCalls).toHaveLength(0);});});
 it('requires the separate webhook secret before any verification',async()=>{const h=fixture();await session(h,async call=>{expect((await call('/webhook',{data:{tx_ref:A}},'wrong')).status).toBe(401);expect(h.providerCalls).toHaveLength(0);});});
 it('disabled mode never reads the existing file',async()=>{const h=fixture({env:{VAYDU_DRIVER_TOPUP_API:'false',VAYDU_DRIVER_WALLET_EVIDENCE_APPROVED:'false'}});await session(h,async call=>{expect((await call('/availability')).status).toBe(404);expect(h.loader).not.toHaveBeenCalled();});});
 it.each([{VAYDU_DEPLOYMENT_ENV:'production'},{VAYDU_DRIVER_PAYOUT_SANDBOX:'true'},{VAYDU_DRIVER_SUBACCOUNT_SANDBOX:'true'},{FLUTTERWAVE_LIVE_SECRET_KEY:'synthetic-live'},{VAYDU_DRIVER_WALLET_EVIDENCE_APPROVED:'false'}])('rejects unsafe configuration %j',env=>expect(()=>fixture({env})).toThrow());
 it('rejects the production DB target',()=>expect(()=>fixture({target:'https://production.example'})).toThrow());
 it('has no credentials or DB fallback in the provider file parser',()=>{const text=Object.entries(creds).map(([k,v])=>k+'='+v).join('\n');expect(()=>parseWalletFile(text+'\nSUPABASE_SERVICE_ROLE_KEY=synthetic')).toThrow();expect(()=>parseWalletFile(text.replace('FLWSECK_TEST-synthetic','FLWSECK-live'))).toThrow();expect(()=>parseWalletFile(text.replace(creds.FLUTTERWAVE_WEBHOOK_SECRET,creds.FLUTTERWAVE_SECRET_KEY))).toThrow();});
});

describe('first TEST account discovery within the same wallet attempt',()=>{
 it('allows the exact driver scope without inventing an account_id and credits one event after verification',async()=>{const h=fixture({firstAccount:true});await session(h,async call=>{expect((await call('/availability')).status).toBe(200);const q=(await call('/checkout',{amountMinor:10000,idempotencyKey:A})).body;expect(q.totalChargeMinor).toBe(10500);expect(h.providerCalls).toHaveLength(0);expect((await call('/checkout',{amountMinor:10000,idempotencyKey:A,confirmedTotalMinor:10500})).body.kind).toBe('checkout');expect((await call('/verify',{attemptId:A})).body.creditedEventId).toBe(E);expect((await call('/verify',{attemptId:A})).body.creditedEventId).toBe(E);expect(h.events.size).toBe(1);});});
 it.each([{missingAccount:true},{wrongMethod:true},{wrongAmount:true}])('refuses incomplete or incorrect provider verification during discovery %j',async options=>{const h=fixture({firstAccount:true,...options});await session(h,async call=>{await call('/checkout',{amountMinor:10000,idempotencyKey:A});await call('/checkout',{amountMinor:10000,idempotencyKey:A,confirmedTotalMinor:10500});expect((await call('/verify',{attemptId:A})).status).not.toBe(200);expect(h.events.size).toBe(0);});});
 it('does not accept an unknown account without explicit TEST discovery opt-in',async()=>{const h=fixture({nullScope:true});await session(h,async call=>{expect((await call('/availability')).status).not.toBe(200);expect(h.providerCalls).toHaveLength(0);});});
 it('does not extend first-account scope to another driver',async()=>{const h=fixture({firstAccount:true,driver:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});await session(h,async call=>{expect((await call('/availability')).status).not.toBe(200);expect(h.providerCalls).toHaveLength(0);});});
});
