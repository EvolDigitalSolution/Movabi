-- =============================================================================
-- Referral adjudication alignment: reverse_referral_reward must match the
-- adjudicate route's transition guard (pending/earned/released are reversible;
-- rejected/reversed are terminal for reversal). Keeps the credit reversal
-- idempotent and side-effect free for non-reversible states.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION reverse_referral_reward(p_referral uuid)
RETURNS referrals LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r referrals;
BEGIN
  SELECT * INTO r FROM referrals WHERE id=p_referral FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'referral_missing'; END IF;
  IF r.status IN ('reversed','rejected') THEN RETURN r; END IF; -- terminal for reversal
  UPDATE referrals SET status='reversed', resolved_at=now()
   WHERE id=p_referral RETURNING * INTO r;
  UPDATE reward_credits SET status='reversed', reversed_at=now()
   WHERE source_id=p_referral AND source IN ('customer_referral','driver_referral')
     AND status IN ('active','used');
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION reverse_referral_reward(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION reverse_referral_reward(uuid) TO service_role;

COMMIT;
