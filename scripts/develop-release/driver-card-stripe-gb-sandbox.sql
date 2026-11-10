-- VAYDU develop: GB/GBP Stripe driver-topup sandbox configuration.
-- ONE transaction, advisory-locked. Any abort rolls back EVERYTHING.
-- Postconditions assert real rows exist — zero-row success is impossible.
--
-- Required inputs (verified on the host BEFORE apply — never invented):
--   DRIVER_ID    = verified designated driver uuid
--   PROVIDER_ACCT= verified Stripe TEST account id bound for that driver
--                  (from driver_payment_accounts/provider records, acct_ format)
-- Apply:
--   docker exec -i movabi-develop-db psql -U postgres -d movabi_develop \
--     -v ON_ERROR_STOP=1 -v DRIVER_ID=<uuid> -v PROVIDER_ACCT=<acct_...> < this-file
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('vaydu-develop-stripe-gb-sandbox'));

-- ---- prereq: verified identity, role, tenant, activation, binding -----------
DO $$ DECLARE t uuid; BEGIN
  SELECT tenant_id INTO t FROM public.profiles
   WHERE id=:'DRIVER_ID'::uuid AND role='driver' AND registration_activated_at IS NOT NULL;
  IF t IS NULL THEN
    RAISE EXCEPTION 'PREREQ: designated driver % is not a verified activated driver', :'DRIVER_ID';
  END IF;
  IF :'PROVIDER_ACCT' IS NULL OR :'PROVIDER_ACCT' !~ '^acct_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'PREREQ: PROVIDER_ACCT must be a verified acct_* binding';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.driver_payment_accounts
      WHERE driver_id=:'DRIVER_ID'::uuid AND provider='stripe'
        AND provider_account_id=:'PROVIDER_ACCT')
   AND NOT EXISTS (SELECT 1 FROM public.driver_card_topup_sandbox_scopes
      WHERE driver_id=:'DRIVER_ID'::uuid AND provider='stripe'
        AND provider_account_id=:'PROVIDER_ACCT') THEN
    RAISE EXCEPTION 'PREREQ: % is not a persisted binding for driver %', :'PROVIDER_ACCT', :'DRIVER_ID';
  END IF;
END $$;

-- ---- conflict checks --------------------------------------------------------
DO $$ DECLARE v text := 'vaydu-driver-card-5pct-wallet-v1'; BEGIN
  IF EXISTS (SELECT 1 FROM public.market_payment_routes
      WHERE provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card'
        AND preferred AND merchant_account_ref IS DISTINCT FROM 'stripe-platform'
        AND merchant_account_ref IS NOT NULL) THEN
    RAISE EXCEPTION 'CONFLICT: preferred stripe/GB/GBP route bound to different merchant';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wallet_topup_fee_schedules
      WHERE active AND provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card'
        AND version <> v) THEN
    RAISE EXCEPTION 'CONFLICT: different ACTIVE fee schedule for stripe/GB/GBP/card';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wallet_topup_fee_schedules
      WHERE version=v AND provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card'
        AND (fee_basis<>'wallet' OR fee_basis_points<>500 OR fee_fixed_minor<>0
             OR fee_cap_minor IS NOT NULL OR rounding<>'half_up' OR exponent<>2)) THEN
    RAISE EXCEPTION 'CONFLICT: canonical fee version has unexpected terms';
  END IF;
  IF EXISTS (SELECT 1 FROM public.driver_card_topup_sandbox_scopes
      WHERE enabled AND provider='stripe' AND country_code='GB' AND currency_code='GBP'
        AND driver_id=:'DRIVER_ID'::uuid
        AND (merchant_account_ref IS DISTINCT FROM 'stripe-platform'
          OR provider_account_id IS DISTINCT FROM :'PROVIDER_ACCT'
          OR policy_version <> v OR fee_passing_mode <> 'merchant')) THEN
    RAISE EXCEPTION 'CONFLICT: enabled scope with different binding/policy for %', :'DRIVER_ID';
  END IF;
END $$;

-- ---- route readiness (create if absent; enable existing binding) ------------
INSERT INTO public.market_payment_routes
 (country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities)
SELECT 'GB','GBP','card','stripe','stripe-platform',true,true,true,true,
       ARRAY['authorise','capture','release','refund','retrieve','collect']
WHERE NOT EXISTS (SELECT 1 FROM public.market_payment_routes
  WHERE provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card' AND preferred);
UPDATE public.market_payment_routes
   SET enabled=true, merchant_approved=true, adapter_ready=true,
       capabilities=array(select unnest(capabilities) union select 'collect'::text)
 WHERE provider='stripe' AND country_code='GB' AND currency_code='GBP'
   AND merchant_account_ref='stripe-platform';

-- ---- global sandbox gate + amount bound --------------------------------------
INSERT INTO public.wallet_collection_config(key,value)
 VALUES('driver_card_sandbox_enabled','true'),('max_amount_minor_GBP','1000000')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;

-- ---- canonical fee schedule --------------------------------------------------
INSERT INTO public.wallet_topup_fee_schedules
 (version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active)
SELECT 'vaydu-driver-card-5pct-wallet-v1','stripe','GB','GBP','card',2,'wallet',500,0,'half_up',
       'develop-release-batch',now(),true
WHERE NOT EXISTS (SELECT 1 FROM public.wallet_topup_fee_schedules
  WHERE version='vaydu-driver-card-5pct-wallet-v1' AND provider='stripe'
    AND country_code='GB' AND currency_code='GBP' AND method='card');

-- ---- immutable designated scope (insert-only; tenant resolved from profile) --
INSERT INTO public.driver_card_topup_sandbox_scopes
 (provider,method,country_code,currency_code,merchant_account_ref,provider_account_id,
  tenant_id,driver_id,fee_passing_mode,reviewed_by,reviewed_at,evidence_reference,policy_version,enabled)
SELECT 'stripe','card','GB','GBP','stripe-platform',:'PROVIDER_ACCT',
 p.tenant_id,p.id,'merchant','develop-release-batch',now(),
 'designated GB/GBP synthetic sandbox scope','vaydu-driver-card-5pct-wallet-v1',true
FROM public.profiles p
WHERE p.id=:'DRIVER_ID'::uuid AND p.role='driver'
  AND NOT EXISTS (SELECT 1 FROM public.driver_card_topup_sandbox_scopes
    WHERE enabled AND provider='stripe' AND country_code='GB' AND currency_code='GBP'
      AND driver_id=:'DRIVER_ID'::uuid);

-- ---- postconditions: every required row must exist ---------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.market_payment_routes
      WHERE provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card'
        AND preferred AND enabled AND merchant_approved AND adapter_ready
        AND 'collect'=ANY(capabilities) AND merchant_account_ref='stripe-platform') THEN
    RAISE EXCEPTION 'POST: stripe/GB/GBP route not ready';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wallet_topup_fee_schedules
      WHERE active AND version='vaydu-driver-card-5pct-wallet-v1' AND provider='stripe'
        AND country_code='GB' AND currency_code='GBP' AND method='card') THEN
    RAISE EXCEPTION 'POST: canonical fee schedule missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.driver_card_topup_sandbox_scopes
      WHERE enabled AND provider='stripe' AND country_code='GB' AND currency_code='GBP'
        AND driver_id=:'DRIVER_ID'::uuid
        AND merchant_account_ref='stripe-platform'
        AND provider_account_id=:'PROVIDER_ACCT'
        AND policy_version='vaydu-driver-card-5pct-wallet-v1') THEN
    RAISE EXCEPTION 'POST: designated sandbox scope missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wallet_collection_config
      WHERE key='driver_card_sandbox_enabled' AND value='true') THEN
    RAISE EXCEPTION 'POST: sandbox gate off';
  END IF;
END $$;
COMMIT;
