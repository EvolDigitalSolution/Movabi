# Paste this complete file into the existing SSH session. Read-only.
# Database names/hosts are reported; credentials and connection URLs are not.
python3 - <<'PY'
import json, subprocess
from urllib.parse import urlsplit, unquote

def run(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=35)
    return p.returncode, p.stdout.strip()
def emit(key,value):
    print(key+': '+json.dumps(value,sort_keys=True),flush=True)
docker=['docker']
if run(docker+['info','--format','{{.ServerVersion}}'])[0]:
    docker=['sudo','-n','docker']
def inspect(name):
    code,out=run(docker+['inspect',name])
    if code: raise SystemExit('Required develop container unavailable: '+name)
    return json.loads(out)[0]
api=inspect('movabi-develop-api')
rest=inspect('movabi-develop-rest')
db=inspect('movabi-develop-db')
for item in (api,rest):
    if (item['Config'].get('Labels') or {}).get('com.docker.compose.project')!='movabi-develop':
        raise SystemExit('Refusing ambiguous compose project')
expected='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c'
if db['Image']!=expected or set(db['NetworkSettings']['Networks'])!={'movabi-develop-private'}:
    raise SystemExit('Develop database identity changed; re-audit required')
def env(item):
    return dict(x.split('=',1) for x in item['Config'].get('Env',[]) if '=' in x)
api_env,rest_env=env(api),env(rest)
emit('DEVELOP_RUNTIME',{'apiImage':api['Image'],'nodeEnv':api_env.get('NODE_ENV'),'apiSwitch':api_env.get('VAYDU_DRIVER_TOPUP_API')=='true'})
for key in ('SUPABASE_URL','API_EXTERNAL_URL'):
    if api_env.get(key):
        u=urlsplit(api_env[key]);emit('API_ENDPOINT_'+key,{'scheme':u.scheme,'host':u.hostname,'port':u.port})
uri=rest_env.get('PGRST_DB_URI','')
u=urlsplit(uri)
if u.scheme not in ('postgres','postgresql') or not u.hostname or not u.path.strip('/'):
    raise SystemExit('PostgREST database target is missing or unsupported; no database guessed')
target=unquote(u.path.lstrip('/'))
emit('POSTGREST_TARGET',{'host':u.hostname,'port':u.port or 5432,'database':target})
net=db['NetworkSettings']['Networks']['movabi-develop-private']
allowed={'movabi-develop-db',net.get('IPAddress')}|set(net.get('Aliases') or [])|set(net.get('DNSNames') or [])
if u.hostname not in allowed:
    raise SystemExit('PostgREST host does not match verified develop database; stopping before SQL')
def sql(query,database=target):
    code,out=run(docker+['exec','-e','PGOPTIONS=-c default_transaction_read_only=on','movabi-develop-db','psql','-X','-U','postgres','-d',database,'-qAt','-v','ON_ERROR_STOP=1','-c',query])
    return out if code==0 else 'READ_UNAVAILABLE'
emit('DATABASE_NAMES',sql("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",'postgres'))
emit('TARGET_OBJECTS',sql("SELECT json_build_object('database',current_database(),'history',to_regclass('supabase_migrations.schema_migrations'),'walletTransactions',to_regclass('public.wallet_transactions'),'marketAvailability',to_regclass('public.market_availability'),'marketRoutes',to_regclass('public.market_payment_routes'),'accounts',to_regclass('public.wallet_accounts'),'events',to_regclass('public.wallet_business_events'),'movements',to_regclass('public.wallet_movements'),'attempts',to_regclass('public.wallet_topup_attempts'),'feeV1',to_regclass('public.wallet_topup_fee_policies'),'feeV2',to_regclass('public.wallet_topup_fee_schedules'),'providerStore',to_regclass('public.payment_checkout_attempts'),'confirmTotal',to_regprocedure('public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text)'),'driverMarket',to_regprocedure('public.driver_cash_credit_status_v1f(uuid)'))"))
emit('MIGRATION_TRACKING_TABLES',sql("SELECT schemaname || '.' || tablename FROM pg_tables WHERE tablename ILIKE '%migration%' ORDER BY 1"))
if sql("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL")=='t':
    emit('MIGRATION_VERSIONS',sql('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 40'))
if sql("SELECT to_regclass('public.wallet_collection_config') IS NOT NULL")=='t':
    emit('COLLECTION_GATE',sql("SELECT key || ':' || CASE WHEN value IN ('true','false','0','1') THEN value ELSE 'configured' END FROM public.wallet_collection_config WHERE key IN ('enabled','legacy_backfill_done')"))
if sql("SELECT to_regclass('public.market_payment_routes') IS NOT NULL")=='t':
    emit('ROUTE_COLUMN_TYPES',sql("SELECT column_name || ':' || udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='market_payment_routes' ORDER BY ordinal_position"))
emit('COMPLETE','Read-only target check; no migrations, enablement or backup writes')
PY
