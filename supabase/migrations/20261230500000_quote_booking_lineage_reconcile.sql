-- =============================================================================
-- 20261230500000_quote_booking_lineage_reconcile.sql
--
-- PURPOSE — CONVERGENCE / LINEAGE ONLY.
--
-- This migration does NOT introduce new product behaviour. It records schema
-- corrections that are ALREADY LIVE in production as a result of earlier
-- controlled emergency repairs, so that the repository can once again describe
-- the database it depends on. Creating this file is NOT permission to execute
-- anything against production.
--
-- WHY IT IS NEEDED
--   The repository previously contained NO tracked declaration of jobs.quote_id
--   even though committed server code reads and writes it, and quote
--   verification depends on it:
--       * POST /api/booking/create compares the caller's verified quote against
--         jobs.quote_id and returns 409 QUOTE_INPUT_CHANGED on mismatch.
--       * The idempotency guard looks up an existing job by
--         .eq('quote_id', ...).eq('customer_id', ...).
--       * Production raised 42703 `column "quote_id" of relation "jobs" does not
--         exist`, after which the column was added out-of-band by a controlled
--         repair. That repair was never represented in the repository, so a
--         fresh environment could not reproduce the column and
--         accept_original_fare would depend on untracked lineage.
--
-- TYPE FIDELITY (IMPORTANT)
--   jobs.quote_id is declared UUID because that is the PROVEN LIVE TYPE: the
--   value originates from randomUUID() in the quote route.
--
--   The three quote-provenance columns on public.quote_market_adjustments are
--   declared TEXT because that is the PROVEN LIVE SHAPE — production added them
--   as text during the emergency repair. Older intended DDL in
--   server/gb-app-store-launch-pricing-migration.txt proposed
--   varchar(2) / varchar(120) / uuid. This migration DELIBERATELY does NOT
--   "correct" them: there is no repository evidence that a narrowing type change
--   is safe against live data, and a failed ALTER TYPE would be destructive.
--   No type-changing migration is introduced here. If convergence to the
--   originally intended types is ever wanted, it must be a separate, separately
--   verified task with a data audit — not a silent side effect of lineage work.
--
-- IDEMPOTENT AND ADDITIVE ONLY: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS. No DROP, no ALTER TYPE, no constraint rewrites, no data changes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. jobs.quote_id — authoritative quote linkage for booking + negotiation.
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS quote_id UUID;

COMMENT ON COLUMN public.jobs.quote_id IS
  'Authoritative quote reference. UUID (proven live type; value originates from randomUUID() in the pricing quote route). Nullable: legacy jobs predate quote linkage.';

-- ---------------------------------------------------------------------------
-- 2. At most one job per quote reference.
--    The booking route relies on this for idempotency: a repeated
--    POST /api/booking/create for the same verified quote must resolve to the
--    existing job rather than creating a second one. Partial index so the many
--    legacy NULL rows are unaffected.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_quote_reference
  ON public.jobs(quote_id)
  WHERE quote_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Quote provenance columns on public.quote_market_adjustments.
--    Declared TEXT to match the proven live shape (see TYPE FIDELITY above).
--    These are read during booking quote verification (country_code and
--    market_city participate in the verified-input comparison).
-- ---------------------------------------------------------------------------
ALTER TABLE public.quote_market_adjustments
  ADD COLUMN IF NOT EXISTS country_code TEXT;

ALTER TABLE public.quote_market_adjustments
  ADD COLUMN IF NOT EXISTS market_city TEXT;

ALTER TABLE public.quote_market_adjustments
  ADD COLUMN IF NOT EXISTS zone_id TEXT;

COMMENT ON COLUMN public.quote_market_adjustments.country_code IS
  'Provenance recorded at quote time. TEXT to match the live production shape added during the emergency repair (see migration header).';
COMMENT ON COLUMN public.quote_market_adjustments.market_city IS
  'Provenance recorded at quote time. TEXT to match the live production shape (see migration header).';
COMMENT ON COLUMN public.quote_market_adjustments.zone_id IS
  'Provenance recorded at quote time. TEXT to match the live production shape (see migration header).';

-- ---------------------------------------------------------------------------
-- NOT INCLUDED DELIBERATELY
--   * No DDL for public.quote_market_adjustments itself, and none for
--     quote_reference / returned_customer_fare. Those definitions remain
--     UNTRACKED in the repository (the pricing/quote schema is largely
--     unversioned). Fabricating the whole pricing table from guesswork would
--     invent types, defaults and constraints — explicitly out of scope. This is
--     why accept_original_fare remains blocked on lineage (see the negotiation
--     authority migration).
--   * No RLS changes, no policy changes, no trigger changes, no grants.
-- =============================================================================
