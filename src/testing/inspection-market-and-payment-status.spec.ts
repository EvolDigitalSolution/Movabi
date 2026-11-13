/**
 * Post-deploy fixes (develop, 2026-11-13; user decisions):
 *  D15 "Auto-assign from registration": a driver's inspection market is assigned once, server-side, from
 *      the registration market, only for an enabled market, a driver with a tenant and no market yet.
 *  503 status: with the payment-account setup module absent, GET /status still answers with the
 *      verified state (Stripe for GB); every setup action stays 503.
 */
import {describe,expect,it,vi} from 'vitest';
import express from 'express';
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{},supabase:{}}));
// verification.routes builds its own client at import; the tests pass their own fake db explicitly.
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({})}));
import {ensureInspectionMarket} from '../../server/routes/verification.routes';
import {developDriverPaymentAccountRouter} from '../../server/routes/driver-payment-account-develop.routes';

type Row=Record<string,unknown>;
function fakeDb(profile:Row|null,markets:Row[]){
  const updates:Array<{values:Row;filters:Array<[string,string,unknown]>}>=[];
  const from=(table:string)=>{
    const filters:Array<[string,string,unknown]>=[];let values:Row|null=null;
    const q:any={
      select(){return q;},
      update(v:Row){values=v;return q;},
      eq(c:string,v:unknown){filters.push(['eq',c,v]);return q;},
      is(c:string,v:unknown){filters.push(['is',c,v]);return q;},
      limit(){return Promise.resolve({data:markets.filter(m=>filters.every(([,c,v])=>m[c]===v)),error:null});},
      maybeSingle(){return Promise.resolve({data:profile,error:null});},
      then(res:any,rej:any){if(table==='profiles'&&values){updates.push({values,filters:[...filters]});return Promise.resolve({error:null}).then(res,rej);}return Promise.resolve({data:null,error:null}).then(res,rej);}
    };return q;};
  return {db:{from},updates};
}
const driver=(over:Row={})=>({id:'d1',role:'driver',tenant_id:'t1',inspection_market_code:null,registration_country_code:'GB',country_code:'GB',...over});
const gb={country_code:'GB',enabled:true};

describe('D15: inspection market auto-assigned from the registration market',()=>{
  it('assigns the registration market once, only while it is unset, for a driver with a tenant',async()=>{
    const {db,updates}=fakeDb(driver(),[gb]);
    await ensureInspectionMarket(db,'d1');
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({inspection_market_code:'GB'});
    expect(updates[0].filters).toEqual(expect.arrayContaining([['eq','id','d1'],['eq','role','driver'],['is','inspection_market_code',null]]));
  });
  it('falls back to country_code when there is no registration country (same precedence as the payout market checks)',async()=>{
    const {db,updates}=fakeDb(driver({registration_country_code:null,country_code:'gb'}),[gb]);
    await ensureInspectionMarket(db,'d1');
    expect(updates[0]?.values).toEqual({inspection_market_code:'GB'});
  });
  it.each([
    ['an existing market (never overwritten)',driver({inspection_market_code:'NG'}),[gb]],
    ['a non-driver',driver({role:'customer'}),[gb]],
    ['a driver with no tenant',driver({tenant_id:null}),[gb]],
    ['an unconfigured market',driver({registration_country_code:'FR',country_code:'FR'}),[gb]],
    ['a disabled market',driver(),[{country_code:'GB',enabled:false}]],
    ['a malformed country',driver({registration_country_code:'GBR',country_code:null}),[gb]],
    ['a missing profile',null,[gb]],
  ])('does nothing for %s',async(_label,profile,markets)=>{
    const {db,updates}=fakeDb(profile as Row|null,markets as Row[]);
    await ensureInspectionMarket(db,'d1');
    expect(updates).toHaveLength(0);
  });
});

describe('payment-account status when the setup module is unavailable',()=>{
  const call=async(path:string,{auth=true,user='d1',status}:{auth?:boolean;user?:string|null;status?:()=>Promise<Row>}={})=>{
    const db={supabaseUrl:'http://not-develop.invalid',auth:{getUser:async()=>({data:{user:user?{id:user}:null},error:user?null:{message:'bad'}})}};
    const app=express();app.use('/api/driver-payment-account',developDriverPaymentAccountRouter(db,{VAYDU_PAYMENT_ACCOUNT_SETUP:'true'} as any,undefined,undefined,status));
    const srv=app.listen(0);const port=(srv.address() as any).port;
    try{const r=await fetch(`http://127.0.0.1:${port}/api/driver-payment-account${path}`,{headers:auth?{Authorization:'Bearer t'}:{}});return {status:r.status,body:await r.json()};}
    finally{srv.close();}
  };
  it('answers /status with the verified state (GB: Stripe) instead of a 503',async()=>{
    const seen:string[]=[];
    const r=await call('/status',{status:async()=>{seen.push('d1');return {provider:'stripe',state:'completed',available:true,reason:null};}});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({provider:'stripe',state:'completed',available:true,reason:null,setupAvailable:false});
    expect(seen).toEqual(['d1']);
  });
  it('a market without the module is reported as unavailable, not an error',async()=>{
    const r=await call('/status',{status:async()=>({provider:null,state:'unavailable',available:false,reason:null})});
    expect(r).toMatchObject({status:200,body:{state:'unavailable',available:false,setupAvailable:false}});
  });
  it('requires a signed-in user',async()=>{
    expect((await call('/status',{auth:false})).status).toBe(401);
    expect((await call('/status',{user:null})).status).toBe(401);
  });
  it('a failing status lookup is a 503 with its own code, never a crash',async()=>{
    const r=await call('/status',{status:async()=>{throw new Error('stripe down');}});
    expect(r).toMatchObject({status:503,body:{code:'PAYMENT_ACCOUNT_STATUS_UNAVAILABLE'}});
  });
  it.each(['/banks','/setup','/resolve','/reconcile'])('every setup action stays unavailable: %s',async(path)=>{
    expect(await call(path)).toMatchObject({status:503,body:{code:'PAYMENT_ACCOUNT_SETUP_UNAVAILABLE'}});
  });
});
