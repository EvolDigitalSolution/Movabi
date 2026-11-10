import importlib.util,unittest
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('operator',Path(__file__).with_name('wallet_minimal_operator.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Guards(unittest.TestCase):
 def test_all_evidence_required(self):
  with patch.object(m,'load',return_value={}):
   _,checks=m.dashboard({'FLUTTERWAVE_PROVIDER_ACCOUNT_ID':'123'})
   self.assertFalse(all(checks.values()))
 def test_alias_not_identity(self):
  data={key:True for key in m.EVIDENCE_FLAGS};data.update(merchantId='alias',providerAccountId='123',evidenceReference='review')
  with patch.object(m,'load',return_value=data):
   _,checks=m.dashboard({'FLUTTERWAVE_PROVIDER_ACCOUNT_ID':'123'});self.assertFalse(checks['merchantIdRecorded'])
 def test_binding_mismatch(self):
  with patch.object(m,'load',return_value={'providerAccountId':'456'}):
   _,checks=m.dashboard({'FLUTTERWAVE_PROVIDER_ACCOUNT_ID':'123'});self.assertFalse(checks['providerAccountIdMatches'])
 def test_missing_binding(self):
  with patch.object(m,'wallet_path',return_value=Path('/nonexistent-wallet-test-fixture')):
   values,checks=m.wallet_bindings();self.assertEqual(values,{});self.assertFalse(m.bindings_ready(checks));self.assertFalse(checks['subaccountFileUsed']);self.assertIsNone(checks['testKeyFormatConfirmed']);self.assertIsNone(checks['separateWebhookPresent']);self.assertIsNone(checks['callbackMatchesExpected'])
 def test_subaccount_file_never_read(self):
  with patch.object(m,'wallet_path',return_value=Path('/private/collection-subaccount/flutterwave-test.env')),patch.object(Path,'read_text',side_effect=AssertionError('must not read subaccount file')):
   values,checks=m.wallet_bindings();self.assertEqual(values,{});self.assertFalse(m.bindings_ready(checks))
 def test_incomplete_proof(self):
  with patch.object(m,'load',return_value={}):
   with self.assertRaises(m.Blocked):m.proof({})
 def test_compose_chain_retained(self):
  r={'files':['a','b','c'],'fileHashes':{'a':'x','b':'x','c':'x'},'directory':'/srv/develop','service':'api'}
  with patch.object(m,'digest',return_value='x'),patch.object(m,'run') as run:
   m.compose(['docker'],r,Path('/private/override.json'));cmd=run.call_args.args[0]
   self.assertEqual([cmd[i+1] for i,x in enumerate(cmd) if x=='-f'],['a','b','c',str(Path('/private/override.json'))]);self.assertIn('--no-deps',cmd)
 def test_compose_drift_blocks(self):
  with patch.object(m,'digest',return_value='changed'):
   with self.assertRaises(m.Blocked):m.compose(['docker'],{'fileHashes':{'a':'original'}},Path('/x'))
class MinimalBuildGuards(unittest.TestCase):
 def test_wrong_base_blocks_without_build_or_credentials(self):
  with patch.object(m,'run') as run:
   with self.assertRaises(m.Blocked):m.prepare_image(['docker'],{'baseApiImage':'expected'},{'api':{'image':'other'}})
   run.assert_not_called()
 def test_prepare_image_uses_pinned_base_and_payload_without_service_restart(self):
  import json
  manifest={'baseApiImage':'base','payloadImage':'payload','protectedSourceHashes':{'server/example.ts':'hash'},'protectedAbsentPaths':['server/absent.ts']}
  calls=[]
  def run(args,**kw):
   calls.append(args)
   if 'inspect' in args:return 'payload' if args[-1]=='payload' else 'derived'
   if 'node' in args:return json.dumps({'server/example.ts':{'exists':True,'sha256':'hash'},'server/absent.ts':{'exists':False}})
   return ''
  with patch.object(m,'run',side_effect=run),patch.object(m,'source_parity',return_value=(True,[])),patch.object(m,'digest',return_value='review'),patch.object(m,'save') as save,patch.object(m,'wallet_bindings',side_effect=AssertionError('must not read wallet credentials')):
   m.prepare_image(['docker'],manifest,{'api':{'image':'base'}})
   self.assertEqual(save.call_args.args[1]['apiImage'],'derived')
  self.assertFalse(any('compose' in c or 'restart' in c or 'psql' in c for c in calls));self.assertTrue(any('--network' in c and 'none' in c for c in calls))
class ReceiptTests(unittest.TestCase):
 def setup_receipt(self):
  image='sha256:'+'a'*64
  manifest={'baseApiImage':'base','payloadImage':'payload','protectedSourceHashes':{'server/source.ts':'expected'},'protectedAbsentPaths':['server/absent.ts'],'reportedPreparedApiImage':image}
  receipt={'baseImage':'base','payloadImage':'payload','reviewSha256':'review','serverTypecheckPassed':True,'apiImage':image}
  return manifest,receipt,image
 def validate(self,manifest,receipt,image,actual=None):
  import json
  def load(path,default=None):return receipt if path.name=='prepared-image.json' else {'api':{'image':'base'}}
  def run(args,**kw):return image if 'inspect' in args else json.dumps(actual or {'server/source.ts':{'exists':True,'sha256':'expected'},'server/absent.ts':{'exists':False}})
  with patch.object(m,'load',side_effect=load),patch.object(m,'digest',return_value='review'),patch.object(m,'run',side_effect=run) as command:
   result=m.validate_prepared(['docker'],manifest,{'api':{'image':'base'}})
   self.assertFalse(any('build' in c.args[0] or 'tsc' in c.args[0] for c in command.call_args_list))
  return result
 def test_receipt_is_reloaded_and_immutable_image_rechecked_without_rebuild(self):
  manifest,receipt,image=self.setup_receipt();r=self.validate(manifest,receipt,image);self.assertEqual(manifest['apiImage'],image);self.assertTrue(r['receiptMatches'])
 def test_each_release_binding_mismatch_blocks(self):
  for field in ['baseImage','payloadImage','reviewSha256','serverTypecheckPassed']:
   manifest,receipt,image=self.setup_receipt();receipt[field]='wrong'
   with self.subTest(field=field),self.assertRaises(m.Blocked):self.validate(manifest,receipt,image)
 def test_wrong_reported_image_blocks(self):
  manifest,receipt,image=self.setup_receipt();receipt['apiImage']='sha256:'+'b'*64
  with self.assertRaises(m.Blocked):self.validate(manifest,receipt,image)
 def test_changed_protected_source_blocks(self):
  manifest,receipt,image=self.setup_receipt()
  with self.assertRaises(m.Blocked):self.validate(manifest,receipt,image,{'server/source.ts':{'exists':True,'sha256':'wrong'},'server/absent.ts':{'exists':False}})
 def test_absent_dependency_appearing_blocks(self):
  manifest,receipt,image=self.setup_receipt()
  with self.assertRaises(m.Blocked):self.validate(manifest,receipt,image,{'server/source.ts':{'exists':True,'sha256':'expected'},'server/absent.ts':{'exists':True,'sha256':'new'}})
class UiDiagnosticsTests(unittest.TestCase):
 def test_raw_build_output_never_exposed(self):
  import subprocess
  raw=b'PRIVATE_SENTINEL unknown flag: chmod'
  with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],1,raw,raw)):
   with self.assertRaises(m.Blocked) as error:m.ui_command('image_build',['docker','build'])
  self.assertIn('builder_chmod_feature_unavailable',str(error.exception));self.assertNotIn('PRIVATE_SENTINEL',str(error.exception));self.assertIn('exitCode=1',str(error.exception))
 def test_timeout_has_safe_named_stage(self):
  import subprocess
  with patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired('docker',1,output=b'PRIVATE_SENTINEL')):
   with self.assertRaises(m.Blocked) as error:m.ui_command('nginx_config_test',['docker','run'])
  self.assertIn('ui_stage=nginx_config_test',str(error.exception));self.assertNotIn('PRIVATE_SENTINEL',str(error.exception))
if __name__=='__main__':unittest.main()

