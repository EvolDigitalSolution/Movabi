"""Shallow only the pinned develop web image; test execution before a UI receipt.
No service deployment, API rebuild, SQL, prune or Docker storage manipulation.
"""
import copy,gzip,hashlib,importlib.util,io,json,os,re,subprocess,tarfile,time,uuid
from pathlib import Path
STATE=Path.home()/'.local/state/vaydu-wallet-minimal-operator'
BASE='sha256:ba1b15a9ea08e387ce445916a222ecabdb882b73b3ff077ed74a48df624ae808'
API='sha256:748b66e62dce2048ec332f0b16e91eb014fbbc07e286823ad9bedfc68a7ee2a3'
DIAG='ui-diagnostic-456000c11af4'
PURPOSE='vaydu-wallet-ui-shallow-test'
LAST_EVIDENCE=None
class Stop(Exception):pass

def digest(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()

def write(path,data,mode=0o600):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
 with os.fdopen(fd,'wb') as f:f.write(data)

class Runner:
 def __init__(self,d,folder):self.d=d;self.folder=folder;self.counter=0;self.owned=[];self.id=folder.name[-12:]
 def call(self,stage,args,data=None,timeout=180,allow=False):
  self.counter+=1;prefix=self.folder/('%03d-'%self.counter+stage)
  write(Path(str(prefix)+'.command.json'),json.dumps({'argv':self.d+args,'stdinBytes':len(data) if data else 0}).encode())
  try:p=subprocess.run(self.d+args,input=data,capture_output=True,timeout=timeout)
  except subprocess.TimeoutExpired as e:
   write(Path(str(prefix)+'.stdout'),e.stdout or b'');write(Path(str(prefix)+'.stderr'),e.stderr or b'');raise Stop(stage+':timeout_private_logs_preserved') from None
  write(Path(str(prefix)+'.stdout'),p.stdout);write(Path(str(prefix)+'.stderr'),p.stderr)
  if p.returncode and not allow:raise Stop(stage+':exit_'+str(p.returncode)+'_private_logs_preserved')
  return p
 def text(self,stage,args):return self.call(stage,args).stdout.decode().strip()
 def inspect(self,image):return json.loads(self.text('image-config',['image','inspect','--format','{{json .Config}}',image]))
 def create(self,image,label,entry=None):
  name='vaydu-ui-'+self.id+'-'+label
  args=['create','--name',name,'--network','none','--no-healthcheck','--label',PURPOSE+'='+self.id]
  if entry:args+=['--entrypoint',entry]
  self.owned.append(name);self.call('create-'+label,args+[image]);return name
 def remove_owned(self):
  for name in reversed(self.owned):
   label=self.text('cleanup-label',['inspect','--format','{{index .Config.Labels "'+PURPOSE+'"}}',name])
   network=self.text('cleanup-network',['inspect','--format','{{.HostConfig.NetworkMode}}',name])
   if label!=self.id or network!='none':raise Stop('temporary_container_cleanup_identity_mismatch')
   self.call('cleanup-own-container',['rm','-f','-v',name])

def canonical_tar(raw,exclude=None):
 result=[]
 with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
  for item in tf:
   name=item.name.lstrip('./')
   if exclude and exclude(name):continue
   content=hashlib.sha256(tf.extractfile(item).read()).hexdigest() if item.isfile() else None
   result.append([name,item.type.decode(errors='replace'),item.mode,item.uid,item.gid,item.linkname,content])
 return hashlib.sha256(json.dumps(sorted(result),separators=(',',':')).encode()).hexdigest()

def cp_manifest(r,container,path,stage,exclude=None):
 raw=r.call(stage,['cp',container+':'+path,'-']).stdout
 return canonical_tar(raw,exclude)

def load_flat(r,config,layer,tag):
 cfg=copy.deepcopy(config)
 # Runtime config is untouched. Rootfs/history ancestry is intentionally replaced.
 for key in ['parent','container']:cfg.pop(key,None)
 cfg['rootfs']={'type':'layers','diff_ids':['sha256:'+digest(layer)]}
 cfg['history']=[{'created':config.get('created'),'created_by':'verified shallow web filesystem'}]
 encoded=json.dumps(cfg,separators=(',',':')).encode();config_name=hashlib.sha256(encoded).hexdigest()+'.json'
 archive=r.folder/(tag.rsplit(':',1)[-1]+'.tar')
 write(archive,b'')
 with tarfile.open(archive,'w') as tf:
  for name,data in [(config_name,encoded),('manifest.json',json.dumps([{'Config':config_name,'RepoTags':[tag],'Layers':['flattened/layer.tar']}]).encode())]:
   item=tarfile.TarInfo(name);item.size=len(data);item.mode=0o600;tf.addfile(item,io.BytesIO(data))
  tf.add(layer,arcname='flattened/layer.tar',recursive=False)
 r.call('load-shallow-image',['image','load','--input',str(archive)],timeout=300)
 image=r.text('loaded-image-id',['image','inspect','--format','{{.Id}}',tag])
 if int(r.text('loaded-layer-count',['image','inspect','--format','{{len .RootFS.Layers}}',image]))!=1:raise Stop('flattened_image_not_one_layer')
 return image

def overlay_tar(source,dest,replacements):
 templates={};dirs=set()
 with tarfile.open(source,'r') as inp,tarfile.open(dest,'w',format=tarfile.PAX_FORMAT) as out:
  for item in inp:
   name=item.name.removeprefix('./').rstrip('/')
   if item.isdir():dirs.add(name)
   if name in replacements:templates[name]=copy.copy(item);continue
   if item.islnk() and item.linkname.removeprefix('./') in replacements:raise Stop('hardlink_to_modified_ui_file_requires_review')
   out.addfile(item,inp.extractfile(item) if item.isfile() else None)
  for path in replacements:
   for parent in reversed(Path(path).parents):
    n=parent.as_posix()
    if n=='.' or n in dirs:continue
    info=tarfile.TarInfo(n);info.type=tarfile.DIRTYPE;info.mode=0o755;out.addfile(info);dirs.add(n)
  for name,data in replacements.items():
   item=templates.get(name,tarfile.TarInfo(name));item.name=name;item.type=tarfile.REGTYPE;item.linkname='';item.size=len(data)
   if name not in templates:item.mode=0o644
   out.addfile(item,io.BytesIO(data))

def service_snapshot(r):
 out={}
 for name in ['movabi-develop-web','movabi-develop-api','movabi-develop-db']:
  out[name]=r.text('service-state',['inspect','--format','{{.Id}}|{{.Image}}|{{.State.Running}}|{{.State.StartedAt}}',name])
 return out

def perform(r,base,api,source,diag):
 config=r.inspect(base);volumes=sorted((config.get('Volumes') or {}).keys())
 if config.get('OnBuild'):raise Stop('base_onbuild_instructions_require_review')
 before_layers=int(r.text('base-layer-count',['image','inspect','--format','{{len .RootFS.Layers}}',base]))
 driver=r.text('storage-driver',['info','--format','{{.Driver}}'])
 # Save the immutable image config rather than copying ENV values into commands.
 saved=r.folder/'original-image.tar';write(saved,b'')
 r.call('save-pinned-base',['image','save','--output',str(saved),base],timeout=300)
 with tarfile.open(saved) as tf:
  manifest=json.load(tf.extractfile('manifest.json'))
  if len(manifest)!=1:raise Stop('unexpected_saved_image_manifest')
  raw_config=json.load(tf.extractfile(manifest[0]['Config']))
 base_container=r.create(base,'base','/bin/sh')  # NEVER started; declared volumes initialize from image.
 filesystem=r.folder/'original-filesystem.tar';write(filesystem,b'')
 r.call('export-unstarted-base',['export','--output',str(filesystem),base_container],timeout=300)
 flat=load_flat(r,raw_config,filesystem,'vaydu-web:shallow-base-'+r.id)
 if r.inspect(flat)!=config:raise Stop('flattened_base_runtime_config_not_identical')
 flat_container=r.create(flat,'flat','/bin/sh')
 volume_checks={}
 for path in volumes:
  if not path.startswith('/') or '..' in Path(path).parts:raise Stop('unexpected_declared_volume_path')
  same=cp_manifest(r,base_container,path,'base-volume')==cp_manifest(r,flat_container,path,'flat-volume')
  volume_checks[path]=same
  if not same:raise Stop('declared_volume_initial_data_or_permissions_changed')
 data={n:(source/n).read_bytes() for n in diag.FILES}
 replacements={'usr/share/nginx/html/index.html':data['index.html'],'etc/nginx/conf.d/default.conf':data['default.conf'],**{'usr/share/nginx/html/_vaydu-wallet/'+n:data[n] for n in diag.ASSET_HASHES}}
 replacements['usr/share/nginx/html/index.html.gz']=gzip.compress(data['index.html'],mtime=0)
 # Offline compression only; no API application, credentials or network.
 compressor_name='vaydu-ui-'+r.id+'-compressor'
 compressed=r.call('brotli-public-index',['run','--name',compressor_name,'--rm','--network','none','--entrypoint','node',api,'-e',"process.stdout.write(require('zlib').brotliCompressSync(require('fs').readFileSync(0)))"],data['index.html']).stdout
 replacements['usr/share/nginx/html/index.html.br']=compressed
 final_tar=r.folder/'wallet-filesystem.tar';write(final_tar,b'');overlay_tar(filesystem,final_tar,replacements)
 image=load_flat(r,raw_config,final_tar,'vaydu-web:wallet-shallow-'+r.id)
 if r.inspect(image)!=config:raise Stop('wallet_image_runtime_config_not_identical')
 app=r.create(image,'http')  # Uses original entrypoint/CMD/USER; no healthcheck side effects.
 syntax=r.call('nginx-syntax',['run','--name','vaydu-ui-'+r.id+'-syntax','--rm','--network','none','--entrypoint','nginx',image,'-t'],allow=True)
 if syntax.returncode:raise Stop('nginx_syntax_validation_failed')
 r.call('start-isolated-http',['start',app])
 ports=set(re.findall(r'\blisten\s+(?:\[::\]:|[0-9.]+:)?([0-9]+)',data['default.conf'].decode()))
 if len(ports)!=1:raise Stop('http_listen_port_requires_review')
 port=next(iter(ports));checks={}
 routes={'/driver-wallet-sandbox':data['wallet.html'],'/driver-topup-return?status=successful':data['wallet.html'],'/driver':data['index.html'],**{'/_vaydu-wallet/'+n:data[n] for n in diag.ASSET_HASHES}}
 for path,expected in routes.items():
  url='http://127.0.0.1:'+port+path
  fetch='if command -v wget >/dev/null 2>&1; then exec wget -q -O - '+url+'; elif command -v curl >/dev/null 2>&1; then exec curl -fsS '+url+'; else exit 127; fi'
  matched=False
  for _ in range(20):
   response=r.call('http-probe',['exec',app,'/bin/sh','-c',fetch],allow=True)
   if response.returncode==0 and response.stdout==expected:matched=True;break
   time.sleep(.25)
  checks[path]=matched
  if not matched:
   r.call('http-container-logs',['logs',app],allow=True)
   raise Stop('isolated_http_route_or_content_mismatch:'+path.split('?',1)[0])
 def exclude(path):
  # cp roots its archive at html/. Only the deliberate UI additions may differ.
  if path.startswith('html/'):path=path[5:]
  return path in ['index.html','index.html.gz','index.html.br'] or path=='_vaydu-wallet' or path.startswith('_vaydu-wallet/')
 original_assets=cp_manifest(r,base_container,'/usr/share/nginx/html','original-booking-assets',exclude)
 served_assets=cp_manifest(r,app,'/usr/share/nginx/html','served-booking-assets',exclude)
 if original_assets!=served_assets:raise Stop('original_booking_asset_content_or_permissions_changed')
 original_index=r.call('base-public-index',['cp',base_container+':/usr/share/nginx/html/index.html','-']).stdout
 with tarfile.open(fileobj=io.BytesIO(original_index)) as tf:base_index=tf.extractfile(next(x for x in tf.getmembers() if x.isfile())).read()
 receipt={'baseWebImage':base,'webImage':image,'sources':{n:hashlib.sha256(data[n]).hexdigest() for n in diag.ASSET_HASHES},'originalIndexSha256':hashlib.sha256(base_index).hexdigest(),'walletIndexSha256':hashlib.sha256(data['index.html']).hexdigest(),'bookingBundlesReplaced':False,'recipe':'shallow-filesystem-v1','allExecutionTestsPassed':True}
 result={'completed':True,'storageDriver':driver,'baseImage':base,'baseLayerCount':before_layers,'imageId':image,'candidateLayerCount':1,'containerCreationPassed':True,'nginxSyntaxPassed':True,'isolatedHttpStartupPassed':True,'httpRouteChecks':checks,'originalBookingAssetsUnchanged':True,'requiredRuntimeConfigIdentical':True,'declaredVolumes':volumes,'declaredVolumeInitialDataChecks':volume_checks,'originalImagesRetained':True,'paymentMade':False}
 return receipt,result

def main():
 global LAST_EVIDENCE
 if STATE.is_symlink() or STATE.stat().st_uid!=os.getuid() or (STATE.stat().st_mode&0o777)!=0o700:raise Stop('operator_state_not_owner_private')
 diag_path=Path.home()/'diagnose-wallet-ui-build.py';spec=importlib.util.spec_from_file_location('diag',diag_path);diag=importlib.util.module_from_spec(spec);spec.loader.exec_module(diag)
 origin=STATE/DIAG;source=origin/'context';inv=json.loads((origin/'invocation.json').read_text());diagnosis=json.loads((origin/'sanitized-result.json').read_text())
 if diagnosis.get('pinnedWebBaseImage')!=BASE or not diagnosis.get('contextProvenanceVerified'):raise Stop('verified_original_context_required')
 if {p.name for p in source.iterdir()}!=diag.FILES:raise Stop('original_context_members_changed')
 for n,h in inv['contextSha256'].items():
  if (source/n).is_symlink() or digest(source/n)!=h:raise Stop('original_context_checksum_changed')
 folder=STATE/('ui-shallow-'+uuid.uuid4().hex[:12]);folder.mkdir(mode=0o700);LAST_EVIDENCE=folder
 d=['docker']
 if subprocess.run(d+['info','--format','{{.ServerVersion}}'],capture_output=True).returncode:d=['sudo','-n','docker']
 r=Runner(d,folder);before=service_snapshot(r)
 expected=r.text('develop-project',['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}','movabi-develop-web'])
 if expected!='movabi-develop' or r.text('running-web-image',['inspect','--format','{{.Image}}','movabi-develop-web'])!=BASE:raise Stop('running_develop_web_baseline_changed')
 if json.loads((STATE/'baseline.json').read_text())['web']['image']!=BASE:raise Stop('recorded_web_baseline_changed')
 preserved={n:digest(STATE/n) for n in ['prepared-image.json','rehearsal.json']}
 failed={}
 previous=sorted(STATE.glob('ui-depth-fix-*'),key=lambda x:x.stat().st_mtime)
 if previous:
  record=json.loads((previous[-1]/'invocation.json').read_text());args=record['argv'];tag=args[args.index('--tag')+1]
  if not re.fullmatch(r'vaydu-web:ui-depth-fixed-[a-f0-9]+',tag):raise Stop('failed_candidate_reference_changed')
  failed={'failedCandidateImage':r.text('failed-candidate-id',['image','inspect','--format','{{.Id}}',tag]),'failedCandidateLayerCount':int(r.text('failed-candidate-layers',['image','inspect','--format','{{len .RootFS.Layers}}',tag]))}
 try:
  receipt,result=perform(r,BASE,API,source,diag)
  if service_snapshot(r)!=before or any(digest(STATE/n)!=h for n,h in preserved.items()):raise Stop('running_services_or_protected_receipt_changed')
  result.update(failed);result.update(runningServicesUnchanged=True,apiImageModified=False,sqlCommandsExecuted=False,apiAndRehearsalReceiptsUnchanged=True,privateEvidenceDirectory=str(folder))
  r.remove_owned()
  if service_snapshot(r)!=before:raise Stop('running_services_changed_during_temporary_cleanup')
  old=STATE/'prepared-ui.json'
  if old.exists():write(folder/'prior-prepared-ui.json',old.read_bytes())
  pending=STATE/('prepared-ui.tmp-'+r.id);write(pending,(json.dumps(receipt,indent=2)+'\n').encode());os.replace(pending,old)
  result['preparedUiReceiptWritten']=True;result['uniqueTemporaryContainersCleaned']=True
  write(folder/'result.json',json.dumps(result,indent=2).encode());print(json.dumps(result,sort_keys=True))
 except Exception as error:
  reason=str(error) if type(error) is Stop else 'shallow_ui_test_failed'
  result={'completed':False,'blocked':reason,**failed,'privateEvidenceDirectory':str(folder),'temporaryContainersRetained':r.owned,'preparedUiReceiptWritten':False,'runningServicesChangedByHelper':False,'apiImageModified':False,'sqlCommandsExecuted':False}
  # Include only sanitized engine errors, never configuration/environment contents.
  errors=[]
  for path in sorted(folder.glob('*.stderr')):
   errors+=diag.summarize(b'',path.read_bytes(),diag.RECIPE)['underlyingErrors']
  result['underlyingErrors']=errors[-6:]
  write(folder/'failure.json',json.dumps(result,indent=2).encode());print(json.dumps(result,sort_keys=True));raise SystemExit(1)
if __name__=='__main__':
 try:main()
 except Exception as error:
  reason=str(error) if type(error) is Stop else 'shallow_ui_precondition_failed'
  print(json.dumps({'completed':False,'blocked':reason,'privateEvidenceDirectory':str(LAST_EVIDENCE) if LAST_EVIDENCE else None,'noRawOutputPrinted':True}));raise SystemExit(1)
