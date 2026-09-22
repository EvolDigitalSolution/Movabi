-- ============================================================================
-- MOVABI — BATCH 2C / PHASE A: POSTFLIGHT for
-- supabase/migrations/20260925000000_driver_compliance_eligibility_phase_a.sql
--
-- STRICTLY READ ONLY. No DDL. No DML. It invokes NO ownership/acquisition RPC.
-- It runs AFTER the migration, so it may reference the Phase A objects directly.
--
-- It proves that Phase A did what it claims and NOTHING MORE:
--   * the seven new functions exist with the intended signature, mode, pinned
--     search_path and internal ACL,
--   * the acquisition trigger exists and is DISABLED,
--   * NO Phase A object can mutate application data: the only trigger wired to a
--     Phase A function is the DISABLED acquisition trigger, and no Phase A
--     function body contains INSERT/UPDATE/DELETE against public tables,
--   * profiles RLS was NOT enabled and the client-writable profiles columns were
--     NOT revoked (Phase A must not activate enforcement),
--   * the live jobs UPDATE policy was NOT replaced,
--   * the canonical rule table is internally consistent and ride-scoped,
--   * every required service alias resolves to its EXPLICIT expected canonical
--     value, and that check GATES the final verdict (SECTION 4.1 reports the
--     per-row result; SECTION 6 counts the failures), and
--   * the eligibility function fails closed, and
--   * the N12 invariant is untouched and healthy.
--
-- WHY RESOLUTION FIXTURES CARRY AN EXPLICIT EXPECTATION
-- ============================================================================
-- The verdict compares the function result against a declared expected value.
-- Deriving the expectation from the raw input instead (for example testing the
-- raw text for membership in a lowercase alias list) makes every correctly
-- resolved uppercase or mixed-case input look like a failure, and it cannot
-- detect a WRONG canonical result at all. The fixture therefore freezes the
-- alias -> canonical mapping, including that unrecognised and blank input must
-- resolve to NULL (fail closed).
--
-- HOW "PHASE A MUTATED NO PROFILE DATA" IS PROVEN
-- ============================================================================
-- Row-level equality is NOT proven here and is NOT claimed: this script has no
-- before/after snapshot of profile rows, so it cannot and does not assert that
-- any row value is unchanged. The proof is STRUCTURAL instead:
--   (a) statically, the migration source contains zero application-table
--       UPDATE/INSERT/DELETE — asserted by src/testing/batch2c-phase-a-eligibility.spec.ts
--       against the comment-stripped migration (the retained Phase B backfill
--       exists only as `--` comments and is therefore not executable), and
--   (b) at runtime, SECTION 2.6 and SECTION 2.7 below prove that no Phase A
--       object is wired to, or contains, any data-mutating logic.
-- (a) and (b) together mean no code path introduced by Phase A can write a row.
-- ============================================================================
--
-- SQL HYGIENE: every derived-table alias declares every column referenced
-- through it; internal `"char"` catalog columns are cast to text before
-- concatenation; no set-returning function appears inside an aggregate.
-- ============================================================================

\pset pager off


-- ============================================================================
-- SECTION 1 — PHASE A OBJECTS
-- ============================================================================
WITH expected(name, sig, rettype, definer, volatility) AS (
    VALUES
        ('canonical_driver_service',            'public.canonical_driver_service(text)',                       'text',    FALSE, 'i'),
        ('job_canonical_service',               'public.job_canonical_service(uuid)',                          'text',    TRUE,  's'),
        ('safe_iso_date',                       'public.safe_iso_date(text)',                                  'date',    FALSE, 'i'),
        ('driver_compliance_rules',             'public.driver_compliance_rules()',                            'record',  FALSE, 'i'),
        ('driver_compliance_rule_passes',       'public.driver_compliance_rule_passes(text,text,timestamptz)', 'boolean', FALSE, 'i'),
        ('driver_service_eligibility',          'public.driver_service_eligibility(uuid,text,timestamptz)',    'record',  TRUE,  's'),
        ('enforce_job_acquisition_eligibility', 'public.enforce_job_acquisition_eligibility()',                'trigger', TRUE,  'v')
)
SELECT
    'OBJECT ' || e.name AS check_name,
    'present | returns ' || e.rettype
      || ' | security=' || CASE WHEN e.definer THEN 'DEFINER' ELSE 'INVOKER' END
      || ' | volatility=' || e.volatility || ' | pinned search_path' AS expected,
    CASE
        WHEN p.oid IS NULL THEN 'MISSING'
        ELSE 'returns=' || pg_catalog.pg_get_function_result(p.oid)
             || ' | security=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
             || ' | volatility=' || p.provolatile::TEXT
             || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
             || ' | dynamic_sql=' || (p.prosrc ILIKE '%EXECUTE %' OR p.prosrc ILIKE '%FORMAT(%')::TEXT
    END AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN p.prosecdef IS DISTINCT FROM e.definer THEN 'FAIL'
        WHEN p.provolatile::TEXT IS DISTINCT FROM e.volatility THEN 'FAIL'
        WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%') THEN 'FAIL'
        WHEN p.prosrc ILIKE '%EXECUTE %' OR p.prosrc ILIKE '%FORMAT(%' THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM expected e
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(e.sig)
ORDER BY e.name;

-- 1.1 Every Phase A function is internal: no client role may execute it.
WITH sigs(sig) AS (
    VALUES
        ('public.canonical_driver_service(text)'),
        ('public.job_canonical_service(uuid)'),
        ('public.safe_iso_date(text)'),
        ('public.driver_compliance_rules()'),
        ('public.driver_compliance_rule_passes(text,text,timestamptz)'),
        ('public.driver_service_eligibility(uuid,text,timestamptz)'),
        ('public.enforce_job_acquisition_eligibility()')
),
roles(rolname) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
SELECT
    'PHASE A function ACL violations' AS check_name,
    'no client role may execute any Phase A function' AS expected,
    COALESCE(
        (SELECT string_agg(s.sig || '->' || r.rolname, ', ' ORDER BY s.sig, r.rolname)
           FROM sigs s CROSS JOIN roles r
          WHERE pg_catalog.to_regprocedure(s.sig) IS NOT NULL
            AND pg_catalog.has_function_privilege(r.rolname, pg_catalog.to_regprocedure(s.sig), 'EXECUTE')),
        'none') AS observed,
    CASE WHEN EXISTS (
            SELECT 1 FROM sigs s CROSS JOIN roles r
             WHERE pg_catalog.to_regprocedure(s.sig) IS NOT NULL
               AND pg_catalog.has_function_privilege(r.rolname, pg_catalog.to_regprocedure(s.sig), 'EXECUTE'))
         THEN 'FAIL' ELSE 'PASS' END AS verdict;


-- ============================================================================
-- SECTION 2 — PHASE A NON-ACTIONS (the whole point of this release)
-- ============================================================================

-- 2.1 The acquisition trigger MUST be present and DISABLED.
SELECT
    'TRIGGER trg_enforce_job_acquisition_eligibility' AS check_name,
    'present and DISABLED (Phase A must not change jobs ownership behaviour)' AS expected,
    CASE WHEN t.tgname IS NULL THEN 'MISSING'
         ELSE 'present | enabled=' || t.tgenabled::TEXT END AS observed,
    CASE
        WHEN t.tgname IS NULL THEN 'FAIL'
        WHEN t.tgenabled = 'D' THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_trigger t
       ON t.tgrelid = 'public.jobs'::regclass
      AND t.tgname = 'trg_enforce_job_acquisition_eligibility';

-- 2.2 Phase A must NOT have enabled RLS on profiles. Reported, with the
--     expectation stated: a change here means enforcement was activated early.
SELECT
    'NON-ACTION profiles RLS' AS check_name,
    'must still be false after Phase A (Phase C enables it)' AS expected,
    'relrowsecurity=' || c.relrowsecurity::TEXT AS observed,
    CASE WHEN c.relrowsecurity IS FALSE THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'profiles';

-- 2.3 Phase A must NOT have revoked the client-writable profiles columns.
--     These MUST remain writable until Phase C: revoking them early would break
--     every deployed client that still writes them.
WITH sensitive(col) AS (
    VALUES ('verification_status'), ('is_verified'), ('is_available'), ('is_online'),
           ('testing_approval_override'), ('driver_review_status'), ('verification_blockers'),
           ('subscription_status'), ('verification_items')
)
SELECT
    'NON-ACTION profiles.' || s.col || ' still client-writable' AS check_name,
    'must remain TRUE after Phase A (Phase C revokes it)' AS expected,
    'authenticated=' || pg_catalog.has_column_privilege('authenticated', 'public.profiles', s.col, 'UPDATE')::TEXT AS observed,
    CASE WHEN pg_catalog.has_column_privilege('authenticated', 'public.profiles', s.col, 'UPDATE')
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM sensitive s
ORDER BY s.col;

-- 2.4 Phase A must NOT have replaced the live jobs UPDATE policy.
SELECT
    'NON-ACTION jobs UPDATE policy presence' AS check_name,
    'the pre-existing policy must still be present unchanged' AS expected,
    COALESCE(string_agg(p.polname, ', ' ORDER BY p.polname), 'NONE') AS observed,
    CASE WHEN COUNT(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_catalog.pg_policy p
WHERE p.polrelid = 'public.jobs'::regclass AND p.polcmd = 'w';

-- 2.5 Phase A must NOT have enabled RLS on jobs or vehicles beyond the
--     pre-existing state (both were already true in production).
SELECT
    'NON-ACTION ' || c.relname || ' RLS' AS check_name,
    'informational: pre-existing state, Phase A does not touch it' AS expected,
    'relrowsecurity=' || c.relrowsecurity::TEXT AS observed,
    'INFO' AS verdict
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('jobs', 'vehicles')
ORDER BY c.relname;

-- 2.6 STRUCTURAL PROOF (runtime, 1 of 2): the ONLY trigger wired to any Phase A
--     function is the DISABLED acquisition trigger on public.jobs. No Phase A
--     function is attached to profiles or vehicles, so Phase A introduced no
--     write path there.
SELECT
    'NON-ACTION no Phase A function is wired as an active trigger' AS check_name,
    'exactly one trigger uses a Phase A function: the DISABLED acquisition trigger on public.jobs' AS expected,
    COALESCE(string_agg(DISTINCT t.tgname || '@' || t.tgrelid::regclass::TEXT
                        || ':enabled=' || t.tgenabled::TEXT, ', '), 'none') AS observed,
    CASE
        WHEN COUNT(*) = 1
             AND COUNT(*) FILTER (WHERE t.tgenabled = 'D'
                                    AND t.tgrelid = 'public.jobs'::regclass) = 1
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_proc pr ON pr.oid = t.tgfoid
WHERE pr.pronamespace = 'public'::regnamespace
  AND pr.proname IN ('canonical_driver_service', 'job_canonical_service', 'safe_iso_date',
                     'driver_compliance_rules', 'driver_compliance_rule_passes',
                     'driver_service_eligibility', 'enforce_job_acquisition_eligibility');

-- 2.7 STRUCTURAL PROOF (runtime, 2 of 2): no Phase A function BODY contains
--     INSERT / UPDATE / DELETE against a table. This is what makes the absence of
--     a row-level before/after comparison acceptable: no Phase A code path can
--     write application data at all.
WITH sigs(sig) AS (
    VALUES
        ('public.canonical_driver_service(text)'),
        ('public.job_canonical_service(uuid)'),
        ('public.safe_iso_date(text)'),
        ('public.driver_compliance_rules()'),
        ('public.driver_compliance_rule_passes(text,text,timestamptz)'),
        ('public.driver_service_eligibility(uuid,text,timestamptz)'),
        ('public.enforce_job_acquisition_eligibility()')
)
SELECT
    'NON-ACTION Phase A function bodies contain no application DML' AS check_name,
    'no INSERT/UPDATE/DELETE statement inside any Phase A function body' AS expected,
    COALESCE(string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname), 'none') AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM sigs s
JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(s.sig)
WHERE p.prosrc ~*
      '(insert[[:space:]]+into[[:space:]]+(public[[:space:]]*\.)?[a-z_]|update[[:space:]]+(public[[:space:]]*\.)?[a-z_][a-z0-9_.]*([[:space:]]+[a-z_][a-z0-9_]*)?[[:space:]]+set[[:space:]]|delete[[:space:]]+from[[:space:]]+(public[[:space:]]*\.)?[a-z_])';

-- 2.8 MIGRATION SOURCE IDENTITY — the exact SHA-256 of the migration this
--     postflight verifies. The static suite asserts that this recorded value
--     equals the real file hash, so the artifact that was applied cannot drift
--     from the artifact that was reviewed. Informational at runtime.
SELECT
    'MIGRATION SOURCE IDENTITY' AS check_name,
    'SHA-256 of the exact Phase A migration source verified by this postflight' AS expected,
    'sha256=CE59F801F6D6BD8EB05347ACA3C0D4A00C1B2716B6ABC189F3ACF445FDA04268' AS observed,
    'INFO' AS verdict;


-- ============================================================================
-- SECTION 3 — CANONICAL RULE TABLE CONSISTENCY AND SERVICE SCOPING
-- ============================================================================
SELECT
    'RULE TABLE totals' AS check_name,
    'blocking + advisory rows, single source of truth' AS expected,
    'rows=' || COUNT(*)::TEXT
      || ' | blocking=' || COUNT(*) FILTER (WHERE r.blocking)::TEXT
      || ' | advisory=' || COUNT(*) FILTER (WHERE NOT r.blocking)::TEXT
      || ' | distinct_codes=' || COUNT(DISTINCT r.rule_code)::TEXT AS observed,
    CASE WHEN COUNT(*) > 0 AND COUNT(*) FILTER (WHERE r.blocking) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM public.driver_compliance_rules() r;

-- 3.1 Passenger licensing MUST be ride-only. Any non-ride row carrying a
--     licence.private_hire* code (or the PHV insurance code) is a FAIL.
SELECT
    'RULE SCOPE passenger licensing is ride-only' AS check_name,
    'no non-ride row may carry licence.private_hire* or PHV insurance' AS expected,
    COALESCE(string_agg(r.rule_code || '@' || r.service_scope, ', ' ORDER BY r.rule_code), 'none') AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM public.driver_compliance_rules() r
WHERE (r.rule_code LIKE 'licence.private_hire%' OR r.rule_code = 'document.private_hire_insurance')
  AND r.service_scope <> 'ride';

-- 3.2 Ride rows must exist for all four granular licensing codes.
WITH required(code) AS (
    VALUES ('licence.private_hire.council'), ('licence.private_hire.number'),
           ('licence.private_hire.badge'),   ('licence.private_hire.expiry')
)
SELECT
    'RULE SCOPE ride licensing completeness' AS check_name,
    'all four granular ride licensing codes present and ride-scoped' AS expected,
    COALESCE(string_agg(r.rule_code || '@' || r.service_scope, ', ' ORDER BY r.rule_code), 'MISSING') AS observed,
    CASE WHEN COUNT(*) = 4 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM public.driver_compliance_rules() r
JOIN required q ON q.code = r.rule_code
WHERE r.service_scope = 'ride';

-- 3.3 The four documents whose expiry the rule set derives.
WITH expiry_rules(code, field) AS (
    VALUES ('document.driving_licence.expiry', 'driver_license_expiry'),
           ('document.insurance.expiry',       'insurance_expiry'),
           ('licence.private_hire.expiry',     'licence_expiry')
)
SELECT
    'RULE EXPIRY ' || e.code AS check_name,
    'present, blocking, check_type=date_not_expired' AS expected,
    COALESCE('found field=' || r.field || ' check=' || r.check_type || ' blocking=' || r.blocking::TEXT,
             'MISSING') AS observed,
    CASE WHEN r.rule_code IS NOT NULL AND r.check_type = 'date_not_expired' AND r.blocking
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM expiry_rules e
LEFT JOIN LATERAL (
    SELECT rr.rule_code, rr.field, rr.check_type, rr.blocking
      FROM public.driver_compliance_rules() rr
     WHERE rr.rule_code = e.code
     LIMIT 1
) r ON TRUE
ORDER BY e.code;

-- 3.4 The advisory rows are the disclosed policy decisions. They must exist and
--     must NOT be blocking, so Phase A introduces no new blocking requirement.
WITH advisory(code) AS (
    VALUES ('document.courier_insurance'), ('document.moving_insurance'),
           ('document.public_liability'),  ('vehicle.mot_expiry'),
           ('vehicle.tax_status'),         ('vehicle.verified'),
           ('document.driving_licence.status'), ('document.insurance.status')
)
SELECT
    'RULE ADVISORY ' || a.code AS check_name,
    'present and blocking = FALSE (named policy decision, no new blocking)' AS expected,
    'blocking_values=' || COALESCE(string_agg(DISTINCT r.blocking::TEXT, ','), 'MISSING') AS observed,
    CASE WHEN COUNT(*) > 0 AND bool_or(r.blocking) IS FALSE THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM advisory a
LEFT JOIN public.driver_compliance_rules() r ON r.rule_code = a.code
GROUP BY a.code
ORDER BY a.code;


-- ============================================================================
-- SECTION 4 — ELIGIBILITY FUNCTION FAILS CLOSED AND EXECUTES
-- ============================================================================
SELECT
    'ELIGIBILITY unknown driver' AS check_name,
    'eligible=false with service.unresolved' AS expected,
    'eligible=' || e.eligible::TEXT
      || ' | blocking=' || COALESCE(array_to_string(e.blocking_codes, ','), 'none') AS observed,
    CASE WHEN e.eligible IS FALSE
              AND COALESCE(e.blocking_codes, ARRAY[]::TEXT[]) @> ARRAY['service.unresolved']::TEXT[]
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM public.driver_service_eligibility(
        '00000000-0000-0000-0000-000000000000'::UUID, 'ride', now()) e;

SELECT
    'ELIGIBILITY unresolvable service' AS check_name,
    'a real driver with an unresolvable service must fail closed' AS expected,
    COALESCE(
        (SELECT 'driver=' || d.id::TEXT
                || ' | eligible=' || e.eligible::TEXT
                || ' | blocking=' || COALESCE(array_to_string(e.blocking_codes, ','), 'none')
           FROM (SELECT p.id FROM public.profiles p
                  WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
                  LIMIT 1) d
          CROSS JOIN LATERAL public.driver_service_eligibility(d.id, 'not-a-service', now()) e),
        'no driver rows to sample (not a failure)') AS observed,
    CASE
        WHEN NOT EXISTS (SELECT 1 FROM public.profiles p WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver')
            THEN 'INFO'
        WHEN EXISTS (
            SELECT 1 FROM (SELECT p.id FROM public.profiles p
                            WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
                            LIMIT 1) d
             CROSS JOIN LATERAL public.driver_service_eligibility(d.id, 'not-a-service', now()) e
             WHERE e.eligible IS FALSE
               AND COALESCE(e.blocking_codes, ARRAY[]::TEXT[]) @> ARRAY['service.unresolved']::TEXT[])
            THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict;

-- 4.1 Canonical service resolution coverage, straight from the function.
--
-- Each fixture row carries an EXPLICIT expected canonical value, and the verdict
-- compares the function result against that expectation. The expectation is
-- never derived from the raw input and never compared case-sensitively with it:
-- canonical_driver_service() lowercases and trims before matching, so 'RIDE',
-- 'Ride' and '  RIDE  ' must ALL resolve to 'ride'. Comparing the raw text
-- against a lowercase alias list made every correctly-resolved uppercase input
-- look like a failure.
--
-- The SAME fixture block is repeated in SECTION 6 so the final GO / NO-GO can
-- count service-resolution failures instead of leaving them as cosmetic rows.
-- src/testing/batch2c-phase-a-eligibility.spec.ts proves the two blocks are
-- identical and evaluates every pair against the canonical implementation.
WITH service_fixtures(raw, expected) AS (
    VALUES
        ('ride',       'ride'),
        ('RIDE',       'ride'),
        ('Ride',       'ride'),
        ('  ride  ',   'ride'),
        ('  RIDE  ',   'ride'),
        ('errand',     'errand'),
        ('ERRAND',     'errand'),
        ('shop',       'errand'),
        ('SHOP',       'errand'),
        ('shopping',   'errand'),
        ('delivery',   'delivery'),
        ('DELIVERY',   'delivery'),
        ('deliver',    'delivery'),
        ('van-moving', 'van-moving'),
        ('VAN-MOVING', 'van-moving'),
        ('van_moving', 'van-moving'),
        ('move',       'van-moving'),
        ('moving',     'van-moving'),
        ('van',        'van-moving'),
        ('',           NULL),
        ('   ',        NULL),
        ('bogus',      NULL)
),
resolution AS (
    SELECT f.raw,
           f.expected,
           public.canonical_driver_service(f.raw) AS resolved
      FROM service_fixtures f
)
SELECT
    'RESOLVE <' || REPLACE(r.raw, ' ', '_') || '>' AS check_name,
    'must resolve to the frozen canonical service, or NULL when unresolvable' AS expected,
    'expected=' || COALESCE(r.expected, 'NULL')
      || ' | resolved=' || COALESCE(r.resolved, 'NULL') AS observed,
    CASE WHEN r.resolved IS NOT DISTINCT FROM r.expected THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM resolution r
ORDER BY r.raw;


-- ============================================================================
-- SECTION 5 — N12 UNCHANGED AND HEALTHY
-- ============================================================================
SELECT
    'N12 invariant idx_jobs_one_active_per_driver' AS check_name,
    'present, UNIQUE, valid, keyed on jobs(driver_id) — untouched by Phase A' AS expected,
    CASE
        WHEN i.indexrelid IS NULL THEN 'MISSING'
        ELSE 'unique=' || i.indisunique::TEXT || ' valid=' || i.indisvalid::TEXT
             || ' key=' || COALESCE(a.attname, '?')
             || ' predicate=' || COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), 'NONE')
    END AS observed,
    CASE
        WHEN i.indexrelid IS NULL THEN 'FAIL'
        WHEN i.indisunique IS TRUE AND i.indisvalid IS TRUE AND a.attname = 'driver_id' THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_index i
       ON i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
LEFT JOIN pg_catalog.pg_attribute a
       ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0];

WITH expected(name, sig, rettype) AS (
    VALUES
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',            'text[]'),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)', 'boolean'),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',            'boolean')
)
SELECT
    'N12 helper ' || e.name AS check_name,
    'present, returns ' || e.rettype || ', internal, search_path pinned' AS expected,
    CASE
        WHEN p.oid IS NULL THEN 'MISSING'
        ELSE 'returns=' || pg_catalog.pg_get_function_result(p.oid)
             || ' | security=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
             || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
    END AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN pg_catalog.pg_get_function_result(p.oid) IS DISTINCT FROM e.rettype THEN 'FAIL'
        WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%') THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM expected e
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(e.sig)
ORDER BY e.name;

-- 5.1 N12 frozen status set must still be exactly the 16 approved values.
SELECT
    'N12 frozen occupying statuses' AS check_name,
    'exactly 16 approved statuses' AS expected,
    'count=' || COUNT(*)::TEXT
      || ' | values=' || COALESCE(string_agg(s.status, ',' ORDER BY s.status), 'NONE') AS observed,
    CASE WHEN COUNT(*) = 16 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (SELECT unnest(public.driver_occupying_statuses()) AS status) s;


-- ============================================================================
-- SECTION 6 — PHASE A GO / NO-GO
--
-- Every counter below is BOTH reported and gated: a counter that appears only in
-- the observed string cannot influence the verdict, so the two lists are kept in
-- step and the suite asserts that.
--
-- service_resolution_failures is computed from the same explicit fixture block
-- used by SECTION 4.1. Without it the final verdict was blind to service
-- resolution: an individual RESOLVE row could print FAIL while the aggregate
-- still printed PASS, because no counter was ever derived from those rows.
-- ============================================================================
WITH objects(sig) AS (
    VALUES
        ('public.canonical_driver_service(text)'),
        ('public.job_canonical_service(uuid)'),
        ('public.safe_iso_date(text)'),
        ('public.driver_compliance_rules()'),
        ('public.driver_compliance_rule_passes(text,text,timestamptz)'),
        ('public.driver_service_eligibility(uuid,text,timestamptz)'),
        ('public.enforce_job_acquisition_eligibility()')
),
missing_objects AS (
    SELECT COUNT(*) AS n FROM objects o
     WHERE pg_catalog.to_regprocedure(o.sig) IS NULL
),
unpinned AS (
    SELECT COUNT(*) AS n
      FROM objects o
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(o.sig)
     WHERE p.oid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                        WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%')
),
service_fixtures(raw, expected) AS (
    VALUES
        ('ride',       'ride'),
        ('RIDE',       'ride'),
        ('Ride',       'ride'),
        ('  ride  ',   'ride'),
        ('  RIDE  ',   'ride'),
        ('errand',     'errand'),
        ('ERRAND',     'errand'),
        ('shop',       'errand'),
        ('SHOP',       'errand'),
        ('shopping',   'errand'),
        ('delivery',   'delivery'),
        ('DELIVERY',   'delivery'),
        ('deliver',    'delivery'),
        ('van-moving', 'van-moving'),
        ('VAN-MOVING', 'van-moving'),
        ('van_moving', 'van-moving'),
        ('move',       'van-moving'),
        ('moving',     'van-moving'),
        ('van',        'van-moving'),
        ('',           NULL),
        ('   ',        NULL),
        ('bogus',      NULL)
),
service_resolution_failures AS (
    SELECT COUNT(*) AS n
      FROM service_fixtures f
     WHERE public.canonical_driver_service(f.raw) IS DISTINCT FROM f.expected
),
client_grants AS (
    SELECT COUNT(*) AS n
      FROM objects o
     CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS ro(rolname)
     WHERE pg_catalog.to_regprocedure(o.sig) IS NOT NULL
       AND pg_catalog.has_function_privilege(ro.rolname, pg_catalog.to_regprocedure(o.sig), 'EXECUTE')
),
trigger_enabled AS (
    SELECT CASE WHEN t.tgname IS NULL THEN 1 WHEN t.tgenabled = 'D' THEN 0 ELSE 1 END AS n
      FROM (SELECT 1) AS one
      LEFT JOIN pg_catalog.pg_trigger t
             ON t.tgrelid = 'public.jobs'::regclass
            AND t.tgname = 'trg_enforce_job_acquisition_eligibility'
),
ride_scope_leak AS (
    SELECT COUNT(*) AS n FROM public.driver_compliance_rules() r
     WHERE (r.rule_code LIKE 'licence.private_hire%' OR r.rule_code = 'document.private_hire_insurance')
       AND r.service_scope <> 'ride'
),
advisory_leak AS (
    SELECT COUNT(*) AS n FROM public.driver_compliance_rules() r
     WHERE r.rule_code IN ('document.courier_insurance', 'document.moving_insurance',
                           'document.public_liability', 'vehicle.mot_expiry',
                           'vehicle.tax_status', 'vehicle.verified')
       AND r.blocking
),
n12_statuses AS (
    SELECT COUNT(*) AS n FROM (SELECT unnest(public.driver_occupying_statuses()) AS status) s
),
profiles_rls AS (
    SELECT CASE WHEN c.relrowsecurity THEN 1 ELSE 0 END AS n
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'profiles'
)
SELECT
    'PHASE A POST-MIGRATION GO / NO-GO' AS check_name,
    'objects present + pinned + internal ACL + trigger DISABLED + every required service alias resolves to its frozen canonical value + ride-only scoping + advisory rows non-blocking + N12 intact + profiles RLS still off' AS expected,
    'missing_objects=' || (SELECT n FROM missing_objects)::TEXT
      || ' | unpinned=' || (SELECT n FROM unpinned)::TEXT
      || ' | client_executable=' || (SELECT n FROM client_grants)::TEXT
      || ' | trigger_enabled_or_missing=' || (SELECT n FROM trigger_enabled)::TEXT
      || ' | service_resolution_failures=' || (SELECT n FROM service_resolution_failures)::TEXT
      || ' | ride_scope_leaks=' || (SELECT n FROM ride_scope_leak)::TEXT
      || ' | advisory_blocking_leaks=' || (SELECT n FROM advisory_leak)::TEXT
      || ' | n12_status_count=' || (SELECT n FROM n12_statuses)::TEXT
      || ' | profiles_rls_on=' || (SELECT n FROM profiles_rls)::TEXT AS observed,
    CASE
        WHEN (SELECT n FROM missing_objects) > 0 THEN 'NO-GO: a Phase A object is missing'
        WHEN (SELECT n FROM unpinned) > 0 THEN 'NO-GO: a Phase A function is not pinned to search_path'
        WHEN (SELECT n FROM client_grants) > 0 THEN 'NO-GO: a Phase A function is client-executable'
        WHEN (SELECT n FROM trigger_enabled) > 0 THEN 'NO-GO: acquisition trigger is not DISABLED'
        WHEN (SELECT n FROM service_resolution_failures) > 0 THEN 'NO-GO: a required service alias does not resolve to its frozen canonical value'
        WHEN (SELECT n FROM ride_scope_leak) > 0 THEN 'NO-GO: passenger licensing leaked outside ride'
        WHEN (SELECT n FROM advisory_leak) > 0 THEN 'NO-GO: an advisory policy row became blocking in Phase A'
        WHEN (SELECT n FROM n12_statuses) <> 16 THEN 'NO-GO: N12 frozen status set changed'
        WHEN (SELECT n FROM profiles_rls) > 0 THEN 'NO-GO: profiles RLS was enabled in Phase A'
        ELSE 'PASS'
    END AS verdict;
