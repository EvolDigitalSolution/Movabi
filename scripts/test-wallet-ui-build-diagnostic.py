import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('diag',Path(__file__).with_name('diagnose-wallet-ui-build.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Diagnostics(unittest.TestCase):
 def test_stdout_classic_builder_underlying_error_not_lost(self):
  output=b"Step 6/6 : RUN rm -f /usr/share/nginx/html/index.html.gz /usr/share/nginx/html/index.html.br\nrm: cannot remove '/usr/share/nginx/html/index.html.gz': Permission denied\nThe command returned a non-zero code: 1"
  r=m.summarize(output,b'',m.RECIPE);self.assertEqual(r['failedDockerfileLine'],6);self.assertTrue(any('Permission denied' in e for e in r['underlyingErrors']))
 def test_buildkit_failed_instruction_and_reason(self):
  err=b"#8 [6/6] RUN rm -f /usr/share/nginx/html/index.html.gz /usr/share/nginx/html/index.html.br\n#8 0.12 rm: can't remove '/usr/share/nginx/html/index.html.gz': Read-only file system\n#8 ERROR: process failed\n 6 | >>> RUN rm -f /usr/share/nginx/html/index.html.gz /usr/share/nginx/html/index.html.br\nERROR: failed to solve"
  r=m.summarize(b'',err,m.RECIPE);self.assertEqual(r['failedDockerfileLine'],6);self.assertTrue(any('Read-only file system' in e for e in r['underlyingErrors']))
 def test_secrets_and_signed_urls_redacted(self):
  value=m.safe_message('ERROR: FLWSECK_TEST-SYNTHETIC sk_test_SYNTHETIC password=hidden https://example.test/path?secret=hidden')
  self.assertNotIn('SYNTHETIC',value);self.assertNotIn('password=hidden',value);self.assertNotIn('example.test',value)
 def test_actual_recipe_does_not_include_secret_or_api_operations(self):
  self.assertNotIn('--secret',m.RECIPE);self.assertNotIn('curl',m.RECIPE);self.assertEqual(len(m.FILES),7);self.assertEqual(len(m.ASSET_HASHES),4)
if __name__=='__main__':unittest.main()
