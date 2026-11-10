"""Package reviewed wallet overlay and operator tools; no deployment or secret access."""
import hashlib,json,shutil,subprocess,tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
DEST=ROOT/'.temp/vaydu-wallet-minimal-20261028'
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as stream:
  for c in iter(lambda:stream.read(1048576),b''):h.update(c)
 return h.hexdigest()
def main():
 reviewed=json.loads((DEST/'reviewed-sources.json').read_text())
 old=ROOT/'.temp/vaydu-wallet-operator-20261028'
 for name in ['verify-develop-wallet-backup.py','setup_only_release.py','wallet_canonical_contract.py','wallet_minimal_operator.py']:
  shutil.copyfile(ROOT/'scripts'/name,DEST/name)
 for name in ['supabase_incremental_schema_reconcile.sql','dashboard-evidence.example.json']:shutil.copyfile(old/name,DEST/name)
 payload=subprocess.run(['docker','image','inspect','--format','{{.Id}}','vaydu-wallet-payload:minimal-20261028'],capture_output=True,text=True,check=True).stdout.strip()
 manifest={'purpose':'wallet-minimal-20261028-v3','canonicalVersion':'wallet-operator-20261028-v2','canonicalSqlSha256':sha(DEST/'supabase_incremental_schema_reconcile.sql'),'apiImage':None,'payloadImage':payload,
 'baseApiImage':reviewed['baseApiImage'],'protectedSourceHashes':reviewed['protectedSourceHashes'],'protectedAbsentPaths':reviewed['protectedAbsentPaths'],
 'driver':'318e6be9-9164-41fa-bb0c-c5ccd3526585','tenant':'d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','provider':'flutterwave','country':'NG','currency':'NGN','policy':'vaydu-driver-card-5pct-wallet-v1',
 'subaccountsRequired':False,'activationEnabled':False,'webDeploymentIncluded':False,'finalApiRequiresGuardedServerLocalBuild':True}
 (DEST/'release.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
 subprocess.run(['docker','image','save','--output',str(DEST/'wallet-payload.tar'),'vaydu-wallet-payload:minimal-20261028'],check=True)
 with tarfile.open(DEST/'wallet-payload.tar') as tf:
  meta=json.load(tf.extractfile('manifest.json'))
  if len(meta)!=1 or meta[0]['RepoTags']!=['vaydu-wallet-payload:minimal-20261028']:raise RuntimeError('Unexpected saved payload image')
  config=tf.extractfile(meta[0]['Config']).read()
  manifest['payloadConfigImage']='sha256:'+hashlib.sha256(config).hexdigest()
  manifest['payloadTag']='vaydu-wallet-payload:minimal-20261028'
 (DEST/'release.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')

 with tarfile.open(DEST/'mobile-develop-review.tar.gz','w:gz') as tf:
  for p in sorted((ROOT/'dist/mobile').rglob('*')):
   if p.is_file():tf.add(p,arcname=p.relative_to(ROOT/'dist/mobile').as_posix(),recursive=False)
 tests={'walletStripeBookingPayoutOverlayTestsPassed':121,'operatorGuardTestsPassed':10,'workspaceServerTypecheckPassed':True,'isolatedWalletPayloadTypecheckPassed':True,'developMobileBuildPassed':True,'mobileBuildWarnings':['app.css exceeds configured 100kB warning budget by 13.81kB'],
 'canonicalSyntheticRestoreFirstApplyPassed':True,'canonicalSyntheticRepeatPassed':True,'canonicalSyntheticProtectedStateUnchanged':True,'sharedStripeFlutterwaveFinancialSqlPassed':True,'realDevelopCanonicalRehearsalPerformed':False,'derivedBaselineImageBuiltLocally':False,'providerPaymentPerformed':False,'nativeReturnVerified':False}
 (DEST/'LOCAL-TESTS.json').write_text(json.dumps(tests,indent=2)+'\n',encoding='utf-8')
 (DEST/'SHA256SUMS').write_text(''.join(sha(p)+'  '+p.name+'\n' for p in sorted(DEST.iterdir()) if p.is_file() and p.name!='SHA256SUMS'),encoding='utf-8',newline='\n')
 print(json.dumps({'bundle':str(DEST),'checksumManifestSha256':sha(DEST/'SHA256SUMS'),'sizeMiB':round(sum(p.stat().st_size for p in DEST.iterdir() if p.is_file())/1048576,2),'canonicalSqlSha256':manifest['canonicalSqlSha256'],'payloadImage':payload}))
if __name__=='__main__':main()
