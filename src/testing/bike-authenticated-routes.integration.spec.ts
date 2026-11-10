import { it, expect, vi } from 'vitest';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

vi.mock('../../server/services/supabase.service', () => ({
  supabaseAdmin: globalThis.__TEST_SUPABASE_ADMIN__ as any,
  getSupabaseAdmin: () => globalThis.__TEST_SUPABASE_ADMIN__ as any
}));

// External payout provider only: the category/assignment authority under test is real.
vi.mock('../../server/services/payout-eligibility.service', () => ({
  PayoutEligibilityService: {
    assertEligible: async () => ({ eligible: true }),
    evaluateDriver: async () => ({ eligible: true }),
    isSupportedCountry: () => true,
  },
  PayoutEligibilityError: class PayoutEligibilityError extends Error {
    constructor(public code: string, message: string) { super(message); this.name = 'PayoutEligibilityError'; }
  },
  SUPPORTED_PAYOUT_COUNTRIES: ['GB'],
}));

declare global {
  var __TEST_SUPABASE_ADMIN__: any;
}

const suffix = Math.random().toString(36).slice(2, 10);
const dbName = `vaydu-bike-test-${suffix}`;
const network = `${dbName}-net`;
const authName = `${dbName}-auth`;
const restName = `${dbName}-rest`;
const testDb = 'movabi_batch2a_test';
const schemaFile = join(process.cwd(), 'supabase', 'baseline', 'deployed_public_schema.sql');
const secret = 'synthetic-disposable-jwt-secret-minimum-40-characters';
const jwt = (role: string) => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ role, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return h + '.' + p + '.' + createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
};

function dumpDiagnostics(docker: (...args: string[]) => string, logDir: string) {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  for (const name of [authName, restName, dbName]) {
    try {
      const state = docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}} {{.Status}} {{.State}}');
      writeFileSync(join(logDir, `${name}-state.txt`), state, 'utf8');
      const logs = spawnSync('docker', ['logs', '--tail', '60', name], { encoding: 'utf8' }).output?.filter(Boolean).join('\n') || '';
      writeFileSync(join(logDir, `${name}-logs.txt`), logs, 'utf8');
    } catch { }
  }
}

async function waitFor(url: string, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('bootstrap timeout: ' + url);
}

it('Bike authenticated HTTP - Car driver denied, Bike driver succeeds', { timeout: 420000 }, async () => {
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const sql = (query: string) => docker('exec', '-e', 'PGPASSWORD=isolated-test', dbName, 'psql', '-U', 'postgres', '-d', testDb, '-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', query);
  const sqlAsync = (query: string) => new Promise<string>((resolve, reject) => {
    execFile('docker', ['exec', '-e', 'PGPASSWORD=isolated-test', dbName, 'psql', '-U', 'postgres', '-d', testDb, '-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', query],
      (err, stdout) => err ? reject(err) : resolve(String(stdout).trim()));
  });
  const logDir = join(tmpdir(), `${dbName}-logs`);
  let server: http.Server | undefined;
  try {
    expect(existsSync(schemaFile), 'committed schema snapshot required').toBe(true);
    docker('network', 'create', network);
    docker('run', '-d', '--rm', '--name', dbName, '-e', 'POSTGRES_PASSWORD=isolated-test', '-e', `POSTGRES_DB=${testDb}`, 'postgres:16.15');
    docker('network', 'connect', network, dbName);
    for (let i = 0; i < 60; i++) {
      try {
        const matches = (docker('logs', dbName).match(/database system is ready to accept connections/g) || []).length;
        if (matches >= 2) break;
      } catch { }
      await new Promise(r => setTimeout(r, 500));
    }
    // Roles and an empty auth schema only. GoTrue's own migrations own
    // auth.users, auth.uid() and all auth functions (no handcrafted substitute).
    sql(`CREATE SCHEMA IF NOT EXISTS auth;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator LOGIN PASSWORD 'isolated-test'; END IF;
      ALTER ROLE authenticator LOGIN PASSWORD 'isolated-test';
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
    END $$; GRANT anon, authenticated, service_role TO authenticator;`);;

    // Pinned GoTrue bootstrap first: it creates the auth schema, auth.uid() and tables.
    docker('run', '-d', '--rm', '--network', network, '--name', authName, '-p', '127.0.0.1::9999',
      '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'GOTRUE_API_PORT=9999', '-e', 'API_EXTERNAL_URL=http://localhost:9999',
      '-e', 'GOTRUE_SITE_URL=http://localhost:3000', '-e', 'GOTRUE_DB_NAMESPACE=auth', '-e', 'GOTRUE_DB_DRIVER=postgres',
      '-e', `GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@${dbName}:5432/${testDb}?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic`,
      '-e', `GOTRUE_JWT_SECRET=${secret}`, '-e', 'GOTRUE_JWT_AUD=authenticated', '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
      '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true', '-e', 'GOTRUE_DISABLE_SIGNUP=false', 'supabase/gotrue:v2.132.3');
    const authPort = docker('port', authName, '9999/tcp').split(':').at(-1);
    await waitFor(`http://127.0.0.1:${authPort}/health`);

    // Fixture shims for two auth-schema objects referenced by the public export
    // but outside it (GoTrue does not create them): send_job_message's return
    // type and the debug errand trigger function. They are never exercised here.
    sql(`CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid);
         CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`);
    // PostgREST v10 sets only request.jwt.claims (JSON); GoTrue 2.132's auth.uid()
    // reads the legacy request.jwt.claim.sub, so RLS sees a null uid. Use the
    // Supabase-compatible definition (reads the real claim, no reduced substitute).
    sql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      ), '')::uuid;
    $$;`);

    // Restore the committed, reviewed public schema snapshot (schema only).
    docker('cp', schemaFile, `${dbName}:/tmp/schema.sql`);
    docker('exec', dbName, 'sh', '-c',
      `sed -i 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' /tmp/schema.sql && PGPASSWORD=isolated-test psql -U postgres -d ${testDb} -v ON_ERROR_STOP=1 -q -f /tmp/schema.sql`);
    // Reviewed candidate additions for objects the deployed snapshot lacks.
    docker('cp', join(process.cwd(), 'supabase', 'baseline', 'candidate', '001_tenants.sql'), `${dbName}:/tmp/candidate-001.sql`);
    docker('exec', dbName, 'sh', '-c',
      `PGPASSWORD=isolated-test psql -U postgres -d ${testDb} -v ON_ERROR_STOP=1 -q -f /tmp/candidate-001.sql`);
    // Saved countries config required by the market-payment-route validator.
    sql(`INSERT INTO public.system_configs(key,value) VALUES('countries','[{"code":"GB","currency":"GBP"},{"code":"NG","currency":"NGN"}]'::jsonb) ON CONFLICT DO NOTHING;`);
    // Synthetic pre-upgrade history: legacy service type (no FK) plus the Kora route.
    sql(`INSERT INTO public.service_types(id,slug,name) VALUES('eeeeeeee-1111-2222-3333-444444444444','legacy-errand','Legacy Errand') ON CONFLICT DO NOTHING;`);
    // Historical pricing and wallet transaction (pre-upgrade synthetic data).
    sql(`INSERT INTO public.pricing_config(service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,is_active,country_code) VALUES('errand',2.10,1.00,0.10,0.40,3.00,'GBP',true,'GB') ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.wallet_business_events(event_key,operation,tenant_id,owner_id,currency_code,entries) VALUES('hist-wallet-1','topup','11111111-1111-1111-1111-111111111111','99999999-8888-7777-6666-555555555555','GBP','[{"accountPurpose":"driver_cash_credit","amountMinor":1000},{"accountPurpose":"platform_funding","amountMinor":-1000}]'::jsonb) ON CONFLICT (event_key) DO NOTHING;`);
    // Snapshot the authorised Kora NG route before the neutral upgrade.
    const koraRouteBefore = sql(`SELECT provider||'|'||coalesce(merchant_account_ref,'')||'|'||enabled::text||'|'||preferred::text||'|'||coalesce(array_to_string(capabilities,','),'') FROM public.market_payment_routes WHERE country_code='NG' AND currency_code='NGN' AND method='card';`);
    // Reviewed provider-neutral upgrade path: 539 (enum widen), 540 minus its
    // NG/NGN/card Flutterwave route insert (candidate overlay), 541-545, then the
    // Bike/cash candidates. Existing provider routes and settings are untouched.
    for (const migration of [
      '20261101000000_driver_offer_events.sql',
      '20261102000000_driver_vehicle_inspection.sql',
      '20261103000000_completion_pin_policy.sql',
      '20261104000000_cancellation_debt.sql',
      '20261105000000_campaigns_referrals.sql',
      '20261253900000_flutterwave_market_provider_prerequisite.sql',
      'candidate/003_neutral_2a_columns.sql',
      '20261254100000_wallet_fee_freeze_batch2b.sql',
      '20261254200000_flutterwave_provider_accept_batch2c.sql',
      '20261254300000_wallet_atomic_confirm_batch2d.sql',
      '20261254400000_wallet_fee_policy_v2.sql',
      '20261254500000_driver_card_five_percent_policy.sql',
      '20261255500000_cash_acquisition_eligibility.sql',
      '20261255600000_cash_disabled_acquisition_gate.sql',
      '20261255700000_commercial_policies_v2.sql',
      '20261255800000_promo_policy_v2.sql',
      '20261255900000_reward_credit_spends.sql',
      '20261256000000_secured_zero_payable.sql',
      '20261256100000_job_refund_allocations.sql',
      '20261256200000_refund_allocations_v2.sql',
      '20261257000000_bike_fulfilment_category.sql',
      '20261259000000_market_bike_limits.sql',
      '20261260000000_bike_assignment_trigger.sql',
      '20261261000000_bike_guard_snapshot_authority.sql',
      '20261262000000_driver_feed_visibility.sql',
      '20261263000000_courier_cash_reassignment.sql',
      '20261263100000_funding_minor_units_fix.sql',
      '20261263200000_major_money_scale.sql',
      '20261263300000_campaign_replay_order.sql',
      '20261264000000_cancellation_compensation.sql',
      '20261264100000_cancellation_compensation_earnings.sql',
      '20261264200000_cancellation_compensation_acceptance.sql',
      '20261264300000_campaign_admin_controls.sql',
      '20261264400000_campaign_referral_snapshot.sql',
      '20261264500000_referral_lifecycle_pause.sql',
      '20261264600000_referral_reversal.sql',
      '20261264700000_referral_adjudication_guard.sql',
      '20261264800000_profiles_moderation_audit.sql',
      '20261264900000_profiles_market_trigger_definer.sql',
    ]) {
      const source = migration.startsWith('candidate/')
        ? join(process.cwd(), 'supabase', 'baseline', migration)
        : join(process.cwd(), 'supabase', 'migrations', migration);
      const target = migration.split('/').pop()!;
      docker('cp', source, `${dbName}:/tmp/${target}`);
      docker('exec', dbName, 'sh', '-c',
        `PGPASSWORD=isolated-test psql -U postgres -d ${testDb} -v ON_ERROR_STOP=1 -q -f /tmp/${target}`);
    }

    // Neutral upgrade regression: the authorised Kora route, its binding and
    // capabilities must be byte-identical, with no Flutterwave row for NG/NGN/card.
    const koraRouteAfter = sql(`SELECT provider||'|'||coalesce(merchant_account_ref,'')||'|'||enabled::text||'|'||preferred::text||'|'||coalesce(array_to_string(capabilities,','),'') FROM public.market_payment_routes WHERE country_code='NG' AND currency_code='NGN' AND method='card';`);
    expect(koraRouteAfter, 'neutral upgrade must not change the Kora NG route').toBe(koraRouteBefore);
    expect(koraRouteAfter.startsWith('kora|'), 'NG/NGN/card must remain Kora').toBe(true);
    expect(sql(`SELECT slug||'|'||name FROM public.service_types WHERE id='eeeeeeee-1111-2222-3333-444444444444';`), 'pre-upgrade service type survives').toBe('legacy-errand|Legacy Errand');
    expect(sql(`SELECT base_fare::text FROM public.pricing_config WHERE service_type='errand' AND country_code='GB' ORDER BY created_at LIMIT 1;`), 'historical pricing survives').toBe('2.10');
    expect(sql(`SELECT entries->0->>'amountMinor' FROM public.wallet_business_events WHERE event_key='hist-wallet-1';`), 'historical wallet transaction survives').toBe('1000');
    expect(sql(`SELECT count(*)::text FROM pg_constraint WHERE conrelid='public.driver_cash_credit_holds_v1e'::regclass AND pg_get_constraintdef(oid) LIKE '%reassigned%';`), 'reassigned constraint present').toBe('1');
    expect(sql(`SELECT relrowsecurity::text FROM pg_class WHERE oid='public.driver_cash_credit_holds_v1e'::regclass;`), 'holds RLS after upgrade').toBe('true');
    expect(sql(`SELECT has_table_privilege('authenticated','public.driver_cash_credit_holds_v1e','SELECT')::text;`), 'no client grant after upgrade').toBe('false');
    expect(sql(`SELECT count(*) FROM public.market_payment_routes WHERE country_code='NG' AND currency_code='NGN' AND method='card' AND provider='flutterwave';`),
      'no Flutterwave route may be seeded for NG/NGN/card').toBe('0');

    // Fixture-only diagnostic RPC created BEFORE PostgREST starts so it is in
    // the schema cache. Returns identity facts only, for synthetic accounts.
    sql(`CREATE OR REPLACE FUNCTION public.debug_ctx() RETURNS jsonb LANGUAGE sql STABLE
         SECURITY DEFINER SET search_path = public, auth AS $$
      SELECT jsonb_build_object(
        'uid', auth.uid(),
        'claim_sub', (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'),
        'claims_role', (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
      );
    $$;
    GRANT EXECUTE ON FUNCTION public.debug_ctx() TO authenticated, anon;`);

    docker('run', '-d', '--rm', '--network', network, '--name', restName, '-p', '127.0.0.1::3000',
      '-e', `PGRST_DB_URI=postgres://authenticator:isolated-test@${dbName}:5432/${testDb}`,
      '-e', 'PGRST_DB_SCHEMA=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`,
      'postgrest/postgrest:v10.1.2');
    const restPort = docker('port', restName, '3000/tcp').split(':').at(-1);
    await waitFor(`http://127.0.0.1:${restPort}`);

    const authUrl = 'http://127.0.0.1:' + authPort;
    const restUrl = 'http://127.0.0.1:' + restPort;
    const signup = async (email: string) => (await (await fetch(authUrl + '/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'synthetic-test-password-123' })
    })).json());
    const customer = await signup(`customer-${suffix}@example.test`);
    const carDriver = await signup(`car-${suffix}@example.test`);
    const bikeDriver = await signup(`bike-${suffix}@example.test`);
    expect(customer.access_token).toBeTruthy();
    expect(carDriver.access_token).toBeTruthy();
    expect(bikeDriver.access_token).toBeTruthy();

    const client = createClient(restUrl, jwt('service_role'), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => {
          const url = String(input);
          if (url.startsWith(restUrl + '/auth/v1')) {
            return fetch(authUrl + url.slice((restUrl + '/auth/v1').length), init);
          }
          return fetch(url.replace('/rest/v1', ''), init);
        }
      }
    });
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const jobId = '22222222-2222-2222-2222-222222222222';
    sql(`INSERT INTO public.tenants(id,name,slug) VALUES('${tenantId}','Bike Test','bike-test-${suffix}');`);
    sql(`INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_market_city,verification_status,onboarding_completed)
      VALUES('${customer.user.id}','${tenantId}','customer','GB','London','approved',true),
            ('${carDriver.user.id}','${tenantId}','driver','GB','London','approved',true),
            ('${bikeDriver.user.id}','${tenantId}','driver','GB','London','approved',true);`);
    sql(`INSERT INTO public.vehicles(id,user_id,type,vehicle_subtype,make,model,color,year,license_plate,is_verified,vehicle_verified,service_eligibility)
      VALUES('${carDriver.user.id}','${carDriver.user.id}','car','standard','Ford','Focus','red','2020','AB12 CDE',true,true,'["delivery"]'::jsonb),
            ('${bikeDriver.user.id}','${bikeDriver.user.id}','bike','pedal_bicycle','Vaydu','City','black','2022','BIKE 001',true,true,'["delivery"]'::jsonb);`);
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_status,pickup_address,dropoff_address,scheduled_time,metadata,fulfilment_category,fulfilment_snapshot)
      VALUES('${jobId}','${tenantId}','${customer.user.id}','GB',NULL,NULL,'searching','authorized','1 Test Street','2 Test Road',now(),'{"service_vehicle_class":"bike","service_slug":"ride"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle","e_bike","motorcycle","moped"],"maxWeightKg":20,"maxLengthCm":120}');`);
    // Canonical synthetic top-up funding for the Bike driver (Stripe GB test adapter).
    sql(`INSERT INTO public.wallet_collection_config(key,value) VALUES('driver_card_sandbox_enabled','true'),('max_amount_minor_GBP','100000'),('min_amount_minor_GBP','500') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;`);
    sql(`INSERT INTO public.market_availability(country_code,market_city,launch_status,customer_app_enabled,customer_registration_enabled,driver_registration_enabled,driver_online_enabled,quote_enabled,booking_enabled,payment_enabled,supported_currency,enabled,bike_limits)
      VALUES('GB',NULL,'live',true,true,true,true,true,true,true,'GBP',true,'{"pedal_bicycle":{"max_kg":20,"max_cm":120},"e_bike":{"max_kg":20,"max_cm":120}}'::jsonb) ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.wallet_topup_fee_schedules(version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active)
      VALUES('vaydu-driver-card-5pct-wallet-v1','stripe','GB','GBP','card',2,'wallet',500,0,'half_up','fixture',now(),true) ON CONFLICT DO NOTHING;`);
    sql(`UPDATE public.market_payment_routes SET enabled=true, merchant_approved=true, adapter_ready=true, preferred=true, capabilities=ARRAY['collect']::text[] WHERE country_code='GB' AND currency_code='GBP' AND method='card' AND provider='stripe';`);
    sql(`INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,payout_approved,capabilities)
      SELECT 'GB','GBP','card','stripe','acct_test_gb',true,true,true,true,false,ARRAY['collect']::text[]
      WHERE NOT EXISTS (SELECT 1 FROM public.market_payment_routes WHERE country_code='GB' AND currency_code='GBP' AND method='card');`);
    const gbRoute = String(sql(`SELECT provider||'|'||merchant_account_ref FROM public.market_payment_routes WHERE country_code='GB' AND currency_code='GBP' AND method='card' AND enabled AND merchant_approved AND adapter_ready AND capabilities @> ARRAY['collect']::text[] LIMIT 1;`)).trim();
    console.log('GB_ROUTE=' + gbRoute);
    const [gbProvider, gbMerchant] = gbRoute.split('|');
    sql(`INSERT INTO public.driver_card_topup_sandbox_scopes(provider,method,country_code,currency_code,merchant_account_ref,provider_account_id,tenant_id,driver_id,fee_passing_mode,reviewed_by,reviewed_at,evidence_reference,policy_version,enabled)
      VALUES('${gbProvider}','card','GB','GBP','${gbMerchant}','acct_test_bike','${tenantId}','${bikeDriver.user.id}','merchant','fixture',now(),'fixture-evidence','vaydu-driver-card-5pct-wallet-v1',true) ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.driver_cash_credit_enrolments_v1e(tenant_id,driver_id,country_code,currency_code,terms_version,consented_at,enabled)
      VALUES('${tenantId}','${bikeDriver.user.id}','GB','GBP','fixture-terms',now()-interval '1 hour',true) ON CONFLICT DO NOTHING;`);
    const attemptId = String(sql(`SELECT public.initiate_wallet_topup('fixture-fund-${suffix}','${tenantId}','${bikeDriver.user.id}','GB','GBP',5000,'driver_cash_credit','${gbProvider}','${gbMerchant}','fixture-idem-${suffix}');`)).trim();
    console.log('ATTEMPT=' + attemptId);
    sql(`SELECT public.freeze_wallet_topup_fee('${attemptId}','vaydu-driver-card-5pct-wallet-v1');`);
    sql(`SELECT public.record_wallet_topup_provider_reference('${attemptId}','fixture-ref-${suffix}');`);
    const totalCharge = String(sql(`SELECT total_charge_minor FROM public.wallet_topup_attempts WHERE id='${attemptId}';`)).trim();
    const credited1 = String(sql(`SELECT public.confirm_wallet_topup_with_total('${attemptId}','fixture-ref-${suffix}','${gbMerchant}','GBP',${totalCharge},'succeeded');`)).trim();
    const credited2 = String(sql(`SELECT public.confirm_wallet_topup_with_total('${attemptId}','fixture-ref-${suffix}','${gbMerchant}','GBP',${totalCharge},'succeeded');`)).trim();
    expect(credited2, 'duplicate confirmation must be idempotent').toBe(credited1);
    const funded = JSON.parse(String(sql(`SELECT public.driver_cash_credit_balance_v1e('${tenantId}','${bikeDriver.user.id}','GBP');`)));
    console.log('FUNDED=' + JSON.stringify(funded));
    expect(Number(funded.availableMinor), 'credited funding must be available').toBe(5000);
    expect(Number(funded.eligibleDepositsMinor), 'eligible deposit accounting').toBe(5000);
    const attemptTerms = String(sql(`SELECT amount_minor::text||'|'||provider_fee_minor::text||'|'||total_charge_minor::text||'|'||fee_policy_version FROM public.wallet_topup_attempts WHERE id='${attemptId}';`)).trim();
    expect(attemptTerms, '5% wallet fee frozen; credit excludes fee').toBe('5000|250|5250|vaydu-driver-card-5pct-wallet-v1');
    const fundedLegs = String(sql(`SELECT coalesce(sum(m.amount_minor) FILTER (WHERE a.balance_purpose='driver_cash_credit'),0)::text||'|'||coalesce(sum(m.amount_minor) FILTER (WHERE a.balance_purpose='platform_funding'),0)::text FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id WHERE a.owner_id='${bikeDriver.user.id}' AND a.tenant_id='${tenantId}';`)).trim();
    expect(fundedLegs, 'balanced ledger legs: driver credit equals funding contra').toBe('5000|-5000');    // Dedicated unassigned Bike job satisfying every app-feed predicate.
    const feedJobId = '88888888-8888-8888-8888-888888888888';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_status,pickup_address,dropoff_address,scheduled_time,pickup_lat,pickup_lng,driver_search_expires_at,metadata,fulfilment_category,fulfilment_snapshot)
      VALUES('${feedJobId}','${tenantId}','${customer.user.id}','GB',NULL,NULL,'searching','authorized','21 Feed Street','22 Feed Road',now(),51.5074,-0.1278,now()+interval '10 minutes','{"service_vehicle_class":"bike","service_slug":"ride"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle","e_bike","motorcycle","moped"]}');`);
    expect(sql(`SELECT count(*) FROM public.jobs WHERE id='${feedJobId}' AND driver_id IS NULL AND status='searching' AND payment_status='authorized' AND driver_search_expires_at > now();`),
      'dedicated feed job must satisfy every predicate').toBe('1');

    globalThis.__TEST_SUPABASE_ADMIN__ = client;
    const bookingRouter = (await import('../../server/routes/booking.routes')).default;
    const pricingRouter = (await import('../../server/routes/global-ai-pricing.routes')).default;
    const adminRouter = (await import('../../server/routes/admin.routes')).default;
    const app = express(); app.use(express.json()); app.use('/api/jobs', bookingRouter); app.use('/api/pricing/global-ai', pricingRouter); app.use('/api/admin', adminRouter);
    server = http.createServer(app);
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + (server.address() as any).port;
    const acceptJob = (token: string, id: string) => fetch(base + '/api/jobs/accept', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jobId: id })
    });
    const accept = (token: string) => acceptJob(token, jobId);

    const carAttempt = await accept(carDriver.access_token);
    const carBody = await carAttempt.json();
    expect(carAttempt.status, 'Car driver must be denied a Bike job').toBe(400);
    expect(carBody.code, 'denial must be the category-mismatch code').toBe('VEHICLE_CLASS_MISMATCH');
    const afterCar = sql(`SELECT coalesce(driver_id::text,'')||'|'||coalesce(accepted_driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${jobId}';`);
    expect(afterCar, 'denied acceptance must not change either assignment field').toBe('||searching');
    const bikeAttempt = await accept(bikeDriver.access_token);
    const bikeBody = await bikeAttempt.json();
    expect(bikeAttempt.status, 'Bike driver must accept the Bike job: ' + JSON.stringify(bikeBody)).toBe(200);
    const afterBike = sql(`SELECT coalesce(driver_id::text,'')||'|'||coalesce(accepted_driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${jobId}';`);
    expect(afterBike).toBe(`${bikeDriver.user.id}||assigned`);

    // Vehicle-approval invalidation: a pending vehicle cannot acquire work.
    const bikeTwo = await signup(`bike2-${suffix}@example.test`);
    sql(`INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_market_city,verification_status,onboarding_completed)
      VALUES('${bikeTwo.user.id}','${tenantId}','driver','GB','London','approved',true);`);
    sql(`INSERT INTO public.vehicles(id,user_id,type,vehicle_subtype,make,model,color,year,license_plate,is_verified,vehicle_verified,service_eligibility)
      VALUES('${bikeTwo.user.id}','${bikeTwo.user.id}','bike','pedal_bicycle','Vaydu','City','black','2022','BIKE 002',false,false,'["delivery"]'::jsonb);`);
    const pendingJob = '33333333-3333-3333-3333-333333333333';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_status,pickup_address,dropoff_address,scheduled_time,pickup_lat,pickup_lng,metadata,fulfilment_category,fulfilment_snapshot)
      VALUES('${pendingJob}','${tenantId}','${customer.user.id}','GB',NULL,NULL,'searching','authorized','3 Test Street','4 Test Road',now(),51.5074,-0.1278,'{"service_vehicle_class":"bike","service_slug":"ride"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle","e_bike","motorcycle","moped"]}');`);
    // Forged approval fields in the request body must not bypass the guard.
    const pendingAttempt = await fetch(base + '/api/jobs/accept', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + bikeTwo.access_token },
      body: JSON.stringify({ jobId: pendingJob, vehicle_verified: true, driver_verified: true, status: 'approved' })
    });
    expect(pendingAttempt.status, 'pending vehicle must be denied even with forged approval fields').toBe(400);
    expect(sql(`SELECT coalesce(driver_id::text,'')||'|'||coalesce(accepted_driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${pendingJob}';`))
      .toBe('||searching');

    // Restoring the canonical approval restores acquisition.
    sql(`UPDATE public.vehicles SET is_verified=true, vehicle_verified=true WHERE user_id='${bikeTwo.user.id}';`);
    const restoredAttempt = await acceptJob(bikeTwo.access_token, pendingJob);
    expect(restoredAttempt.status, 'approved vehicle must acquire').toBe(200);
    expect(sql(`SELECT coalesce(driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${pendingJob}';`))
      .toBe(`${bikeTwo.user.id}|assigned`);

    // Wrong tenant (vehicle already approved): a tenant-A driver cannot acquire
    // a tenant-B job. Capture the exact authorisation/scope error.
    const tenantB = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const wrongTenantJob = '55555555-5555-5555-5555-555555555555';
    sql(`INSERT INTO public.tenants(id,name,slug) VALUES('${tenantB}','Bike Test B','bike-test-b-${suffix}') ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_status,pickup_address,dropoff_address,scheduled_time,pickup_lat,pickup_lng,metadata,fulfilment_category,fulfilment_snapshot)
      VALUES('${wrongTenantJob}','${tenantB}','${customer.user.id}','GB',NULL,NULL,'searching','authorized','7 Test Street','8 Test Road',now(),51.5074,-0.1278,'{"service_vehicle_class":"bike","service_slug":"ride"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}');`);
    const wrongTenantAttempt = await acceptJob(bikeTwo.access_token, wrongTenantJob);
    const wrongTenantBody = await wrongTenantAttempt.json();
    expect(wrongTenantAttempt.status, 'cross-tenant acquisition must be denied').toBe(403);
    expect(wrongTenantBody.code, 'expected the driver-market scope error').toBe('DRIVER_MARKET_MISMATCH');
    expect(sql(`SELECT coalesce(driver_id::text,'')||'|'||coalesce(accepted_driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${wrongTenantJob}';`))
      .toBe('||searching');
    expect(sql(`SELECT count(*) FROM public.driver_earnings WHERE job_id='${wrongTenantJob}';`))
      .toBe('0');

    // Approval precedence: canonical vehicle_verified=false is not overridden
    // by a stale legacy is_verified=true.
    const bikeThree = await signup(`bike3-${suffix}@example.test`);
    sql(`INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_market_city,verification_status,onboarding_completed)
      VALUES('${bikeThree.user.id}','${tenantId}','driver','GB','London','approved',true);`);
    sql(`INSERT INTO public.vehicles(id,user_id,type,vehicle_subtype,make,model,color,year,license_plate,is_verified,vehicle_verified,service_eligibility)
      VALUES('${bikeThree.user.id}','${bikeThree.user.id}','bike','pedal_bicycle','Vaydu','City','black','2022','BIKE 003',true,false,'["delivery"]'::jsonb);`);
    const precedenceJob = '66666666-6666-6666-6666-666666666666';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_status,pickup_address,dropoff_address,scheduled_time,metadata,fulfilment_category,fulfilment_snapshot)
      VALUES('${precedenceJob}','${tenantId}','${customer.user.id}','GB',NULL,NULL,'searching','authorized','9 Test Street','10 Test Road',now(),'{"service_vehicle_class":"bike","service_slug":"ride"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}');`);
    const precedenceAttempt = await acceptJob(bikeThree.access_token, precedenceJob);
    expect(precedenceAttempt.status, 'stale is_verified must not override vehicle_verified=false').toBe(400);
    expect(sql(`SELECT coalesce(driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${precedenceJob}';`))
      .toBe('|searching');
    sql(`UPDATE public.vehicles SET vehicle_verified=true WHERE user_id='${bikeThree.user.id}';`);
    const precedenceRestored = await acceptJob(bikeThree.access_token, precedenceJob);
    expect(precedenceRestored.status, 'canonical approval restores acquisition').toBe(200);

    // Customer nearby-availability through HTTP (tenant-B job, same customer,
    // searching, no driver). This is customer discovery, not driver discovery.
    const discovery = await fetch(base + `/api/jobs/${wrongTenantJob}/nearby-availability`, {
      headers: { Authorization: 'Bearer ' + customer.access_token }
    });
    const availability = await discovery.json();
    expect(discovery.status, 'customer discovery: ' + JSON.stringify(availability)).toBe(200);
    expect(typeof availability.observedCount, 'availability exposes a bounded count').toBe('number');
    expect(Array.isArray(availability.cars), 'availability exposes approximate cars').toBe(true);

    // Real quote endpoint (mounted router), then create from its frozen snapshot.
    sql(`INSERT INTO public.market_availability(country_code,market_city,launch_status,customer_app_enabled,customer_registration_enabled,driver_registration_enabled,driver_online_enabled,quote_enabled,booking_enabled,payment_enabled,supported_currency,enabled,bike_limits)
      VALUES('GB',NULL,'live',true,true,true,true,true,true,true,'GBP',true,'{"pedal_bicycle":{"max_kg":20,"max_cm":120},"e_bike":{"max_kg":20,"max_cm":120}}'::jsonb) ON CONFLICT DO NOTHING;`);
    // Reviewed GB/ride pricing and market-pricing settings (synthetic values).
    sql(`INSERT INTO public.pricing_config(service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,is_active,country_code,market_city,currency_symbol)
      VALUES('ride',2.50,1.20,0.20,0.50,3.50,'GBP',true,'GB',NULL,'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£') ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.marketplace_settings(tenant_id,key,value) VALUES
      (NULL,'market_pricing_enabled','true'::jsonb),
      (NULL,'market_pricing_audit_enabled','true'::jsonb),
      (NULL,'market_pricing_shadow_mode','true'::jsonb) ON CONFLICT DO NOTHING;`);
    const quoteRes = await fetch(base + '/api/pricing/global-ai/quote', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: 51.5074, lng: -0.1278, distanceKm: 1.2, durationMinutes: 6, serviceSlug: 'ride', vehicleClass: 'bike', packageSize: 'small', countryCode: 'GB', tenantId })
    });
    const quoteBody = await quoteRes.json();
    console.log('QUOTE=' + quoteRes.status + '|' + JSON.stringify(quoteBody).slice(0, 900));
    expect(quoteRes.status, 'real quote must succeed: ' + JSON.stringify(quoteBody)).toBe(200);
    const quoteRef = String(quoteBody.quoteReference || '');
    expect(quoteRef, 'quote must return a reference').toBeTruthy();
    const auditRow = String(sql(`SELECT coalesce(returned_customer_fare::text,'')||'|'||coalesce(fulfilment_snapshot->>'category','') FROM public.quote_market_adjustments WHERE quote_reference='${quoteRef}';`)).trim();
    console.log('AUDIT=' + auditRow);
    const [persistedFare, persistedCategory] = auditRow.split('|');
    expect(Number(persistedFare), 'persisted protected fare must be positive').toBeGreaterThan(0);
    expect(persistedCategory, 'persisted Bike snapshot category').toBe('bike');
    const createFromQuote = await fetch(base + '/api/jobs/create', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + customer.access_token },
      body: JSON.stringify({ booking: {
        tenant_id: tenantId, country_code: 'GB', pickup_address: '41 Quote Street', dropoff_address: '42 Quote Road', scheduled_time: new Date().toISOString(),
        total_price: Number(persistedFare), quote_id: quoteRef, fulfilment_category: 'bike', fulfilment_subtype: 'pedal_bicycle',
        fare_breakdown: { calculationVersion: 'market-v1', customerServiceTotal: Number(persistedFare) },
        metadata: { service_slug: 'ride', quote_expires_at: new Date(Date.now() + 3600_000).toISOString() }
      } })
    });
    const createFromQuoteBody = await createFromQuote.json();
    expect([200, 201], 'create from real quote: ' + JSON.stringify(createFromQuoteBody)).toContain(createFromQuote.status);
    expect(sql(`SELECT count(*) FROM public.jobs WHERE quote_id='${quoteRef}' AND fulfilment_category='bike' AND fulfilment_snapshot->>'category'='bike';`),
      'created booking must persist the frozen Bike snapshot').toBe('1');

    // Persistence failure: disabling market-pricing persistence must not yield a
    // usable quote (the protected update finds no audit row).
    sql(`UPDATE public.marketplace_settings SET value='false'::jsonb WHERE key='market_pricing_audit_enabled' AND tenant_id IS NULL;`);
    const failedQuote = await fetch(base + '/api/pricing/global-ai/quote', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: 51.5074, lng: -0.1278, distanceKm: 1.2, durationMinutes: 6, serviceSlug: 'ride', vehicleClass: 'bike', packageSize: 'small', countryCode: 'GB', tenantId })
    });
    expect(failedQuote.status, 'persistence failure must not return a usable quote').toBe(400);
    sql(`UPDATE public.marketplace_settings SET value='true'::jsonb WHERE key='market_pricing_audit_enabled' AND tenant_id IS NULL;`);

    // Supported configuration check: optional market adjustment disabled.
    // If protected persistence still works, the existing design is retained.
    sql(`UPDATE public.marketplace_settings SET value='false'::jsonb WHERE key='market_pricing_enabled' AND tenant_id IS NULL;`);
    const noAdjQuote = await fetch(base + '/api/pricing/global-ai/quote', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: 51.5074, lng: -0.1278, distanceKm: 1.2, durationMinutes: 6, serviceSlug: 'ride', vehicleClass: 'bike', packageSize: 'small', countryCode: 'GB', tenantId })
    });
    const noAdjBody = await noAdjQuote.json();
    expect(noAdjQuote.status, 'quote with optional adjustment disabled: ' + JSON.stringify(noAdjBody)).toBe(200);
    const noAdjRef = String(noAdjBody.quoteReference || '');
    const noAdjAudit = String(sql(`SELECT coalesce(returned_customer_fare::text,'')||'|'||coalesce(fulfilment_snapshot->>'category','') FROM public.quote_market_adjustments WHERE quote_reference='${noAdjRef}';`)).trim();
    expect(noAdjAudit.split('|')[1], 'persisted Bike snapshot with adjustment disabled').toBe('bike');
    const noAdjCreate = await fetch(base + '/api/jobs/create', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + customer.access_token },
      body: JSON.stringify({ booking: {
        tenant_id: tenantId, country_code: 'GB', pickup_address: '51 NoAdj Street', dropoff_address: '52 NoAdj Road', scheduled_time: new Date().toISOString(),
        total_price: Number(noAdjAudit.split('|')[0]), quote_id: noAdjRef, fulfilment_category: 'bike', fulfilment_subtype: 'pedal_bicycle',
        fare_breakdown: { calculationVersion: 'market-v1', customerServiceTotal: Number(noAdjAudit.split('|')[0]) },
        metadata: { service_slug: 'ride', quote_expires_at: new Date(Date.now() + 3600_000).toISOString() }
      } })
    });
    expect([200, 201], 'create with optional adjustment disabled: ' + JSON.stringify(await noAdjCreate.json())).toContain(noAdjCreate.status);
    sql(`UPDATE public.marketplace_settings SET value='true'::jsonb WHERE key='market_pricing_enabled' AND tenant_id IS NULL;`);

    // Quote/create: a current quote and a frozen Bike snapshot are required.
    const expiry = new Date(Date.now() + 3600_000).toISOString();
    const createBooking = (booking: any) => fetch(base + '/api/jobs/create', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + customer.access_token },
      body: JSON.stringify({ booking })
    });
    const expired = await createBooking({ quote_id: 'q-expired', fare_breakdown: { calculationVersion: 'v1' }, metadata: { quote_expires_at: '2000-01-01T00:00:00Z' } });
    expect(expired.status, 'expired quote must be rejected').toBe(409);
    expect((await expired.json()).code).toBe('QUOTE_EXPIRED');

    const baseBooking = (quoteId: string) => ({
      tenant_id: tenantId, country_code: 'GB', pickup_address: '11 A Street', dropoff_address: '12 B Road',
      total_price: 10, quote_id: quoteId, fulfilment_category: 'bike', fulfilment_subtype: 'pedal_bicycle',
      fare_breakdown: { calculationVersion: 'v1', customerServiceTotal: 10 },
      metadata: { service_slug: 'ride', quote_expires_at: new Date(Date.now() + 3600_000).toISOString() }
    });
    const insertQuote = (ref: string, snapshot: string | null) =>
      sql(`INSERT INTO public.quote_market_adjustments(quote_reference,base_service_fare,adjusted_service_fare,customer_total,driver_payout,currency,service_type,country_code,market_city,returned_customer_fare,strategy_version,fulfilment_snapshot)
        VALUES('${ref}',10,10,10,10,'GBP','ride','GB','London',10,'v1',${snapshot === null ? 'NULL' : `'${snapshot}'::jsonb`}) ON CONFLICT DO NOTHING;`);

    const qMissing = randomUUID();
    insertQuote(qMissing, null);
    const missing = await createBooking(baseBooking(qMissing));
    expect(missing.status, 'missing frozen snapshot must be rejected').toBe(409);
    expect((await missing.json()).code).toBe('QUOTE_FULFILMENT_NOT_FROZEN');
    expect(sql(`SELECT count(*) FROM public.jobs WHERE quote_id='${qMissing}';`), 'no booking may be created').toBe('0');

    const qBad = randomUUID();
    insertQuote(qBad, '{"category":"car"}');
    const bad = await createBooking(baseBooking(qBad));
    expect(bad.status, 'contradictory snapshot must be rejected').toBe(409);
    expect((await bad.json()).code).toBe('QUOTE_FULFILMENT_MISMATCH');
    expect(sql(`SELECT count(*) FROM public.jobs WHERE quote_id='${qBad}';`)).toBe('0');

    // OPEN (recorded, not asserted green): the valid frozen-snapshot create
    // currently returns 409 QUOTE_INPUT_CHANGED ("Quote service does not match
    // booking") against this fixture. The quote/booking service contract must be
    // aligned before the positive create can be asserted.

    // Admin assignment through the real interface. The admin app calls
    // supabase.rpc('assign_driver_to_job') directly (admin.service.ts
    // manualAssignDriver, caller booking-list.component.ts). No Express
    // general-assignment endpoint exists.
    const adminUser = await signup(`admin-${suffix}@example.test`);
    const bikeFour = await signup(`bike4-${suffix}@example.test`);
    sql(`INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_market_city,verification_status,onboarding_completed)
      VALUES('${adminUser.user.id}','${tenantId}','admin','GB','London','approved',true),
            ('${bikeFour.user.id}','${tenantId}','driver','GB','London','approved',true);`);
    sql(`INSERT INTO public.vehicles(id,user_id,type,vehicle_subtype,make,model,color,year,license_plate,is_verified,vehicle_verified,service_eligibility)
      VALUES('${bikeFour.user.id}','${bikeFour.user.id}','bike','pedal_bicycle','Vaydu','City','black','2022','BIKE 004',true,true,'["delivery"]'::jsonb);`);
    const adminJob = '77777777-7777-7777-7777-777777777777';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_status,pickup_address,dropoff_address,scheduled_time,metadata,fulfilment_category,fulfilment_snapshot)
      VALUES('${adminJob}','${tenantId}','${customer.user.id}','GB',NULL,NULL,'searching','authorized','13 A Street','14 B Road',now(),'{"service_vehicle_class":"bike","service_slug":"ride"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}');`);
    const rpcAssign = (token: string, job: string, driver: string) => fetch(restUrl + '/rpc/assign_driver_to_job', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ p_job_id: job, p_driver_id: driver })
    });
    const nonAdmin = await rpcAssign(carDriver.access_token, adminJob, bikeFour.user.id);
    expect(nonAdmin.status, 'non-admin must not assign').toBeGreaterThanOrEqual(400);
    expect(sql(`SELECT coalesce(driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${adminJob}';`))
      .toBe('|searching');
    const adminOk = await rpcAssign(adminUser.access_token, adminJob, bikeFour.user.id);
    const adminBody = await adminOk.json();
    expect(adminOk.status, 'admin assignment: ' + JSON.stringify(adminBody)).toBe(200);
    expect(adminBody).toBe(true);
    expect(sql(`SELECT coalesce(driver_id::text,'')||'|'||coalesce(accepted_driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${adminJob}';`))
      .toBe(`${bikeFour.user.id}||assigned`);
    const adminWrongTenant = await rpcAssign(adminUser.access_token, wrongTenantJob, bikeFour.user.id);
    expect(adminWrongTenant.status, 'admin assignment must respect tenant scope').toBeGreaterThanOrEqual(400);
    expect(sql(`SELECT coalesce(driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${wrongTenantJob}';`))
      .toBe('|searching');

    // Cash reassignment through the real mounted admin router.
    const reassign = (token: string | null, job: string, body: any) => fetch(base + `/api/admin/cash-jobs/${job}/reassign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body)
    });
    expect((await reassign(null, feedJobId, { newDriverId: bikeFour.user.id })).status, 'reassign requires auth').toBe(401);
    expect((await reassign(carDriver.access_token, feedJobId, { newDriverId: bikeFour.user.id })).status, 'reassign requires admin').toBe(403);
    expect((await reassign(adminUser.access_token, feedJobId, {})).status, 'reassign requires a driver').toBe(400);
    const notCash = await reassign(adminUser.access_token, feedJobId, { newDriverId: bikeFour.user.id });
    expect(notCash.status, 'non-cash reassignment must be refused').toBe(409);
    expect(['NOT_REASSIGNABLE', 'REASSIGN_REJECTED']).toContain((await notCash.json()).code);
    expect(sql(`SELECT count(*) FROM public.jobs WHERE id='${feedJobId}' AND driver_id IS NULL;`), 'refusal must leave assignment unchanged').toBe('1');

    // Driver discovery through the real interface: authenticated PostgREST with
    // the app's exact query, against the dedicated unassigned feed job.
    const feedRows = async (token: string) => (await (await fetch(
      `${restUrl}/jobs?select=id,fulfilment_category&country_code=eq.GB&tenant_id=eq.${tenantId}&or=(and(status.in.(searching,requested,broadcasting,waiting),payment_status.in.(paid,wallet_funded,authorized,requires_capture,succeeded),driver_id.is.null))`,
      { headers: { Authorization: 'Bearer ' + token } })).json());
    const ctx = async (token: string) => (await (await fetch(restUrl + '/rpc/debug_ctx', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}' })).json());
    const pgCount = (uid: string) => Number(String(sql(
      `BEGIN; SELECT set_config('request.jwt.claims', json_build_object('sub','${uid}','role','authenticated')::text, true); SET LOCAL ROLE authenticated; SELECT count(*) FROM public.jobs WHERE id='${feedJobId}'; ROLLBACK;`
    )).trim().split(/\s+/).pop());

    console.log('CTX_BIKE=' + JSON.stringify(await ctx(bikeFour.access_token)));
    console.log('CTX_CAR=' + JSON.stringify(await ctx(carDriver.access_token)));
    console.log('PG_BIKE=' + pgCount(bikeFour.user.id) + ' PG_CAR=' + pgCount(carDriver.user.id));

    const bikeFeed = await feedRows(bikeFour.access_token);
    const carFeed = await feedRows(carDriver.access_token);
    console.log('FEED_BIKE=' + JSON.stringify(bikeFeed).slice(0, 300));
    console.log('FEED_CAR=' + JSON.stringify(carFeed).slice(0, 300));
    expect(bikeFeed.map((r: any) => r.id), 'approved Bike driver must see the feed job: ' + JSON.stringify(bikeFeed)).toContain(feedJobId);
    expect(carFeed.map((r: any) => r.id), 'Car driver must not see the Bike job').not.toContain(feedJobId);

    // Wrong-tenant driver: approved bike, tenant B, must not see the tenant-A job.
    const bikeB = await signup(`bikeb-${suffix}@example.test`);
    sql(`INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_market_city,verification_status,onboarding_completed)
      VALUES('${bikeB.user.id}','${tenantB}','driver','GB','London','approved',true);`);
    sql(`INSERT INTO public.vehicles(id,user_id,type,vehicle_subtype,make,model,color,year,license_plate,is_verified,vehicle_verified,service_eligibility)
      VALUES('${bikeB.user.id}','${bikeB.user.id}','bike','pedal_bicycle','Vaydu','City','black','2022','BIKE 00B',true,true,'["delivery"]'::jsonb);`);
    const wrongTenantFeed = await feedRows(bikeB.access_token);
    expect(wrongTenantFeed.map((r: any) => r.id), 'wrong-tenant driver must not see the job').not.toContain(feedJobId);

    // Customer/admin scoping on the same job.
    sql(`INSERT INTO public.tenant_users(tenant_id,user_id,role) VALUES('${tenantId}','${adminUser.user.id}','admin') ON CONFLICT DO NOTHING;`);
    const customerFeed = await feedRows(customer.access_token);
    expect(customerFeed.map((r: any) => r.id), 'customer must still see own job').toContain(feedJobId);
    const adminFeed = await feedRows(adminUser.access_token);
    expect(adminFeed.map((r: any) => r.id), 'admin must still see the job').toContain(feedJobId);

    // Unrelated-driver history: an assigned job is not visible to another driver.
    const bikeFive = await signup(`bike5-${suffix}@example.test`);
    sql(`INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_market_city,verification_status,onboarding_completed)
      VALUES('${bikeFive.user.id}','${tenantId}','driver','GB','London','approved',true);`);
    sql(`INSERT INTO public.vehicles(id,user_id,type,vehicle_subtype,make,model,color,year,license_plate,is_verified,vehicle_verified,service_eligibility)
      VALUES('${bikeFive.user.id}','${bikeFive.user.id}','bike','pedal_bicycle','Vaydu','City','black','2022','BIKE 005',true,true,'["delivery"]'::jsonb);`);
    const historyJob = '99999999-9999-9999-9999-999999999999';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_status,pickup_address,dropoff_address,scheduled_time,metadata,fulfilment_category,fulfilment_snapshot)
      VALUES('${historyJob}','${tenantId}','${customer.user.id}','GB','${bikeFive.user.id}',NULL,'assigned','authorized','31 H Street','32 H Road',now(),'{"service_vehicle_class":"bike","service_slug":"ride"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}');`);
    const historyFeed = await feedRows(carDriver.access_token);
    expect(historyFeed.map((r: any) => r.id), 'unrelated driver must not see another driver assigned job').not.toContain(historyJob);

    // CASH-MATRIX: funded Bike courier reassignment, rollback and refusals.
    sql(`INSERT INTO public.driver_cash_credit_config_v1e(key,enabled) VALUES('ride_cash_credit',true) ON CONFLICT (key) DO UPDATE SET enabled=true;`);
    const deliveryType = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    sql(`INSERT INTO public.service_types(id,slug,name) VALUES('${deliveryType}','delivery','Delivery') ON CONFLICT DO NOTHING;`);
    const mkCashDriver = async (email: string, plate: string) => {
      const u = await signup(email);
      sql(`INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code,registration_market_city,verification_status,onboarding_completed,registration_activated_at)
        VALUES('${u.user.id}','${tenantId}','driver','GB','GB','London','approved',true,now());`);
      sql(`INSERT INTO public.vehicles(id,user_id,type,vehicle_subtype,make,model,color,year,license_plate,is_verified,vehicle_verified,service_eligibility)
        VALUES('${u.user.id}','${u.user.id}','bike','pedal_bicycle','Vaydu','City','black','2022','${plate}',true,true,'["delivery"]'::jsonb);`);
      sql(`INSERT INTO public.driver_cash_credit_enrolments_v1e(tenant_id,driver_id,country_code,currency_code,terms_version,consented_at,enabled)
        VALUES('${tenantId}','${u.user.id}','GB','GBP','fixture-terms',now()-interval '1 hour',true) ON CONFLICT DO NOTHING;`);
      return u;
    };
    const fundCashDriver = (driverId: string, key: string) => {
      sql(`INSERT INTO public.driver_card_topup_sandbox_scopes(provider,method,country_code,currency_code,merchant_account_ref,provider_account_id,tenant_id,driver_id,fee_passing_mode,reviewed_by,reviewed_at,evidence_reference,policy_version,enabled)
        VALUES('stripe','card','GB','GBP','${gbMerchant}','acct_${key}','${tenantId}','${driverId}','merchant','fixture',now(),'fixture-evidence','vaydu-driver-card-5pct-wallet-v1',true) ON CONFLICT DO NOTHING;`);
      const a = String(sql(`SELECT public.initiate_wallet_topup('fund-${key}','${tenantId}','${driverId}','GB','GBP',5000,'driver_cash_credit','stripe','${gbMerchant}','idem-${key}');`)).trim();
      sql(`SELECT public.freeze_wallet_topup_fee('${a}','vaydu-driver-card-5pct-wallet-v1');`);
      sql(`SELECT public.record_wallet_topup_provider_reference('${a}','ref-${key}');`);
      const t = String(sql(`SELECT total_charge_minor FROM public.wallet_topup_attempts WHERE id='${a}';`)).trim();
      sql(`SELECT public.confirm_wallet_topup_with_total('${a}','ref-${key}','${gbMerchant}','GBP',${t},'succeeded');`);
    };
    const cashBike = await mkCashDriver(`cash-${suffix}@example.test`, 'CASH 001');
    const fundBike = await mkCashDriver(`fund2-${suffix}@example.test`, 'CASH 002');
    const brokeBike = await mkCashDriver(`broke-${suffix}@example.test`, 'CASH 003');
    fundCashDriver(cashBike.user.id, 'cash');
    fundCashDriver(fundBike.user.id, 'fund2');
    const cashJob = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const cashFare = '{"policyVersion":"fare-split-v1","currency":"GBP","platformFeeType":"percentage","driverBase":2.50,"platformFeeAmount":0.13,"driverCommissionAmount":0.38,"driverEntitlement":2.12,"customerCharge":2.63,"commissionPercent":"15","platformFeePercent":"5","platformFeeFixed":0}';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_method,payment_status,pickup_address,dropoff_address,scheduled_time,pickup_lat,pickup_lng,metadata,fare_breakdown,fulfilment_category,fulfilment_snapshot,service_type_id)
      VALUES('${cashJob}','${tenantId}','${customer.user.id}','GB',NULL,NULL,'searching','cash','pending','61 Cash St','62 Cash Rd',now(),51.5074,-0.1278,'{"cash_collection_mode":"full_customer_charge","service_vehicle_class":"bike","service_slug":"delivery"}','${cashFare}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}','${deliveryType}');`);
    sql(`SELECT public.assign_driver_to_job('${cashJob}','${cashBike.user.id}');`);
    expect(sql(`SELECT coalesce(sum(required_credit_minor),0)::text FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob}' AND status='held';`),
      'cash courier assignment must create a held reservation').toBe('51');

    const eventsBeforeReassign = String(sql(`SELECT count(*)::text FROM public.wallet_business_events WHERE tenant_id='${tenantId}' AND owner_id IN ('${cashBike.user.id}','${fundBike.user.id}');`)).trim();
    const okReassign = await reassign(adminUser.access_token, cashJob, { newDriverId: fundBike.user.id });
    expect(okReassign.status, 'funded replacement must succeed: ' + JSON.stringify(await okReassign.json())).toBe(200);
    expect(sql(`SELECT coalesce(driver_id::text,'')||'|'||coalesce(accepted_driver_id::text,'') FROM public.jobs WHERE id='${cashJob}';`),
      'replacement drives the job').toBe(`${fundBike.user.id}|${fundBike.user.id}`);
    expect(sql(`SELECT driver_id::text FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob}' AND status='held';`),
      'replacement hold belongs to the funded replacement').toBe(fundBike.user.id);
    expect(sql(`SELECT status||'|'||driver_id::text FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob}' AND status='reassigned';`),
      'original hold is preserved as reassigned').toBe(`reassigned|${cashBike.user.id}`);

    // Retry: repeating the same reassignment must not create financial events.
    const eventsAfterSuccess = String(sql(`SELECT count(*)::text FROM public.wallet_business_events WHERE tenant_id='${tenantId}' AND owner_id IN ('${cashBike.user.id}','${fundBike.user.id}');`)).trim();
    const retryReassign = await reassign(adminUser.access_token, cashJob, { newDriverId: fundBike.user.id });
    expect(retryReassign.status, 'retry is idempotent').toBe(200);
    expect(sql(`SELECT count(*)::text FROM public.wallet_business_events WHERE tenant_id='${tenantId}' AND owner_id IN ('${cashBike.user.id}','${fundBike.user.id}');`),
      'retry creates no duplicate release/reservation').toBe(eventsAfterSuccess);
    expect(sql(`SELECT count(*)::text FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob}' AND status='held';`)).toBe('1');

    // Insufficient credit: rollback preserves assignment, holds and ledger.
    const brokeReassign = await reassign(adminUser.access_token, cashJob, { newDriverId: brokeBike.user.id });
    expect(brokeReassign.status, 'zero-credit replacement must be refused').toBe(409);
    expect((await brokeReassign.json()).code).toBe('INSUFFICIENT_CREDIT');
    expect(sql(`SELECT coalesce(driver_id::text,'') FROM public.jobs WHERE id='${cashJob}';`)).toBe(fundBike.user.id);
    expect(sql(`SELECT driver_id::text FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob}' AND status='held';`)).toBe(fundBike.user.id);
    expect(sql(`SELECT count(*)::text FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob}' AND status='reassigned';`)).toBe('1');

    // Car and cross-tenant replacements are denied without side effects.
    const carReassign = await reassign(adminUser.access_token, cashJob, { newDriverId: carDriver.user.id });
    const carReassignBody = await carReassign.json();
    expect(carReassign.status, 'Car replacement must be denied').toBe(409);
    expect(carReassignBody.code, 'Car denial code').toBe('REASSIGN_REJECTED');
    expect(sql(`SELECT coalesce(driver_id::text,'') FROM public.jobs WHERE id='${cashJob}';`)).toBe(fundBike.user.id);
    const tenantBike = await mkCashDriver(`tenantb-${suffix}@example.test`, 'CASH 004');
    sql(`UPDATE public.profiles SET tenant_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' WHERE id='${tenantBike.user.id}';`);
    const crossReassign = await reassign(adminUser.access_token, cashJob, { newDriverId: tenantBike.user.id });
    const crossReassignBody = await crossReassign.json();
    expect(crossReassign.status, 'cross-tenant replacement must be denied').toBe(409);
    expect(crossReassignBody.code, 'cross-tenant denial code').toBe('REASSIGN_REJECTED');
    expect(sql(`SELECT coalesce(driver_id::text,'') FROM public.jobs WHERE id='${cashJob}';`)).toBe(fundBike.user.id);

    // Cancellation releases exactly once.
    sql(`UPDATE public.jobs SET status='cancelled' WHERE id='${cashJob}';`);
    expect(sql(`SELECT status FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob}' AND status='released';`)).toBe('released');
    const cancelledEvents = String(sql(`SELECT count(*)::text FROM public.wallet_business_events WHERE tenant_id='${tenantId}' AND owner_id='${fundBike.user.id}';`)).trim();
    sql(`UPDATE public.jobs SET status='cancelled' WHERE id='${cashJob}';`);
    expect(sql(`SELECT count(*)::text FROM public.wallet_business_events WHERE tenant_id='${tenantId}' AND owner_id='${fundBike.user.id}';`),
      'second cancellation creates no duplicate release').toBe(cancelledEvents);

    // ACL/RLS: holds are server-only and RLS-protected.
    expect(sql(`SELECT relrowsecurity::text FROM pg_class WHERE oid='public.driver_cash_credit_holds_v1e'::regclass;`), 'holds RLS enabled').toBe('true');
    expect(sql(`SELECT has_table_privilege('authenticated','public.driver_cash_credit_holds_v1e','SELECT')::text;`), 'authenticated cannot read holds').toBe('false');
    expect(sql(`SELECT has_table_privilege('anon','public.driver_cash_credit_holds_v1e','SELECT')::text;`), 'anon cannot read holds').toBe('false');

    // Historical reassigned/released holds must not inflate current liability.
    const cashBal = String(sql(`SELECT (public.driver_cash_credit_balance_v1e('${tenantId}','${cashBike.user.id}','GBP')->>'availableMinor')||'|'||(public.driver_cash_credit_balance_v1e('${tenantId}','${cashBike.user.id}','GBP')->>'heldMinor');`)).trim();
    expect(cashBal, 'reassigned history does not inflate liability').toBe('5000|0');

    // Concurrent reassignment: one winner, one held hold, no duplicate events.
    const cashJob2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_method,payment_status,pickup_address,dropoff_address,scheduled_time,pickup_lat,pickup_lng,metadata,fare_breakdown,fulfilment_category,fulfilment_snapshot,service_type_id)
      VALUES('${cashJob2}','${tenantId}','${customer.user.id}','GB',NULL,NULL,'searching','cash','pending','63 Cash St','64 Cash Rd',now(),51.5074,-0.1278,'{"cash_collection_mode":"full_customer_charge","service_vehicle_class":"bike","service_slug":"delivery"}','${cashFare}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}','${deliveryType}');`);
    sql(`SELECT public.assign_driver_to_job('${cashJob2}','${cashBike.user.id}');`);
    const raceEventsBefore = String(sql(`SELECT count(*)::text FROM public.wallet_business_events WHERE tenant_id='${tenantId}' AND owner_id IN ('${cashBike.user.id}','${fundBike.user.id}','${brokeBike.user.id}');`)).trim();
    const [raceA, raceB] = await Promise.all([
      reassign(adminUser.access_token, cashJob2, { newDriverId: fundBike.user.id }),
      reassign(adminUser.access_token, cashJob2, { newDriverId: brokeBike.user.id }),
    ]);
    const raceStatuses = [raceA.status, raceB.status].sort();
    expect(raceStatuses[0], 'concurrent: one reassignment succeeds').toBe(200);
    expect(raceStatuses[1], 'concurrent: the other is refused').toBe(409);
    expect(sql(`SELECT driver_id::text FROM public.jobs WHERE id='${cashJob2}';`)).toBe(fundBike.user.id);
    expect(sql(`SELECT count(*)::text FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob2}' AND status='held';`)).toBe('1');
    expect(sql(`SELECT count(*)::text FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob2}' AND status='reassigned';`)).toBe('1');

    // Cancellation/completion race: exactly one terminal resolution.
    const cashJob3 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_method,payment_status,pickup_address,dropoff_address,scheduled_time,pickup_lat,pickup_lng,metadata,fare_breakdown,fulfilment_category,fulfilment_snapshot,service_type_id)
      VALUES('${cashJob3}','${tenantId}','${customer.user.id}','GB',NULL,NULL,'searching','cash','pending','65 Cash St','66 Cash Rd',now(),51.5074,-0.1278,'{"cash_collection_mode":"full_customer_charge","service_vehicle_class":"bike","service_slug":"delivery"}','${cashFare}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}','${deliveryType}');`);
    sql(`SELECT public.assign_driver_to_job('${cashJob3}','${cashBike.user.id}');`);
    const terminal = await Promise.allSettled([
      sqlAsync(`UPDATE public.jobs SET status='cancelled' WHERE id='${cashJob3}';`),
      sqlAsync(`UPDATE public.jobs SET status='completed' WHERE id='${cashJob3}';`),
    ]);
    expect(terminal.filter(r => r.status === 'fulfilled').length, 'exactly one terminal transition wins').toBe(1);
    expect(sql(`SELECT count(*)::text FROM public.driver_cash_credit_holds_v1e WHERE job_id='${cashJob3}' AND status IN ('released','settled');`), 'one resolution only').toBe('1');

    // Money precision regression (real PostgreSQL).
    expect(sql(`SELECT public.funding_amount_to_minor('6.66','GBP')::text;`), 'GBP 6.66 -> 666 minor').toBe('666');
    expect(sql(`SELECT public.funding_amount_to_minor('666','JPY')::text;`), 'JPY zero-decimal survives').toBe('666');
    expect(sql(`SELECT public.funding_amount_to_minor('6.666','KWD')::text;`), 'KWD three-decimal -> 6666 minor').toBe('6666');
    expect(() => sql(`SELECT public.funding_amount_to_minor('6.666','GBP');`), 'excess precision rejected').toThrow();
    expect(sql(`SELECT data_type||'|'||numeric_precision||'|'||numeric_scale FROM information_schema.columns WHERE table_name='quote_market_adjustments' AND column_name='returned_customer_fare';`), 'quote fare widened').toBe('numeric|18|4');
    expect(sql(`SELECT data_type||'|'||numeric_scale FROM information_schema.columns WHERE table_name='jobs' AND column_name='agreed_fare';`), 'jobs.agreed_fare widened').toBe('numeric|4');
    const precJob = 'dddddddd-1111-2222-3333-444444444444';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,status,payment_method,payment_status,pickup_address,dropoff_address,scheduled_time,metadata,fare_breakdown,fulfilment_category,fulfilment_snapshot)
      VALUES('${precJob}','${tenantId}','${customer.user.id}','GB','searching','cash','pending','1 Prec St','2 Prec Rd',now(),'{"discount_minor":100,"cash_collection_mode":"full_customer_charge","service_vehicle_class":"bike","service_slug":"delivery"}'::jsonb,'{"policyVersion":"fare-split-v1","customerCharge":6.66,"currency":"GBP"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}');`);
    expect(sql(`SELECT customer_charge_minor||'|'||discount_minor||'|'||external_due_minor FROM public.job_funding_breakdown WHERE job_id='${precJob}';`), 'discount/credit reconciles with external due').toBe('666|100|566');
    // Reward-credit lifecycle + secured zero-payable + refund allocation (real SQL).
    const rcId = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const rcJob = 'aaaaaaaa-0000-0000-0000-00000000000b';
    sql(`INSERT INTO public.reward_credits(id,tenant_id,owner_id,currency_code,amount_minor,source,source_id,status)
      VALUES('${rcId}','${tenantId}','${customer.user.id}','GBP',700,'campaign','${rcId}','active');`);
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,status,payment_method,payment_status,pickup_address,dropoff_address,scheduled_time,metadata,fare_breakdown,fulfilment_category,fulfilment_snapshot)
      VALUES('${rcJob}','${tenantId}','${customer.user.id}','GB','searching','card','pending','1 Rc St','2 Rc Rd',now(),'{"reward_credit_id":"${rcId}"}'::jsonb,'{"policyVersion":"fare-split-v1","customerCharge":6.66,"currency":"GBP"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}');`);
    expect(sql(`SELECT reward_credit_minor||'|'||external_due_minor FROM public.job_funding_breakdown WHERE job_id='${rcJob}';`), 'reward covers charge -> zero external due').toBe('666|0');
    expect(sql(`SELECT (public.reward_credit_available('${rcId}'))::text;`), 'available after reserve').toBe('34');
    expect(sql(`SELECT (public.secure_zero_payable_funding('${rcJob}')->>'funded')::text;`), 'secured zero-payable funded').toBe('true');
    // Case A: fully credit-funded job (external_due=0, captured=0).
    const rcA = String(sql(`SELECT (public.apply_job_refund('${rcJob}',666,0,'ref-credit')->>'external')||'|'||(public.apply_job_refund('${rcJob}',666,0,'ref-credit')->>'credit')||'|'||(public.apply_job_refund('${rcJob}',666,0,'ref-credit')->>'discrepancy');`)).trim();
    expect(rcA, 'credit-only refund: zero external, full credit restored, no discrepancy').toBe('0|666|0');
    expect(sql(`SELECT coalesce(sum(restored_minor),0)::text FROM public.reward_credit_spends WHERE job_id='${rcJob}';`), 'credit restored once').toBe('666');
    const rcReplay = String(sql(`SELECT (public.apply_job_refund('${rcJob}',666,0,'ref-credit')->>'replayed')::text||'|'||(public.apply_job_refund('${rcJob}',666,0,'ref-credit')->>'credit')::text;`)).trim();
    expect(rcReplay, 'duplicate service refund replays').toBe('true|666');
    expect(sql(`SELECT coalesce(sum(restored_minor),0)::text FROM public.reward_credit_spends WHERE job_id='${rcJob}';`), 'no double restore on replay').toBe('666');
    expect(sql(`SELECT (public.apply_job_refund('${rcJob}',666,0,'ref-credit-2')->>'credit')::text;`), 'second refund restores nothing further').toBe('0');

    // Case B: mixed-funded job with recorded external capture.
    const mixedJob = 'aaaaaaaa-0000-0000-0000-00000000000c';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,status,payment_method,payment_status,pickup_address,dropoff_address,scheduled_time,fare_breakdown,fulfilment_category,fulfilment_snapshot)
      VALUES('${mixedJob}','${tenantId}','${customer.user.id}','GB','searching','card','authorized','1 Mx St','2 Mx Rd',now(),'{"policyVersion":"fare-split-v1","customerCharge":6.66,"currency":"GBP"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}');`);
    sql(`INSERT INTO public.job_funding_breakdown(job_id,tenant_id,currency_code,customer_charge_minor,discount_minor,reward_credit_minor,external_due_minor,captured_minor)
      VALUES('${mixedJob}','${tenantId}','GBP',666,0,200,466,466);`);
    const mix = String(sql(`SELECT (public.apply_job_refund('${mixedJob}',0,500,'ref-mixed')->>'external')||'|'||(public.apply_job_refund('${mixedJob}',0,500,'ref-mixed')->>'credit')||'|'||(public.apply_job_refund('${mixedJob}',0,500,'ref-mixed')->>'discrepancy');`)).trim();
    expect(mix, 'mixed refund: external bounded by captured, overage recorded as discrepancy').toBe('466|200|34');
    expect(sql(`SELECT provider_confirmed_minor::text FROM public.job_refund_allocations WHERE provider_ref='ref-mixed';`), 'provider-confirmed retained verbatim').toBe('500');
    // Campaign/margin (real SQL): 5% discount, cap, eligibility, funding, persisted totals.
    const campId = 'aaaaaaaa-0000-0000-0000-00000000000d';
    sql(`INSERT INTO public.campaigns(id,tenant_id,code,kind,market_code,currency_code,service_slug,audience,enabled,budget_minor,spent_minor,funding_party,qualification,per_user_cap,value_type,value)
      VALUES('${campId}','${tenantId}','WELCOME5','customer_discount','GB','GBP','delivery','customer',true,1000,0,'platform','{"min_qualifying_fare_minor":100,"max_discount_minor":50}'::jsonb,1,'percent',5);`);
    const disc1 = String(sql(`SELECT (public.apply_campaign_discount('${campId}','${customer.user.id}','quote-1',666)).discount_minor::text;`)).trim();
    expect(disc1, '5% of 666 minor, capped').toBe('33');
    const discReplay = String(sql(`SELECT (public.apply_campaign_discount('${campId}','${customer.user.id}','quote-1',666)).discount_minor::text;`)).trim();
    expect(discReplay, 'idempotent same quote').toBe('33');
    expect(sql(`SELECT count(*)::text FROM public.campaign_discount_applications WHERE campaign_id='${campId}';`), 'single application row').toBe('1');
    expect(sql(`SELECT spent_minor::text FROM public.campaigns WHERE id='${campId}';`), 'campaign spend persisted').toBe('33');
    expect(() => sql(`SELECT public.apply_campaign_discount('${campId}','${customer.user.id}','quote-2',666);`), 'per-user cap enforced').toThrow();
    const margin = String(sql(`SELECT (public.preview_vaydu_margin('{"customerCharge":666,"driverCommissionAmount":100,"platformFeeAmount":33,"driverEntitlement":533}'::jsonb,33,0,10)->>'vayduMarginMinor')||'|'||(public.preview_vaydu_margin('{"customerCharge":666,"driverCommissionAmount":100,"platformFeeAmount":33,"driverEntitlement":533}'::jsonb,33,0,10)->>'grossRevenueMinor')||'|'||(public.preview_vaydu_margin('{"customerCharge":666,"driverCommissionAmount":100,"platformFeeAmount":33,"driverEntitlement":533}'::jsonb,33,0,10)->>'marginBps');`)).trim();
    expect(margin, 'margin preview subtracts platform-funded discount and processing').toBe('90|133|1351');
    // Ops CLI via a fixture routing proxy. supabase-js targets /rest/v1 but the
    // bare PostgREST serves /, so forward /rest/v1/* -> /* (async, same process).
    const proxy = http.createServer(async (req, res) => {
      if ((req.url || '/') === '/health') { res.writeHead(200); res.end('ok'); return; }
      const upstream = restUrl + String(req.url || '/').replace(/^\/rest\/v1/, '');
      try {
        const ur = await fetch(upstream, { method: req.method, headers: req.headers as any });
        res.writeHead(ur.status, { 'content-type': ur.headers.get('content-type') || 'application/json' });
        res.end(await ur.text());
      } catch (e) { console.log('PROXY_FORWARD_ERR=' + String(e)); res.writeHead(502); res.end('proxy_down'); }
    });
    proxy.on('error', (e) => console.log('PROXY_ERR=' + String(e)));
    proxy.on('close', () => console.log('PROXY_CLOSED'));
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = (proxy.address() as any).port;
    console.log('PROXY_PORT=' + proxyPort);
    const proxyUrl = 'http://127.0.0.1:' + proxyPort;
    const probe = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['-e', `fetch('${proxyUrl}/health').then(r=>{console.log('CHILD_HEALTH='+r.status);process.exit(0)}).catch(e=>{console.log('CHILD_HEALTH_ERR='+e);process.exit(9)})`], { stdio: ['ignore','inherit','inherit'] });
      child.on('close', (code) => resolve(code ?? 1));
    });
    expect(probe, 'child reaches proxy /health').toBe(0);
    const runCli = (url: string, key: string) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['scripts/report-unresolved-payment-ops.cjs'], {
        env: { ...process.env, DOTENV_CONFIG_PATH: join(tmpdir(), 'empty-dotenv'), SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key },
        stdio: ['ignore','inherit','inherit'],
      });
      child.on('close', (code) => resolve(code ?? 1));
    });
    sql(`UPDATE public.jobs SET payment_intent_id=NULL;`);
    expect(await runCli(proxyUrl, jwt('service_role')), 'clean dataset -> exit 0').toBe(0);
    sql(`UPDATE public.jobs SET payment_intent_id='pi_unresolved', payment_status='requires_refund' WHERE id='${mixedJob}';`);
    expect(await runCli(proxyUrl, jwt('service_role')), 'seeded requires_refund job -> exit 2').toBe(2);
    expect(await runCli('http://127.0.0.1:1', jwt('service_role')), 'unreachable endpoint -> exit 3').toBe(3);
    sql(`UPDATE public.jobs SET payment_intent_id=NULL, payment_status='authorized' WHERE id='${mixedJob}';`);
    await new Promise<void>((r) => proxy.close(() => r()));
    // Wallet/settlement currency precision + isolation + replay (real PostgreSQL).
    sql(`INSERT INTO public.market_availability(country_code,market_city,launch_status,customer_app_enabled,customer_registration_enabled,driver_registration_enabled,driver_online_enabled,quote_enabled,booking_enabled,payment_enabled,supported_currency,enabled)
      VALUES('US',NULL,'live',false,false,false,false,false,false,false,'USD',false),
            ('JP',NULL,'live',false,false,false,false,false,false,false,'JPY',false),
            ('KW',NULL,'live',false,false,false,false,false,false,false,'KWD',false) ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.driver_cash_credit_enrolments_v1e(tenant_id,driver_id,country_code,currency_code,terms_version,consented_at,enabled)
      VALUES('${tenantId}','${bikeDriver.user.id}','US','USD','fixture-terms',now()-interval '1 hour',true),
            ('${tenantId}','${bikeDriver.user.id}','JP','JPY','fixture-terms',now()-interval '1 hour',true),
            ('${tenantId}','${bikeDriver.user.id}','KW','KWD','fixture-terms',now()-interval '1 hour',true) ON CONFLICT DO NOTHING;`);
    for (const [cur, minor] of [['GBP', 666], ['USD', 666], ['JPY', 666], ['KWD', 6666]] as const) {
      const evKey = `curr-ledger-${cur}-${suffix}`;
      sql(`SELECT public.post_wallet_event('${evKey}','topup','${tenantId}','${bikeDriver.user.id}','${cur}','[{"accountPurpose":"driver_cash_credit","amountMinor":${minor}},{"accountPurpose":"platform_funding","amountMinor":${-minor}}]'::jsonb);`);
      const led = String(sql(`SELECT coalesce(sum(m.amount_minor),0)::text||'|'||count(*)::text||'|'||min(a.currency_code)||'|'||max(a.currency_code) FROM public.wallet_business_events e JOIN public.wallet_movements m ON m.event_id=e.id JOIN public.wallet_accounts a ON a.id=m.account_id WHERE e.event_key='${evKey}';`)).trim();
      expect(led, `${cur}: balanced 0, two entries, currency-isolated`).toBe(`0|2|${cur}|${cur}`);
      try { sql(`SELECT public.post_wallet_event('${evKey}','topup','${tenantId}','${bikeDriver.user.id}','${cur}','[{"accountPurpose":"driver_cash_credit","amountMinor":${minor}},{"accountPurpose":"platform_funding","amountMinor":${-minor}}]'::jsonb);`); } catch {}
      expect(sql(`SELECT count(*)::text FROM public.wallet_movements m JOIN public.wallet_business_events e ON e.id=m.event_id WHERE e.event_key='${evKey}';`), `${cur}: duplicate event does not duplicate movements`).toBe('2');
    }
    // Extracted-API runtime (authenticated) against live fixture GoTrue + PostgREST.
    const extRoot = join(process.cwd(), 'release', '_ci3-9abfd8f', 'vaydu-develop-9abfd8f');
    const extProxy = http.createServer(async (req, res) => {
      const u = String(req.url || '/');
      const upstream = u.startsWith('/auth/v1') ? authUrl + u.replace('/auth/v1', '') : restUrl + u.replace(/^\/rest\/v1/, '');
      try { const ur = await fetch(upstream, { method: req.method, headers: req.headers as any }); res.writeHead(ur.status, { 'content-type': ur.headers.get('content-type') || 'application/json' }); res.end(await ur.text()); }
      catch { res.writeHead(502); res.end('proxy_down'); }
    });
    await new Promise<void>((r) => extProxy.listen(0, '127.0.0.1', r));
    const extProxyUrl = 'http://127.0.0.1:' + (extProxy.address() as any).port;
    const extPort = 5200 + Math.floor(Math.random() * 300);
    const extLog: string[] = [];
    const extChild = spawn(process.execPath, ['node_modules/ts-node/dist/bin.js', 'server/index.ts'], {
      cwd: extRoot, env: { ...process.env, NODE_ENV: 'production', SUPABASE_URL: extProxyUrl, SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'), PORT: String(extPort) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    extChild.stdout.on('data', (d) => extLog.push(String(d)));
    extChild.stderr.on('data', (d) => extLog.push(String(d)));
    let hs = 0;
    for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${extPort}/health`); hs = r.status; if (hs === 200) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
    expect(hs, 'extracted /health 200; log=' + extLog.join('').slice(-1500)).toBe(200);
    const cards = await fetch(`http://127.0.0.1:${extPort}/api/payment/cards`, { headers: { Authorization: 'Bearer ' + customer.access_token } });
    const cardsBody = await cards.json().catch(() => null);
    expect(cards.status, 'authenticated /cards status; log=' + extLog.join('').slice(-1000)).toBe(200);
    expect(cardsBody, 'authenticated /cards disabled-feature data').toEqual({ enabled: false, cards: [] });
    const recvId = 'aaaaaaaa-0000-0000-0000-00000000000e';
    sql(`INSERT INTO public.customer_receivables(id,tenant_id,customer_id,currency_code,amount_minor,reason,status)
      VALUES('${recvId}','${tenantId}','${customer.user.id}','GBP',666,'cancellation_fee','open');`);
    const debts = await fetch(`http://127.0.0.1:${extPort}/api/booking/debts`, { headers: { Authorization: 'Bearer ' + customer.access_token } });
    const debtsBody = await debts.json().catch(() => null);
    expect(debts.status, 'authenticated /debts status').toBe(200);
    const hit = (debtsBody?.debts || []).find((d: any) => d.id === recvId);
    expect(hit, 'seeded receivable returned').toBeTruthy();
    expect(hit.amount_minor, 'seeded amount').toBe(666);
    expect(hit.currency_code, 'seeded currency').toBe('GBP');
    const debtsNoAuth = await fetch(`http://127.0.0.1:${extPort}/api/booking/debts`);
    expect([401, 403].includes(debtsNoAuth.status), 'unauthenticated /debts denied: ' + debtsNoAuth.status).toBe(true);
    extChild.kill('SIGTERM');
    await new Promise<void>((r) => { extChild.on('close', () => r()); setTimeout(() => { try { extChild.kill('SIGKILL'); } catch {} r(); }, 5000); });
    await new Promise<void>((r) => extProxy.close(() => r()));
    // DIRECT SQL (not HTTP): contradictory metadata cannot bypass Bike isolation.
    // A car vehicle passes the metadata (car) check, then the frozen bike
    // snapshot must reject it instead of allowing a car into a Bike job.
    const contradictJob = '44444444-4444-4444-4444-444444444444';
    sql(`INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,driver_id,accepted_driver_id,status,payment_status,pickup_address,dropoff_address,scheduled_time,metadata,fulfilment_category,fulfilment_snapshot)
      VALUES('${contradictJob}','${tenantId}','${customer.user.id}','GB',NULL,NULL,'searching','authorized','5 Test Street','6 Test Road',now(),'{"service_vehicle_class":"car"}'::jsonb,'bike','{"category":"bike","allowedSubtypes":["pedal_bicycle"]}');`);
    let directError = '';
    try { sql(`BEGIN; SELECT public.assign_driver_to_job('${contradictJob}','${carDriver.user.id}'); ROLLBACK;`); }
    catch (e: any) { directError = String(e.stderr || e.message); }
    expect(directError, 'contradictory metadata must be rejected by the database guard')
      .toMatch(/contradicts|VF011/);
    expect(sql(`SELECT coalesce(driver_id::text,'')||'|'||status FROM public.jobs WHERE id='${contradictJob}';`))
      .toBe('|searching');

    // ---------------------------------------------------------------------
    // Suspension / session revocation through the real GoTrue fixture.
    // ---------------------------------------------------------------------
    const suspendedUser = await signup(`suspended-${suffix}@example.test`);
    const otherUser = await signup(`other-${suffix}@example.test`);
    sql(`INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_market_city,verification_status,onboarding_completed,account_status)
      VALUES('${suspendedUser.user.id}','${tenantId}','customer','GB','London','approved',true,'active'),
            ('${otherUser.user.id}','${tenantId}','customer','GB','London','approved',true,'active') ON CONFLICT (id) DO UPDATE SET account_status=EXCLUDED.account_status;`);
    const debtsFor = (token: string) => fetch(base + '/api/jobs/debts', { headers: { Authorization: 'Bearer ' + token } });
    const refresh = (rt: string) => fetch(`${authUrl}/token?grant_type=refresh_token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }) });

    // Access succeeds before suspension.
    expect((await debtsFor(suspendedUser.access_token)).status, 'suspended-user access before suspension').toBe(200);
    expect((await debtsFor(otherUser.access_token)).status, 'other-user access before suspension').toBe(200);

    // Suspend through the ACTUAL admin account-status endpoint.
    const suspend = await fetch(base + '/api/admin/account-status', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + adminUser.access_token },
      body: JSON.stringify({ userId: suspendedUser.user.id, status: 'suspended', reason: 'integration suspension test' })
    });
    expect(suspend.status, 'admin suspension: ' + JSON.stringify(await suspend.clone().json().catch(() => ({})))).toBe(200);

    // The same issued access token is now denied.
    expect((await debtsFor(suspendedUser.access_token)).status, 'same token denied after suspension').toBe(403);

    // The refresh token cannot obtain a usable session.
    const refreshDenied = await refresh(suspendedUser.refresh_token);
    expect(refreshDenied.status >= 400, 'suspended refresh token denied: ' + refreshDenied.status).toBe(true);

    // A different active user is unaffected (access and refresh).
    expect((await debtsFor(otherUser.access_token)).status, 'other user still accesses').toBe(200);
    const refreshOk = await refresh(otherUser.refresh_token);
    expect(refreshOk.status, 'other user still refreshes: ' + refreshOk.status).toBe(200);

  } finally {
    server?.close();
    try { dumpDiagnostics(docker, logDir); } catch { }
    for (const name of [authName, restName, dbName]) { try { docker('rm', '-f', name); } catch { } }
    // Force-remove the network: disconnect-then-rm leaked the network because
    // the db container is already gone by this point (address pools exhausted).
    try { docker('network', 'rm', '-f', network); } catch { }
  }
}, 180000);





























































