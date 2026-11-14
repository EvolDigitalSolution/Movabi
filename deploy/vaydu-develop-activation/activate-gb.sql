-- DEVELOP ONLY. GB/GBP activation of approved policy values. One transaction: any failed check rolls
-- back everything. Re-running changes nothing (idempotent). Undo: deactivate-gb.sql (keeps history).
--
-- APPROVAL SOURCE OF EVERY FINANCIAL OR POLICY VALUE IN THIS FILE
-- | Value                                   | Used here as                                  | Approval                                                     |
-- |-----------------------------------------|-----------------------------------------------|--------------------------------------------------------------|
-- | Cancellation fee 3.00 GBP               | fee_minor 300                                 | P1, user "Approve all proposals", 2026-11-14                 |
-- | Cancellation cap 3.00 GBP               | fee_cap_minor 300                             | P1, 2026-11-14                                               |
-- | Grace 120 s after acceptance            | grace_seconds 120                             | P1, 2026-11-14 (grace from acceptance: recorded design, 6a)  |
-- | Driver compensation 80% on collection   | compensation 80, funding on_collection        | Approved before 2026-11-12 (matrix "Approved and recorded")  |
-- | Debt threshold 50% of the minimum fare  | debt_threshold_bps 5000 x GB ride min. fare   | Approved before 2026-11-12 (matrix "Approved and recorded")  |
-- | GB ride minimum fare                    | read LIVE from pricing_config (not a new value)| Existing develop configuration                              |
-- | First-booking promotion 5%              | value_type percent, value 5                   | Approved before 2026-11-12 ("promo 5%")                       |
-- | Promo max discount 5.00 GBP             | max_discount_minor 500                        | P4, 2026-11-14                                               |
-- | Promo minimum fare 8.00 GBP             | min_qualifying_fare_minor 800                 | P4, 2026-11-14                                               |
-- | Promo budget 500.00 GBP                 | budget_minor 50000                            | P4, 2026-11-14                                               |
-- | Promo one per customer, first booking   | per_user_cap 1, firstBookingOnly              | Approved before 2026-11-12 ("5% first booking")              |
-- | Referral 5%                             | referral_reward_bps 500                       | Approved before 2026-11-12 (customer and driver referral 5%) |
-- | Referral cap 5.00 GBP                   | reward_cap_minor 500                          | P5, 2026-11-14                                               |
-- | Referral qualifying fare 8.00 GBP       | min_qualifying_fare_minor 800                 | P5, 2026-11-14                                               |
-- | Referral budget 500.00 GBP              | budget_minor 50000                            | P5, 2026-11-14                                               |
-- | Referral limits/windows                 | database defaults + redeem route (not set here)| Approved before 2026-11-12 (90-day credit, <=5/month; driver 20 jobs/30 days, <=3/month, 7-day review) |
-- | PIN required for GB                     | completion_pin_policy.markets.GB = required   | P6, 2026-11-14                                               |
-- | Matching weights GB                     | smart_matching.markets.GB 0.5 / 1.0 / 0.15 km | P7, 2026-11-14                                               |
-- | Review-score ranking on, road ETA off   | rankingEnabled true; VAYDU_TOMTOM_MATRIX_V23 untouched (off) | P7, 2026-11-14                                |
-- | Surge GB: on, max 1.5, demand/supply    | dynamic_pricing.markets.GB                    | P8, 2026-11-14                                               |
-- | Traffic display-only, other mult. 1.0   | trafficEnabled false, multipliers 1           | P8, 2026-11-14                                               |
-- Not set here: P9 (current map style kept), P13 (manual review kept): no change needed.
--
-- Scope: every tenant with GB drivers or customers, market GB, currency GBP only. NG and every other
-- market are untouched: rows carry market GB; settings change only their "markets"."GB" key.
-- Needs release 2 (referral rewards in minor units) and an API with the 2026-11-14 promo conversion and
-- per-market matching/pricing (bundle 4509243 or later): the earn_referral check below stops otherwise.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$ BEGIN
  IF current_database() <> 'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF;
  IF md5(replace(pg_get_functiondef('public.earn_referral(uuid,uuid)'::regprocedure),chr(13),'')) <> 'bbc10e72010059230652fd175f56a712' THEN
    RAISE EXCEPTION 'release 2 (referral minor units) is not applied: referrals would pay wrong amounts';
  END IF;
  IF to_regprocedure('public.set_cancellation_policy_enabled(uuid,uuid,boolean)') IS NULL THEN RAISE EXCEPTION 'release 1 missing'; END IF;
END $guard$;

-- The GB ride minimum fare, converted with the shared minor-unit rule (currency exponent, exact numeric).
CREATE TEMP TABLE gb_min ON COMMIT DROP AS
  SELECT DISTINCT round(minimum_fare * power(10::numeric, public.wallet_currency_minor_exponent(upper(currency_code))))::bigint AS minor
    FROM public.pricing_config
   WHERE upper(country_code)='GB' AND service_type='ride' AND is_active AND upper(currency_code)='GBP';
DO $m$ BEGIN
  IF (SELECT count(*) FROM gb_min) <> 1 OR (SELECT minor FROM gb_min) IS NULL OR (SELECT minor FROM gb_min) <= 0 THEN
    RAISE EXCEPTION 'GB/GBP ride minimum fare is not exactly one positive value: %', (SELECT string_agg(coalesce(minor::text,'null'), ',') FROM gb_min);
  END IF;
END $m$;
CREATE TEMP TABLE gb_tenants ON COMMIT DROP AS
  SELECT DISTINCT tenant_id FROM public.profiles
   WHERE tenant_id IS NOT NULL AND role IN ('driver','customer')
     AND upper(coalesce(registration_country_code, country_code, '')) = 'GB';
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM gb_tenants) THEN RAISE EXCEPTION 'no GB tenant found'; END IF; END $t$;

-- P8 preconditions: nothing else may override the approved GB surge.
DO $p8chk$ BEGIN
  IF EXISTS (SELECT 1 FROM public.market_pricing_strategies WHERE upper(country_code)='GB' AND enabled
               AND maximum_surge_multiplier IS NOT NULL AND maximum_surge_multiplier <> 1.5) THEN
    RAISE EXCEPTION 'an enabled GB market pricing strategy sets a different maximum surge: nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pricing_markets WHERE upper(country_code)='GB' AND ai_pricing_enabled AND NOT shadow_mode_enabled) THEN
    RAISE EXCEPTION 'GB AI pricing is live: traffic could change GB fares, contrary to P8: nothing was changed';
  END IF;
END $p8chk$;

-- Sets only the market key of a per-tenant setting; keeps every other key of that setting.
CREATE FUNCTION pg_temp.set_market_key(p_tenant uuid, p_key text, p_market text, p_entry jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE cur jsonb;
BEGIN
  SELECT value INTO cur FROM public.marketplace_settings WHERE tenant_id=p_tenant AND key=p_key ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.marketplace_settings(tenant_id,key,value) VALUES (p_tenant,p_key,jsonb_build_object('markets',jsonb_build_object(p_market,p_entry)));
  ELSIF cur #> ARRAY['markets',p_market] IS DISTINCT FROM p_entry THEN
    UPDATE public.marketplace_settings SET value = jsonb_set(CASE WHEN jsonb_typeof(value)='object' THEN value ELSE '{}'::jsonb END, '{markets}',
             coalesce(CASE WHEN jsonb_typeof(value->'markets')='object' THEN value->'markets' END,'{}'::jsonb) || jsonb_build_object(p_market,p_entry), true),
           updated_at = now()
     WHERE tenant_id=p_tenant AND key=p_key;
  END IF;
END $f$;

-- P1 (+ approved 80/20 on collection, debt threshold 50% of the GB minimum fare). Published as a new
-- version through the same function the admin route uses, then enabled.
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
              jsonb_build_object('source','develop-activation-2026-11-14','approval','P1 (2026-11-14); 80/20 and 50% threshold approved before 2026-11-12',
                                 'market','GB','feeMinor',300,'feeCapMinor',300,'graceSeconds',120,'referenceFareMinor',(SELECT minor FROM gb_min),'debtThresholdBps',5000));
  END LOOP;
END $p1$;

-- P4 first-booking promotion; P5 referrals. Re-enables a paused/disabled campaign only when its terms are
-- exactly the approved ones; a campaign with other terms stops the script (checked below).
INSERT INTO public.campaigns(tenant_id,code,kind,market_code,currency_code,service_slug,audience,enabled,paused,budget_minor,funding_party,
                             qualification,per_user_cap,stacking,value_type,value,referral_reward_bps,version)
SELECT tenant_id,'FIRST5GB','customer_discount','GB','GBP','ride','customer',true,false,50000,'platform',
       '{"firstBookingOnly":true,"max_discount_minor":500,"min_qualifying_fare_minor":800}'::jsonb,1,'exclusive','percent',5,500,1
  FROM gb_tenants
ON CONFLICT (tenant_id,code) DO UPDATE SET enabled=true, paused=false
  WHERE campaigns.kind=EXCLUDED.kind AND campaigns.market_code='GB' AND campaigns.currency_code='GBP'
    AND campaigns.qualification=EXCLUDED.qualification AND campaigns.budget_minor=EXCLUDED.budget_minor
    AND campaigns.value_type IS NOT DISTINCT FROM EXCLUDED.value_type AND campaigns.value IS NOT DISTINCT FROM EXCLUDED.value
    AND campaigns.referral_reward_bps=EXCLUDED.referral_reward_bps AND campaigns.per_user_cap=EXCLUDED.per_user_cap;
INSERT INTO public.campaigns(tenant_id,code,kind,market_code,currency_code,service_slug,audience,enabled,paused,budget_minor,funding_party,
                             qualification,per_user_cap,stacking,value_type,value,referral_reward_bps,version)
SELECT tenant_id,'REFERGB','referral','GB','GBP','ride','both',true,false,50000,'platform',
       '{"reward_cap_minor":500,"min_qualifying_fare_minor":800}'::jsonb,1,'exclusive',NULL,NULL,500,1
  FROM gb_tenants
ON CONFLICT (tenant_id,code) DO UPDATE SET enabled=true, paused=false
  WHERE campaigns.kind=EXCLUDED.kind AND campaigns.market_code='GB' AND campaigns.currency_code='GBP'
    AND campaigns.qualification=EXCLUDED.qualification AND campaigns.budget_minor=EXCLUDED.budget_minor
    AND campaigns.value_type IS NOT DISTINCT FROM EXCLUDED.value_type AND campaigns.value IS NOT DISTINCT FROM EXCLUDED.value
    AND campaigns.referral_reward_bps=EXCLUDED.referral_reward_bps AND campaigns.per_user_cap=EXCLUDED.per_user_cap;
DO $chk$ BEGIN
  IF EXISTS (SELECT 1 FROM gb_tenants t WHERE
       NOT EXISTS (SELECT 1 FROM public.campaigns c WHERE c.tenant_id=t.tenant_id AND c.code='FIRST5GB' AND c.enabled AND NOT c.paused AND c.market_code='GB' AND c.currency_code='GBP'
                     AND c.value_type='percent' AND c.value=5 AND c.budget_minor=50000 AND c.per_user_cap=1
                     AND c.qualification='{"firstBookingOnly":true,"max_discount_minor":500,"min_qualifying_fare_minor":800}'::jsonb)
    OR NOT EXISTS (SELECT 1 FROM public.campaigns c WHERE c.tenant_id=t.tenant_id AND c.code='REFERGB' AND c.enabled AND NOT c.paused AND c.market_code='GB' AND c.currency_code='GBP'
                     AND c.referral_reward_bps=500 AND c.budget_minor=50000
                     AND c.qualification='{"reward_cap_minor":500,"min_qualifying_fare_minor":800}'::jsonb)) THEN
    RAISE EXCEPTION 'FIRST5GB or REFERGB exists with terms other than the approved ones: nothing was changed';
  END IF;
END $chk$;

-- P6 PIN, P7 matching, P8 surge: only the GB key of each per-tenant setting.
DO $settings$ DECLARE t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM gb_tenants LOOP
    PERFORM pg_temp.set_market_key(t, 'completion_pin_policy', 'GB', '"required"'::jsonb);
    PERFORM pg_temp.set_market_key(t, 'smart_matching', 'GB',
      '{"rankingEnabled":true,"acceptanceRateWeight":0.5,"cancellationRateWeight":1.0,"newDriverExposureKm":0.15}'::jsonb);
    PERFORM pg_temp.set_market_key(t, 'dynamic_pricing', 'GB',
      '{"enabled":true,"maxSurge":1.5,"maxMultiplier":1.5,"demandSupplyEnabled":true,"trafficEnabled":false,"timeOfDayEnabled":false,"weatherEnabled":false,
        "trafficMultiplier":1,"weatherMultiplier":1,"demandMultiplier":1,"fuelMultiplier":1,"supplyScarcityMultiplier":1,"rainMultiplier":1,"floodMultiplier":1,
        "peakMultiplier":1,"publicHolidayMultiplier":1,"eventMultiplier":1,"nearbyDriverDiscount":1,"nightMultiplier":1,"airportSurcharge":0}'::jsonb);
  END LOOP;
END $settings$;

INSERT INTO public.audit_logs(user_id,action,entity_type,metadata)
SELECT NULL,'admin_develop_activation','market',jsonb_build_object('source','develop-activation-2026-11-14','market','GB','currency','GBP',
       'approved',jsonb_build_array('P1','P4','P5','P6','P7','P8'),'approvedBy','user, "Approve all proposals", 2026-11-14','tenant',tenant_id) FROM gb_tenants;

-- Result (only GB rows and GB keys may appear as changed).
SELECT 'cancellation' AS feature, tenant_id::text, market_code, version::text, enabled::text, fee_minor||'/'||fee_cap_minor||'/'||grace_seconds||'/'||debt_threshold_minor AS terms
  FROM public.cancellation_policies WHERE enabled ORDER BY 2,3;
SELECT 'campaign' AS feature, tenant_id::text, code, market_code||'/'||currency_code, enabled::text, qualification::text FROM public.campaigns WHERE enabled ORDER BY 2,3;
SELECT 'setting' AS feature, coalesce(tenant_id::text,'(platform)'), key, (value #> '{markets,GB}')::text AS gb
  FROM public.marketplace_settings WHERE key IN ('completion_pin_policy','smart_matching','dynamic_pricing') ORDER BY 2,3;
SELECT 'non-GB rows enabled (must be 0)' AS check,
  (SELECT count(*) FROM public.cancellation_policies WHERE enabled AND market_code<>'GB') + (SELECT count(*) FROM public.campaigns WHERE enabled AND market_code<>'GB') AS n;
COMMIT;
