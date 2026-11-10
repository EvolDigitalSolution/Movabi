-- =============================================================================
-- 20261237000000_driver_opportunity_lifecycle_guard.sql
--
-- PRODUCTION-PROVEN DEFECT (driver "dead card")
--   fetch_hybrid_opportunities (re-issued by 320 and again by 360) filters the
--   NEGOTIATION SESSION but never the underlying JOB:
--
--     WHERE s.status IN ('open','released')
--       AND s.active_driver_id IS NULL
--       AND public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)
--       AND s.expires_at > now()
--       AND NOT EXISTS (... driver_job_declines ...)
--
--   Nothing constrains jobs.status. A session left in ('open','released') whose
--   JOB is cancelled / completed / expired / already paid+assigned is therefore
--   still returned as an "opportunity" — a card the driver cannot act on,
--   because every negotiation action re-checks jobs.status and raises.
--
-- POSITIVE ALLOWLIST (derived from existing authority, not invented)
--   Three independent migrations agree on the job statuses on which negotiation
--   actions are legal, and each refuses otherwise:
--     * 20261231000000 (lifecycle authority)  : IF v_job.status NOT IN (...)
--     * 20261232000000 (eligibility parity)   : IF v_job.status NOT IN (...)
--     * 20261234000000 (lease release)        : IF v_job.status NOT IN (...)
--   The consistent set is:
--
--     ('pending_fare_confirmation', 'negotiating', 'open')
--
--   Discovery now returns EXACTLY the sessions whose job is in that set, so the
--   invariant holds by construction:
--
--     VISIBLE OPPORTUNITY  =>  AN ACTION THAT AUTHORITY WILL ACCEPT
--
--   Why each member belongs:
--     pending_fare_confirmation - the canonical marketplace request state: open
--                                 for negotiation, not yet fare-agreed.
--     negotiating               - a live negotiation is in progress; eligible
--                                 drivers may still claim/counter.
--     open                      - the generic pre-dispatch request state used by
--                                 non-negotiation marketplace flows.
--   Why each excluded state must NOT appear:
--     cancelled / customer_declined job - terminal customer cancellation.
--     completed / settled              - work is done.
--     expired                          - overall marketplace deadline passed.
--     assigned / searching / *_in_progress / delivered etc. - the job already has
--                                 a driver or is paid+dispatched active work; it
--                                 must never surface as a negotiable opportunity.
--
--   An allowlist is used deliberately instead of an ever-growing terminal
--   denylist: a newly introduced job status then fails CLOSED (hidden) rather
--   than leaking as a dead card.
--
-- SCOPE: re-issues ONLY fetch_hybrid_opportunities. Everything else from
--   320/340/360 is preserved verbatim, including:
--     * the 340 stale-lease release sweep;
--     * the 360 unpaid-agreement expiry sweep;
--     * the 320 vehicle/service eligibility predicate;
--     * the driver_job_declines exclusion (which is what intentionally bars a
--       driver who released the request from seeing it again);
--     * the identity guard, expiry semantics, return shape and ACLs.
--   Migration 360 is NOT modified. No release authority is changed.
--
-- DELIBERATELY UNCHANGED: Stripe/payment authority, fare/settlement maths, RLS,
--   eligibility rules, and the frozen occupying-status taxonomy.
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
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only fetch your own opportunities';
  END IF;

  -- 360: lapsed unpaid agreements release back to the market (or terminalise).
  PERFORM public.expire_unpaid_fare_agreement(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.status = 'fare_agreed'
    AND COALESCE(s.payment_deadline, s.expires_at) IS NOT NULL
    AND COALESCE(s.payment_deadline, s.expires_at) <= now();

  -- 340: lapsed claimed leases release back to the market.
  PERFORM public.release_stale_negotiation_lease(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.active_driver_id IS NOT NULL
    AND s.status IN ('open', 'driver_claimed', 'negotiating')
    AND s.expires_at IS NOT NULL
    AND s.expires_at <= now();

  RETURN QUERY
  SELECT
    s.id AS session_id,
    s.job_id,
    s.customer_id,
    s.suggested_fare,
    s.customer_offer,
    CASE
      WHEN BTRIM(j.metadata->>'distance_km') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (BTRIM(j.metadata->>'distance_km'))::NUMERIC
      ELSE NULL
    END AS distance_km,
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
    -- THE GUARD (370): the underlying job must still be genuinely negotiable.
    -- This is the SAME allowlist every negotiation action already enforces, so
    -- discovery can never surface a card the actions would reject.
    AND j.status IN ('pending_fare_confirmation', 'negotiating', 'open')
    AND public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)
    AND s.expires_at > now()
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_job_declines d
      WHERE d.driver_id = p_driver_id AND d.job_id = s.job_id
    );
END;
$$;

-- ACL — unchanged from 320/360: client-executable for authenticated drivers,
-- anon revoked, service_role retained.
REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) TO authenticated, service_role;
