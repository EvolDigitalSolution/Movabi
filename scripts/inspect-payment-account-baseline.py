"""Narrow read-only source evidence. No environment, credentials, bank or DB access."""
import hashlib,json,os,re,subprocess,tarfile,tempfile,uuid
from pathlib import Path

IMAGE='sha256:1ef978c931bf390273f4648f6c8bdce04231338d64ae7c6ead7e4e10d723c6aa'
NAME='movabi-develop-api'
FILES=('server/index.ts','server/routes/driver-onboarding.routes.ts','server/services/driver-requirement.service.ts')

class Diagnostic(RuntimeError):
 def __init__(self,category,stage,**details):
  super().__init__(category);self.report={'completed':False,'blocked':category,'stage':stage,'rawOutputWithheld':True,**details}

def main():
 d=['docker']
 if subprocess.run(d+['info','--format','{{.ServerVersion}}'],capture_output=True).returncode:d=['sudo','-n','docker']
 def run(args,stage='inspect-baseline'):
  p=subprocess.run(d+args,capture_output=True,timeout=60)
  if p.returncode:
   error=p.stderr.lower();category='permission_denied' if b'permission denied' in error or b'access denied' in error else 'container_or_path_absent' if b'no such' in error or b'not found' in error else 'docker_command_failed'
   raise Diagnostic(category,stage,executable='docker',exitCode=p.returncode)
  return p.stdout.decode().strip()
 if run(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',NAME])!='movabi-develop':raise RuntimeError('compose_project_mismatch')
 if run(['inspect','--format','{{.Image}}',NAME])!=IMAGE:raise RuntimeError('pinned_baseline_mismatch')
 root=Path.home()/'.local/state/vaydu-payment-account-source-review'
 root.mkdir(mode=0o700,parents=True,exist_ok=True)
 if root.is_symlink() or root.stat().st_uid!=os.getuid() or root.stat().st_mode&0o077:raise RuntimeError('private_review_directory_required')
 out=root/('review-'+uuid.uuid4().hex[:12]);out.mkdir(mode=0o700)
 hashes={}
 for name in FILES:
  script="const f=require('fs');try{const s=f.lstatSync("+json.dumps('/app/'+name)+");console.log(JSON.stringify({exists:true,isFile:s.isFile()}));}catch(e){console.log(JSON.stringify({exists:e.code==='ENOENT'?false:null,category:e.code==='EACCES'?'permission_denied':'source_metadata_unavailable'}));}"
  state=json.loads(run(['exec',NAME,'node','-e',script],'source-metadata:'+name))
  if state.get('exists') is not True or state.get('isFile') is not True:
   raise Diagnostic('source_absent' if state.get('exists') is False else state.get('category','source_not_regular_file'),'source-metadata',sourcePath='/app/'+name,expectedSourceExists=state.get('exists'))
  target=out/name;target.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
  run(['cp',NAME+':/app/'+name,str(target)],'copy-allowlisted-source:'+name)
  if target.is_symlink() or not target.is_file():raise RuntimeError('unexpected_source_type')
  os.chmod(target,0o600);body=target.read_bytes()
  # Block embedded credential literals; ordinary process.env references are fine.
  if re.search(rb'(?:FLWSECK_(?:TEST|LIVE)-|sk_(?:live|test)_|eyJ[a-zA-Z0-9_-]{25,}\.)[a-zA-Z0-9_.-]{8,}',body):raise RuntimeError('embedded_sensitive_literal_review_required')
  hashes[name]=hashlib.sha256(body).hexdigest()
 manifest=out/'source-manifest.json';manifest.write_text(json.dumps({'baselineImage':IMAGE,'files':hashes},indent=2));os.chmod(manifest,0o600)
 archive=out.parent/(out.name+'.tar.gz')
 with tarfile.open(archive,'x:gz') as tar:
  for name in (*FILES,'source-manifest.json'):tar.add(out/name,arcname=name,recursive=False)
 os.chmod(archive,0o600)
 print(json.dumps({'completed':True,'baselineVerified':True,'archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'sourceFileCount':3,'environmentRead':False,'databaseAccessed':False,'servicesChanged':False}))
if __name__=='__main__':
 try:main()
 except Exception as e:
  if isinstance(e,Diagnostic):print(json.dumps(e.report));raise SystemExit(1)
  category=str(e) if isinstance(e,RuntimeError) else type(e).__name__
  print(json.dumps({'completed':False,'blocked':category,'rawOutputWithheld':True}));raise SystemExit(1)
