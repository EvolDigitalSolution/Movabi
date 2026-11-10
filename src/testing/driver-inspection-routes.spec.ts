import express from 'express';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const mock = vi.hoisted(() => {
  const driver='00000000-0000-0000-0000-000000000001';
  const photo='00000000-0000-0000-0000-000000000002';
  const vehicle='00000000-0000-0000-0000-000000000003';
  const tables: Record<string,Record<string,unknown>[]> = {
    profiles:[{id:driver,role:'driver',tenant_id:'tenant-a'},
      {id:'same-admin',role:'admin',tenant_id:'tenant-a'},
      {id:'other-admin',role:'admin',tenant_id:'tenant-b'}],
    vehicles:[{id:vehicle,user_id:driver,capacity:'bike',inspection_revision:'revision-a'}],
    driver_vehicle_inspection_photos:[]
  };
  const sign=vi.fn(async () => ({data:{signedUrl:'https://storage.example.invalid/private'},error:null}));
  const upload=vi.fn(async () => ({error:null}));
  const client = {
    auth:{getUser:async (token:string) => ({data:{user:{id:token==='driver' ? driver : token}},error:null})},
    storage:{from:() => ({createSignedUrl:sign,upload})},
    rpc:async (_name:string,args:Record<string,string>) => {
      tables.driver_vehicle_inspection_photos.push({id:photo,driver_id:args.p_driver,tenant_id:args.p_tenant,
        vehicle_id:args.p_vehicle,vehicle_revision:args.p_revision,slot:args.p_slot,storage_path:args.p_path,status:'pending'});
      return {data:photo,error:null};
    },
    from:(name:string) => {
      let rows = tables[name];
      let update:Record<string,unknown>|undefined;
      const result = (one:boolean) => {
        if (update) for (const row of rows) Object.assign(row,update);
        return {data:one ? rows[0] || null : rows,error:null};
      };
      const query = {
        select:() => query,
        eq:(key:string,value:unknown) => {rows=rows.filter(row => row[key]===value); return query;},
        neq:(key:string,value:unknown) => {rows=rows.filter(row => row[key]!==value); return query;},
        limit:(limit:number) => {rows=rows.slice(0,limit); return query;},
        update:(values:Record<string,unknown>) => {update=values; return query;},
        maybeSingle:async () => result(true),
        then:(resolve:(value:unknown)=>unknown) => Promise.resolve(resolve(result(false)))
      };
      return query;
    }
  };
  return {client,driver,photo,vehicle,sign,upload,tables};
});

vi.mock('@supabase/supabase-js', () => ({createClient:() => mock.client}));
vi.mock('../../server/services/email.service', () => ({EmailService:{}}));
vi.mock('../../server/services/notification.service', () => ({NotificationService:{}}));
import router from '../../server/routes/verification.routes';

describe('inspection upload and tenant review endpoints', () => {
  const app = express();
  app.use(express.json(),router);
  let server: ReturnType<typeof app.listen>;
  let base:string;
  beforeAll(async () => {
    server=app.listen(0,'127.0.0.1');
    await once(server,'listening');
    const address=server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    base='http://127.0.0.1:'+address.port;
  });
  afterAll(() => server.close());
  const call = (path:string,token:string,options:RequestInit={}) => fetch(base+path,{
    ...options,headers:{Authorization:'Bearer '+token,...options.headers}
  });

  it('attaches a real image to the correct vehicle slot and denies cross-tenant links and review', async () => {
    const image = await sharp({create:{width:250,height:250,channels:3,background:'red'}}).jpeg().toBuffer();
    expect((await call('/inspection-photos/front','driver',{method:'PUT',body:new Uint8Array(image),
      headers:{'Content-Type':'application/octet-stream','X-Inspection-Vehicle':'revision-a'}})).status).toBe(204);
    expect(mock.upload).toHaveBeenCalledOnce();
    const photos='/drivers/'+mock.driver+'/inspection-photos';
    const review='/inspection-photos/'+mock.photo+'/review';
    const approve = {method:'POST',headers:{'Content-Type':'application/json'},body:'{"status":"approved"}'};
    expect((await call(photos,'other-admin')).status).toBe(404);
    expect((await call(review,'other-admin',approve)).status).toBe(404);
    expect(mock.sign).not.toHaveBeenCalled();
    const allowed = await call(photos,'same-admin');
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({vehicle:{id:mock.vehicle},slots:[
      {slot:'front',status:'pending',url:'https://storage.example.invalid/private'},
      {slot:'rear',status:'missing'},{slot:'side',status:'missing'}
    ]});
    expect((await call(review,'same-admin',approve)).status).toBe(204);
    expect(mock.tables.driver_vehicle_inspection_photos[0]).toMatchObject({status:'approved',reviewed_by:'same-admin'});
  });
});
