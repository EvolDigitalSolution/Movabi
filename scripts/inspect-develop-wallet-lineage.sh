# Read-only catalog/flag/backup inventory for the VERIFIED develop database.
# Paste the complete file into the authenticated SSH session.
python3 - <<'PY'
import hashlib, json, pathlib, subprocess
from urllib.parse import urlsplit, unquote
def run(args):
    p=subprocess.run(args,capture_output=True,text=True,timeout=45)
    return p.returncode,p.stdout.strip()
def emit(k,v): print(k+': '+json.dumps(v,sort_keys=True),flush=True)
d=['docker']
if run(d+['info','--format','{{.ServerVersion}}'])[0]: d=['sudo','-n','docker']
def inspect(name):
    rc,out=run(d+['inspect',name])
    if rc: raise SystemExit('Required develop container unavailable')
    return json.loads(out)[0]
db=inspect('movabi-develop-db');rest=inspect('movabi-develop-rest')
if db['Image']!='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c' or set(db['NetworkSettings']['Networks'])!={'movabi-develop-private'}:
    raise SystemExit('Develop database identity changed')
env=dict(x.split('=',1) for x in rest['Config'].get('Env',[]) if '=' in x)
uri=urlsplit(env.get('PGRST_DB_URI',''))
if uri.hostname!='movabi-develop-db' or unquote(uri.path.lstrip('/'))!='movabi_develop':
    raise SystemExit('PostgREST target changed')
def sql(q):
    rc,out=run(d+['exec','-e','PGOPTIONS=-c default_transaction_read_only=on','movabi-develop-db','psql','-X','-U','postgres','-d','movabi_develop','-qAt','-v','ON_ERROR_STOP=1','-c',q])
    return out if rc==0 else 'READ_UNAVAILABLE'
emit('LINEAGE_DATABASE','movabi_develop')
emit('PUBLIC_HISTORY_COLUMNS',sql("SELECT column_name||':'||udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations' ORDER BY ordinal_position"))
emit('PUBLIC_HISTORY_IDENTITIES',sql("SELECT json_strip_nulls(json_build_object('version',to_jsonb(m)->>'version','name',to_jsonb(m)->>'name','migration',to_jsonb(m)->>'migration','id',to_jsonb(m)->>'id')) FROM public.schema_migrations m ORDER BY coalesce(to_jsonb(m)->>'version',to_jsonb(m)->>'id',to_jsonb(m)->>'name') DESC LIMIT 100"))
emit('WALLET_COLUMN_TYPES',sql("SELECT table_name||':'||column_name||':'||udt_name||':'||is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('wallet_topup_attempts','wallet_collection_config','payment_checkout_attempts','wallet_accounts','wallet_business_events','wallet_movements') ORDER BY table_name,ordinal_position"))
emit('WALLET_CONSTRAINTS',sql("SELECT c.relname||':'||con.conname||':'||pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('wallet_topup_attempts','payment_checkout_attempts','wallet_business_events','market_payment_routes') ORDER BY c.relname,con.conname"))
emit('WALLET_FUNCTION_IDENTITIES',sql("SELECT p.oid::regprocedure::text||':'||md5(pg_get_functiondef(p.oid))||':securityDefiner='||p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('wallet_collection_enabled','wallet_currency_minor_exponent','initiate_wallet_topup','claim_wallet_topup_submission','confirm_wallet_topup','post_wallet_event','record_wallet_topup_provider_reference','wallet_topup_attempt_freeze','driver_cash_credit_status_v1f') ORDER BY 1"))
emit('COLLECTION_FUNCTION_RESULT',sql('SELECT public.wallet_collection_enabled()'))
emit('CHECKOUT_STORE_COUNTS',sql('SELECT state||chr(58)||count(*) FROM public.payment_checkout_attempts GROUP BY state ORDER BY state'))
emit('ATTEMPT_COUNTS',sql('SELECT payment_provider||chr(58)||status||chr(58)||count(*) FROM public.wallet_topup_attempts GROUP BY payment_provider,status ORDER BY 1'))
emit('ROUTE_READINESS',sql("SELECT json_build_object('country',country_code,'currency',currency_code,'provider',provider,'method',method,'preferred',preferred,'enabled',enabled,'merchantApproved',merchant_approved,'adapterReady',adapter_ready,'payoutApproved',payout_approved,'merchantConfigured',coalesce(btrim(merchant_account_ref),'')<>'','capabilities',capabilities) FROM public.market_payment_routes ORDER BY country_code,currency_code,provider,method"))
emit('DATABASE_BYTES',sql("SELECT pg_database_size('movabi_develop')"))
emit('EXTENSIONS',sql('SELECT extname||chr(58)||extversion FROM pg_extension ORDER BY extname'))
emit('ROLE_NAMES',sql("SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname"))
for folder in ('/srv/movabi/develop/backups','/srv/movabi/develop/shared/backups','/srv/movabi/develop'):
    path=pathlib.Path(folder)
    if not path.is_dir(): continue
    try:
        files=sorted((p for p in path.iterdir() if p.is_file() and any(s in p.name.lower() for s in ('backup','dump','migration','reconcile'))),key=lambda p:p.stat().st_mtime,reverse=True)[:15]
        emit('DEVELOP_BACKUP_CANDIDATES',[{'path':str(p),'bytes':p.stat().st_size,'mtime':p.stat().st_mtime} for p in files])
    except (PermissionError,OSError): emit('BACKUP_DIRECTORY_UNREADABLE',folder)
emit('COMPLETE','Read-only lineage and backup inventory; no migration or enablement')
PY
