import importlib.util,unittest
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('operator',Path(__file__).with_name('wallet_operator.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
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
if __name__=='__main__':unittest.main()

