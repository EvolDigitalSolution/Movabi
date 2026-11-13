-- Real-data drill preamble for the behaviour suites. Inserted right after each suite's own "BEGIN;",
-- so it is part of that suite's transaction and is rolled back with it (each suite ends in ROLLBACK).
-- The suites were written for an empty schema clone; on a copy of develop's real data two things differ:
--  * develop's on_auth_user_created trigger (migration 20260407000000) creates a profile for every new
--    auth.users row, so the suites' explicit fixture profiles would collide with it;
--  * develop's own market_availability rows occupy the GB/NG scopes the suites create as fixtures;
--  * develop's own service_types own the ride/delivery/errand slugs the suites create as fixtures
--    (referenced only by id, so renaming the slugs inside the transaction changes no reference).
-- Neither is behaviour under test. Nothing here survives the suite's ROLLBACK.
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;
DELETE FROM public.market_availability;
UPDATE public.service_types SET slug = slug || '-predrill';
