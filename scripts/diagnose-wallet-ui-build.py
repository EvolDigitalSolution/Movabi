"""Diagnose the retained UI build against its pinned base; no deployment/secrets.
Preserves a private context snapshot and full plain Docker stdout/stderr.
"""
import hashlib,json,os,re,shutil,stat,subprocess,uuid
from pathlib import Path
STATE=Path.home()/'.local/state/vaydu-wallet-minimal-operator'
FILES={'Dockerfile','index.html','default.conf','wallet.html','wallet.js','wallet.css','entry.js'}
RECIPE='ARG DEVELOP_WEB\nFROM ${DEVELOP_WEB}\nCOPY --chmod=0644 index.html /usr/share/nginx/html/index.html\nCOPY --chmod=0644 default.conf /etc/nginx/conf.d/default.conf\nCOPY --chmod=0644 wallet.html wallet.js wallet.css entry.js /usr/share/nginx/html/_vaydu-wallet/\nRUN rm -f /usr/share/nginx/html/index.html.gz /usr/share/nginx/html/index.html.br\n'
ASSET_HASHES={'wallet.html': 'bc39facfb01443a413211312e17332b75f47d8c2e1aec91121a3700b5d933249', 'wallet.js': '4b5892257922b4f1f311d4d0dbc6f953ee92650ea1c25021d9e419ed9fca8a85', 'wallet.css': 'c57e78cde0efc21e62b14343a48088bbdf879ad797af61cab3dc8201f81c4ec8', 'entry.js': 'bd05fa2e98edb214db50825dbf57d279003727a97e6ce2c4a39e4b5b24582982'}
LOCATIONS='\n  location = /driver-wallet-sandbox { alias /usr/share/nginx/html/_vaydu-wallet/wallet.html; default_type text/html; add_header Cache-Control no-store; add_header Referrer-Policy no-referrer; }\n  location = /driver-topup-return { alias /usr/share/nginx/html/_vaydu-wallet/wallet.html; default_type text/html; add_header Cache-Control no-store; add_header Referrer-Policy no-referrer; }\n  location ^~ /_vaydu-wallet/ { root /usr/share/nginx/html; add_header Cache-Control no-store; add_header Referrer-Policy no-referrer; }\n  location ^~ /api/payment/driver-topup/ { resolver 127.0.0.11 valid=10s ipv6=off; set $wallet_api http://movabi-develop-api:3001; proxy_pass $wallet_api; proxy_set_header Host $host; proxy_set_header Authorization $http_authorization; proxy_read_timeout 35s; add_header Cache-Control no-store; }\n'
class Stop(Exception):pass

def private_write(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data)

def safe_message(line):
 line=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',line)
 line=re.sub(r'https?://[^\s<>]+','[URL withheld]',line)
 line=re.sub(r'(?:FLWSECK[^\s\x22\x27]*|sk_(?:test|live)_[^\s\x22\x27]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)','[credential withheld]',line)
 line=re.sub(r'(?i)\b(password|secret|token|authorization|api[_-]?key)\s*[:=]\s*[^,;\s]+',r'\1=[withheld]',line)
 line=re.sub(r'[A-Za-z0-9_+/=-]{40,}','[opaque value withheld]',line)
 return ''.join(c for c in line if c=='\t' or ord(c)>=32)[:600]

def summarize(stdout,stderr,recipe):
 text=(stdout+b'\n'+stderr).decode(errors='replace');lines=text.splitlines();instruction=None;number=None
 for line in lines:
  match=re.search(r'^\s*(\d+)\s*\|\s*>>>',line)
  if match and 1<=int(match[1])<=len(recipe.splitlines()):number=int(match[1]);instruction=recipe.splitlines()[number-1]
 if instruction is None:
  failed=re.findall(r'^#(\d+)\s+ERROR:',text,re.M)
  for line in lines:
   if (failed and re.match(r'^#'+failed[-1]+r'\s',line)) or not failed:
    match=re.search(r'(?:\]\s+|Step \d+/\d+ :\s*)(ARG|FROM|COPY|RUN)\s+(.+)',line)
    if match:
     command=match[1]+' '+match[2]
     for i,item in enumerate(recipe.splitlines(),1):
      if command==item:instruction=item;number=i
  if instruction is None and re.search(r'load metadata|resolve source metadata|pull access denied',text,re.I):instruction=recipe.splitlines()[1];number=2
 errors=[]
 for line in lines:
  normalized=re.sub(r'^#\d+\s+(?:[0-9.]+\s+)?','',line).strip()
  if re.search(r'error|failed|denied|cannot|can.t|read-only|not found|no such file|unknown flag|not permitted|exit code',normalized,re.I):
   safe=safe_message(normalized)
   if safe and safe not in errors:errors.append(safe)
 return {'failedDockerfileLine':number,'failedInstruction':instruction,'underlyingErrors':errors[-6:],'rawOutputWithheld':True}

def verify_context(folder):
 if folder.is_symlink() or folder.resolve().parent!=STATE.resolve():raise Stop('unsafe_context_path')
 if {p.name for p in folder.iterdir()}!=FILES:raise Stop('unexpected_context_members')
 data={}
 for name in FILES:
  p=folder/name;s=p.lstat()
  if not stat.S_ISREG(s.st_mode) or p.is_symlink() or s.st_uid!=os.getuid() or s.st_size>2097152:raise Stop('unsafe_context_file')
  data[name]=p.read_bytes()
 if data['Dockerfile'].decode()!=RECIPE:raise Stop('Dockerfile_differs_from_reviewed_recipe')
 for name,expected in ASSET_HASHES.items():
  if hashlib.sha256(data[name]).hexdigest()!=expected:raise Stop('context_wallet_asset_differs_from_reviewed_source')
 if re.search(rb'(?i)proxy_set_header\s+(?:Authorization|X-API-Key)\s+[\x22\x27]?(?:Basic|Bearer)\s+[^\s;]+',data['default.conf']):raise Stop('literal_authorization_in_context_values_withheld')
 for name,body in data.items():
  if re.search(rb'FLWSECK|sk_(?:live|test)_[A-Za-z0-9]|-----BEGIN .*PRIVATE KEY-----',body):raise Stop('possible_secret_in_context_values_withheld')
  for token in re.findall(rb'eyJ[\w-]+\.[\w-]+\.[\w-]+',body):
   import base64
   try:role=json.loads(base64.urlsafe_b64decode(token.split(b'.')[1]+b'===')).get('role')
   except Exception:role=None
   if role!='anon':raise Stop('nonpublic_token_in_context_values_withheld')
  if re.search(rb'(?i)(?:password|service_role_key|secret_key)\s*[=:]\s*[\x22\x27][^\x22\x27]{4,}',body):raise Stop('possible_secret_assignment_in_context_values_withheld')
 return data

def main():
 if STATE.is_symlink() or STATE.stat().st_uid!=os.getuid() or stat.S_IMODE(STATE.stat().st_mode)!=0o700:raise Stop('operator_state_not_owner_private')
 candidates=[p for p in STATE.glob('ui-build-*') if p.is_dir() and not p.is_symlink() and (p/'Dockerfile').is_file()]
 if not candidates:raise Stop('retained_ui_build_context_missing')
 source=max(candidates,key=lambda p:p.stat().st_mtime);data=verify_context(source)
 evidence=STATE/('ui-diagnostic-'+uuid.uuid4().hex[:12]);evidence.mkdir(mode=0o700)
 context=evidence/'context';context.mkdir(mode=0o700)
 for name,body in data.items():private_write(context/name,body)
 def call(args):
  p=subprocess.run(args,capture_output=True,timeout=40)
  if p.returncode:raise Stop('docker_identity_or_capability_check_failed_raw_output_retained_only')
  return p.stdout
 d=['docker']
 if subprocess.run(d+['info','--format','{{.ServerVersion}}'],capture_output=True,timeout=15).returncode:d=['sudo','-n','docker']
 baseline=json.loads((STATE/'baseline.json').read_text())['web']['image']
 project=call(d+['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}','movabi-develop-web']).decode().strip()
 current=call(d+['inspect','--format','{{.Image}}','movabi-develop-web']).decode().strip()
 tag='vaydu-web:reviewed-wallet-base-20261028'
 if project!='movabi-develop' or current!=baseline or call(d+['image','inspect','--format','{{.Id}}',tag]).decode().strip()!=baseline:raise Stop('pinned_web_baseline_or_tag_changed')
 onbuild=json.loads(call(d+['image','inspect','--format','{{json .Config.OnBuild}}',baseline]))
 shell=json.loads(call(d+['image','inspect','--format','{{json .Config.Shell}}',baseline]))
 if onbuild or shell not in (None,[],['/bin/sh','-c'],['/bin/bash','-c']):raise Stop('unexpected_base_build_hooks_or_shell')
 original_index=call(d+['run','--rm','--network','none','--entrypoint','cat',baseline,'/usr/share/nginx/html/index.html']).decode('utf-8-sig')
 original_config=call(d+['run','--rm','--network','none','--entrypoint','cat',baseline,'/etc/nginx/conf.d/default.conf']).decode()
 entry='<script src="/_vaydu-wallet/entry.js" defer></script>'
 expected_index=re.sub(r'</body>',lambda x:entry+x.group(),original_index,count=1,flags=re.I).encode()
 expected_config=re.sub(r'server\s*\{',lambda x:x.group()+LOCATIONS,original_config,count=1).encode()
 if data['index.html']!=expected_index or data['default.conf']!=expected_config:raise Stop('context_differs_from_reviewed_public_base_patch')

 # Only reviewed local image argument, COPY operations and cache-file removal.
 # No --secret, --ssh, credentials, env assignments or package/network commands.
 help_text=call(d+['build','--help']).decode(errors='replace')
 command=d+['build']+(['--progress=plain'] if '--progress' in help_text else [])+['--network','none','--pull=false','--build-arg','DEVELOP_WEB='+tag,'--file',str(context/'Dockerfile'),'--tag','vaydu-web:diagnostic-'+evidence.name[-12:],str(context)]
 private_write(evidence/'invocation.json',json.dumps({'argv':command,'baseImage':baseline,'contextSha256':{n:hashlib.sha256(b).hexdigest() for n,b in data.items()},'credentialsInBuildArgs':False,'contextSecretPatternScanPassed':True,'contextProvenanceVerified':True,'noSecretOrSshMounts':True},indent=2).encode())
 env=os.environ.copy();env['BUILDKIT_PROGRESS']='plain'
 out_path=evidence/'stdout.log';err_path=evidence/'stderr.log'
 for p in [out_path,err_path]:private_write(p,b'')
 with out_path.open('wb') as out,err_path.open('wb') as err:
  try:code=subprocess.run(command,stdout=out,stderr=err,env=env,timeout=300).returncode
  except subprocess.TimeoutExpired:code=124
 result={'stage':'diagnose-ui-build','buildExitCode':code,'pinnedWebBaseImage':baseline,'originalContextPreserved':True,'privateEvidenceDirectory':str(evidence),'credentialsInBuildArgs':False,'contextSecretPatternScanPassed':True,'contextProvenanceVerified':True,'servicesChanged':False,'apiChanged':False,'sqlChanged':False,**summarize(out_path.read_bytes(),err_path.read_bytes(),RECIPE)}
 private_write(evidence/'sanitized-result.json',json.dumps(result,indent=2).encode())
 print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
 try:main()
 except Exception as error:
  reason=str(error) if type(error) is Stop else 'diagnostic_precondition_failed_raw_output_withheld'
  print(json.dumps({'stage':'diagnose-ui-build','completed':False,'blocked':reason,'noRawOutputPrinted':True}));raise SystemExit(1)
