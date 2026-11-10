"""Synthetic Linux operator checks: no Docker, SSH, real provider or database."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from contextlib import redirect_stdout
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('checks',Path(__file__).with_name('check-cohost-disabled-stage.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
if not hasattr(os,'getuid'):raise SystemExit('Run this synthetic filesystem test in the network-disabled Linux container')
with tempfile.TemporaryDirectory(prefix='cohost-checks-') as tmp:
    root=Path(tmp);hashes={'server/routes/connect.routes.ts':'a'*64}
    (root/'review.json').write_text(json.dumps({'imageId':m.PIN,'protectedSourceHashes':hashes}))
    migrations=root/'migrations';migrations.mkdir();(migrations/'synthetic.sql').write_text('SELECT 1;')
    (migrations/'migration-manifest.json').write_text(json.dumps({'files':[{'name':'synthetic.sql','sha256':hashlib.sha256(b'SELECT 1;').hexdigest()}]}))
    phase='baseline';calls=[];drift=False;unsafe=False
    def run(args):
        calls.append(args)
        if 'info' in args:return 'synthetic'
        if 'node' in args:
            code=args[-1]
            if 'const paths=' in code:return json.dumps({'/health':200,'/api/connect/payout-settings':401,'/api/driver-payment-account/status':401})
            if 'createHash' in code:return json.dumps(hashes if not drift else {'server/routes/connect.routes.ts':'b'*64})
            flags={k:'false' for k in m.KEYS};flags.update(NODE_ENV='production',VAYDU_DEPLOYMENT_ENV='develop',VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP='true' if phase=='post-stage' else 'false')
            if unsafe:flags['VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED']='true'
            return json.dumps(flags)
        query=args[-1]
        if query.startswith('SELECT EXISTS(SELECT 1 FROM public.profiles'):return 't'
        if 'count(DISTINCT supported_currency)' in query:return 't'
        if query=='SELECT public.wallet_collection_enabled()':return 'f'
        if query.startswith("SELECT to_regclass("):return 't' if 'driver_collection_setup_markets' in query else 'f'
        if 'FROM public.driver_collection_setup_markets' in query:return 't'
        if "json_build_object('routes'" in query:return json.dumps({'routes':'r','completion':'c','settlement':'s'})
        if "json_build_object('payoutMarkets'" in query:return json.dumps({'payoutMarkets':False,'collectionMarkets':False,'collectionAccounts':False,'bookingSettlement':False})
        if 'information_schema.columns' in query:return json.dumps([{'schema':'public','column':'version'}])
        if query.startswith('SELECT count(*) FROM public.schema_migrations'):return '0'
        raise AssertionError('Unexpected command; no writes allowed')
    def identity(_):return {'previousImage':m.PIN if phase=='post-stage' else m.BASELINE}
    def metadata(_d,name,template):
        if name=='movabi-develop-db':return m.release.EXPECTED_IMAGE if hasattr(m.release,'EXPECTED_IMAGE') else 'synthetic-db-image'
        if '.Mounts' in template:return json.dumps([{'Destination':'/run/vaydu/flutterwave-test.env','RW':False,'Source':str(m.release.PRIVATE)}])
        raise AssertionError('Unexpected metadata')
    with patch.object(m,'ROOT',root),patch.object(m.release,'identity',side_effect=identity),patch.object(m.release,'metadata',side_effect=metadata),patch.object(m.release,'run',side_effect=run):
        for phase in ['baseline','migration-plan','post-stage','post-rollback']:

            with patch.object(sys,'argv',['checks',phase]),redirect_stdout(io.StringIO()):m.main()
        backup=root/'vaydu-develop-wallet-backups'/'synthetic-fresh';backup.mkdir(parents=True)
        archive=backup/'movabi_develop.dump';archive.write_bytes(b'synthetic-archive-not-a-database')
        manifest=backup/'manifest.json';digest=hashlib.sha256(archive.read_bytes()).hexdigest()
        manifest.write_text(json.dumps({'restoreVerified':True,'sourceContainer':'movabi-develop-db','sourceDatabase':'movabi_develop','sourceImage':'synthetic-db-image','sha256':digest}))
        (root/'operator-evidence'/'fresh-backup.log').write_text(json.dumps({'restoreVerified':True,'backupDirectory':str(backup),'verificationManifest':str(manifest)}))
        phase='backup'
        with patch.object(Path,'home',return_value=root),patch.object(sys,'argv',['checks',phase]),redirect_stdout(io.StringIO()):m.main()
        assert json.loads((root/'operator-evidence'/'accepted-backup.json').read_text())['sha256']==digest
        for mode in ['drift','approval']:

            phase='post-stage';drift=mode=='drift';unsafe=mode=='approval'
            with patch.object(sys,'argv',['checks',phase]),redirect_stdout(io.StringIO()):
                try:m.main();raise AssertionError('Unsafe state accepted')
                except RuntimeError:pass
        drift=False;unsafe=False
        (root/'review.json').write_text(json.dumps({'imageId':m.PIN,'protectedSourceHashes':hashes,'schemaScope':'setup-only-550'}))
        phase='post-stage'
        with patch.object(sys,'argv',['checks',phase]),redirect_stdout(io.StringIO()):m.main()
        phase='backup'
        with patch.object(Path,'home',return_value=root),patch.object(sys,'argv',['checks',phase]),redirect_stdout(io.StringIO()):
            try:m.main();raise AssertionError('Synthetic proof accepted for setup-only combined release')
            except RuntimeError:pass
        assert all('up' not in args and 'pg_dump' not in args for args in calls)
        assert not any('.Config.Env' in ' '.join(args) for args in calls)
print('PASS: synthetic baseline, migration deferral, post-stage/rollback health/auth, source-drift and approval-gate rejection; no real commands')
