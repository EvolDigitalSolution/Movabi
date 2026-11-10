"""Guarded develop schema staging. Default is read-only; explicit apply keeps gates off.

No image replacement, provider scope activation, secret provisioning or production action.
Run from a reviewed staged release directory containing the canonical SQL section.
"""
import argparse,hashlib,json,pathlib,subprocess

DB_IMAGE='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c'
API_IMAGE='sha256:1ef978c931bf390273f4648f6c8bdce04231338d64ae7c6ead7e4e10d723c6aa'
WEB_IMAGE='sha256:ba1b15a9ea08e387ce445916a222ecabdb882b73b3ff077ed74a48df624ae808'
BACKUP=pathlib.Path('/home/edsadmin/vaydu-develop-wallet-backups/20261027T134821Z-1eabea4c')
BACKUP_SHA='abf0c32b9287efb2ca13b57521c786fde2930d21103a70343793d6fa1c404f21'

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--release-dir',required=True);parser.add_argument('--apply-disabled-schema',action='store_true');args=parser.parse_args()
 directory=pathlib.Path(args.release_dir).resolve();manifest=json.loads((directory/'release-manifest.json').read_text())
 sql_path=directory/'supabase_incremental_schema_reconcile.sql';payload=sql_path.read_bytes()
 if sql_path.is_symlink() or hashlib.sha256(payload).hexdigest()!=manifest.get('canonicalSqlSha256'):raise RuntimeError('Staged canonical SQL checksum mismatch')
 if manifest.get('purpose')!='develop-driver-card-disabled-schema' or manifest.get('policyVersion')!='vaydu-driver-card-5pct-wallet-v1':raise RuntimeError('Wrong release purpose/policy')
 verified=json.loads((BACKUP/'verification-9168cbbb449f.json').read_text())
 if verified.get('restoreVerified') is not True or verified.get('sourceDatabase')!='movabi_develop' or verified.get('sourceContainer')!='movabi-develop-db' or verified.get('sourceImage')!=DB_IMAGE or verified.get('sha256')!=BACKUP_SHA:raise RuntimeError('Backup provenance/restore proof mismatch')
 digest=hashlib.sha256()
 with open(BACKUP/'movabi_develop.dump','rb') as archive:
  for chunk in iter(lambda:archive.read(1024*1024),b''):digest.update(chunk)
 if digest.hexdigest()!=BACKUP_SHA:raise RuntimeError('Backup archive checksum mismatch')
 docker=['docker']
 if subprocess.run(docker+['info'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:docker=['sudo','-n','docker']
 def run(parts,input_data=None):
  p=subprocess.run(docker+parts,input=input_data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
  if p.returncode:raise RuntimeError('Develop operation failed; diagnostic output withheld')
  return p.stdout
 for name,expected in [('movabi-develop-db',DB_IMAGE),('movabi-develop-api',API_IMAGE),('movabi-develop-web',WEB_IMAGE)]:
  item=json.loads(run(['inspect',name]))[0]
  if item['Image']!=expected:raise RuntimeError('Develop image baseline changed; re-review required')
  if name.endswith('-db'):
   if set(item['NetworkSettings']['Networks'])!={'movabi-develop-private'}:raise RuntimeError('Wrong database network')
  else:
   if (item['Config'].get('Labels') or {}).get('com.docker.compose.project')!='movabi-develop':raise RuntimeError('Wrong compose project')
  if name.endswith('-api'):
   env=dict(v.split('=',1) for v in item['Config'].get('Env',[]) if '=' in v)
   if env.get('NODE_ENV')!='production' or env.get('VAYDU_DRIVER_TOPUP_API')=='true':raise RuntimeError('Shared API guard baseline changed')
 rest=json.loads(run(['inspect','movabi-develop-rest']))[0]
 from urllib.parse import urlsplit,unquote
 uri=urlsplit(dict(v.split('=',1) for v in rest['Config'].get('Env',[]) if '=' in v).get('PGRST_DB_URI',''))
 if uri.hostname!='movabi-develop-db' or unquote(uri.path.lstrip('/'))!='movabi_develop':raise RuntimeError('Application database routing changed')
 readonly=['exec','-e','PGOPTIONS=-c default_transaction_read_only=on','movabi-develop-db','psql','-U','postgres','-d','movabi_develop','-X','-qAt','-v','ON_ERROR_STOP=1','-c']
 state=run(readonly+["SELECT public.wallet_collection_enabled(),(SELECT count(*) FROM public.wallet_topup_attempts),(SELECT count(*) FROM public.payment_checkout_attempts),(SELECT count(*) FROM public.market_payment_routes WHERE enabled OR merchant_approved OR adapter_ready OR payout_approved),coalesce((SELECT value FROM public.wallet_collection_config WHERE key='driver_card_sandbox_enabled'),'false')"]).decode().strip()
 if state!='f|0|2|0|false':raise RuntimeError('Disabled develop data/route baseline changed')
 if args.apply_disabled_schema:
  run(['exec','-i','movabi-develop-db','psql','-U','postgres','-d','movabi_develop','-X','-qAt','-v','ON_ERROR_STOP=1'],payload)
  if run(readonly+['SELECT public.wallet_collection_enabled()']).decode().strip()!='f':raise RuntimeError('Unexpected gate state; stop')
 print(json.dumps({'backupVerified':True,'target':'movabi-develop-db/movabi_develop','canonicalSqlVerified':True,'schemaApplied':args.apply_disabled_schema,'collectionEnabled':False,'imagesReplaced':False,'scopeActivated':False}))

if __name__=='__main__':
 try:main()
 except RuntimeError as error:print('RELEASE_BLOCKED: '+str(error));raise SystemExit(1)
