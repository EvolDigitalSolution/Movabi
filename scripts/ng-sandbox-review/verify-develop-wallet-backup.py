"""Back up only verified develop; restore only into a fresh isolated container.

No credential values or database contents are printed. No application writes,
migrations, collection enablement, environment changes or production operations.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid

EXPECTED_IMAGE = 'sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture-source')
    parser.add_argument('--backup-root')
    parser.add_argument('--retry-backup')
    parser.add_argument('--validate-canonical-sql')
    parser.add_argument('--canonical-sha256')
    parser.add_argument('--migration-directory')
    parser.add_argument('--expected-driver')
    parser.add_argument('--expected-tenant')
    args = parser.parse_args()
    release_sql = None
    if args.validate_canonical_sql:
        path=Path(args.validate_canonical_sql)
        if path.name!='supabase_incremental_schema_reconcile.sql' or path.is_symlink():
            raise RuntimeError('Expected reviewed canonical SQL file')
        release_sql=path.read_bytes()
        if not args.canonical_sha256 or hashlib.sha256(release_sql).hexdigest()!=args.canonical_sha256:
            raise RuntimeError('Canonical SQL checksum mismatch')
    migration_files=[]
    migration_set_sha=None
    if args.migration_directory:
        if release_sql:raise RuntimeError('Choose canonical or collection migration rehearsal, not both')
        directory=Path(args.migration_directory)
        if directory.is_symlink():raise RuntimeError('Refusing symlinked migration directory')
        manifest_file=directory/'migration-manifest.json'
        if manifest_file.is_symlink():raise RuntimeError('Refusing symlinked migration manifest')
        manifest_bytes=manifest_file.read_bytes()
        release_manifest=json.loads(manifest_bytes)
        expected_names=['20261253900000_flutterwave_market_provider_prerequisite.sql','20261254600000_driver_payment_accounts_sandbox.sql',
                        '20261254700000_flutterwave_payout_outbox.sql','20261254800000_flutterwave_collection_subaccounts.sql',
                        '20261254900000_flutterwave_booking_split_authority.sql']
        if release_manifest.get('purpose')!='vaydu-collection-disabled-rehearsal' or [x.get('name') for x in release_manifest.get('files',[])]!=expected_names:
            raise RuntimeError('Unexpected collection migration manifest')
        for item in release_manifest['files']:
            path=directory/item['name']
            if path.is_symlink():raise RuntimeError('Refusing symlinked migration source')
            body=path.read_bytes()
            if hashlib.sha256(body).hexdigest()!=item['sha256']:raise RuntimeError('Collection migration checksum mismatch')
            migration_files.append((item['name'],body))
        migration_set_sha=hashlib.sha256(manifest_bytes).hexdigest()
        if not args.expected_driver or not args.expected_tenant:raise RuntimeError('Existing driver and tenant UUIDs from read-only audit are required')
    if bool(args.expected_driver)!=bool(args.expected_tenant):raise RuntimeError('Both existing driver and tenant UUIDs are required')
    if args.expected_driver and any(not re.fullmatch(r'[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}',x) for x in [args.expected_driver,args.expected_tenant]):
        raise RuntimeError('Driver/tenant identifiers must be UUIDs')
    fixture = args.fixture_source
    if fixture and not re.fullmatch(r'vaydu-backup-fixture-[a-f0-9]{8}', fixture):
        raise RuntimeError('Invalid disposable fixture name')
    if args.backup_root and not fixture:
        raise RuntimeError('Custom backup root is available only in fixture mode')
    docker = ['docker']
    if subprocess.run(docker + ['info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        docker = ['sudo', '-n', 'docker']

    def command(parts, *, input_data=None, stdin=None, stdout=None, timeout=120):
        result = subprocess.run(docker + parts, input=input_data, stdin=stdin,
                                stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode:
            stage = next((value for value in ('pg_dump','pg_restore','createdb','psql','inspect','run','rm') if value in parts), parts[0])
            diagnostic = (result.stderr or b'').decode(errors='replace').lower()
            signatures = {
                'superuser_required': ('must be superuser', 'must be a superuser'),
                'owner_mismatch': ('must be owner', 'permission denied to change owner'),
                'permission_denied': ('permission denied',),
                'extension_unavailable': ('extension is not available', 'could not open extension control file'),
                'role_related': ('role ',),
                'object_missing': ('does not exist',),
                'duplicate_object': ('already exists',),
                'configuration_mismatch': ('unrecognized configuration parameter',),
                'constraint_failure': ('violates ',),
                'archive_invalid': ('unsupported version', 'input file does not appear', 'unexpected end of file'),
            }
            categories = [key for key, values in signatures.items() if any(value in diagnostic for value in values)]
            print('SAFE_DIAGNOSTIC: ' + json.dumps({'stage': stage, 'categories': categories or ['unclassified'],
                  'errorCount': diagnostic.count('error:')}), flush=True)
            raise RuntimeError('Docker operation failed at ' + stage + '; raw diagnostic output suppressed')
        return result.stdout or b''

    def inspect(name):
        # Project/image/network metadata only. Never fetch container Env or connection URLs.
        template='{"Image":{{json .Image}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}},"Config":{"Labels":{{json .Config.Labels}}}}'
        return json.loads(command(['inspect','--format',template,name]))

    source = fixture or 'movabi-develop-db'
    metadata = inspect(source)
    image = metadata['Image']
    if not fixture:
        if image != EXPECTED_IMAGE or set(metadata['NetworkSettings']['Networks']) != {'movabi-develop-private'}:
            raise RuntimeError('Develop database identity changed')
        rest = inspect('movabi-develop-rest')
        api = inspect('movabi-develop-api')
        if any((x['Config'].get('Labels') or {}).get('com.docker.compose.project')!='movabi-develop' for x in (rest,api)):
            raise RuntimeError('Develop application project identity changed')
        if 'movabi-develop-private' not in rest['NetworkSettings']['Networks']:
            raise RuntimeError('Develop REST network identity changed')
        # The known database itself is verified below. No PGRST_DB_URI, API Env,
        # existing credential file or connection secret is extracted.

    def sql(container, database, query, readonly=True):
        options = ['-e', 'PGOPTIONS=-c default_transaction_read_only=on'] if readonly else []
        host = ['-h', '127.0.0.1'] if container != source or fixture else []
        return command(['exec'] + options + [container, 'psql', '-X', '-U', 'postgres', '-d', database,
                       '-qAt', '-v', 'ON_ERROR_STOP=1'] + host + ['-c', query]).decode().strip()

    if sql(source, 'movabi_develop', 'SELECT current_database()') != 'movabi_develop':
        raise RuntimeError('Database identity mismatch')
    if sql(source, 'movabi_develop', 'SELECT public.wallet_collection_enabled()') != 'f':
        raise RuntimeError('Collection is not confirmed disabled; stop and inspect')
    tables = ('wallet_accounts', 'wallet_business_events', 'wallet_movements',
              'wallet_topup_attempts', 'payment_checkout_attempts')

    def counts(container, database):
        return {table: int(sql(container, database, 'SELECT count(*) FROM public.' + table)) for table in tables}

    before = counts(source, 'movabi_develop')
    def selected_driver(container,database):
        if not args.expected_driver:return None
        query="SELECT json_build_object('id',id,'tenant',tenant_id,'country',coalesce(nullif(registration_country_code,''),country_code),'activated',registration_activated_at IS NOT NULL) FROM public.profiles WHERE role='driver' AND id='"+args.expected_driver+"'::uuid AND tenant_id='"+args.expected_tenant+"'::uuid"
        out=sql(container,database,query)
        if not out:raise RuntimeError('The selected existing driver/tenant is absent from source or restored backup')
        value=json.loads(out)
        if value['country']!='NG':raise RuntimeError('Selected driver is not registered to NG')
        return value
    driver_before=selected_driver(source,'movabi_develop')

    security_query = """SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'owner',pg_get_userbyid(c.relowner),'acl',
      (SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type),'[]'::jsonb)
       FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a)) ORDER BY c.relname),'[]'::jsonb)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN
      ('wallet_accounts','wallet_business_events','wallet_movements','wallet_topup_attempts','payment_checkout_attempts')"""
    # Order by role NAME rather than role OID: the fresh cluster has new OIDs.
    security_query = security_query.replace('ORDER BY a.grantor,a.grantee,a.privilege_type', "ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type")
    security_before = json.loads(sql(source, 'movabi_develop', security_query))
    size = int(sql(source, 'movabi_develop', "SELECT pg_database_size('movabi_develop')"))
    root = Path(args.backup_root) if fixture else Path.home() / 'vaydu-develop-wallet-backups'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    wrong_owner = hasattr(os, 'getuid') and root.stat().st_uid != os.getuid()
    if root.is_symlink() or wrong_owner:
        raise RuntimeError('Backup root is not owned by the current user or is a symlink')
    os.chmod(root, 0o700)
    if shutil.disk_usage(root).free < max(size * 4, 1024 * 1024 * 1024):
        raise RuntimeError('Insufficient free disk for backup and disposable verification')
    previous = None
    if args.retry_backup:
        folder = Path(args.retry_backup).resolve()
        if folder.parent != root.resolve() or not re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{8}', folder.name):
            raise RuntimeError('Retry archive is outside the private backup root')
        if (folder / 'manifest.json').is_symlink() or (folder / 'movabi_develop.dump').is_symlink():
            raise RuntimeError('Refusing symlinked backup artifacts')
        previous = json.loads((folder / 'manifest.json').read_text(encoding='utf8'))
        if previous.get('sourceContainer') != source or previous.get('sourceDatabase') != 'movabi_develop' or previous.get('sourceImage') != image:
            raise RuntimeError('Archive provenance does not match verified develop')
        if previous.get('countsBefore') != before:
            raise RuntimeError('Wallet baseline changed since the retained backup')
    else:
        folder = root / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8])
        folder.mkdir(mode=0o700)
    print('BACKUP_DIRECTORY: ' + str(folder), flush=True)
    dump = folder / 'movabi_develop.dump'
    manifest = {'sourceContainer': source, 'sourceDatabase': 'movabi_develop', 'sourceImage': image,
                'countsBefore': before, 'databaseBytes': size, 'restoreVerified': False}
    restore = 'vaydu-develop-restore-' + uuid.uuid4().hex[:12]
    created = False
    try:
        if not previous:
            with open(dump, 'xb') as output:
                os.chmod(dump, 0o600)
                command(['exec', source, 'pg_dump'] + (['-h', '127.0.0.1'] if fixture else []) + ['-U', 'postgres', '-d', 'movabi_develop',
                         '--format=custom', '--lock-wait-timeout=15s'],
                        stdout=output, timeout=300)
        digest = hashlib.sha256(dump.read_bytes()).hexdigest()
        if previous and (previous.get('sha256') != digest or previous.get('dumpBytes') != dump.stat().st_size):
            raise RuntimeError('Retained archive checksum/size mismatch')
        manifest.update({'dumpBytes': dump.stat().st_size, 'sha256': digest})
        # No host ports, application network, persistent volume or credentials.
        bootstrap = 'initdb -D /tmp/vaydu-restore -A trust --no-locale >/dev/null && exec postgres -D /tmp/vaydu-restore -c shared_preload_libraries=pg_net -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp'
        command(['run', '--detach', '--network', 'none', '--memory=768m', '--cpus=1', '--pids-limit=256',
                 '--name', restore, '--label', 'vaydu.purpose=disposable-backup-restore',
                 '--user', 'postgres', '--entrypoint', 'bash', image, '-c', bootstrap])
        created = True
        for _ in range(60):
            ready = subprocess.run(docker + ['exec', restore, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Disposable restore database did not become ready')
        # Preserve structural role attributes needed for ownership (e.g. event
        # triggers require a superuser owner), only in the isolated clone.
        # Login permission and credentials are never copied.
        roles = json.loads(sql(source, 'movabi_develop', "SELECT coalesce(json_agg(json_build_object('name',rolname,'super',rolsuper,'inherit',rolinherit,'createrole',rolcreaterole,'createdb',rolcreatedb,'replication',rolreplication,'bypassrls',rolbypassrls)),'[]') FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres'"))
        for role in roles:
            literal = "'" + role['name'].replace("'", "''") + "'"
            sql(restore, 'postgres', "DO $restore$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=" + literal + ") THEN EXECUTE format('CREATE ROLE %I NOLOGIN'," + literal + "); END IF; END $restore$;", readonly=False)
            identifier = '"' + role['name'].replace('"', '""') + '"'
            attributes = ['NOLOGIN'] + [(option if role[key] else 'NO' + option) for key, option in
                (('super','SUPERUSER'),('inherit','INHERIT'),('createrole','CREATEROLE'),('createdb','CREATEDB'),('replication','REPLICATION'),('bypassrls','BYPASSRLS'))]
            sql(restore, 'postgres', 'ALTER ROLE ' + identifier + ' ' + ' '.join(attributes), readonly=False)
        restore_database='movabi_develop' if (release_sql or migration_files) else 'vaydu_restore_check'
        command(['exec', restore, 'createdb', '-h', '127.0.0.1', '-U', 'postgres', '-T', 'template0', restore_database])
        with open(dump, 'rb') as archive:
            command(['exec', '-i', restore, 'pg_restore', '-h', '127.0.0.1', '-U', 'postgres', '-d', restore_database,
                     '--exit-on-error'], stdin=archive, timeout=300)
        after = counts(source, 'movabi_develop')
        restored = counts(restore, restore_database)
        if before != after or before != restored:
            raise RuntimeError('Wallet counts changed during backup or restore counts differ; backup is not verified')
        security_restored = json.loads(sql(restore, restore_database, security_query))
        if security_before != security_restored:
            raise RuntimeError('Restored wallet ownership/ACLs differ; backup is not verified')
        if hashlib.sha256(dump.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Backup checksum changed')
        if driver_before is not None and selected_driver(restore,restore_database)!=driver_before:
            raise RuntimeError('Restored existing driver identity/registration does not match the current source')
        if migration_files:
            check=inspect(restore)
            if restore==source or (check['Config'].get('Labels') or {}).get('vaydu.purpose')!='disposable-backup-restore' or set(check['NetworkSettings']['Networks'])!={'none'}:
                raise RuntimeError('Collection rehearsal clone identity mismatch')
            prerequisite_sql="""SELECT json_build_object(
              'marketRoutes',to_regclass('public.market_payment_routes') IS NOT NULL,
              'routeAudit',to_regclass('public.market_payment_route_audit') IS NOT NULL,
              'outbox',to_regclass('public.job_payout_queue') IS NOT NULL,
              'refundLedger',to_regclass('public.refund_operations') IS NOT NULL,
              'completionAuthority',to_regprocedure('public.complete_job_with_pending_payout(uuid,uuid,jsonb,jsonb)') IS NOT NULL,
              'settlementAuthority',to_regprocedure('public.record_job_settlement(uuid,uuid,numeric,numeric,numeric,numeric,numeric,text,text,text,boolean)') IS NOT NULL,
              'newTablesAbsent',to_regclass('public.driver_payout_markets') IS NULL AND to_regclass('public.driver_collection_subaccounts') IS NULL AND to_regclass('public.job_settlement_methods') IS NULL)"""
            prerequisites=json.loads(sql(restore,restore_database,prerequisite_sql))
            print('CLONE_PREREQUISITES: '+json.dumps(prerequisites,sort_keys=True),flush=True)
            missing=[name for name,ready in prerequisites.items() if not ready]
            if missing:raise RuntimeError('Collection rehearsal prerequisites missing or already partially applied: '+','.join(missing))
            # These are actual migration sources, applied only to the fresh isolated restore.
            # Missing baseline/outbox contracts refuse rehearsal rather than importing guessed prerequisites.
            for name,body in migration_files:
                print('CLONE_MIGRATION: '+name,flush=True)
                command(['exec','-i',restore,'psql','-h','127.0.0.1','-U','postgres','-d',restore_database,'-X','-v','ON_ERROR_STOP=1'],input_data=body,timeout=120)
            disabled=sql(restore,restore_database,"SELECT NOT EXISTS(SELECT 1 FROM public.driver_collection_markets WHERE setup_approved OR split_collection_approved OR f4b_approved OR adapter_ready) AND NOT EXISTS(SELECT 1 FROM public.driver_collection_subaccounts) AND NOT EXISTS(SELECT 1 FROM public.driver_payout_markets WHERE enabled OR merchant_approved OR adapter_ready)")
            if disabled!='t' or counts(restore,restore_database)!=before or sql(restore,restore_database,'SELECT public.wallet_collection_enabled()')!='f':
                raise RuntimeError('Collection rehearsal changed protected counts or enabled a capability')
            if selected_driver(restore,restore_database)!=driver_before:raise RuntimeError('Migrations changed the selected driver identity')
            manifest.update({'collectionMigrationCloneVerified':True,'migrationSetSha256':migration_set_sha,
                             'appliedCloneMigrations':[name for name,_ in migration_files],'selectedExistingDriverVerified':True,'collectionGatesDisabledVerified':True})
        if release_sql:
            # The target is always the fresh labeled, network-none clone, never
            # the source application container. Original database name is used
            # only inside that clone so canonical development guards run.
            check=inspect(restore)
            if restore==source or (check['Config'].get('Labels') or {}).get('vaydu.purpose')!='disposable-backup-restore' or set(check['NetworkSettings']['Networks'])!={'none'}:
                raise RuntimeError('Canonical clone target identity mismatch')
            for _ in range(2):
                command(['exec','-i',restore,'psql','-h','127.0.0.1','-U','postgres','-d',restore_database,'-X','-v','ON_ERROR_STOP=1'],input_data=release_sql,timeout=120)
            if counts(restore,restore_database)!=before or sql(restore,restore_database,'SELECT public.wallet_collection_enabled()')!='f' or sql(restore,restore_database,'SELECT public.driver_card_sandbox_enabled()')!='f':
                raise RuntimeError('Canonical clone data/gates changed unexpectedly')
            manifest.update({'canonicalCloneVerified':True,'canonicalSqlSha256':args.canonical_sha256,'canonicalRepeatVerified':True})
        manifest.update({'countsAfter': after, 'restoredCounts': restored, 'restoreVerified': True,
                         'walletOwnershipAndACLVerified': True,
                         'restoreScope': 'Full archive with object ownership/ACL restored; wallet table owners/ACLs compared; structural role attributes copied only into the isolated clone, all copied roles NOLOGIN and no credentials copied'})
    finally:
        manifest_path = folder / ('verification-' + restore.removeprefix('vaydu-develop-restore-') + '.json' if previous else 'manifest.json')
        with open(manifest_path, 'w', encoding='utf8') as output:
            json.dump(manifest, output, indent=2)
        os.chmod(manifest_path, 0o600)
        if created:
            check = inspect(restore)
            if (check['Config'].get('Labels') or {}).get('vaydu.purpose') == 'disposable-backup-restore' and set(check['NetworkSettings']['Networks']) == {'none'}:
                command(['rm', '-f', restore])
            else:
                raise RuntimeError('Disposable container cleanup identity mismatch; manual inspection required')
    print(json.dumps({'backupDirectory': str(folder), 'sha256': manifest['sha256'],
                      'verificationManifest': str(manifest_path),
                      'restoreVerified': manifest['restoreVerified'], 'walletCounts': manifest['restoredCounts'],
                      'canonicalCloneVerified':manifest.get('canonicalCloneVerified',False),
                      'collectionMigrationCloneVerified':manifest.get('collectionMigrationCloneVerified',False),
                      'selectedExistingDriverVerified':manifest.get('selectedExistingDriverVerified',False),
                      'collectionGatesDisabledVerified':manifest.get('collectionGatesDisabledVerified',False),
                      'scope': manifest['restoreScope']}), flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('BACKUP_NOT_VERIFIED: ' + reason + '; backup artifacts retained privately if created', flush=True)
        raise SystemExit(1)
