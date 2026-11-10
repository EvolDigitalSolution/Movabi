import express from 'express';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const driver='d1', sameAdmin='admin-a', otherAdmin='admin-b';
  const tables: Record<string,Record<string,unknown>[]> = {
    profiles:[
      {id:driver,role:'driver',tenant_id:'tenant-a'},
      {id:sameAdmin,role:'admin',tenant_id:'tenant-a'},
      {id:otherAdmin,role:'admin',tenant_id:'tenant-b'}
    ],
    driver_vehicle_inspection_photos:[
      {id:'p1',driver_id:driver,tenant_id:'tenant-a',vehicle_id:'v1',vehicle_revision:'r1',slot:'front',storage_path:'t/d/p1.jpg',status:'under_review',byte_size:1,content_type:'image/jpeg',created_at:'2026-01-01'}
    ]
  };
  const makeClient=()=>({
    auth:{getUser:async (token:string)=>({data:{user:{id:token==='same'?sameAdmin:token==='other'?otherAdmin:driver}},error:null})},
    storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://s/signed'},error:null})})},
    from:(name:string)=>{
      let rows=[...tables[name]];
      let upd:Record<string,unknown>|undefined;
      const res=(one:boolean)=>{ if(upd) for(const r of rows) Object.assign(r,upd); return {data:one?rows[0]||null:rows,error:null}; };
      const q:any={select:()=>q,eq:(k:string,v:unknown)=>{rows=rows.filter(r=>r[k]===v);return q;},neq:(k:string,v:unknown)=>{rows=rows.filter(r=>r[k]!==v);return q;},update:(v:Record<string,unknown>)=>{upd=v;return q;},order:()=>q,limit:()=>q,maybeSingle:async()=>res(true),then:(fn:(x:unknown)=>unknown)=>Promise.resolve(fn(res(false)))};
      return q;
    }
  });
  return {client:makeClient(),tables,driver};
});

vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:mock.client}));
vi.mock('../../server/services/audit.service',()=>({AuditService:{logAdminAction:async()=>{}}}));
vi.mock('../../server/services/stripe.service',()=>({stripe:{}}));
vi.mock('../../server/services/notification.service',()=>({NotificationService:{}}));
vi.mock('../../server/services/dispatch.service',()=>({dispatchService:{}}));
vi.mock('../../server/services/payout.service',()=>({PayoutService:{}}));
vi.mock('../../server/services/admin-demand-map.service',()=>({demandZones:[]}));
vi.mock('../../server/services/admin-issuing-terminal.service',()=>({AdminIssuingTerminalService:{}}));
vi.mock('../../server/services/admin-finance.service',()=>({AdminFinanceService:{},reportBounds:()=>({}),dayInZone:()=>true}));
vi.mock('../../server/services/app-version.service',()=>({AppVersionService:{},normaliseAppVersionConfig:(x:unknown)=>x}));
vi.mock('../../server/services/marketplace-config.service',()=>({MarketplaceConfigService:{}}));
vi.mock('../../server/services/local-place-search.service',()=>({LocalPlaceSearchService:{},ProviderBrandService:{}}));
vi.mock('../../server/services/test-account-purge.service',()=>({isTestAccountPurgeEnabled:()=>false,purgeTestAccount:async()=>{},previewPurge:async()=>({}),isResetAllTestDataEnabled:()=>false,createResetChallenge:()=>({}),consumeResetChallenge:()=>true,resetPreview:async()=>({}),resetAllTestData:async()=>{},RESET_ALL_CONFIRMATION:''}));

import router from '../../server/routes/admin.routes';

describe('legacy Admin inspection endpoints — tenant scope',()=>{
  const app=express(); app.use(express.json(),router);
  let server:ReturnType<typeof app.listen>; let base:string;
  beforeAll(async()=>{ server=app.listen(0,'127.0.0.1'); await once(server,'listening');
    base=`http://127.0.0.1:${(server.address() as {port:number}).port}`; });
  afterAll(async()=>{ server.close(); await once(server,'close'); });

  it('same-tenant admin lists pending photos with signed urls',async()=>{
    const r=await fetch(`${base}/inspection-photos`,{headers:{authorization:'Bearer same'}});
    expect(r.status).toBe(200);
    const body=await r.json() as {photos:{slot:string;review_url:string}[]};
    expect(body.photos[0].slot).toBe('front');
    expect(body.photos[0].review_url).toBeTruthy();
  });

  it('different-tenant admin cannot list photos',async()=>{
    const r=await fetch(`${base}/inspection-photos`,{headers:{authorization:'Bearer other'}});
    const body=await r.json() as {photos:unknown[]};
    expect(r.status===200 && body.photos.length===0).toBe(true);
  });

  it('different-tenant admin cannot review a photo',async()=>{
    const r=await fetch(`${base}/inspection-photos/p1/review`,{method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer other'},
      body:JSON.stringify({status:'approved'})});
    expect([403,404,409]).toContain(r.status);
    const row=mock.tables.driver_vehicle_inspection_photos[0];
    expect(row.status).toBe('under_review');
  });

  it('rejection requires a reason and sets rejection_reason',async()=>{
    const noReason=await fetch(`${base}/inspection-photos/p1/review`,{method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer same'},
      body:JSON.stringify({status:'rejected'})});
    expect([400,422]).toContain(noReason.status);
    const r=await fetch(`${base}/inspection-photos/p1/review`,{method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer same'},
      body:JSON.stringify({status:'rejected',reason:'Blurred plate'})});
    expect([200,204]).toContain(r.status);
    const row=mock.tables.driver_vehicle_inspection_photos[0];
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe('Blurred plate');
  });
});
