"""Private TEST credential reuse prompt. No key generation, source-file reads or overwrite."""
import getpass,json,os,re,stat,sys,warnings
from pathlib import Path
TARGET=Path.home()/'.config/vaydu-driver-card-sandbox/flutterwave-test.env'
CALLBACK='https://movabi-develop.apps.evolsolution.com/driver-topup-return'
def main():
 if not sys.stdin.isatty():raise RuntimeError('interactive_ssh_terminal_required')
 if TARGET.exists() or TARGET.is_symlink():raise RuntimeError('existing_wallet_file_preserved_no_overwrite')
 warnings.simplefilter('error',getpass.GetPassWarning)
 alias=input('Internal merchant alias (not identity approval): ').strip()
 account=input('Provider-supported transaction account_id (not an assumed MID): ').strip()
 if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}',alias) or not re.fullmatch(r'\d{1,30}',account):raise RuntimeError('nonsecret_reference_format_invalid_no_file_created')
 key=getpass.getpass('Existing Flutterwave TEST secret key (hidden; reused, not regenerated): ')
 if not re.fullmatch(r'FLWSECK_TEST-[A-Za-z0-9_-]+',key):raise RuntimeError('test_key_format_required_no_provider_request')
 hook=getpass.getpass('Separate wallet TEST webhook secret hash (hidden; must match dashboard): ')
 if not re.fullmatch(r'[A-Za-z0-9_-]{8,}',hook) or hook==key or hook.startswith('FLWSECK'):raise RuntimeError('separate_wallet_webhook_secret_required')
 if getpass.getpass('Confirm wallet webhook secret hash (hidden): ')!=hook:raise RuntimeError('webhook_confirmation_mismatch')
 folder=TARGET.parent
 for parent in [folder,*folder.parents]:
  if parent.is_symlink():raise RuntimeError('symlink_parent_rejected')
 folder.mkdir(mode=0o700,parents=True,exist_ok=True)
 if folder.stat().st_uid!=os.getuid() or stat.S_IMODE(folder.stat().st_mode)&0o022:raise RuntimeError('wallet_directory_owner_or_write_permissions_unsafe_no_permissions_changed')
 values={'VAYDU_DRIVER_TOPUP_API':'false','FLUTTERWAVE_SECRET_KEY':key,'FLUTTERWAVE_WEBHOOK_SECRET':hook,'FLUTTERWAVE_MERCHANT_REF':alias,'FLUTTERWAVE_PROVIDER_ACCOUNT_ID':account,'VAYDU_TOPUP_CALLBACK_URL':CALLBACK}
 fd=os.open(TARGET,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:
  f.write(''.join(k+'='+v+'\n' for k,v in values.items()));f.flush();os.fsync(f.fileno())
 print(json.dumps({'completed':True,'walletFileCreated':True,'testCredentialReused':True,'keysGenerated':False,'subaccountFileRead':False,'separateWalletWebhookPresent':True,'liveKeyConfigured':False,'activationEnabled':False,'providerRequestsMade':False,'identityApproved':False,'privateFile':str(TARGET),'permissions':'0600'}))
if __name__=='__main__':
 try:main()
 except Exception as e:
  category=str(e) if type(e) is RuntimeError else 'private_binding_setup_failed_values_withheld'
  print(json.dumps({'completed':False,'blocked':category,'noSecretValuesPrinted':True}));raise SystemExit(1)
