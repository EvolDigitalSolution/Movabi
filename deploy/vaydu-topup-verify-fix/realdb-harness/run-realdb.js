// Real-database integration: the repository's own express router + DriverWalletTopupService +
// StripeDriverTopupSandbox + flutterwaveAttemptStore, against the real PostgreSQL functions,
// grants and constraints. Only Stripe is simulated (test-mode semantics); no network calls.
require('./register');
const assert=require('node:assert/strict');
const http=require('node:http');
const crypto=require('node:crypto');
const express=require('express');
const {createDriverTopupRouter,flutterwaveAttemptStore}=require('/home/claude/vaydu/server/routes/driver-wallet-topup.routes.ts');
const {StripeDriverTopupSandbox}=require('/home/claude/vaydu/server/services/payments/stripe-driver-topup-sandbox.ts');
const {psql,qb,rpc}=require('./realdb');

const OWNER='22222222-2222-4222-8222-222222222222',OTHER='33333333-3333-4333-8333-333333333333';
// Same store semantics as the develop Stripe binding (driver-wallet-develop.routes.ts): rpc errors -> plain Error.
const store={authGetUser:async t=>t==='owner-token'?{id:OWNER,email:'driver@example.test'}:t==='other-token'?{id:OTHER,email:'other@example.test'}:null,
  from:qb,rpc:async(fn,args)=>{try{return await rpc(fn,args);}catch(e){log.push(`rpc ${fn}: ${e.message.slice(0,160)}`);throw new Error('Develop wallet binding rejected.');}}};
const log=[];
// Stripe test-mode simulator: one PaymentIntent per reference, idempotent create/cancel.
const pis=new Map();let creates=0;
const stripe={accounts:{retrieve:async()=>({id:'acct_synthetic'})},
  checkout:{sessions:{list:async()=>({data:[],has_more:false}),retrieve:async()=>{throw Error('unexpected');}}},
  paymentIntents:{
    create:async(p,o)=>{const ref=p.metadata.vaydu_driver_topup;if(pis.has(ref))return {...pis.get(ref)};creates++;
      const pi={id:'pi_'+ref.replace(/-/g,'').slice(0,20),livemode:false,status:'requires_payment_method',last_payment_error:null,amount:p.amount,amount_received:0,currency:p.currency,client_secret:'pi_'+ref.slice(0,8)+'_secret_x',metadata:p.metadata,latest_charge:null};
      assert.equal(o.idempotencyKey,'driver-topup:'+ref);pis.set(ref,pi);return {...pi};},
    retrieve:async id=>{const pi=[...pis.values()].find(p=>p.id===id);if(!pi)throw Error('No such payment_intent');return JSON.parse(JSON.stringify(pi));},
    search:async()=>({data:[]}),
    cancel:async id=>{const pi=[...pis.values()].find(p=>p.id===id);if(!['requires_payment_method','requires_confirmation','requires_action','canceled'].includes(pi.status))throw Object.assign(Error('payment_intent_unexpected_state'),{type:'StripeInvalidRequestError'});pi.status='canceled';return {...pi};}}};
function pay(ref,status,extra={}){const pi=pis.get(ref);Object.assign(pi,{status,...extra});
  if(status==='succeeded'){pi.amount_received=extra.amount_received??pi.amount;pi.latest_charge={id:'ch_x',amount:extra.chargeAmount??pi.amount,currency:pi.currency,paid:true,captured:true,refunded:false,amount_refunded:0,payment_method_details:{type:'card'},balance_transaction:{id:'txn_x',currency:pi.currency,fee:50,net:pi.amount-50}};}
  if(status==='requires_payment_method'&&extra.declined)pi.last_payment_error={code:'card_declined'};}
const config={collectionEnabled:async()=>true,flutterwaveSecret:()=>{throw Error('x');},flutterwaveWebhookSecret:()=>{throw Error('x');},flutterwaveMerchant:()=>{throw Error('x');},
  callbackUrl:()=>'https://movabi-develop.apps.evolsolution.com/driver-topup-return',scopeAllowed:undefined,walletScopeRouting:false,allowFirstFlutterwaveTestAccount:false};
const app=express();app.use(express.json());
app.use(createDriverTopupRouter({supabase:store,config,adapter:(provider,merchant)=>{if(provider!=='stripe')throw Error('provider');return new StripeDriverTopupSandbox(stripe,'sk_test_synthetic',merchant,flutterwaveAttemptStore(store));}}));
let server,port;
async function call(path,body,token='owner-token'){const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>({}))};}
const sql=async q=>{const r=await psql(q,{},null);if(r.err)throw Error(r.stderr);return r.stdout;};
const credits=async id=>Number(await sql(`select count(*) from wallet_business_events e join wallet_topup_attempts a on a.credited_event_id=e.id where a.id='${id}'`));
const movements=async id=>sql(`select string_agg(a.balance_purpose||':'||m.amount_minor,',' order by m.amount_minor desc) from wallet_movements m join wallet_accounts a on a.id=m.account_id join wallet_topup_attempts t on t.credited_event_id=m.event_id where t.id='${id}'`);
const status=async id=>sql(`select status from wallet_topup_attempts where id='${id}'`);
async function newAttempt(amount=10000){const key=crypto.randomUUID();
  const q=await call('/checkout',{amountMinor:amount,idempotencyKey:key});assert.equal(q.status,200,JSON.stringify(q.body)+log.slice(-2).join(' | '));
  const c=await call('/checkout',{amountMinor:amount,idempotencyKey:key,confirmedTotalMinor:q.body.totalChargeMinor});assert.equal(c.status,200,JSON.stringify(c.body)+log.slice(-2).join(' | '));
  return {id:q.body.attemptId,quote:q.body,checkout:c.body};}
const results=[];async function check(name,fn){try{await fn();results.push(['PASS',name]);}catch(e){results.push(['FAIL',name,e.message.split('\n')[0]]);}}

(async()=>{
  server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
  await check('availability: GB/GBP, exponent 2, approved 5% policy label',async()=>{const r=await fetch(`http://127.0.0.1:${port}/availability`,{headers:{authorization:'Bearer owner-token'}});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));assert.deepEqual(b,{currency:'GBP',exponent:2,feeLabel:'Card fee (5%)',feePolicyVersion:'vaydu-driver-card-5pct-wallet-v1'});});
  let A;
  await check('quote + checkout: fee frozen by SQL = 5% of wallet amount, half-up, added on top',async()=>{A=await newAttempt(1999);
    assert.deepEqual([A.quote.walletAmountMinor,A.quote.feeMinor,A.quote.totalChargeMinor],[1999,100,2099]);
    assert.equal(A.checkout.clientSecret.includes('_secret_'),true);assert.equal(await status(A.id),'provider_pending');});
  await check('verify before payment -> 409 PAYMENT_NOT_COMPLETED, no credit, attempt untouched',async()=>{const v=await call('/verify',{attemptId:A.id});assert.equal(v.status,409);assert.equal(v.body.code,'PAYMENT_NOT_COMPLETED');assert.equal(await credits(A.id),0);assert.equal(await status(A.id),'provider_pending');});
  await check('resume returns the SAME PaymentIntent secret; no new PaymentIntent',async()=>{const before=creates;const r=await call('/resume',{attemptId:A.id});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.clientSecret,A.checkout.clientSecret);assert.equal(creates,before);});
  await check('declined card -> PAYMENT_FAILED, no credit; retry on the same PaymentIntent succeeds',async()=>{pay(A.id,'requires_payment_method',{declined:true});const v=await call('/verify',{attemptId:A.id});assert.equal(v.body.code,'PAYMENT_FAILED');assert.equal(await credits(A.id),0);
    const r=await call('/resume',{attemptId:A.id});assert.equal(r.status,200);});
  await check('3DS in progress (requires_action) -> PAYMENT_PENDING',async()=>{pay(A.id,'requires_action');assert.equal((await call('/verify',{attemptId:A.id})).body.code,'PAYMENT_PENDING');});
  await check('another eligible driver cannot verify/resume/discard (404), no state change',async()=>{for(const p of ['/verify','/resume','/discard']){const r=await call(p,{attemptId:A.id},'other-token');assert.equal(r.status,404,p+JSON.stringify(r.body));}
    assert.equal(await status(A.id),'provider_pending');assert.equal(pis.get(A.id).status,'requires_action');});
  await check('success: 15 concurrent verifies -> exactly one SQL credit of the wallet amount (1999), fee not credited',async()=>{pay(A.id,'succeeded');
    const rs=await Promise.all(Array.from({length:15},()=>call('/verify',{attemptId:A.id})));
    const ids=new Set(rs.map(r=>r.body.creditedEventId));assert.deepEqual([...new Set(rs.map(r=>r.status))],[200],JSON.stringify(rs.map(r=>r.body)));assert.equal(ids.size,1);
    assert.equal(await credits(A.id),1);assert.equal(await movements(A.id),'driver_cash_credit:1999,platform_funding:-1999');assert.equal(await status(A.id),'credited');});
  await check('repeat verify (refresh) returns the same event; resume/discard refused after credit',async()=>{const v=await call('/verify',{attemptId:A.id});assert.equal(v.status,200);
    assert.equal((await call('/resume',{attemptId:A.id})).body.code,'TOPUP_ALREADY_CREDITED');assert.equal((await call('/discard',{attemptId:A.id})).body.code,'TOPUP_ALREADY_CREDITED');assert.equal(await credits(A.id),1);});
  await check('provider observations recorded (audit) for the credited attempt',async()=>{assert.ok(Number(await sql(`select count(*) from wallet_topup_provider_observations where attempt_id='${A.id}'`))>=3);});
  let B;
  await check('discard unpaid: Stripe PI cancelled first, attempt -> failed (terminal), verify -> CANCELLED, no credit',async()=>{B=await newAttempt(5000);const d=await call('/discard',{attemptId:B.id});assert.equal(d.status,200,JSON.stringify(d.body)+log.slice(-2).join('|'));
    assert.equal(pis.get(B.id).status,'canceled');assert.equal(await status(B.id),'failed');assert.equal((await call('/verify',{attemptId:B.id})).body.code,'PAYMENT_CANCELLED');assert.equal(await credits(B.id),0);
    assert.equal((await call('/discard',{attemptId:B.id})).status,200);assert.equal((await call('/resume',{attemptId:B.id})).body.code,'PAYMENT_RESUME_UNAVAILABLE');});
  await check('DB guard: even an (impossible) late provider success on a discarded attempt cannot credit',async()=>{pay(B.id,'succeeded');const v=await call('/verify',{attemptId:B.id});assert.equal(v.status,503);assert.equal(v.body.code,'PAYMENT_RECEIVED_CREDIT_PENDING');assert.equal(await credits(B.id),0);assert.equal(await status(B.id),'failed');});
  let C;
  await check('discard racing concurrent verifies on a paid PI: discard refused, exactly one credit',async()=>{C=await newAttempt(3000);pay(C.id,'succeeded');
    const rs=await Promise.all([call('/discard',{attemptId:C.id}),...Array.from({length:8},()=>call('/verify',{attemptId:C.id})),call('/discard',{attemptId:C.id})]);
    assert.ok(rs.filter((_,i)=>i===0||i===9).every(r=>r.status===409),JSON.stringify(rs.map(r=>r.body)));assert.equal(await credits(C.id),1);assert.equal(await status(C.id),'credited');});
  await check('amount/currency/receipt mismatches never credit (409 reconciliation)',async()=>{for(const extra of [{amount:99999},{currency:'eur'},{amount_received:1}]){const X=await newAttempt(2000);pay(X.id,'succeeded',extra);
      const v=await call('/verify',{attemptId:X.id});assert.equal(v.body.code,'PAYMENT_RECONCILIATION_REQUIRED',JSON.stringify(extra));assert.equal(await credits(X.id),0);}});
  await check('processing / cancelled map to PENDING / CANCELLED with no credit',async()=>{const X=await newAttempt(2500);pay(X.id,'processing');assert.equal((await call('/verify',{attemptId:X.id})).body.code,'PAYMENT_PENDING');
    assert.equal((await call('/discard',{attemptId:X.id})).body.code,'PAYMENT_NOT_DISCARDABLE');pay(X.id,'canceled');assert.equal((await call('/verify',{attemptId:X.id})).body.code,'PAYMENT_CANCELLED');assert.equal(await credits(X.id),0);});
  await check('checkout replay with the same idempotency key creates no second PaymentIntent',async()=>{const key=crypto.randomUUID();const q=await call('/checkout',{amountMinor:1200,idempotencyKey:key});const before=creates;
    await call('/checkout',{amountMinor:1200,idempotencyKey:key,confirmedTotalMinor:q.body.totalChargeMinor});const again=await call('/checkout',{amountMinor:1200,idempotencyKey:key,confirmedTotalMinor:q.body.totalChargeMinor});
    assert.equal(creates,before+1);assert.equal(again.status,409);});
  server.close();
  for(const r of results)console.log(r.join(' | '));
  const failed=results.filter(r=>r[0]==='FAIL').length;console.log(`\n${results.length-failed} passed, ${failed} failed`);if(failed)console.log(log.slice(-10).join('\n'));process.exit(failed?1:0);
})();
