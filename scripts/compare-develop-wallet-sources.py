"""Validate explicit present/absent source evidence; prepare diffs, never update code or pins."""
import argparse,difflib,hashlib,json,posixpath,re,tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
PATHS=('server/routes/connect.routes.ts','server/services/stripe.service.ts','server/routes/booking.routes.ts','server/services/job-payout.service.ts','server/services/payout-eligibility.service.ts','server/routes/payment.routes.ts','server/services/payments/stripe-payment-adapter.ts','server/services/payments/stripe-payment-bridge.ts')
OPTIONAL_ABSENT=frozenset(PATHS[-2:])

def validate_archive(archive,expected_sha):
 if hashlib.sha256(Path(archive).read_bytes()).hexdigest()!=expected_sha:raise RuntimeError('Export archive checksum mismatch')
 with tarfile.open(archive,'r:gz') as tf:
  members=tf.getmembers();names=[x.name for x in members]
  if len(names)!=len(set(names)) or not set(names)<=set(PATHS)|{'source-review.json'} or 'source-review.json' not in names or any(not x.isfile() or x.size>2097152 for x in members):raise RuntimeError('Archive allowlist violation')
  data={x.name:tf.extractfile(x).read() for x in members}
 manifest=json.loads(data.pop('source-review.json'))
 if manifest.get('formatVersion')!=2 or manifest.get('composeProject')!='movabi-develop' or not re.fullmatch(r'sha256:[a-f0-9]{64}',manifest.get('image','')):raise RuntimeError('Export identity/format mismatch')
 files=manifest.get('files',{})
 if not isinstance(files,dict) or set(files)!=set(PATHS):raise RuntimeError('Export presence manifest mismatch')
 for name,entry in files.items():
  if not isinstance(entry,dict) or type(entry.get('exists')) is not bool:raise RuntimeError('Invalid presence entry')
  if entry['exists']:
   if set(entry)!={'exists','sha256'} or name not in data or not re.fullmatch(r'[a-f0-9]{64}',str(entry['sha256'])) or hashlib.sha256(data[name]).hexdigest()!=entry['sha256']:raise RuntimeError('Present source checksum mismatch')
  elif name not in OPTIONAL_ABSENT or set(entry)!={'exists'} or name in data:raise RuntimeError('Invalid absence evidence or placeholder')
 return manifest,data

def import_evidence(name,content,absent):
 text=content.decode('utf-8-sig')
 # Static import/export-from, literal require and literal dynamic import only.
 specs=re.findall(r'''(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']''',text)
 edges=[]
 for spec in sorted(set(specs)):
  if not spec.startswith('.'):continue
  target=posixpath.normpath(posixpath.join(posixpath.dirname(name),spec))
  if target.endswith('.js'):target=target[:-3]+'.ts'
  elif not target.endswith('.ts'):target+='.ts'
  edges.append({'specifier':spec,'resolvedSourcePath':target,'referencesConfirmedAbsentPath':target in absent,'withinExportAllowlist':target in PATHS})
 return edges

def main():
 p=argparse.ArgumentParser();p.add_argument('archive');p.add_argument('--sha256',required=True);args=p.parse_args()
 manifest,data=validate_archive(args.archive,args.sha256)
 release=json.loads((ROOT/'.temp/vaydu-wallet-operator-20261028/release.json').read_text())
 if set(release['protectedSourceHashes'])!=set(PATHS):raise RuntimeError('Candidate allowlist changed; review required')
 for name in PATHS:
  if hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=release['protectedSourceHashes'][name]:raise RuntimeError('Local candidate changed after pinned release; review required: '+name)
 out=ROOT/'.temp/deployed-wallet-source-comparison'
 if out.exists():raise RuntimeError('Existing comparison preserved; review it before preparing a new one')
 out.mkdir(parents=True);report=[]
 absent={name for name,entry in manifest['files'].items() if not entry['exists']}
 for name in PATHS:
  candidate=(ROOT/name).read_bytes();entry=manifest['files'][name]
  item={'file':name,'deployedExists':entry['exists'],'candidateSha256':release['protectedSourceHashes'][name],'candidateRelativeImports':import_evidence(name,candidate,absent)}
  if not entry['exists']:
   item['reviewStatus']='confirmed_absent_no_source_no_hash_no_placeholder';report.append(item);continue
  deployed=data[name];target=out/'deployed'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(deployed)
  diff=''.join(difflib.unified_diff(deployed.decode('utf-8-sig').splitlines(True),candidate.decode('utf-8-sig').splitlines(True),fromfile='deployed/'+name,tofile='candidate/'+name))
  dest=out/'diffs'/(name+'.diff');dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(diff,encoding='utf-8')
  item.update(bytesIdentical=deployed==candidate,normalizedTextIdentical=deployed.decode('utf-8-sig').replace('\r\n','\n')==candidate.decode('utf-8-sig').replace('\r\n','\n'),deployedSha256=entry['sha256'],deployedRelativeImports=import_evidence(name,deployed,absent),reviewStatus='pending_semantic_review' if diff else 'no_text_difference');report.append(item)
 (out/'comparison.json').write_text(json.dumps({'sourceImage':manifest['image'],'files':report,'sourcesChanged':False,'releaseManifestChanged':False,'architectureConclusion':'pending_review_of_deployed_imports_and_any_unexported_dependencies','staticImportScanIsNotCompleteDependencyProof':True},indent=2)+'\n')
 print(json.dumps({'comparisonDirectory':str(out),'exportedFiles':len(data),'confirmedAbsentFiles':sorted(absent),'semanticReviewRequired':True,'releaseRebuilt':False}))
if __name__=='__main__':main()
