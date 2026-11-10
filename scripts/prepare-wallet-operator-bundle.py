"""Prepare the single operator bundle. No SSH, provisioning, activation or DB access."""
import hashlib,json,re,shutil,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
DEST=ROOT/'.temp'/'vaydu-wallet-operator-20261028'
VERSION='wallet-operator-20261028-v2'
def prepare_sql():
    old=(ROOT/'scripts/driver-card-develop-release/supabase_incremental_schema_reconcile.sql').read_text(encoding='utf-8')
    if hashlib.sha256((ROOT/'scripts/driver-card-develop-release/supabase_incremental_schema_reconcile.sql').read_bytes()).hexdigest()!='e464e94db05a0842519bcbc8081a0cdfcf56a8ced90ac6a766b4b340f1f7caa4':raise RuntimeError('Original reviewed card release changed')
    candidate=(ROOT/'scripts/driver-wallet-develop-disabled-candidate.sql').read_text(encoding='utf-8')
    body=candidate[candidate.index('BEGIN;')+6:candidate.rindex('COMMIT;')]
    source=(ROOT/'supabase/migrations/20261254000000_flutterwave_provider_batch2a.sql').read_text(encoding='utf-8')
    seed=source[source.index('INSERT INTO public.market_payment_routes'):source.index('-- 4. Privileges')].strip()
    if body.count(seed)!=1:raise RuntimeError('Reviewed route seed shape changed')
    body=body.replace(seed,'-- Wallet sandbox selection never inserts/updates a global collection route.')
    body,n=re.subn(r" IF EXISTS\(SELECT 1 FROM public.market_payment_routes WHERE enabled OR merchant_approved OR adapter_ready OR payout_approved\) THEN RAISE EXCEPTION '[^']+'; END IF;\n",'',body)
    if n!=2:raise RuntimeError('Reviewed route approval guard shape changed')
    delta=(ROOT/'supabase/migrations/20261255100000_driver_wallet_scope_routing.sql').read_text(encoding='utf-8')
    delta=delta[delta.index('BEGIN;')+6:delta.rindex('COMMIT;')]
    begin=old.index('  SELECT md5(jsonb_build_object(')
    end=old.index(' INTO observed_schema_fingerprint;',begin)
    fp=old[begin:end].strip()
    source_sha=hashlib.sha256((body+delta).encode()).hexdigest()
    route="SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) FROM public.market_payment_routes r"
    block=f"""-- VAYDU_WALLET_OPERATOR_20261028_BEGIN
-- Independent versioned canonical wallet section. No subaccount/payout migration.
BEGIN;
DO $operator$
DECLARE applied record; prior record; observed_schema_fingerprint text; routes_before text; routes_after text;
BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Develop database required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('vaydu-driver-card-schema',0));
 CREATE TABLE IF NOT EXISTS public.vaydu_driver_card_schema_releases(version text PRIMARY KEY,source_sha256 text NOT NULL,catalog_fingerprint text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
 REVOKE ALL ON public.vaydu_driver_card_schema_releases FROM PUBLIC,anon,authenticated,service_role;
 SELECT * INTO applied FROM public.vaydu_driver_card_schema_releases WHERE version='{VERSION}';
 IF FOUND THEN
  {fp} INTO observed_schema_fingerprint;
  IF applied.source_sha256 IS DISTINCT FROM '{source_sha}' OR applied.catalog_fingerprint IS DISTINCT FROM observed_schema_fingerprint THEN RAISE EXCEPTION 'Wallet operator release drift'; END IF;
  RETURN;
 END IF;
 LOCK TABLE public.market_payment_routes IN ACCESS EXCLUSIVE MODE;
 {route} INTO routes_before;
 SELECT * INTO prior FROM public.vaydu_driver_card_schema_releases WHERE version='driver-card-topup-20261027-v1';
 IF FOUND THEN
  {fp} INTO observed_schema_fingerprint;
  IF prior.source_sha256 IS DISTINCT FROM '746192dd0435bb34724819a1ef94de3b1011fba741c09dd2ba3e9ee6af1a9de8' OR prior.catalog_fingerprint IS DISTINCT FROM observed_schema_fingerprint THEN RAISE EXCEPTION 'Existing v1 card schema differs'; END IF;
 ELSE
  EXECUTE $fresh${body}$fresh$;
 END IF;
 EXECUTE $delta${delta}$delta$;
 {route} INTO routes_after;
 IF routes_before IS DISTINCT FROM routes_after THEN RAISE EXCEPTION 'Global collection routes changed'; END IF;
 IF public.wallet_collection_enabled() OR public.driver_card_sandbox_enabled() THEN RAISE EXCEPTION 'Collection must remain disabled'; END IF;
 {fp} INTO observed_schema_fingerprint;
 INSERT INTO public.vaydu_driver_card_schema_releases(version,source_sha256,catalog_fingerprint) VALUES('{VERSION}','{source_sha}',observed_schema_fingerprint);
 NOTIFY pgrst,'reload schema';
END $operator$;
COMMIT;
-- VAYDU_WALLET_OPERATOR_20261028_END
"""
    return block
def main():
    DEST.mkdir(parents=True,exist_ok=True)
    sql=prepare_sql();(DEST/'supabase_incremental_schema_reconcile.sql').write_text(sql,encoding='utf-8',newline='\n')
    # Integrate the managed canonical section while preserving unrelated bytes.
    canonical=ROOT/'supabase_incremental_schema_reconcile.sql';raw=canonical.read_bytes()
    for start,end in [(b'-- VAYDU_WALLET_OPERATOR_20261028_BEGIN',b'-- VAYDU_WALLET_OPERATOR_20261028_END'),(b'-- VAYDU_DRIVER_CARD_TOPUP_20261027_BEGIN',b'-- VAYDU_DRIVER_CARD_TOPUP_20261027_END')]:
        if start in raw:
            i=raw.index(start);j=raw.index(end,i)+len(end);raw=raw[:i]+sql.rstrip().encode()+raw[j:];break
    else:raw+=b'\n'+sql.encode()
    canonical.write_bytes(raw)
    for name in ['wallet_operator.py','verify-develop-wallet-backup.py','setup_only_release.py','wallet_canonical_contract.py']:
        shutil.copyfile(ROOT/'scripts'/name,DEST/name)
    evidence={'merchantIdentityVerified':False,'merchantAliasBindingConfirmed':False,'merchantId':'','providerAccountId':'','providerAccountBindingConfirmed':False,
      'testModeConfirmed':False,'ngnCardSupportConfirmed':False,'redirectUrlConfirmed':False,'webhookUrlConfirmed':False,'webhookSecretMatchesDashboard':False,
      'feePassingMerchantPays':False,'evidenceReference':''}
    (DEST/'dashboard-evidence.example.json').write_text(json.dumps(evidence,indent=2)+'\n',encoding='utf-8')
    def image(tag):return subprocess.run(['docker','image','inspect','--format','{{.Id}}',tag],capture_output=True,text=True,check=True).stdout.strip()
    manifest={'purpose':VERSION,'canonicalSqlSha256':hashlib.sha256(sql.encode()).hexdigest(),'apiImage':image('vaydu-api:wallet-operator-20261028'),'webImage':image('vaydu-web:wallet-operator-20261028'),
      'driver':'318e6be9-9164-41fa-bb0c-c5ccd3526585','tenant':'d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8','provider':'flutterwave','country':'NG','currency':'NGN','policy':'vaydu-driver-card-5pct-wallet-v1',
      'protectedSourceHashes':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['server/routes/connect.routes.ts','server/routes/payment.routes.ts','server/services/payments/stripe-payment-adapter.ts','server/services/payments/stripe-payment-bridge.ts','server/services/stripe.service.ts','server/routes/booking.routes.ts','server/services/job-payout.service.ts','server/services/payout-eligibility.service.ts']},
      'canonicalVersion':VERSION,'subaccountsRequired':False,'activationEnabled':False}
    (DEST/'release.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    for tag,file in [('vaydu-api:wallet-operator-20261028','api.tar'),('vaydu-web:wallet-operator-20261028','web.tar')]:
        subprocess.run(['docker','image','save','--output',str(DEST/file),tag],check=True)
    sums=[]
    for p in sorted(DEST.iterdir()):
        if not p.is_file() or p.name=='SHA256SUMS':continue
        h=hashlib.sha256()
        with p.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1048576),b''):h.update(chunk)
        sums.append(h.hexdigest()+'  '+p.name+'\n')
    (DEST/'SHA256SUMS').write_text(''.join(sums),encoding='utf-8',newline='\n')
    print(json.dumps({'bundle':str(DEST),'manifestSha256':hashlib.sha256((DEST/'SHA256SUMS').read_bytes()).hexdigest(),'canonicalSqlSha256':manifest['canonicalSqlSha256']}))
if __name__=='__main__':main()
