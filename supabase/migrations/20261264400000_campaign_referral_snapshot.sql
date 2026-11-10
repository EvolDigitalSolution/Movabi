-- =============================================================================
-- Referral rate snapshot: existing referrals retain their original rate.
--
-- 643 made earn_referral prefer the live campaign referral_reward_bps, which
-- would retroactively re-price an already-created referral when an admin edits
-- the rate. The correct semantics: the rate is frozen on the referral at link
-- time (see the redeem route), and earn_referral reads ONLY that snapshot.
-- New links pick up the campaign's current referral_reward_bps at link time;
-- existing links keep theirs. Legacy links (no snapshot) fall back to 500 bps
-- (the approved 5% default).
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.campaigns') IS NULL OR to_regclass('public.referrals') IS NULL THEN
    RAISE EXCEPTION 'Referral snapshot prerequisites missing';
  END IF;
END $$;

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
  IF NOT FOUND OR NOT c.enabled OR c.paused THEN RAISE EXCEPTION 'campaign_inactive'; END IF;
  v_fare := coalesce(j.agreed_fare, j.total_price, j.price, 0)::bigint;

  IF r.referral_kind='customer' THEN
    v_reward := (v_fare * coalesce(r.reward_rate_bps, 500) / 10000)::bigint;
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
  v_reward := (v_fare * coalesce(r.reward_rate_bps, 500) / 10000)::bigint;
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
revoke all on function earn_referral(uuid,uuid) from public, anon, authenticated;
grant execute on function earn_referral(uuid,uuid) to service_role;

COMMIT;
