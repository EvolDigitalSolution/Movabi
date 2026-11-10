import {Router} from 'express';
import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import Stripe from 'stripe';
import {supabaseAdmin} from '../services/supabase.service';
import existing,{createDriverTopupRouter,flutterwaveAttemptStore} from './driver-wallet-topup.routes';
import {DriverWalletTopupService,type DriverTopupDb,type DriverTopupConfig} from '../services/payments/driver-wallet-topup';
import {FlutterwaveWalletCollection} from '../services/payments/flutterwave-wallet-collection';
import {StripeDriverTopupSandbox} from '../services/payments/stripe-driver-topup-sandbox';
export const WALLET_DRIVER='318e6be9-9164-41fa-bb0c-c5ccd3526585';
export const WALLET_TENANT='d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8';
export const WALLET_RETURN='https://movabi-develop.apps.evolsolution.com/driver-topup-return';
export const WALLET_FILE='/run/vaydu/wallet-flutterwave-test.env';
const stop=()=>new Error('Develop wallet binding rejected.');
export function parseWalletFile(text:string){
 const allowed=new Set(['VAYDU_DRIVER_TOPUP_API','FLUTTERWAVE_SECRET_KEY','FLUTTERWAVE_WEBHOOK_SECRET','FLUTTERWAVE_MERCHANT_REF','FLUTTERWAVE_PROVIDER_ACCOUNT_ID','VAYDU_TOPUP_CALLBACK_URL','FLUTTERWAVE_LIVE_SECRET_KEY','VAYDU_FLUTTERWAVE_FIRST_TEST_ACCOUNT']);
 const v:Record<string,string>={};
 for(const line of text.split(/\r?\n/)){if(!line||line.startsWith('#'))continue;const i=line.indexOf('=');const k=line.slice(0,i),value=line.slice(i+1);if(i<1||!allowed.has(k)||Object.prototype.hasOwnProperty.call(v,k)||/[\x00-\x1f\x7f]/.test(value))throw stop();v[k]=value;}
 if(!/^FLWSECK_TEST-[A-Za-z0-9_-]+$/.test(v.FLUTTERWAVE_SECRET_KEY||'')||! /^[A-Za-z0-9_-]{8,}$/.test(v.FLUTTERWAVE_WEBHOOK_SECRET||'')||v.FLUTTERWAVE_WEBHOOK_SECRET===v.FLUTTERWAVE_SECRET_KEY||! /^[A-Za-z0-9_.:-]{1,120}$/.test(v.FLUTTERWAVE_MERCHANT_REF||'')||!( /^\d{1,30}$/.test(v.FLUTTERWAVE_PROVIDER_ACCOUNT_ID||'') ? v.VAYDU_FLUTTERWAVE_FIRST_TEST_ACCOUNT!=='true' : (!v.FLUTTERWAVE_PROVIDER_ACCOUNT_ID&&v.VAYDU_FLUTTERWAVE_FIRST_TEST_ACCOUNT==='true'))|| (v.VAYDU_FLUTTERWAVE_FIRST_TEST_ACCOUNT!==undefined&&!['true','false'].includes(v.VAYDU_FLUTTERWAVE_FIRST_TEST_ACCOUNT))||v.VAYDU_TOPUP_CALLBACK_URL!==WALLET_RETURN||v.FLUTTERWAVE_LIVE_SECRET_KEY||v.VAYDU_DRIVER_TOPUP_API!=='false')throw stop();
 return Object.freeze(v);
}
export function readWalletFile(uid:number){let fd:number|undefined;try{
 if(process.platform!=='linux'||!Number.isSafeInteger(uid)||uid<0)throw stop();
 fd=openSync(WALLET_FILE,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);
 if(!s.isFile()||(s.mode&0o777)!==0o600||s.uid!==uid||s.size>16384)throw stop();
 const text=readFileSync(fd,'utf8');if(Buffer.byteLength(text)>16384)throw stop();return parseWalletFile(text);
 }catch{throw stop();}finally{if(fd!==undefined)closeSync(fd);}}

export function driverWalletDevelopRouter(db:any=supabaseAdmin,env:NodeJS.ProcessEnv=process.env,loader=readWalletFile,request:typeof fetch=fetch){
 if(env.VAYDU_DRIVER_WALLET_COHOST_DEVELOP===undefined||env.VAYDU_DRIVER_WALLET_COHOST_DEVELOP==='false')return existing();
 if(env.VAYDU_DRIVER_WALLET_COHOST_DEVELOP!=='true'||env.VAYDU_DEPLOYMENT_ENV!=='develop'||!['production','test','development'].includes(env.NODE_ENV||''))throw stop();
 if(!['http://movabi-develop-kong:8000/','https://movabi-supabase-develop.apps.evolsolution.com/'].includes(new URL(db.supabaseUrl).href))throw stop();
 for(const k of ['VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_DRIVER_PAYOUT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX','VAYDU_BOOKING_SPLIT_TIMING_APPROVED'])if(env[k]!==undefined&&env[k]!=='false')throw stop();
 if(env.FLUTTERWAVE_LIVE_SECRET_KEY||(env.FLUTTERWAVE_SECRET_KEY&&!env.FLUTTERWAVE_SECRET_KEY.startsWith('FLWSECK_TEST-')))throw stop();
 const enabled=env.VAYDU_DRIVER_TOPUP_API==='true',reconcile=env.VAYDU_DRIVER_WALLET_RECONCILE_ONLY==='true';
 if(env.VAYDU_DRIVER_WALLET_RECONCILE_ONLY!==undefined&&!['true','false'].includes(env.VAYDU_DRIVER_WALLET_RECONCILE_ONLY))throw stop();
 if(!enabled&&!reconcile){const r=Router();r.use((_q,s)=>s.status(404).json({code:'DRIVER_TOPUP_UNAVAILABLE'}));return r;}
 if(env.VAYDU_DRIVER_TOPUP_API!==undefined&&!['true','false'].includes(env.VAYDU_DRIVER_TOPUP_API))throw stop();
 const store:DriverTopupDb={authGetUser:async token=>{const r=await db.auth.getUser(token);return r.error||!r.data?.user?null:{id:r.data.user.id,email:r.data.user.email||''};},from:t=>db.from(t),rpc:async(fn,args)=>{const r=await db.rpc(fn,args);if(r.error)throw stop();return r.data;}};
 // Explicit develop-only Stripe path: provider must be declared, the configured
 // credential must be a test-mode key, no live keys may be present. Driver
 // eligibility is resolved by the CANONICAL sandbox-scope authority
 // (reviewed+enabled driver_card_topup_sandbox_scopes row, enforced in
 // market() as PAYMENT_SANDBOX_REVIEW_REQUIRED) — not a hardcoded account.
 // Market routing uses market_payment_routes + scopes + fee schedules
 // (walletScopeRouting=false); the legacy Flutterwave file/adapter is skipped.
 if(env.VAYDU_DRIVER_TOPUP_PROVIDER==='stripe'){
   if(env.VAYDU_DRIVER_WALLET_EVIDENCE_APPROVED!=='true')throw stop();
   const key=env.STRIPE_SECRET_KEY||'';
   if(!/^[sr]k_test_[A-Za-z0-9]+$/.test(key))throw stop();
   if(env.STRIPE_LIVE_SECRET_KEY||env.STRIPE_SECRET_KEY_LIVE)throw stop();
   const config:DriverTopupConfig={collectionEnabled:async()=>enabled&&!reconcile,flutterwaveSecret:()=>{throw stop();},flutterwaveWebhookSecret:()=>{throw stop();},flutterwaveMerchant:()=>{throw stop();},callbackUrl:()=>WALLET_RETURN,scopeAllowed:undefined,walletScopeRouting:false,allowFirstFlutterwaveTestAccount:false};
   const router=Router();
   router.use(createDriverTopupRouter({supabase:store,config,adapter:(provider,merchant)=>{
     if(provider!=='stripe')throw new Error('Develop wallet binding rejected.');
     return new StripeDriverTopupSandbox(new Stripe(key,{apiVersion:'2023-10-16' as any}),key,merchant,flutterwaveAttemptStore(store));
   }}));
   return router;
 }
 if(env.VAYDU_DRIVER_WALLET_EVIDENCE_APPROVED!=='true'||! /^(0|[1-9]\d*)$/.test(env.VAYDU_DRIVER_WALLET_FILE_OWNER_UID||''))throw stop();
 const c=loader(Number(env.VAYDU_DRIVER_WALLET_FILE_OWNER_UID));
 const config:DriverTopupConfig={collectionEnabled:async()=>enabled&&!reconcile,flutterwaveSecret:()=>c.FLUTTERWAVE_SECRET_KEY,flutterwaveWebhookSecret:()=>c.FLUTTERWAVE_WEBHOOK_SECRET,flutterwaveMerchant:()=>c.FLUTTERWAVE_MERCHANT_REF,callbackUrl:()=>WALLET_RETURN,scopeAllowed:(id,tenant)=>id===WALLET_DRIVER&&tenant===WALLET_TENANT,walletScopeRouting:true,allowFirstFlutterwaveTestAccount:c.VAYDU_FLUTTERWAVE_FIRST_TEST_ACCOUNT==='true'};
 const adapter=new FlutterwaveWalletCollection(c.FLUTTERWAVE_SECRET_KEY,c.FLUTTERWAVE_MERCHANT_REF,flutterwaveAttemptStore(store),c.FLUTTERWAVE_WEBHOOK_SECRET,request);
 const service=new DriverWalletTopupService(store,config,adapter);const router=Router();
 router.post('/webhook',async(q,s)=>{s.setHeader('Cache-Control','no-store');if(!adapter.authenticWebhook(q.headers['verif-hash']))return void s.sendStatus(401);
  const ref=q.body?.data?.tx_ref;if(typeof ref!=='string'||! /^[a-f0-9-]{36}$/i.test(ref))return void s.sendStatus(202);
  try{await service.verifyWebhook(ref);s.sendStatus(200);}catch{s.sendStatus(202);}});
 router.use(createDriverTopupRouter({supabase:store,config,adapter}));return router;
}
