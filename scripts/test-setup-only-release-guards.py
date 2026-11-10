"""Pure release proof/checksum and operator transport tests. No real commands."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch
from setup_only_release import NAME,load_release,require_real_proof,PROTECTED_SQL,DISABLED_SQL,ensure_no_legacy_setup

root=Path(__file__).resolve().parent
artifact=load_release(root/'ng-setup-only-review/migrations')
proof={'sourceKind':'verified-develop','sourceContainer':'movabi-develop-db','sourceDatabase':'movabi_develop',
 'restoreVerified':True,'walletOwnershipAndACLVerified':True,'setupOnlyCloneVerified':True,'protectedAuthorityUnchanged':True,
 'routingUnchanged':True,'bookingRowsUnchanged':True,'outboxRowsUnchanged':True,'selectedExistingDriverVerified':True,
 'collectionGatesDisabledVerified':True,'migrationSetSha256':artifact['manifestSha256'],'appliedSetupOnlyMigrations':[NAME]}
require_real_proof(proof,artifact['manifestSha256'])
for patch_values in [{'sourceKind':'synthetic-fixture'},{'setupOnlyCloneVerified':False},{'protectedAuthorityUnchanged':False},
                     {'sourceContainer':'other'},{'migrationSetSha256':'wrong'},{'appliedSetupOnlyMigrations':[]}]:
    try:require_real_proof({**proof,**patch_values},artifact['manifestSha256']);raise AssertionError('Unsafe proof accepted')
    except RuntimeError:pass

ensure_no_legacy_setup(lambda query:'f' if 'to_regclass' in query else 't')
try:ensure_no_legacy_setup(lambda query:'t' if 'to_regclass' in query else 'f');raise AssertionError('Legacy uncertain operation bypassed')
except RuntimeError:pass

spec=importlib.util.spec_from_file_location('apply_setup',root/'apply-driver-setup-only-release.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Folder:
    def is_symlink(self):return False
    def mkdir(self,**kwargs):pass
    def stat(self):return SimpleNamespace(st_uid=1000,st_mode=0o40700)
    def __truediv__(self,name):return Path('/synthetic-private-release')/name
calls=[];writes={}
fingerprints={'functions':'f','triggers':'t','columns':'c','constraints':'x','relations':'z','routes':'r','bookingRows':'b','outboxRows':'o'}
def run(args):
    calls.append(args)
    if 'info' in args:return 'synthetic'
    query=args[-1]
    if query==PROTECTED_SQL:return json.dumps(fingerprints)
    if query==DISABLED_SQL:return 't'
    if query.startswith("SELECT to_regclass('public.driver_collection_subaccounts'"):return 'f'
    if query=='SELECT public.wallet_collection_enabled()':return 'f'
    if query.startswith('SELECT json_build_object('):return json.dumps({'newNamesAbsent':True,'profiles':True})
    raise AssertionError('Unexpected command')
def execute(args,**kwargs):
    calls.append(args)
    assert kwargs['input']==artifact['body'] and 'psql' in args and 'movabi_develop' in args
    assert '--force-recreate' not in args
    return SimpleNamespace(returncode=0)
import os
with patch.object(m,'load_real_proof',return_value=({**proof,'sourceImage':'synthetic-image','protectedFingerprints':fingerprints},'synthetic-proof-sha')),\
 patch.object(m.release,'identity',return_value={}),patch.object(m.release,'metadata',return_value='synthetic-image'),\
 patch.object(m.release,'run',side_effect=run),patch.object(m.release,'REVIEW',Folder()),\
 patch.object(os,'getuid',return_value=1000,create=True),patch.object(m.release,'write_private',side_effect=lambda p,d:writes.update({str(p):d})),\
 patch.object(m.subprocess,'run',side_effect=execute),\
 patch.object(sys,'argv',['apply','--migration-directory',str(root/'ng-setup-only-review/migrations'),'--rehearsal-manifest','synthetic-proof','--apply']):
    m.main()
assert writes[str(Path('/synthetic-private-release')/'setup-only-schema.json')]['state']=='applied'
assert all('.Config.Env' not in ' '.join(args) for args in calls)
assert not any('up' in args or 'pg_dump' in args for args in calls)
print('PASS: real-proof requirements reject synthetic/stale scope; exact 550 operator transport and receipt; no real Docker/database commands')
