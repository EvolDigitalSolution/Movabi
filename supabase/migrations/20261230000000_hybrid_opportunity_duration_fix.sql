-- =============================================================================
-- 20261230000000_hybrid_opportunity_duration_fix.sql
--
-- Bounded corrective migration for public.fetch_hybrid_opportunities.
--
-- DEFECT (production-proven):
--   jobs.metadata->>'duration_seconds' legitimately contains FRACTIONAL seconds
--   (e.g. "643.9", which is the routing-service duration 643.9s = 10.73min).
--   The function parsed it as a strict integer literal:
--       (j.metadata->>'duration_seconds')::INTEGER
--   which aborts the whole RPC with:
--       22P02  invalid input syntax for type integer: "643.9"
--   As a result drivers received NO hybrid opportunities at all, because the
--   client's fetchHybridOpportunities() catch swallows the error and sets [].
--
--   jobs.duration_seconds (top-level INTEGER column) already holds the rounded
--   value 644; only the free-form metadata copy was fractional. metadata is
--   free-form JSON, so any writer may store a non-integer, empty, or malformed
--   value -- the function must therefore never raise on it.
--
-- FIX:
--   Regex-guarded conversion following the existing repo convention (compare
--   scripts/db/preflight_20260925000000_driver_compliance_eligibility_phase_a.sql,
--   which guards date casts with `~ '^\d{4}-\d{2}-\d{2}$'`).
--     643.9  -> 644
--     643    -> 643
--     ''     -> NULL
--     missing-> NULL
--     'abc'  -> NULL   (no exception)
--     absurd -> clamped to INTEGER max (no 22003 overflow exception)
--
--   distance_km gets the same guard because it is the identical defect class in
--   the same SELECT and would otherwise still crash the RPC on malformed input.
--   Its declared return type stays NUMERIC.
--
-- SECURITY (must not regress):
--   The driver identity-binding guard introduced by
--   20261203000000_release_authority_hardening.sql is RESTATED here verbatim.
--   The incremental reconcile definition had lost it, so a re-run of that file
--   would have silently removed the protection and let any authenticated driver
--   fetch another driver's opportunity set by passing a foreign p_driver_id.
--
-- Unchanged: function name, parameter signature (uuid), returned column contract,
-- negotiation/fare rules, RLS policies, session timeout, jobs statuses,
-- acquisition trigger state, service taxonomy, payment/Stripe behaviour.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fetch_hybrid_opportunities(
  p_driver_id UUID
)
RETURNS TABLE (
  session_id UUID,
  job_id UUID,
  customer_id UUID,
  suggested_fare NUMERIC,
  customer_offer NUMERIC,
  distance_km NUMERIC,
  eta_seconds INTEGER,
  service_name TEXT,
  service_slug TEXT,
  pickup_address TEXT,
  dropoff_address TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Release closure: a driver may only fetch their own opportunities.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only fetch your own opportunities';
  END IF;

  RETURN QUERY
  SELECT
    s.id AS session_id,
    s.job_id,
    s.customer_id,
    s.suggested_fare,
    s.customer_offer,
    -- Free-form metadata: convert only when it is a plain non-negative decimal,
    -- otherwise NULL. Never raise (22P02) on malformed legacy values.
    CASE
      WHEN BTRIM(j.metadata->>'distance_km') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (BTRIM(j.metadata->>'distance_km'))::NUMERIC
      ELSE NULL
    END AS distance_km,
    -- Fractional seconds are expected (643.9 -> 644). Clamped so an absurd value
    -- cannot raise 22003 integer out of range either.
    CASE
      WHEN BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN LEAST(2147483647::NUMERIC, ROUND((BTRIM(j.metadata->>'duration_seconds'))::NUMERIC))::INTEGER
      ELSE NULL
    END AS eta_seconds,
    COALESCE(st.name, 'Request') AS service_name,
    COALESCE(st.slug, '') AS service_slug,
    j.pickup_address,
    j.dropoff_address
  FROM public.marketplace_negotiation_sessions s
  JOIN public.jobs j ON j.id = s.job_id
  LEFT JOIN public.service_types st ON st.id = j.service_type_id
  WHERE s.status IN ('open', 'released')
    AND s.active_driver_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_job_declines d
      WHERE d.driver_id = p_driver_id AND d.job_id = s.job_id
    );
END;
$$;

-- ACL unchanged: authenticated + service_role only, never PUBLIC/anon.
REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(uuid) TO authenticated, service_role;
