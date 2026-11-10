"""Failure-injection tests: diagnostics cannot contain subprocess output or source."""
import base64,contextlib,hashlib,importlib.util,io,json,subprocess,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('exporter',Path(__file__).with_name('export-develop-wallet-source-review.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
IMAGE='sha256:'+'a'*64
SENTINEL='PRIVATE_RAW_OUTPUT_MUST_NEVER_APPEAR'

class ExportTests(unittest.TestCase):
 def command(self,args,**kwargs):
  joined=' '.join(args)
  if 'info' in args:return subprocess.CompletedProcess(args,0,b'27.0\n',b'')
  if '{{.State.Running}}' in args:out=b'true\n'
  elif 'com.docker.compose.project' in joined:out=b'movabi-develop\n'
  elif '{{.Image}}' in args:out=(IMAGE+'\n').encode()
  elif 'let exists=null' in joined:out=json.dumps({p:{'exists':True,'safe':True} for p in m.PATHS}).encode()
  else:out=json.dumps({p:{'exists':True,'content':base64.b64encode(SENTINEL.encode()).decode()} for p in m.PATHS}).encode()
  return subprocess.CompletedProcess(args,0,out,b'')
 def invoke(self,side_effect=None,out=None):
  with patch.object(m.subprocess,'run',side_effect=side_effect or self.command),patch.object(m,'inventory',return_value=([],[])),patch.object(m,'OUT',out or Path('/nonexistent-review')),contextlib.redirect_stdout(io.StringIO()) as stream:
   code=m.main()
  report=json.loads(stream.getvalue());self.assertNotIn(SENTINEL,stream.getvalue())
  return code,report
 def failure(self,stage,reason=None):
  calls=0
  def mocked(args,**kwargs):
   nonlocal calls
   joined=' '.join(args)
   match=(stage=='container_presence' and '{{.State.Running}}' in args or stage=='compose_project' and 'com.docker.compose.project' in joined or stage=='source_path_probe' and 'let exists=null' in joined or stage=='source_export' and 'toString' in joined)
   if '{{.Image}}' in args:
    calls+=1;match=stage=='image_before' and calls==1 or stage=='image_after' and calls==2
   if match:return subprocess.CompletedProcess(args,7,SENTINEL.encode(),(reason or SENTINEL).encode())
   return self.command(args,**kwargs)
  return mocked
 def test_each_guarded_subprocess_failure_named_and_value_free(self):
  for stage in ['container_presence','compose_project','image_before','source_path_probe','source_export','image_after']:
   with self.subTest(stage=stage):
    code,r=self.invoke(self.failure(stage));self.assertEqual(code,1);d=r['diagnostics'][-1];self.assertEqual(d['stage'],stage);self.assertEqual(d['exitCode'],7);self.assertEqual(d['executable'],'docker');self.assertEqual(d['category'],'command_failed_unclassified')
 def test_access_failure_fallback_diagnoses_sudo(self):
  def denied(args,**kwargs):return subprocess.CompletedProcess(args,1,b'',b'sudo: a password is required '+SENTINEL.encode())
  code,r=self.invoke(denied);self.assertEqual(code,1);self.assertEqual([d['stage'] for d in r['diagnostics']],['docker_access_direct','docker_access_sudo']);self.assertEqual(r['diagnostics'][-1]['executable'],'sudo');self.assertEqual(r['diagnostics'][-1]['category'],'sudo_noninteractive_auth_required')
 def test_daemon_permission_and_node_categories(self):
  for message,expected in [('Cannot connect to the Docker daemon','docker_daemon_unavailable'),('permission denied','permission_denied'),('executable file not found','node_executable_missing')]:
   _,r=self.invoke(self.failure('source_path_probe',message+' '+SENTINEL));self.assertEqual(r['diagnostics'][-1]['category'],expected)
 def test_container_missing(self):
  _,r=self.invoke(self.failure('container_presence','No such container '+SENTINEL));self.assertIs(r['diagnostics'][-1]['containerExists'],False)
 def test_missing_executable_and_timeout(self):
  for exception,category in [(FileNotFoundError(SENTINEL),'executable_not_found'),(subprocess.TimeoutExpired('docker',40,output=SENTINEL),'command_timeout'),(PermissionError(SENTINEL),'executable_permission_denied')]:
   with patch.object(m.subprocess,'run',side_effect=exception):
    with self.assertRaises(m.SafeFailure) as c:m.run('fixture',['docker','info'])
   self.assertEqual(c.exception.diagnostic['category'],category);self.assertIsNone(c.exception.diagnostic['exitCode']);self.assertNotIn(SENTINEL,json.dumps(c.exception.diagnostic))
 def test_project_mismatch_not_bypassed(self):
  def wrong(args,**kw):
   if 'com.docker.compose.project' in ' '.join(args):return subprocess.CompletedProcess(args,0,b'production',b'')
   return self.command(args,**kw)
  _,r=self.invoke(wrong);self.assertEqual(r['diagnostics'][-1]['category'],'compose_project_mismatch')
 def test_image_change_not_bypassed(self):
  count=0
  def changed(args,**kw):
   nonlocal count
   if '{{.Image}}' in args:
    count+=1
    if count==2:return subprocess.CompletedProcess(args,0,('sha256:'+'b'*64).encode(),b'')
   return self.command(args,**kw)
  _,r=self.invoke(changed);self.assertEqual(r['diagnostics'][-1]['category'],'image_changed_during_export')
 def test_source_missing_returns_booleans_no_source_read(self):
  def missing(args,**kw):
   if 'let exists=null' in ' '.join(args):return subprocess.CompletedProcess(args,0,json.dumps({p:{'exists':False,'safe':False} for p in m.PATHS}).encode(),b'')
   if 'toString' in ' '.join(args):raise AssertionError('must not export missing source')
   return self.command(args,**kw)
  _,r=self.invoke(missing);d=r['diagnostics'][-1];self.assertEqual(d['category'],'source_path_missing');self.assertTrue(all(x is False for x in d['sourcePathExists'].values()))
 def test_node_source_read_error_fixed_code(self):
  def missing(args,**kw):
   if 'toString' in ' '.join(args):return subprocess.CompletedProcess(args,22,SENTINEL.encode(),SENTINEL.encode())
   return self.command(args,**kw)
  _,r=self.invoke(missing);self.assertEqual(r['diagnostics'][-1]['category'],'source_read_permission_denied')
 def test_malformed_json_and_allowlist(self):
  for response,expected in [(SENTINEL.encode(),'unexpected_command_response'),(b'{}','source_metadata_invalid')]:
   def broken(args,**kw):
    if 'let exists=null' in ' '.join(args):return subprocess.CompletedProcess(args,0,response,b'')
    return self.command(args,**kw)
   _,r=self.invoke(broken);self.assertEqual(r['diagnostics'][-1]['category'],expected)
 def test_complete_export_marker_and_exact_allowlist(self):
  with tempfile.TemporaryDirectory() as tmp:
   out=Path(tmp)/'review';code,r=self.invoke(out=out);self.assertEqual(code,0);archive=Path(r['sourceArchive']);self.assertTrue(archive.is_file());self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(),r['archiveSha256']);self.assertTrue((archive.parent/'completion.json').is_file())
   with tarfile.open(archive) as tf:self.assertEqual(set(tf.getnames()),set(m.PATHS)|{'source-review.json'})
   self.assertEqual(len(m.PATHS),8)
   _,again=self.invoke(out=out);self.assertNotEqual(r['sourceArchive'],again['sourceArchive']);self.assertEqual(again['previousExports'][0]['state'],'completed_verified_preserved');self.assertTrue(archive.is_file())
 def test_legacy_partial_directory_preserved(self):
  with tempfile.TemporaryDirectory() as tmp:
   out=Path(tmp)/'review';out.mkdir();partial=out/'export.tar.gz';partial.write_bytes(b'partial')
   code,r=self.invoke(out=out);self.assertEqual(code,0);self.assertEqual(partial.read_bytes(),b'partial');self.assertIn(r['previousExports'][0]['state'],['incomplete_or_unreadable_preserved','incomplete_or_legacy_unconfirmed_preserved'])
 def test_partial_write_failure_preserved_and_next_run_succeeds(self):
  with tempfile.TemporaryDirectory() as tmp:
   out=Path(tmp)/'review'
   with patch.object(m.tarfile,'open',side_effect=PermissionError(SENTINEL)):
    code,r=self.invoke(out=out)
   self.assertEqual(code,1);self.assertEqual(r['diagnostics'][-1]['stage'],'archive_write');failed=list(out.parent.glob('review-run-*'));self.assertEqual(len(failed),1);self.assertTrue((failed[0]/'export.tar.gz.partial').exists());self.assertFalse((failed[0]/'completion.json').exists())
   code,r=self.invoke(out=out);self.assertEqual(code,0);self.assertTrue(failed[0].exists());self.assertEqual(r['previousExports'][0]['state'],'incomplete_or_legacy_unconfirmed_preserved')
 def test_exact_two_absent_manifest_no_hash_no_placeholder(self):
  def baseline(args,**kw):
   if 'let exists=null' in ' '.join(args):return subprocess.CompletedProcess(args,0,json.dumps({p:{'exists':p not in m.OPTIONAL_ABSENT,'safe':p not in m.OPTIONAL_ABSENT} for p in m.PATHS}).encode(),b'')
   if 'toString' in ' '.join(args):return subprocess.CompletedProcess(args,0,json.dumps({p:({'exists':False} if p in m.OPTIONAL_ABSENT else {'exists':True,'content':base64.b64encode(b'fixture source').decode()}) for p in m.PATHS}).encode(),b'')
   return self.command(args,**kw)
  with tempfile.TemporaryDirectory() as tmp:
   code,r=self.invoke(baseline,Path(tmp)/'review');self.assertEqual(code,0);self.assertEqual(len(r['exportedSourceFiles']),6);self.assertEqual(set(r['absentSourceFiles']),m.OPTIONAL_ABSENT)
   with tarfile.open(r['sourceArchive']) as tf:
    self.assertEqual(set(tf.getnames()),(set(m.PATHS)-m.OPTIONAL_ABSENT)|{'source-review.json'});manifest=json.load(tf.extractfile('source-review.json'))
   for p in m.OPTIONAL_ABSENT:self.assertEqual(manifest['files'][p],{'exists':False})
 def test_optional_path_permission_error_is_not_absence(self):
  def denied(args,**kw):
   if 'let exists=null' in ' '.join(args):return subprocess.CompletedProcess(args,0,json.dumps({p:({'exists':None,'safe':False} if p in m.OPTIONAL_ABSENT else {'exists':True,'safe':True}) for p in m.PATHS}).encode(),b'')
   return self.command(args,**kw)
  code,r=self.invoke(denied);self.assertEqual(code,1);self.assertEqual(r['diagnostics'][-1]['category'],'source_path_unsafe_or_unreadable')
 def test_presence_change_blocks(self):
  def changed(args,**kw):
   if 'toString' in ' '.join(args):return subprocess.CompletedProcess(args,0,json.dumps({p:({'exists':False} if p in m.OPTIONAL_ABSENT else {'exists':True,'content':base64.b64encode(b'x').decode()}) for p in m.PATHS}).encode(),b'')
   return self.command(args,**kw)
  code,r=self.invoke(changed);self.assertEqual(code,1);self.assertEqual(r['diagnostics'][-1]['category'],'source_presence_changed_during_export')
 def test_success_does_not_call_environment_db_or_mutations(self):
  calls=[]
  def traced(args,**kw):calls.append(args);return self.command(args,**kw)
  with tempfile.TemporaryDirectory() as tmp:self.invoke(traced,Path(tmp)/'review')
  for call in calls:
   self.assertFalse(any(word in call for word in ['psql','restart','cp','rm','compose']))
   self.assertNotIn('.Env',' '.join(call))
if __name__=='__main__':unittest.main()
