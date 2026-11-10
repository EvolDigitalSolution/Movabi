"""Prepare a wallet-only overlay; never modify protected workspace files or credentials."""
from pathlib import Path
import hashlib,json,re,shutil,subprocess
ROOT=Path(__file__).resolve().parent.parent
DEST=ROOT/'.temp/vaydu-wallet-minimal-20261028'
CONTEXT=ROOT/'.temp/wallet-minimal-build'
BASE='sha256:1ef978c931bf390273f4648f6c8bdce04231338d64ae7c6ead7e4e10d723c6aa'

def prepare():
 comparison=json.loads((ROOT/'.temp/deployed-wallet-source-comparison/comparison.json').read_text())
 if comparison['sourceImage']!=BASE:raise RuntimeError('Reviewed source image differs')
 protected={};absent=[]
 for entry in comparison['files']:
  name=entry['file']
  if entry['deployedExists']:
   data=(ROOT/'.temp/deployed-wallet-source-comparison/deployed'/name).read_bytes()
   if hashlib.sha256(data).hexdigest()!=entry['deployedSha256']:raise RuntimeError('Deployed source evidence changed')
   protected[name]=entry['deployedSha256']
  else:absent.append(name)
 if len(protected)!=6 or set(absent)!={'server/services/payments/stripe-payment-adapter.ts','server/services/payments/stripe-payment-bridge.ts'}:raise RuntimeError('Unexpected reviewed presence map')
 DEST.mkdir(parents=True,exist_ok=True);CONTEXT.mkdir(parents=True,exist_ok=True)
 src=CONTEXT/'src';src.mkdir(exist_ok=True)
 visited=set();todo=['server/routes/driver-wallet-develop.routes.ts']
 while todo:
  name=todo.pop()
  if name in visited:continue
  if name in protected or name in absent:raise RuntimeError('Protected architecture dependency unexpectedly imported: '+name)
  visited.add(name);relative=Path(name).relative_to('server');out=src/relative;out.parent.mkdir(parents=True,exist_ok=True)
  if name=='server/services/supabase.service.ts':
   out.write_text("// Reuse the existing in-process client; no settings or credentials copied.\nexport const supabaseAdmin:any=require('../../services/supabase.service').supabaseAdmin;\n",encoding='utf-8');continue
  data=(ROOT/name).read_text();out.write_text(data,encoding='utf-8')
  for spec in re.findall(r'''(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']''',data):
   if spec.startswith('.'):
    dep=(ROOT/Path(name).parent/spec).resolve()
    if dep.suffix!='.ts':dep=Path(str(dep)+'.ts')
    todo.append(dep.relative_to(ROOT).as_posix())
 config={'compilerOptions':{'target':'ES2020','module':'CommonJS','moduleResolution':'node','esModuleInterop':True,'strict':False,'skipLibCheck':True,'rootDir':'src','outDir':'payload/wallet-sandbox','types':['node'],'typeRoots':[str(ROOT/'node_modules/@types')]},'include':['src/**/*.ts']}
 # Resolve third-party imports through the workspace without copying dependencies.
 config['compilerOptions']['baseUrl']=str(ROOT)
 config['compilerOptions']['paths']={'*':['node_modules/*']}
 (CONTEXT/'tsconfig.json').write_text(json.dumps(config,indent=2),encoding='utf-8')
 subprocess.run(['node',str(ROOT/'node_modules/typescript/bin/tsc'),'-p',str(CONTEXT/'tsconfig.json')],check=True)
 patch='''const fs=require('fs'),crypto=require('crypto');
const expected=__HASHES__,absent=__ABSENT__;
function check(){for(const [p,h] of Object.entries(expected)){const f='/app/'+p;if(fs.realpathSync(f)!==f||!fs.lstatSync(f).isFile()||crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')!==h)throw Error('protected_source_mismatch');}
for(const p of absent){try{fs.lstatSync('/app/'+p);throw Error('protected_absence_changed');}catch(e){if(e.code!=='ENOENT')throw e;}}}
check();const path='/app/server/index.ts';let text=fs.readFileSync(path,'utf8');
const anchor=/app\\.use\\(\\s*(['"])\\/api\\/payment\\1\\s*,\\s*paymentRoutes\\s*\\)\\s*;/g;
if((text.match(anchor)||[]).length!==1||text.includes('/api/payment/driver-topup')||text.includes('wallet-sandbox'))throw Error('index_mount_requires_review');
text=text.replace(anchor,`app.use('/api/payment/driver-topup', require('./wallet-sandbox/routes/driver-wallet-develop.routes').driverWalletDevelopRouter(require('./services/supabase.service').supabaseAdmin));\\n$&`);
fs.writeFileSync(path,text);check();
'''.replace('__HASHES__',json.dumps(protected)).replace('__ABSENT__',json.dumps(absent))
 (CONTEXT/'payload/patch-index.cjs').write_text(patch,encoding='utf-8')
 (CONTEXT/'Dockerfile').write_text('FROM scratch\nCOPY payload /payload\n',encoding='utf-8')
 (DEST/'Dockerfile.api').write_text('ARG WALLET_PAYLOAD\nARG DEVELOP_BASE\nFROM ${WALLET_PAYLOAD} AS wallet\nFROM ${DEVELOP_BASE}\nCOPY --from=wallet /payload/wallet-sandbox /app/server/wallet-sandbox\nCOPY --from=wallet /payload/patch-index.cjs /tmp/vaydu-wallet-patch.cjs\nRUN node /tmp/vaydu-wallet-patch.cjs && rm /tmp/vaydu-wallet-patch.cjs\n',encoding='utf-8')
 manifest={'baseApiImage':BASE,'protectedSourceHashes':protected,'protectedAbsentPaths':absent,'walletClosure':sorted(visited),'walletPayloadSourceHashes':{name:hashlib.sha256((src/Path(name).relative_to('server')).read_bytes()).hexdigest() for name in sorted(visited)}}
 (DEST/'reviewed-sources.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
 shutil.copyfile(ROOT/'docs/WALLET_MINIMAL_DEPLOYED_REVIEW.md',DEST/'SOURCE-REVIEW.md')
 print(json.dumps({'payloadContext':str(CONTEXT),'walletSourceFiles':len(visited),'protectedFilesReplaced':0,'absentStripeModulesAdded':False}))
if __name__=='__main__':prepare()

