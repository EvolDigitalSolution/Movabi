#!/usr/bin/env bash
# Read-only, no credential extraction or provider requests. Run in existing SSH shell.
set -eu
python3 - <<'PY'
import json,subprocess,hashlib,re
from pathlib import Path
def run(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=35)
 return p.returncode,p.stdout.strip()
docker=['docker']
if run(docker+['info','--format','{{.ServerVersion}}'])[0]:docker=['sudo','-n','docker']
code,raw=run(docker+['inspect','--format','{{json .Image}}','movabi-develop-db'])
if code or json.loads(raw)!='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c':raise SystemExit('Develop DB image changed: re-audit required')
code,raw=run(docker+['inspect','--format','{{json .NetworkSettings.Networks}}','movabi-develop-db'])
if code or set(json.loads(raw))!={'movabi-develop-private'}:raise SystemExit('Develop DB network changed: re-audit required')
def sql(statement):
 code,out=run(docker+['exec','movabi-develop-db','psql','-U','postgres','-d','movabi_develop','-X','-qAt','-v','ON_ERROR_STOP=1','-c','BEGIN READ ONLY; '+statement+'; COMMIT;'])
 if code:raise SystemExit('Read-only catalog query failed; inspect schema prerequisites manually (diagnostics suppressed)')
 return out
for service in ('movabi-develop-api','movabi-develop-rest','movabi-develop-web'):
 code,project=run(docker+['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',service])
 if code or project!='movabi-develop':raise SystemExit('Develop service compose identity unavailable: '+service)
 code,identifier=run(docker+['inspect','--format','{{.Image}}',service])
 print('SERVICE_IMAGE: '+json.dumps({'service':service,'image':identifier if not code else None}))
# Only explicitly named non-secret switches. Never inspect Env arrays or connection URLs.
public_flags=['NODE_ENV','VAYDU_DRIVER_TOPUP_API','VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX','VAYDU_BOOKING_SPLIT_TIMING_APPROVED','VAYDU_DRIVER_PAYOUT_SANDBOX']
js='process.stdout.write(JSON.stringify(Object.fromEntries('+json.dumps(public_flags)+'.map(k=>{const v=process.env[k];return [k,v===undefined?null:k==="NODE_ENV"?(["production","development","test"].includes(v)?v:"invalid_not_disclosed"):v==="true"?true:v==="false"?false:"invalid_not_disclosed"]}))))'
code,flags=run(docker+['exec','movabi-develop-api','node','-e',js])
print('PUBLIC_API_FLAGS: '+(flags if not code else json.dumps({'unavailable':True})))
code,networks=run(docker+['inspect','--format','{{json .NetworkSettings.Networks}}','movabi-develop-rest'])
ip=None if code else json.loads(networks).get('movabi-develop-private',{}).get('IPAddress')
if ip and re.fullmatch(r'[0-9.]+',ip):
 print('REST_DATABASE_ACTIVITY: '+sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT datname AS database,count(*) AS connections FROM pg_stat_activity WHERE client_addr='"+ip+"'::inet GROUP BY datname) x"))
else:print('REST_DATABASE_ACTIVITY: '+json.dumps({'unconfirmed':'REST private-network address unavailable'}))
print('CATALOG: '+sql("SELECT json_build_object('database',current_database(),'accounts',to_regclass('public.driver_payment_accounts'),'payoutMarkets',to_regclass('public.driver_payout_markets'),'collectionMarkets',to_regclass('public.driver_collection_markets'),'collectionAccounts',to_regclass('public.driver_collection_subaccounts'),'settlementAuthority',to_regclass('public.job_settlement_methods'),'submissionLedger',to_regclass('public.flutterwave_job_submissions'),'completeAuthority',to_regprocedure('public.complete_job_with_pending_payout(uuid,uuid,jsonb,jsonb)'))"))
print('PROVIDER_CONSTRAINT: '+sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.market_payment_routes'::regclass AND conname='market_payment_routes_provider_check'"))
print('COLLECTION_ASSIGNMENTS: '+sql("SELECT coalesce(json_agg(json_build_object('country',country_code,'currency',currency_code,'provider',provider,'preferred',preferred,'enabled',enabled,'approved',merchant_approved,'adapterReady',adapter_ready,'payoutApproved',payout_approved)),'[]') FROM public.market_payment_routes WHERE method='card'"))
if sql("SELECT to_regclass('public.driver_payout_markets') IS NOT NULL")=='t':
 print('PAYOUT_MARKETS: '+sql("SELECT coalesce(json_agg(json_build_object('country',country_code,'currency',currency_code,'provider',provider,'enabled',enabled,'approved',merchant_approved,'adapterReady',adapter_ready,'capabilityVerified',capability_verified_at IS NOT NULL,'driver',sandbox_driver_id,'tenant',sandbox_tenant_id)),'[]') FROM public.driver_payout_markets"))
if sql("SELECT to_regclass('public.driver_collection_markets') IS NOT NULL")=='t':
 print('COLLECTION_ACCOUNT_MARKETS: '+sql("SELECT coalesce(json_agg(json_build_object('country',country_code,'currency',currency_code,'environment',environment,'merchantReferenceConfigured',merchant_account_ref IS NOT NULL,'defaultSplitType',default_split_type,'defaultSplitValue',default_split_value,'tenant',sandbox_tenant_id,'setupApproved',setup_approved,'splitApproved',split_collection_approved,'f4bApproved',f4b_approved,'evidenceRecorded',capability_evidence_ref IS NOT NULL,'driver',sandbox_driver_id)),'[]') FROM public.driver_collection_markets"))
 print('COLLECTION_ACCOUNT_COUNTS: '+sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT country_code,currency_code,environment,state,count(*) FROM public.driver_collection_subaccounts GROUP BY 1,2,3,4) x"))
# Include the existing NG driver even when registration/payment setup is incomplete.
print('NG_DRIVER_CANDIDATES: '+sql("SELECT coalesce(json_agg(json_build_object('driverId',p.id,'tenantId',p.tenant_id,'registeredCountry',coalesce(nullif(p.registration_country_code,''),p.country_code),'profileCountry',p.country_code,'currency',m.supported_currency,'registrationActivated',p.registration_activated_at IS NOT NULL)),'[]') FROM public.profiles p LEFT JOIN (SELECT DISTINCT country_code,supported_currency FROM public.market_availability) m ON m.country_code=coalesce(nullif(p.registration_country_code,''),p.country_code) WHERE p.role='driver' AND (p.registration_country_code='NG' OR p.country_code='NG')"))
for schema,table in [('public','schema_migrations'),('supabase_migrations','schema_migrations')]:
 if sql("SELECT to_regclass('"+schema+"."+table+"') IS NOT NULL")!='t':
  print('MIGRATION_HISTORY: '+json.dumps({'table':schema+'.'+table,'present':False}));continue
 columns=sql("SELECT column_name FROM information_schema.columns WHERE table_schema='"+schema+"' AND table_name='"+table+"'").splitlines()
 allowed=[c for c in ('version','id','name') if c in columns]
 if not allowed:print('MIGRATION_HISTORY: '+json.dumps({'table':schema+'.'+table,'supportedColumns':False}));continue
 select=','.join('"'+c+'"' for c in allowed)
 print('MIGRATION_HISTORY_'+schema+': '+sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT "+select+" FROM "+schema+'.'+table+' ORDER BY "'+allowed[0]+'"::text DESC LIMIT 30) x'))
print('APPLICATION_ROUTINES: '+sql("SELECT coalesce(json_agg(json_build_object('routine',p.oid::regprocedure::text,'definitionMd5',md5(pg_get_functiondef(p.oid)))),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('claim_driver_collection_subaccount','reserve_flutterwave_booking_split','claim_flutterwave_split_submission','confirm_flutterwave_split_collection','finish_flutterwave_split_settlement','complete_job_with_pending_payout','record_job_settlement')"))
folder=Path.home()/'vaydu-develop-wallet-backups'/'20261027T134821Z-1eabea4c'
dump=folder/'movabi_develop.dump'
if dump.exists() and not dump.is_symlink():
 h=hashlib.sha256()
 with dump.open('rb') as stream:
  for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
 print('RETAINED_BACKUP: '+json.dumps({'present':True,'bytes':dump.stat().st_size,'sha256':h.hexdigest(),'matchesPreviouslyVerifiedArchive':h.hexdigest()=='abf0c32b9287efb2ca13b57521c786fde2930d21103a70343793d6fa1c404f21','priorVerificationManifestPresent':(folder/'verification-9168cbbb449f.json').is_file()}))
else:print('RETAINED_BACKUP: '+json.dumps({'present':False}))
print('ACTIVATED_DRIVERS: '+sql("SELECT coalesce(json_agg(json_build_object('id',p.id,'tenant',p.tenant_id,'registeredCountry',coalesce(p.registration_country_code,p.country_code),'currency',m.supported_currency)),'[]') FROM public.profiles p LEFT JOIN (SELECT DISTINCT country_code,supported_currency FROM public.market_availability) m ON m.country_code=coalesce(p.registration_country_code,p.country_code) WHERE p.role='driver' AND p.registration_activated_at IS NOT NULL"))
print('COMPLETE: read-only; no credentials, bank accounts, provider requests or enablement')
PY
