-- Batch 1: canonical driver self-accept lifecycle.
--
-- Two DISTINCT RPCs are preserved, because the repository proves they are not
-- semantically equivalent:
--
--   accept_searching_job  = DRIVER SELF-ACCEPT. The driver personally claims an
--                           open request. Sets driver_id, accepted_driver_id and
--                           accepted_at, and lands on status 'accepted' - the first
--                           actionable Driver Job Details state.
--
--   assign_driver_to_job  = ADMIN/DISPATCH ASSIGNMENT. An operator assigns a driver
--                           who has NOT personally accepted yet. Sets driver_id only
--                           and lands on status 'assigned'. accepted_driver_id and
--                           accepted_at are deliberately left untouched.
--
-- The two functions are intentionally NOT collapsed into one another.
--
-- This migration only corrects accept_searching_job, and contains NO data
-- migration: existing rows are never rewritten.

-- ============================================================================
-- PREREQUISITE HELPER — vehicle/job compatibility
--
-- Production does NOT contain this function, and both accept RPCs below call it,
-- so the migration must create it itself. Without it the migration would apply
-- cleanly (PL/pgSQL bodies are resolved at FIRST EXECUTION, not at CREATE time)
-- and then every accept and every admin assignment would fail at runtime with
-- SQLSTATE 42883. Creating it here removes that trap.
--
-- Semantics are the proven historical ones (supabase_incremental_schema_reconcile.sql
-- lines 2142-2232), hardened:
--   * every table reference is schema-qualified (the historical body relied on a
--     caller-side search_path that happened to include public)
--   * search_path is pinned
--   * SECURITY INVOKER is retained: this is a pure read-only predicate and needs
--     no elevated rights
--   * production has NO vehicles.service_class column, so compatibility text is
--     read via to_jsonb(row)->>'service_class' (absent key -> NULL -> ''), which
--     the historical implementation already did
--   * NULL-safe throughout: a missing job or missing vehicle returns FALSE
-- ============================================================================
CREATE OR REPLACE FUNCTION public.driver_vehicle_can_accept_job(
    p_job_id UUID,
    p_driver_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_required TEXT;
    v_service_slug TEXT;
    v_metadata JSONB;
    v_vehicle RECORD;
    v_vehicle_text TEXT;
BEGIN
    IF p_job_id IS NULL OR p_driver_id IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT
        COALESCE(
            (SELECT COALESCE(st.slug::TEXT, st.name::TEXT)
               FROM public.service_types st
              WHERE st.id = j.service_type_id),
            j.metadata ->> 'service_slug',
            ''
        ),
        COALESCE(j.metadata, '{}'::jsonb)
    INTO v_service_slug, v_metadata
    FROM public.jobs j
    WHERE j.id = p_job_id;

    -- Missing job -> not acceptable.
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    v_required := LOWER(COALESCE(
        v_metadata ->> 'service_vehicle_class',
        v_metadata ->> 'vehicle_class',
        v_metadata ->> 'vehicleClass',
        v_metadata #>> '{ride_details,vehicle_class}',
        v_metadata #>> '{delivery_details,vehicleClass}',
        v_metadata #>> '{errand_details,vehicleClass}',
        ''
    ));

    IF v_required LIKE '%bike%' OR v_required LIKE '%motorcycle%' OR v_required LIKE '%scooter%' THEN
        v_required := 'bike';
    ELSIF v_required LIKE '%minibus%' OR v_required LIKE '%7 seater%' OR v_required LIKE '%7-seater%' THEN
        v_required := 'minibus';
    ELSIF v_required LIKE '%large_van%' OR v_required LIKE '%large van%' OR v_required LIKE '%luton%' THEN
        v_required := 'large_van';
    ELSIF v_required LIKE '%small_van%' OR v_required LIKE '%small van%' OR v_required LIKE '%van%' THEN
        v_required := 'small_van';
    ELSIF v_required LIKE '%xl%' OR v_required LIKE '%7%' THEN
        v_required := 'xl';
    ELSIF v_required LIKE '%standard%' THEN
        v_required := 'standard';
    ELSIF v_required LIKE '%car%' THEN
        v_required := 'car';
    ELSIF LOWER(v_service_slug) LIKE '%van%' OR LOWER(v_service_slug) LIKE '%moving%' THEN
        v_required := 'small_van';
    ELSIF LOWER(v_service_slug) LIKE '%delivery%' OR LOWER(v_service_slug) LIKE '%errand%' THEN
        v_required := 'car';
    ELSE
        v_required := 'standard';
    END IF;

    SELECT * INTO v_vehicle
    FROM public.vehicles
    WHERE user_id = p_driver_id
    LIMIT 1;

    -- Missing vehicle -> not acceptable.
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- service_class has no physical column in production; read it from the row
    -- as JSON so an absent key degrades to '' instead of erroring.
    v_vehicle_text := LOWER(
        COALESCE(to_jsonb(v_vehicle) ->> 'type', '') || ' ' ||
        COALESCE(to_jsonb(v_vehicle) ->> 'capacity', '') || ' ' ||
        COALESCE(to_jsonb(v_vehicle) ->> 'service_class', '')
    );

    IF v_vehicle_text LIKE '%bike%' OR v_vehicle_text LIKE '%motorcycle%' OR v_vehicle_text LIKE '%scooter%' THEN
        RETURN v_required = 'bike';
    END IF;

    IF v_vehicle_text LIKE '%minibus%' OR v_vehicle_text LIKE '%7 seater%' OR v_vehicle_text LIKE '%7-seater%' OR v_vehicle_text LIKE '%xl%' OR v_vehicle_text LIKE '%7%' THEN
        RETURN v_required IN ('standard', 'xl', 'minibus', 'car');
    END IF;

    IF v_vehicle_text LIKE '%large_van%' OR v_vehicle_text LIKE '%large van%' OR v_vehicle_text LIKE '%luton%' THEN
        RETURN v_required IN ('standard', 'xl', 'car', 'small_van', 'large_van');
    END IF;

    IF v_vehicle_text LIKE '%small_van%' OR v_vehicle_text LIKE '%small van%' OR v_vehicle_text LIKE '%van%' THEN
        RETURN v_required IN ('standard', 'car', 'small_van');
    END IF;

    RETURN v_required IN ('standard', 'car');
END;
$$;

-- ============================================================================
-- DRIVER SELF-ACCEPT
--
-- Production's existing function is public.accept_searching_job(uuid, uuid)
-- RETURNS public.jobs, with ZERO dependent objects (verified on production).
-- Batch 1 requires a BOOLEAN contract so the client can distinguish "I won the
-- claim" from "another driver won". CREATE OR REPLACE cannot change a return
-- type, so the old signature is dropped here (NO CASCADE) and immediately
-- recreated in the same migration - there is no cross-migration window.
-- ============================================================================
DROP FUNCTION IF EXISTS public.accept_searching_job(uuid, uuid);

CREATE OR REPLACE FUNCTION public.accept_searching_job(
    p_job_id UUID,
    p_driver_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller UUID := auth.uid();
BEGIN
    IF p_job_id IS NULL OR p_driver_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id and p_driver_id are required';
    END IF;

    -- Browser/authenticated callers may only claim work for themselves.
    -- service_role calls have no auth.uid() and remain available to trusted server code.
    IF v_caller IS NOT NULL AND v_caller <> p_driver_id THEN
        RAISE EXCEPTION 'A driver may only accept a request for themselves';
    END IF;

    IF NOT public.driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
        RAISE EXCEPTION 'Driver vehicle is not compatible with this request';
    END IF;

    UPDATE public.jobs
    SET driver_id = p_driver_id,
        accepted_driver_id = p_driver_id,
        status = 'accepted',
        accepted_at = NOW(),
        updated_at = NOW()
    WHERE id = p_job_id
      -- Exactly the statuses the driver UI advertises as available
      -- (driver.service.ts availableRequestStatuses + the realtime filter +
      --  dispatch.service.ts, which writes 'broadcasting' and 'waiting').
      AND status IN ('pending', 'requested', 'searching', 'broadcasting', 'waiting')
      AND driver_id IS NULL
      AND accepted_driver_id IS NULL;

    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_driver_to_job(
    p_job_id UUID,
    p_driver_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
    IF NOT public.driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
        RAISE EXCEPTION 'Driver vehicle is not compatible with this request';
    END IF;

    UPDATE public.jobs
    SET driver_id = p_driver_id,
        status = 'assigned',
        updated_at = NOW()
    WHERE id = p_job_id
      AND status IN ('pending', 'requested', 'searching')
      AND driver_id IS NULL;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Driver confirmation of an ADMIN/DISPATCH assignment.
--
-- assign_driver_to_job places a driver on a job as 'assigned' without that driver
-- having personally accepted it. This function is the only operation that lets the
-- already-assigned driver convert their own assignment into a personal acceptance.
--
-- Distinct from accept_searching_job on purpose: that function claims an OPEN
-- request (driver_id IS NULL) and must keep its marketplace race protection. Here
-- the job already has driver_id set, so this is a confirmation, not a claim.
--
-- Caller identity comes from auth.uid() and is never taken from the request body.
-- p_driver_id only exists so trusted server code can confirm on behalf of the
-- authenticated caller; if supplied it MUST equal the caller.
CREATE OR REPLACE FUNCTION public.accept_assigned_job(
    p_job_id UUID,
    p_driver_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller UUID := auth.uid();
BEGIN
    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id is required';
    END IF;

    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required to confirm an assignment';
    END IF;

    IF p_driver_id IS NOT NULL AND p_driver_id <> v_caller THEN
        RAISE EXCEPTION 'A driver may only confirm a request assigned to themselves';
    END IF;

    -- Atomic: only the driver already stored on the job may confirm it, only from
    -- 'assigned', and only while accepted_driver_id is still unset. A repeat call
    -- matches no row and returns FALSE without raising.
    UPDATE public.jobs
    SET status = 'accepted',
        accepted_driver_id = v_caller,
        accepted_at = NOW(),
        updated_at = NOW()
    WHERE id = p_job_id
      AND status = 'assigned'
      AND driver_id = v_caller
      AND accepted_driver_id IS NULL;

    RETURN FOUND;
END;
$$;

-- The helper is an internal predicate called only from the two accept functions
-- below. It must NOT be client-callable, so PUBLIC's default EXECUTE is revoked
-- and no role grant is issued: the SECURITY DEFINER caller already has the
-- necessary rights. Leaving PUBLIC EXECUTE would let any authenticated client
-- probe driver/job vehicle compatibility directly.
REVOKE ALL ON FUNCTION public.driver_vehicle_can_accept_job(UUID, UUID) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.accept_searching_job(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_driver_to_job(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_assigned_job(UUID, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.accept_searching_job(UUID, UUID)
TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.assign_driver_to_job(UUID, UUID)
TO authenticated, service_role;

-- Only authenticated drivers need this confirmation, so it is not granted to service_role.
GRANT EXECUTE ON FUNCTION public.accept_assigned_job(UUID, UUID)
TO authenticated;

-- ============================================================================
-- Atomic wallet-reservation settlement for job completion.
--
-- Replaces a Node-side sequence of independent PostgREST calls (read wallet,
-- update balances, insert ledger rows, update errand_funding) which had no
-- transaction: a crash between the balance mutation and the settlement marker
-- left the wallet debited with no durable evidence, so a completion retry could
-- debit the same reservation twice.
--
-- Everything below runs in ONE transaction. Either all effects commit (balance
-- mutation + ledger rows + errand_funding marker) or none do. The caller's amount
-- is only an upper bound; the settled amount is re-derived from DB state.
--
-- Server-side only: granted to service_role, never to authenticated/PUBLIC.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.settle_job_wallet_reservation(
    p_job_id UUID,
    p_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job RECORD;
    v_wallet RECORD;
    v_funding RECORD;
    v_amount NUMERIC;
    v_reserved NUMERIC;
    v_available NUMERIC;
    v_job_reserved NUMERIC;
    v_reservation_amount NUMERIC;
    v_settlement_amount NUMERIC;
    v_refund_amount NUMERIC;
    v_actual_spending NUMERIC := 0;
    v_service_slug TEXT;
    -- Wallet state captured for the audit columns on each ledger event.
    v_available_before NUMERIC;
    v_reserved_before NUMERIC;
    v_available_after_settlement NUMERIC;
    v_reserved_after_settlement NUMERIC;
    v_available_after_release NUMERIC;
    v_reserved_after_release NUMERIC;
    v_now TIMESTAMPTZ := NOW();
BEGIN
    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id is required';
    END IF;

    v_amount := ROUND(COALESCE(p_amount, 0)::NUMERIC, 2);

    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'Wallet settlement amount must be greater than zero';
    END IF;

    -- Lock order is fixed (jobs -> wallets -> errand_funding) to match the existing
    -- reserve_errand_funds / release_job_wallet_reservation RPCs and avoid
    -- deadlocks. The job lock serialises concurrent settlements for the same job.
    SELECT *
    INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF v_job IS NULL THEN
        RAISE EXCEPTION 'Job not found for wallet settlement';
    END IF;

    IF v_job.customer_id IS NULL THEN
        RAISE EXCEPTION 'Job has no customer to settle against';
    END IF;

    SELECT *
    INTO v_wallet
    FROM public.wallets
    WHERE user_id = v_job.customer_id
    FOR UPDATE;

    IF v_wallet IS NULL THEN
        -- Nothing reserved to settle. Never create a settlement without a wallet.
        RETURN jsonb_build_object('status', 'not_wallet_job', 'job_id', p_job_id, 'reason', 'Wallet not found');
    END IF;

    -- Settlement marker read under the wallet lock (same order as reserve_errand_funds).
    SELECT *
    INTO v_funding
    FROM public.errand_funding
    WHERE job_id = p_job_id
    FOR UPDATE;

    IF v_funding IS NOT NULL AND LOWER(COALESCE(v_funding.status, '')) = 'settled' THEN
        RETURN jsonb_build_object(
            'status', 'already_settled',
            'job_id', p_job_id,
            'amount_settled', COALESCE((v_funding.metadata -> 'settlement' ->> 'amount_settled')::NUMERIC, 0)
        );
    END IF;

    v_reserved := ROUND(GREATEST(COALESCE(v_wallet.reserved_balance, 0), 0)::NUMERIC, 2);
    v_available := ROUND(GREATEST(COALESCE(v_wallet.available_balance, 0), 0)::NUMERIC, 2);

    -- Derive the amount from DB state, never trust the caller blindly.
    IF v_funding IS NOT NULL THEN
        v_job_reserved := ROUND(GREATEST(COALESCE(v_funding.amount_reserved, 0), 0)::NUMERIC, 2);
    ELSE
        v_job_reserved := v_amount;
    END IF;

    -- jobs has no service_slug column in this schema: it is resolved from
    -- service_types.slug with a metadata->>'service_slug' fallback, exactly as
    -- driver_vehicle_can_accept_job does. The subquery always yields one row so
    -- v_service_slug is always assigned.
    SELECT COALESCE(
        (SELECT COALESCE(st.slug::TEXT, st.name::TEXT)
         FROM public.service_types st
         WHERE st.id = v_job.service_type_id),
        v_job.metadata ->> 'service_slug',
        ''
    ) INTO v_service_slug;

    -- Errand settlement follows actual spend when it was recorded, matching the
    -- existing completion rules. The errand_details existence test is deliberate:
    -- if service_types or the metadata slug cannot resolve, an errand must still be
    -- recognised so the actual_spending cap cannot be silently skipped (which would
    -- over-settle up to the full reservation).
    IF LOWER(COALESCE(v_service_slug, '')) = 'errand'
       OR EXISTS (
           SELECT 1
           FROM public.errand_details ed
           WHERE ed.job_id = p_job_id
       )
    THEN
        SELECT COALESCE(actual_spending, 0)
        INTO v_actual_spending
        FROM public.errand_details
        WHERE job_id = p_job_id
        LIMIT 1;

        v_actual_spending := ROUND(GREATEST(COALESCE(v_actual_spending, 0), 0)::NUMERIC, 2);

        IF v_actual_spending > 0 THEN
            v_amount := ROUND(LEAST(v_amount, v_actual_spending)::NUMERIC, 2);
        END IF;
    END IF;

    v_reservation_amount := ROUND(LEAST(v_reserved, v_job_reserved)::NUMERIC, 2);
    v_settlement_amount := ROUND(LEAST(v_reservation_amount, v_amount)::NUMERIC, 2);
    v_refund_amount := ROUND(GREATEST(v_reservation_amount - v_settlement_amount, 0)::NUMERIC, 2);

    IF v_settlement_amount <= 0 THEN
        -- No marker write: a retry must still be able to settle if a reservation
        -- appears later. Returning without mutating anything is safe.
        RETURN jsonb_build_object('status', 'not_wallet_job', 'job_id', p_job_id, 'reason', 'Customer wallet reservation is empty');
    END IF;

    -- 1. Balance mutation.
    --
    -- The wallet update is a single atomic statement. The net effect is
    --   reserved  -= settlement + refund   (== v_reservation_amount)
    --   available += refund
    -- and that single UPDATE is exactly equivalent to performing the settlement
    -- event followed by the release event. Expressing it once keeps the mutation
    -- atomic; the per-event before/after values recorded on each ledger row below
    -- are what describe the two events individually.
    v_available_before := v_available;
    v_reserved_before := v_reserved;

    -- Settlement event: money leaves the reservation permanently.
    v_available_after_settlement := v_available_before;
    v_reserved_after_settlement := ROUND(GREATEST(v_reserved_before - v_settlement_amount, 0)::NUMERIC, 2);

    -- Release event: the unused remainder of the reservation goes back to available.
    v_available_after_release := ROUND((v_available_after_settlement + v_refund_amount)::NUMERIC, 2);
    v_reserved_after_release := ROUND(GREATEST(v_reserved_before - v_reservation_amount, 0)::NUMERIC, 2);

    UPDATE public.wallets
    SET available_balance = v_available_after_release,
        reserved_balance = v_reserved_after_release,
        updated_at = v_now
    WHERE user_id = v_job.customer_id;

    -- 2. Settlement ledger row.
    -- Production has wallet_transactions.transaction_type (and no `type` column),
    -- so this is a direct insert: no runtime column-variant probing.
    INSERT INTO public.wallet_transactions (
        wallet_id, user_id, job_id, amount, transaction_type, description, metadata,
        balance_before_available, balance_after_available,
        balance_before_reserved, balance_after_reserved
    )
    VALUES (
        v_wallet.id, v_job.customer_id, p_job_id, v_settlement_amount, 'settlement',
        'Job payment settled from wallet reservation',
        jsonb_build_object(
            'payment_method', 'wallet',
            'currency_code', COALESCE(v_job.currency_code, 'GBP'),
            'settled_at', v_now
        ),
        v_available_before, v_available_after_settlement,
        v_reserved_before, v_reserved_after_settlement
    );

    -- 3. Release ledger row for the unused reservation (only when something is
    --    returned). Its before/after values describe the RELEASE event alone, so
    --    they are not a copy of the settlement snapshot.
    IF v_refund_amount > 0 THEN
        INSERT INTO public.wallet_transactions (
            wallet_id, user_id, job_id, amount, transaction_type, description, metadata,
            balance_before_available, balance_after_available,
            balance_before_reserved, balance_after_reserved
        )
        VALUES (
            v_wallet.id, v_job.customer_id, p_job_id, v_refund_amount, 'release',
            'Unused errand wallet reservation returned',
            jsonb_build_object(
                'payment_method', 'wallet',
                'currency_code', COALESCE(v_job.currency_code, 'GBP'),
                'released_at', v_now,
                'reason', 'actual_spending_below_reserved_amount'
            ),
            v_available_after_settlement, v_available_after_release,
            v_reserved_after_settlement, v_reserved_after_release
        );
    END IF;

    -- 4. Settlement marker. Written in the same transaction as the debit, so it can
    -- never record a settlement that was rolled back, and a committed debit can
    -- never exist without it.
    IF v_funding IS NOT NULL THEN
        UPDATE public.errand_funding
        SET status = 'settled',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'settlement', jsonb_build_object(
                    'amount_settled', v_settlement_amount,
                    'amount_released', v_refund_amount,
                    'settled_at', v_now
                )
            ),
            updated_at = v_now
        WHERE job_id = p_job_id;
    END IF;

    RETURN jsonb_build_object(
        'status', 'settled',
        'job_id', p_job_id,
        'amount_settled', v_settlement_amount,
        'amount_released', v_refund_amount
    );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_job_wallet_reservation(UUID, NUMERIC) FROM PUBLIC;

-- Moves money and is only ever called by trusted server code.
GRANT EXECUTE ON FUNCTION public.settle_job_wallet_reservation(UUID, NUMERIC)
TO service_role;

-- No data migration is performed here.
-- Rows currently in 'assigned' are a legitimate admin/dispatch state (a driver the
-- operator assigned who has NOT personally accepted). They are deliberately left
-- untouched: rewriting them to 'accepted' would collapse the two semantics and
-- manufacture accepted_at values for historical jobs.
