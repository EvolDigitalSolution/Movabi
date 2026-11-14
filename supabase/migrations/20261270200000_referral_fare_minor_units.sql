-- 7b (2026-11-14): earn_referral treated the job fare (MAJOR units, e.g. 12.50 GBP) as MINOR units:
-- `coalesce(j.agreed_fare, j.total_price, j.price, 0)::bigint` turned 12.50 into 12 "minor", so a 5% reward
-- became 0 and any minor-unit qualifying fare (e.g. 800 = 8.00 GBP) could never be met. Fixed by converting
-- with the currency's minor exponent (public.wallet_currency_minor_exponent, as cancellation_fee_quote does).
-- The percentage is rounded DOWN to a whole minor unit with exact numeric arithmetic (same result as
-- the previous integer division, now explicit). Also refuses a job outside the campaign's market or
-- currency (market isolation).
-- Base: develop's LIVE definition (baseline 20261112), changed only at the fare line and the two checks.
-- Rewards already recorded are not recalculated. Rollback: release-down restores develop's exact live body.
CREATE OR REPLACE FUNCTION public.earn_referral(p_referral uuid, p_job uuid) RETURNS public.referrals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE r referrals; j jobs; c campaigns;
        v_fare bigint; v_reward bigint; v_max int; v_progress int; v_exp int;
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
  -- Existing obligations survive pause/disable: the campaign must only exist
  -- (for currency, caps and budget). New links are gated at redeem time.
  SELECT * INTO c FROM campaigns WHERE id=r.campaign_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_missing'; END IF;
  -- Market isolation: a campaign rewards jobs of its own market and currency only.
  IF upper(coalesce(j.currency_code,'')) <> upper(c.currency_code) THEN RAISE EXCEPTION 'referral_currency_mismatch'; END IF;
  IF upper(coalesce(j.country_code,'')) <> upper(c.market_code) THEN RAISE EXCEPTION 'referral_market_mismatch'; END IF;
  -- Fares on jobs are MAJOR units (e.g. 12.50 GBP); rewards, caps and budgets are MINOR units.
  -- Shared rule (as cancellation_fee_quote): exact NUMERIC arithmetic with the currency's minor
  -- exponent from wallet_currency_minor_exponent; round() on numeric rounds half away from zero.
  -- No floating point is involved. An unknown currency is refused.
  v_exp := public.wallet_currency_minor_exponent(upper(j.currency_code));
  IF v_exp IS NULL THEN RAISE EXCEPTION 'referral_currency_unknown'; END IF;
  v_fare := round(coalesce(j.agreed_fare, j.total_price, j.price, 0)::numeric * power(10::numeric, v_exp))::bigint;

  IF r.referral_kind='customer' THEN
    v_reward := floor(v_fare::numeric * coalesce(r.reward_rate_bps, 500) / 10000)::bigint;  -- rounds down
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
  v_reward := floor(v_fare::numeric * coalesce(r.reward_rate_bps, 500) / 10000)::bigint;  -- rounds down
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
REVOKE ALL ON FUNCTION public.earn_referral(uuid,uuid) FROM PUBLIC;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON FUNCTION public.earn_referral(uuid,uuid) FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON FUNCTION public.earn_referral(uuid,uuid) FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public.earn_referral(uuid,uuid) TO service_role; END IF;
END $g$;
