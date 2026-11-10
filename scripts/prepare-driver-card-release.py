"""Prepare reviewed deployment artifacts; never reads or packages credentials."""
import hashlib,json,pathlib,shutil,subprocess,sys
root=pathlib.Path(__file__).resolve().parent.parent
subprocess.run([sys.executable,str(root/'scripts/prepare-driver-wallet-develop-sql.py')],check=True)
release=root/'scripts/driver-card-develop-release'
sql=release/'supabase_incremental_schema_reconcile.sql'
digest=hashlib.sha256(sql.read_bytes()).hexdigest()
def image_id(tag):
    result=subprocess.run(['docker','image','inspect',tag,'--format','{{.Id}}'],capture_output=True,text=True,check=True)
    return result.stdout.strip()
api=image_id('vaydu-driver-card-sandbox:review-20261027');web=image_id('vaydu-driver-card-web:review-20261027')
shutil.copyfile(root/'scripts/check-driver-card-disabled-release.py',release/'check-driver-card-disabled-release.py')
manifest={'purpose':'develop-driver-card-disabled-schema','policyVersion':'vaydu-driver-card-5pct-wallet-v1','firstCandidateMarket':{'provider':'flutterwave','country':'NG','currency':'NGN','driverId':None},
          'canonicalSqlSha256':digest,'sandboxApiImageId':api,'sandboxWebImageId':web,
          'backupSha256':'abf0c32b9287efb2ca13b57521c786fde2930d21103a70343793d6fa1c404f21',
          'enableCollection':False,'enableLiveCollection':False,'driverSelectionRequired':True,'merchantReviewRequired':True,
          'connectionSecretInjectionAuthorized':True,'connectionSecretExtractionAllowed':False,'connectionBindingProvided':False}
(release/'release-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
source=(root/'scripts/verify-develop-wallet-backup.py').read_text()
(root/'scripts/validate-driver-card-canonical-on-backup.sh').write_text('# Applies reviewed canonical SQL twice ONLY to a fresh isolated restore clone.\n'+
 "python3 - --retry-backup '/home/edsadmin/vaydu-develop-wallet-backups/20261027T134821Z-1eabea4c' --validate-canonical-sql '/home/edsadmin/vaydu-driver-card-release-20261027/supabase_incremental_schema_reconcile.sql' --canonical-sha256 '"+digest+"' <<'PY'\n"+source+'\nPY\n')
checksums={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in release.iterdir() if p.is_file() and p.name!='checksums.json'}
(release/'checksums.json').write_text(json.dumps(checksums,indent=2)+'\n')
print('Prepared credential-free, disabled develop release artifacts and checksums')
