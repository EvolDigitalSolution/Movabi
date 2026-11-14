-- DEVELOP ONLY. GB/GBP activation of the policy values APPROVED by the user on 2026-11-14
-- ("Approve all proposals"): P1 cancellation fee, P4 first-booking promotion, P5 referrals, P6 PIN default.
-- One transaction: any failed check rolls back everything. Re-running changes nothing (idempotent).
-- Scope: every tenant that has GB drivers or customers, market GB, currency GBP only. NG and every
-- other market are untouched (all rows below carry market GB; the PIN setting changes only its GB key).
-- Needs release 2 (referral rewards in minor units, 20261270200000) and an API that converts promo
-- fares to minor units (2026-11-14 or later): it stops otherwise.
-- Undo: deactivate-gb.sql (disables; keeps history, frozen quotes and earned rewards).
\set ON_ERROR_STOP on
BEGIN;
DO $guard$ BEGIN
  IF current_database() <> 'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF;
  IF md5(replace(pg_get_functiondef('public.earn_referral(uuid,uuid)'::regprocedure),chr(13),'')) <> '114759b0db49eab9d05d5c982bd581fa' THEN
    RAISE EXCEPTION 'release 2 (referral minor units) is not applied: referrals would pay wrong amounts';
  END IF;
  IF to_regprocedure('public.set_cancellation_policy_enabled(uuid,uuid,boolean)') IS NULL THEN RAISE EXCEPTION 'release 1 missing'; END IF;
END $guard$;

-- The GB market minimum fare (approved debt threshold = 50% of it), from the active GB ride price row.
CREATE TEMP TABLE gb_min ON COMMIT DROP AS
  SELECT DISTINCT round(minimum_fare * 100)::bigint AS minor FROM public.pricing_config
   WHERE upper(country_code)='GB' AND service_type='ride' AND is_active;
DO $m$ BEGIN
  IF (SELECT count(*) FROM gb_min) <> 1 OR (SELECT minor FROM gb_min) <= 0 THEN
    RAISE EXCEPTION 'GB ride minimum fare is not exactly one positive value: %', (SELECT string_agg(minor::text, ',') FROM gb_min);
  END IF;
END $m$;
CREATE TEMP TABLE gb_tenants ON COMMIT DROP AS
  SELECT DISTINCT tenant_id FROM public.profiles
   WHERE tenant_id IS NOT NULL AND role IN ('driver','customer')
     AND upper(coalesce(registration_country_code, country_code, '')) = 'GB';
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM gb_tenants) THEN RAISE EXCEPTION 'no GB tenant found'; END IF; END $t$;

-- P1 (+ approved 80/20, on collection, debt threshold 50% of the GB minimum fare): fee 300, cap 300,
-- grace 120 s. Published as a new version through the same function the admin route uses, then enabled.
DO $p1$ DECLARE t uuid; v record; pid uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM gb_tenants LOOP
    IF EXISTS (SELECT 1 FROM public.cancellation_policies WHERE tenant_id=t AND market_code='GB' AND enabled
                 AND fee_minor=300 AND fee_cap_minor=300 AND grace_seconds=120 AND driver_compensation_percent=80) THEN CONTINUE; END IF;
    SELECT * INTO v FROM public.publish_cancellation_policy(t, 'GB', (SELECT minor FROM gb_min), 5000, 120, 300, 300, 80, NULL);
    pid := v.id;
    PERFORM public.set_cancellation_policy_enabled(pid, t, true);
    INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,metadata)
      VALUES (NULL,'admin_policy_publish','cancellation_policy',pid,
              jsonb_build_object('source','develop-activation-2026-11-14','approval','P1','market','GB','feeMinor',300,'feeCapMinor',300,'graceSeconds',120,'referenceFareMinor',(SELECT minor FROM gb_min),'debtThresholdBps',5000));
  END LOOP;
END $p1$;

-- P4: first-booking promotion 5% (approved), max discount 500, minimum fare 800, budget 50000; rides; one per customer.
INSERT INTO public.campaigns(tenant_id,code,kind,market_code,currency_code,service_slug,audience,enabled,paused,budget_minor,funding_party,
                             qualification,per_user_cap,stacking,value_type,value,referral_reward_bps,version)
SELECT tenant_id,'FIRST5GB','customer_discount','GB','GBP','ride','customer',true,false,50000,'platform',
       '{"firstBookingOnly":true,"max_discount_minor":500,"min_qualifying_fare_minor":800}'::jsonb,1,'exclusive','percent',5,500,1
  FROM gb_tenants
ON CONFLICT (tenant_id,code) DO NOTHING;

-- P5: referrals 5% (approved; customer 90-day credit, <=5/month; driver 20 jobs/30 days, <=3/month, 7-day
-- review, from the database defaults and the redeem route), reward cap 500, qualifying fare 800, budget 50000.
INSERT INTO public.campaigns(tenant_id,code,kind,market_code,currency_code,service_slug,audience,enabled,paused,budget_minor,funding_party,
                             qualification,per_user_cap,stacking,value_type,value,referral_reward_bps,version)
SELECT tenant_id,'REFERGB','referral','GB','GBP','ride','both',true,false,50000,'platform',
       '{"reward_cap_minor":500,"min_qualifying_fare_minor":800}'::jsonb,1,'exclusive',NULL,NULL,500,1
  FROM gb_tenants
ON CONFLICT (tenant_id,code) DO NOTHING;

-- P6: completion PIN required for every GB service (today's behaviour, now explicit for GB only).
DO $p6$ DECLARE t uuid; cur jsonb;
BEGIN
  FOR t IN SELECT tenant_id FROM gb_tenants LOOP
    SELECT value INTO cur FROM public.marketplace_settings WHERE tenant_id=t AND key='completion_pin_policy' ORDER BY created_at DESC LIMIT 1;
    IF cur IS NULL THEN
      INSERT INTO public.marketplace_settings(tenant_id,key,value) VALUES (t,'completion_pin_policy','{"markets":{"GB":"required"}}');
    ELSIF coalesce(cur #>> '{markets,GB}','') <> 'required' THEN
      UPDATE public.marketplace_settings SET value = jsonb_set(CASE WHEN jsonb_typeof(value)='object' THEN value ELSE '{}'::jsonb END, '{markets}',
               coalesce(CASE WHEN jsonb_typeof(value->'markets')='object' THEN value->'markets' END,'{}'::jsonb) || '{"GB":"required"}', true),
             updated_at = now()
       WHERE tenant_id=t AND key='completion_pin_policy';
    END IF;
  END LOOP;
END $p6$;

INSERT INTO public.audit_logs(user_id,action,entity_type,metadata)
SELECT NULL,'admin_develop_activation','market',jsonb_build_object('source','develop-activation-2026-11-14','market','GB','currency','GBP',
       'approved',jsonb_build_array('P1','P4','P5','P6'),'tenant',tenant_id) FROM gb_tenants;

-- Result (only GB rows may appear).
SELECT 'cancellation' AS feature, tenant_id::text, market_code, version::text, enabled::text, fee_minor||'/'||fee_cap_minor||'/'||grace_seconds AS terms
  FROM public.cancellation_policies WHERE enabled ORDER BY 2,3;
SELECT 'campaign' AS feature, tenant_id::text, code, market_code||'/'||currency_code, enabled::text, qualification::text FROM public.campaigns WHERE enabled ORDER BY 2,3;
SELECT 'pin' AS feature, coalesce(tenant_id::text,'(platform)'), value::text FROM public.marketplace_settings WHERE key='completion_pin_policy';
SELECT 'non-GB rows enabled (must be 0)' AS check,
  (SELECT count(*) FROM public.cancellation_policies WHERE enabled AND market_code<>'GB') + (SELECT count(*) FROM public.campaigns WHERE enabled AND market_code<>'GB') AS n;
COMMIT;
