"""Full synthetic archive/restore/migration rehearsal. No remote DB or credential access."""
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid
ROOT=Path(__file__).resolve().parent.parent
NAME='vaydu-backup-fixture-'+uuid.uuid4().hex[:8]
# Local matching-version fixture; the real remote hash is enforced outside fixture mode.
IMAGE='supabase/postgres:15.1.1.78'
BACKUPS=ROOT/'.tmp'/('collection-restore-'+uuid.uuid4().hex[:8])
def docker(*args,stdin=None):
    p=subprocess.run(['docker',*args],input=stdin,text=True,capture_output=True,timeout=120)
    if p.returncode:raise RuntimeError('Synthetic Docker operation failed: '+args[0])
    return p.stdout.strip()
def sql(text):return docker('exec','-i',NAME,'psql','-h','127.0.0.1','-U','postgres','-d','movabi_develop','-X','-qAt','-v','ON_ERROR_STOP=1',stdin=text)
def file(relative):return sql((ROOT/relative).read_text(encoding='utf-8'))
def main():
    subprocess.run([sys.executable,str(ROOT/'scripts/prepare-ng-sandbox-operator-review.py')],check=True)
    try:
        docker('run','--detach','--rm','--network','none','--name',NAME,'--user','postgres','--entrypoint','bash',IMAGE,'-c',
               'initdb -D /tmp/vaydu-source -A trust --no-locale >/dev/null && exec postgres -D /tmp/vaydu-source -c shared_preload_libraries=pg_net -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp')
        for _ in range(40):
            try:
                docker('exec',NAME,'pg_isready','-h','127.0.0.1','-U','postgres');break
            except RuntimeError:time.sleep(.5)
        docker('exec',NAME,'createdb','-h','127.0.0.1','-U','postgres','movabi_develop')
        file('scripts/check-driver-payment-account-fixture.sql')
        source=(ROOT/'supabase/migrations/20261241000000_driver_settlement_claim.sql').read_text(encoding='utf-8')
        sql(source[source.index('CREATE OR REPLACE FUNCTION public.record_job_settlement('):])
        file('supabase/migrations/20261242000000_completion_payout_outbox.sql')
        file('supabase/migrations/20261023230000_market_payment_routes.sql')
        file('scripts/check-collection-subaccount-fixture.sql')
        sql("""CREATE FUNCTION public.wallet_collection_enabled() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
          CREATE TABLE public.wallet_accounts(id uuid);CREATE TABLE public.wallet_business_events(id uuid);
          CREATE TABLE public.wallet_movements(id uuid);CREATE TABLE public.wallet_topup_attempts(id uuid);
          CREATE TABLE public.payment_checkout_attempts(reference text PRIMARY KEY,state text);
          INSERT INTO public.payment_checkout_attempts VALUES('synthetic-submitted','submitted'),('synthetic-unknown','unknown');
          INSERT INTO public.profiles VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','driver','NG','NG',NULL);""")
        BACKUPS.mkdir(parents=True,exist_ok=False)
        args=[sys.executable,str(ROOT/'scripts/verify-develop-wallet-backup.py'),'--fixture-source',NAME,'--backup-root',str(BACKUPS),
              '--migration-directory',str(ROOT/'scripts/ng-sandbox-review/migrations'),
              '--expected-driver','11111111-1111-4111-8111-111111111111','--expected-tenant','22222222-2222-4222-8222-222222222222']
        result=subprocess.run(args,text=True,capture_output=True,timeout=300)
        if result.returncode:raise RuntimeError('Synthetic backup rehearsal refused: '+result.stdout[-2500:])
        manifests=list(BACKUPS.glob('*/manifest.json'))
        assert len(manifests)==1
        manifest=json.loads(manifests[0].read_text(encoding='utf-8'))
        assert manifest['restoreVerified'] and manifest['collectionMigrationCloneVerified'] and manifest['selectedExistingDriverVerified'] and manifest['collectionGatesDisabledVerified']
        assert manifest['restoredCounts']==manifest['countsBefore']
        assert sql("SELECT to_regclass('public.driver_collection_subaccounts') IS NULL AND NOT public.wallet_collection_enabled();")=='t'
        # An older archive must not be accepted merely because wallet counts are
        # unchanged when the selected existing driver's profile is missing.
        sql("INSERT INTO public.profiles VALUES('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','driver','NG','NG',now());")
        stale_args=args+['--retry-backup',str(manifests[0].parent)]
        selected=stale_args.index('--expected-driver')+1
        stale_args[selected]='33333333-3333-4333-8333-333333333333'
        stale=subprocess.run(stale_args,text=True,capture_output=True,timeout=300)
        assert stale.returncode!=0 and 'selected existing driver/tenant is absent' in stale.stdout
        print('PASS: full synthetic archive restore, selected unactivated NG driver retained, ownership/ACLs, all five migrations only in isolated clone, source/gates unchanged; real develop archive still requires SSH rehearsal')
        print('PASS: stale archive refused when the selected existing driver is absent, despite unchanged wallet counts')
    finally:
        subprocess.run(['docker','rm','-f',NAME],capture_output=True,timeout=30)
if __name__=='__main__':main()
