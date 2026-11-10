import contextlib,importlib.util,io,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('prompt',Path(__file__).with_name('prompt-wallet-test-binding.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class PromptTests(unittest.TestCase):
 def test_no_existing_file_overwrite(self):
  with tempfile.TemporaryDirectory() as tmp:
   target=Path(tmp)/'wallet.env';target.write_text('preserve')
   with patch.object(m,'TARGET',target),patch.object(m.sys.stdin,'isatty',return_value=True),patch.object(m.getpass,'getpass',side_effect=AssertionError('must not ask for credentials')):
    with self.assertRaisesRegex(RuntimeError,'no_overwrite'):m.main()
   self.assertEqual(target.read_text(),'preserve')
 def test_nonterminal_refused(self):
  with patch.object(m.sys.stdin,'isatty',return_value=False):
   with self.assertRaisesRegex(RuntimeError,'interactive'):m.main()
 def test_live_key_rejected_without_file_or_provider_call(self):
  with tempfile.TemporaryDirectory() as tmp,patch.object(m,'TARGET',Path(tmp)/'wallet.env'),patch.object(m.sys.stdin,'isatty',return_value=True),patch('builtins.input',side_effect=['alias','123']),patch.object(m.getpass,'getpass',return_value='FLWSECK-LIVE-SYNTHETIC'):
   with self.assertRaisesRegex(RuntimeError,'test_key_format'):m.main()
 def test_webhook_must_be_separate_from_api_key(self):
  key='FLWSECK_TEST-SYNTHETIC'
  with tempfile.TemporaryDirectory() as tmp,patch.object(m,'TARGET',Path(tmp)/'wallet.env'),patch.object(m.sys.stdin,'isatty',return_value=True),patch('builtins.input',side_effect=['alias','123']),patch.object(m.getpass,'getpass',side_effect=[key,key]):
   with self.assertRaisesRegex(RuntimeError,'separate_wallet_webhook'):m.main()
 def test_webhook_confirmation_required(self):
  with tempfile.TemporaryDirectory() as tmp,patch.object(m,'TARGET',Path(tmp)/'wallet.env'),patch.object(m.sys.stdin,'isatty',return_value=True),patch('builtins.input',side_effect=['alias','123']),patch.object(m.getpass,'getpass',side_effect=['FLWSECK_TEST-SYNTHETIC','synthetic-hook-one','synthetic-hook-two']):
   with self.assertRaisesRegex(RuntimeError,'confirmation_mismatch'):m.main()
if __name__=='__main__':unittest.main()
