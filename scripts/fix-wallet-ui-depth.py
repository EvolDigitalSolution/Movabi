"""Correct only the diagnosed UI layer-depth failure. No deployment or API rebuild."""
import gzip,hashlib,importlib.util,json,os,re,stat,subprocess,uuid
from pathlib import Path
STATE=Path.home()/'.local/state/vaydu-wallet-minimal-operator'
DIAG='ui-diagnostic-456000c11af4'
BASE='sha256:ba1b15a9ea08e387ce445916a222ecabdb882b73b3ff077ed74a48df624ae808'
COMPRESSOR='sha256:748b66e62dce2048ec332f0b16e91eb014fbbc07e286823ad9bedfc68a7ee2a3'
class Stop(Exception):pass

def write(path,data,mode=0o600):
 path.parent.mkdir(parents=True,exist_ok=True)
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
 with os.fdopen(fd,'wb') as f:f.write(data)

def command(args,data=None,timeout=120):
 p=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
 if p.returncode:raise Stop('verification_command_failed_no_raw_output_printed')
 return p.stdout

def asset_manifest(d,image):
 script="find /usr/share/nginx/html -type f ! -path '/usr/share/nginx/html/_vaydu-wallet/*' ! -path '/usr/share/nginx/html/index.html' ! -path '/usr/share/nginx/html/index.html.gz' ! -path '/usr/share/nginx/html/index.html.br' -exec sha256sum '{}' ';' | LC_ALL=C sort"
 p=subprocess.run(d+['run','--rm','--network','none','--entrypoint','/bin/sh',image,'-c',script],capture_output=True,timeout=90)
 if p.returncode or p.stderr:raise Stop('unchanged_asset_manifest_failed')
 return p.stdout

def build_and_verify(d,source,folder,base,compressor,diag):
 data={n:(source/n).read_bytes() for n in diag.FILES};root=folder/'rootfs';root.mkdir(mode=0o755)
 targets={'index.html':'usr/share/nginx/html/index.html','default.conf':'etc/nginx/conf.d/default.conf',**{n:'usr/share/nginx/html/_vaydu-wallet/'+n for n in diag.ASSET_HASHES}}
 for name,path in targets.items():write(root/path,data[name],0o644)
 # Replace stale encodings in the SAME COPY, rather than adding a RUN layer.
 write(root/'usr/share/nginx/html/index.html.gz',gzip.compress(data['index.html'],mtime=0),0o644)
 brotli=command(d+['run','--rm','-i','--network','none','--entrypoint','node',compressor,'-e',"process.stdout.write(require('zlib').brotliCompressSync(require('fs').readFileSync(0)))"],data['index.html'])
 write(root/'usr/share/nginx/html/index.html.br',brotli,0o644)
 for path in root.rglob('*'):
  if path.is_dir():os.chmod(path,0o755)  # ONLY newly-created public overlay directories.
 recipe=b'ARG DEVELOP_WEB\nFROM ${DEVELOP_WEB}\nCOPY rootfs/ /\n';write(folder/'Dockerfile',recipe)
 base_tag='vaydu-web:ui-depth-base-'+folder.name[-8:]
 command(d+['image','tag',base,base_tag])
 if command(d+['image','inspect','--format','{{.Id}}',base_tag]).decode().strip()!=base:raise Stop('base_tag_identity_changed')
 help_text=command(d+['build','--help']).decode(errors='replace');tag='vaydu-web:ui-depth-fixed-'+folder.name[-8:]
 args=d+['build']+(['--progress=plain'] if '--progress' in help_text else [])+['--network','none','--pull=false','--build-arg','DEVELOP_WEB='+base_tag,'--tag',tag,str(folder)]
 write(folder/'invocation.json',json.dumps({'argv':args,'uiOnly':True,'baseImage':base,'providerCredentialsUsed':False,'apiApplicationStarted':False},indent=2).encode())
 for name in ['stdout.log','stderr.log']:write(folder/name,b'')
 with (folder/'stdout.log').open('wb') as out,(folder/'stderr.log').open('wb') as err:
  p=subprocess.run(args,stdout=out,stderr=err,timeout=300)
 if p.returncode:
  return None,{'completed':False,'stage':'single-copy-ui-build','buildExitCode':p.returncode,'privateEvidenceDirectory':str(folder),**diag.summarize((folder/'stdout.log').read_bytes(),(folder/'stderr.log').read_bytes(),recipe.decode())}
 image=command(d+['image','inspect','--format','{{.Id}}',tag]).decode().strip()
 before=int(command(d+['image','inspect','--format','{{len .RootFS.Layers}}',base]));after=int(command(d+['image','inspect','--format','{{len .RootFS.Layers}}',image]))
 if after!=before+1:raise Stop('derived_image_not_exactly_one_new_filesystem_layer')
 for field in ['Entrypoint','Cmd','User','WorkingDir']:
  fmt='{{json .Config.'+field+'}}'
  if command(d+['image','inspect','--format',fmt,base])!=command(d+['image','inspect','--format',fmt,image]):raise Stop('web_runtime_configuration_changed')
 p=subprocess.run(d+['run','--rm','--network','none','--entrypoint','nginx',image,'-t'],capture_output=True,timeout=45)
 write(folder/'nginx.stdout',p.stdout);write(folder/'nginx.stderr',p.stderr)
 if p.returncode:return None,{'completed':False,'stage':'nginx-validation','privateEvidenceDirectory':str(folder),**diag.summarize(p.stdout,p.stderr,recipe.decode())}
 original=asset_manifest(d,base);derived=asset_manifest(d,image)
 write(folder/'original-booking-assets.sha256',original);write(folder/'derived-booking-assets.sha256',derived)
 if original!=derived:raise Stop('original_booking_assets_changed')
 original_index=command(d+['run','--rm','--network','none','--entrypoint','cat',base,'/usr/share/nginx/html/index.html'])
 receipt={'baseWebImage':base,'webImage':image,'sources':{n:hashlib.sha256(data[n]).hexdigest() for n in diag.ASSET_HASHES},'originalIndexSha256':hashlib.sha256(original_index).hexdigest(),'walletIndexSha256':hashlib.sha256(data['index.html']).hexdigest(),'bookingBundlesReplaced':False,'recipe':'single-copy-depth-fix','nginxConfigPassed':True,'originalBookingAssetsUnchanged':True}
 return receipt,{'completed':True,'stage':'single-copy-ui-correction','pinnedWebBaseImage':base,'webImage':image,'baseLayerCount':before,'derivedLayerCount':after,'newFilesystemLayers':1,'nginxConfigPassed':True,'originalBookingAssetsUnchanged':True,'originalAssetManifestSha256':hashlib.sha256(original).hexdigest(),'privateEvidenceDirectory':str(folder),'servicesChanged':False,'apiImageModified':False,'apiApplicationStarted':False,'sqlChanged':False,'paymentMade':False}

def main():
 if STATE.is_symlink() or STATE.stat().st_uid!=os.getuid() or stat.S_IMODE(STATE.stat().st_mode)!=0o700:raise Stop('operator_state_not_private')
 helper=Path.home()/'diagnose-wallet-ui-build.py'
 spec=importlib.util.spec_from_file_location('diag',helper);diag=importlib.util.module_from_spec(spec);spec.loader.exec_module(diag)
 evidence=STATE/DIAG;source=evidence/'context';meta=json.loads((evidence/'invocation.json').read_text());prior=json.loads((evidence/'sanitized-result.json').read_text())
 if not prior.get('contextProvenanceVerified') or prior.get('pinnedWebBaseImage')!=BASE or not any('max depth exceeded' in x for x in prior.get('underlyingErrors',[])):raise Stop('specific_layer_depth_diagnosis_required')
 if {p.name for p in source.iterdir()}!=diag.FILES or meta.get('baseImage')!=BASE:raise Stop('diagnostic_context_identity_changed')
 for name,sha in meta['contextSha256'].items():
  path=source/name
  if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=sha:raise Stop('preserved_context_checksum_changed')
 d=['docker']
 if subprocess.run(d+['info','--format','{{.ServerVersion}}'],capture_output=True).returncode:d=['sudo','-n','docker']
 if command(d+['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}','movabi-develop-web']).decode().strip()!='movabi-develop' or command(d+['inspect','--format','{{.Image}}','movabi-develop-web']).decode().strip()!=BASE:raise Stop('running_develop_web_baseline_changed')
 if json.loads((STATE/'baseline.json').read_text())['web']['image']!=BASE:raise Stop('recorded_web_baseline_changed')
 if command(d+['image','inspect','--format','{{.Id}}',COMPRESSOR]).decode().strip()!=COMPRESSOR:raise Stop('prepared_api_image_unavailable_for_offline_brotli_only')
 old_receipt=STATE/'prepared-ui.json'
 if old_receipt.is_file():
  r=json.loads(old_receipt.read_text())
  if r.get('recipe')=='single-copy-depth-fix' and r.get('sources')=={n:hashlib.sha256((source/n).read_bytes()).hexdigest() for n in diag.ASSET_HASHES}:
   if command(d+['image','inspect','--format','{{.Id}}',r['webImage']]).decode().strip()==r['webImage']:
    print(json.dumps({'completed':True,'existingCorrectedUiReused':True,'webImage':r['webImage'],'servicesChanged':False}));return
 folder=STATE/('ui-depth-fix-'+uuid.uuid4().hex[:12]);folder.mkdir(mode=0o700)
 protected_receipts={n:hashlib.sha256((STATE/n).read_bytes()).hexdigest() for n in ['prepared-image.json','rehearsal.json']}
 receipt,result=build_and_verify(d,source,folder,BASE,COMPRESSOR,diag)
 if receipt:
  if any(hashlib.sha256((STATE/n).read_bytes()).hexdigest()!=sha for n,sha in protected_receipts.items()):raise Stop('api_or_rehearsal_receipt_changed')
  if old_receipt.exists():write(folder/'prior-prepared-ui.json',old_receipt.read_bytes())
  pending=STATE/('prepared-ui.json.tmp-'+uuid.uuid4().hex[:8]);write(pending,(json.dumps(receipt,indent=2)+'\n').encode());os.replace(pending,old_receipt)
  result['preparedUiReceiptWritten']=True;result['apiAndRehearsalReceiptsUnchanged']=True
 write(folder/'result.json',json.dumps(result,indent=2).encode());print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
 try:main()
 except Exception as error:
  category=str(error) if type(error) is Stop else 'ui_correction_failed_private_evidence_retained'
  print(json.dumps({'completed':False,'blocked':category,'servicesChanged':False,'noRawOutputPrinted':True}));raise SystemExit(1)
