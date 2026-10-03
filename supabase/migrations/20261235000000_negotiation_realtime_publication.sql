-- =============================================================================
-- 20261235000000_negotiation_realtime_publication.sql
--
-- PRODUCTION-PROVEN DEFECT (driver counter never reaches the customer live)
--   Both negotiation screens subscribe to `postgres_changes` on
--   public.marketplace_negotiation_sessions and
--   public.marketplace_negotiation_events. Supabase Realtime only delivers
--   changes for tables that belong to the `supabase_realtime` PUBLICATION — and
--   NEITHER of these tables was ever added to it. Every other table the app
--   subscribes to was added explicitly (`job_messages`, `errand_funding`,
--   `errand_details`, `job_issuing_*`), so this is an omission, not a policy:
--   the client subscription is correctly scoped and correctly filtered, it simply
--   can never receive a WAL event.
--
--   Consequence: a successful driver_counter_offer never converged to an open
--   customer page (it only appeared after leaving/re-entering), and a lease
--   release/reassignment could not converge either. Client-side retries cannot
--   fix this — the missing membership is the authoritative gate.
--
-- WHAT THIS MIGRATION DOES
--   Additively enrolls the two tables in `supabase_realtime`. Idempotent, and a
--   no-op on any environment where the publication does not exist (e.g. a plain
--   PostgreSQL without Realtime).
--
-- REPLICA IDENTITY: left at the default deliberately. The client never treats a
--   payload as authoritative — both screens REQUEST A FULL RELOAD on any change —
--   so the default identity is sufficient, while the filters used by the client
--   still resolve (INSERT carries the whole row; the sessions filter uses the
--   primary key `id`, which the default identity always includes).
--
-- DELIBERATELY UNCHANGED: no RLS change (310's SELECT-only
--   `hybrid_sessions_owner_or_driver` / `hybrid_events_participants` already
--   permit the two participants), no schema change, no function change.
--   Migrations 305/310/320/330/340 are NOT touched.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE '[negotiation-realtime] publication supabase_realtime absent; nothing to do';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'marketplace_negotiation_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_negotiation_sessions;
    RAISE NOTICE '[negotiation-realtime] added marketplace_negotiation_sessions';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'marketplace_negotiation_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_negotiation_events;
    RAISE NOTICE '[negotiation-realtime] added marketplace_negotiation_events';
  END IF;
END $$;
