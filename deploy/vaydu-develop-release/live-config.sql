-- READ-ONLY: live enablement state on develop (2026-11-13). Run by host-live-config.sh.
-- Prints switches, scopes and counts only: no merchant references, no personal data, no secrets.
\set ON_ERROR_STOP 1
\pset pager off
BEGIN READ ONLY;
\echo '== market_availability (enabled markets and their switches)'
SELECT country_code, coalesce(market_city,'-') AS city, supported_currency AS ccy, enabled, launch_status,
       booking_enabled AS booking, payment_enabled AS payment, driver_online_enabled AS online, driver_registration_enabled AS driver_reg
  FROM public.market_availability ORDER BY 1,2;
\echo '== market_payment_routes (collection; merchant refs not printed)'
SELECT country_code, currency_code, method, provider, enabled, merchant_approved, adapter_ready, payout_approved, capabilities, merchant_account_ref IS NOT NULL AS has_ref
  FROM public.market_payment_routes ORDER BY 1,2,3;
\echo '== driver_payout_markets (payout)'
SELECT country_code, currency_code, provider, enabled, merchant_approved, adapter_ready, merchant_mode, capability_verified_at IS NOT NULL AS capability_verified
  FROM public.driver_payout_markets ORDER BY 1,2;
\echo '== cash ride: global switch and markets'
SELECT key, enabled FROM public.driver_cash_credit_config_v1e ORDER BY 1;
SELECT country_code, currency_code, enabled FROM public.driver_cash_credit_markets_v1e ORDER BY 1,2;
\echo '== cancellation_policies (per tenant + market; fee values shown only as present/absent)'
SELECT tenant_id, market_code, version, enabled, fee_minor > 0 AS has_fee, fee_cap_minor IS NOT NULL AS has_cap, grace_seconds,
       driver_compensation_percent, compensation_funding, debt_threshold_minor > 0 AS has_debt_threshold, cardinality(exempt_reasons) AS exempt_reasons
  FROM public.cancellation_policies ORDER BY 1,2,3;
\echo '== campaigns (promotions, referrals, driver incentives)'
SELECT tenant_id, kind, market_code, currency_code, service_slug, enabled, paused, budget_minor > 0 AS has_budget, per_user_cap,
       qualification ? 'max_discount_minor' AS has_max_discount, qualification ? 'min_qualifying_fare_minor' AS has_min_fare,
       referral_reward_bps, valid_from, valid_until
  FROM public.campaigns ORDER BY 1,2,3;
\echo '== marketplace_settings: completion PIN, smart matching, dynamic pricing (null tenant = platform default)'
SELECT coalesce(tenant_id::text,'(platform)') AS tenant, key, value, updated_at
  FROM public.marketplace_settings WHERE key IN ('completion_pin_policy','smart_matching','dynamic_pricing') ORDER BY 2,1;
\echo '== per-driver PIN overrides'
SELECT policy, count(*) FROM public.driver_pin_policies GROUP BY 1 ORDER BY 1;
\echo '== drivers per tenant and registration market (counts only)'
SELECT tenant_id, coalesce(registration_country_code,'-') AS market, count(*) AS drivers,
       count(*) FILTER (WHERE registration_activated_at IS NOT NULL) AS activated,
       count(*) FILTER (WHERE inspection_market_code IS NULL) AS no_inspection_market
  FROM public.profiles WHERE role='driver' GROUP BY 1,2 ORDER BY 1,2;
\echo '== approved inspection photos per driver market (current revision)'
SELECT coalesce(p.registration_country_code,'-') AS market, ph.status, count(*)
  FROM public.driver_vehicle_inspection_photos ph JOIN public.profiles p ON p.id=ph.driver_id
  JOIN public.vehicles v ON v.id=ph.vehicle_id AND v.inspection_revision=ph.vehicle_revision
 GROUP BY 1,2 ORDER BY 1,2;
ROLLBACK;
