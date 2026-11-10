"""Setup-only driver payment-account operator for the Vaydu develop API.

Stages
------
status            read-only JSON report
preflight         fail-closed read-only checks (no writes)
rehearse          fresh backup -> disposable network-none PostgreSQL 15 restore
                  -> apply canonical SQL -> repeat/refusal -> preservation -> cleanup
build             derive an API image from the reviewed deployed baseline + closure
test-api          original-CMD cold smoke plus real Auth/PostgREST/Postgres HTTP tests
deploy-disabled   record the exact Compose chain + original image, recreate API only
activate          apply canonical SQL + setup-only environment (no transfers)
verify            hosted checks for the setup-only route
rollback          restore the recorded original image and environment

Safety: setup is separated from money movement. No transfer, payout dispatch,
wallet credit, collection, subaccount or split operation is performed here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path

DRIVER = "318e6be9-9164-41fa-bb0c-c5ccd3526585"
TENANT = "d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8"
STATE = Path.home() / ".local/state/vaydu-payment-account-operator"
ROOT = Path(__file__).resolve().parent.parent
SQL = ROOT / "sql" / "payment_account_setup_canonical.sql"
RELEASE = ROOT / "release.json"
MANIFEST = ROOT / "manifest.sha256"
API_DOCKERFILE = ROOT / "Dockerfile.api"
HOSTED = "https://movabi-develop.apps.evolsolution.com"
DB_CONTAINER = "movabi-develop-db"
DB_NAME = "movabi_develop"
POSTGRES_IMAGE = "postgres:15"
API_FILES={'api/mount.cjs','api/runtime.cjs','api/onboarding/router.js','api/onboarding/service.js',
           'api/services/payments/flutterwave-driver-payout.js','api/services/payments/flutterwave-wallet-collection.js','api/services/payments/payment-contracts.js'}


class Blocked(Exception):
    pass


def run(args, data=None, timeout=600):
    proc = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if proc.returncode:
        raise Blocked("command_failed:" + Path(args[0]).name)
    return proc.stdout.decode().strip()


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()


def load(path: Path, default=None):
    return json.loads(Path(path).read_text(encoding='utf-8-sig')) if Path(path).is_file() else default


def save(name: str, value: dict) -> None:
    STATE.mkdir(parents=True, mode=0o700, exist_ok=True)
    if STATE.is_symlink() or os.stat(STATE).st_uid != os.getuid() or os.stat(STATE).st_mode&0o077:
        raise Blocked("unsafe_operator_state")
    target = STATE / name
    if target.is_symlink():
        raise Blocked("unsafe_operator_state")
    temp = STATE / (name + ".tmp-" + uuid.uuid4().hex[:8])
    temp.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(temp, 0o600)
    os.replace(temp, target)


def load_release() -> dict:
    if not MANIFEST.is_file() or MANIFEST.is_symlink():
        raise Blocked("release_manifest_missing")
    names = set()
    for line in MANIFEST.read_text(encoding='utf-8-sig').splitlines():
        expected, name = line.split("  ", 1)
        if not re.fullmatch(r"[a-f0-9]{64}", expected) or name in names or Path(name).is_absolute() or '..' in Path(name).parts:
            raise Blocked("invalid_manifest_entry")
        names.add(name)
        path = ROOT / name
        if path.is_symlink() or not path.is_file() or digest(path) != expected:
            raise Blocked("release_checksum_mismatch:" + name)
    actual = {p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*') if p.is_file()
              and 'closure' not in p.relative_to(ROOT).parts and '__pycache__' not in p.parts
              and p != MANIFEST}
    if names != actual:
        raise Blocked("release_manifest_incomplete_or_extra_files")
    if {name for name in names if name.startswith('api/')}!=API_FILES:
        raise Blocked('exact_setup_only_dependency_closure_required')
    release = load(RELEASE, {})
    if release.get("purpose") != "vaydu-driver-payment-account-setup-v1":
        raise Blocked("wrong_release_purpose")
    if release.get("driver") != DRIVER or release.get("tenant") != TENANT:
        raise Blocked("wrong_release_scope")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", release.get("baselineApiImage", "")):
        raise Blocked("reviewed_baseline_image_required")
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", release.get("merchantRef", "")):
        raise Blocked("merchant_reference_required")
    if digest(SQL) != release.get("sqlSha256"):
        raise Blocked("canonical_sql_checksum_mismatch")
    return release


def release_fingerprint():
    return digest(MANIFEST)


def require_receipt(name, release, age=7200):
    receipt = load(STATE / name, {})
    if receipt.get('releaseFingerprint') != release_fingerprint() or time.time()-receipt.get('verifiedAt',0)>age:
        raise Blocked('fresh_matching_receipt_required:'+name)
    return receipt


def check_binding(release, path):
    """Read the existing private TEST file inside an isolated candidate process.

    Never copy its contents, expose values, export keys into the environment, or
    make a provider request. Alias matching is NOT merchant identity evidence.
    """
    if not path or not Path(path).is_absolute():raise Blocked('existing_private_setup_file_absolute_path_required')
    file=Path(path)
    if file.is_symlink() or not file.is_file():raise Blocked('existing_private_setup_file_unavailable')
    stat=file.stat()
    if stat.st_uid!=os.getuid() or stat.st_mode&0o077:raise Blocked('existing_private_setup_file_owner_or_permissions')
    built=require_receipt('built-image.json',release)
    script="try{const f=require('/app/server/payment-account-closure/runtime.cjs')({...process.env});f(process.env.VAYDU_PAYMENT_ACCOUNT_MERCHANT_REF);console.log(JSON.stringify({completed:true,testFormatConfirmed:true,internalAliasMatch:true,providerRequestsMade:false,merchantIdentityVerified:false}));}catch(e){console.log(JSON.stringify({completed:false,category:/^[a-z_]+$/.test(e.message)?e.message:'binding_unavailable'}));}"
    d=docker()
    args=d+['run','--rm','--network','none','--entrypoint','node','--mount','type=bind,src='+str(file)+',dst=/run/vaydu/payment-account-test.env,readonly']
    for key,value in {'VAYDU_DEPLOYMENT_ENV':'develop','VAYDU_PAYMENT_ACCOUNT_SETUP':'true','VAYDU_PAYMENT_ACCOUNT_SECRET_FILE':'/run/vaydu/payment-account-test.env','VAYDU_PAYMENT_ACCOUNT_MERCHANT_REF':release['merchantRef'],'VAYDU_DRIVER_PAYOUT_TRANSFERS':'false','VAYDU_DRIVER_SUBACCOUNT_SANDBOX':'false','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX':'false'}.items():args+=['-e',key+'='+value]
    report=json.loads(run(args+[built['image'],'-e',script]))
    if report.get('completed') is not True:raise Blocked('private_setup_binding:'+report.get('category','unavailable'))
    save('binding.json',{'file':str(file),'inode':stat.st_ino,'mtimeNs':stat.st_mtime_ns,'verifiedAt':time.time(),'releaseFingerprint':release_fingerprint(),**report})
    return report


def record_merchant_evidence(release,path):
    if not path or not Path(path).is_absolute():raise Blocked('private_dashboard_evidence_file_required')
    file=Path(path)
    if file.is_symlink() or not file.is_file() or file.stat().st_uid!=os.getuid() or file.stat().st_mode&0o077:
        raise Blocked('private_dashboard_evidence_file_permissions_required')
    evidence=load(file,{})
    template=load(ROOT/'merchant-evidence.template.json')
    if set(evidence)!=set(template):raise Blocked('exact_dashboard_evidence_fields_required_no_credentials')
    if evidence.get('schemaVersion')!=1 or evidence.get('evidenceKind')!='operator_dashboard_review' or evidence.get('providerEnvironment')!='test':
        raise Blocked('test_dashboard_review_required')
    for field in ('testBusinessViewed','testCredentialBindingConfirmed','ngnBankDestinationSetupApproved'):
        if evidence.get(field) is not True:raise Blocked('unresolved_dashboard_check:'+field)
    for field in ('merchantId','businessName'):
        value=evidence.get(field)
        if not isinstance(value,str) or not value.strip() or len(value)>160 or any(marker in value for marker in ('FLWSECK','sk_live_','sk_test_')):
            raise Blocked('nonsecret_dashboard_identity_field_required:'+field)
    if evidence['configuredReference']!=release['merchantRef'] or evidence['merchantId']==release['merchantRef']:
        raise Blocked('internal_alias_is_not_provider_merchant_identity')
    binding=require_receipt('binding.json',release)
    check_binding(release,binding['file'])
    save('merchant-evidence.json',{'operatorDashboardReviewed':True,'evidenceKind':'operator_dashboard_review',
        'dashboardEvidenceSha256':digest(file),'bindingInode':binding['inode'],'bindingMtimeNs':binding['mtimeNs'],
        'releaseFingerprint':release_fingerprint(),'verifiedAt':time.time()})
    return {'accepted':True,'evidenceKind':'operator_dashboard_review','providerIdentityApiCalled':False,'secretValuesPrinted':False}


def docker() -> list[str]:
    probe = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True)
    return ["docker"] if probe.returncode == 0 else ["sudo", "-n", "docker"]


def sql_read(statement: str) -> str:
    d = docker()
    proc = subprocess.run(
        d + ["exec", "-i", DB_CONTAINER, "psql", "-X", "-U", "postgres", "-d", DB_NAME, "-qAt",
             "-v", "ON_ERROR_STOP=1",
             "-c", "SET default_transaction_read_only=on; SET search_path=pg_catalog,public; " + statement],
        capture_output=True, timeout=120)
    if proc.returncode:
        raise Blocked("read_query_failed")
    return proc.stdout.decode().strip()


def sql_apply(statements: dict, script: Path | None = None) -> tuple[bool, str]:
    d = docker()
    args = d + ["exec", "-i", DB_CONTAINER, "psql", "-X", "-U", "postgres", "-d", DB_NAME, "-q",
                "-v", "ON_ERROR_STOP=1"]
    for key, value in statements.items():
        args += ["-v", f"{key}={value}"]
    if script is not None:
        payload = script.read_bytes()
        args += ["-f", "-"]
        proc = subprocess.run(args, input=payload, capture_output=True, timeout=180)
    else:
        proc = subprocess.run(args, input=b"", capture_output=True, timeout=180)
    return proc.returncode == 0, proc.stderr.decode(errors="replace")


def schema_state() -> dict:
    row = sql_read(
        "SELECT json_build_object("
        "'markets',to_regclass('public.driver_payout_markets') IS NOT NULL,"
        "'accounts',to_regclass('public.driver_payment_accounts') IS NOT NULL,"
        "'claim',to_regprocedure('public.claim_driver_payment_setup(uuid,uuid,text,text,text)') IS NOT NULL,"
        "'fence',to_regprocedure('public.fence_driver_payment_setup(uuid,uuid,text,text,text)') IS NOT NULL,"
        "'freeze',to_regprocedure('public.freeze_driver_payment_submission()') IS NOT NULL,"
        "'bindRecovery',to_regprocedure('public.bind_driver_payment_recovery(uuid,text,text)') IS NOT NULL,"
        "'identityGuard',to_regprocedure('public.guard_driver_payment_account_identity()') IS NOT NULL,"
        "'coreColumns',(SELECT count(*)=15 FROM information_schema.columns WHERE table_schema='public' AND table_name='driver_payment_accounts' AND column_name IN('id','driver_id','tenant_id','country_code','currency_code','provider','merchant_account_ref','state','beneficiary_id','bank_code','last4','fingerprint','setup_token','submission_attempted_at','updated_at')),"
        "'recoveryColumn',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='driver_payment_accounts' AND column_name='recovery_evidence_ref'))"
    )
    return json.loads(row)


def classify_schema(state: dict) -> str:
    parts = [state.get("markets"), state.get("accounts"), state.get("claim")]
    if parts == [False, False, False]:
        if any(state.get(k,False) for k in ('identityGuard','fence','freeze','bindRecovery','recoveryColumn')):return 'partial'
        return "absent"
    if parts == [True, True, True]:
        if state.get('coreColumns',True) is not True or state.get('identityGuard',True) is not True:return 'partial'
        recovery=[state.get(k,False) for k in ('fence','freeze','bindRecovery','recoveryColumn')]
        if any(recovery) and not all(recovery):return 'partial'
        return "complete"
    return "partial"


def preflight(release: dict, strict: bool = True) -> dict:
    d=docker()
    for name in ('movabi-develop-api',DB_CONTAINER):
        if run(d+['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',name])!='movabi-develop':
            raise Blocked('develop_compose_project_required')
    if run(d+['inspect','--format','{{.Image}}',DB_CONTAINER])!='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c':
        raise Blocked('reviewed_develop_database_image_changed')
    networks=json.loads(run(d+['inspect','--format','{{json .NetworkSettings.Networks}}',DB_CONTAINER]))
    if set(networks)!={'movabi-develop-private'}:raise Blocked('reviewed_develop_database_network_changed')
    if sql_read("SELECT current_database()") != DB_NAME:
        raise Blocked("wrong_database")
    if sql_read("SELECT count(*) FROM public.profiles WHERE id='%s' AND tenant_id='%s' AND role='driver' "
                "AND registration_activated_at IS NOT NULL "
                "AND coalesce(registration_country_code,country_code)='NG'" % (DRIVER, TENANT)) != "1":
        raise Blocked("approved_driver_scope_required")
    ng = sql_read("SELECT count(DISTINCT upper(supported_currency))||'|'||max(upper(supported_currency)) "
                  "FROM public.market_availability WHERE country_code='NG'")
    if ng != "1|NGN":
        raise Blocked("ng_currency_must_be_ngn")
    state = classify_schema(schema_state())
    if state == "partial":
        raise Blocked("partial_schema_requires_reconciliation")
    # Observe only named non-secret feature gates. Never inspect/dump the
    # container environment or credentials; unrelated Stripe queue work continues.
    flags=['VAYDU_DRIVER_PAYOUT_TRANSFERS','VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX']
    script='const names='+json.dumps(flags)+";console.log(names.some(n=>process.env[n]==='true')?'forbidden':'off');"
    if run(docker()+['exec','movabi-develop-api','node','-e',script])!='off':
        raise Blocked('existing_money_movement_gate_enabled_requires_review')
    enabled_markets = "0"
    if state != "absent":
        enabled_markets = sql_read("SELECT count(*) FROM public.driver_payout_markets WHERE enabled")
        if strict and enabled_markets != "0":
            raise Blocked("payout_market_already_enabled")
    for flag in ("VAYDU_DRIVER_PAYOUT_TRANSFERS", "VAYDU_DRIVER_SUBACCOUNT_SANDBOX", "VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX"):
        if os.environ.get(flag) == "true":
            raise Blocked("money_movement_flag_forbidden_during_onboarding:" + flag)
    return {
        "database": DB_NAME,
        "driver": DRIVER,
        "tenant": TENANT,
        "schemaState": state,
        "enabledPayoutMarkets": int(enabled_markets),
        "stripeQueueQuietRequired": False,
        "moneyMovementFlagsOff": True,
        "baselineApiImage": release["baselineApiImage"],
    }


def verify_db_identity(d):
    if run(d+['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',DB_CONTAINER])!='movabi-develop':raise Blocked('develop_database_project_required')
    if run(d+['inspect','--format','{{.Image}}',DB_CONTAINER])!='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c':raise Blocked('reviewed_develop_database_image_changed')
    if set(json.loads(run(d+['inspect','--format','{{json .NetworkSettings.Networks}}',DB_CONTAINER])))!={'movabi-develop-private'}:raise Blocked('reviewed_develop_database_network_changed')


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_http(port: int, path: str, timeout: float = 90.0) -> int:
    import http.client
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            conn.request("GET", path)
            last = conn.getresponse().status
            conn.close()
            if last:
                return last
        except OSError:
            last = None
        time.sleep(0.5)
    raise Blocked("api_not_ready")


def rehearse(release: dict) -> dict:
    d = docker()
    backups = Path.home() / "vaydu-develop-wallet-backups"
    backups.mkdir(parents=True, mode=0o700, exist_ok=True)
    dump = backups / ("rehearsal-" + uuid.uuid4().hex[:8] + ".dump")
    container = "vaydu-pa-rehearsal-" + uuid.uuid4().hex[:8]
    created=False
    try:
        with os.fdopen(os.open(dump,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),"wb") as handle:
            proc = subprocess.run(d + ["exec", DB_CONTAINER, "pg_dump", "-Fc", "-U", "postgres", DB_NAME],
                                  stdout=handle, stderr=subprocess.PIPE, timeout=900)
        if proc.returncode or dump.stat().st_size == 0:
            raise Blocked("fresh_backup_failed")
        os.chmod(dump, 0o600)
        db_image=run(d+['inspect','--format','{{.Image}}',DB_CONTAINER])
        if db_image!='sha256:632d750850d22dbc57c28380bed582538bd1a0b4c963fac50e2fa03e6c26542c':
            raise Blocked('reviewed_develop_database_image_changed')
        bootstrap='initdb -D /tmp/vaydu-restore -A trust --no-locale >/dev/null && exec postgres -D /tmp/vaydu-restore -c shared_preload_libraries=pg_net -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp'
        restore = subprocess.run(
            d + ["run", "-d", "--name", container, "--network", "none",'--user','postgres','--entrypoint','bash',db_image,'-c',bootstrap],
            capture_output=True, timeout=120)
        if restore.returncode:
            raise Blocked("rehearsal_container_start_failed")
        created=True
        _wait_pg(container, d)
        roles=json.loads(sql_read("SELECT coalesce(json_agg(json_build_object('name',rolname,'super',rolsuper,'inherit',rolinherit,'createrole',rolcreaterole,'createdb',rolcreatedb,'replication',rolreplication,'bypassrls',rolbypassrls)),'[]') FROM pg_roles WHERE rolname !~ '^pg_' AND rolname<>'postgres'"))
        for role in roles:
            literal="'"+role['name'].replace("'","''")+"'"
            identifier='"'+role['name'].replace('"','""')+'"'
            attributes=['NOLOGIN']+[(option if role[key] else 'NO'+option) for key,option in (('super','SUPERUSER'),('inherit','INHERIT'),('createrole','CREATEROLE'),('createdb','CREATEDB'),('replication','REPLICATION'),('bypassrls','BYPASSRLS'))]
            statement="DO $r$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname="+literal+") THEN EXECUTE format('CREATE ROLE %I NOLOGIN',"+literal+");END IF;END $r$;ALTER ROLE "+identifier+' '+' '.join(attributes)+';'
            run(d+['exec','-i',container,'psql','-h','127.0.0.1','-U','postgres','-d','postgres','-Xq','-v','ON_ERROR_STOP=1'],data=statement.encode())
        run(d+['exec',container,'createdb','-h','127.0.0.1','-U','postgres','-T','template0',DB_NAME])
        with dump.open("rb") as handle:
            proc = subprocess.run(d + ["exec", "-i", container, "pg_restore",'-h','127.0.0.1', "-U", "postgres", "-d", DB_NAME,
                                       "--exit-on-error"], stdin=handle,
                                 capture_output=True, timeout=900)
        if proc.returncode:
            raise Blocked('pg_restore_failed_no_rehearsal_receipt_written')
        before = _protected(d, container)
        args = ["exec", "-i", container, "psql",'-h','127.0.0.1', "-X", "-U", "postgres", "-d", DB_NAME, "-q",
                "-v", "ON_ERROR_STOP=1", "-v", "driver=" + DRIVER, "-v", "tenant=" + TENANT,
                "-v", "merchant=" + release["merchantRef"], "-v", "evidence=" + release["evidenceRef"]]
        state=run(d+args+['-At','-c',"SELECT to_regclass('public.driver_payment_accounts') IS NOT NULL"])
        if state=='f':
            first = subprocess.run(d + args + ["-f", "-"], input=SQL.read_bytes(), capture_output=True, timeout=180)
            if first.returncode:raise Blocked("canonical_apply_failed_in_rehearsal")
        recovery_present=run(d+args+['-At','-c',"SELECT to_regprocedure('public.fence_driver_payment_setup(uuid,uuid,text,text,text)') IS NOT NULL"])
        if recovery_present=='f':
            recovery = subprocess.run(d + args + ["-f", "-"], input=(SQL.parent/'payment_account_recovery_v2.sql').read_bytes(), capture_output=True, timeout=180)
            if recovery.returncode:raise Blocked('recovery_v2_apply_failed_in_rehearsal')
        second = subprocess.run(d + args + ["-f", "-"], input=SQL.read_bytes(), capture_output=True, timeout=180)
        if second.returncode == 0:
            raise Blocked("repeat_apply_must_refuse")
        assertions=subprocess.run(d+args+['-f','-'],input=(SQL.parent/'rehearsal_assert.sql').read_bytes(),capture_output=True,timeout=180)
        if assertions.returncode:raise Blocked('restored_clone_scope_claim_privilege_or_recovery_assertion_failed')
        after = _protected(d, container)
        if before != after:
            raise Blocked("protected_fingerprint_changed")
        proof = {
            "sourceKind": "verified-develop",
            "sourceContainer": DB_CONTAINER,
            "sourceDatabase": DB_NAME,
            "restoreVerified": True,
            "canonicalApplyVerified": True,
            "repeatApplyRefused": True,
            "protectedUnchanged": True,
            "scopeClaimsPermissionsRecoveryVerified": True,
            "sqlSha256": digest(SQL),
            "backupSha256": digest(dump),
            "verifiedAt": time.time(),
            "releaseFingerprint": release_fingerprint(),
        }
        save("rehearsal.json", proof)
        return proof
    finally:
        if created:subprocess.run(d + ["rm", "-f", container], capture_output=True, timeout=60)
        # Keep the original fresh backup privately on success AND failure.


def _wait_pg(container: str, d: list[str], timeout: float = 90.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        proc = subprocess.run(d + ["exec", container, "pg_isready",'-h','127.0.0.1', "-U", "postgres"], capture_output=True)
        if proc.returncode == 0:
            return
        time.sleep(0.5)
    raise Blocked("rehearsal_postgres_not_ready")


def _protected(d: list[str], container: str) -> str:
    """Hash protected function definitions, full rows, ACLs, owners and triggers."""
    def query(statement):
        return run(d+['exec','-i',container,'psql','-h','127.0.0.1','-XqAt','-U','postgres','-d',DB_NAME,'-v','ON_ERROR_STOP=1','-c',statement],timeout=180)
    excluded="'guard_driver_payment_account_identity','claim_driver_payment_setup','fence_driver_payment_setup','freeze_driver_payment_submission','bind_driver_payment_recovery'"
    parts=[query("SELECT md5(coalesce(jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) ORDER BY p.oid::regprocedure::text)::text,'[]')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND p.proname NOT IN("+excluded+")")]
    for name in ['market_payment_routes','jobs','bookings','job_payout_queue','driver_earnings','profiles']:
        if query("SELECT to_regclass('public."+name+"') IS NOT NULL")!='t':
            parts.append(name+':absent');continue
        parts.append(query("SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) FROM public."+name+" t"))
        parts.append(query("SELECT md5(jsonb_build_array(relowner::regrole::text,relacl::text,relrowsecurity,(SELECT jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal))::text) FROM pg_class c WHERE c.oid='public."+name+"'::regclass"))
    return hashlib.sha256('|'.join(parts).encode()).hexdigest()


def build(release: dict) -> dict:
    d = docker()
    tag = "vaydu-api:payment-account-setup-" + uuid.uuid4().hex[:8]
    actual = run(d + ['image','inspect','--format','{{.Id}}',release['baselineApiImage']])
    if actual != release['baselineApiImage']:
        raise Blocked('pinned_baseline_missing_or_changed')
    protected_image(d,actual)
    base_tag='vaydu-api:payment-account-reviewed-base-'+uuid.uuid4().hex[:8]
    run(d+['tag',actual,base_tag])
    proc = subprocess.run(
        d + ["build", "--progress=plain", "--network", "none", "--pull=false",
             "--build-arg", "BASELINE=" + base_tag,
             "--tag", tag, "--file", str(API_DOCKERFILE), str(ROOT)],
        capture_output=True, timeout=900)
    if proc.returncode:
        folder=STATE/('build-diagnostic-'+uuid.uuid4().hex[:12])
        folder.mkdir(parents=True,mode=0o700,exist_ok=False)
        for name,body in [('stdout.log',proc.stdout),('stderr.log',proc.stderr)]:
            target=folder/name;target.write_bytes(body);os.chmod(target,0o600)
        raise Blocked("api_image_build_failed_private_diagnostic:"+str(folder))
    image = run(d + ["image", "inspect", "--format", "{{.Id}}", tag])
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise Blocked("api_image_identity_invalid")
    protected_image(d,image,prepared=True)
    save("built-image.json", {"image": image, "baseline": release["baselineApiImage"], "verifiedAt": time.time(), 'releaseFingerprint':release_fingerprint()})
    return {"image": image, "baseline": release["baselineApiImage"]}


def protected_image(d, image, prepared=False):
    expected=load(ROOT/'reviewed-protected.json')
    if expected['baseApiImage']!=load(RELEASE)['baselineApiImage']:raise Blocked('protected_baseline_identity_mismatch')
    # Node reads only the eight reviewed source paths, returning hashes/absence.
    script="const fs=require('fs'),c=require('crypto');const files="+json.dumps(list(expected['protectedSourceHashes']))+";const absent="+json.dumps(expected['protectedAbsentPaths'])+";const result={};for(const p of files){result[p]=c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex');}for(const p of absent){result[p]=fs.existsSync('/app/'+p)?'unexpected_present':null;}console.log(JSON.stringify(result));"
    actual=json.loads(run(d+['run','--rm','--network','none','--entrypoint','node',image,'-e',script]))
    wanted={**expected['protectedSourceHashes'],**{p:None for p in expected['protectedAbsentPaths']}}
    if actual!=wanted:raise Blocked('protected_source_or_absence_changed')
    plan=load(ROOT/'integration-plan.json')
    paths=[f['path'] for f in plan['files']]
    script="const f=require('fs'),c=require('crypto');const out={};for(const p of "+json.dumps(paths)+"){out[p]=c.createHash('sha256').update(f.readFileSync('/app/'+p)).digest('hex');}console.log(JSON.stringify(out));"
    actual=json.loads(run(d+['run','--rm','--network','none','--entrypoint','node',image,'-e',script]))
    wanted={f['path']:f['afterSha256' if prepared else 'beforeSha256'] for f in plan['files']}
    if actual!=wanted:raise Blocked('reviewed_onboarding_integration_fingerprint_mismatch')


def test_api(release: dict, built: dict) -> dict:
    require_receipt('built-image.json', release)
    protected_image(docker(),built['image'],prepared=True)
    run(docker()+['run','--rm','--network','none','--entrypoint','node','-v',str(ROOT)+':/app/setup-review:ro',built['image'],'/app/setup-review/tests/baseline-patch.cjs'],timeout=120)
    cold=cold_smoke(built['image'])
    run([sys.executable,str(ROOT/'tests/test_operator.py')],timeout=120)
    result=subprocess.run([sys.executable,str(ROOT/'tests/run-integration.py'),'--image',built['image']],capture_output=True,timeout=900)
    records=[line for line in result.stdout.decode(errors='replace').splitlines() if line.startswith('{')]
    proof=json.loads(records[-1]) if records else {}
    if result.returncode:raise Blocked('packaged_api_http_failed:private_diagnostics='+str(proof.get('privateFixtureEvidence','unavailable')))
    if proof.get('completed') is not True or not all(proof.get(k) is True for k in ('realAuth','realPostgrest','realPostgres','packagedMount')):
        raise Blocked('packaged_api_integration_failed')
    proof.update(image=built['image'],verifiedAt=time.time(),releaseFingerprint=release_fingerprint())
    proof.update(cold)
    save('api-tested.json',proof)
    return proof


def cold_smoke(image):
    """Execute the image's original CMD, network-none, synthetic settings only."""
    d=docker();name='vaydu-setup-cold-'+uuid.uuid4().hex[:16];created=False
    try:
        args=d+['run','-d','--network','none','--name',name,
          '-e','PORT=3001','-e','SUPABASE_URL=http://movabi-develop-kong:8000',
          '-e','SUPABASE_SERVICE_ROLE_KEY=fixture-only-nonfunctional-service-key',
          '-e','STRIPE_SECRET_KEY=sk_test_fixture_only_nonfunctional',
          '-e','VAYDU_PAYMENT_ACCOUNT_SETUP=false','-e','VAYDU_DRIVER_PAYOUT_TRANSFERS=false',
          '-e','VAYDU_DRIVER_SUBACCOUNT_SANDBOX=false','-e','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX=false',image]
        run(args,timeout=120);created=True
        script="Promise.all(['/health','/api/driver-payment-account/status'].map(async p=>{const r=await fetch('http://127.0.0.1:3001'+p);return r.status})).then(s=>{process.exit(s[0]===200&&s[1]===401?0:1)}).catch(()=>process.exit(1))"
        for _ in range(50):
            check=subprocess.run(d+['exec',name,'node','-e',script],capture_output=True,timeout=5)
            if check.returncode==0:return {'actualEntryColdSmokePassed':True,'coldSmokeNetwork':'none','coldSmokeUsesSyntheticSettings':True}
            if run(d+['inspect','--format','{{.State.Running}}',name])!='true':break
            time.sleep(.4)
        save('cold-smoke-failure.json',{'image':image,'stage':'actual-entry-cold-smoke','verifiedAt':time.time()})
        folder=STATE/('cold-smoke-'+uuid.uuid4().hex[:12]);folder.mkdir(mode=0o700)
        logs=subprocess.run(d+['logs',name],capture_output=True,timeout=30)
        file=folder/'runtime.log';file.write_bytes(logs.stdout+logs.stderr);os.chmod(file,0o600)
        text=(logs.stdout+logs.stderr).decode(errors='replace')
        missing=re.search(r"Cannot find module ['\"]([A-Za-z0-9_./@-]+)['\"]",text)
        category='module_missing:'+missing.group(1) if missing else 'syntax_error' if 'SyntaxError:' in text else 'health_or_mount_not_ready'
        raise Blocked('actual_entry_cold_smoke_failed:'+category+':private_diagnostics='+str(folder))
    finally:
        if created:subprocess.run(d+['rm','-f',name],capture_output=True,timeout=60)

def target(d: list[str]) -> dict:
    records = {}
    for kind, name in (("api", "movabi-develop-api"), ("web", "movabi-develop-web")):
        def meta(fmt: str, container: str = name) -> str:
            return run(d + ["inspect", "--format", fmt, container])

        def label(key: str, container: str = name) -> str:
            return meta('{{index .Config.Labels "com.docker.compose.' + key + '"}}', container)

        if label("project") != "movabi-develop":
            raise Blocked("compose_project_changed")
        files = [f for f in label("project.config_files").split(",") if f]
        directory = label("project.working_dir")
        service = label("service")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", service) or not Path(directory).is_dir():
            raise Blocked("compose_chain_unavailable")
        if any(not Path(f).is_absolute() or not Path(f).is_file() for f in files):
            raise Blocked("compose_chain_unavailable")
        records[kind] = {
            "container": name,
            "image": meta("{{.Image}}"),
            "service": service,
            "directory": directory,
            "files": files,
            "fileHashes": {f: digest(Path(f)) for f in files},
        }
    if records["api"]["service"] == records["web"]["service"]:
        raise Blocked("api_web_service_collision")
    return records


def compose(d: list[str], record: dict, override: Path) -> None:
    for file, expected in record["fileHashes"].items():
        if digest(Path(file)) != expected:
            raise Blocked("compose_chain_changed")
    cmd = d + ["compose", "--project-name", "movabi-develop", "--project-directory", record["directory"]]
    for file in record["files"]:
        cmd += ["-f", file]
    run(cmd + ["-f", str(override), "up", "-d", "--no-deps", "--no-build", "--pull", "never",
               "--force-recreate", record["service"]])


def require_recorded_chain(record,current):
    actual=current.get('files',[])
    own={str(STATE/name) for name in ('api-disabled.override.json','api-setup.override.json','api-rollback.override.json')}
    if current.get('service')!=record['service'] or current.get('directory')!=record['directory']:
        raise Blocked('compose_identity_changed_since_staging')
    if actual!=record['files'] and not(actual[:-1]==record['files'] and actual[-1:] and actual[-1] in own):
        raise Blocked('compose_override_chain_changed_since_staging')


def override_payload(service: str, image: str, environment: dict | None = None) -> dict:
    payload: dict = {"services": {service: {"image": image}}}
    if environment:
        payload["services"][service]["environment"] = environment
    return payload


def deploy_disabled(release: dict, built: dict) -> dict:
    require_receipt('built-image.json',release)
    require_receipt('api-tested.json',release)
    require_receipt('rehearsal.json',release)
    # Baseline onboarding-source compatibility has to be reviewed before a
    # release may change mandatory requirement evaluation or the hosted UI.
    if release.get('onboardingIntegrationReviewed') is not True:
        raise Blocked('reviewed_baseline_onboarding_integration_required')
    d = docker()
    current = target(d)
    api = current["api"]
    if api['image'] != release['baselineApiImage']:
        raise Blocked('running_develop_baseline_changed')
    if (STATE/'baseline.json').exists():
        raise Blocked('existing_baseline_receipt_preserved_review_before_repeat_deployment')
    save("baseline.json", current)
    override = STATE / "api-disabled.override.json"
    save(override.name, override_payload(api["service"], built["image"],{'VAYDU_PAYMENT_ACCOUNT_SETUP':'false','VAYDU_DRIVER_PAYOUT_TRANSFERS':'false'}))
    # Persist rollback information BEFORE Compose can interrupt the API.
    save("deployed.json", {"image": built["image"], "originalImage": api["image"], "service": api["service"],
                           "record": api, "setupEnabled": False, "stageStartedAt": time.time(),
                           "releaseFingerprint":release_fingerprint()})
    compose(d, api, override)
    after = target(d)["api"]
    if after["image"] != built["image"]:
        raise Blocked("running_api_image_mismatch")
    if run(d + ["inspect", "--format", "{{.State.Status}}", after["container"]]) != "running":
        raise Blocked("api_not_running_after_deploy")
    for _ in range(40):
        probe=subprocess.run(d+['exec',after['container'],'node','-e',"fetch('http://127.0.0.1:3001/health').then(async r=>{const b=await r.json();process.exit(r.status===200&&b.status==='ok'?0:1)}).catch(()=>process.exit(1))"],capture_output=True,timeout=5)
        if probe.returncode==0:break
        time.sleep(.5)
    else:raise Blocked('api_health_failed_rollback_receipt_retained')
    save("deployed.json", {"image": built["image"], "originalImage": api["image"], "service": api["service"],
                           "record": api, "setupEnabled": False, "deployedAt": time.time()})
    return {"image": built["image"], "originalImage": api["image"], "service": api["service"], "setupEnabled": False}


def activate(release: dict) -> dict:
    require_receipt('api-tested.json',release)
    require_receipt('rehearsal.json',release)
    evidence=require_receipt('merchant-evidence.json',release)
    if evidence.get('operatorDashboardReviewed') is not True:
        raise Blocked('reviewed_test_setup_evidence_required')
    binding=require_receipt('binding.json',release)
    stat=Path(binding['file']).stat()
    if stat.st_ino!=binding['inode'] or stat.st_mtime_ns!=binding['mtimeNs'] or evidence['bindingInode']!=binding['inode'] or evidence['bindingMtimeNs']!=binding['mtimeNs']:
        raise Blocked('private_binding_changed_since_dashboard_review')
    check_binding(release,binding['file'])
    deployed = load(STATE / "deployed.json", {})
    if deployed.get("image") != load(STATE / "built-image.json", {}).get("image"):
        raise Blocked("deploy_disabled_required_first")
    d=docker();record=deployed['record'];require_recorded_chain(record,target(d)['api'])
    state = classify_schema(schema_state())
    if state == "partial":
        raise Blocked("partial_schema_requires_reconciliation")
    if state == "absent":
        raise Blocked("install_required_first")
    if sql_read("SELECT count(*) FROM public.driver_payout_markets WHERE enabled") == "0":
        activate_sql = SQL.parent / "payment_account_activate_verified.sql"
        if not activate_sql.is_file():
            raise Blocked("activation_sql_missing")
        ok, _ = sql_apply({"merchant": release["merchantRef"],'evidence':'operator-dashboard-sha256:'+evidence['dashboardEvidenceSha256']}, script=activate_sql)
        if not ok:
            raise Blocked("canonical_activation_failed")
    d = docker()
    record = deployed["record"]
    require_recorded_chain(record,target(d)['api'])
    environment = {
        # Setup-only. Transfers and dispatch stay explicitly off.
        "VAYDU_PAYMENT_ACCOUNT_SETUP": "true",
        "VAYDU_DEPLOYMENT_ENV":"develop",
        "VAYDU_PAYMENT_ACCOUNT_SECRET_FILE":"/run/vaydu/payment-account-test.env",
        "VAYDU_PAYMENT_ACCOUNT_MERCHANT_REF":release['merchantRef'],
        "VAYDU_DRIVER_PAYOUT_TRANSFERS": "false",
    }
    override = STATE / "api-setup.override.json"
    payload=override_payload(record['service'],deployed['image'],environment)
    payload['services'][record['service']]['volumes']=[{'type':'bind','source':binding['file'],'target':'/run/vaydu/payment-account-test.env','read_only':True}]
    save(override.name,payload)
    compose(d, record, override)
    after = target(d)["api"]
    if after["image"] != deployed["image"]:
        raise Blocked("running_api_image_mismatch")
    scope = sql_read("SELECT count(*)||'|'||bool_and(enabled) FROM public.driver_payout_markets "
                     "WHERE country_code='NG' AND currency_code='NGN' AND sandbox_driver_id='%s' AND sandbox_tenant_id='%s'"
                     % (DRIVER, TENANT))
    if scope != "1|true":
        raise Blocked("approved_scope_not_active")
    save("activated.json", {"image": deployed["image"], "scope": scope, "transfers": False, "activatedAt": time.time()})
    return {"image": deployed["image"], "scopeActive": True, "transfersEnabled": False, "schemaState": schema_state()}


def verify(release: dict) -> dict:
    import urllib.error
    import urllib.request

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None

    opener = urllib.request.build_opener(NoRedirect())
    checks = {}
    d=docker()
    deployed=load(STATE/'deployed.json',{})
    if not deployed.get('record'):raise Blocked('disabled_deployment_receipt_required')
    actual=target(d)
    require_recorded_chain(deployed['record'],actual['api'])
    if actual['api']['image']!=deployed['image']:raise Blocked('running_api_image_mismatch')
    baseline=load(STATE/'baseline.json',{})
    if actual['web']['image']!=baseline.get('web',{}).get('image'):raise Blocked('web_image_changed_during_api_only_release')
    flags="console.log(JSON.stringify({setupDisabled:process.env.VAYDU_PAYMENT_ACCOUNT_SETUP==='false',moneyMovementOff:['VAYDU_DRIVER_PAYOUT_TRANSFERS','VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX'].every(n=>process.env[n]!=='true')}))"
    gates=json.loads(run(d+['exec','movabi-develop-api','node','-e',flags]))
    if gates!={'setupDisabled':True,'moneyMovementOff':True}:raise Blocked('disabled_gate_verification_failed')
    protected_image(d,deployed['image'],prepared=True)
    for path, expected in (("/api/driver-payment-account/status", 401), ("/api/driver-onboarding/status", 401)):
        try:
            with opener.open(HOSTED + path, timeout=15) as response:
                checks[path] = response.status
        except urllib.error.HTTPError as error:
            checks[path] = error.code
        if checks[path] != expected:
            raise Blocked("unexpected_status:" + path)
    save("verified.json", {"checks": checks, "verifiedAt": time.time()})
    return {"checks": checks,'disabledGates':gates,'protectedSourcesUnchanged':True,'webUnchanged':True, "stripeQueueQuietRequired": False}


def rollback() -> dict:
    d = docker()
    deployed = load(STATE / "deployed.json", {})
    if not deployed.get("record") or not re.fullmatch(r"sha256:[a-f0-9]{64}", deployed.get("originalImage", "")):
        raise Blocked("rollback_receipt_missing")
    require_recorded_chain(deployed['record'],target(d)['api'])
    database_disabled=False
    try:
        verify_db_identity(d)
        if classify_schema(schema_state())=='complete':
            statement="UPDATE public.driver_payout_markets SET enabled=false WHERE country_code='NG' AND currency_code='NGN' AND sandbox_driver_id='%s' AND sandbox_tenant_id='%s';" % (DRIVER,TENANT)
            run(d+['exec','-i',DB_CONTAINER,'psql','-Xq','-U','postgres','-d',DB_NAME,'-v','ON_ERROR_STOP=1'],data=statement.encode())
            database_disabled=True
    except (Blocked, OSError):pass # Restore the original API even if DB is unavailable.
    override = STATE / "api-rollback.override.json"
    save(override.name, override_payload(deployed["record"]["service"], deployed["originalImage"]))
    compose(d, deployed["record"], override)
    if target(d)["api"]["image"] != deployed["originalImage"]:
        raise Blocked("rollback_image_mismatch")
    return {"restoredImage": deployed["originalImage"],'databaseSetupDisabled':database_disabled,'schemaAndHistoryRetained':True}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["status", "preflight", "install", "rehearse", "prepare-image", "build", "test-api",'check-binding','record-merchant-evidence',
                                          "deploy-disabled", "activate", "verify", "rollback"])
    parser.add_argument('--secret-file')
    parser.add_argument('--evidence-file')
    args = parser.parse_args()
    os.umask(0o077)
    release = load_release()
    if args.stage=='rollback':
        print(json.dumps({'stage':'rollback',**rollback()}));return 0
    if args.stage == "status":
        print(json.dumps({"stage": "status", "schemaState": classify_schema(schema_state()),
                          "driver": DRIVER, "tenant": TENANT, "baselineApiImage": release["baselineApiImage"]}))
        return 0
    report = preflight(release, strict=args.stage in ("preflight", "install", "rehearse", "build", "test-api", "deploy-disabled"))
    if args.stage == "preflight":
        print(json.dumps({"stage": "preflight", **report}))
        return 0
    if args.stage == "install":
        require_receipt('rehearsal.json',release)
        state = classify_schema(schema_state())
        if state == "partial":
            raise Blocked("partial_schema_requires_reconciliation")
        if state == "absent":
            ok, _ = sql_apply({"driver": DRIVER, "tenant": TENANT, "merchant": release["merchantRef"],
                               "evidence": release["evidenceRef"]}, script=SQL)
            if not ok:
                raise Blocked("canonical_install_failed")
        if sql_read("SELECT to_regprocedure('public.fence_driver_payment_setup(uuid,uuid,text,text,text)') IS NOT NULL")=='f':
            ok,_=sql_apply({},script=SQL.parent/'payment_account_recovery_v2.sql')
            if not ok:raise Blocked('additive_recovery_install_failed')
        scope = sql_read("SELECT count(*)||'|'||coalesce(bool_and(enabled)::text,'false') "
                         "FROM public.driver_payout_markets WHERE country_code='NG' AND currency_code='NGN'")
        print(json.dumps({"stage": "install", "schemaState": classify_schema(schema_state()),
                          "scope": scope, "enabled": scope.endswith("|true")}))
        return 0
    if args.stage == "rehearse":
        print(json.dumps({"stage": "rehearse", **rehearse(release)}))
        return 0
    if args.stage in ("build",'prepare-image'):
        print(json.dumps({"stage": "build", **build(release)}))
        return 0
    if args.stage == "test-api":
        built = load(STATE / "built-image.json", {})
        if not built.get("image"):
            raise Blocked("build_required_first")
        print(json.dumps({"stage": "test-api", **test_api(release, built)}))
        return 0
    if args.stage=='check-binding':
        print(json.dumps({'stage':'check-binding',**check_binding(release,args.secret_file)}));return 0
    if args.stage=='record-merchant-evidence':
        print(json.dumps({'stage':args.stage,**record_merchant_evidence(release,args.evidence_file)}));return 0
    if args.stage == "deploy-disabled":
        built = load(STATE / "built-image.json", {})
        if not built.get("image"):
            raise Blocked("build_required_first")
        print(json.dumps({"stage": "deploy-disabled", **deploy_disabled(release, built)}))
        return 0
    if args.stage == "activate":
        print(json.dumps({"stage": "activate", **activate(release)}))
        return 0
    if args.stage == "verify":
        print(json.dumps({"stage": "verify", **verify(release)}))
        return 0
    print(json.dumps({"stage": "rollback", **rollback()}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Blocked as error:
        print(json.dumps({"completed": False, "blocked": str(error), "rawOutputWithheld": True}))
        raise SystemExit(1)

