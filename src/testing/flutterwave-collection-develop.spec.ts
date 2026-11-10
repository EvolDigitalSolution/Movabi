import {describe,it,expect,vi} from 'vitest';
vi.mock('node:fs',async()=>{const real=await vi.importActual<any>('node:fs');return {...real,openSync:vi.fn(),fstatSync:vi.fn(),readFileSync:vi.fn(),closeSync:vi.fn()};});
import {openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{}}));
vi.mock('../../server/services/payout-eligibility.service',()=>({PayoutEligibilityService:{evaluateDriver:async()=>({eligible:true})}}));
vi.mock('../../server/services/job-payout.service',()=>({JobPayoutService:{process:()=>{throw Error('No transfers allowed');}}}));
import express from 'express';
import {developDriverPaymentAccountRouter} from '../../server/routes/driver-payment-account-develop.routes';
import existingAccountRoutes from '../../server/routes/driver-payment-account.routes';
import {confirmedDevelopCollectionScope,DEVELOP_COLLECTION_DRIVER as DRIVER,DEVELOP_COLLECTION_TENANT as TENANT,
 developCollectionProvider,parseDevelopCollectionFile,readDevelopCollectionFile} from '../../server/services/payments/flutterwave-collection-develop';
const credentials={FLUTTERWAVE_TEST_SECRET_KEY:'FLWSECK_TEST-synthetic',FLUTTERWAVE_LIVE_SECRET_KEY:'',FLUTTERWAVE_COLLECTION_MERCHANT_REF:'synthetic-alias',
 DRIVER_SUBACCOUNT_FINGERPRINT_KEY:'synthetic-stable-fingerprint-at-least-32',VAYDU_DRIVER_SUBACCOUNT_SANDBOX:'false',
 VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX:'false',VAYDU_BOOKING_SPLIT_TIMING_APPROVED:'false'};
const source=()=>Object.entries(credentials).map(([k,v])=>k+'='+v).join('\n');
const env=():NodeJS.ProcessEnv=>({NODE_ENV:'production',VAYDU_DEPLOYMENT_ENV:'develop',VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP:'true',VAYDU_DRIVER_SUBACCOUNT_SANDBOX:'true',
 VAYDU_DRIVER_SUBACCOUNT_MERCHANT_VERIFIED:'true',VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED:'true',VAYDU_DRIVER_SUBACCOUNT_FILE_OWNER_UID:'1000',
 VAYDU_DRIVER_PAYOUT_SANDBOX:'false',VAYDU_DRIVER_TOPUP_API:'false',VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX:'false',VAYDU_BOOKING_SPLIT_TIMING_APPROVED:'false'});
describe('co-hosted develop-only provider',()=>{
 it('preserves the existing router when not opted in without touching the injected client',()=>{const db=new Proxy({},{get(){throw Error('Client must not be accessed by disabled integration');}});expect(developDriverPaymentAccountRouter(db,{})).toBe(existingAccountRoutes);expect(developDriverPaymentAccountRouter(db,{VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP:'false'})).toBe(existingAccountRoutes);});
 it('allows production NODE_ENV on the exact develop target without mutating environment or using a DB key',()=>{const config=env(),before={...config},loader=vi.fn(()=>credentials),network=vi.fn();const provider=developCollectionProvider('http://movabi-develop-kong:8000',config,loader,network);expect(provider('synthetic-alias')).toBeDefined();expect(config).toEqual(before);expect(loader).toHaveBeenCalledWith(1000);expect(network).not.toHaveBeenCalled();expect(()=>provider('different-merchant')).toThrow();});
 it('does not read a file or require approvals while setup is disabled',()=>{const config={...env(),VAYDU_DRIVER_SUBACCOUNT_SANDBOX:'false',VAYDU_DRIVER_SUBACCOUNT_MERCHANT_VERIFIED:undefined,VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED:undefined};const loader=vi.fn();const provider=developCollectionProvider('http://movabi-develop-kong:8000',config,loader);expect(()=>provider('synthetic-alias')).toThrow();expect(loader).not.toHaveBeenCalled();});
 it.each([{VAYDU_DEPLOYMENT_ENV:'production'},{VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP:'false'},{VAYDU_DRIVER_SUBACCOUNT_MERCHANT_VERIFIED:'false'},
  {VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED:'false'},{VAYDU_DRIVER_SUBACCOUNT_FILE_OWNER_UID:'-1'},{FLUTTERWAVE_LIVE_SECRET_KEY:'FLWSECK-live'},
  {FLUTTERWAVE_SECRET_KEY:'FLWSECK-live'},{VAYDU_DRIVER_PAYOUT_SANDBOX:'true'},{VAYDU_DRIVER_TOPUP_API:'true'},
  {VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX:'true'},{VAYDU_BOOKING_SPLIT_TIMING_APPROVED:'true'}])('rejects invalid or unsafe activation %j',patch=>{const loader=vi.fn(()=>credentials);expect(()=>developCollectionProvider('http://movabi-develop-kong:8000',{...env(),...patch},loader)).toThrow();expect(loader).not.toHaveBeenCalled();});
 it.each(['https://production.example','http://movabi-develop-kong:8000/other','http://user:password@movabi-develop-kong:8000'])('rejects a different client target %s',url=>{expect(()=>developCollectionProvider(url,env(),()=>credentials)).toThrow();});
 it('does not inspect/change Stripe credentials',()=>{expect(developCollectionProvider('http://movabi-develop-kong:8000',{...env(),STRIPE_SECRET_KEY:'sk_live_synthetic_existing'},()=>credentials)('synthetic-alias')).toBeDefined();});
 it('never enumerates the process environment or reads/copies database or Stripe credentials',()=>{
  const config=new Proxy(env(),{ownKeys(){throw Error('Environment enumeration forbidden');},get(target,key:string){if(/SUPABASE_|DATABASE_|POSTGRES_|STRIPE_/.test(key))throw Error('Credential access forbidden');return target[key];}});
  expect(developCollectionProvider('http://movabi-develop-kong:8000',config,()=>credentials)('synthetic-alias')).toBeDefined();
 });
 it('hard binds the approved scope independently of database approval values',()=>{const s={driverId:DRIVER,tenant:TENANT,country:'NG',currency:'NGN'};expect(confirmedDevelopCollectionScope(s)).toBe(true);for(const patch of [{driverId:'other'},{tenant:'other'},{country:'GH'},{currency:'GBP'}])expect(confirmedDevelopCollectionScope({...s,...patch})).toBe(false);});
 it('parses only the provider file and suppresses malformed/sensitive contents',()=>{expect(Object.isFrozen(parseDevelopCollectionFile(source()))).toBe(true);for(const extra of ['\nSUPABASE_SERVICE_ROLE_KEY=synthetic-sensitive','\nFLUTTERWAVE_TEST_SECRET_KEY=duplicate','\nUNKNOWN=private']){let message='';try{parseDevelopCollectionFile(source()+extra);}catch(error){message=String(error);}expect(message).toContain('rejected');expect(message).not.toContain('synthetic-sensitive');}expect(()=>parseDevelopCollectionFile(source().replace('FLWSECK_TEST-synthetic','FLWSECK-live'))).toThrow();expect(()=>parseDevelopCollectionFile(source().replace('VAYDU_DRIVER_SUBACCOUNT_SANDBOX=false','VAYDU_DRIVER_SUBACCOUNT_SANDBOX=true'))).toThrow();});
 it('returns a safe error if the private mounted file cannot be used',()=>{expect(()=>readDevelopCollectionFile(-1)).toThrow('configuration rejected');});
 it('reads the pinned mounted file once with ownership/mode checks, closes it and suppresses filesystem errors',()=>{
  const original=Object.getOwnPropertyDescriptor(process,'platform')!;
  Object.defineProperty(process,'platform',{value:'linux'});
  try{
   vi.mocked(openSync).mockReturnValue(19);
   vi.mocked(fstatSync).mockReturnValue({isFile:()=>true,mode:0o100600,uid:1000,size:source().length} as any);
   vi.mocked(readFileSync).mockReturnValue(source());
   expect(readDevelopCollectionFile(1000).FLUTTERWAVE_COLLECTION_MERCHANT_REF).toBe('synthetic-alias');
   expect(openSync).toHaveBeenCalledWith('/run/vaydu/flutterwave-test.env',expect.any(Number));expect(closeSync).toHaveBeenCalledWith(19);
   for(const patch of [{mode:0o100644},{uid:999},{size:16385},{isFile:()=>false}]){
    vi.mocked(fstatSync).mockReturnValue({isFile:()=>true,mode:0o100600,uid:1000,size:source().length,...patch} as any);
    expect(()=>readDevelopCollectionFile(1000)).toThrow('configuration rejected');
   }
   vi.mocked(openSync).mockImplementation(()=>{throw Error('synthetic private filesystem diagnostics');});
   expect(()=>readDevelopCollectionFile(1000)).toThrow('Develop collection setup configuration rejected.');
  }finally{Object.defineProperty(process,'platform',original);vi.mocked(openSync).mockReset();vi.mocked(fstatSync).mockReset();vi.mocked(readFileSync).mockReset();vi.mocked(closeSync).mockReset();}
 });
});

function fixture(options:any={}){
 let row:any=null,created:any=null;let posts=0;const calls:string[]=[];const filters:any[]=[];let claims=0;
 const market={country_code:'NG',currency_code:'NGN',provider:'flutterwave',environment:'test',merchant_account_ref:'synthetic-alias',
  sandbox_driver_id:options.driver||DRIVER,sandbox_tenant_id:options.tenant||TENANT,setup_approved:true,adapter_ready:true,capability_evidence_ref:'synthetic-test-only-evidence',merchant_identity_verified:true,administrative_default_approved:true,
  // Synthetic approval/default fixture only; no real market approval or proposed flat zero.
  default_split_type:'flat',default_split_value:'1',f4b_approved:false,...options.market};
 const request:any=async(url:string,init:any)=>{calls.push(url);const body=init.body?JSON.parse(init.body):null;
  if(url.endsWith('/banks/NG'))return Response.json({status:'success',data:[{id:1,code:'044',name:'Synthetic Bank',has_branches:false}]});
  if(url.endsWith('/accounts/resolve'))return Response.json({status:'success',data:{account_number:body.account_number,account_name:'Synthetic Driver'}});
  if(url.endsWith('/subaccounts')&&body){posts++;created={...body,id:7,subaccount_id:'RS_SYNTHETIC'};if(options.timeout)throw Error('sensitive uncertain payload');return Response.json({status:'success',data:{id:7,subaccount_id:'RS_SYNTHETIC'}});}
  if(url.includes('/subaccounts?page=')){if(options.empty)return Response.json({status:'error',message:'Subaccounts not found'},{status:400});return Response.json({status:'success',data:created?[created]:[],meta:{page_info:{total_pages:1}}});}
  throw Error('Forbidden provider path');};
 const profile={id:options.driver||DRIVER,tenant_id:options.tenant||TENANT,role:'driver',registration_activated_at:'synthetic',registration_country_code:options.country||'NG'};
 const db:any={supabaseUrl:'http://movabi-develop-kong:8000',auth:{getUser:vi.fn(async(token:string)=>({data:{user:token==='owner'?{id:profile.id}:null}}))},from:vi.fn((table:string)=>{
  if(options.rejectLegacy&&['driver_payout_markets','driver_payment_accounts','driver_collection_markets','driver_collection_subaccounts'].includes(table))throw Error('Legacy payout/collection schema must not be queried');
  let patch:any=null;const chain:any={select:()=>chain,eq:(k:any,v:any)=>{filters.push([table,k,v]);return chain;},neq:()=>chain,
   single:async()=>({data:profile}),maybeSingle:async()=>({data:table==='driver_collection_setup_markets'?market:table==='driver_payout_markets'?null:row}),
   update:(value:any)=>{patch=value;return chain;},then:(resolve:any)=>{if(table==='market_availability')return Promise.resolve({data:[{supported_currency:options.currency||'NGN'}]}).then(resolve);if(patch)Object.assign(row,patch);return Promise.resolve({data:row?[{id:row.id}]:[]}).then(resolve);}};return chain;}),
  rpc:vi.fn(async(_name:string,args:any)=>{claims++;if(row)return {data:[]};row={id:'11111111-1111-4111-8111-111111111111',state:'in_progress',request_hash:args.p_request_hash,destination_hash:args.p_destination_hash,account_type:args.p_account_type,last4:args.p_last4,default_split_type:'flat',default_split_value:'1'};return {data:[row]};})};
 const loader=vi.fn(()=>credentials);const app=express();app.use(express.json());app.use(developDriverPaymentAccountRouter(db,{...env(),...options.env},loader,request));
 return {app,db,loader,filters,calls,row:()=>row,posts:()=>posts,claims:()=>claims};
}
async function session(h:ReturnType<typeof fixture>,fn:(call:(path:string,body?:any,auth?:boolean)=>Promise<any>)=>Promise<void>){
 const server=h.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try{await fn(async(path,body,auth=true)=>{const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer owner'}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();return {status:r.status,text,json:()=>JSON.parse(text)};});}
 finally{await new Promise<void>(r=>server.close(()=>r()));}
}
const input={name:'Synthetic Driver',email:'driver@example.test',phone:'+2348000000000',accountType:'bank',bankCode:'044',accountNumber:'0123456789',accountName:'Synthetic Driver',confirmed:true,driverId:'forged',tenantId:'forged'};
describe('co-hosted authenticated collection-only router with the existing injected DB object',()=>{
 it('requires owner auth and uses that exact client for status, claim and persistence',async()=>{const h=fixture({rejectLegacy:true});await session(h,async call=>{expect((await call('/status',undefined,false)).status).toBe(401);expect((await call('/status')).json()).toMatchObject({state:'not_started',available:true,reconcileOnly:false});expect(h.calls).toHaveLength(0);expect((await call('/banks')).status).toBe(200);expect((await call('/resolve',input)).json().accountName).toBe('Synthetic Driver');expect((await call('/setup',input)).json()).toMatchObject({state:'completed',verification:'retrieved'});expect(h.db.rpc).toHaveBeenCalledWith('claim_driver_collection_setup',expect.objectContaining({p_driver:DRIVER,p_tenant:TENANT}));expect(h.posts()).toBe(1);expect(h.db.from.mock.calls.map(c=>c[0])).not.toContain('driver_payout_markets');expect(JSON.stringify(h.row())).not.toContain(input.accountNumber);expect((await call('/setup',input)).json().state).toBe('completed');expect(h.posts()).toBe(1);});});
 it('concurrent confirms claim once and make one POST',async()=>{const h=fixture();await session(h,async call=>{await Promise.all([call('/setup',input),call('/setup',input)]);expect(h.posts()).toBe(1);});});
 it('timeout plus empty list never permits a replacement create or completion',async()=>{const h=fixture({timeout:true,empty:true});await session(h,async call=>{expect((await call('/setup',input)).status).toBe(409);for(let i=0;i<2;i++){expect((await call('/reconcile',{})).json()).toMatchObject({state:'action_required',reconcileOnly:true,creationPermitted:false});expect((await call('/setup',input)).json().reconcileOnly).toBe(true);}expect(h.posts()).toBe(1);expect(h.row().subaccount_id).toBeUndefined();});});
 it.each([{driver:'other'},{tenant:'other'},{country:'GH'},{currency:'GBP'}])('blocks a different authenticated scope even if its market row is approved %j',async options=>{const h=fixture(options);await session(h,async call=>{expect((await call('/status')).json().available).toBe(false);for(const path of ['/setup','/resolve','/reconcile'])expect((await call(path,input)).status).toBe(409);expect((await call('/banks')).status).toBe(409);expect(h.db.rpc).not.toHaveBeenCalled();expect(h.calls).toHaveLength(0);});});
 it.each([{merchant_identity_verified:false},{administrative_default_approved:false},{default_split_type:null,default_split_value:null}])('blocks missing database approval/default even when runtime gates are approved %j',async market=>{const h=fixture({market});await session(h,async call=>{expect((await call('/status')).json().available).toBe(false);expect((await call('/setup',input)).status).toBe(409);expect(h.posts()).toBe(0);expect(h.db.rpc).not.toHaveBeenCalled();});});
 it('stages disabled without reading credentials or making provider calls',async()=>{const h=fixture({env:{VAYDU_DRIVER_SUBACCOUNT_SANDBOX:'false'}});await session(h,async call=>{expect((await call('/status')).json().available).toBe(false);expect((await call('/setup',input)).status).toBe(409);expect(h.loader).not.toHaveBeenCalled();expect(h.calls).toHaveLength(0);});});
 it('does not mount transfer/webhook/booking paths',async()=>{const h=fixture();await session(h,async call=>{for(const path of ['/webhook','/transfers','/booking','/checkout'])expect((await call(path,{})).status).toBe(404);expect(h.calls).toHaveLength(0);});});
 it('delegates GB/GBP status to the existing Stripe service but never Flutterwave setup',async()=>{const h=fixture({country:'GB',currency:'GBP'});await session(h,async call=>{expect((await call('/status')).json()).toMatchObject({provider:'stripe',state:'completed'});expect((await call('/setup',input)).status).toBe(409);expect(h.calls).toHaveLength(0);});});
});
