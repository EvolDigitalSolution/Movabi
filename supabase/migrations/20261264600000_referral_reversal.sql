-- =============================================================================
-- Referral lifecycle completion: disabled-preserves-obligations + reversal.
--
-- 1. campaign_spend no longer gates on `enabled`. Gating is the caller's job:
--    apply_campaign_discount rejects disabled/paused (new applications), while
--    earn_referral spends budget for a PREVIOUSLY ACCEPTED referral even after
--    the campaign is disabled — the accepted obligation is preserved.
-- 2. reverse_referral_reward atomically reverses a referral AND its linked
--    reward credit(s): status -> reversed, preserving any historical spend
--    (reward_credit_spends rows are never deleted) and never creating extra
--    credit. Duplicate reversal is idempotent.
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.campaigns') IS NULL
     OR to_regclass('public.referrals') IS NULL
     OR to_regclass('public.reward_credits') IS NULL THEN
    RAISE EXCEPTION 'Referral lifecycle prerequisites missing';
  END IF;
END $$;

-- Budget guard is a pure anti-overspend bound; caller enforces lifecycle state.
CREATE OR REPLACE FUNCTION campaign_spend(p_campaign uuid, p_amount bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v campaigns;
BEGIN
  update campaigns set spent_minor=spent_minor+p_amount
   where id=p_campaign and spent_minor+p_amount<=budget_minor
  returning * into v;
  return found;
END $$;
REVOKE ALL ON FUNCTION campaign_spend(uuid,bigint) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION campaign_spend(uuid,bigint) TO service_role;

-- Reverse an accepted/earned/released referral and its reward credit(s).
-- Idempotent; preserves historical spending; creates no extra credit.
CREATE OR REPLACE FUNCTION reverse_referral_reward(p_referral uuid)
RETURNS referrals LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r referrals;
BEGIN
  SELECT * INTO r FROM referrals WHERE id=p_referral FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'referral_missing'; END IF;
  IF r.status='reversed' THEN RETURN r; END IF; -- duplicate reversal idempotent
  UPDATE referrals SET status='reversed', resolved_at=now()
   WHERE id=p_referral RETURNING * INTO r;
  -- Reverse linked reward credit(s); active or already-used both become
  -- reversed (used credits keep their spend history, nothing is deleted).
  UPDATE reward_credits SET status='reversed', reversed_at=now()
   WHERE source_id=p_referral AND source IN ('customer_referral','driver_referral')
     AND status IN ('active','used');
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION reverse_referral_reward(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION reverse_referral_reward(uuid) TO service_role;

COMMIT;
