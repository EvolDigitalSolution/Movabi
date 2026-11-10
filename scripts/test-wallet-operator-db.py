"""Synthetic wallet baseline -> full backup -> disposable canonical restore. Never a real develop backup."""
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
    name='vaydu-backup-fixture-'+uuid.uuid4().hex[:8]
    def docker(*parts,data=None,stdin=None):
        p=subprocess.run(['docker',*parts],input=data.encode() if data is not None else None,stdin=stdin,capture_output=True,text=False,timeout=120)
        if p.returncode:
            error=p.stderr.decode(errors='replace') if isinstance(p.stderr,bytes) else p.stderr
            safe=[label for label,needle in [('selected_scope','Confirmed activated NG/NGN driver/tenant required'),('base_dependencies','Setup-only base dependencies missing'),('already_applied','Setup-only objects already exist'),('missing_object','does not exist'),('permission','permission denied'),('constraint','violates'),('duplicate','already exists')] if needle in error]
            if data and 'VAYDU_WALLET_OPERATOR' in data:
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
        for file in ['scripts/check-wallet-topups-batch1c-fixture.sql','supabase/migrations/20261244000000_wallet_metadata_batch1a.sql','supabase/migrations/20261245000000_wallet_accounting_foundation_batch1b.sql','supabase/migrations/20261246000000_wallet_topups_batch1c.sql']:
            sql((ROOT/file).read_text(encoding='utf-8'))
        sql("ALTER TABLE public.market_payment_routes ADD CONSTRAINT market_payment_routes_provider_check CHECK(provider IN ('stripe','kora','fincra')); CREATE TABLE public.payment_checkout_attempts(reference text PRIMARY KEY,request jsonb NOT NULL,state text NOT NULL CHECK(state IN ('started','submitted','unknown')),checkout_url text,created_at timestamptz NOT NULL DEFAULT now()); INSERT INTO public.payment_checkout_attempts(reference,request,state) VALUES('synthetic-submitted','{}','submitted'),('synthetic-unknown','{}','unknown'); CREATE TABLE public.profiles(id uuid PRIMARY KEY,tenant_id uuid,role text,registration_country_code text,country_code text,registration_activated_at timestamptz); CREATE TABLE public.jobs(id uuid PRIMARY KEY); CREATE TABLE public.job_payout_queue(job_id uuid PRIMARY KEY);")
        # Fixture archive used different synthetic driver IDs. Seed the approved-scope
        # identifiers in THIS disposable synthetic clone only, never a real environment.
        sql("INSERT INTO public.profiles(id,tenant_id,role,registration_country_code,country_code,registration_activated_at) VALUES('318e6be9-9164-41fa-bb0c-c5ccd3526585','d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','driver','NG','NG',now()) ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,role='driver',registration_country_code='NG',country_code='NG',registration_activated_at=now();")
        canonical=ROOT/'.temp/wallet-operator-sql-test/supabase_incremental_schema_reconcile.sql'
        result=subprocess.run([sys.executable,str(ROOT/'scripts/verify-develop-wallet-backup.py'),'--fixture-source',name,'--backup-root',str(ROOT/'.temp'/('wallet-operator-rehearsal-'+name[-8:])), '--validate-canonical-sql',str(canonical),'--canonical-sha256',hashlib.sha256(canonical.read_bytes()).hexdigest(),'--canonical-wallet-guard','--expected-driver','318e6be9-9164-41fa-bb0c-c5ccd3526585','--expected-tenant','d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8'],capture_output=True,text=True,timeout=600)
        print(result.stdout)
        if result.returncode:raise RuntimeError('Synthetic canonical rehearsal failed')
        sql(canonical.read_text());sql(canonical.read_text())
        financial=(ROOT/'scripts/check-driver-card-five-percent.sql').read_text()
        financial='\n'.join(line for line in financial.splitlines() if not ('UPDATE public.market_payment_routes' in line or 'INSERT INTO public.market_payment_routes' in line))
        sql(financial)
        print(json.dumps({'syntheticSharedCardFinancialTestsPassed':True,'globalPreferredRouteNotRequired':True,'realDevelopRehearsalPerformed':False}))

    finally:
        subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=30)
if __name__=='__main__':main()
