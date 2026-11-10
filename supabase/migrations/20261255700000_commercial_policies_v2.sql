-- ============================================================================
-- APPROVED COMMERCIAL POLICIES V2 — market/currency configured, never GB-only.
-- Integer minor units + basis points. Missing config => policy inactive.
-- ============================================================================

-- A) Receivable payment-reference binding scoped to the canonical triple
--    (provider, merchant_account_ref, reference) — same scoping as
--    job_payment_bindings. A pi_* prefix identifies Stripe only; it does NOT
--    establish merchant/Connect/env binding, so uniqueness follows the triple.
ALTER TABLE customer_receivables
  ADD COLUMN IF NOT EXISTS payment_provider text CHECK (payment_provider IN ('stripe','flutterwave','paystack')),
  ADD COLUMN IF NOT EXISTS merchant_account_ref text;
-- Backfill provider/merchant ONLY from the authoritative canonical binding:
-- a job_payment_bindings row that unambiguously owns this reference. Rows
-- with zero or multiple binding candidates are left NULL and reported —
-- never guessed.
UPDATE customer_receivables r
   SET payment_provider = b.provider,
       merchant_account_ref = b.merchant_account_ref
  FROM job_payment_bindings b
 WHERE r.payment_reference IS NOT NULL
   AND r.payment_provider IS NULL
   AND b.payment_reference = r.payment_reference
   AND (SELECT count(*) FROM job_payment_bindings b2
         WHERE b2.payment_reference = r.payment_reference) = 1;
DO $$
DECLARE dup record; amb record;
BEGIN
  SELECT payment_reference, count(*) INTO dup
    FROM customer_receivables
    WHERE payment_reference IS NOT NULL
    GROUP BY payment_reference HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'customer_receivables has duplicate payment_reference % across % rows — reconcile manually', dup.payment_reference, dup.count;
  END IF;
  FOR amb IN SELECT id, payment_reference FROM customer_receivables
              WHERE payment_reference IS NOT NULL
                AND (payment_provider IS NULL OR merchant_account_ref IS NULL) LOOP
    RAISE NOTICE 'UNBOUND_RECEIVABLE id=% ref=% — no authoritative binding found; left NULL (report, not guess)', amb.id, amb.payment_reference;
  END LOOP;
END $$;
DROP INDEX IF EXISTS customer_receivables_payment_reference_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS customer_receivables_ref_binding_uniq
  ON customer_receivables (
    coalesce(payment_provider,''),
    coalesce(merchant_account_ref,''),
    payment_reference)
  WHERE payment_reference IS NOT NULL;
-- Trigger (not a CHECK): enforces binding only when the reference/binding
-- columns are being written — a 'paid' resolution must carry the triple.
-- Unrelated updates on legacy unbound rows (dispute, audit fields) stay
-- writable: recovery access is preserved.
ALTER TABLE customer_receivables DROP CONSTRAINT IF EXISTS receivable_reference_binding;
CREATE OR REPLACE FUNCTION enforce_receivable_reference_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_reference IS NULL THEN RETURN NEW; END IF;
  -- On UPDATE, allow touching an existing reference's row only when the
  -- binding columns themselves are not being changed (handled below via
  -- NEW carrying a complete triple) — the check is on the NEW row state,
  -- but only fires when the binding columns changed OR a reference is set.
  IF TG_OP='INSERT'
     OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
     OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
     OR NEW.merchant_account_ref IS DISTINCT FROM OLD.merchant_account_ref THEN
    IF NEW.payment_provider IS NULL OR NEW.merchant_account_ref IS NULL THEN
      RAISE EXCEPTION 'A payment reference requires provider + merchant binding' USING ERRCODE='RBD01';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS receivable_reference_binding ON customer_receivables;
CREATE TRIGGER receivable_reference_binding BEFORE INSERT OR UPDATE OF
  payment_reference, payment_provider, merchant_account_ref
  ON customer_receivables FOR EACH ROW EXECUTE FUNCTION enforce_receivable_reference_binding();

-- B) Referral policy: % rewards, monthly caps, expiry, review release.
ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS referral_kind text NOT NULL DEFAULT 'customer'
    CHECK (referral_kind IN ('customer','driver')),
  ADD COLUMN IF NOT EXISTS reward_rate_bps int CHECK (reward_rate_bps BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS reward_cap_minor bigint CHECK (reward_cap_minor >= 0),
  ADD COLUMN IF NOT EXISTS qualifying_fare_minor bigint,
  ADD COLUMN IF NOT EXISTS qualifying_jobs_required int DEFAULT 1,
  ADD COLUMN IF NOT EXISTS qualifying_window_days int,
  ADD COLUMN IF NOT EXISTS review_days int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qualified_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_at timestamptz,
  ADD COLUMN IF NOT EXISTS credit_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

-- Per-job progress for driver referrals (cumulative fares across qualifying
-- jobs inside the activation window).
CREATE TABLE IF NOT EXISTS referral_driver_progress (
  referral_id uuid NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  job_id uuid PRIMARY KEY,
  fare_minor bigint NOT NULL CHECK (fare_minor >= 0),
  completed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE referral_driver_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON referral_driver_progress FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON referral_driver_progress TO service_role;

-- Non-withdrawable booking credit granted by referral rewards.
CREATE TABLE IF NOT EXISTS reward_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  source text NOT NULL CHECK (source IN ('customer_referral','driver_referral','campaign')),
  source_id uuid NOT NULL,
  withdrawable boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','reversed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz
);
ALTER TABLE reward_credits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reward_credits FROM PUBLIC,anon,authenticated;
GRANT SELECT ON reward_credits TO authenticated;
GRANT SELECT,INSERT,UPDATE ON reward_credits TO service_role;

-- Monthly-cap helper: count earned/released rewards for a referrer this month.
CREATE OR REPLACE FUNCTION referral_monthly_count(p_referrer uuid, p_kind text)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT count(*)::int FROM referrals
   WHERE referrer_id=p_referrer AND referral_kind=p_kind
     AND status IN ('earned','released')
     AND resolved_at >= date_trunc('month', now());
$$;

-- C) Cash early-stop review: disputed amounts held for operator review.
ALTER TABLE driver_cash_credit_holds_v1e
  ADD COLUMN IF NOT EXISTS review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disputed_minor bigint CHECK (disputed_minor >= 0),
  ADD COLUMN IF NOT EXISTS review_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalated boolean NOT NULL DEFAULT false;

-- Flag a hold for operator review (service_role only). The hold stays 'held';
-- review_due_at targets 24h; escalated is a flag, never a state change —
-- NOTHING auto-releases when the deadline passes.
CREATE OR REPLACE FUNCTION flag_cash_hold_review_v1f(p_job uuid, p_disputed_minor bigint)
RETURNS driver_cash_credit_holds_v1e LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h driver_cash_credit_holds_v1e;
BEGIN
  IF NOT public.cash_credit_service_writer_v1e() THEN
    RAISE EXCEPTION 'Cash review requires the server role' USING ERRCODE='CE002';
  END IF;
  UPDATE driver_cash_credit_holds_v1e
     SET review_required=true,
         disputed_minor=p_disputed_minor,
         review_due_at=now()+interval '24 hours'
   WHERE job_id=p_job AND status='held'
   RETURNING * INTO h;
  IF NOT FOUND THEN RAISE EXCEPTION 'No held cash credit for this job' USING ERRCODE='CE006'; END IF;
  RETURN h;
END $$;

-- D) Holds become reusable per job: released history preserved, exactly one
--    ACTIVE hold per job. Reassignment = release old + reserve new atomically.
ALTER TABLE driver_cash_credit_holds_v1e DROP CONSTRAINT IF EXISTS driver_cash_credit_holds_v1e_job_id_key;
DROP INDEX IF EXISTS driver_cash_credit_holds_v1e_job_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS holds_one_active_per_job
  ON driver_cash_credit_holds_v1e(job_id) WHERE status='held';

-- E) Trigger: active holds only protect terms; released rows don't block
--    reassignment; review-flagged holds never auto-settle.
CREATE OR REPLACE FUNCTION public.enforce_ride_cash_credit_v1e() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h public.driver_cash_credit_holds_v1e%ROWTYPE; driver uuid; slug text;
BEGIN
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e
  WHERE job_id=NEW.id AND status IN ('held','settled') ORDER BY created_at DESC LIMIT 1;
 IF FOUND THEN
  IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash transitions require the server role' USING ERRCODE='CE002'; END IF;
  IF NEW.status IS NULL THEN RAISE EXCEPTION 'Cash booking status missing' USING ERRCODE='CE006'; END IF;
  IF NEW.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN
   IF h.status='settled' THEN RAISE EXCEPTION 'Settled cash ride requires refund review' USING ERRCODE='CE005'; END IF;
   IF h.status='held' AND NOT h.review_required THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'released'); END IF;
   RETURN NEW;
  END IF;
  IF NEW.driver_id IS NOT NULL AND NEW.accepted_driver_id IS NOT NULL AND NEW.driver_id<>NEW.accepted_driver_id THEN RAISE EXCEPTION 'Conflicting accepted drivers' USING ERRCODE='CE005'; END IF;
  IF NEW.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR NEW.payment_intent_id IS NOT NULL THEN RAISE EXCEPTION 'Cash custody/payment mode changed' USING ERRCODE='CE005'; END IF;
  IF NEW.payment_method IS DISTINCT FROM 'cash' OR NEW.fare_breakdown IS DISTINCT FROM h.fare_snapshot
     OR NEW.tenant_id IS DISTINCT FROM h.tenant_id OR NEW.currency_code IS DISTINCT FROM h.currency_code
     OR NEW.country_code IS DISTINCT FROM h.country_code OR coalesce(NEW.driver_id,NEW.accepted_driver_id) IS DISTINCT FROM h.driver_id THEN
   RAISE EXCEPTION 'Cash reservation requires explicit reconciliation before changing terms' USING ERRCODE='CE005'; END IF;
  IF NEW.status IN ('completed','delivered','settled') AND h.status='held' AND NOT h.review_required THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'settled'); END IF;
  RETURN NEW;
 END IF;
 IF NEW.payment_method IS DISTINCT FROM 'cash' THEN RETURN NEW; END IF;
 IF NOT public.driver_cash_credit_enabled_v1e() THEN
  driver:=coalesce(NEW.driver_id,NEW.accepted_driver_id);
  IF driver IS NOT NULL AND coalesce(OLD.driver_id,OLD.accepted_driver_id) IS NULL
     AND NEW.status IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
   RAISE EXCEPTION 'Cash credit pilot disabled' USING ERRCODE='CE001';
  END IF;
  RETURN NEW;
 END IF;
 SELECT st.slug INTO slug FROM public.service_types st WHERE st.id=NEW.service_type_id;
 IF slug IS DISTINCT FROM 'ride' THEN RETURN NEW; END IF;
 IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash acceptance requires the server role' USING ERRCODE='CE002'; END IF;
 driver:=coalesce(NEW.driver_id,NEW.accepted_driver_id);
 IF driver IS NOT NULL AND NEW.status IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
  PERFORM public.reserve_cash_job_credit_v1e(NEW.id,driver);
 END IF;
 RETURN NEW;
END $$;

-- F) Atomic cash reassignment: release old hold, transfer assignment, reserve
--    replacement credit — all one transaction. Failure preserves the original.
CREATE OR REPLACE FUNCTION public.reassign_cash_job_credit_v1f(p_job uuid, p_new_driver uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.jobs%ROWTYPE; h public.driver_cash_credit_holds_v1e%ROWTYPE;
        reserved numeric; v_event uuid;
BEGIN
 IF NOT public.cash_credit_service_writer_v1e() THEN
  RAISE EXCEPTION 'Cash reassignment requires the server role' USING ERRCODE='CE002';
 END IF;
 SELECT * INTO j FROM public.jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE='CE002'; END IF;
 IF j.payment_method IS DISTINCT FROM 'cash' THEN RAISE EXCEPTION 'Not a cash job' USING ERRCODE='CE002'; END IF;
 IF j.status NOT IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived') THEN
  RAISE EXCEPTION 'Cash reassignment only before service starts' USING ERRCODE='CE006';
 END IF;
 IF j.metadata->>'cash_collected_at' IS NOT NULL THEN
  RAISE EXCEPTION 'Cash already collected - reassignment not allowed' USING ERRCODE='CE005';
 END IF;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job AND status='held' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'No held cash credit to reassign' USING ERRCODE='CE006'; END IF;
 -- Release path mirrors resolve_'released': serialise on the old driver's
 -- credit lock, verify reserved-ledger consistency, post the reversal.
 PERFORM public.driver_cash_credit_lock_v1e(h.tenant_id,h.driver_id,h.currency_code);
 SELECT coalesce(sum(m.amount_minor::numeric),0) INTO reserved
   FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id
  WHERE a.tenant_id=h.tenant_id AND a.owner_id=h.driver_id AND a.currency_code=h.currency_code
    AND a.balance_purpose='driver_cash_credit_reserved';
 IF reserved < h.required_credit_minor THEN
  RAISE EXCEPTION 'Cash reserved ledger requires reconciliation' USING ERRCODE='CE006';
 END IF;
 IF h.required_credit_minor>0 THEN
  v_event:=public.post_wallet_reversal('cash-hold:'||h.id::text,'cash-hold:'||h.id::text||':release');
 END IF;
 UPDATE public.driver_cash_credit_holds_v1e SET status='released',resolution_event_id=v_event,resolved_at=now() WHERE id=h.id;
 -- Transfer assignment: the trigger reserves for the replacement driver. If
 -- reserve fails (insufficient credit, market mismatch, unenrolled) the whole
 -- transaction rolls back — original hold returns to 'held', driver unchanged.
 UPDATE public.jobs SET driver_id=p_new_driver, accepted_driver_id=p_new_driver WHERE id=p_job;
 RETURN (SELECT id FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job AND status='held');
END $$;

-- G) Debt threshold: configured market reference minimum fare + bps,
--    computed and PERSISTED at policy publish (versioned).
ALTER TABLE cancellation_policies
  ADD COLUMN IF NOT EXISTS reference_fare_minor bigint CHECK (reference_fare_minor >= 0),
  ADD COLUMN IF NOT EXISTS debt_threshold_bps int CHECK (debt_threshold_bps BETWEEN 0 AND 10000);
CREATE OR REPLACE FUNCTION publish_cancellation_policy(
  p_tenant uuid, p_market text, p_reference_fare_minor bigint, p_debt_threshold_bps int,
  p_grace_seconds int, p_fee_minor bigint, p_fee_cap_minor bigint,
  p_compensation_percent numeric, p_created_by uuid)
RETURNS cancellation_policies LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v cancellation_policies;
BEGIN
  INSERT INTO cancellation_policies(
    tenant_id, market_code, version, enabled,
    grace_seconds, fee_minor, fee_cap_minor,
    driver_compensation_percent, compensation_funding,
    reference_fare_minor, debt_threshold_bps, debt_threshold_minor,
    created_by)
  VALUES(
    p_tenant, p_market,
    (SELECT coalesce(max(version),0)+1 FROM cancellation_policies WHERE tenant_id=p_tenant AND market_code=p_market),
    false,
    p_grace_seconds, p_fee_minor, p_fee_cap_minor,
    p_compensation_percent, 'on_collection',
    p_reference_fare_minor, p_debt_threshold_bps,
    (p_reference_fare_minor * p_debt_threshold_bps / 10000)::bigint,
    p_created_by)
  RETURNING * INTO v;
  RETURN v;
END $$;

-- H) Evolved earn_referral: % rewards, monthly caps, expiry, driver review.
CREATE OR REPLACE FUNCTION earn_referral(p_referral uuid, p_job uuid)
RETURNS referrals LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r referrals; j jobs; c campaigns;
        v_fare bigint; v_reward bigint; v_max int; v_progress int;
BEGIN
  SELECT * INTO r FROM referrals WHERE id=p_referral FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'referral_missing'; END IF;
  IF r.status IN ('released','reversed','rejected') THEN RETURN r; END IF;
  IF r.status='earned' AND r.referral_kind='customer' THEN RETURN r; END IF;
  SELECT * INTO j FROM jobs WHERE id=p_job;
  IF NOT FOUND OR j.status NOT IN ('completed','settled','delivered')
     OR coalesce(j.payment_status,'') NOT IN ('paid','succeeded','refunded','cash_due','cash_pending') THEN
    RAISE EXCEPTION 'qualifying_activity_incomplete';
  END IF;
  SELECT * INTO c FROM campaigns WHERE id=r.campaign_id;
  IF NOT FOUND OR NOT c.enabled THEN RAISE EXCEPTION 'campaign_inactive'; END IF;
  v_fare := coalesce(j.agreed_fare, j.total_price, j.price, 0)::bigint;

  IF r.referral_kind='customer' THEN
    v_reward := (v_fare * coalesce(r.reward_rate_bps,500) / 10000)::bigint;
    IF r.reward_cap_minor IS NOT NULL THEN v_reward := least(v_reward, r.reward_cap_minor); END IF;
    IF r.qualifying_fare_minor IS NOT NULL AND v_fare < r.qualifying_fare_minor THEN
      RAISE EXCEPTION 'qualifying_fare_below_minimum';
    END IF;
    v_max := coalesce((c.qualification->>'max_rewards_per_month')::int, 5);
    IF referral_monthly_count(r.referrer_id,'customer') >= v_max THEN
      RAISE EXCEPTION 'monthly_cap_reached';
    END IF;
    IF c.budget_minor>0 AND NOT campaign_spend(c.id, v_reward) THEN
      RAISE EXCEPTION 'campaign_budget_exhausted';
    END IF;
    UPDATE referrals SET status='earned', qualifying_job_id=p_job,
      qualifying_fare_minor=v_fare, reward_minor=v_reward,
      qualified_at=now(), resolved_at=now(),
      credit_expires_at=now()+interval '90 days'
     WHERE id=p_referral RETURNING * INTO r;
    INSERT INTO reward_credits(tenant_id,owner_id,currency_code,amount_minor,source,source_id,withdrawable,expires_at)
      SELECT c.tenant_id, r.referrer_id, c.currency_code, v_reward, 'customer_referral', r.id, false, r.credit_expires_at;
    RETURN r;
  END IF;

  -- Driver referral: cumulative fares across first N qualifying jobs inside
  -- the activation window; released only after the review period.
  IF r.activated_at IS NULL THEN
    UPDATE referrals SET activated_at=j.created_at WHERE id=p_referral RETURNING * INTO r;
  END IF;
  IF r.qualifying_window_days IS NOT NULL AND j.created_at > r.activated_at + (r.qualifying_window_days||' days')::interval THEN
    UPDATE referrals SET status='rejected', resolved_at=now() WHERE id=p_referral RETURNING * INTO r;
    RETURN r;
  END IF;
  INSERT INTO referral_driver_progress(referral_id,job_id,fare_minor)
    VALUES(p_referral,p_job,v_fare) ON CONFLICT (job_id) DO NOTHING;
  SELECT count(*) INTO v_progress FROM referral_driver_progress WHERE referral_id=p_referral;
  IF v_progress < coalesce(r.qualifying_jobs_required,20) THEN RETURN r; END IF;
  IF r.status='earned' THEN RETURN r; END IF;
  v_max := coalesce((c.qualification->>'max_rewards_per_month')::int, 3);
  IF referral_monthly_count(r.referrer_id,'driver') >= v_max THEN
    RAISE EXCEPTION 'monthly_cap_reached';
  END IF;
  SELECT sum(fare_minor) INTO v_fare FROM referral_driver_progress WHERE referral_id=p_referral;
  v_reward := (v_fare * coalesce(r.reward_rate_bps,500) / 10000)::bigint;
  IF r.reward_cap_minor IS NOT NULL THEN v_reward := least(v_reward, r.reward_cap_minor); END IF;
  IF c.budget_minor>0 AND NOT campaign_spend(c.id, v_reward) THEN
    RAISE EXCEPTION 'campaign_budget_exhausted';
  END IF;
  UPDATE referrals SET status='earned', qualifying_job_id=p_job,
    qualifying_fare_minor=v_fare, reward_minor=v_reward,
    qualified_at=now(), resolved_at=now(),
    release_at=now()+(coalesce(r.review_days,7)||' days')::interval
   WHERE id=p_referral RETURNING * INTO r;
  RETURN r;
END $$;

-- After the review window an earned driver referral releases its credit.
CREATE OR REPLACE FUNCTION release_referral_rewards()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n int := 0; r referrals;
BEGIN
  FOR r IN SELECT * FROM referrals
            WHERE status='earned' AND referral_kind='driver'
              AND release_at IS NOT NULL AND release_at<=now()
            FOR UPDATE SKIP LOCKED LOOP
    UPDATE referrals SET status='released' WHERE id=r.id;
    INSERT INTO reward_credits(tenant_id,owner_id,currency_code,amount_minor,source,source_id,withdrawable)
      SELECT r.tenant_id, r.referrer_id,
        (SELECT currency_code FROM campaigns WHERE id=r.campaign_id),
        r.reward_minor, 'driver_referral', r.id, false;
    n := n+1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION flag_cash_hold_review_v1f(uuid,bigint),
  public.reassign_cash_job_credit_v1f(uuid,uuid),
  publish_cancellation_policy(uuid,text,bigint,int,int,bigint,bigint,numeric,uuid),
  release_referral_rewards(),
  referral_monthly_count(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION flag_cash_hold_review_v1f(uuid,bigint),
  public.reassign_cash_job_credit_v1f(uuid,uuid),
  publish_cancellation_policy(uuid,text,bigint,int,int,bigint,bigint,numeric,uuid),
  release_referral_rewards(),
  referral_monthly_count(uuid,text) TO service_role;

-- I) Replay scope: a released hold is history, not a replay conflict —
--    reassignment creates a fresh active hold. Only held/settled rows count.
CREATE OR REPLACE FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid)                                                                                                                                                                                                   
  RETURNS uuid                                                                                                                                                                                                                                                                                    
  LANGUAGE plpgsql                                                                                                                                                                                                                                                                                
  SECURITY DEFINER                                                                                                                                                                                                                                                                                
  SET search_path TO 'pg_catalog', 'public'                                                                                                                                                                                                                                                       
 AS $function$                                                                                                                                                                                                                                                                                    
 DECLARE j public.jobs%ROWTYPE; enrol public.driver_cash_credit_enrolments_v1e%ROWTYPE; p jsonb; terms jsonb; balance jsonb; h public.driver_cash_credit_holds_v1e%ROWTYPE; v_id uuid; event uuid; need bigint; driver uuid;                                                                      
 BEGIN                                                                                                                                                                                                                                                                                            
  IF NOT public.driver_cash_credit_enabled_v1e() THEN RAISE EXCEPTION 'Cash credit pilot disabled' USING ERRCODE='CE001'; END IF;                                                                                                                                                                 
  SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;                                                                                                                                                                                                                           
  driver:=coalesce(j.driver_id,j.accepted_driver_id);                                                                                                                                                                                                                                             
  IF driver IS DISTINCT FROM p_driver_id OR p_driver_id IS NULL OR (j.driver_id IS NOT NULL AND j.accepted_driver_id IS NOT NULL AND j.driver_id<>j.accepted_driver_id)                                                                                                                           
  OR j.payment_method IS DISTINCT FROM 'cash' OR j.status IS NULL OR j.status NOT IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN                                                                                 
   RAISE EXCEPTION 'Cash booking/driver is not eligible' USING ERRCODE='CE002'; END IF;                                                                                                                                                                                                           
  IF NOT EXISTS(SELECT 1 FROM public.service_types WHERE id=j.service_type_id AND slug='ride') THEN                                                                                                                                                                                               
   RAISE EXCEPTION 'Cash credit pilot supports Ride only' USING ERRCODE='CE002'; END IF;                                                                                                                                                                                                          
  PERFORM public.driver_cash_credit_lock_v1e(j.tenant_id,p_driver_id,j.currency_code);                                                                                                                                                                                                            
  SELECT to_jsonb(x) INTO p FROM public.profiles x WHERE id=p_driver_id;                                                                                                                                                                                                                          
  SELECT * INTO enrol FROM public.driver_cash_credit_enrolments_v1e WHERE tenant_id=j.tenant_id AND driver_id=p_driver_id AND country_code=j.country_code AND currency_code=j.currency_code FOR SHARE;                                                                                            
  IF p IS NULL OR p->>'role' IS DISTINCT FROM 'driver' OR NULLIF(p->>'registration_activated_at','') IS NULL                                                                                                                                                                                      
  OR NOT public.driver_job_market_matches_v23(p,to_jsonb(j))                                                                                                                                                                                                                                      
  OR NOT EXISTS(SELECT 1 FROM public.market_availability m WHERE m.country_code=j.country_code AND upper(m.supported_currency)=j.currency_code)                                                                                                                                                   
  OR enrol.driver_id IS NULL OR NOT enrol.enabled OR enrol.consented_at>now() THEN                                                                                                                                                                                                                
   RAISE EXCEPTION 'Driver cash credit is not approved for this tenant/market' USING ERRCODE='CE002'; END IF;                                                                                                                                                                                     
  terms:=public.cash_credit_terms_v1e(j.fare_breakdown,j.currency_code);need:=(terms->>'required')::bigint;                                                                                                                                                                                       
  IF j.fare_breakdown ? 'driverCommissionPolicy' AND j.fare_breakdown->'driverCommissionPolicy'->>'driverId' IS DISTINCT FROM p_driver_id::text THEN                                                                                                                                              
   RAISE EXCEPTION 'Frozen commission belongs to another driver' USING ERRCODE='CE003'; END IF;                                                                                                                                                                                                   
  IF j.agreed_fare IS NOT NULL AND public.cash_credit_minor_v1e(to_jsonb(j.agreed_fare),j.currency_code)<>(terms->>'charge')::bigint THEN                                                                                                                                                         
   RAISE EXCEPTION 'Agreed fare does not match frozen cash terms' USING ERRCODE='CE003'; END IF;                                                                                                                                                                                                  
  SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=j.id AND status IN ('held','settled') FOR UPDATE;                                                                                                                                                                                                          
  IF FOUND THEN                                                                                                                                                                                                                                                                                   
   IF h.driver_id<>p_driver_id OR h.tenant_id<>j.tenant_id OR h.currency_code<>j.currency_code OR h.country_code<>j.country_code OR h.fare_snapshot IS DISTINCT FROM j.fare_breakdown OR h.status='released' THEN                                                                                 
    RAISE EXCEPTION 'Cash reservation replay terms changed' USING ERRCODE='CE005'; END IF;                                                                                                                                                                                                        
   RETURN h.id;                                                                                                                                                                                                                                                                                   
  END IF;                                                                                                                                                                                                                                                                                         
  IF j.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR j.payment_intent_id IS NOT NULL OR j.payment_status IS NULL OR j.payment_status NOT IN ('pending','cash_due','cash_pending') THEN                                                                             
   RAISE EXCEPTION 'Explicit full-cash custody and no digital payment required' USING ERRCODE='CE002'; END IF;                                                                                                                                                                                    
  IF j.status IN ('completed','delivered','settled') THEN RAISE EXCEPTION 'Cannot create a new cash hold after completion' USING ERRCODE='CE006'; END IF;                                                                                                                                         
  balance:=public.driver_cash_credit_balance_v1e(j.tenant_id,p_driver_id,j.currency_code);                                                                                                                                                                                                        
  IF NOT (balance->>'consistent')::boolean OR (balance->>'deficitMinor')::numeric>0 THEN RAISE EXCEPTION 'Cash credit requires reconciliation' USING ERRCODE='CE006'; END IF;                                                                                                                     
  IF (balance->>'availableMinor')::numeric<need THEN RAISE EXCEPTION 'Top up driver cash credit before accepting this cash ride' USING ERRCODE='CE004'; END IF;                                                                                                                                   
  v_id:=gen_random_uuid();                                                                                                                                                                                                                                                                        
  IF need>0 THEN                                                                                                                                                                                                                                                                                  
   event:=public.post_wallet_event('cash-hold:'||v_id::text,'cash_credit_reserve',j.tenant_id,p_driver_id,j.currency_code,                                                                                                                                                                        
    jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',-need),jsonb_build_object('accountPurpose','driver_cash_credit_reserved','amountMinor',need)));                                                                                                      
  END IF;                                                                                                                                                                                                                                                                                         
  INSERT INTO public.driver_cash_credit_holds_v1e(id,job_id,tenant_id,driver_id,country_code,currency_code,fare_snapshot,enrolment_terms_version,enrolment_consented_at,customer_charge_minor,commission_minor,platform_fee_minor,driver_entitlement_minor,required_credit_minor,reserve_event_id)
  VALUES(v_id,j.id,j.tenant_id,p_driver_id,j.country_code,j.currency_code,j.fare_breakdown,enrol.terms_version,enrol.consented_at,(terms->>'charge')::bigint,(terms->>'commission')::bigint,(terms->>'fee')::bigint,(terms->>'net')::bigint,need,event);                                          
  RETURN v_id;                                                                                                                                                                                                                                                                                    
 END $function$;

-- J) Review columns are mutable on a held row (only terms/history frozen);
--    resolve targets the ACTIVE hold so released history can't mask it.
CREATE OR REPLACE FUNCTION public.guard_cash_credit_hold_v1e()                                                                                              
  RETURNS trigger                                                                                                                                            
  LANGUAGE plpgsql                                                                                                                                           
  SET search_path TO 'pg_catalog', 'public'                                                                                                                  
 AS $function$                                                                                                                                               
 BEGIN                                                                                                                                                       
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cash credit history cannot be deleted' USING ERRCODE='CE005'; END IF;                                              
  IF (to_jsonb(NEW)-ARRAY['status','resolution_event_id','resolved_at','review_required','disputed_minor','review_due_at','escalated']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolution_event_id','resolved_at','review_required','disputed_minor','review_due_at','escalated'])
  OR OLD.status<>'held' OR NEW.status NOT IN ('held','released','settled') THEN                                                                                     
   RAISE EXCEPTION 'Cash credit terms/history are frozen' USING ERRCODE='CE005'; END IF;                                                                     
  RETURN NEW;                                                                                                                                                
 END $function$                                                                                                                                              ;

CREATE OR REPLACE FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text)                                                                                                                                                                                                                                                                                            
  RETURNS uuid                                                                                                                                                                                                                                                                                                                                                                           
  LANGUAGE plpgsql                                                                                                                                                                                                                                                                                                                                                                       
  SECURITY DEFINER                                                                                                                                                                                                                                                                                                                                                                       
  SET search_path TO 'pg_catalog', 'public'                                                                                                                                                                                                                                                                                                                                              
 AS $function$                                                                                                                                                                                                                                                                                                                                                                           
 DECLARE j public.jobs%ROWTYPE; h public.driver_cash_credit_holds_v1e%ROWTYPE; event uuid; reserved numeric;                                                                                                                                                                                                                                                                             
 BEGIN                                                                                                                                                                                                                                                                                                                                                                                   
  SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;                                                                                                                                                                                                                                                                                                                  
  SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job_id ORDER BY CASE WHEN status='held' THEN 0 ELSE 1 END, created_at DESC LIMIT 1 FOR UPDATE;                                                                                                                                                                                                                                                                                             
  IF NOT FOUND THEN RAISE EXCEPTION 'Cash hold missing' USING ERRCODE='CE006'; END IF;                                                                                                                                                                                                                                                                                                   
  PERFORM public.driver_cash_credit_lock_v1e(h.tenant_id,h.driver_id,h.currency_code);                                                                                                                                                                                                                                                                                                   
  IF p_outcome IS NULL OR p_outcome NOT IN ('released','settled') THEN RAISE EXCEPTION 'Invalid cash resolution' USING ERRCODE='CE003'; END IF;                                                                                                                                                                                                                                          
  IF p_outcome='released' AND (j.status IS NULL OR j.status NOT IN ('cancelled','canceled','expired','failed','no_driver_found')) THEN RAISE EXCEPTION 'Only cancelled/failed cash rides release credit' USING ERRCODE='CE006'; END IF;                                                                                                                                                  
  IF p_outcome='settled' AND (j.status IS NULL OR j.status NOT IN ('completed','delivered','settled') OR coalesce(j.driver_id,j.accepted_driver_id) IS DISTINCT FROM h.driver_id OR j.payment_method IS DISTINCT FROM 'cash' OR j.fare_breakdown IS DISTINCT FROM h.fare_snapshot OR j.tenant_id<>h.tenant_id OR j.currency_code<>h.currency_code OR j.country_code<>h.country_code) THEN
   RAISE EXCEPTION 'Cash completion terms/state mismatch' USING ERRCODE='CE006'; END IF;                                                                                                                                                                                                                                                                                                 
  IF h.status=p_outcome THEN RETURN h.id; END IF;                                                                                                                                                                                                                                                                                                                                        
  IF h.status<>'held' THEN RAISE EXCEPTION 'Cash hold already resolved differently' USING ERRCODE='CE005'; END IF;                                                                                                                                                                                                                                                                       
  SELECT coalesce(sum(m.amount_minor::numeric),0) INTO reserved FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id                                                                                                                                                                                                                                        
  WHERE a.tenant_id=h.tenant_id AND a.owner_id=h.driver_id AND a.currency_code=h.currency_code AND a.balance_purpose='driver_cash_credit_reserved';                                                                                                                                                                                                                                      
  IF reserved IS DISTINCT FROM (SELECT coalesce(sum(required_credit_minor::numeric),0) FROM public.driver_cash_credit_holds_v1e WHERE tenant_id=h.tenant_id AND driver_id=h.driver_id AND currency_code=h.currency_code AND status='held') OR reserved<h.required_credit_minor THEN RAISE EXCEPTION 'Cash reserved ledger requires reconciliation' USING ERRCODE='CE006'; END IF;        
  IF h.required_credit_minor>0 THEN                                                                                                                                                                                                                                                                                                                                                      
   IF p_outcome='released' THEN event:=public.post_wallet_reversal('cash-hold:'||h.id::text,'cash-hold:'||h.id::text||':release');                                                                                                                                                                                                                                                       
   ELSE event:=public.post_wallet_event('cash-hold:'||h.id::text||':settle','cash_credit_settle',h.tenant_id,h.driver_id,h.currency_code,                                                                                                                                                                                                                                                
     jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit_reserved','amountMinor',-h.required_credit_minor),jsonb_build_object('accountPurpose','cash_fee_clearing','amountMinor',h.required_credit_minor)));                                                                                                                                                       
   END IF;                                                                                                                                                                                                                                                                                                                                                                               
  END IF;                                                                                                                                                                                                                                                                                                                                                                                
  UPDATE public.driver_cash_credit_holds_v1e SET status=p_outcome,resolution_event_id=event,resolved_at=now() WHERE id=h.id;                                                                                                                                                                                                                                                             
  RETURN h.id;                                                                                                                                                                                                                                                                                                                                                                           
 END $function$                                                                                                                                                                                                                                                                                                                                                                          ;
