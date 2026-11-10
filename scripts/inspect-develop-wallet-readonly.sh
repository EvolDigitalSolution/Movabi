# Paste this complete file into the authenticated remote SSH shell.
# No files are written, no services are changed, no credential values are output.
python3 - <<'PY'
import json, pathlib, subprocess

def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=35)
    return result.returncode, result.stdout

def emit(label, value):
    print(label + ': ' + json.dumps(value, sort_keys=True), flush=True)

emit('AUDIT_MODE', 'read-only; credential values suppressed')
code, output = run(['docker', 'ps', '--format', '{{json .}}'])
docker = ['docker']
if code:
    docker = ['sudo', '-n', 'docker']
    code, output = run(docker + ['ps', '--format', '{{json .}}'])
if code:
    emit('BLOCKER', 'Docker metadata is unavailable without additional privileges; no password requested')
    raise SystemExit(1)
containers = [json.loads(line) for line in output.splitlines() if line.strip()]
emit('CONTAINERS', [{key: row.get(key) for key in ('Names', 'Image', 'Status')} for row in containers])
develop = [row for row in containers if 'develop' in row.get('Names', '').lower()]
if not develop:
    emit('BLOCKER', 'No container name explicitly identifies develop; target requires clarification')
for row in develop:
    name = row['Names']
    code, raw = run(docker + ['inspect', name])
    if code:
        emit('INSPECT_UNAVAILABLE', name)
        continue
    item = json.loads(raw)[0]
    config = item.get('Config', {})
    labels = config.get('Labels') or {}
    env = dict(entry.split('=', 1) for entry in config.get('Env', []) if '=' in entry)
    emit('DEVELOP_METADATA', {
        'name': name, 'imageId': item.get('Image'), 'created': item.get('Created'),
        'project': labels.get('com.docker.compose.project'),
        'service': labels.get('com.docker.compose.service'),
        'workingDir': labels.get('com.docker.compose.project.working_dir'),
        'composeFiles': labels.get('com.docker.compose.project.config_files'),
        'mounts': [{'source': m.get('Source'), 'destination': m.get('Destination'), 'rw': m.get('RW')} for m in item.get('Mounts', [])],
        'networks': sorted(item.get('NetworkSettings', {}).get('Networks', {})),
    })
    safe_flags = {}
    for key, value in env.items():
        if key == 'NODE_ENV':
            safe_flags[key] = value if value in ('development', 'production', 'test', 'develop') else 'other'
        elif any(word in key.upper() for word in ('ENABLED', 'SANDBOX', 'DRIVER_TOPUP_API', 'LIVE_COLLECTION', 'CASH_RIDE')):
            safe_flags[key] = value.lower() if value.lower() in ('true', 'false', '0', '1') else 'configured-nonboolean'
    emit('DEVELOP_FLAGS_' + name, safe_flags)
    emit('DEVELOP_PROVIDER_PREREQUISITES_' + name, {
        'flutterwaveSecret': 'test' if env.get('FLUTTERWAVE_SECRET_KEY', '').startswith('FLWSECK_TEST-') else ('non-test' if env.get('FLUTTERWAVE_SECRET_KEY') else 'missing'),
        'flutterwaveMerchantConfigured': bool(env.get('FLUTTERWAVE_MERCHANT_REF')),
        'flutterwaveWebhookConfigured': bool(env.get('FLUTTERWAVE_WEBHOOK_SECRET')),
        'callbackConfigured': bool(env.get('VAYDU_TOPUP_CALLBACK_URL')),
        'stripeKeyMode': 'test' if env.get('STRIPE_SECRET_KEY', '').startswith('sk_test_') else ('non-test' if env.get('STRIPE_SECRET_KEY') else 'missing'),
    })
    if 'postgres' not in row.get('Image', '').lower() and not any(word in name.lower() for word in ('-db', 'database')):
        continue
    def sql(query):
        code, text = run(docker + ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', name,
            'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query])
        return text.strip() if code == 0 else 'READ_UNAVAILABLE'
    emit('DEVELOP_DB_IDENTITY_' + name, sql('SELECT current_database() || chr(58) || current_user || chr(58) || current_setting(\'server_version\')'))
    emit('DEVELOP_SCHEMA_OBJECTS_' + name, sql("SELECT json_build_object('migrationHistory',to_regclass('supabase_migrations.schema_migrations'),'attempts',to_regclass('public.wallet_topup_attempts'),'oldPolicies',to_regclass('public.wallet_topup_fee_policies'),'newSchedules',to_regclass('public.wallet_topup_fee_schedules'),'providerStore',to_regclass('public.payment_checkout_attempts'),'atomicConfirm',to_regprocedure('public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text)'),'driverMarket',to_regprocedure('public.driver_cash_credit_status_v1f(uuid)'))"))
    if sql("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL") == 't':
        emit('DEVELOP_MIGRATION_VERSIONS_' + name, sql('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 35'))
    if sql("SELECT to_regclass('public.wallet_collection_config') IS NOT NULL") == 't':
        emit('DEVELOP_COLLECTION_GATE_' + name, sql("SELECT key || chr(58) || CASE WHEN value IN ('true','false','0','1') THEN value ELSE 'configured' END FROM public.wallet_collection_config WHERE key IN ('enabled','legacy_backfill_done')"))
    if sql("SELECT to_regclass('public.wallet_topup_attempts') IS NOT NULL") == 't':
        emit('DEVELOP_ATTEMPT_COUNTS_' + name, sql('SELECT payment_provider || chr(58) || status || chr(58) || count(*) FROM public.wallet_topup_attempts GROUP BY payment_provider,status ORDER BY 1'))

# Report backup locations and size/mtime only. Do not read database dumps/env files.
for root in (pathlib.Path('/srv'), pathlib.Path('/var/backups')):
    if not root.exists():
        continue
    try:
        candidates = list(root.glob('*backup*')) + list(root.glob('*/*backup*')) + list(root.glob('*/*/*backup*'))
        for directory in candidates[:25]:
            if not directory.is_dir():
                continue
            emit('BACKUP_DIRECTORY', str(directory))
            entries = sorted((p for p in directory.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)[:8]
            emit('BACKUP_FILE_METADATA', [{'path': str(p), 'bytes': p.stat().st_size, 'mtime': p.stat().st_mtime} for p in entries])
    except (PermissionError, OSError):
        emit('BACKUP_METADATA_UNAVAILABLE', str(root))
emit('AUDIT_COMPLETE', 'No backup verified or configuration changed; inventory only')
PY
