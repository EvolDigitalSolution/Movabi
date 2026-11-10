"""Offline guard/Compose tests. No Docker engine, provider, credentials or database."""
import hashlib,importlib.util,json,os,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('operator_under_test',ROOT/'operator/payment_account_operator.py')
op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)

class Guards(unittest.TestCase):
 def test_schema_classification(self):
  self.assertEqual(op.classify_schema({'markets':False,'accounts':False,'claim':False}),'absent')
  self.assertEqual(op.classify_schema({'markets':True,'accounts':True,'claim':True}),'complete')
  for fields in [(True,False,False),(False,False,True),(True,True,False)]:
   self.assertEqual(op.classify_schema(dict(zip(['markets','accounts','claim'],fields))),'partial')
 def test_receipt_requires_exact_release_and_freshness(self):
  with patch.object(op,'load',return_value={'releaseFingerprint':'wrong','verifiedAt':time.time()}),patch.object(op,'release_fingerprint',return_value='reviewed'):
   with self.assertRaises(op.Blocked):op.require_receipt('api-tested.json',{})
  with patch.object(op,'load',return_value={'releaseFingerprint':'reviewed','verifiedAt':0}),patch.object(op,'release_fingerprint',return_value='reviewed'):
   with self.assertRaises(op.Blocked):op.require_receipt('api-tested.json',{})
 def test_activation_does_not_approve_placeholder_evidence(self):
  with patch.object(op,'require_receipt',return_value={}):
   with self.assertRaisesRegex(op.Blocked,'reviewed_test_setup_evidence_required'):op.activate({})
 def test_missing_merchant_evidence_blocks_activation_without_sql_or_compose(self):
  with patch.object(op,'require_receipt',return_value={}),patch.object(op,'sql_apply') as sql,patch.object(op,'compose') as compose:
   with self.assertRaisesRegex(op.Blocked,'reviewed_test_setup_evidence_required'):op.activate({})
   sql.assert_not_called();compose.assert_not_called()
 def test_dashboard_template_never_becomes_approval_automatically(self):
  with tempfile.TemporaryDirectory() as tmp:
   file=Path(tmp)/'dashboard.json';file.write_text((ROOT/'merchant-evidence.template.json').read_text());os.chmod(file,0o600)
   with self.assertRaisesRegex(op.Blocked,'unresolved_dashboard_check'):op.record_merchant_evidence({'merchantRef':'vaydu-flutterwave-test-ng'},str(file))
 def test_compose_preserves_every_file_in_order_and_service(self):
  with tempfile.TemporaryDirectory() as tmp:
   files=[Path(tmp)/('chain-'+str(n)+'.json') for n in range(3)]
   for f in files:f.write_text('{}')
   record={'fileHashes':{str(f):op.digest(f) for f in files},'files':[str(f) for f in files],'directory':tmp,'service':'api'}
   with patch.object(op,'run',return_value='') as run:
    op.compose(['docker'],record,Path(tmp)/'setup.override.json')
    args=run.call_args.args[0]
    self.assertEqual([args[i+1] for i,x in enumerate(args) if x=='-f'],[str(f) for f in files]+[str(Path(tmp)/'setup.override.json')])
    self.assertEqual(args[-1],'api');self.assertIn('--no-deps',args);self.assertIn('--no-build',args)
   files[1].write_text('changed')
   with patch.object(op,'run') as run:
    with self.assertRaisesRegex(op.Blocked,'compose_chain_changed'):op.compose(['docker'],record,Path(tmp)/'override')
    run.assert_not_called()
 def test_rollback_disables_only_scope_and_restores_original_image(self):
  with tempfile.TemporaryDirectory() as tmp:
   original='sha256:'+'1'*64
   record={'service':'api','files':[],'fileHashes':{},'directory':tmp}
   receipt={'record':record,'originalImage':original}
   with patch.object(op,'docker',return_value=['docker']),patch.object(op,'load',return_value=receipt),patch.object(op,'verify_db_identity',return_value=True),patch.object(op,'schema_state',return_value={'markets':True,'accounts':True,'claim':True}),patch.object(op,'run',return_value='') as run,patch.object(op,'save') as save,patch.object(op,'compose') as compose,patch.object(op,'target',return_value={'api':{**record,'image':original}}):
    result=op.rollback();self.assertEqual(result['restoredImage'],original)
    statement=run.call_args.kwargs['data'].decode();self.assertIn(op.DRIVER,statement);self.assertIn(op.TENANT,statement);self.assertIn('enabled=false',statement)
    payload=save.call_args.args[1];self.assertEqual(payload,{'services':{'api':{'image':original}}})
    compose.assert_called_once()
 def test_manifest_is_text_not_json_and_rejects_extra_files(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);sql=root/'sql.sql';sql.write_text('-- fixture')
   release={'purpose':'vaydu-driver-payment-account-setup-v1','driver':op.DRIVER,'tenant':op.TENANT,'baselineApiImage':'sha256:'+'a'*64,'merchantRef':'fixture-alias','sqlSha256':op.digest(sql)}
   (root/'release.json').write_text(json.dumps(release))
   files=[sql,root/'release.json']
   for name in op.API_FILES:
    p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('// fixture');files.append(p)
   manifest=root/'manifest.sha256';manifest.write_text(''.join(op.digest(p)+'  '+p.relative_to(root).as_posix()+'\n' for p in files))
   with patch.object(op,'ROOT',root),patch.object(op,'MANIFEST',manifest),patch.object(op,'SQL',sql),patch.object(op,'RELEASE',root/'release.json'):
    self.assertEqual(op.load_release(),release)
    (root/'unexpected.env').write_text('fixture-only')
    with self.assertRaisesRegex(op.Blocked,'release_manifest_incomplete'):op.load_release()

if __name__=='__main__':unittest.main()
