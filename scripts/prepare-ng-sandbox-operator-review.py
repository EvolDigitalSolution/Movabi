"""Credential-free operator bundle; no deployment or remote access."""
import hashlib
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
DEST=ROOT/'scripts'/'ng-sandbox-review'
FILES=[
 '20261253900000_flutterwave_market_provider_prerequisite.sql',
 '20261254600000_driver_payment_accounts_sandbox.sql',
 '20261254700000_flutterwave_payout_outbox.sql',
 '20261254800000_flutterwave_collection_subaccounts.sql',
 '20261254900000_flutterwave_booking_split_authority.sql',
]
def main():
    DEST.mkdir(exist_ok=True)
    allowed={'audit-develop-readonly.sh','provision_flutterwave_subaccount_test.py','verify-develop-wallet-backup.py',
             'check-flutterwave-test-merchant.py','confirmed-scope.json','checksums.json','SHA256SUMS','migrations/migration-manifest.json',
             *('migrations/'+name for name in FILES)}
    if DEST.is_symlink() or any(path.is_symlink() or (path.is_file() and str(path.relative_to(DEST)).replace('\\','/') not in allowed) for path in DEST.rglob('*')):
        raise RuntimeError('Unexpected file or symlink in operator bundle; review locally before uploading')
    migrations=DEST/'migrations';migrations.mkdir(exist_ok=True)
    entries=[]
    for name in FILES:
        body=(ROOT/'supabase'/'migrations'/name).read_bytes()
        (migrations/name).write_bytes(body)
        entries.append({'name':name,'sha256':hashlib.sha256(body).hexdigest()})
    manifest={'purpose':'vaydu-collection-disabled-rehearsal','files':entries}
    (migrations/'migration-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n')
    audit='\n'.join((ROOT/'scripts'/name).read_text(encoding='utf-8') for name in ['inspect-driver-payment-account-develop.sh','inspect-vaydu-secret-bindings.sh'])
    (DEST/'audit-develop-readonly.sh').write_text(audit,encoding='utf-8',newline='\n')
    for name in ['provision_flutterwave_subaccount_test.py','verify-develop-wallet-backup.py','check-flutterwave-test-merchant.py']:
        (DEST/name).write_bytes((ROOT/'scripts'/name).read_bytes())
    scope={'driverId':'318e6be9-9164-41fa-bb0c-c5ccd3526585','tenantId':'d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','country':'NG','currency':'NGN','source':'user-confirmed develop audit','privateCredentialFile':'/home/edsadmin/.config/vaydu-collection-subaccount-sandbox/flutterwave-test.env','databaseConnectionConfigured':False,'deployApproved':False,'setupEnabled':False,'bookingCollectionEnabled':False,'payoutsEnabled':False,'defaultSplitProposal':{'type':'flat','value':'0','approved':False}}
    scope['reportedRehearsal']={'restoreVerified':True,'collectionMigrationCloneVerified':True,'selectedExistingDriverVerified':True,'collectionGatesDisabledVerified':True,'canonicalCloneVerified':False,'canonicalValidationRequested':False}
    scope['reportedMerchantProbe']={'ngBankCatalogueAccessible':True,'ngnFeeQuoteAccessible':True,'collectionSubaccountListHttpStatus':400,'collectionSubaccountListCategory':'no_rows','bothListVariantsEmpty':True,'creationPermissionVerified':False,'merchantIdentityVerified':False,'creationTested':False,'settlementTested':False,'transferTested':False}
    (DEST/'confirmed-scope.json').write_text(json.dumps(scope,indent=2)+'\n',encoding='utf-8',newline='\n')
    sums={str(path.relative_to(DEST)).replace('\\','/'):hashlib.sha256(path.read_bytes()).hexdigest()
          for path in sorted(DEST.rglob('*')) if path.is_file() and path.name not in ('checksums.json','SHA256SUMS')}
    (DEST/'checksums.json').write_text(json.dumps(sums,indent=2)+'\n',encoding='utf-8',newline='\n')
    (DEST/'SHA256SUMS').write_text(''.join(digest+'  '+name+'\n' for name,digest in sums.items()),encoding='utf-8',newline='\n')
    print('Prepared credential-free NG sandbox operator bundle: '+str(DEST))
if __name__=='__main__':main()
