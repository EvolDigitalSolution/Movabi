"""Freeze the reviewed disabled-staging bundle. Never packages private bindings."""
import hashlib,importlib.util,json,os,tarfile,tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
RELEASE=ROOT/'deploy/vaydu-payment-account-setup'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
 meta=json.loads((RELEASE/'release.json').read_text(encoding='utf-8-sig'))
 if meta['onboardingIntegrationReviewed'] is not True or meta['transfersEnabled'] is not False:
  raise RuntimeError('Exact reviewed disabled-staging scope required')
 files=sorted(p for p in RELEASE.rglob('*') if p.is_file() and '__pycache__' not in p.parts
  and 'closure' not in p.relative_to(RELEASE).parts and p.name!='manifest.sha256')
 if any(p.is_symlink() or p.suffix.lower() in ('.env','.dump','.pem','.key') for p in files):raise RuntimeError('Private or unexpected file in release')
 body=''.join(sha(p)+'  '+p.relative_to(RELEASE).as_posix()+'\n' for p in files)
 (RELEASE/'manifest.sha256').write_text(body,encoding='utf-8')
 spec=importlib.util.spec_from_file_location('release_guard',RELEASE/'operator/payment_account_operator.py')
 op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op);op.load_release()
 name=meta['bundleId'];archive=ROOT/'deploy'/(name+'.tar.gz')
 if archive.exists():raise RuntimeError('Existing bundle preserved; use a new reviewed revision')
 handle=tempfile.NamedTemporaryFile(prefix=name+'.partial-',suffix='.tar.gz',dir=ROOT/'deploy',delete=False);partial=Path(handle.name);handle.close()
 # Exclusive creation preserves older evidence and prevents accidental overwrite.
 with partial.open('wb') as raw:
  import gzip
  with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as compressed:
   with tarfile.open(fileobj=compressed,mode='w') as tar:
    for p in [*files,RELEASE/'manifest.sha256']:
     info=tar.gettarinfo(str(p),arcname=name+'/'+p.relative_to(RELEASE).as_posix())
     info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0;info.mode=0o600
     with p.open('rb') as data:tar.addfile(info,data)
 with tempfile.TemporaryDirectory(prefix='vaydu-published-bundle-check-') as temp:
  temp=Path(temp)
  with tarfile.open(partial) as tar:
   for m in tar.getmembers():
    if not m.isfile() or m.issym() or m.islnk() or '..' in Path(m.name).parts or not m.name.startswith(name+'/'):raise RuntimeError('Unsafe bundle member')
   tar.extractall(temp,filter='data')
  extracted=temp/name
  for p in files:
   if sha(extracted/p.relative_to(RELEASE))!=sha(p):raise RuntimeError('Extracted file mismatch')
 os.link(partial,archive);partial.unlink()
 sidecar=archive.with_name(archive.name+'.sha256')
 with sidecar.open('x',encoding='ascii') as output:output.write(sha(archive)+'  '+archive.name+'\n')
 print(json.dumps({'archive':str(archive),'sha256':sha(archive),'sha256File':str(sidecar),'files':len(files)+1,'activationEnabled':False,'cashWorkIncluded':False}))
if __name__=='__main__':main()
