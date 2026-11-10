"""Build a credential-free, single-migration rehearsal bundle. No deployment."""
import hashlib
import json
from pathlib import Path
import shutil
from setup_only_release import NAME,PURPOSE

ROOT=Path(__file__).resolve().parent.parent
DEST=ROOT/'scripts'/'ng-setup-only-review'
def main():
    DEST.mkdir(exist_ok=True)
    if DEST.is_symlink():raise RuntimeError('Unsafe review directory')
    folder=DEST/'migrations';folder.mkdir(exist_ok=True)
    body=(ROOT/'supabase/migrations'/NAME).read_bytes()
    (folder/NAME).write_bytes(body)
    manifest={'purpose':PURPOSE,'files':[{'name':NAME,'sha256':hashlib.sha256(body).hexdigest()}],
      'lineage':{'version':'20261255000000','scope':'independent setup-only additive branch','dependsOn':['profiles schema/activated selected driver','market_availability NG/NGN','PostgreSQL UUID generation','anon/authenticated/service_role roles'],
       'doesNotDependOn':['20261253900000','20261254600000','20261254700000','20261254800000','20261254900000'],
       'existingMigrationFilesRewritten':False,'legacyCollectionRecordsImported':False},
      'merchantIdentityApproved':False,'administrativeDefaultApproved':False,'activationEnabled':False}
    (folder/'migration-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n')
    for name in ['verify-develop-wallet-backup.py','setup_only_release.py','apply-driver-setup-only-release.py','release-driver-collection-cohost.py','check-cohost-disabled-stage.py']:
        shutil.copyfile(ROOT/'scripts'/name,DEST/name)
    protected=['server/routes/connect.routes.ts','server/services/stripe.service.ts','server/routes/payment.routes.ts','server/routes/booking.routes.ts','server/routes/stripe-webhook.routes.ts','server/services/payout-eligibility.service.ts','server/services/job-payout.service.ts']
    (DEST/'review.json').write_text(json.dumps({'imageId':'sha256:084b2cf6a7db7713244a7554a38acb54f0dd78323250ce9c260a2d541d7c3cfa','schemaScope':'setup-only-550','merchantIdentityApproved':False,'administrativeDefaultApproved':False,'activationEnabled':False,
      'protectedSourceHashes':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in protected}},indent=2)+'\n',encoding='utf-8',newline='\n')
    allowed={NAME,'migration-manifest.json','verify-develop-wallet-backup.py','setup_only_release.py','apply-driver-setup-only-release.py','release-driver-collection-cohost.py','check-cohost-disabled-stage.py','review.json','SHA256SUMS'}
    if any(p.is_symlink() or (p.is_file() and p.name not in allowed) for p in DEST.rglob('*')):raise RuntimeError('Unexpected review file')
    sums={p.relative_to(DEST).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(DEST.rglob('*')) if p.is_file() and p.name!='SHA256SUMS'}
    (DEST/'SHA256SUMS').write_text(''.join(digest+'  '+name+'\n' for name,digest in sums.items()),encoding='utf-8',newline='\n')
    print(json.dumps({'bundle':str(DEST),'manifestSha256':hashlib.sha256((DEST/'SHA256SUMS').read_bytes()).hexdigest(),'migrationSha256':hashlib.sha256(body).hexdigest(),'deployed':False}))
if __name__=='__main__':main()
