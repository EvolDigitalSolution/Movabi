"""Read-only exporter contract tests; Docker operations are simulated."""
import contextlib,importlib.util,io,json,subprocess,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('baseline_reader',Path(__file__).with_name('inspect-payment-account-baseline.py'))
reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)

class Exporter(unittest.TestCase):
 def exercise(self,home,image=None,embedded=False):
  calls=[]
  def run(args,**kwargs):
   calls.append(args)
   if args[1]=='info':out='fixture-version'
   elif args[1]=='inspect':out=('movabi-develop' if 'Labels' in args[3] else (image or reader.IMAGE))
   elif args[1]=='cp':
    source=args[2];self.assertIn(source,[reader.NAME+':/app/'+f for f in reader.FILES])
    body='export const fixture = true;\n'
    if embedded:body="const forbidden='FLWSECK_TEST-synthetic-never-real-key';\n"
    Path(args[3]).write_text(body);out=''
   elif args[1]=='exec':
    self.assertEqual(args[2:5],[reader.NAME,'node','-e'])
    self.assertTrue(any('/app/'+name in args[5] for name in reader.FILES));out=json.dumps({'exists':True,'isFile':True})
   else:self.fail('Unexpected executable or mutation in read-only reader')
   return subprocess.CompletedProcess(args,0,stdout=out.encode(),stderr=b'')
  captured=io.StringIO()
  with patch.object(reader.Path,'home',return_value=home),patch.object(reader.subprocess,'run',side_effect=run),contextlib.redirect_stdout(captured):reader.main()
  return json.loads(captured.getvalue()),calls
 def test_exact_three_files_private_archive_and_unique_attempts(self):
  with tempfile.TemporaryDirectory() as home:
   first,calls=self.exercise(Path(home));second,_=self.exercise(Path(home))
   self.assertTrue(first['completed']);self.assertNotEqual(first['archive'],second['archive'])
   archive=Path(first['archive']);self.assertEqual(archive.stat().st_mode&0o777,0o600)
   with tarfile.open(archive) as tar:self.assertEqual(set(tar.getnames()),set(reader.FILES)|{'source-manifest.json'})
   self.assertFalse(any('Env' in str(args) or 'psql' in args or 'restart' in args for args in calls))
 def test_image_guard_is_not_weakened(self):
  with tempfile.TemporaryDirectory() as home:
   with self.assertRaisesRegex(RuntimeError,'pinned_baseline_mismatch'):self.exercise(Path(home),'sha256:'+'0'*64)
   self.assertFalse(list(Path(home).rglob('*.tar.gz')))
 def test_embedded_literal_blocks_archive_without_deleting_evidence(self):
  with tempfile.TemporaryDirectory() as home:
   with self.assertRaisesRegex(RuntimeError,'embedded_sensitive_literal'):self.exercise(Path(home),embedded=True)
   self.assertFalse(list(Path(home).rglob('*.tar.gz')))
   self.assertTrue(list(Path(home).rglob('index.ts')))
if __name__=='__main__':unittest.main()
