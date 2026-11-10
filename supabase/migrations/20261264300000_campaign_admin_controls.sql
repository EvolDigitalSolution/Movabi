-- =============================================================================
-- Campaign admin controls (promotions, referrals, driver incentives).
--
-- Fills the operational gaps so admins can configure, pause and publish each
-- campaign independently with server-side validation and audit:
--   * tri-state lifecycle: enabled / paused / disabled (paused stops NEW
--     applications but never erases accepted discounts, spent budget or
--     earned/pending rewards — there is no cascade delete anywhere);
--   * version + published_at/published_by for the audit trail of who changed
--     or published each policy version;
--   * campaign-level referral reward rate (default 500 bps = 5%);
--   * optional global usage limit.
--
-- Forward-only. Defensive IF NOT EXISTS / CREATE OR REPLACE.
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.campaigns') IS NULL
     OR to_regclass('public.campaign_discount_applications') IS NULL
     OR to_regclass('public.referrals') IS NULL THEN
    RAISE EXCEPTION 'Campaign admin controls prerequisites missing';
  END IF;
END $$;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid,
  ADD COLUMN IF NOT EXISTS referral_reward_bps int NOT NULL DEFAULT 500 CHECK (referral_reward_bps BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS usage_limit int CHECK (usage_limit IS NULL OR usage_limit > 0);

-- ---------------------------------------------------------------------------
-- apply_campaign_discount: paused blocks new applications; optional global
-- usage limit; existing qualification rules (first-booking-only, minimum fare,
-- maximum discount cap) and budget/per-user-cap guards are preserved.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_campaign_discount(
  p_campaign uuid, p_customer uuid, p_quote text, p_fare_minor bigint)
returns campaign_discount_applications language plpgsql security definer set search_path=public as $$
declare c campaigns; v campaign_discount_applications; used int; discount bigint; total_used int;
begin
  select * into c from campaigns where id=p_campaign for update;
  if not found or not c.enabled or c.paused or c.kind<>'customer_discount' then raise exception 'campaign_unavailable'; end if;
  if c.valid_from is not null and c.valid_from>now() then raise exception 'campaign_not_started'; end if;
  if c.valid_until is not null and c.valid_until<=now() then raise exception 'campaign_expired'; end if;

  -- First-booking-only: reject if the customer has any prior completed/paid job.
  if coalesce((c.qualification->>'firstBookingOnly')::boolean,false) then
    if exists(select 1 from jobs where customer_id=p_customer
              and status in ('completed','delivered','settled')
              and payment_status in ('paid','succeeded','cash_due','cash_pending')) then
      raise exception 'campaign_first_booking_only';
    end if;
  end if;
  -- Market-configured minimum eligible fare.
  if c.qualification->>'min_qualifying_fare_minor' is not null
     and p_fare_minor < (c.qualification->>'min_qualifying_fare_minor')::bigint then
    raise exception 'campaign_fare_below_minimum';
  end if;

  -- Idempotent replay first: same (campaign, customer, quote) returns existing
  -- (preserves the 202612633 replay-order fix).
  select * into v from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and quote_reference=p_quote;
  if found then return v; end if;

  select count(*) into used from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and status in ('applied','consumed');
  if used>=c.per_user_cap then raise exception 'campaign_cap_reached'; end if;

  -- Optional global usage limit.
  if c.usage_limit is not null then
    select count(*) into total_used from campaign_discount_applications
     where campaign_id=p_campaign and status in ('applied','consumed');
    if total_used>=c.usage_limit then raise exception 'campaign_usage_limit_reached'; end if;
  end if;

  discount := case when c.value_type='percent' then least(floor(p_fare_minor * c.value / 100), p_fare_minor)
                   when c.value_type='fixed_minor' then least(c.value::bigint, p_fare_minor)
                   else 0 end;
  -- Market-configured maximum discount cap.
  if c.qualification->>'max_discount_minor' is not null
     and discount > (c.qualification->>'max_discount_minor')::bigint then
    discount := (c.qualification->>'max_discount_minor')::bigint;
  end if;
  if discount <= 0 then raise exception 'campaign_no_discount'; end if;
  if c.budget_minor>0 and not campaign_spend(c.id, discount) then raise exception 'campaign_budget_exhausted'; end if;
  insert into campaign_discount_applications(tenant_id,campaign_id,customer_id,quote_reference,discount_minor)
    values(c.tenant_id,p_campaign,p_customer,p_quote,discount) returning * into v;
  return v;
end$$;
revoke all on function apply_campaign_discount(uuid,uuid,text,bigint) from public, anon, authenticated;
grant execute on function apply_campaign_discount(uuid,uuid,text,bigint) to service_role;

-- ---------------------------------------------------------------------------
-- earn_referral: paused blocks new rewards; referral rate is campaign-
-- configurable (default 500 bps = 5%). Existing earned/pending/released
-- rewards are never touched by a pause.
-- ---------------------------------------------------------------------------
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
    v_reward := (v_fare * coalesce(c.referral_reward_bps, r.reward_rate_bps, 500) / 10000)::bigint;
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
  v_reward := (v_fare * coalesce(c.referral_reward_bps, r.reward_rate_bps, 500) / 10000)::bigint;
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
