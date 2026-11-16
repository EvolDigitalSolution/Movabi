#!/usr/bin/env bash
# Sourced ONLY by the owned disposable release-2 rehearsal after its existing checks.
# Uses that harness's q/root/tmp helpers. Never run on a host or accept a database URL.
act="$root/deploy/vaydu-develop-activation"
q movabi_develop <<'SQL'
-- Synthetic test setup, not a live financial correction.
INSERT INTO public.market_pricing_strategies(id,country_code,currency,service_type,enabled,maximum_surge_multiplier,normal_demand_multiplier,busy_multiplier,commission_percent,updated_at)
 SELECT ('8a000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'GB','GBP',s,true,3,1.1,2.5,17,'2026-11-01'
 FROM unnest(ARRAY['ride','errand','delivery','van-moving']) WITH ORDINALITY t(s,n);
INSERT INTO public.pricing_markets(country_code,currency_code,timezone,distance_unit,market_enabled,ai_pricing_enabled,shadow_mode_enabled)
 VALUES('GB','GBP','Europe/London','km',true,true,false);
INSERT INTO public.marketplace_settings(tenant_id,key,value) VALUES(NULL,'market_pricing_shadow_mode','false');
-- A NULL campaign field must be a conflict, not disappear through SQL three-valued logic.
UPDATE public.campaigns SET value_type=NULL WHERE code='FIRST5GB';
SQL
q movabi_develop < "$act/activation-preflight.sql" > "$tmp/p8-preflight-blocks.log"
report=$(grep '^ACTIVATION_PREFLIGHT_JSON=' "$tmp/p8-preflight-blocks.log" | sed 's/^ACTIVATION_PREFLIGHT_JSON=//')
# Assert the actual preflight output using PostgreSQL JSON, without duplicating check logic.
q movabi_develop -v report="$report" <<'SQL'
CREATE TEMP TABLE check_summary AS SELECT :'report'::jsonb AS report;
CREATE TEMP TABLE check_rows AS SELECT * FROM jsonb_to_recordset(:'report'::jsonb->'checks') AS x(code text,status text,detail jsonb);
DO $$ BEGIN
 IF (SELECT (report->>'blocks')::int FROM check_summary)<4 THEN RAISE EXCEPTION 'not all simultaneous conflicts were reported'; END IF;
 IF (SELECT count(*) FROM check_rows WHERE code IN('gb_ride_minimum','ai_market_shadow','market_intelligence_shadow','campaign_terms','existing_policy_skip_branch') AND status='BLOCK')<4 THEN RAISE EXCEPTION 'missing simultaneous conflict report'; END IF;
 IF NOT EXISTS(SELECT 1 FROM check_rows WHERE code='p8_strategy_overrides' AND status='CORRECTABLE') THEN RAISE EXCEPTION 'P8 correction not classified'; END IF;
END $$;
SQL
echo 'PASS: P8 preflight collected simultaneous conflicts in one pass'
q movabi_develop <<'SQL'
UPDATE public.campaigns SET value_type='percent' WHERE code='FIRST5GB';
UPDATE public.pricing_markets SET shadow_mode_enabled=true WHERE country_code='GB';
UPDATE public.marketplace_settings SET value='true' WHERE tenant_id IS NULL AND key='market_pricing_shadow_mode';
-- Focused test uses the user's preserved 3.35 floor and the existing integer threshold formula.
UPDATE public.pricing_config SET minimum_fare=3.35 WHERE country_code='GB' AND service_type='ride';
UPDATE public.cancellation_policies SET reference_fare_minor=335,debt_threshold_bps=5000,debt_threshold_minor=335::bigint*5000/10000
 WHERE market_code='GB';
-- One GB tenant used platform defaults for its other-market quotes. GB-only insertion must
-- preserve those defaults, rather than masking them with a newly created tenant row.
DELETE FROM public.marketplace_settings WHERE tenant_id='5a5a5a5a-0000-4000-8000-000000000001' AND key='dynamic_pricing';
INSERT INTO public.marketplace_settings(tenant_id,key,value) VALUES(NULL,'dynamic_pricing',
 '{"enabled":true,"maxSurge":2.4,"trafficEnabled":true,"trafficMultiplier":1.3,"weatherMultiplier":1.2,"markets":{"NG":{"enabled":true,"maxSurge":2.2}}}');
SQL
q movabi_develop < "$act/activation-preflight.sql" > "$tmp/p8-preflight-ok.log"
report=$(grep '^ACTIVATION_PREFLIGHT_JSON=' "$tmp/p8-preflight-ok.log" | sed 's/^ACTIVATION_PREFLIGHT_JSON=//')
q movabi_develop -v report="$report" <<'SQL'
CREATE TEMP TABLE check_summary AS SELECT :'report'::jsonb AS report;
DO $$ BEGIN IF (SELECT (report->>'blocks')::int FROM check_summary)<>0 THEN RAISE EXCEPTION 'preflight still has blockers: %',(SELECT report FROM check_summary); END IF; END $$;
SQL
echo 'PASS: P8 preflight has no remaining blockers after explicit fixture repairs'
S=$(q movabi_develop -c "select jsonb_agg(to_jsonb(s) order by id) from public.market_pricing_strategies s where country_code='GB'")
before=$(q movabi_develop -c "select md5(jsonb_agg(to_jsonb(s) order by id)::text) from public.market_pricing_strategies s")
bash "$act/build-p8-transaction.sh" without-legacy ROLLBACK > "$tmp/p8-dryrun.sql"
q movabi_develop -v expected_strategies_json="$S" < "$tmp/p8-dryrun.sql" > "$tmp/p8-dryrun.log" 2>&1 || { tail -30 "$tmp/p8-dryrun.log"; return 1; }
grep -q P8_ACTIVATION_ISOLATION_OK "$tmp/p8-dryrun.log"
check 'P8 full projected correction + exact activation dry run leaves every strategy unchanged' "$(q movabi_develop -c "select md5(jsonb_agg(to_jsonb(s) order by id)::text) from public.market_pricing_strategies s")" "$before"
bash "$act/build-p8-transaction.sh" without-legacy COMMIT > "$tmp/p8-apply.sql"
q movabi_develop -v expected_strategies_json="$S" < "$tmp/p8-apply.sql" > "$tmp/p8-apply.log" 2>&1 || { tail -30 "$tmp/p8-apply.log"; return 1; }
grep -q P8_ACTIVATION_ISOLATION_OK "$tmp/p8-apply.log"
check 'P8 composite transaction committed exactly four audited strategy corrections' "$(q movabi_develop -c "select count(*) from public.audit_logs where action='admin_develop_p8_reconciliation'")" 4
check 'P8 four strategy caps/normal/busy use approved effective demand/supply policy' "$(q movabi_develop -c "select count(*) from public.market_pricing_strategies where country_code='GB' and maximum_surge_multiplier=1.5 and normal_demand_multiplier=1 and busy_multiplier is null")" 4
check 'P8 retains GB AI enabled flag in shadow mode' "$(q movabi_develop -c "select ai_pricing_enabled::text||'/'||shadow_mode_enabled::text from public.pricing_markets where country_code='GB'")" 'true/true'
check 'P8 atomically enables native GB session tenant binding for every activated tenant' "$(q movabi_develop -c "select count(*) from public.marketplace_settings where key='quote_tenant_binding' and value#>>'{markets,GB,enabled}'='true'")" "$(q movabi_develop -c "select count(distinct tenant_id) from public.profiles where coalesce(nullif(upper(btrim(registration_country_code)),''),nullif(upper(btrim(country_code)),''))='GB' and role in('customer','driver') and tenant_id is not null")"
check 'P8 missing tenant setting inherits current platform NG defaults before GB activation' "$(q movabi_develop -c "select (value->>'maxSurge')||'/'||(value#>>'{markets,NG,maxSurge}')||'/'||(value#>>'{markets,GB,maxSurge}') from public.marketplace_settings where tenant_id='5a5a5a5a-0000-4000-8000-000000000001' and key='dynamic_pricing'")" '2.4/2.2/1.5'
echo 'P8_COMPOSITE_REHEARSAL_OK: aggregate preflight + rolled-back exact activation + audited atomic apply + isolation checks'
