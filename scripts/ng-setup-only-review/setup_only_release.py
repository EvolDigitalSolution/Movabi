"""Shared exact setup-only rehearsal contracts. No secrets, connections or side effects."""
NAME='20261255000000_driver_collection_setup_only.sql'
PURPOSE='vaydu-driver-collection-setup-only-v1'
TABLES=('driver_collection_setup_markets','driver_collection_setup_accounts')

def ensure_no_legacy_setup(sql):
    # Optional compatibility inspection, not a dependency or import. An old uncertain
    # operation must never be bypassed merely by switching to the new store.
    if sql("SELECT to_regclass('public.driver_collection_subaccounts') IS NOT NULL")=='t':
        if sql("SELECT NOT EXISTS(SELECT 1 FROM public.driver_collection_subaccounts WHERE driver_id='318e6be9-9164-41fa-bb0c-c5ccd3526585')")!='t':
            raise RuntimeError('Existing legacy collection operation for selected driver; reconcile lineage before creating any new claim')

def load_release(directory):
    import hashlib,json
    from pathlib import Path
    directory=Path(directory)
    if directory.is_symlink():raise RuntimeError('Unsafe setup-only release directory')
    path=directory/'migration-manifest.json'
    if path.is_symlink():raise RuntimeError('Unsafe setup-only manifest')
    raw=path.read_bytes();manifest=json.loads(raw)
    if manifest.get('purpose')!=PURPOSE or [item.get('name') for item in manifest.get('files',[])]!=[NAME]:raise RuntimeError('Exact single setup-only release required')
    source=directory/NAME
    if source.is_symlink():raise RuntimeError('Unsafe setup-only source')
    body=source.read_bytes();digest=hashlib.sha256(body).hexdigest()
    if manifest['files'][0].get('sha256')!=digest:raise RuntimeError('Setup-only migration checksum mismatch')
    return {'body':body,'migrationSha256':digest,'manifestSha256':hashlib.sha256(raw).hexdigest()}

def require_real_proof(proof,manifest_sha):
    required=['restoreVerified','walletOwnershipAndACLVerified','setupOnlyCloneVerified','protectedAuthorityUnchanged','routingUnchanged',
              'bookingRowsUnchanged','outboxRowsUnchanged','selectedExistingDriverVerified','collectionGatesDisabledVerified']
    if proof.get('sourceKind')!='verified-develop' or proof.get('sourceContainer')!='movabi-develop-db' or proof.get('sourceDatabase')!='movabi_develop':raise RuntimeError('Real develop rehearsal required; synthetic fixture evidence is insufficient')
    if any(proof.get(name) is not True for name in required) or proof.get('migrationSetSha256')!=manifest_sha or proof.get('appliedSetupOnlyMigrations')!=[NAME]:raise RuntimeError('Exact setup-only rehearsal verification is incomplete or stale')

def load_real_proof(path,release):
    import hashlib,json,os,stat,time
    from pathlib import Path
    path=Path(path);root=Path.home()/'vaydu-develop-wallet-backups'
    if path.is_symlink() or path.resolve().parent.parent!=root.resolve():raise RuntimeError('Expected private develop backup verification manifest')
    info=path.stat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=os.getuid() or time.time()-info.st_mtime>7200:raise RuntimeError('Private current-user fresh rehearsal proof required (maximum two hours)')
    raw=path.read_bytes();proof=json.loads(raw);require_real_proof(proof,release['manifestSha256'])
    dump=path.parent/'movabi_develop.dump'
    if dump.is_symlink():raise RuntimeError('Unsafe backup archive')
    digest=hashlib.sha256()
    with dump.open('rb') as archive:
        for chunk in iter(lambda:archive.read(1024*1024),b''):digest.update(chunk)
    if proof.get('sha256')!=digest.hexdigest():raise RuntimeError('Rehearsed archive integrity mismatch')
    return proof,hashlib.sha256(raw).hexdigest()

# Compare before/after inside a restore. No raw definitions/route rows leave PostgreSQL.
# Exclude only the exact newly introduced setup objects, not broad naming patterns.
PROTECTED_SQL="""SELECT json_build_object(
 'functions',md5(coalesce((SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,
   pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl::text) ORDER BY p.oid::regprocedure::text)::text
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN('f','p')
   AND p.proname NOT IN('guard_driver_collection_setup_identity','claim_driver_collection_setup')),'[]')),
 'triggers',md5(coalesce((SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname)::text
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname NOT IN('driver_collection_setup_markets','driver_collection_setup_accounts')),'[]')),
 'columns',md5(coalesce((SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),
   a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum)::text
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
   LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
   WHERE n.nspname='public' AND c.relkind IN('r','p') AND a.attnum>0 AND NOT a.attisdropped
   AND c.relname NOT IN('driver_collection_setup_markets','driver_collection_setup_accounts')),'[]')),
 'constraints',md5(coalesce((SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname)::text
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   AND c.relname NOT IN('driver_collection_setup_markets','driver_collection_setup_accounts')),'[]')),
 'relations',md5(coalesce((SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner),c.relacl::text) ORDER BY c.relname)::text
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p')
   AND c.relname NOT IN('driver_collection_setup_markets','driver_collection_setup_accounts')),'[]')),
 'routes',md5((SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text FROM public.market_payment_routes r)),
 'bookingRows',md5((SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY id),'[]')::text FROM public.jobs j)),
 'outboxRows',md5((SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY job_id),'[]')::text FROM public.job_payout_queue q))
)"""

DISABLED_SQL="""SELECT
 (SELECT rolbypassrls FROM pg_roles WHERE rolname='service_role')
 AND (SELECT count(*)=1 FROM public.driver_collection_setup_markets)
 AND NOT EXISTS(SELECT 1 FROM public.driver_collection_setup_markets WHERE setup_approved OR adapter_ready OR
  merchant_identity_verified OR administrative_default_approved OR f4b_approved OR merchant_account_ref IS NOT NULL
  OR capability_evidence_ref IS NOT NULL OR default_split_type IS NOT NULL OR default_split_value IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM public.driver_collection_setup_accounts)
 AND NOT has_table_privilege('anon','public.driver_collection_setup_accounts','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated','public.driver_collection_setup_accounts','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('service_role','public.driver_collection_setup_accounts','INSERT,DELETE,TRUNCATE')
 AND has_table_privilege('service_role','public.driver_collection_setup_accounts','SELECT')
 AND NOT has_function_privilege('anon','public.claim_driver_collection_setup(uuid,uuid,text,text,text,text,text)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.claim_driver_collection_setup(uuid,uuid,text,text,text,text,text)','EXECUTE')
 AND has_function_privilege('service_role','public.claim_driver_collection_setup(uuid,uuid,text,text,text,text,text)','EXECUTE')
 AND (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN('public.driver_collection_setup_markets'::regclass,'public.driver_collection_setup_accounts'::regclass))
"""

DEPENDENCY_SQL="""SELECT json_build_object(
 'newNamesAbsent',to_regclass('public.driver_collection_setup_markets') IS NULL AND to_regclass('public.driver_collection_setup_accounts') IS NULL,
 'profiles',to_regclass('public.profiles') IS NOT NULL,
 'serviceRoleRlsBypass',coalesce((SELECT rolbypassrls FROM pg_roles WHERE rolname='service_role'),false),
 'markets',to_regclass('public.market_availability') IS NOT NULL,
 'routingBaseline',to_regclass('public.market_payment_routes') IS NOT NULL,
 'bookingBaseline',to_regclass('public.jobs') IS NOT NULL,
 'outboxBaseline',to_regclass('public.job_payout_queue') IS NOT NULL)
"""

# No approval, merchant or default is set, even in the clone. Every probe rolls
# back. Positive concurrent claims were tested separately on synthetic fixtures.
CLAIM_PROBES_SQL="""BEGIN;
SET LOCAL ROLE service_role;
DO $probe$ BEGIN
 BEGIN
  PERFORM * FROM public.claim_driver_collection_setup('318e6be9-9164-41fa-bb0c-c5ccd3526585',
   'd0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','rehearsal-disabled',repeat('a',64),repeat('b',64),'bank','6789');
  RAISE EXCEPTION 'Disabled setup claim unexpectedly accepted';
 EXCEPTION WHEN no_data_found THEN NULL; END;
 BEGIN
  PERFORM * FROM public.claim_driver_collection_setup('00000000-0000-0000-0000-000000000000',
   'd0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','rehearsal-disabled',repeat('a',64),repeat('b',64),'bank','6789');
  RAISE EXCEPTION 'Foreign owner claim unexpectedly accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'Approved setup owner/tenant/account type required' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM * FROM public.claim_driver_collection_setup('318e6be9-9164-41fa-bb0c-c5ccd3526585',
   '00000000-0000-0000-0000-000000000000','rehearsal-disabled',repeat('a',64),repeat('b',64),'bank','6789');
  RAISE EXCEPTION 'Foreign tenant claim unexpectedly accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'Approved setup owner/tenant/account type required' THEN RAISE; END IF;
 END;
END $probe$;
ROLLBACK;"""

CLAIM_UNIQUENESS_SQL="""SELECT EXISTS(SELECT 1 FROM pg_constraint
 WHERE conrelid='public.driver_collection_setup_accounts'::regclass AND contype='u'
 AND pg_get_constraintdef(oid)='UNIQUE (driver_id, tenant_id, country_code, currency_code, environment)')"""
