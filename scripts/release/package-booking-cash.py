"""Package reviewed base + explicit booking/payment fixes. Never ship this branch wholesale."""
from pathlib import Path
import hashlib,io,json,subprocess,tarfile,sys
root=Path(__file__).resolve().parents[2]
sha=subprocess.check_output(['git','rev-parse','--short=7','HEAD'],cwd=root,text=True).strip()
def digest(data):return hashlib.sha256(data).hexdigest()
def committed(p):return subprocess.check_output(['git','show',f'HEAD:{p}'],cwd=root)
def unpack(data):
 with tarfile.open(fileobj=io.BytesIO(data)) as t:return {m.name.split('/',1)[1]:t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
def pack(files,prefix):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w:gz') as t:
  for p,data in sorted(files.items()):
   m=tarfile.TarInfo(prefix+'/'+p);m.size=len(data);m.mode=0o644;t.addfile(m,io.BytesIO(data))
 return out.getvalue()
def sums(files):return ''.join(digest(data)+'  '+p+'\n' for p,data in sorted(files.items())).encode()
base_data=(root/'release/vaydu-develop-f949a14-release-linux.tar.gz').read_bytes()
assert digest(base_data)=='58dcdbaf0b27769bcf15bfbfa584e4e64002c4ab27ada42cd4f5f57cc089488a'
base=unpack(base_data)
p8_data=(root/'release/vaydu-gb-p8-fix-eef726b.tar.gz').read_bytes()
assert digest(p8_data)=='c92f2f33a0ae9d61c62bd17a32a722f31c3afa6a3eea98413d620f60f94cf99a'
p8=unpack(p8_data);paired=unpack(p8['vaydu-develop-eef726b-release-linux.tar.gz'])
api_paths=['server/routes/booking.routes.ts','server/routes/card-wallet.routes.ts','server/services/dispatch.service.ts']
web_paths=['src/app/apps/mobile/features/customer/booking-request/booking-request.page.ts','src/app/apps/mobile/features/customer/payment-methods/payment-methods.page.ts','src/app/core/services/stripe/payment.service.ts','src/app/apps/admin/features/users/user-list.component.ts','src/app/shared/utils/profile-market-context.ts']
web_root=Path(sys.argv[1]).resolve()
snapshot=web_root.parent.parent
# The compiled input must be f949a14 plus exactly these five frontend overlays.
tracked=subprocess.check_output(['git','ls-tree','-r','--name-only','f949a14'],cwd=root,text=True).splitlines()
raw_source=subprocess.check_output(['git','archive','--format=tar','f949a14'],cwd=root)
with tarfile.open(fileobj=io.BytesIO(raw_source)) as t:source_base={m.name:t.extractfile(m).read() for m in t.getmembers() if m.isfile() and m.name.startswith('src/')}
for p in tracked:
 if p.startswith('src/') and p not in web_paths:assert (snapshot/p).read_bytes()==source_base[p],p
for p in web_paths:assert (snapshot/p).read_bytes()==committed(p),p
assert (web_root/'index.html').is_file()
candidate=dict(paired)
for p in api_paths:candidate[p]=committed(p)
for p in web_paths:candidate[p]=committed(p)
for p in list(candidate):
 if p.startswith('mobile/browser/'):del candidate[p]
new_web={p.relative_to(web_root).as_posix():p.read_bytes() for p in web_root.rglob('*') if p.is_file()}
candidate.update({'mobile/browser/'+p:data for p,data in new_web.items()})
candidate['SOURCE_SHA']=(sha+'\n').encode()
candidate['BOOKING_CASH_PATCH.json']=json.dumps({'source':sha,'api_base':'eef726b','immutable_release_base':'f949a14','api_overlays':api_paths,'web_source_base':'f949a14','web_overlays':web_paths,'sql':'unchanged','admin_browser':'unchanged; user-list source correction is included in mobile routes, separate admin rollout not included'},indent=2).encode()+b'\n'
# Every release SQL and migration byte remains the reviewed base byte.
for p,data in base.items():
 if p.endswith('.sql') or p=='RELEASE-MIGRATIONS.sha256':assert candidate[p]==data,p
for p in ['SHA256SUMS','ALL_SHA256SUMS']:candidate.pop(p,None)
candidate['SHA256SUMS']=sums(candidate)
candidate['ALL_SHA256SUMS']=sums(candidate)
runtime=lambda files:{p:data for p,data in files.items() if p.startswith(('server/','src/')) or p in ['package.json','package-lock.json','SOURCE_SHA']}
files={'app.tar.gz':pack(candidate,'app'),'SOURCE_SHA':candidate['SOURCE_SHA'],
 'BASE_API_f949a14_SHA256SUMS':sums(runtime(base)),'BASE_API_eef726b_SHA256SUMS':sums(runtime(paired)),
 'CANDIDATE_API_SHA256SUMS':sums(runtime(candidate)),
 'CANDIDATE_WEB_SHA256SUMS':sums({'./'+p:d for p,d in new_web.items()}),
 'CANDIDATE_WEB_FILES.txt':''.join('./'+p+'\n' for p in sorted(new_web)).encode(),
 'P8_WEB_f949a14_SHA256SUMS':sums({'./'+p.removeprefix('mobile/browser/'):d for p,d in base.items() if p.startswith('mobile/browser/')}),
 'P8_WEB_f949a14_FILES.txt':''.join('./'+p.removeprefix('mobile/browser/')+'\n' for p in sorted(base) if p.startswith('mobile/browser/')).encode(),
 'verify-p8-web.sh':committed('deploy/vaydu-develop-activation/verify-p8-web.sh'),
 'deploy.sh':committed('deploy/vaydu-booking-cash/deploy.sh'),'DEPLOYMENT.md':committed('deploy/vaydu-booking-cash/DEPLOYMENT.md'),
 'default.conf':committed('deploy/vaydu-booking-cash/default.conf'),
 'Dockerfile.web':committed('deploy/vaydu-booking-cash/Dockerfile.web'),
 'diagnose-customer-payment-context.cjs':committed('scripts/diagnose-customer-payment-context.cjs'),
 'EVIDENCE.md':committed('docs/roadmap-evidence/booking-cash-20261116.md')}
files['SHA256SUMS']=sums(files)
name='vaydu-booking-cash-'+sha;out=root/'release'/f'{name}.tar.gz'
assert not out.exists(),out
data=pack(files,name);out.write_bytes(data);out.with_suffix(out.suffix+'.sha256').write_text(digest(data)+'  '+out.name+'\n',encoding='utf-8',newline='\n')
assert unpack(data)==files
print(digest(data)+'  '+str(out))
print('BOOKING_CANDIDATE_VERIFIED: f949a14 release + reviewed P8 API + 3 API fixes + isolated web; SQL/admin browser/unrelated branch work unchanged')
