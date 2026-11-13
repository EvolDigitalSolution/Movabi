/**
 * Vehicle inspection, end to end on a REAL backend (2026-11-13): postgres:15.1 restored from develop's live
 * schema + the 3c91991 release, pinned GoTrue, PostgREST, and the real onboarding and verification
 * routers called over HTTP as a driver and as an admin. Only the external payout provider (Stripe) and
 * the storage upload (the photo row is registered through the same RPC the upload route calls) are
 * outside the stack.
 *
 * Scenarios: zero images, partial uploads, all uploaded (awaiting review), submission refused until
 * approved, admin approves each photo, submission accepted, admin approval, a removed photo, and a
 * vehicle change (revision rotation) that drops every photo; plus the acquisition gate.
 */
import {it,expect,vi} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import express from 'express';
import http from 'node:http';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';

declare global { var __TEST_SUPABASE_ADMIN__: any; }
vi.mock('../../server/services/supabase.service',()=>({
  supabaseAdmin:new Proxy({},{get:(_t,k)=>globalThis.__TEST_SUPABASE_ADMIN__[k]}),
  getSupabaseAdmin:()=>globalThis.__TEST_SUPABASE_ADMIN__,
}));
// verification.routes builds its own client at import: hand it the same real-stack client.
vi.mock('@supabase/supabase-js',async(importOriginal)=>{const mod:any=await importOriginal();return {...mod,createClient:(...args:any[])=>globalThis.__TEST_SUPABASE_ADMIN__??mod.createClient(...args)};});
vi.mock('../../server/services/payout-eligibility.service',()=>({
  PayoutEligibilityService:{assertEligible:async()=>({eligible:true}),evaluateDriver:async()=>({eligible:true}),isSupportedCountry:()=>true},
  PayoutEligibilityError:class extends Error{},SUPPORTED_PAYOUT_COUNTRIES:['GB'],
}));

const suffix=Math.random().toString(36).slice(2,10);
const dbName=`vaydu-insp-${suffix}`,network=`${dbName}-net`,authName=`${dbName}-auth`,restName=`${dbName}-rest`,testDb='movabi_insp_test';
const secret='synthetic-disposable-jwt-secret-minimum-40-characters';
const jwt=(role:string)=>{const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const p=Buffer.from(JSON.stringify({role,aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');return h+'.'+p+'.'+createHmac('sha256',secret).update(h+'.'+p).digest('base64url');};
const waitFor=async(url:string,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error('timeout '+url);};
const MOTOR=['front','rear','dashboard','seats_interior','left_side','right_side'];

it('vehicle inspection readiness, submission, admin review/approval and acquisition on a real backend',{timeout:600000},async()=>{
  const docker=(...a:string[])=>execFileSync('docker',a,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  const sql=(q:string)=>docker('exec','-e','PGPASSWORD=isolated-test',dbName,'psql','-U','postgres','-d',testDb,'-X','-v','ON_ERROR_STOP=1','-qAt','-c',q);
  const psqlFile=(file:string)=>{docker('cp',file,`${dbName}:/tmp/load.sql`);docker('exec','-e','PGPASSWORD=isolated-test',dbName,'psql','-U','postgres','-d',testDb,'-X','-v','ON_ERROR_STOP=1','-q','-f','/tmp/load.sql');};
  let server:http.Server|undefined;
  try{
    docker('network','create',network);
    docker('run','-d','--rm','--name',dbName,'--network',network,'-e','POSTGRES_PASSWORD=isolated-test','-e',`POSTGRES_DB=${testDb}`,'postgres:15.1');
    for(let i=0;i<120;i++){try{if((docker('logs',dbName).match(/ready to accept connections/g)||[]).length>=2)break;}catch{}await new Promise(r=>setTimeout(r,500));}
    sql(`CREATE SCHEMA IF NOT EXISTS auth; DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator LOGIN PASSWORD 'isolated-test'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_storage_admin') THEN CREATE ROLE supabase_storage_admin NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dashboard_user') THEN CREATE ROLE dashboard_user NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pgbouncer') THEN CREATE ROLE pgbouncer NOLOGIN; END IF;
    END $$; GRANT anon, authenticated, service_role TO authenticator;`);
    docker('run','-d','--rm','--network',network,'--name',authName,'-p','127.0.0.1::9999',
      '-e','GOTRUE_API_HOST=0.0.0.0','-e','GOTRUE_API_PORT=9999','-e','API_EXTERNAL_URL=http://localhost:9999','-e','GOTRUE_SITE_URL=http://localhost:3000',
      '-e','GOTRUE_DB_NAMESPACE=auth','-e','GOTRUE_DB_DRIVER=postgres',
      '-e',`GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@${dbName}:5432/${testDb}?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic`,
      '-e',`GOTRUE_JWT_SECRET=${secret}`,'-e','GOTRUE_JWT_AUD=authenticated','-e','GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
      '-e','GOTRUE_MAILER_AUTOCONFIRM=true','-e','GOTRUE_DISABLE_SIGNUP=false','supabase/gotrue:v2.132.3');
    const authPort=docker('port',authName,'9999/tcp').split(':').at(-1);
    await waitFor(`http://127.0.0.1:${authPort}/health`);
    sql(`CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid);
      CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid; $$;
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz DEFAULT now());`);
    // develop's live public schema (byte-exact) + the release that is deployed on develop.
    const work=mkdtempSync(join(tmpdir(),'vaydu-insp-'));
    const live=readFileSync(join(process.cwd(),'supabase/baseline/develop_live_public_schema_20261112.sql')).toString('latin1')
      .replace('CREATE SCHEMA public;','CREATE SCHEMA IF NOT EXISTS public;').replace(/CREATE EXTENSION /g,'CREATE EXTENSION IF NOT EXISTS ');
    writeFileSync(join(work,'live.sql'),Buffer.from(live,'latin1'));
    psqlFile(join(work,'live.sql'));
    psqlFile(join(process.cwd(),'deploy/vaydu-develop-release/release-up.sql'));
    // PostgREST starts AFTER the schema exists, so its cache is current.
    docker('run','-d','--rm','--network',network,'--name',restName,'-p','127.0.0.1::3000',
      '-e',`PGRST_DB_URI=postgres://authenticator:isolated-test@${dbName}:5432/${testDb}`,'-e','PGRST_DB_SCHEMA=public','-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,
      'postgrest/postgrest:v10.1.2');
    const restPort=docker('port',restName,'3000/tcp').split(':').at(-1);
    await waitFor(`http://127.0.0.1:${restPort}`);
    const authUrl='http://127.0.0.1:'+authPort,restUrl='http://127.0.0.1:'+restPort;
    const real:any=await vi.importActual('@supabase/supabase-js');
    globalThis.__TEST_SUPABASE_ADMIN__=real.createClient(restUrl,jwt('service_role'),{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input:any,init:any)=>{const url=String(input);if(url.startsWith(restUrl+'/auth/v1'))return fetch(authUrl+url.slice((restUrl+'/auth/v1').length),init);return fetch(url.replace('/rest/v1',''),init);}}});
    const signup=async(email:string)=>(await (await fetch(authUrl+'/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'synthetic-test-password-123'})})).json());
    const driver=await signup(`insp-driver-${suffix}@example.test`),admin=await signup(`insp-admin-${suffix}@example.test`);
    expect(driver.access_token&&admin.access_token).toBeTruthy();
    const D=driver.user.id,A=admin.user.id,T='aaaaaaaa-1111-4111-8111-111111111111';
    sql(`INSERT INTO public.tenants(id,name,slug) VALUES('${T}','Inspection Test','insp-${suffix}');
      DELETE FROM public.profiles WHERE id IN ('${D}','${A}');
      INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code,full_name,phone,date_of_birth,current_address,accepted_driver_agreement_at,driver_license_url,insurance_url,driver_license_expiry,insurance_expiry,right_to_work_url,verification_items,verification_status,driver_review_status,onboarding_completed,stripe_connect_status,charges_enabled,payouts_enabled)
        VALUES('${D}','${T}','driver','GB','GB','Ada Driver','07000000000','1990-01-01','Unit 1, 1 High Street, Bolton, BL1 1AA',now(),'licence.pdf','insurance.pdf','2030-01-01','2030-01-01','rtw.pdf',ARRAY['{"key":"delivery_equipment_confirmed","value":"true"}']::text[],'incomplete','incomplete',false,'connected',true,true),
              ('${A}','${T}','admin','GB','GB','Ann Admin','07000000001','1985-01-01','Unit 2, 2 High Street, Bolton, BL1 1AA',NULL,NULL,NULL,NULL,NULL,NULL,ARRAY[]::text[],'approved','approved',true,NULL,false,false);
      INSERT INTO public.market_availability(country_code,market_city,launch_status,customer_app_enabled,customer_registration_enabled,driver_registration_enabled,driver_online_enabled,quote_enabled,booking_enabled,payment_enabled,supported_currency,enabled)
        VALUES('GB',NULL,'live',true,true,true,true,true,true,true,'GBP',true) ON CONFLICT DO NOTHING;
      INSERT INTO public.vehicles(id,user_id,type,vehicle_subtype,make,model,color,year,license_plate,service_eligibility)
        VALUES('${D}','${D}','car',NULL,'Ford','Focus','Red','2020','AB12 CDE','["delivery"]'::jsonb);`);

    // verification.routes reads its service key at import (the client itself is the mocked real-stack one).
    process.env['SUPABASE_SERVICE_ROLE_KEY']=jwt('service_role');
    const routes:any=await import('../../server/routes/driver-onboarding.routes');
    const verification:any=await import('../../server/routes/verification.routes');
    const app=express();app.use(express.json());
    app.use('/api/driver-onboarding',routes.default);app.use('/api/verification',verification.default);
    server=http.createServer(app);server.keepAliveTimeout=600000;await new Promise<void>(r=>server!.listen(0,'127.0.0.1',()=>r()));
    const base=`http://127.0.0.1:${(server.address() as any).port}`;
    const call=async(method:string,path:string,token:string,body?:unknown)=>{const r=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let json:any=null;try{json=JSON.parse(text);}catch{}return {status:r.status,json,text};};
    // The real readiness responses are saved for the review-screen browser test (e2e/driver-inspection-review.spec.ts).
    const snapshots:Record<string,unknown>={};
    const readiness=async(label?:string)=>{const r=await call('GET','/api/driver-onboarding/status',driver.access_token);expect(r.status,r.text).toBe(200);if(label)snapshots[label]=r.json;
      const rows=Object.fromEntries((r.json.automaticRequirements as any[]).filter(x=>x.category==='inspection').map(x=>[x.code,x]));
      return {vehicle:r.json.sectionStatus.vehicle.status,inspection:r.json.sectionStatus.inspection?.status,photos:rows['vehicle.inspection_photos'],review:rows['vehicle.inspection_review'],overall:r.json.overallStatus};};
    const vehicle=()=>({rev:sql(`SELECT inspection_revision FROM public.vehicles WHERE id='${D}'`)});
    const register=(slot:string)=>sql(`SELECT public.register_driver_inspection_photo('${D}','${T}','${D}','${vehicle().rev}','${slot}','inspection/${D}/${slot}-x.jpg',1000,'image/jpeg');`);

    // 1. Zero images: vehicle details complete, inspection "Missing photos", nothing counted.
    let r=await readiness('zero-images');
    console.log('READINESS_ZERO='+JSON.stringify(r));
    expect(r.vehicle).toBe('complete');
    expect(r.inspection).toBe('incomplete');
    expect(r.photos).toMatchObject({status:'missing',completed:false,blockingForSubmission:true});
    expect(r.photos.reason).toBe('Missing photos: front, rear, dashboard, seats interior, left side, right side (0 of 6 uploaded).');
    // 2. Partial uploads.
    for(const s of MOTOR.slice(0,3))register(s);
    r=await readiness('partial-uploads');
    expect(r.photos.reason).toBe('Missing photos: seats interior, left side, right side (3 of 6 uploaded).');
    expect(r.inspection).toBe('incomplete');
    // 3. All uploaded: upload complete, admin review separate and pending.
    for(const s of MOTOR.slice(3))register(s);
    r=await readiness('all-uploaded-awaiting-review');
    expect(r.photos).toMatchObject({status:'completed',completed:true});
    expect(r.review).toMatchObject({status:'under_review',completed:false,blockingForSubmission:true});
    expect(r.inspection).toBe('under_review');
    // 4. Submission is refused until every photo is approved.
    let sub=await call('POST','/api/verification/driver-submission',driver.access_token,{});
    console.log('SUBMIT_BEFORE_APPROVAL='+sub.status+' '+sub.text.slice(0,400));
    expect(sub.status).toBe(422);
    expect(JSON.stringify(sub.json)).toMatch(/inspection/i);
    // 5. Admin reviews each photo through the real route.
    const ids=sql(`SELECT string_agg(id::text,',' ORDER BY slot) FROM public.driver_vehicle_inspection_photos WHERE driver_id='${D}' AND status='under_review'`).split(',');
    expect(ids).toHaveLength(6);
    for(const id of ids)expect((await call('POST',`/api/verification/inspection-photos/${id}/review`,admin.access_token,{status:'approved'})).status).toBe(204);
    expect((await call('POST',`/api/verification/inspection-photos/${ids[0]}/review`,driver.access_token,{status:'approved'})).status,'a driver cannot review photos').toBe(403);
    r=await readiness('all-approved');
    expect(r.review).toMatchObject({status:'approved',completed:true,blockingForSubmission:false});
    expect(r.inspection).toBe('complete');
    // 6. Submission now passes the inspection (and the market is auto-assigned, D15).
    sub=await call('POST','/api/verification/driver-submission',driver.access_token,{});
    console.log('SUBMIT_AFTER_APPROVAL='+sub.status+' '+sub.text.slice(0,600));
    expect(JSON.stringify(sub.json||{})).not.toMatch(/inspection/i);
    expect(sql(`SELECT inspection_market_code FROM public.profiles WHERE id='${D}'`)).toBe('GB');
    if(sub.status===200){
      expect(sql(`SELECT driver_review_status FROM public.profiles WHERE id='${D}'`)).toBe('under_review');
      // 7. Admin approval through the real route.
      const appr=await call('POST',`/api/verification/drivers/${D}/manual-approve`,admin.access_token,{notes:'integration',testingOverride:true});
      console.log('MANUAL_APPROVE='+appr.status+' '+appr.text.slice(0,400));
      expect(appr.status,appr.text).toBe(200);
      expect(sql(`SELECT is_verified::text||'|'||driver_review_status FROM public.profiles WHERE id='${D}'`)).toBe('true|approved');
    }
    expect(sub.status,'submission must succeed once the inspection is approved: '+sub.text).toBe(200);
    // Acquisition gate passes with every photo approved.
    const ev:any=await import('../../server/services/driver-inspection-evidence');
    await expect(ev.assertInspectionApproved(globalThis.__TEST_SUPABASE_ADMIN__,D)).resolves.toBeUndefined();
    // 8. Removed image: deleting one saved photo drops the slot back to missing and blocks acquisition.
    sql(`DELETE FROM public.driver_vehicle_inspection_photos WHERE driver_id='${D}' AND slot='front'`);
    r=await readiness('removed-image');
    expect(r.photos.reason).toBe('Missing photos: front (5 of 6 uploaded).');
    await expect(ev.assertInspectionApproved(globalThis.__TEST_SUPABASE_ADMIN__,D)).rejects.toMatchObject({code:'INSPECTION_NOT_APPROVED'});
    // Re-uploading front alone needs a fresh admin approval.
    register('front');
    r=await readiness();
    expect(r.photos.completed).toBe(true);expect(r.review.status).toBe('under_review');
    // 9. Vehicle change rotates the inspection revision: every photo stops counting.
    const before=vehicle().rev;
    sql(`UPDATE public.vehicles SET make='Toyota', model='Corolla' WHERE id='${D}'`);
    expect(vehicle().rev).not.toBe(before);
    r=await readiness();
    expect(r.photos.reason).toBe('Missing photos: front, rear, dashboard, seats interior, left side, right side (0 of 6 uploaded).');
    expect(r.inspection).toBe('incomplete');
    // Admin approval of a driver whose inspection is not approved is refused (submission state is gone).
    const appr2=await call('POST',`/api/verification/drivers/${D}/manual-approve`,admin.access_token,{notes:'integration',testingOverride:true});
    console.log('MANUAL_APPROVE_AFTER_CHANGE='+appr2.status+' '+appr2.text.slice(0,300));
    expect([409,422]).toContain(appr2.status);
    const out=join(process.cwd(),'e2e/fixtures/inspection-readiness');mkdirSync(out,{recursive:true});
    for(const [label,payload] of Object.entries(snapshots))writeFileSync(join(out,label+'.json'),JSON.stringify(payload,null,1)+String.fromCharCode(10));
    console.log('SNAPSHOTS='+Object.keys(snapshots).join(','));
    expect(sql(`SELECT driver_review_status FROM public.profiles WHERE id='${D}'`),'a vehicle change reopens review').not.toBe('approved');
  }finally{
    if(server)await new Promise(r=>server!.close(()=>r(null)));
    for(const n of [restName,authName,dbName])spawnSync('docker',['rm','-f',n]);
    spawnSync('docker',['network','rm',network]);
  }
});
