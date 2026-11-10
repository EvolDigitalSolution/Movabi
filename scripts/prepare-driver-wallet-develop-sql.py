"""Produce an atomic, disabled schema candidate; never connects to a database."""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
hashes = {
    'claim_wallet_topup_submission': '0ff1197e432107c69f2c591917a80cca',
    'confirm_wallet_topup': '099267ac21fcb291d218dd08717401b0',
    'initiate_wallet_topup': '24dd1a38a941359349950ebe245c735b',
    'post_wallet_event': '0fe33c2fbea877b181d637aa0bfe7f10',
    'record_wallet_topup_provider_reference': '340bd44df3bd557ab5b18eec619239a1',
    'wallet_collection_enabled': 'cb6d40cff166261a208753822fd3a50f',
    'wallet_currency_minor_exponent': 'bbd1b5c8d1a49c90a302f5efb6f6278e',
    'wallet_topup_attempt_freeze': 'de86b788446923a78d0ad5f74477a87a',
}
parts = ["""-- REVIEW CANDIDATE ONLY. No collection/route enablement or merchant approval.
-- Incorporate through the canonical incremental reconciliation workflow only
-- after a verified develop backup and restore test. Never run on production.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
LOCK TABLE public.wallet_topup_attempts,public.wallet_collection_config,public.market_payment_routes,public.payment_checkout_attempts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Wrong database'; END IF;
 IF public.wallet_collection_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Collection must remain disabled'; END IF;
 IF EXISTS(SELECT 1 FROM public.wallet_topup_attempts) THEN RAISE EXCEPTION 'Attempt baseline changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.market_payment_routes WHERE enabled OR merchant_approved OR adapter_ready OR payout_approved) THEN RAISE EXCEPTION 'Route approval baseline changed'; END IF;
 IF (SELECT count(*) FROM public.payment_checkout_attempts)<>2 THEN RAISE EXCEPTION 'Provider-store baseline changed'; END IF;
 IF to_regclass('public.wallet_topup_fee_policies') IS NOT NULL OR to_regclass('public.wallet_topup_fee_schedules') IS NOT NULL THEN RAISE EXCEPTION 'Fee schema baseline changed'; END IF;
END $$;
"""]
for name, digest in hashes.items():
    parts.append(f"DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='{name}' AND md5(pg_get_functiondef(p.oid))='{digest}')<>1 THEN RAISE EXCEPTION 'Function baseline changed: {name}'; END IF; END $$;\n")
files = [
    '20261253900000_flutterwave_market_provider_prerequisite.sql',
    '20261254000000_flutterwave_provider_batch2a.sql',
    '20261254100000_wallet_fee_freeze_batch2b.sql',
    '20261254200000_flutterwave_provider_accept_batch2c.sql',
    '20261254300000_wallet_atomic_confirm_batch2d.sql',
    '20261254400000_wallet_fee_policy_v2.sql',
    '20261254500000_driver_card_five_percent_policy.sql',
]
for filename in files:
    lines = (root / 'supabase' / 'migrations' / filename).read_text(encoding='utf8').splitlines()
    boundaries = [i for i, line in enumerate(lines) if line.strip() in ('BEGIN;', 'COMMIT;')]
    if len(boundaries) != 2 or lines[boundaries[0]].strip() != 'BEGIN;' or lines[boundaries[1]].strip() != 'COMMIT;':
        raise RuntimeError('Unexpected migration transaction layout: ' + filename)
    parts.append('\n-- Source: ' + filename + '\n' + '\n'.join(line for i, line in enumerate(lines) if i not in boundaries) + '\n')
parts.append("""
DO $$ BEGIN
 IF public.wallet_collection_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Collection unexpectedly enabled'; END IF;
 IF EXISTS(SELECT 1 FROM public.market_payment_routes WHERE enabled OR merchant_approved OR adapter_ready OR payout_approved) THEN RAISE EXCEPTION 'Approval unexpectedly enabled'; END IF;
 IF (SELECT count(*) FROM public.payment_checkout_attempts)<>2 THEN RAISE EXCEPTION 'Provider records changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.wallet_topup_fee_schedules) THEN RAISE EXCEPTION 'Unapproved fee schedule created'; END IF;
 IF public.driver_card_sandbox_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Driver sandbox unexpectedly enabled'; END IF;
END $$;
COMMIT;
""")
output = root / 'scripts' / 'driver-wallet-develop-disabled-candidate.sql'
output.write_text(''.join(parts), encoding='utf8')
print('Prepared disabled schema candidate: ' + str(output))

# Integrate only this managed section; preserve every pre-existing canonical byte.
import hashlib
candidate = output.read_text(encoding='utf8')
body = candidate[candidate.index('BEGIN;')+len('BEGIN;'):candidate.rindex('COMMIT;')]
source_hash = hashlib.sha256(candidate.encode()).hexdigest()
functions = list(hashes) + ['freeze_wallet_topup_fee','freeze_wallet_topup_fee_v1','freeze_wallet_topup_fee_v2','confirm_wallet_topup_with_total','record_driver_topup_provider_observation','wallet_fee_schedule_freeze','driver_card_scope_freeze','driver_card_attempt_scope_freeze','driver_card_sandbox_enabled','driver_card_sandbox_permit','driver_card_sandbox_attempt_permit']
tables = ['wallet_topup_attempts','payment_checkout_attempts','wallet_topup_fee_policies','wallet_topup_fee_schedules','driver_card_fee_policy_versions','driver_card_topup_sandbox_scopes','wallet_topup_provider_observations']
fn_names=','.join("'"+n+"'" for n in functions)
tb_names=','.join("'"+n+"'" for n in tables)
fingerprint=f"""SELECT md5(jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ({fn_names})),
 'columns',(SELECT jsonb_agg(jsonb_build_array(table_name,column_name,udt_name,is_nullable,column_default) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ({tb_names})),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,x.conname,pg_get_constraintdef(x.oid)) ORDER BY c.relname,x.conname) FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ({tb_names})),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relacl::text) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ({tb_names})),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public' AND c.relname IN ({tb_names}))
 )::text)"""
start='-- VAYDU_DRIVER_CARD_TOPUP_20261027_BEGIN'
end='-- VAYDU_DRIVER_CARD_TOPUP_20261027_END'
block=f"""{start}
-- Development-only additive card-top-up schema. No collection enablement.
BEGIN;
DO $driver_card_reconcile$
DECLARE applied record; observed_schema_fingerprint text;
BEGIN
 IF current_database()<>'movabi_develop' THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('vaydu-driver-card-schema',0));
 CREATE TABLE IF NOT EXISTS public.vaydu_driver_card_schema_releases(version text PRIMARY KEY,source_sha256 text NOT NULL,catalog_fingerprint text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
 REVOKE ALL ON public.vaydu_driver_card_schema_releases FROM PUBLIC,anon,authenticated,service_role;
 SELECT * INTO applied FROM public.vaydu_driver_card_schema_releases WHERE version='driver-card-topup-20261027-v1';
 IF FOUND THEN
  {fingerprint} INTO observed_schema_fingerprint;
  IF applied.source_sha256 IS DISTINCT FROM '{source_hash}' OR applied.catalog_fingerprint IS DISTINCT FROM observed_schema_fingerprint THEN
   RAISE EXCEPTION 'Driver card release drift; refuse automatic reconciliation';
  END IF;
  RETURN;
 END IF;
 EXECUTE $driver_card_sql${body}$driver_card_sql$;
 {fingerprint} INTO observed_schema_fingerprint;
 INSERT INTO public.vaydu_driver_card_schema_releases(version,source_sha256,catalog_fingerprint) VALUES('driver-card-topup-20261027-v1','{source_hash}',observed_schema_fingerprint);
 NOTIFY pgrst, 'reload schema';
END $driver_card_reconcile$;
COMMIT;
{end}
"""
canonical=root/'supabase_incremental_schema_reconcile.sql'
prior=canonical.read_bytes()
marker=start.encode()
if marker in prior:
 begin=prior.index(marker);finish=prior.index(end.encode(),begin)+len(end)
 updated=prior[:begin]+block.rstrip().encode()+prior[finish:]
else:
 updated=prior+b'\n'+block.encode()
canonical.write_bytes(updated)
release=root/'scripts'/'driver-card-develop-release';release.mkdir(exist_ok=True)
(release/'supabase_incremental_schema_reconcile.sql').write_text(block,encoding='utf8')
print('Integrated canonical section and extracted development-only release section')
