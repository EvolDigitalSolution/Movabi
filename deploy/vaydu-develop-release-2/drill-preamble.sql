-- Real-data drill preamble for the behaviour suites (release 2). host-db-release.sh inserts it right after
-- each suite's own "BEGIN;", so it runs inside that suite's transaction and is ROLLED BACK with it (every
-- suite ends in ROLLBACK). Only the THROWAWAY restored copy is ever touched; nothing here survives.
-- The suites were written for an empty schema clone; on a copy of develop's real data these differ:
--  * develop's on_auth_user_created trigger creates a profile for every new auth.users row, so the suites'
--    explicit fixture profiles collide with it (profiles_pkey);
--  * develop's market_availability rows occupy the GB/NG scopes the suites create as fixtures
--    (idx_market_availability_unique_scope);
--  * develop's service types own the ride/delivery/errand slugs, so the suites' fixture service types are
--    skipped by ON CONFLICT DO NOTHING; jobs then reference a missing service type (merge suite: 23503,
--    MB003, no reservation, CE006, CE002; proven by scripts/release/reproduce-host-drill.sh DIAG_MERGE=1).
--    service_types is referenced only by id, so renaming slugs changes no reference;
--  * cash-market and cash-config rows (none on develop today; present after a GB cash activation) occupy
--    the GB/GBP scope the suites create as fixtures.
-- None of these is behaviour under test. No assertion of any suite is changed.
DO $drill_preamble$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='on_auth_user_created' AND tgrelid='auth.users'::regclass) THEN
    ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;
  END IF;
END $drill_preamble$;
DELETE FROM public.market_availability;
UPDATE public.service_types SET slug = slug || '-predrill';
DELETE FROM public.driver_cash_credit_markets_v1e;
DELETE FROM public.driver_cash_credit_config_v1e;
