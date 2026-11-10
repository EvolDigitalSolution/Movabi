"""Synthetic release preflight: no Docker, SSH, credentials or deployment."""
import importlib.util
import io
import json
import stat
import sys
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('cohost_release',Path(__file__).with_name('release-driver-collection-cohost.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
image='sha256:'+'a'*64
record={'service':'api','files':['/verified/develop/compose.yml'],'directory':'/verified/develop','previousImage':'sha256:'+'b'*64}
command=module.compose(['docker'],record,Path('/review/stage.json'))
assert command==['docker','compose','--project-name','movabi-develop','--project-directory','/verified/develop',
                 '-f','/verified/develop/compose.yml','-f',str(Path('/review/stage.json')),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','api']
assert 'NODE_ENV' not in module.FLAGS
assert module.FLAGS['VAYDU_DRIVER_SUBACCOUNT_SANDBOX']=='false'
assert module.FLAGS['VAYDU_DRIVER_SUBACCOUNT_MERCHANT_VERIFIED']=='false'
assert module.FLAGS['VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED']=='false'
assert not any(name.startswith(('SUPABASE_','POSTGRES_','DATABASE_','STRIPE_')) for name in module.FLAGS)

class ProviderFile:
    def is_symlink(self):return False
    def stat(self):return SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=1000,st_gid=1000,st_size=500)
    def __str__(self):return '/private/existing-provider-file.env'
    def read_text(self,*args,**kwargs):raise AssertionError('No credential file reads allowed by release helper')

def check(schema):
    calls=[]
    def run(args):
        calls.append(args)
        if 'image' in args:return image
        if 'exec' in args:return 't' if schema else 'f'
        return 'synthetic-version'
    with patch.object(module,'identity',return_value=record),patch.object(module,'PRIVATE',ProviderFile()),patch.object(module,'run',side_effect=run),\
         patch.object(module,'metadata',return_value=''),patch.object(sys,'argv',['release','--plan','--image',image]):
        output=io.StringIO()
        with redirect_stdout(output):module.main()
    result=json.loads(output.getvalue())
    assert result['planOnly'] and result['migrationPrerequisitesPresent']==schema
    assert not result['activationEnabled'] and not result['merchantApproved'] and not result['defaultSplitApproved']
    assert all('up' not in args for args in calls)
    assert not any('.Config.Env' in ' '.join(args) or 'config' in args for args in calls)
check(True);check(False)
class ReviewFile:
    def __init__(self,name):self.name=name
    def __str__(self):return '/private/review/'+self.name
    def is_symlink(self):return False
    def read_text(self):return json.dumps({'state':'applied','manifestSha256':'synthetic-setup-manifest','rehearsalProofSha256':'synthetic-proof'}) if self.name=='setup-only-schema.json' else json.dumps(record)
class ReviewDirectory:
    def is_symlink(self):return False
    def mkdir(self,**kwargs):pass
    def stat(self):return SimpleNamespace(st_uid=1000,st_mode=stat.S_IFDIR|0o700)
    def __truediv__(self,name):return ReviewFile(name)
for action,missing in [('--stage-disabled',False),('--rollback',False),('--stage-disabled',True)]:
    calls=[];writes={}
    def simulated_run(args):
        calls.append(args)
        if 'image' in args:return image
        if 'exec' in args:return 'f' if missing else 't'
        return 'synthetic-version'
    with patch.object(module,'identity',return_value=dict(record)),patch.object(module,'PRIVATE',ProviderFile()),\
         patch.object(module,'REVIEW',ReviewDirectory()),patch.object(module,'metadata',return_value=''),\
         patch.object(module.os,'getuid',return_value=1000,create=True),patch.object(module,'run',side_effect=simulated_run),\
         patch.object(module,'write_private',side_effect=lambda path,value:writes.update({str(path):value})),\
         patch.object(sys,'argv',['release',action,'--image',image]+(['--allow-missing-schema-disabled'] if missing else [])):
        with redirect_stdout(io.StringIO()):module.main()
    commands=[args for args in calls if 'compose' in args]
    assert len(commands)==1 and '--no-deps' in commands[0] and commands[0][-1]=='api'
    override=writes['/private/review/'+('stage.json' if action=='--stage-disabled' else 'rollback.json')]['services']['api']
    assert override['environment']['VAYDU_DRIVER_SUBACCOUNT_SANDBOX']=='false'
    assert override['environment']['VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED']=='false'
    assert 'NODE_ENV' not in override['environment']
    if action=='--stage-disabled':assert override['volumes'][0]['read_only'] is True
    else:assert override['image']==record['previousImage'] and 'volumes' not in override
import setup_only_release as setup
setup_calls=[]
def setup_run(args):
    setup_calls.append(args)
    if 'image' in args:return image
    if 'exec' in args:return 't'
    return 'synthetic-version'
with patch.object(module,'identity',return_value=dict(record)),patch.object(module,'PRIVATE',ProviderFile()),patch.object(module,'REVIEW',ReviewDirectory()),\
     patch.object(module,'metadata',return_value=''),patch.object(module.os,'getuid',return_value=1000,create=True),\
     patch.object(module,'run',side_effect=setup_run),patch.object(module,'write_private'),\
     patch.object(setup,'load_release',return_value={'manifestSha256':'synthetic-setup-manifest'}),\
     patch.object(setup,'load_real_proof',return_value=({},'synthetic-proof')),\
     patch.object(sys,'argv',['release','--stage-disabled','--image',image,'--setup-only-directory','synthetic-directory','--rehearsal-manifest','synthetic-proof']):
    with redirect_stdout(io.StringIO()):module.main()
assert any('driver_collection_setup_markets' in args[-1] for args in setup_calls if 'exec' in args)
assert not any('driver_payout_markets' in args[-1] for args in setup_calls if 'exec' in args)
with patch.object(module,'identity',return_value=record),patch.object(module,'PRIVATE',ProviderFile()),\
     patch.object(module,'run',side_effect=lambda args:image if 'image' in args else 'f'),\
     patch.object(sys,'argv',['release','--stage-disabled','--image',image]):
    try:module.main();raise AssertionError('Missing migrations must block staging')
    except RuntimeError as error:assert 'migrations' in str(error)
print('PASS: disabled release plan, missing-schema guard, preserved NODE_ENV/DB configuration and service-only restart command; no real deployment')
