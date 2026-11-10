-- ============================================================================
-- MOVABI — BATCH 1 ACL REPAIR (FORWARD-ONLY, IDEMPOTENT)
--
-- WHY THIS EXISTS
-- ============================================================================
-- 20260921000000_accept_rpc_lifecycle_reconcile.sql created the lifecycle RPCs
-- but its privilege statements did NOT converge to the intended matrix. The
-- production postflight reported effective EXECUTE where it must not exist:
--
--   anon          : accept_assigned_job, accept_searching_job,
--                   driver_vehicle_can_accept_job, settle_job_wallet_reservation
--   authenticated : driver_vehicle_can_accept_job, settle_job_wallet_reservation
--   service_role  : accept_assigned_job
--
-- ROOT CAUSE (PostgreSQL privilege semantics, not a typo)
--   The original migration relied on:
--       REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--   That removes ONLY the PUBLIC pseudo-role's own grant. It does NOT remove
--   EXECUTE that a CONCRETE role holds in its own right. Three separate
--   mechanisms left concrete grants in place:
--
--     1. PostgreSQL grants EXECUTE on a newly created function to PUBLIC by
--        default. REVOKE ... FROM PUBLIC clears that entry.
--     2. This database's schema owner additionally carries DEFAULT PRIVILEGES
--        that hand EXECUTE on new functions directly to anon, authenticated and
--        service_role. Those become concrete ACL entries on the function.
--     3. `CREATE OR REPLACE FUNCTION` PRESERVES an existing function's ACL, and
--        `DROP FUNCTION` + `CREATE FUNCTION` RE-DERIVES the ACL from the
--        owner's default privileges. So both paths - the CREATE OR REPLACE of
--        assign_driver_to_job and the DROP+CREATE of accept_searching_job -
--        re-established concrete role grants that REVOKE FROM PUBLIC never
--        touched.
--
--   Result: a REVOKE FROM PUBLIC followed by a GRANT to
--   (authenticated, service_role) ADDS those grants but SUBTRACTS nothing from
--   anon. `anon` already had its own entry, so it kept EXECUTE. There is no
--   repository evidence of any ALTER DEFAULT PRIVILEGES statement, and the
--   bootstrap schema predates the migrations, so the default ACL is
--   pre-existing environment state rather than something the repo created.
--
-- WHAT THIS MIGRATION DOES
--   Converges all five functions to the intended matrix by EXPLICITLY revoking
--   from every role that must not have access, then granting exactly what is
--   required. It is privilege DDL only:
--     * NO data writes (no INSERT / UPDATE / DELETE)
--     * NO function body or signature changes
--     * NO table, index or column changes
--     * NO CREATE / DROP of any object
--
-- INTENDED EFFECTIVE PRIVILEGE MATRIX (EXECUTE)
--   function                          PUBLIC  anon  authenticated  service_role
--   driver_vehicle_can_accept_job       NO     NO        NO            NO
--   accept_searching_job                NO     NO        YES           YES
--   assign_driver_to_job                NO     NO        YES           YES
--   accept_assigned_job                 NO     NO        YES           NO
--   settle_job_wallet_reservation       NO     NO        NO            YES
--
--   driver_vehicle_can_accept_job is an internal predicate invoked only from
--   SECURITY DEFINER callers, so it needs no role grant at all.
--
-- IDEMPOTENCE
--   REVOKE and GRANT are both idempotent: revoking a privilege that is already
--   absent is a no-op, and granting one that is already present is a no-op.
--   Running this file repeatedly always produces the same final ACL state and
--   never errors. `REVOKE ALL ... FROM PUBLIC` is deliberately used here to
--   strip any lingering PUBLIC entry.
--
-- FAILURE BEHAVIOUR
--   Every statement uses a schema-qualified EXACT signature. If a required
--   function is missing, REVOKE/GRANT would fail with 42883 - and because this
--   file is applied with ON_ERROR_STOP=1, the migration aborts rather than
--   silently repairing a subset. The guard below makes that failure explicit
--   and legible before any privilege is changed.
--
-- APPLY (from /srv/movabi/current; read-only equivalent target is the same
-- production container used for the original migration):
--   docker exec -i movabi-supabase-db \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/migrations/20260922000000_accept_rpc_acl_repair.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- GUARD: all five functions must exist, or abort before changing any privilege.
-- ----------------------------------------------------------------------------
DO $acl_guard$
DECLARE
    v_missing TEXT;
BEGIN
    SELECT string_agg(expected.signature, ', ' ORDER BY expected.signature)
      INTO v_missing
      FROM (VALUES
              ('public.driver_vehicle_can_accept_job(uuid,uuid)'),
              ('public.accept_searching_job(uuid,uuid)'),
              ('public.assign_driver_to_job(uuid,uuid)'),
              ('public.accept_assigned_job(uuid,uuid)'),
              ('public.settle_job_wallet_reservation(uuid,numeric)')
           ) AS expected(signature)
     WHERE to_regprocedure(expected.signature) IS NULL;

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'ACL repair aborted: required function(s) not found: %', v_missing
            USING HINT = 'Apply 20260921000000_accept_rpc_lifecycle_reconcile.sql first.';
    END IF;
END;
$acl_guard$;

-- ============================================================================
-- 1. driver_vehicle_can_accept_job — internal predicate, NO role may execute.
-- ============================================================================
REVOKE ALL ON FUNCTION public.driver_vehicle_can_accept_job(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_vehicle_can_accept_job(UUID, UUID)
FROM anon, authenticated, service_role;

-- ============================================================================
-- 2. accept_searching_job — authenticated + service_role, never anon.
-- ============================================================================
REVOKE ALL ON FUNCTION public.accept_searching_job(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_searching_job(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_searching_job(UUID, UUID)
TO authenticated, service_role;

-- ============================================================================
-- 3. assign_driver_to_job — authenticated + service_role, never anon.
-- ============================================================================
REVOKE ALL ON FUNCTION public.assign_driver_to_job(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assign_driver_to_job(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_driver_to_job(UUID, UUID)
TO authenticated, service_role;

-- ============================================================================
-- 4. accept_assigned_job — authenticated ONLY (never anon, never service_role).
-- ============================================================================
REVOKE ALL ON FUNCTION public.accept_assigned_job(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_assigned_job(UUID, UUID)
FROM anon, service_role;
GRANT EXECUTE ON FUNCTION public.accept_assigned_job(UUID, UUID)
TO authenticated;

-- ============================================================================
-- 5. settle_job_wallet_reservation — service_role ONLY (moves money).
-- ============================================================================
REVOKE ALL ON FUNCTION public.settle_job_wallet_reservation(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.settle_job_wallet_reservation(UUID, NUMERIC)
FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_job_wallet_reservation(UUID, NUMERIC)
TO service_role;

-- NOTE ON THE OWNER (postgres): EXECUTE for the owner is deliberately NOT
-- revoked. The owner is not a client role; a function owner can always re-grant
-- to itself, so revoking would remove nothing meaningful while making the ACL
-- harder to read. This migration targets client-facing roles only.

-- ============================================================================
-- 6. PREVENT RECURRENCE for future functions.
--
-- The concrete role grants that defeated the original migration came from the
-- schema owner's DEFAULT PRIVILEGES. Resetting the defaults means a future
-- CREATE FUNCTION will no longer begin life with EXECUTE for anon /
-- authenticated / service_role, so the same defect cannot recur on the next
-- migration. This is a forward-looking default only: it does NOT alter the ACL
-- of any existing function, and it is idempotent.
--
-- FOR ROLE uses the current schema owner dynamically rather than assuming
-- 'postgres', and is skipped when the owner cannot be determined.
-- ============================================================================
DO $acl_defaults$
DECLARE
    v_owner TEXT;
BEGIN
    SELECT pg_get_userbyid(n.nspowner)
      INTO v_owner
      FROM pg_namespace n
     WHERE n.nspname = 'public';

    IF v_owner IS NOT NULL THEN
        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
            'REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role',
            v_owner
        );
        RAISE NOTICE 'ACL repair: default function EXECUTE revoked for anon/authenticated/service_role (owner=%)', v_owner;
    ELSE
        RAISE NOTICE 'ACL repair: public schema owner not resolved; default privileges left unchanged';
    END IF;
END;
$acl_defaults$;

-- ============================================================================
-- 7. In-migration confirmation (NOT a substitute for the postflight).
--    Emits the resulting proacl so the operator can see the converged state
--    immediately. Kept informational; the authoritative gate is
--    scripts/db/postflight_20260921000000_accept_rpc_lifecycle.sql, which tests
--    EFFECTIVE privileges with has_function_privilege.
-- ============================================================================
SELECT
    p.proname                                              AS function_name,
    pg_get_function_identity_arguments(p.oid)              AS identity_arguments,
    COALESCE(array_to_string(p.proacl, ' | '),
             '(NULL: default ACL - PUBLIC has EXECUTE)')   AS proacl_after_repair
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('driver_vehicle_can_accept_job', 'accept_searching_job',
                    'assign_driver_to_job', 'accept_assigned_job',
                    'settle_job_wallet_reservation')
ORDER BY p.proname;
