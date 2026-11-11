import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import { createDriverTopupRouter, flutterwaveAttemptStore } from '../../server/routes/driver-wallet-topup.routes';
import { StripeDriverTopupSandbox } from '../../server/services/payments/stripe-driver-topup-sandbox';
import type { DriverTopupConfig, DriverTopupDb } from '../../server/services/payments/driver-wallet-topup';
import { inAppPayment, verifyOutcome } from '../app/shared/utils/driver-topup-verify-outcome';
import { driverTopupMinor, driverTopupMoney } from '../app/shared/utils/driver-topup-money';

// Regression for the develop Stripe in-app top-up: /verify returned 409
// PAYMENT_RECONCILIATION_REQUIRED for every non-succeeded PaymentIntent, and the
// UI never rendered the card form, so the journey stuck. Mocks here model the
// provider and DB; the SQL credit path is exercised separately against Postgres.
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other='dddddddd-dddd-4ddd-8ddd-dddddddddddd', tenant='11111111-1111-4111-8111-111111111111';
const attemptId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FEE_VERSION='vaydu-driver-card-5pct-wallet-v1';

function world(){
  const rows:Record<string,any[]>={
    profiles:[{id:owner,tenant_id:tenant,role:'driver',registration_activated_at:'2026-01-01'},{id:other,tenant_id:tenant,role:'driver',registration_activated_at:'2026-01-01'}],
    market_payment_routes:[{provider:'stripe',merchant_account_ref:'stripe-platform',capabilities:['collect'],country_code:'GB',currency_code:'GBP',method:'card',preferred:true,enabled:true,merchant_approved:true,adapter_ready:true}],
    wallet_topup_fee_schedules:[{version:FEE_VERSION,provider:'stripe',country_code:'GB',currency_code:'GBP',method:'card',active:true,exponent:2,fee_basis:'wallet',fee_basis_points:500,fee_fixed_minor:0,fee_cap_minor:null,rounding:'half_up'}],
    driver_card_topup_sandbox_scopes:[{id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',driver_id:owner,tenant_id:tenant,provider:'stripe',method:'card',country_code:'GB',currency_code:'GBP',merchant_account_ref:'stripe-platform',enabled:true,provider_account_id:'acct_synthetic',policy_version:FEE_VERSION,fee_passing_mode:'merchant'},
      {id:'ffffffff-ffff-4fff-8fff-ffffffffffff',driver_id:other,tenant_id:tenant,provider:'stripe',method:'card',country_code:'GB',currency_code:'GBP',merchant_account_ref:'stripe-platform',enabled:true,provider_account_id:'acct_synthetic',policy_version:FEE_VERSION,fee_passing_mode:'merchant'}],
    wallet_topup_attempts:[], payment_checkout_attempts:[],
  };
  const ledger:{attempt:string;amount:number}[]=[];const observations:any[]=[];
  let confirmFails=0;let lock=Promise.resolve();let collection=true;const market={country:'GB',currency:'GBP'};
  function qb(table:string){
    const filters:[string,unknown][]=[];let patch:any=null;let single=false;
    const run=()=>{const list=rows[table]||(rows[table]=[]);const hit=list.filter(r=>filters.every(([k,v])=>r[k]===v));
      if(patch){hit.forEach(r=>Object.assign(r,patch));return {data:hit.map(r=>({...r})),error:null};}
      if(single)return hit.length>1?{data:null,error:{message:'multiple'}}:{data:hit[0]?{...hit[0]}:null,error:null};
      return {data:hit.map(r=>({...r})),error:null};};
    const o:any={select:()=>o,eq:(k:string,v:unknown)=>{filters.push([k,v]);return o;},maybeSingle:()=>{single=true;return o;},
      update:(p:any)=>{patch=p;return o;},
      insert:async(r:any)=>{const list=rows[table]||(rows[table]=[]);if(table==='payment_checkout_attempts'&&list.some(x=>x.reference===r.reference))return {error:{code:'23505'}};list.push({...r});return {error:null};},
      then:(res:any,rej:any)=>Promise.resolve(run()).then(res,rej)};
    return o;
  }
  const db:DriverTopupDb={
    authGetUser:async t=>t==='owner-token'?{id:owner,email:'driver@example.test'}:t==='other-token'?{id:other,email:'other@example.test'}:null,
    from:qb,
    rpc:(async(fn:string,args:any)=>{
      if(fn==='driver_card_sandbox_enabled')return collection;
      if(fn==='mark_wallet_topup_failed'){const run=lock.then(async()=>{const a=rows.wallet_topup_attempts.find(x=>x.id===args.p_attempt_id);if(a.status==='credited'||a.status==='refunded')throw Error('BP008');a.status='failed';return null;});lock=run.then(()=>undefined,()=>undefined);return run;}
      if(fn==='wallet_currency_minor_exponent')return 2;
      if(fn==='driver_cash_credit_status_v1f')return {driverId:args.p_driver_id,tenantId:tenant,country:market.country,currency:market.currency};
      if(fn==='initiate_wallet_topup'){const ex=rows.wallet_topup_attempts.find(a=>a.key===args.p_attempt_key);if(ex)return ex.id;
        rows.wallet_topup_attempts.push({key:args.p_attempt_key,id:attemptId,owner_id:args.p_owner_id,tenant_id:args.p_tenant_id,country_code:'GB',currency_code:'GBP',payment_provider:'stripe',merchant_account_ref:'stripe-platform',provider_reference:null,amount_minor:args.p_amount_minor,provider_fee_minor:null,total_charge_minor:null,fee_policy_version:null,fee_exponent:2,destination_account_purpose:'driver_cash_credit',status:'initiated',provider_account_id:null,claimed:false,credited_event_id:null});return attemptId;}
      if(fn==='freeze_wallet_topup_fee'){const a=rows.wallet_topup_attempts.find(x=>x.id===args.p_attempt_id);if(!a.fee_policy_version){
        // Approved policy: 5% of the wallet amount, half-up, added on top (mirrors wallet_scheduled_fee).
        const fee=Math.floor((a.amount_minor*500+5000)/10000);Object.assign(a,{provider_fee_minor:fee,total_charge_minor:a.amount_minor+fee,fee_policy_version:FEE_VERSION,provider_account_id:'acct_synthetic'});}return null;}
      if(fn==='claim_wallet_topup_submission'){const a=rows.wallet_topup_attempts.find(x=>x.id===args.p_attempt_id);const r=!a.claimed;a.claimed=true;if(r)a.status='submitting';return r;}
      if(fn==='record_wallet_topup_provider_reference'){const a=rows.wallet_topup_attempts.find(x=>x.id===args.p_attempt_id);if(a.provider_reference&&a.provider_reference!==args.p_provider_reference)throw Error('BP002');a.provider_reference=args.p_provider_reference;if(a.status==='submitting')a.status='provider_pending';return null;}
      if(fn==='record_driver_topup_provider_observation'){
        // Mirrors the SQL contract (BP004): source must be a server query; only known string/null fields.
        const e=args.p_evidence,allowed=['source','provider','reference','currency','status','paymentMethod','providerAccountId','chargedAmountApiMinor','providerFeeApiMinor','settlementNetApiMinor','settlementCurrency','providerBalanceReference'];
        if(!['server-query','server-fee-query'].includes(e?.source)||e.provider!=='stripe'||Object.keys(e).some(k=>!allowed.includes(k)||!(typeof e[k]==='string'||e[k]===null)))throw Error('BP004 Invalid observation');
        observations.push(e);return null;}
      if(fn==='confirm_wallet_topup_with_total'){
        // Serialised per attempt like SELECT ... FOR UPDATE; idempotent replay returns the same event.
        const run=lock.then(async()=>{await new Promise(r=>setTimeout(r,2));
          if(confirmFails>0){confirmFails--;throw Error('synthetic database outage');}
          const a=rows.wallet_topup_attempts.find(x=>x.id===args.p_attempt_id);
          if(args.p_final_status!=='succeeded'||args.p_verified_provider_reference!==a.provider_reference||args.p_verified_currency!==a.currency_code||args.p_verified_total_minor!==a.total_charge_minor||args.p_verified_merchant_account_ref!==a.merchant_account_ref)throw Error('BP008');
          if(a.status==='credited')return a.credited_event_id;
          if(a.status==='failed'||a.status==='refunded')throw Error('BP008 terminal');
          ledger.push({attempt:a.id,amount:a.amount_minor});a.status='credited';a.credited_event_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';return a.credited_event_id;});
        lock=run.then(()=>undefined,()=>undefined);return run;}
      return null;
    }) as any,
  };
  // Stateful Stripe test-mode fake.
  let pi:any=null;let creates=0;let retrieves=0;const cancels:string[]=[];
  const stripe:any={accounts:{retrieve:async()=>({id:'acct_synthetic'})},
    checkout:{sessions:{list:async()=>({data:[],has_more:false}),retrieve:async()=>{throw Error('unexpected');}}},
    paymentIntents:{
      create:async(p:any)=>{creates++;pi={id:'pi_synthetic',object:'payment_intent',livemode:false,status:'requires_payment_method',last_payment_error:null,amount:p.amount,amount_received:0,currency:p.currency,client_secret:'pi_synthetic_secret_abc',metadata:p.metadata,latest_charge:null};return pi;},
      retrieve:async()=>{retrieves++;return {...pi};},search:async()=>({data:pi?[pi]:[]}),
      cancel:async(id:string,_p:any,o:any)=>{cancels.push(o?.idempotencyKey);if(id!==pi.id)throw Error('no such PI');
        if(!['requires_payment_method','requires_confirmation','requires_action','canceled'].includes(pi.status))throw Object.assign(Error('payment_intent_unexpected_state'),{type:'StripeInvalidRequestError'});
        pi={...pi,status:'canceled'};return {...pi};}}};
  const pay=(status:string,extra:any={})=>{pi={...pi,status,...extra};
    if(status==='succeeded')pi.latest_charge={id:'ch_synthetic',amount:extra.chargeAmount??pi.amount,currency:pi.currency,paid:true,captured:true,refunded:false,amount_refunded:0,payment_method_details:{type:'card'},balance_transaction:{id:'txn_synthetic',currency:pi.currency,fee:50,net:pi.amount-50}};
    if(status==='succeeded'&&pi.amount_received===0)pi.amount_received=pi.amount;};
  const config:DriverTopupConfig={collectionEnabled:async()=>true,flutterwaveSecret:()=>{throw Error('unused');},flutterwaveWebhookSecret:()=>{throw Error('unused');},flutterwaveMerchant:()=>{throw Error('unused');},callbackUrl:()=>'https://movabi-develop.apps.evolsolution.com/driver-topup-return',walletScopeRouting:false};
  const app=express();app.use(express.json());
  app.use(createDriverTopupRouter({supabase:db,config,adapter:(provider,merchant)=>{if(provider!=='stripe')throw Error('provider');return new StripeDriverTopupSandbox(stripe,'sk_test_synthetic',merchant,flutterwaveAttemptStore(db));}}));
  return {app,ledger,observations,pay,creates:()=>creates,cancels,failConfirm:(n:number)=>{confirmFails=n;},attempt:()=>rows.wallet_topup_attempts[0],
    rows,market,retrieves:()=>retrieves,
    setCollection:(v:boolean)=>{collection=v;},dropScope:()=>{rows.driver_card_topup_sandbox_scopes=rows.driver_card_topup_sandbox_scopes.filter(r=>r.driver_id!==owner);},piStatus:()=>pi.status};
}
async function call(app:express.Express,path:string,body:unknown,token='owner-token'){
  const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{const port=(server.address() as any).port;const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json().catch(()=>({})) as any};}finally{server.close();}
}
async function checkedOut(){
  const w=world();const key='99999999-9999-4999-8999-999999999999';
  const quote=await call(w.app,'/checkout',{amountMinor:10000,idempotencyKey:key});
  expect(quote.status).toBe(200);
  expect(quote.body).toMatchObject({kind:'quote',walletAmountMinor:10000,feeMinor:500,totalChargeMinor:10500,currency:'GBP',feeLabel:'Card fee (5%)'});
  const co=await call(w.app,'/checkout',{amountMinor:10000,idempotencyKey:key,confirmedTotalMinor:10500});
  expect(co.status).toBe(200);expect(co.body.clientSecret).toBe('pi_synthetic_secret_abc');expect(w.creates()).toBe(1);
  return w;
}

describe('driver top-up verification states (Stripe in-app, develop binding)',()=>{
  it('verify before payment reports PAYMENT_NOT_COMPLETED (not reconciliation) and credits nothing; resume reuses the same PaymentIntent',async()=>{
    const w=await checkedOut();
    const v=await call(w.app,'/verify',{attemptId});
    expect(v.status).toBe(409);expect(v.body.code).toBe('PAYMENT_NOT_COMPLETED');expect(w.ledger).toHaveLength(0);
    const r=await call(w.app,'/resume',{attemptId});
    expect(r.status).toBe(200);expect(r.body).toMatchObject({attemptId,clientSecret:'pi_synthetic_secret_abc'});expect(w.creates()).toBe(1);
  });
  it('successful payment credits the wallet amount (not the 5% fee) exactly once across repeats and concurrent verifies',async()=>{
    const w=await checkedOut();w.pay('succeeded');
    const first=await call(w.app,'/verify',{attemptId});
    expect(first.status).toBe(200);expect(first.body.creditedEventId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const again=await call(w.app,'/verify',{attemptId});expect(again.body.creditedEventId).toBe(first.body.creditedEventId);
    const burst=await Promise.all(Array.from({length:10},()=>call(w.app,'/verify',{attemptId})));
    for(const b of burst){expect(b.status).toBe(200);expect(b.body.creditedEventId).toBe(first.body.creditedEventId);}
    expect(w.ledger).toHaveLength(1);expect(w.ledger[0].amount).toBe(10000);
    expect(w.observations.at(-1)).toMatchObject({status:'succeeded',chargedAmountApiMinor:'10500'});
    const r=await call(w.app,'/resume',{attemptId});expect(r.status).toBe(409);expect(r.body.code).toBe('TOPUP_ALREADY_CREDITED');
  });
  it('concurrent first verifies after success credit once',async()=>{
    const w=await checkedOut();w.pay('succeeded');
    const burst=await Promise.all(Array.from({length:12},()=>call(w.app,'/verify',{attemptId})));
    expect(new Set(burst.map(b=>b.status))).toEqual(new Set([200]));
    expect(new Set(burst.map(b=>b.body.creditedEventId)).size).toBe(1);expect(w.ledger).toHaveLength(1);
  });
  it.each([
    ['processing',{},'PAYMENT_PENDING'],['requires_action',{},'PAYMENT_ACTION_REQUIRED'],['requires_confirmation',{},'PAYMENT_PENDING'],
    ['requires_payment_method',{last_payment_error:{code:'card_declined'}},'PAYMENT_FAILED'],
    ['canceled',{},'PAYMENT_CANCELLED'],['requires_capture',{},'PAYMENT_RECONCILIATION_REQUIRED'],['some_future_status',{},'PAYMENT_RECONCILIATION_REQUIRED'],
  ])('%s maps to %s without credit',async(status,extra,code)=>{
    const w=await checkedOut();w.pay(status as string,extra);
    const v=await call(w.app,'/verify',{attemptId});expect(v.status).toBe(409);expect(v.body.code).toBe(code);expect(w.ledger).toHaveLength(0);
  });
  it.each([
    ['amount',{amount:10600}],['currency',{currency:'eur'}],['short receipt',{amount_received:10000}],['live mode',{livemode:true}],
    ['other reference',{metadata:{vaydu_driver_topup:'other',vaydu_account:'acct_synthetic',vaydu_merchant:'stripe-platform',vaydu_total:'10500'}}],
  ])('a succeeded PaymentIntent with mismatched %s never credits',async(_n,extra)=>{
    const w=await checkedOut();w.pay('succeeded',extra);
    const v=await call(w.app,'/verify',{attemptId});expect(v.status).toBe(409);expect(v.body.code).toBe('PAYMENT_RECONCILIATION_REQUIRED');expect(w.ledger).toHaveLength(0);
  });
  it('another driver cannot verify or resume the transaction',async()=>{
    const w=await checkedOut();w.pay('succeeded');
    const v=await call(w.app,'/verify',{attemptId},'other-token');expect(v.status).toBe(404);expect(v.body.code).toBe('TOPUP_NOT_AVAILABLE');
    const r=await call(w.app,'/resume',{attemptId},'other-token');expect(r.status).toBe(404);
    expect(w.ledger).toHaveLength(0);
    expect((await call(w.app,'/verify',{attemptId},'bad-token')).status).toBe(401);
  });
  it('provider success with a failed ledger write reports PAYMENT_RECEIVED_CREDIT_PENDING, then credits once on retry',async()=>{
    const w=await checkedOut();w.pay('succeeded');w.failConfirm(1);
    const v=await call(w.app,'/verify',{attemptId});expect(v.status).toBe(503);expect(v.body.code).toBe('PAYMENT_RECEIVED_CREDIT_PENDING');expect(w.ledger).toHaveLength(0);
    const v2=await call(w.app,'/verify',{attemptId});expect(v2.status).toBe(200);expect(w.ledger).toHaveLength(1);
  });
  it('a pending verification does not mark the attempt failed; later success still credits once',async()=>{
    const w=await checkedOut();w.pay('processing');
    expect((await call(w.app,'/verify',{attemptId})).body.code).toBe('PAYMENT_PENDING');
    w.pay('succeeded');expect((await call(w.app,'/verify',{attemptId})).status).toBe(200);expect(w.ledger).toHaveLength(1);
  });
  it('resume enforces auth, ownership, kill switch, reviewed scope and attempt state, and never creates a payment',async()=>{
    const w=await checkedOut();
    expect((await call(w.app,'/resume',{attemptId},'bad-token')).status).toBe(401);
    const otherR=await call(w.app,'/resume',{attemptId},'other-token');expect(otherR.status).toBe(404);expect(JSON.stringify(otherR.body)).not.toContain('secret');
    expect((await call(w.app,'/resume',{attemptId,extra:1})).status).toBe(400);
    w.setCollection(false);expect((await call(w.app,'/resume',{attemptId})).body.code).toBe('COLLECTION_DISABLED');w.setCollection(true);
    // Resume is bound to the frozen attempt: without the driver's enabled reviewed scope for exactly that binding it is refused.
    w.dropScope();const noScope=await call(w.app,'/resume',{attemptId});expect(noScope.body.code).toBe('PAYMENT_RESUME_UNAVAILABLE');expect(noScope.body.clientSecret).toBeUndefined();
    expect(w.creates()).toBe(1);
  });
  it('resume refuses failed (discarded) and processing attempts',async()=>{
    const w=await checkedOut();w.pay('processing');
    expect((await call(w.app,'/resume',{attemptId})).body.code).toBe('PAYMENT_RESUME_UNAVAILABLE');
    const w2=await checkedOut();expect((await call(w2.app,'/discard',{attemptId})).status).toBe(200);
    expect((await call(w2.app,'/resume',{attemptId})).body.code).toBe('PAYMENT_RESUME_UNAVAILABLE');
  });
  it('discard cancels the unpaid PaymentIntent first, marks the attempt failed, and a later verify can never credit',async()=>{
    const w=await checkedOut();
    const d=await call(w.app,'/discard',{attemptId});expect(d.status).toBe(200);expect(d.body).toEqual({attemptId,discarded:true});
    expect(w.piStatus()).toBe('canceled');expect(w.attempt().status).toBe('failed');expect(w.cancels).toEqual(['driver-topup-cancel:'+attemptId]);
    // Stripe now refuses to take the payment, so nothing can succeed late.
    const v=await call(w.app,'/verify',{attemptId});expect(v.body.code).toBe('PAYMENT_CANCELLED');expect(w.ledger).toHaveLength(0);
    // Repeat is safe.
    expect((await call(w.app,'/discard',{attemptId})).status).toBe(200);
  });
  it('discard of a payment that already succeeded is refused (so it is verified and credited once, not lost)',async()=>{
    const w=await checkedOut();w.pay('succeeded');
    const d=await call(w.app,'/discard',{attemptId});expect(d.status).toBe(409);expect(d.body.code).toBe('PAYMENT_NOT_DISCARDABLE');
    expect(w.attempt().status).not.toBe('failed');
    expect((await call(w.app,'/verify',{attemptId})).status).toBe(200);expect(w.ledger).toHaveLength(1);
    expect((await call(w.app,'/discard',{attemptId})).body.code).toBe('TOPUP_ALREADY_CREDITED');expect(w.ledger).toHaveLength(1);
  });
  it('discard racing a payment that succeeds at Stripe first fails safely and leaves the attempt verifiable',async()=>{
    const w=await checkedOut();w.pay('processing');
    const d=await call(w.app,'/discard',{attemptId});expect(d.status).toBe(409);expect(d.body.code).toBe('PAYMENT_NOT_DISCARDABLE');
    w.pay('succeeded');expect((await call(w.app,'/verify',{attemptId})).status).toBe(200);expect(w.ledger).toHaveLength(1);
  });
  it('another driver cannot discard the transaction',async()=>{
    const w=await checkedOut();
    expect((await call(w.app,'/discard',{attemptId},'other-token')).status).toBe(404);expect(w.piStatus()).toBe('requires_payment_method');expect(w.attempt().status).toBe('provider_pending');
  });
  it('UI maps only explicit server codes; unknown/network errors are "temporarily unavailable"',()=>{
    expect(verifyOutcome('PAYMENT_PENDING')[0]).toBe('pending');
    expect(verifyOutcome('PAYMENT_ACTION_REQUIRED')[0]).toBe('action_required');
    expect(verifyOutcome('PAYMENT_NOT_COMPLETED')[0]).toBe('not_completed');
    expect(verifyOutcome('PAYMENT_FAILED')[0]).toBe('failed');
    expect(verifyOutcome('PAYMENT_CANCELLED')[0]).toBe('cancelled');
    expect(verifyOutcome('PAYMENT_RECEIVED_CREDIT_PENDING')[0]).toBe('credit_pending');
    expect(verifyOutcome('PAYMENT_RECONCILIATION_REQUIRED')[0]).toBe('review');
    expect(verifyOutcome(undefined)[0]).toBe('unavailable');expect(verifyOutcome('TOPUP_RESULT_UNCONFIRMED')[0]).toBe('unavailable');
  });
});

// Regression: a PaymentIntent waiting for 3D Secure (requires_action) was reported as
// PAYMENT_PENDING ("still processing"), so after a reload during the bank challenge the
// app offered only "Check payment status" and the payment could never be finished.
describe('3D Secure (requires_action) after a reload continues the SAME payment',()=>{
  it('reports PAYMENT_ACTION_REQUIRED, resumes the original PaymentIntent for authentication, then credits exactly once',async()=>{
    const w=await checkedOut();
    // Card submitted, bank challenge shown, page reloaded before it was completed.
    w.pay('requires_action',{next_action:{type:'use_stripe_sdk'}});
    const v=await call(w.app,'/verify',{attemptId});
    expect(v.status).toBe(409);expect(v.body.code).toBe('PAYMENT_ACTION_REQUIRED');
    expect(w.ledger).toHaveLength(0);expect(w.attempt().status).toBe('provider_pending');
    expect(verifyOutcome(v.body.code)[0]).toBe('action_required');
    // Another driver gets nothing (no secret, no state change); unauthenticated is 401.
    const foreign=await call(w.app,'/resume',{attemptId},'other-token');
    expect(foreign.status).toBe(404);expect(JSON.stringify(foreign.body)).not.toContain('pi_');
    expect((await call(w.app,'/resume',{attemptId},'bad-token')).status).toBe(401);
    // Owner resumes: same PaymentIntent secret, flagged for authentication; no new payment.
    const r=await call(w.app,'/resume',{attemptId});
    expect(r.status).toBe(200);expect(r.body).toEqual({attemptId,provider:'stripe',clientSecret:'pi_synthetic_secret_abc',nextAction:true});
    expect(inAppPayment(r.body,attemptId,'stripe')).toEqual({provider:'stripe',mode:'authenticate',clientSecret:'pi_synthetic_secret_abc'});
    expect(w.creates()).toBe(1);expect(w.piStatus()).toBe('requires_action');
    // Challenge completed on that PaymentIntent -> one credit of the wallet amount, idempotent under repeats.
    w.pay('succeeded');
    const burst=await Promise.all(Array.from({length:8},()=>call(w.app,'/verify',{attemptId})));
    for(const b of burst){expect(b.status).toBe(200);expect(b.body.creditedEventId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');}
    expect(w.ledger).toEqual([{attempt:attemptId,amount:10000}]);expect(w.creates()).toBe(1);
    expect((await call(w.app,'/resume',{attemptId})).body.code).toBe('TOPUP_ALREADY_CREDITED');
  });
  it.each([
    ['amount',{amount:10600}],['currency',{currency:'eur'}],['live mode',{livemode:true}],
    ['merchant',{metadata:{vaydu_driver_topup:attemptId,vaydu_account:'acct_synthetic',vaydu_merchant:'other-merchant',vaydu_total:'10500'}}],
  ])('a requires_action PaymentIntent with mismatched %s is neither resumed nor reported as authentication',async(_n,extra)=>{
    const w=await checkedOut();w.pay('requires_action',extra);
    const r=await call(w.app,'/resume',{attemptId});expect(r.status).toBe(409);expect(r.body.code).toBe('PAYMENT_RECONCILIATION_REQUIRED');expect(r.body.clientSecret).toBeUndefined();
    expect((await call(w.app,'/verify',{attemptId})).body.code).toBe('PAYMENT_RECONCILIATION_REQUIRED');
    expect(w.ledger).toHaveLength(0);expect(w.creates()).toBe(1);
  });
  it('failed authentication falls back to the card form on the same PaymentIntent; discard cancels it',async()=>{
    const w=await checkedOut();w.pay('requires_action');
    w.pay('requires_payment_method',{last_payment_error:{code:'payment_intent_authentication_failure'}});
    expect((await call(w.app,'/verify',{attemptId})).body.code).toBe('PAYMENT_FAILED');
    const r=await call(w.app,'/resume',{attemptId});expect(r.body.nextAction).toBe(false);
    expect(inAppPayment(r.body,attemptId,'stripe')?.mode).toBe('card');
    const w2=await checkedOut();w2.pay('requires_action');
    expect((await call(w2.app,'/discard',{attemptId})).status).toBe(200);
    expect(w2.piStatus()).toBe('canceled');expect(w2.attempt().status).toBe('failed');expect(w2.creates()).toBe(1);expect(w2.ledger).toHaveLength(0);
  });
  it('the client accepts a resume response only for its own attempt',()=>{
    expect(inAppPayment({attemptId:'other',provider:'stripe',clientSecret:'pi_x_secret_y',nextAction:true},attemptId,'stripe')).toBeNull();
    expect(inAppPayment(null,attemptId,'stripe')).toBeNull();
    expect(inAppPayment({attemptId,provider:'stripe',clientSecret:''},attemptId,'stripe')).toBeNull();
    // Cross-provider: a response for another provider is never handed to a provider UI.
    expect(inAppPayment({attemptId,provider:'kora',clientSecret:'opaque'},attemptId,'stripe')).toBeNull();
    expect(inAppPayment({attemptId,provider:'stripe',clientSecret:'pi_x_secret_y'},attemptId,'fincra')).toBeNull();
    expect(inAppPayment({attemptId,provider:'stripe',clientSecret:'pi_x_secret_y'},attemptId,undefined)).toBeNull();
    expect(inAppPayment({attemptId,clientSecret:'pi_x_secret_y'},attemptId,'stripe')).toBeNull();
    expect(inAppPayment({attemptId,provider:'stripe',clientSecret:'pi_x_secret_y'},attemptId,'stripe')?.mode).toBe('card');
  });
});

// Multi-region binding: provider, merchant, account, country and currency come from the
// server-authorised market at checkout and are FROZEN on the attempt. Resume, verify and
// discard use the attempt's binding, never the market's current configuration.
describe('market binding of an existing attempt',()=>{
  it('a later market change (route moved to another provider) neither redirects nor strands the attempt',async()=>{
    const w=await checkedOut();
    w.rows.market_payment_routes=[{provider:'kora',merchant_account_ref:'kora-gb-test',capabilities:['collect'],country_code:'GB',currency_code:'GBP',method:'card',preferred:true,enabled:true,merchant_approved:true,adapter_ready:true}];
    const r=await call(w.app,'/resume',{attemptId});
    expect(r.status).toBe(200);expect(r.body).toEqual({attemptId,provider:'stripe',clientSecret:'pi_synthetic_secret_abc',nextAction:false});
    expect(w.creates()).toBe(1);
    w.pay('succeeded');
    expect((await call(w.app,'/verify',{attemptId})).status).toBe(200);
    expect((await call(w.app,'/verify',{attemptId})).status).toBe(200);
    expect(w.ledger).toEqual([{attempt:attemptId,amount:10000}]);
  });
  it('cross-provider: an attempt frozen to another provider is never resumed through Stripe',async()=>{
    const w=await checkedOut();
    const a=w.attempt();a.payment_provider='kora';a.merchant_account_ref='kora-gb-test';
    w.rows.driver_card_topup_sandbox_scopes.push({id:'99999999-9999-4999-8999-999999999990',driver_id:a.owner_id,tenant_id:a.tenant_id,provider:'kora',method:'card',country_code:'GB',currency_code:'GBP',merchant_account_ref:'kora-gb-test',enabled:true,provider_account_id:a.provider_account_id,policy_version:a.fee_policy_version,fee_passing_mode:'merchant'});
    const before=w.retrieves();
    const r=await call(w.app,'/resume',{attemptId});
    expect(r.status).toBe(409);expect(r.body.code).toBe('PAYMENT_RESUME_UNAVAILABLE');expect(r.body.clientSecret).toBeUndefined();
    expect(w.retrieves()).toBe(before);expect(w.creates()).toBe(1);expect(w.ledger).toHaveLength(0);
  });
  it('the attempt keeps its frozen currency binding: an attempt whose currency no longer matches its reviewed scope is refused',async()=>{
    const w=await checkedOut();
    w.attempt().currency_code='EUR';
    const r=await call(w.app,'/resume',{attemptId});
    expect(r.body.code).toBe('PAYMENT_RESUME_UNAVAILABLE');expect(r.body.clientSecret).toBeUndefined();
    expect(w.ledger).toHaveLength(0);
  });
  it('another tenant cannot see or resume the attempt (market isolation)',async()=>{
    const w=await checkedOut();
    w.attempt().tenant_id='22222222-2222-4222-8222-222222222222';
    expect((await call(w.app,'/resume',{attemptId})).status).toBe(404);
    expect((await call(w.app,'/verify',{attemptId})).status).toBe(404);
    expect((await call(w.app,'/discard',{attemptId})).status).toBe(404);
    expect(w.piStatus()).toBe('requires_payment_method');
  });
  it('an unsupported market gets no quote, no attempt and no provider call',async()=>{
    const w=world();w.market.country='KE';w.market.currency='KES';
    const q=await call(w.app,'/checkout',{amountMinor:10000,idempotencyKey:'99999999-9999-4999-8999-999999999999'});
    expect(q.body.code).toBe('PAYMENT_MARKET_UNAVAILABLE');
    expect(w.rows.wallet_topup_attempts).toHaveLength(0);expect(w.creates()).toBe(0);
  });
});

describe('currency minor units (no two-decimal assumption)',()=>{
  it.each([
    ['JPY',0,'1500',1500,'JPY 1500'],['GBP',2,'12.34',1234,'GBP 12.34'],['NGN',2,'2500.50',250050,'NGN 2500.50'],['KWD',3,'1.234',1234,'KWD 1.234'],
  ])('%s with exponent %i',(currency,exponent,text,minorUnits,label)=>{
    expect(driverTopupMinor(text as string,exponent as number)).toBe(minorUnits);
    expect(driverTopupMoney(minorUnits as number,currency as string,exponent as number)).toBe(label);
  });
  it('rejects more decimal places than the currency allows',()=>{
    expect(()=>driverTopupMinor('12.345',2)).toThrow();
    expect(()=>driverTopupMinor('15.5',0)).toThrow();
  });
});

describe('legacy Checkout Session attempts (created by the earlier redirect flow)',()=>{
  const input={reference:attemptId,merchantAccountRef:'stripe-platform',providerAccountId:'acct_synthetic',currency:'GBP',exponent:2,amountMinor:10500};
  function legacy(status:'open'|'expired'|'complete'){
    let session:any={id:'cs_test_synthetic',livemode:false,mode:'payment',status,payment_status:status==='complete'?'paid':'unpaid',client_reference_id:attemptId,
      metadata:{vaydu_driver_topup:attemptId,vaydu_account:'acct_synthetic',vaydu_merchant:'stripe-platform',vaydu_total:'10500'},amount_total:10500,currency:'gbp',payment_intent:null};
    const expired:string[]=[];
    const stripe:any={accounts:{retrieve:async()=>({id:'acct_synthetic'})},checkout:{sessions:{retrieve:async()=>({...session}),list:async()=>({data:[],has_more:false}),
      expire:async(id:string)=>{expired.push(id);session={...session,status:'expired'};return {...session};}}},paymentIntents:{retrieve:async()=>{throw Error('no PI');}}};
    const store={begin:async()=>true,finish:async()=>{},observe:async()=>{},
      get:async()=>({state:'submitted',providerSessionId:'cs_test_synthetic',request:{provider:'stripe',reference:attemptId,merchantAccountRef:'stripe-platform',providerAccountId:'acct_synthetic',currency:'GBP',amountMinor:10500,exponent:2,credentialFingerprint:createHash('sha256').update('sk_test_synthetic').digest('hex')}})};
    return {adapter:new StripeDriverTopupSandbox(stripe,'sk_test_synthetic','stripe-platform',store as any),expired};
  }
  it('an open session without a PaymentIntent reports PAYMENT_NOT_COMPLETED (was a 409 reconciliation)',async()=>{
    await expect(legacy('open').adapter.verify(input)).rejects.toThrow('Payment has not been completed');
  });
  it('an expired session reports PAYMENT_CANCELLED',async()=>{
    await expect(legacy('expired').adapter.verify(input)).rejects.toThrow('Payment was cancelled');
  });
  it('discard expires an open session so it can no longer be paid',async()=>{
    const l=legacy('open');expect((await l.adapter.cancel(input)).status).toBe('canceled');expect(l.expired).toEqual(['cs_test_synthetic']);
  });
  it('discard refuses a completed session',async()=>{
    await expect(legacy('complete').adapter.cancel(input)).rejects.toThrow('verify it instead');
  });
});
