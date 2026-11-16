"""Package committed DB-only completion-PIN policy tools; no API/web/provider payload."""
from pathlib import Path
import hashlib,io,subprocess,tarfile
r=Path(__file__).resolve().parents[2]
sha=subprocess.check_output(['git','rev-parse','--short=7','HEAD'],cwd=r,text=True).strip()
name='vaydu-pin-africa-'+sha
p=r/'release'/(name+'.tar.gz')
if p.exists() or p.with_suffix(p.suffix+'.sha256').exists():raise SystemExit('Refusing existing artifact overwrite')
def committed(path):return subprocess.check_output(['git','show','HEAD:'+path],cwd=r)
basefile=r/'release/vaydu-develop-f949a14-release-linux.tar.gz'
assert hashlib.sha256(basefile.read_bytes()).hexdigest()=='58dcdbaf0b27769bcf15bfbfa584e4e64002c4ab27ada42cd4f5f57cc089488a'
with tarfile.open(basefile) as t:
 base={m.name.split('/',1)[1]:t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
for manifest in ['SHA256SUMS','ALL_SHA256SUMS','RELEASE-MIGRATIONS.sha256']:
 for line in base[manifest].decode().splitlines():
  h,path=line.split(None,1);assert hashlib.sha256(base[path.lstrip('*').removeprefix('./')]).hexdigest()==h
files={f:committed('deploy/vaydu-completion-pin-africa/'+f) for f in ['deploy.sh','verify.sql','README.md']}
up=committed('deploy/vaydu-completion-pin-africa/apply.sql')
assert up.count(b'\\ir acceptance-market.sql')==1 and up.endswith(b'COMMIT;\n')
files['policy.sql']=up.replace(b'\\ir acceptance-market.sql',committed('supabase/migrations/20261270400000_completion_pin_acceptance_market.sql'))
files['RELEASE_VERIFY.sql']=committed('deploy/vaydu-develop-release-2/VERIFY.sql')
files['verify-p8-web.sh']=committed('deploy/vaydu-develop-activation/verify-p8-web.sh')
web={p.removeprefix('mobile/browser/'):v for p,v in base.items() if p.startswith('mobile/browser/')}
files['P8_WEB_f949a14_SHA256SUMS']=''.join(hashlib.sha256(v).hexdigest()+'  ./'+p+'\n' for p,v in sorted(web.items())).encode()
files['P8_WEB_f949a14_FILES.txt']=''.join('./'+p+'\n' for p in sorted(web)).encode()
paths=['server/services/logistics.service.ts','server/services/completion-pin-policy.ts','server/services/marketplace-config.service.ts','server/routes/booking.routes.ts']
files['API_PIN_SHA256SUMS']=''.join(hashlib.sha256(base[p]).hexdigest()+'  '+p+'\n' for p in paths).encode()
files['SOURCE_SHA']=(sha+'\n').encode()
files['SHA256SUMS']=''.join(hashlib.sha256(v).hexdigest()+'  '+p+'\n' for p,v in sorted(files.items())).encode()
with tarfile.open(p,'x:gz') as t:
 for path,data in sorted(files.items()):
  m=tarfile.TarInfo(name+'/'+path);m.mode=0o644;m.size=len(data);t.addfile(m,io.BytesIO(data))
with tarfile.open(p) as t:assert {m.name.split('/',1)[1]:t.extractfile(m).read() for m in t.getmembers() if m.isfile()}==files
h=hashlib.sha256(p.read_bytes()).hexdigest()
p.with_suffix(p.suffix+'.sha256').write_text(h+'  '+p.name+'\n',encoding='utf-8',newline='\n')
print(h+'  '+str(p))
print('PIN_DB_ONLY_ARTIFACT_VERIFIED: committed transactional policy/audit; pinned API integrity and web content guards; no API/web/provider payload')
