import hashlib,importlib.util,io,json,tarfile,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('compare',Path(__file__).with_name('compare-develop-wallet-sources.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ImportTests(unittest.TestCase):
 def archive(self,folder,mutate=None,placeholder=False):
  data={p:b"import {x} from './payments/stripe-payment-bridge';\n" for p in m.PATHS if p not in m.OPTIONAL_ABSENT}
  files={p:({'exists':True,'sha256':hashlib.sha256(data[p]).hexdigest()} if p in data else {'exists':False}) for p in m.PATHS}
  manifest={'formatVersion':2,'composeProject':'movabi-develop','image':'sha256:'+'a'*64,'files':files}
  if mutate:mutate(manifest)
  if placeholder:data[next(iter(m.OPTIONAL_ABSENT))]=b''
  archive=Path(folder)/'export.tar.gz'
  with tarfile.open(archive,'w:gz') as tf:
   for p,content in {**data,'source-review.json':json.dumps(manifest).encode()}.items():
    entry=tarfile.TarInfo(p);entry.size=len(content);tf.addfile(entry,io.BytesIO(content))
  return archive,hashlib.sha256(archive.read_bytes()).hexdigest()
 def test_six_present_two_absent(self):
  with tempfile.TemporaryDirectory() as tmp:
   p,h=self.archive(tmp);manifest,data=m.validate_archive(p,h);self.assertEqual(len(data),6)
   for name in m.OPTIONAL_ABSENT:self.assertEqual(manifest['files'][name],{'exists':False});self.assertNotIn(name,data)
 def test_absence_cannot_have_hash(self):
  with tempfile.TemporaryDirectory() as tmp:
   p,h=self.archive(tmp,lambda x:x['files'][next(iter(m.OPTIONAL_ABSENT))].update(sha256='0'*64))
   with self.assertRaises(RuntimeError):m.validate_archive(p,h)
 def test_placeholder_rejected(self):
  with tempfile.TemporaryDirectory() as tmp:
   p,h=self.archive(tmp,placeholder=True)
   with self.assertRaises(RuntimeError):m.validate_archive(p,h)
 def test_required_source_cannot_be_marked_absent(self):
  with tempfile.TemporaryDirectory() as tmp:
   p,h=self.archive(tmp,lambda x:x['files'].__setitem__(m.PATHS[0],{'exists':False}))
   with self.assertRaises(RuntimeError):m.validate_archive(p,h)
 def test_present_hash_mismatch(self):
  with tempfile.TemporaryDirectory() as tmp:
   p,h=self.archive(tmp,lambda x:x['files'][m.PATHS[0]].update(sha256='0'*64))
   with self.assertRaises(RuntimeError):m.validate_archive(p,h)
 def test_unknown_presence_rejected(self):
  with tempfile.TemporaryDirectory() as tmp:
   p,h=self.archive(tmp,lambda x:x['files'][next(iter(m.OPTIONAL_ABSENT))].update(exists=None))
   with self.assertRaises(RuntimeError):m.validate_archive(p,h)
 def test_static_reference_to_absent_bridge_detected(self):
  edges=m.import_evidence('server/services/stripe.service.ts',b"import {createBridge} from './payments/stripe-payment-bridge';",m.OPTIONAL_ABSENT)
  self.assertTrue(edges[0]['referencesConfirmedAbsentPath'])
 def test_no_reference_does_not_invent_dependency(self):
  edges=m.import_evidence('server/services/stripe.service.ts',b"import Stripe from 'stripe';",m.OPTIONAL_ABSENT);self.assertEqual(edges,[])
if __name__=='__main__':unittest.main()
