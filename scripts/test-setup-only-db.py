"""Restore a previously verified SYNTHETIC develop fixture archive; never real-server data.

Tests setup-only SQL, claims and unchanged protected authorities in a network-none clone.
The real-server rehearsal is a separate verify-develop-wallet-backup.py command.
"""
from concurrent.futures import ThreadPoolExecutor
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid
from setup_only_release import NAME,PROTECTED_SQL,DISABLED_SQL

ROOT=Path(__file__).resolve().parent.parent
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--archive',required=True);args=parser.parse_args()
    archive=Path(args.archive);manifest=json.loads((archive.parent/'manifest.json').read_text())
    if archive.is_symlink() or not re.fullmatch(r'vaydu-backup-fixture-[a-f0-9]{8}',manifest.get('sourceContainer','')):raise RuntimeError('Verified synthetic fixture provenance required')
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    if manifest.get('restoreVerified') is not True or manifest.get('sha256')!=digest:raise RuntimeError('Synthetic archive integrity check failed')
    name='vaydu-backup-fixture-'+uuid.uuid4().hex[:8]
    def docker(*parts,data=None,stdin=None):
        p=subprocess.run(['docker',*parts],input=data,stdin=stdin,capture_output=True,text=data is not None,timeout=120)
        if p.returncode:
            error=p.stderr.decode(errors='replace') if isinstance(p.stderr,bytes) else p.stderr
            safe=[label for label,needle in [('selected_scope','Confirmed activated NG/NGN driver/tenant required'),('base_dependencies','Setup-only base dependencies missing'),('already_applied','Setup-only objects already exist'),('missing_object','does not exist'),('permission','permission denied'),('constraint','violates'),('duplicate','already exists')] if needle in error]
            if data and 'CREATE TABLE public.driver_collection_setup_markets' in data:
                # This is a static reviewed DDL-only source in a synthetic clone.
                # The first ERROR line contains schema/compiler metadata, never a provider body.
                first=next((line.split('ERROR:',1)[1].strip() for line in error.splitlines() if 'ERROR:' in line),'unclassified DDL error')
                raise RuntimeError('Synthetic setup DDL failed: '+first[:180])
            raise RuntimeError('Synthetic Docker/SQL step failed; categories='+','.join(safe))
        return p.stdout.decode().strip() if isinstance(p.stdout,bytes) else p.stdout.strip()
    def sql(query):return docker('exec','-i',name,'psql','-h','127.0.0.1','-U','postgres','-d','movabi_develop','-X','-qAt','-v','ON_ERROR_STOP=1',data=query)
    def fail(query):
        try:sql(query)
        except RuntimeError:return
        raise RuntimeError('Forbidden SQL operation unexpectedly succeeded')
    try:
        bootstrap='initdb -D /tmp/setup-only-pg -A trust --no-locale >/dev/null && exec postgres -D /tmp/setup-only-pg -c shared_preload_libraries=pg_net -c listen_addresses=127.0.0.1'
        docker('run','-d','--rm','--network','none','--name',name,'--label','vaydu.purpose=setup-only-synthetic-test','--user','postgres','--entrypoint','bash','supabase/postgres:15.1.1.78','-c',bootstrap)
        for _ in range(60):
            p=subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],capture_output=True)
            if p.returncode==0:break
            time.sleep(.5)
        else:raise RuntimeError('Synthetic clone not ready')
        docker('exec',name,'psql','-h','127.0.0.1','-U','postgres','-X','-v','ON_ERROR_STOP=1','-c','CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;')
        docker('exec',name,'createdb','-h','127.0.0.1','-U','postgres','movabi_develop')
        # Synthetic SQL tests only; the real-server verifier preserves owners/ACLs separately.
        with archive.open('rb') as stream:docker('exec','-i',name,'pg_restore','-h','127.0.0.1','-U','postgres','-d','movabi_develop','--no-owner','--no-acl','--exit-on-error',stdin=stream)
        # Fixture archive used different synthetic driver IDs. Seed the approved-scope
        # identifiers in THIS disposable synthetic clone only, never a real environment.
        sql("INSERT INTO public.profiles(id,tenant_id,role,registration_country_code,country_code,registration_activated_at) VALUES('318e6be9-9164-41fa-bb0c-c5ccd3526585','d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','driver','NG','NG',now()) ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,role='driver',registration_country_code='NG',country_code='NG',registration_activated_at=now();")
        sql('BEGIN;'+(ROOT/'supabase/migrations'/NAME).read_text().split('BEGIN;',1)[1].rsplit('COMMIT;',1)[0]+'ROLLBACK;')
        result=subprocess.run([sys.executable,str(ROOT/'scripts/verify-develop-wallet-backup.py'),'--fixture-source',name,
            '--backup-root',str(ROOT/'.temp'/('setup-only-rehearsal-'+name[-8:])),
            '--setup-only-directory',str(ROOT/'scripts/ng-setup-only-review/migrations'),
            '--expected-driver','318e6be9-9164-41fa-bb0c-c5ccd3526585','--expected-tenant','d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8'],capture_output=True,text=True,timeout=300)
        if result.returncode:raise RuntimeError('Synthetic full backup/rehearsal helper failed; inspect private synthetic log')
        reports=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        report=reports[-1]
        assert report['sourceKind']=='synthetic-fixture' and report['restoreVerified'] and report['setupOnlyCloneVerified'] and report['protectedAuthorityUnchanged']
        protected=json.loads(sql(PROTECTED_SQL))
        sql((ROOT/'supabase/migrations'/NAME).read_text())
        assert json.loads(sql(PROTECTED_SQL))==protected
        assert sql(DISABLED_SQL)=='t'
        assert sql("SELECT to_regclass('public.driver_payout_markets') IS NULL AND to_regclass('public.driver_collection_subaccounts') IS NULL AND to_regclass('public.job_settlement_methods') IS NULL")=='t'
        claim="SELECT count(*) FROM public.claim_driver_collection_setup('318e6be9-9164-41fa-bb0c-c5ccd3526585','d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','synthetic-merchant',repeat('a',64),repeat('b',64),'bank','6789');"
        fail('SET ROLE service_role; '+claim) # unapproved by default
        sql("UPDATE public.driver_collection_setup_markets SET merchant_account_ref='synthetic-merchant',capability_evidence_ref='synthetic-fixture-only',default_split_type='flat',default_split_value=1,merchant_identity_verified=true,administrative_default_approved=true,setup_approved=true,adapter_ready=true;")
        fail('SET ROLE authenticated; '+claim)
        fail('SET ROLE service_role; '+claim.replace('318e6be9-9164-41fa-bb0c-c5ccd3526585','11111111-1111-4111-8111-111111111111'))
        fail('SET ROLE service_role; '+claim.replace('d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','22222222-2222-4222-8222-222222222222'))
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:sql('SET ROLE service_role; '+claim),range(2)))
        assert sorted(results)==['0','1']
        assert sql('SET ROLE service_role; '+claim)=='0'
        sql("SET ROLE service_role; UPDATE public.driver_collection_setup_accounts SET state='action_required';")
        assert sql('SET ROLE service_role; '+claim)=='0'
        fail("SET ROLE service_role; DELETE FROM public.driver_collection_setup_accounts;")
        fail("DELETE FROM public.driver_collection_setup_accounts;")
        fail("UPDATE public.driver_collection_setup_accounts SET request_hash=repeat('c',64);")
        fail("SET ROLE service_role; UPDATE public.driver_collection_setup_accounts SET tenant_id='22222222-2222-4222-8222-222222222222';")
        fail("SET ROLE service_role; UPDATE public.driver_collection_setup_accounts SET state='completed';")
        fail("SET ROLE service_role; UPDATE public.driver_collection_setup_accounts SET state='completed',subaccount_id='RS_SYNTHETIC',provider_numeric_id='8';")
        sql("SET ROLE service_role; UPDATE public.driver_collection_setup_accounts SET state='completed',subaccount_id='RS_SYNTHETIC',provider_numeric_id='8',verification='retrieved';")
        fail("SET ROLE service_role; UPDATE public.driver_collection_setup_accounts SET state='action_required';")
        fail("SET ROLE service_role; UPDATE public.driver_collection_setup_accounts SET subaccount_id='RS_DIFFERENT';")
        # A changed alias cannot bypass the stronger unique owner/tenant/market claim.
        sql("UPDATE public.driver_collection_setup_markets SET merchant_account_ref='changed-alias';")
        assert sql('SET ROLE service_role; '+claim.replace('synthetic-merchant','changed-alias'))=='0'
        assert json.loads(sql(PROTECTED_SQL))==protected
        # Exercise the unchanged existing Stripe SQL authority using synthetic IDs only.
        # No Stripe API or transfer request is made; tr_synthetic is a fixture reference.
        sql("""INSERT INTO public.profiles(id,tenant_id,role,registration_country_code,country_code,registration_activated_at)
          VALUES('66666666-6666-4666-8666-666666666666','22222222-2222-4222-8222-222222222222','driver','GB','GB',now());
          INSERT INTO public.jobs(id,driver_id,tenant_id,country_code,currency_code,status,payment_status,payment_method)
          VALUES('55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666','22222222-2222-4222-8222-222222222222','GB','GBP','in_progress','paid','card');
          SELECT id FROM public.complete_job_with_pending_payout('55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666',
          '{"total":105,"payout":100,"platformFee":5,"commission":0,"commissionRate":0,"amountMinor":10000,"currency":"GBP","country":"GB","destination":"acct_synthetic"}',
          '{"completion_pin_verified_at":"synthetic-only"}');
          SELECT job_id FROM public.claim_queued_job_payout('55555555-5555-4555-8555-555555555555');""")
        assert sql("SELECT public.finish_queued_job_payout(job_id,token,'tr_synthetic') FROM public.job_payout_queue WHERE job_id='55555555-5555-4555-8555-555555555555';")=='t'
        assert sql("SELECT status||':'||stripe_transfer_id FROM public.driver_earnings WHERE job_id='55555555-5555-4555-8555-555555555555';")=='paid:tr_synthetic'
        assert hashlib.sha256(archive.read_bytes()).hexdigest()==digest
        print(json.dumps({'sourceKind':'synthetic-fixture-archive','restoredFixtureTestPassed':True,'setupOnlyMigration':NAME,'routingBookingFunctionsTriggersUnchanged':True,'claimRaceSingleWinner':True,'ownerTenantIsolation':True,'privatePermissions':True,'completionNeedsVerification':True,'existingStripeSqlFlowPassed':True,'realDevelopBackupRehearsed':False}))
    finally:
        subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=30)
if __name__=='__main__':main()
