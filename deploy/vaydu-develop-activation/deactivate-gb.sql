-- DEVELOP ONLY. Undo activate-gb.sql: switches the GB features OFF without deleting history.
--
-- What deactivation does NOT touch (valid obligations stay valid; rehearsed in check-deactivated.sql):
--   * Cancellation fees already quoted into a cancelled booking (frozen quote) and customer debt already
--     recorded (customer_receivables): they stay open and payable; compensation of a fee collected later
--     still follows the frozen policy version.
--   * Discounts already applied to a quote (campaign_discount_applications): the booking keeps them.
--   * Referral rewards already earned (reward_credits): kept in full until they expire or are spent.
--   * Referrals already linked: they still earn when the referee completes a qualifying ride (the campaign
--     row exists; earn_referral honours existing links, as designed). New links and new discounts stop.
--   * Published policy versions, campaign rows, settings history and audit rows.
-- What it turns off for NEW business: fee quotes, discount applications, referral links, the GB PIN /
-- matching / surge keys (GB falls back to: PIN required, previous ranking, no surge).
\set ON_ERROR_STOP on
BEGIN;
DO $guard$ BEGIN IF current_database() <> 'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF; END $guard$;
DO $d$ DECLARE r record;
BEGIN
  FOR r IN SELECT id, tenant_id FROM public.cancellation_policies WHERE market_code='GB' AND enabled LOOP
    PERFORM public.set_cancellation_policy_enabled(r.id, r.tenant_id, false);
  END LOOP;
END $d$;
UPDATE public.campaigns SET enabled=false WHERE market_code='GB' AND code IN ('FIRST5GB','REFERGB') AND enabled;
-- Settings: remove only the GB key; every other key (other markets, tenant-level values) is kept.
UPDATE public.marketplace_settings SET value = value #- '{markets,GB}', updated_at = now()
 WHERE key IN ('completion_pin_policy','smart_matching','dynamic_pricing') AND value #> '{markets,GB}' IS NOT NULL;
INSERT INTO public.audit_logs(user_id,action,entity_type,metadata)
VALUES (NULL,'admin_develop_deactivation','market',jsonb_build_object('source','develop-activation-2026-11-14','market','GB','undone',jsonb_build_array('P1','P4','P5','P6','P7','P8')));
SELECT (SELECT count(*) FROM public.cancellation_policies WHERE enabled AND market_code='GB') AS gb_policies_enabled,
       (SELECT count(*) FROM public.campaigns WHERE enabled AND market_code='GB' AND code IN ('FIRST5GB','REFERGB')) AS gb_campaigns_enabled,
       (SELECT count(*) FROM public.marketplace_settings WHERE value #> '{markets,GB}' IS NOT NULL
          AND key IN ('completion_pin_policy','smart_matching','dynamic_pricing')) AS gb_setting_keys;
COMMIT;
