"""Read-only release checks, safe metadata only. Never reads provider or DB credentials."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import time

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('release',ROOT/'release-driver-collection-cohost.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
PIN='sha256:508ae7f1260bd3340ad2c2d7e1503007aeb16a4a99143356d6e0c2dbcfe15480'
BASELINE='sha256:1ef978c931bf390273f4648f6c8bdce04231338d64ae7c6ead7e4e10d723c6aa'
KEYS=['VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_DRIVER_SUBACCOUNT_MERCHANT_VERIFIED','VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED',
      'VAYDU_DRIVER_TOPUP_API','VAYDU_DRIVER_PAYOUT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX','VAYDU_BOOKING_SPLIT_TIMING_APPROVED']

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('phase',choices=['baseline','backup','migration-plan','post-stage','post-rollback'])
    args=parser.parse_args()
    d=['docker']
    try:release.run(d+['info','--format','{{.ServerVersion}}'])
    except RuntimeError:d=['sudo','-n','docker']
    identity=release.identity(d)
    def sql(query):return release.run(d+['exec','-e','PGOPTIONS=-c default_transaction_read_only=on -c timezone=UTC -c search_path=pg_catalog,public','movabi-develop-db','psql','-X','-U','postgres','-d','movabi_develop','-At','-v','ON_ERROR_STOP=1','-c',query])
    def node(code):return json.loads(release.run(d+['exec','movabi-develop-api','node','-e',code]))
    def snapshot():
        code="const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(JSON.stringify(Object.fromEntries("+json.dumps(list(review['protectedSourceHashes']))+".map(p=>[p,c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]))));"
        hashes=node(code)
        flags=node("process.stdout.write(JSON.stringify(Object.fromEntries("+json.dumps(KEYS+['NODE_ENV','VAYDU_DEPLOYMENT_ENV','VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP'])+".map(k=>[k,process.env[k]===undefined?null:process.env[k]]))))")
        # Do not echo arbitrary switch values. Compare in-process; report booleans only.
        if flags['NODE_ENV']!='production':raise RuntimeError('Existing API NODE_ENV differs from accepted production runtime')
        if any(flags[k] not in (None,'false') for k in KEYS):raise RuntimeError('A setup/approval/payout/topup/split gate is not disabled')
        if sql("SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id='318e6be9-9164-41fa-bb0c-c5ccd3526585' AND tenant_id='d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8' AND role='driver' AND registration_activated_at IS NOT NULL AND coalesce(registration_country_code,country_code)='NG')")!='t':raise RuntimeError('Confirmed activated NG driver/tenant no longer matches')
        if sql('SELECT public.wallet_collection_enabled()')!='f':raise RuntimeError('Wallet collection gate must remain disabled')
        if sql("SELECT count(DISTINCT supported_currency)=1 AND min(supported_currency)='NGN' FROM public.market_availability WHERE country_code='NG'")!='t':raise RuntimeError('NG/NGN registered currency is ambiguous')
        if sql("SELECT to_regclass('public.driver_collection_markets') IS NOT NULL")=='t':
            if sql("SELECT NOT EXISTS(SELECT 1 FROM public.driver_collection_markets WHERE setup_approved OR adapter_ready OR f4b_approved OR split_collection_approved OR split_semantics_verified OR fee_passing_verified OR settlement_verified OR default_split_type IS NOT NULL OR default_split_value IS NOT NULL)")!='t':raise RuntimeError('Collection/default configuration is not unapproved and disabled')
        if sql("SELECT to_regclass('public.driver_payout_markets') IS NOT NULL")=='t':
            if sql("SELECT NOT EXISTS(SELECT 1 FROM public.driver_payout_markets WHERE provider='flutterwave' AND (enabled OR merchant_approved OR adapter_ready))")!='t':raise RuntimeError('Flutterwave payout market is enabled or approved')
        if setup_only:
            present=sql("SELECT to_regclass('public.driver_collection_setup_markets') IS NOT NULL")=='t'
            if present:
                from setup_only_release import DISABLED_SQL
                if sql(DISABLED_SQL)!='t':raise RuntimeError('Setup-only defaults/approvals/private state not disabled')
            elif args.phase=='post-stage':raise RuntimeError('Setup-only schema is absent after combined rollout')
        fingerprints=json.loads(sql("SELECT json_build_object('routes',md5((SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text FROM public.market_payment_routes r)),'completion',md5(pg_get_functiondef('public.complete_job_with_pending_payout(uuid,uuid,jsonb,jsonb)'::regprocedure)),'settlement',md5(pg_get_functiondef('public.record_job_settlement(uuid,uuid,numeric,numeric,numeric,numeric,numeric,text,text,text,boolean)'::regprocedure)))"))
        return {'image':identity['previousImage'],'protectedSourceHashes':hashes,'databaseFingerprints':fingerprints,'nodeEnvProduction':True,'gatesDisabled':True,'driverVerified':True,
                'cohostSelected':flags['VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP']=='true','developMarker':flags['VAYDU_DEPLOYMENT_ENV']=='develop'}
    def health():
        # Only unauthenticated reads; no provider/payment calls, no token input or response bodies printed.
        code="""(async()=>{const base='http://127.0.0.1:'+(process.env.PORT||'3001');const paths=['/health','/api/connect/payout-settings','/api/driver-payment-account/status'];const results={};for(const p of paths){const r=await fetch(base+p,{redirect:'error',signal:AbortSignal.timeout(5000)});results[p]=r.status;if(p==='/health'){const j=await r.json();if(j.status!=='ok')throw Error('health');}}process.stdout.write(JSON.stringify(results));})().catch(()=>process.exit(1));"""
        result=node(code)
        if result!={'/health':200,'/api/connect/payout-settings':401,'/api/driver-payment-account/status':401}:raise RuntimeError('Health/Stripe authentication boundary smoke check failed')
        return result
    review=json.loads((ROOT/'review.json').read_text())
    pin=review.get('imageId','')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',pin):raise RuntimeError('Unexpected reviewed image')
    setup_only=review.get('schemaScope')=='setup-only-550'
    evidence=ROOT/'operator-evidence'
    if evidence.is_symlink():raise RuntimeError('Unsafe operator evidence path')
    evidence.mkdir(mode=0o700,exist_ok=True)
    if evidence.stat().st_uid!=os.getuid() or evidence.stat().st_mode&0o777!=0o700:raise RuntimeError('Private operator evidence directory required')
    baseline_file=evidence/'baseline.json'
    if args.phase=='baseline':
        if identity['previousImage']!=BASELINE:raise RuntimeError('Current API image differs from last supplied baseline; review before continuing')
        current=snapshot()
        mismatch=[p for p,digest in review['protectedSourceHashes'].items() if current['protectedSourceHashes'][p]!=digest]
        if mismatch:raise RuntimeError('Protected Stripe/booking sources differ between current API and reviewed image: '+','.join(mismatch)+'. Review/rebuild before staging; do not bypass.')
        current['healthSmoke']=health()
        release.write_private(baseline_file,current)
        print(json.dumps({'baselineVerified':True,'protectedSourceParity':True,'readOnlyStripeAuthSmoke':True,'gatesDisabled':True,'backupStillRequired':True}))
    elif args.phase=='backup':
        lines=(evidence/'fresh-backup.log').read_text().splitlines()
        results=[json.loads(line) for line in lines if line.startswith('{')]
        result=next((x for x in reversed(results) if x.get('restoreVerified') is True),None)
        if not result:raise RuntimeError('Fresh backup restore verification did not pass')
        folder=Path(result['backupDirectory']);root=Path.home()/'vaydu-develop-wallet-backups'
        if folder.is_symlink() or folder.resolve().parent!=root.resolve():raise RuntimeError('Backup provenance mismatch')
        manifest=Path(result['verificationManifest'])
        if manifest.is_symlink() or manifest.resolve().parent!=folder.resolve():raise RuntimeError('Backup manifest provenance mismatch')
        data=json.loads(manifest.read_text())
        if setup_only:
            from setup_only_release import load_release,require_real_proof
            artifact=load_release(ROOT/'migrations');require_real_proof(data,artifact['manifestSha256'])
        dump=folder/'movabi_develop.dump'
        if dump.is_symlink() or time.time()-dump.stat().st_mtime>7200:raise RuntimeError('Fresh archive missing or older than two hours')
        digestor=hashlib.sha256()
        with dump.open('rb') as archive:
            for chunk in iter(lambda:archive.read(1024*1024),b''):digestor.update(chunk)
        digest=digestor.hexdigest()
        if data.get('restoreVerified') is not True or data.get('sourceContainer')!='movabi-develop-db' or data.get('sourceDatabase')!='movabi_develop' or data.get('sourceImage')!=release.metadata(d,'movabi-develop-db','{{.Image}}') or data.get('sha256')!=digest:raise RuntimeError('Fresh backup verification/provenance/checksum failed')
        release.write_private(evidence/'accepted-backup.json',{'backupDirectory':str(folder),'manifest':str(manifest),'sha256':digest,'acceptedAt':time.time()})
        print(json.dumps({'freshBackupVerified':True,'sha256':digest,'restoreVerified':True}))
    elif args.phase=='migration-plan':
        # This is a deliberate no-write compatibility decision, not permission to apply the broad bundle.
        manifest=json.loads((ROOT/'migrations/migration-manifest.json').read_text())
        for item in manifest['files']:
            path=ROOT/'migrations'/item['name']
            if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:raise RuntimeError('Reviewed migration checksum mismatch')
        present=json.loads(sql("SELECT json_build_object('payoutMarkets',to_regclass('public.driver_payout_markets') IS NOT NULL,'collectionMarkets',to_regclass('public.driver_collection_markets') IS NOT NULL,'collectionAccounts',to_regclass('public.driver_collection_subaccounts') IS NOT NULL,'bookingSettlement',to_regclass('public.job_settlement_methods') IS NOT NULL)"))
        columns=json.loads(sql("SELECT coalesce(json_agg(json_build_object('schema',table_schema,'column',column_name)),'[]') FROM information_schema.columns WHERE table_name='schema_migrations' AND table_schema IN('public','supabase_migrations') AND column_name IN('id','version','name')"))
        history=[]
        for schema in ['public','supabase_migrations']:
            names=[item['column'] for item in columns if item['schema']==schema]
            # Select only known identifier columns, never statements/checksums with arbitrary payloads.
            chosen=[name for name in ['version','name','id'] if name in names]
            if not chosen:continue
            conditions=[]
            for name in chosen:
                for item in manifest['files']:
                    version=item['name'].split('_')[0]
                    conditions.append('"'+name+'"::text LIKE '+"'"+version+"%'")
            count=sql('SELECT count(*) FROM '+schema+'.schema_migrations WHERE '+' OR '.join(conditions))
            history.append({'table':schema+'.schema_migrations','reviewedVersionRowsPresent':int(count)})
        from setup_only_release import NAME,PURPOSE
        compatible=setup_only and manifest.get('purpose')==PURPOSE and [x['name'] for x in manifest['files']]==[NAME]
        print(json.dumps({'reviewedOrder':[x['name'] for x in manifest['files']],'catalogPresence':present,'migrationHistoryIdentityColumns':columns,'reviewedMigrationHistoryCounts':history,
         'reviewedBundleCompatibleWithNoBookingChanges':compatible,'migrationsApplied':False,'reason':'Exact independent setup-only release; broad migrations excluded' if compatible else '546 can change market routing; 547 rewrites completion authority; 548 installs booking/payout triggers. Deferred under current instruction.','scope':'Setup-only schema plus disabled API; activation NOT approved' if compatible else 'Application-only disabled stage; setup schema/onboarding readiness NOT approved'}))
    else:
        baseline=json.loads(baseline_file.read_text());current=snapshot()
        expected=pin if args.phase=='post-stage' else baseline['image']
        if current['image']!=expected:raise RuntimeError('Running API image differs from expected stage/rollback image')
        if current['protectedSourceHashes']!=baseline['protectedSourceHashes'] or current['databaseFingerprints']!=baseline['databaseFingerprints']:raise RuntimeError('Protected Stripe/booking sources or database routing/authority changed')
        if args.phase=='post-stage' and not(current['cohostSelected'] and current['developMarker']):raise RuntimeError('Co-hosted develop staging marker mismatch')
        if args.phase=='post-rollback' and current['cohostSelected']:raise RuntimeError('Co-host opt-in not disabled after rollback')
        result=health()
        if args.phase=='post-stage':
            mounts=json.loads(release.metadata(d,'movabi-develop-api','{{json .Mounts}}'))
            match=[m for m in mounts if m.get('Destination')=='/run/vaydu/flutterwave-test.env']
            if len(match)!=1 or match[0].get('RW') is not False or match[0].get('Source')!=str(release.PRIVATE):raise RuntimeError('Private provider mount is not the expected read-only reference')
        print(json.dumps({'phase':args.phase,'verified':True,'healthAndAuthSmoke':result,'stripeSourceParity':True,'routingAndCompletionUnchanged':True,'gatesDisabled':True,'onboardingReady':False,'authenticatedStripePaymentTested':False}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'verified':False,'reason':str(error) if isinstance(error,RuntimeError) else 'Read-only prerequisite check failed; raw diagnostic withheld'}))
        raise SystemExit(1)
