import {it,expect} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import express from 'express';
import http from 'node:http';
import {createDriverTopupRouter,flutterwaveAttemptStore} from '../../server/routes/driver-wallet-topup.routes';
import {FlutterwaveWalletCollection} from '../../server/services/payments/flutterwave-wallet-collection';
import {StripeDriverTopupSandbox} from '../../server/services/payments/stripe-driver-topup-sandbox';
const dbName=process.env['VAYDU_DISPOSABLE_DB'];
// Only the fresh-container runner sets this. Never accepts a database URL.
it.skipIf(!dbName)('real disposable Auth -> mounted route -> PostgREST -> SQL -> provider query -> one credit',async()=>{
 if(!/^vaydu-topup-test-[a-f0-9]{8}$/.test(dbName!))throw Error('Refusing non-test target');
 const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const sql=(query:string)=>docker('exec',dbName!,'psql','-U','postgres','-d','vaydu_batch2a_test','-X','-v','ON_ERROR_STOP=1','-qAt','-c',query);
 const network=dbName+'-net', authName=dbName+'-auth', restName=dbName+'-rest';
 const secret='synthetic-disposable-jwt-secret-minimum-40-characters';
 const jwt=(role:string)=>{const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const p=Buffer.from(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');return h+'.'+p+'.'+createHmac('sha256',secret).update(h+'.'+p).digest('base64url');};
 let server:http.Server|undefined;
 try {
  docker('network','create',network); docker('network','connect',network,dbName!);
  sql(`CREATE TABLE public.profiles(id uuid PRIMARY KEY,tenant_id uuid,role text,registration_activated_at timestamptz);
   GRANT SELECT ON public.profiles,public.market_payment_routes TO service_role;
   CREATE FUNCTION public.driver_cash_credit_status_v1f(p_driver_id uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('driverId',id,'tenantId',tenant_id,'country','NG','currency','NGN') FROM public.profiles WHERE id=p_driver_id $$;
   REVOKE ALL ON FUNCTION public.driver_cash_credit_status_v1f(uuid) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION public.driver_cash_credit_status_v1f(uuid) TO service_role;
   INSERT INTO public.wallet_collection_config(key,value) VALUES('enabled','false'),('driver_card_sandbox_enabled','true'),('max_amount_minor_NGN','1000000') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
   UPDATE public.market_payment_routes SET enabled=true,merchant_approved=true,adapter_ready=true,capabilities=ARRAY['collect'] WHERE provider='flutterwave';
   INSERT INTO public.wallet_topup_fee_schedules(version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active) VALUES('vaydu-driver-card-5pct-wallet-v1','flutterwave','NG','NGN','card',2,'wallet',500,0,'half_up','synthetic',now(),true);`);
  docker('run','-d','--rm','--network',network,'--name',authName,'-p','127.0.0.1::9999',
   '-e','GOTRUE_API_HOST=0.0.0.0','-e','GOTRUE_API_PORT=9999','-e','API_EXTERNAL_URL=http://localhost:9999',
   '-e','GOTRUE_SITE_URL=http://localhost:3000','-e','GOTRUE_DB_NAMESPACE=auth','-e','GOTRUE_DB_DRIVER=postgres','-e',`GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@${dbName}:5432/vaydu_batch2a_test?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic`,
   '-e',`GOTRUE_JWT_SECRET=${secret}`,'-e','GOTRUE_JWT_AUD=authenticated','-e','GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated','-e','GOTRUE_MAILER_AUTOCONFIRM=true','-e','GOTRUE_DISABLE_SIGNUP=false','supabase/gotrue:v2.132.3');
  docker('run','-d','--rm','--network',network,'--name',restName,'-p','127.0.0.1::3000','-e',`PGRST_DB_URI=postgres://postgres:isolated-test@${dbName}:5432/vaydu_batch2a_test`,'-e','PGRST_DB_SCHEMA=public','-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,'postgrest/postgrest:v10.1.2');
  const port=(name:string,p:string)=>docker('port',name,p).split(':').at(-1);
  const authUrl='http://127.0.0.1:'+port(authName,'9999/tcp'), restUrl='http://127.0.0.1:'+port(restName,'3000/tcp');
  for(let i=0;i<40;i++){try{if((await fetch(authUrl+'/health')).ok&&(await fetch(restUrl)).ok)break;}catch{} await new Promise(r=>setTimeout(r,500));}
  const signup=await fetch(authUrl+'/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'driver@example.test',password:'synthetic-test-password-123'})});
  const user:any=await signup.json();expect(signup.status,JSON.stringify(user)+' '+(signup.ok?'':spawnSync('docker',['logs','--tail','12',authName],{encoding:'utf8'}).stderr)).toBe(200);expect(user.access_token).toBeTruthy();
  sql(`INSERT INTO public.profiles VALUES('${user.user.id}','11111111-1111-1111-1111-111111111111','driver',now());
  INSERT INTO public.driver_card_topup_sandbox_scopes(provider,method,country_code,currency_code,merchant_account_ref,provider_account_id,tenant_id,driver_id,fee_passing_mode,reviewed_by,reviewed_at,evidence_reference,policy_version,enabled) VALUES('flutterwave','card','NG','NGN','flw-ng-merchant','17321','11111111-1111-1111-1111-111111111111','${user.user.id}','merchant','synthetic',now(),'synthetic review','vaydu-driver-card-5pct-wallet-v1',true);`);
  const client=createClient(restUrl,jwt('service_role'),{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(url,init)=>fetch(String(url).replace('/rest/v1',''),init)}});
  const db={from:(table:string)=>client.from(table),authGetUser:async(token:string)=>{const r=await fetch(authUrl+'/user',{headers:{Authorization:'Bearer '+token}});return r.ok?await r.json():null;},rpc:async(fn:string,args:any)=>{const {data,error}=await client.rpc(fn,args);if(error)throw Error(error.message);return data;}};
  let posts=0; const provider=new FlutterwaveWalletCollection('FLWSECK_TEST-synthetic','flw-ng-merchant',flutterwaveAttemptStore(db),'synthetic-webhook',async(url,init)=>{
   if(init?.method==='POST'){posts++;return new Response(JSON.stringify({status:'success',data:{link:'https://checkout.flutterwave.com/test'}}));}
   if(String(url).includes('/transactions/fee'))return new Response(JSON.stringify({status:'success',data:{charge_amount:'105',currency:'NGN',fee:'1.75',merchant_fee:'0'}}));
   const reference=new URL(String(url)).searchParams.get('tx_ref');
   return new Response(JSON.stringify({status:'success',data:{tx_ref:reference,currency:'NGN',account_id:17321,payment_type:'card',amount:'105',charged_amount:'105.00',app_fee:'1.75',merchant_fee:'0',amount_settled:'103.25',status:'successful'}}));
  });
  const app=express();app.use(express.json());app.use(createDriverTopupRouter({supabase:db as any,adapter:provider,config:{collectionEnabled:async()=>true,callbackUrl:()=> 'http://localhost:3000/driver?topupReturn=1',flutterwaveSecret:()=>'',flutterwaveWebhookSecret:()=>'',flutterwaveMerchant:()=> 'flw-ng-merchant'}}));
  server=http.createServer(app);await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+(server.address() as any).port;
  const post=async(path:string,body:any,token=user.access_token)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const input={amountMinor:10000,idempotencyKey:'ffffffff-ffff-ffff-ffff-ffffffffffff'};
  expect((await post('/checkout',input,'invalid')).status).toBe(401);
  const quotes=await Promise.all([post('/checkout',input),post('/checkout',input)]);
  expect(quotes.map(q=>q.status),JSON.stringify(quotes)).toEqual([200,200]);expect(quotes[0].body.attemptId).toBe(quotes[1].body.attemptId);
  const q=quotes[0].body;expect(q.totalChargeMinor).toBe(10500);
  const submissions=await Promise.all([post('/checkout',{...input,confirmedTotalMinor:q.totalChargeMinor}),post('/checkout',{...input,confirmedTotalMinor:q.totalChargeMinor})]);
  expect(submissions.map(r=>r.status).sort(),JSON.stringify(submissions)).toEqual([200,409]);expect(posts).toBe(1);
  const confirmations=await Promise.all([post('/verify',{attemptId:q.attemptId}),post('/verify',{attemptId:q.attemptId})]);
  expect(confirmations.map(r=>r.status),JSON.stringify(confirmations)).toEqual([200,200]);expect(confirmations[0].body.creditedEventId).toBe(confirmations[1].body.creditedEventId);
  expect(sql(`SELECT count(*)||':'||sum(m.amount_minor) FROM public.wallet_movements m JOIN public.wallet_accounts a ON a.id=m.account_id WHERE a.owner_id='${user.user.id}' AND a.balance_purpose='driver_cash_credit'`)).toBe('1:10000');
  expect(sql(`SELECT count(*) FROM public.wallet_topup_provider_observations WHERE attempt_id='${q.attemptId}'`)).toBe('2');
  const otherResponse=await fetch(authUrl+'/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'other@example.test',password:'synthetic-test-password-123'})});
  const other:any=await otherResponse.json();expect(otherResponse.status).toBe(200);
  sql(`INSERT INTO public.profiles VALUES('${other.user.id}','11111111-1111-1111-1111-111111111111','driver',now());`);
  expect((await post('/verify',{attemptId:q.attemptId},other.access_token)).status).toBe(404);
  expect((await post('/checkout',{...input,owner_id:other.user.id})).status).toBe(400);
  expect((await post('/checkout',{...input,amountMinor:10001})).status).not.toBe(200);
  sql(`UPDATE public.wallet_collection_config SET value='false' WHERE key='driver_card_sandbox_enabled'`);
  expect((await post('/checkout',input)).status).toBe(409);
  // Collection shutdown must not prevent reconciliation of a paid attempt.
  expect((await post('/verify',{attemptId:q.attemptId})).body.creditedEventId).toBe(confirmations[0].body.creditedEventId);
  // A second approved card provider uses the identical fee/confirmation/ledger chain.
  const stripeSignup=await fetch(authUrl+'/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'stripe-driver@example.test',password:'synthetic-test-password-123'})});
  const stripeUser:any=await stripeSignup.json();expect(stripeSignup.status).toBe(200);
  sql(`ALTER TABLE public.profiles ADD COLUMN country_code text DEFAULT 'NG',ADD COLUMN currency_code text DEFAULT 'NGN';
   CREATE OR REPLACE FUNCTION public.driver_cash_credit_status_v1f(p_driver_id uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('driverId',id,'tenantId',tenant_id,'country',country_code,'currency',currency_code) FROM public.profiles WHERE id=p_driver_id $$;
   INSERT INTO public.profiles VALUES('${stripeUser.user.id}','11111111-1111-1111-1111-111111111111','driver',now(),'GB','GBP');
   UPDATE public.wallet_collection_config SET value='true' WHERE key='driver_card_sandbox_enabled';
   INSERT INTO public.wallet_collection_config(key,value) VALUES('max_amount_minor_GBP','1000000') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
   UPDATE public.market_payment_routes SET enabled=true,merchant_approved=true,adapter_ready=true,capabilities=ARRAY['collect'] WHERE country_code='GB' AND currency_code='GBP' AND provider='stripe';
   INSERT INTO public.wallet_topup_fee_schedules(version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active) VALUES('vaydu-driver-card-5pct-wallet-v1','stripe','GB','GBP','card',2,'wallet',500,0,'half_up','synthetic',now(),true);
   INSERT INTO public.driver_card_topup_sandbox_scopes(provider,method,country_code,currency_code,merchant_account_ref,provider_account_id,tenant_id,driver_id,fee_passing_mode,reviewed_by,reviewed_at,evidence_reference,policy_version,enabled) VALUES('stripe','card','GB','GBP','stripe-platform','acct_synthetic','11111111-1111-1111-1111-111111111111','${stripeUser.user.id}','merchant','synthetic',now(),'synthetic fixed-total checkout review','vaydu-driver-card-5pct-wallet-v1',true);`);
  let stripePosts=0,metadata:any={},stripeReference='';
  const stripeSession=()=>({id:'cs_test_synthetic',livemode:false,mode:'payment',amount_total:10500,currency:'gbp',client_reference_id:stripeReference,metadata,url:'https://checkout.stripe.com/c/pay/cs_test_synthetic',status:'complete',payment_status:'paid',payment_intent:'pi_synthetic'});
  const sdk:any={accounts:{retrieve:async()=>({id:'acct_synthetic'})},checkout:{sessions:{create:async(params:any)=>{stripePosts++;metadata=params.metadata;stripeReference=params.client_reference_id;return stripeSession();},retrieve:async()=>stripeSession()}},paymentIntents:{retrieve:async()=>({livemode:false,status:'succeeded',amount:10500,amount_received:10500,currency:'gbp',metadata,latest_charge:{amount:10500,currency:'gbp',paid:true,captured:true,refunded:false,amount_refunded:0,payment_method_details:{type:'card'},balance_transaction:{id:'txn_synthetic',currency:'gbp',fee:700,net:9800}}})}};
  const stripeAdapter=new StripeDriverTopupSandbox(sdk,'sk_test_synthetic','stripe-platform',flutterwaveAttemptStore(db));
  app.use('/stripe',createDriverTopupRouter({supabase:db as any,adapter:stripeAdapter,config:{collectionEnabled:async()=>true,callbackUrl:()=> 'http://localhost:3000/driver-topup-return',flutterwaveSecret:()=>'',flutterwaveWebhookSecret:()=>'',flutterwaveMerchant:()=>''}}));
  const stripePost=(path:string,body:any)=>post('/stripe'+path,body,stripeUser.access_token);
  const stripeQuote=await stripePost('/checkout',input);expect(stripeQuote.status,JSON.stringify(stripeQuote)).toBe(200);expect(stripeQuote.body.totalChargeMinor).toBe(10500);
  const stripeSubmissions=await Promise.all([stripePost('/checkout',{...input,confirmedTotalMinor:10500}),stripePost('/checkout',{...input,confirmedTotalMinor:10500})]);
  expect(stripeSubmissions.map(r=>r.status).sort(),JSON.stringify(stripeSubmissions)).toEqual([200,409]);expect(stripePosts).toBe(1);
  const stripeConfirmations=await Promise.all([stripePost('/verify',{attemptId:stripeQuote.body.attemptId}),stripePost('/verify',{attemptId:stripeQuote.body.attemptId})]);
  expect(stripeConfirmations.map(r=>r.status),JSON.stringify(stripeConfirmations)).toEqual([200,200]);
  expect(stripeConfirmations[0].body.creditedEventId).toBe(stripeConfirmations[1].body.creditedEventId);
  expect(sql(`SELECT count(*)||':'||sum(m.amount_minor) FROM public.wallet_movements m JOIN public.wallet_accounts a ON a.id=m.account_id WHERE a.owner_id='${stripeUser.user.id}' AND a.balance_purpose='driver_cash_credit'`)).toBe('1:10000');
  expect(sql('SELECT public.wallet_collection_enabled()')).toBe('f');
  expect(sql(`SELECT evidence->>'providerFeeApiMinor' FROM public.wallet_topup_provider_observations WHERE attempt_id='${stripeQuote.body.attemptId}'`)).toBe('700');
 } finally {
  server?.close();
  for(const name of [authName,restName]){try{docker('rm','-f',name);}catch{}}
  try{docker('network','disconnect',network,dbName!);docker('network','rm',network);}catch{}
 }
},120000);
