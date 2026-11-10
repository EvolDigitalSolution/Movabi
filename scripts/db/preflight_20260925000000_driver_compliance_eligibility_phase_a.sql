-- ============================================================================
-- MOVABI — BATCH 2C / PHASE A: PREFLIGHT for
-- supabase/migrations/20260925000000_driver_compliance_eligibility_phase_a.sql
--
-- STRICTLY READ ONLY. No DDL. No DML. No mutation RPC is invoked.
--
-- It establishes, against the live database, that Phase A is safe to apply and
-- that its additive rule set matches reality:
--   * the columns the rule set reads actually exist,
--   * passenger-licence canonical vs compatibility storage availability,
--   * the Phase B backfill blast radius (reported only, NEVER gated),
--   * the canonical read precedence is SAFE (this IS gated — see SECTION 4.2),
--   * service resolution coverage,
--   * driver population and current approval/online state,
--   * the blast radius of the Phase C rule set,
--   * vehicle ownership/verification anomalies,
--   * N12 invariant health, and
--   * the Phase A objects are absent OR already exactly compatible.
--
-- PHASE A APPLIES NO BACKFILL. The blast-radius numbers below describe what the
-- Phase B controlled data-reconciliation UPDATE would change, so an operator can
-- review them before Phase B is written. They are informational: Phase A itself
-- mutates nothing, so a large blast radius does not block Phase A.
--
-- CLEAN-INSTALL LESSON (Batch 2B): this file must run BEFORE the migration, so
-- it NEVER calls a Phase A function directly. Every optional new object is
-- reached through pg_catalog.to_regprocedure('...') / to_regclass('...') with a
-- STRING argument, which returns NULL instead of raising when the object is
-- absent. A statically written call would be resolved by the parser before any
-- CASE guard could run and would abort the whole script.
--
-- SQL HYGIENE (Batch 2A lessons): every derived-table alias declares every
-- column referenced through it; regexp_matches is used as a FROM item via
-- CROSS JOIN LATERAL, never inside an aggregate; internal `"char"` catalog
-- columns are cast to text before concatenation.
-- ============================================================================

\pset pager off


-- ============================================================================
-- SECTION 1 — SERVER / BASELINE CONTEXT
-- ============================================================================

SELECT
    'PG_VERSION' AS check_name,
    'informational' AS expected,
    pg_catalog.current_setting('server_version') AS observed,
    'INFO' AS verdict;

SELECT
    'TABLE ' || c.relname AS check_name,
    'RLS state and row count for a table Phase A/C touches' AS expected,
    'rls=' || c.relrowsecurity::TEXT
      || ' forced=' || c.relforcerowsecurity::TEXT
      || ' rows=' || CASE c.relname
                        WHEN 'profiles' THEN (SELECT COUNT(*) FROM public.profiles)::TEXT
                        WHEN 'jobs'     THEN (SELECT COUNT(*) FROM public.jobs)::TEXT
                        WHEN 'vehicles' THEN (SELECT COUNT(*) FROM public.vehicles)::TEXT
                     END AS observed,
    'INFO' AS verdict
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('profiles', 'jobs', 'vehicles')
ORDER BY c.relname;

-- 1.1 The live jobs UPDATE policy that Phase C will replace. Reported, never
--     asserted: Phase A must not depend on its current shape.
SELECT
    'JOBS UPDATE policy ' || p.polname AS check_name,
    'informational: Phase C replaces this' AS expected,
    'using=' || COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), 'NONE')
      || ' | with_check=' || COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), 'NONE') AS observed,
    'INFO' AS verdict
FROM pg_catalog.pg_policy p
WHERE p.polrelid = 'public.jobs'::regclass AND p.polcmd = 'w'
ORDER BY p.polname;

-- 1.2 Which sensitive profiles columns are currently client-writable. This is
--     the N13 evidence and the Phase C target list; Phase A changes none of it.
WITH sensitive(col) AS (
    VALUES ('verification_status'), ('is_verified'), ('driver_review_status'),
           ('verification_blockers'), ('driver_review_blockers'), ('compliance_status'),
           ('testing_approval_override'), ('is_online'), ('is_available'),
           ('subscription_status'), ('driver_license_status'), ('insurance_status'),
           ('private_hire_driver_license_status'), ('private_hire_vehicle_license_status'),
           ('private_hire_insurance_status'), ('role'), ('account_status'),
           ('verification_items')
)
SELECT
    'N13 WRITABLE profiles.' || s.col AS check_name,
    'must become NOT client-writable in Phase C' AS expected,
    'authenticated=' || pg_catalog.has_column_privilege('authenticated', 'public.profiles', s.col, 'UPDATE')::TEXT
      || ' anon=' || pg_catalog.has_column_privilege('anon', 'public.profiles', s.col, 'UPDATE')::TEXT AS observed,
    'INFO' AS verdict
FROM sensitive s
ORDER BY s.col;


-- ============================================================================
-- SECTION 2 — REQUIRED PROFILES COLUMNS ACTUALLY EXIST
--
-- The rule set reads ten fields that are NOT defined by any repository
-- migration (they exist in production and are written by live code). Phase A
-- reads them through to_jsonb() so an absent column degrades to NULL, but the
-- operator must know the truth before Phase C enforcement is enabled.
-- ============================================================================
WITH expected(col, required_now, why) AS (
    VALUES
        ('id',                         TRUE,  'primary key / lookup'),
        ('role',                       TRUE,  'driver population'),
        ('country_code',               TRUE,  'GB scoping'),
        ('full_name',                  TRUE,  'profile.full_name'),
        ('phone',                      TRUE,  'profile.phone'),
        ('current_address',            FALSE, 'address_present fallback'),
        ('address_line1',              FALSE, 'address_present fallback'),
        ('home_address',               FALSE, 'address_present fallback'),
        ('date_of_birth',              TRUE,  'profile.date_of_birth'),
        ('accepted_driver_agreement_at', TRUE, 'agreement.not_accepted'),
        ('account_status',             TRUE,  'account.not_active'),
        ('is_verified',                TRUE,  'onboarding.not_approved'),
        ('verification_status',        TRUE,  'onboarding.not_approved'),
        ('onboarding_completed',       TRUE,  'onboarding.not_complete'),
        ('driver_review_status',       TRUE,  'review state'),
        ('right_to_work_url',          FALSE, 'work.right_to_work fallback'),
        ('right_to_work_share_code',   FALSE, 'work.right_to_work fallback'),
        ('driver_license_url',         TRUE,  'document.driving_licence'),
        ('driver_license_expiry',      TRUE,  'document.driving_licence.expiry'),
        ('driver_license_status',      FALSE, 'advisory status rule'),
        ('insurance_url',              TRUE,  'document.insurance'),
        ('insurance_expiry',           TRUE,  'document.insurance.expiry'),
        ('insurance_status',           FALSE, 'advisory status rule'),
        ('council_name',               FALSE, 'ride licence canonical'),
        ('council_license_authority',  FALSE, 'ride licence legacy alias'),
        ('council_license_number',     FALSE, 'ride licence canonical'),
        ('council_license_expiry',     FALSE, 'ride licence legacy alias'),
        ('taxi_badge_number',          FALSE, 'ride licence canonical'),
        ('taxi_license_expiry',        FALSE, 'ride licence canonical expiry'),
        ('private_hire_vehicle_license_url', FALSE, 'ride legacy requirement'),
        ('private_hire_insurance_url', FALSE, 'document.private_hire_insurance'),
        ('goods_in_transit_insurance_url', FALSE, 'document.goods_in_transit'),
        ('courier_insurance_url',      FALSE, 'advisory courier rule'),
        ('moving_insurance_url',       FALSE, 'advisory van rule'),
        ('public_liability_insurance_url', FALSE, 'advisory van rule'),
        ('verification_items',         FALSE, 'legacy compatibility storage')
)
SELECT
    'COLUMN profiles.' || e.col AS check_name,
    e.why AS expected,
    COALESCE(c.data_type, 'ABSENT') AS observed,
    CASE
        WHEN c.column_name IS NULL AND e.required_now THEN 'FAIL'
        WHEN c.column_name IS NULL THEN 'WARN'
        ELSE 'PASS'
    END AS verdict
FROM expected e
LEFT JOIN information_schema.columns c
       ON c.table_schema = 'public' AND c.table_name = 'profiles' AND c.column_name = e.col
ORDER BY verdict DESC, check_name;


-- ============================================================================
-- SECTION 3 — REQUIRED VEHICLE COLUMNS ACTUALLY EXIST
-- ============================================================================
WITH expected(col, required_now, why) AS (
    VALUES
        ('id',               TRUE,  'ordering tiebreak'),
        ('user_id',          TRUE,  'ownership lookup'),
        ('created_at',       TRUE,  'deterministic newest-vehicle pick'),
        ('type',             TRUE,  'driver_is_motor'),
        ('capacity',         TRUE,  'driver_is_motor'),
        ('make',             TRUE,  'vehicle.make'),
        ('model',            TRUE,  'vehicle.model'),
        ('year',             TRUE,  'vehicle.year'),
        ('license_plate',    TRUE,  'vehicle.registration'),
        ('color',            FALSE, 'vehicle.colour (colour alias)'),
        ('service_eligibility', FALSE, 'declared services (NOT a compliance verdict)'),
        ('vehicle_verified', FALSE, 'advisory vehicle.verified'),
        ('dvla_mot_status',  FALSE, 'advisory MOT status'),
        ('mot_expiry_date',  FALSE, 'advisory vehicle.mot_expiry'),
        ('dvla_tax_status',  FALSE, 'advisory vehicle.tax_status')
)
SELECT
    'COLUMN vehicles.' || e.col AS check_name,
    e.why AS expected,
    COALESCE(c.data_type, 'ABSENT') AS observed,
    CASE
        WHEN c.column_name IS NULL AND e.required_now THEN 'FAIL'
        WHEN c.column_name IS NULL THEN 'WARN'
        ELSE 'PASS'
    END AS verdict
FROM expected e
LEFT JOIN information_schema.columns c
       ON c.table_schema = 'public' AND c.table_name = 'vehicles' AND c.column_name = e.col
ORDER BY verdict DESC, check_name;

-- 3.1 `vehicle_class` must NOT exist: a SEPARATE out-of-scope defect depends on
--     this fact and Batch 2C must not change it either way.
SELECT
    'SEPARATE DEFECT vehicle_class column' AS check_name,
    'informational: must remain absent; dispatch.service.ts:605 is out of scope' AS expected,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = 'vehicles'
                         AND column_name = 'vehicle_class')
         THEN 'present (unexpected)' ELSE 'absent (as expected)' END AS observed,
    'INFO' AS verdict;


-- ============================================================================
-- SECTION 4 — PASSENGER-LICENCE CANONICAL vs COMPATIBILITY STORAGE
--
-- Reports, SEPARATELY PER CANONICAL FIELD, the five categories an operator needs
-- before any data reconciliation:
--   1. canonical EMPTY + compatibility PRESENT   (json_only)
--   2. canonical PRESENT + compatibility PRESENT and IDENTICAL (same)
--   3. canonical PRESENT + compatibility PRESENT and DIVERGENT (DIVERGENT)
--   4. malformed compatibility values            (SECTION 4.2)
--   5. rows a future PHASE B backfill WOULD change (SECTION 4.3)
--
-- Only object-shaped verification_items are counted, matching the read
-- precedence and the Phase B backfill design.
--
-- Phase A itself mutates NOTHING, so categories 1-3 and 5 are reported and never
-- gate the Phase A GO decision. Category 4 feeds the ONE thing that IS gated:
-- whether the canonical read precedence is safe (SECTION 4.4 / SECTION 11).
-- ============================================================================
WITH driver_items AS (
    SELECT p.id,
           CASE WHEN jsonb_typeof(to_jsonb(p) -> 'verification_items') = 'object'
                THEN to_jsonb(p) -> 'verification_items'
                ELSE '{}'::JSONB END AS items
      FROM public.profiles p
     WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
)
SELECT
    'LICENCE STORAGE ' || f.field AS check_name,
    'canonical_empty+compat_present / canonical_present+compat_same / canonical_present+compat_DIVERGENT / column_only / compat_only' AS expected,
    'column_only=' || COUNT(*) FILTER (WHERE f.col_val IS NOT NULL AND f.json_val IS NULL)::TEXT
      || ' | json_only=' || COUNT(*) FILTER (WHERE f.col_val IS NULL AND f.json_val IS NOT NULL)::TEXT
      || ' | same=' || COUNT(*) FILTER (WHERE f.col_val IS NOT NULL AND f.json_val = f.col_val)::TEXT
      || ' | DIVERGENT=' || COUNT(*) FILTER (WHERE f.col_val IS NOT NULL AND f.json_val IS NOT NULL AND f.json_val <> f.col_val)::TEXT AS observed,
    'INFO' AS verdict
FROM (
    SELECT 'council_name' AS field,
           NULLIF(BTRIM(COALESCE(p.council_name, '')), '') AS col_val,
           NULLIF(BTRIM(COALESCE(d.items ->> 'council_name', '')), '') AS json_val
      FROM public.profiles p JOIN driver_items d ON d.id = p.id
    UNION ALL
    SELECT 'council_license_number',
           NULLIF(BTRIM(COALESCE(p.council_license_number, '')), ''),
           NULLIF(BTRIM(COALESCE(d.items ->> 'council_license_number', '')), '')
      FROM public.profiles p JOIN driver_items d ON d.id = p.id
    UNION ALL
    SELECT 'taxi_badge_number',
           NULLIF(BTRIM(COALESCE(p.taxi_badge_number, '')), ''),
           NULLIF(BTRIM(COALESCE(d.items ->> 'taxi_badge_number', '')), '')
      FROM public.profiles p JOIN driver_items d ON d.id = p.id
    UNION ALL
    SELECT 'taxi_license_expiry',
           NULLIF(BTRIM(COALESCE(p.taxi_license_expiry::TEXT, '')), ''),
           NULLIF(BTRIM(COALESCE(d.items ->> 'taxi_license_expiry', '')), '')
      FROM public.profiles p JOIN driver_items d ON d.id = p.id
) f
GROUP BY f.field
ORDER BY f.field;

-- 4.2 MALFORMED LICENCE VALUES — compatibility values that are PRESENT but
--     cannot be used by the read precedence because their JSON type is not a
--     string. Text canonical columns cannot be malformed; the expiry field can
--     additionally be unparseable or an impossible calendar date (4.3).
WITH driver_items AS (
    SELECT p.id,
           CASE WHEN jsonb_typeof(to_jsonb(p) -> 'verification_items') = 'object'
                THEN to_jsonb(p) -> 'verification_items'
                ELSE '{}'::JSONB END AS items
      FROM public.profiles p
     WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
)
SELECT
    'LICENCE MALFORMED ' || f.field AS check_name,
    'present compatibility values whose JSON type is not a string' AS expected,
    'non_string_compatibility=' || COUNT(*) FILTER (WHERE f.json_type IS NOT NULL
                                                      AND f.json_type <> 'string')::TEXT AS observed,
    'INFO' AS verdict
FROM (
    SELECT 'council_name' AS field, jsonb_typeof(d.items -> 'council_name') AS json_type
      FROM driver_items d
    UNION ALL
    SELECT 'council_license_number', jsonb_typeof(d.items -> 'council_license_number')
      FROM driver_items d
    UNION ALL
    SELECT 'taxi_badge_number', jsonb_typeof(d.items -> 'taxi_badge_number')
      FROM driver_items d
    UNION ALL
    SELECT 'taxi_license_expiry', jsonb_typeof(d.items -> 'taxi_license_expiry')
      FROM driver_items d
) f
GROUP BY f.field
ORDER BY f.field;

-- 4.3 LICENCE EXPIRY PRECEDENCE SAFETY — the ONE thing that IS gated.
--
-- The frozen read precedence is canonical column -> compatibility key -> legacy
-- alias. That ordering is safe only while a PRESENT canonical value is actually
-- USABLE. If the canonical expiry cannot be parsed as a DATE while a usable
-- compatibility or alias value exists, the precedence DISCARDS real licence
-- evidence and the driver fails closed for the wrong reason. The Phase B
-- NULL-only backfill cannot repair it (the canonical value is not NULL), so this
-- must be surfaced as a NO-GO for operator data repair — see SECTION 11.
--
-- Deliberately ARITHMETIC-ONLY: a DATE cast on an impossible calendar date
-- RAISES in PostgreSQL, which would abort this read-only script. Only rows whose
-- value already matches the frozen shape are ever cast to INT.
WITH lic AS (
    SELECT NULLIF(BTRIM(COALESCE(p.taxi_license_expiry::TEXT, '')), '')       AS canon_expiry,
           NULLIF(BTRIM(COALESCE(d.items ->> 'taxi_license_expiry', '')), '') AS json_expiry,
           NULLIF(BTRIM(COALESCE(p.council_license_expiry::TEXT, '')), '')    AS alias_expiry
      FROM public.profiles p
      JOIN (
          SELECT p2.id,
                 CASE WHEN jsonb_typeof(to_jsonb(p2) -> 'verification_items') = 'object'
                      THEN to_jsonb(p2) -> 'verification_items'
                      ELSE '{}'::JSONB END AS items
            FROM public.profiles p2
           WHERE COALESCE(to_jsonb(p2) ->> 'role', '') = 'driver'
      ) d ON d.id = p.id
),
shaped AS (
    SELECT v.canon_expiry,
           v.json_expiry,
           v.alias_expiry,
           substring(v.canon_expiry, 1, 4)::INT AS cy,
           substring(v.canon_expiry, 6, 2)::INT AS cm,
           substring(v.canon_expiry, 9, 2)::INT AS cd
      FROM lic v
     WHERE v.canon_expiry ~ '^\d{4}-\d{2}-\d{2}$'
),
safety AS (
    SELECT (s.cy BETWEEN 1 AND 9999
            AND s.cm BETWEEN 1 AND 12
            AND s.cd BETWEEN 1
                AND (CASE s.cm
                       WHEN 2 THEN (CASE WHEN s.cy % 4 = 0 AND (s.cy % 100 <> 0 OR s.cy % 400 = 0)
                                         THEN 29 ELSE 28 END)
                       WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
                       ELSE 31 END)) AS canon_usable,
           (s.json_expiry ~ '^\d{4}-\d{2}-\d{2}$'
            OR s.alias_expiry ~ '^\d{4}-\d{2}-\d{2}$') AS fallback_present
      FROM shaped s
),
unshaped AS (
    -- Canonical present but not even the frozen shape: unusable by definition,
    -- so it shadows usable fallback data in exactly the same way.
    SELECT (v.json_expiry ~ '^\d{4}-\d{2}-\d{2}$'
            OR v.alias_expiry ~ '^\d{4}-\d{2}-\d{2}$') AS fallback_present
      FROM lic v
     WHERE v.canon_expiry IS NOT NULL
       AND v.canon_expiry !~ '^\d{4}-\d{2}-\d{2}$'
)
SELECT
    'LICENCE EXPIRY precedence safety' AS check_name,
    'a canonical present-but-unusable expiry must NOT shadow usable compatibility/alias data; GATED in SECTION 11' AS expected,
    'canonical_absent=' || (SELECT COUNT(*) FROM lic v WHERE v.canon_expiry IS NULL)::TEXT
      || ' | canonical_bad_shape=' || (SELECT COUNT(*) FROM lic v
                                        WHERE v.canon_expiry IS NOT NULL
                                          AND v.canon_expiry !~ '^\d{4}-\d{2}-\d{2}$')::TEXT
      || ' | canonical_impossible_calendar=' || (SELECT COUNT(*) FROM safety x
                                                  WHERE NOT x.canon_usable)::TEXT
      || ' | compatibility_bad_shape=' || (SELECT COUNT(*) FROM lic v
                                            WHERE v.json_expiry IS NOT NULL
                                              AND v.json_expiry !~ '^\d{4}-\d{2}-\d{2}$')::TEXT
      || ' | alias_bad_shape=' || (SELECT COUNT(*) FROM lic v
                                    WHERE v.alias_expiry IS NOT NULL
                                      AND v.alias_expiry !~ '^\d{4}-\d{2}-\d{2}$')::TEXT
      || ' | UNSAFE_SHADOWED=' || ((SELECT COUNT(*) FROM safety x
                                     WHERE NOT x.canon_usable AND x.fallback_present)
                                   + (SELECT COUNT(*) FROM unshaped u
                                       WHERE u.fallback_present))::TEXT AS observed,
    'INFO' AS verdict;

-- 4.4 PHASE B BACKFILL BLAST RADIUS — how many rows the PHASE B controlled
--     data-reconciliation UPDATE would change, and exactly which columns.
--     Phase A executes NO backfill, so these counts are informational and never
--     gate the Phase A GO decision. They are the numbers an operator must review
--     BEFORE Phase B is executed: filling `council_license_number` is the only
--     one that can flip the CURRENT online gate
--     (driver-requirement.service.ts licence.private_hire).
SELECT
    'PHASE B BACKFILL rows that would be changed' AS check_name,
    'informational (Phase A mutates nothing); council_license_number is eligibility-affecting' AS expected,
    'council_name=' || COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(p.council_name, '')), '') IS NULL
                                          AND NULLIF(BTRIM(COALESCE(d.items ->> 'council_name', '')), '') IS NOT NULL)::TEXT
      || ' | council_license_number=' || COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(p.council_license_number, '')), '') IS NULL
                                                             AND NULLIF(BTRIM(COALESCE(d.items ->> 'council_license_number', '')), '') IS NOT NULL)::TEXT
      || ' | taxi_badge_number=' || COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(p.taxi_badge_number, '')), '') IS NULL
                                                        AND NULLIF(BTRIM(COALESCE(d.items ->> 'taxi_badge_number', '')), '') IS NOT NULL)::TEXT
      || ' | taxi_license_expiry=' || COUNT(*) FILTER (WHERE p.taxi_license_expiry IS NULL
                                                          AND (d.items ->> 'taxi_license_expiry') ~ '^\d{4}-\d{2}-\d{2}$')::TEXT AS observed,
    'INFO' AS verdict
FROM public.profiles p
JOIN (
    SELECT p2.id,
           CASE WHEN jsonb_typeof(to_jsonb(p2) -> 'verification_items') = 'object'
                THEN to_jsonb(p2) -> 'verification_items'
                ELSE '{}'::JSONB END AS items
      FROM public.profiles p2
     WHERE COALESCE(to_jsonb(p2) ->> 'role', '') = 'driver'
) d ON d.id = p.id;


-- ============================================================================
-- SECTION 5 — SERVICE RESOLUTION COVERAGE
-- ============================================================================

-- 5.1 Every distinct raw service value in service_types, with what the frozen
--     taxonomy would resolve it to. NULL resolution is the fail-closed case.
SELECT
    'SERVICE_TYPES ' || COALESCE(st.slug, st.name, '(null)') AS check_name,
    'must resolve to one of ride/errand/delivery/van-moving' AS expected,
    CASE LOWER(BTRIM(COALESCE(st.slug, st.name, '')))
        WHEN 'ride' THEN 'ride'
        WHEN 'errand' THEN 'errand' WHEN 'shop' THEN 'errand' WHEN 'shopping' THEN 'errand'
        WHEN 'delivery' THEN 'delivery' WHEN 'deliver' THEN 'delivery'
        WHEN 'van-moving' THEN 'van-moving' WHEN 'van_moving' THEN 'van-moving'
        WHEN 'move' THEN 'van-moving' WHEN 'moving' THEN 'van-moving' WHEN 'van' THEN 'van-moving'
        ELSE 'UNRESOLVED' END AS observed,
    CASE WHEN LOWER(BTRIM(COALESCE(st.slug, st.name, ''))) IN
              ('ride','errand','shop','shopping','delivery','deliver',
               'van-moving','van_moving','move','moving','van')
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM public.service_types st
ORDER BY COALESCE(st.slug, st.name);

-- 5.2 Acquisition-sensitive jobs whose service CANNOT be resolved. Any non-zero
--     count means the Phase C trigger would fail closed on real jobs.
WITH sensitive_jobs AS (
    SELECT j.id,
           COALESCE(
               (SELECT COALESCE(st.slug::TEXT, st.name::TEXT)
                  FROM public.service_types st WHERE st.id = j.service_type_id),
               j.metadata ->> 'service_slug',
               ''
           ) AS raw_service
      FROM public.jobs j
     WHERE j.status IN ('pending', 'requested', 'searching', 'broadcasting', 'waiting')
)
SELECT
    'UNRESOLVED service on acquisition-sensitive jobs' AS check_name,
    'MUST be 0 before Phase C is enabled' AS expected,
    COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM sensitive_jobs s
WHERE LOWER(BTRIM(s.raw_service)) NOT IN
      ('ride','errand','shop','shopping','delivery','deliver',
       'van-moving','van_moving','move','moving','van');


-- ============================================================================
-- SECTION 6 — DRIVER POPULATION, APPROVAL AND PRESENCE STATE
-- ============================================================================
SELECT
    'DRIVER population and state' AS check_name,
    'informational: current approval/online/available distribution' AS expected,
    'drivers=' || COUNT(*) FILTER (WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver')::TEXT
      || ' | approved=' || COUNT(*) FILTER (WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
                                             AND ((to_jsonb(p) ->> 'is_verified')::TEXT = 'true'
                                                  OR COALESCE(to_jsonb(p) ->> 'verification_status', '') = 'approved'))::TEXT
      || ' | online=' || COUNT(*) FILTER (WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
                                            AND (to_jsonb(p) ->> 'is_online')::TEXT = 'true')::TEXT
      || ' | available=' || COUNT(*) FILTER (WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
                                               AND (to_jsonb(p) ->> 'is_available')::TEXT = 'true')::TEXT
      || ' | online_and_available=' || COUNT(*) FILTER (WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
                                                          AND (to_jsonb(p) ->> 'is_online')::TEXT = 'true'
                                                          AND (to_jsonb(p) ->> 'is_available')::TEXT = 'true')::TEXT
      || ' | online_not_available=' || COUNT(*) FILTER (WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
                                                          AND (to_jsonb(p) ->> 'is_online')::TEXT = 'true'
                                                          AND COALESCE(to_jsonb(p) ->> 'is_available', 'true') <> 'true')::TEXT AS observed,
    'INFO' AS verdict
FROM public.profiles p;

-- 6.1 Drivers whose declared services are readable, by canonical service.
SELECT
    'SELECTED SERVICE ' || s.value AS check_name,
    'informational: drivers declaring this service' AS expected,
    COUNT(*)::TEXT AS observed,
    'INFO' AS verdict
FROM public.profiles p
CROSS JOIN LATERAL (
    SELECT LOWER(BTRIM(v)) AS value
      FROM unnest(
          string_to_array(
              REPLACE(REPLACE(REPLACE(
                  COALESCE(to_jsonb(p) ->> 'driver_service_types',
                           to_jsonb(p) -> 'verification_items' ->> 'driver_service_types',
                           ''),
                  '[', ''), ']', ''), '"', ''),
              ',')
      ) AS v
) s
WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
  AND LOWER(BTRIM(s.value)) IN
      ('ride','errand','shop','shopping','delivery','deliver',
       'van-moving','van_moving','move','moving','van')
GROUP BY s.value
ORDER BY s.value;


-- ============================================================================
-- SECTION 7 — EXPIRY BLAST RADIUS (currently-enforced requirements only)
--
-- DATE semantics: expired <=> expiry < current_date. A document expiring TODAY
-- is still valid.
-- ============================================================================
WITH drivers AS (
    SELECT p.id,
           to_jsonb(p) AS j
      FROM public.profiles p
     WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
),
pairs(label, driver_id, expiry_text, enforced) AS (
    SELECT 'document.driving_licence.expiry', d.id, d.j ->> 'driver_license_expiry', TRUE  FROM drivers d
    UNION ALL
    SELECT 'document.insurance.expiry',       d.id, d.j ->> 'insurance_expiry',       TRUE  FROM drivers d
    UNION ALL
    SELECT 'licence.private_hire.expiry',     d.id, d.j ->> 'taxi_license_expiry',    TRUE  FROM drivers d
    UNION ALL
    SELECT 'vehicle.mot_expiry (advisory)',   d.id, NULL::TEXT,                       FALSE FROM drivers d
)
SELECT
    'EXPIRY ' || pr.label AS check_name,
    CASE WHEN pr.enforced THEN 'currently enforcement-relevant' ELSE 'advisory only' END AS expected,
    'expired<' || pg_catalog.current_setting('TimeZone') || '=' ||
      COUNT(*) FILTER (WHERE pr.expiry_text ~ '^\d{4}-\d{2}-\d{2}$'
                         AND (pr.expiry_text)::DATE < CURRENT_DATE)::TEXT
      || ' | expires_today=' || COUNT(*) FILTER (WHERE pr.expiry_text ~ '^\d{4}-\d{2}-\d{2}$'
                                                   AND (pr.expiry_text)::DATE = CURRENT_DATE)::TEXT
      || ' | missing=' || COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(pr.expiry_text, '')), '') IS NULL)::TEXT
      || ' | malformed=' || COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(pr.expiry_text, '')), '') IS NOT NULL
                                               AND pr.expiry_text !~ '^\d{4}-\d{2}-\d{2}$')::TEXT AS observed,
    'INFO' AS verdict
FROM pairs pr
GROUP BY pr.label, pr.enforced
ORDER BY pr.label;


-- ============================================================================
-- SECTION 8 — VEHICLE ANOMALIES
-- ============================================================================
SELECT
    'VEHICLE ' || a.anomaly AS check_name,
    a.expectation AS expected,
    a.observed AS observed,
    a.verdict AS verdict
FROM (
    SELECT 'duplicate vehicles per user' AS anomaly,
           'must be 0; market-availability.routes.ts:33 already 409s on >1' AS expectation,
           COUNT(*)::TEXT AS observed,
           CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
      FROM (SELECT v.user_id FROM public.vehicles v GROUP BY v.user_id HAVING COUNT(*) > 1) d
    UNION ALL
    SELECT 'driver_id disagrees with user_id',
           'informational: ownership ambiguity for the eligibility lookup',
           COUNT(*)::TEXT,
           'INFO'
      FROM public.vehicles v
     WHERE v.driver_id IS NOT NULL AND v.driver_id <> v.user_id
    UNION ALL
    SELECT 'driver profiles with no vehicle row',
           'informational: these drivers cannot be eligible (vehicle.present)',
           COUNT(*)::TEXT,
           'INFO'
      FROM public.profiles p
     WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
       AND NOT EXISTS (SELECT 1 FROM public.vehicles v WHERE v.user_id = p.id)
    UNION ALL
    SELECT 'vehicles whose user_id has no profiles row',
           'informational: orphaned vehicle rows',
           COUNT(*)::TEXT,
           'INFO'
      FROM public.vehicles v
     WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v.user_id)
    UNION ALL
    SELECT 'MOT expired (advisory rule)',
           'informational: would block only if TODO-POLICY-2C-4 is promoted',
           COUNT(*)::TEXT,
           'INFO'
      FROM public.vehicles v
     WHERE (to_jsonb(v) ->> 'mot_expiry_date') ~ '^\d{4}-\d{2}-\d{2}$'
       AND (to_jsonb(v) ->> 'mot_expiry_date')::DATE < CURRENT_DATE
    UNION ALL
    SELECT 'vehicle not verified (advisory rule)',
           'informational: would block only if TODO-POLICY-2C-4 is promoted',
           COUNT(*)::TEXT,
           'INFO'
      FROM public.vehicles v
     WHERE COALESCE(to_jsonb(v) ->> 'vehicle_verified', 'false') <> 'true'
) a;


-- ============================================================================
-- SECTION 9 — N12 INVARIANT HEALTH (must be unchanged and healthy)
-- ============================================================================
SELECT
    'N12 invariant idx_jobs_one_active_per_driver' AS check_name,
    'present, UNIQUE, valid, on public.jobs(driver_id)' AS expected,
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

SELECT
    'N12 duplicate occupying drivers' AS check_name,
    'MUST be 0' AS expected,
    COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (
    SELECT j.driver_id
      FROM public.jobs j
     WHERE j.driver_id IS NOT NULL
       AND j.status IN ('assigned','accepted','fare_agreed','heading_to_pickup',
                        'driver_en_route','arrived','driver_arrived','arrived_at_store',
                        'shopping_in_progress','collected','picked_up',
                        'en_route_to_customer','in_progress','delivered',
                        'over_budget_requested','requires_review')
     GROUP BY j.driver_id
    HAVING COUNT(*) > 1
) d;


-- ============================================================================
-- SECTION 10 — PHASE A OBJECT STATE (absent, or exactly compatible)
--
-- Reached only through to_regprocedure('...') string literals, so this runs
-- cleanly before the migration.
-- ============================================================================
WITH objects(name, sig, kind) AS (
    VALUES
        ('canonical_driver_service',              'public.canonical_driver_service(text)',                        'FUNCTION'),
        ('job_canonical_service',                 'public.job_canonical_service(uuid)',                           'FUNCTION'),
        ('safe_iso_date',                         'public.safe_iso_date(text)',                                   'FUNCTION'),
        ('driver_compliance_rules',               'public.driver_compliance_rules()',                             'FUNCTION'),
        ('driver_compliance_rule_passes',         'public.driver_compliance_rule_passes(text,text,timestamptz)',  'FUNCTION'),
        ('driver_service_eligibility',            'public.driver_service_eligibility(uuid,text,timestamptz)',     'FUNCTION'),
        ('enforce_job_acquisition_eligibility',   'public.enforce_job_acquisition_eligibility()',                 'FUNCTION')
)
SELECT
    'PHASE A ' || o.kind || ' ' || o.name AS check_name,
    'absent (clean install) or present and compatible' AS expected,
    CASE
        WHEN pg_catalog.to_regprocedure(o.sig) IS NULL THEN 'absent (clean install)'
        ELSE 'present | returns=' || pg_catalog.pg_get_function_result(p.oid)
             || ' | security=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
             || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
    END AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure(o.sig) IS NULL THEN 'PASS'
        WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%') THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM objects o
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(o.sig)
ORDER BY o.name;

-- 10.1 The acquisition trigger must be ABSENT, or present and DISABLED.
--      Present-and-enabled before Phase C would be a live behaviour change.
SELECT
    'PHASE A trigger trg_enforce_job_acquisition_eligibility' AS check_name,
    'absent, or present and DISABLED (tgenabled = D)' AS expected,
    CASE WHEN t.tgname IS NULL THEN 'absent (clean install)'
         ELSE 'present | enabled=' || t.tgenabled::TEXT
              || ' | timing=' || t.tgtype::TEXT END AS observed,
    CASE
        WHEN t.tgname IS NULL THEN 'PASS'
        WHEN t.tgenabled = 'D' THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_trigger t
       ON t.tgrelid = 'public.jobs'::regclass
      AND t.tgname = 'trg_enforce_job_acquisition_eligibility';


-- ============================================================================
-- SECTION 11 — GO / NO-GO
--
-- GO requires ALL of:
--   * every REQUIRED-now profiles and vehicles column present
--   * zero acquisition-sensitive jobs with an unresolvable service
--   * the N12 invariant healthy and zero duplicate occupying drivers
--   * the Phase A trigger absent or DISABLED
--   * every present Phase A function with a pinned search_path
--   * the canonical passenger-licence read precedence is SAFE: no row where a
--     present-but-unusable canonical expiry shadows usable compatibility data
--     (SECTION 4.3 reports the counts)
-- The Phase B backfill blast radius is reported, never gated: Phase A mutates
-- nothing, so "rows are backfillable" is not a Phase A precondition.
-- ============================================================================
WITH required_cols(obj, col) AS (
    VALUES
        ('profiles','id'),('profiles','role'),('profiles','country_code'),('profiles','full_name'),
        ('profiles','phone'),('profiles','date_of_birth'),('profiles','accepted_driver_agreement_at'),
        ('profiles','account_status'),('profiles','is_verified'),('profiles','verification_status'),
        ('profiles','onboarding_completed'),('profiles','driver_review_status'),
        ('profiles','driver_license_url'),('profiles','driver_license_expiry'),
        ('profiles','insurance_url'),('profiles','insurance_expiry'),
        ('vehicles','id'),('vehicles','user_id'),('vehicles','created_at'),('vehicles','type'),
        ('vehicles','capacity'),('vehicles','make'),('vehicles','model'),('vehicles','year'),
        ('vehicles','license_plate')
),
missing_cols AS (
    SELECT COUNT(*) AS n
      FROM required_cols r
     WHERE NOT EXISTS (
             SELECT 1 FROM information_schema.columns c
              WHERE c.table_schema = 'public'
                AND c.table_name = r.obj
                AND c.column_name = r.col)
),
unresolved AS (
    SELECT COUNT(*) AS n
      FROM public.jobs j
     WHERE j.status IN ('pending','requested','searching','broadcasting','waiting')
       AND LOWER(BTRIM(COALESCE(
               (SELECT COALESCE(st.slug::TEXT, st.name::TEXT)
                  FROM public.service_types st WHERE st.id = j.service_type_id),
               j.metadata ->> 'service_slug', ''))) NOT IN
           ('ride','errand','shop','shopping','delivery','deliver',
            'van-moving','van_moving','move','moving','van')
),
dup_drivers AS (
    SELECT COUNT(*) AS n
      FROM (
        SELECT j.driver_id
          FROM public.jobs j
         WHERE j.driver_id IS NOT NULL
           AND j.status = ANY (ARRAY['assigned','accepted','fare_agreed','heading_to_pickup',
                                     'driver_en_route','arrived','driver_arrived','arrived_at_store',
                                     'shopping_in_progress','collected','picked_up',
                                     'en_route_to_customer','in_progress','delivered',
                                     'over_budget_requested','requires_review'])
         GROUP BY j.driver_id
        HAVING COUNT(*) > 1
      ) d
),
trigger_state AS (
    SELECT CASE
             WHEN t.tgname IS NULL THEN 0
             WHEN t.tgenabled = 'D' THEN 0
             ELSE 1
           END AS n
      FROM (SELECT 1) AS one
      LEFT JOIN pg_catalog.pg_trigger t
             ON t.tgrelid = 'public.jobs'::regclass
            AND t.tgname = 'trg_enforce_job_acquisition_eligibility'
),
invariant AS (
    SELECT CASE
             WHEN i.indexrelid IS NULL THEN 1
             WHEN i.indisunique IS TRUE AND i.indisvalid IS TRUE AND a.attname = 'driver_id' THEN 0
             ELSE 1
           END AS n
      FROM (SELECT 1) AS one
      LEFT JOIN pg_catalog.pg_index i
             ON i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
      LEFT JOIN pg_catalog.pg_attribute a
             ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
),
unpinned AS (
    SELECT COUNT(*) AS n
      FROM (VALUES
                ('public.canonical_driver_service(text)'),
                ('public.job_canonical_service(uuid)'),
                ('public.safe_iso_date(text)'),
                ('public.driver_compliance_rules()'),
                ('public.driver_compliance_rule_passes(text,text,timestamptz)'),
                ('public.driver_service_eligibility(uuid,text,timestamptz)'),
                ('public.enforce_job_acquisition_eligibility()')
           ) AS o(sig)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(o.sig)
     WHERE p.oid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                        WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%')
),
driver_licence_raw AS (
    SELECT NULLIF(BTRIM(COALESCE(p.taxi_license_expiry::TEXT, '')), '') AS canon_expiry,
           NULLIF(BTRIM(COALESCE(to_jsonb(p) -> 'verification_items' ->> 'taxi_license_expiry', '')), '') AS json_expiry,
           NULLIF(BTRIM(COALESCE(p.council_license_expiry::TEXT, '')), '') AS alias_expiry
      FROM public.profiles p
     WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
),
canon_shaped AS (
    SELECT substring(v.canon_expiry, 1, 4)::INT AS cy,
           substring(v.canon_expiry, 6, 2)::INT AS cm,
           substring(v.canon_expiry, 9, 2)::INT AS cd,
           (v.json_expiry ~ '^\d{4}-\d{2}-\d{2}$'
            OR v.alias_expiry ~ '^\d{4}-\d{2}-\d{2}$') AS fallback_present
      FROM driver_licence_raw v
     WHERE v.canon_expiry ~ '^\d{4}-\d{2}-\d{2}$'
),
canon_unshaped AS (
    SELECT (v.json_expiry ~ '^\d{4}-\d{2}-\d{2}$'
            OR v.alias_expiry ~ '^\d{4}-\d{2}-\d{2}$') AS fallback_present
      FROM driver_licence_raw v
     WHERE v.canon_expiry IS NOT NULL
       AND v.canon_expiry !~ '^\d{4}-\d{2}-\d{2}$'
),
unsafe_precedence AS (
    SELECT (SELECT COUNT(*) FROM canon_shaped c
             WHERE NOT (c.cy BETWEEN 1 AND 9999
                        AND c.cm BETWEEN 1 AND 12
                        AND c.cd BETWEEN 1
                            AND (CASE c.cm
                                   WHEN 2 THEN (CASE WHEN c.cy % 4 = 0 AND (c.cy % 100 <> 0 OR c.cy % 400 = 0)
                                                     THEN 29 ELSE 28 END)
                                   WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
                                   ELSE 31 END))
               AND c.fallback_present)
          + (SELECT COUNT(*) FROM canon_unshaped u WHERE u.fallback_present) AS n
)
SELECT
    'PHASE A GO / NO-GO' AS check_name,
    'required columns present + services resolvable + N12 healthy + trigger absent-or-disabled + search_path pinned + licence read precedence safe' AS expected,
    'missing_required_columns=' || (SELECT n FROM missing_cols)::TEXT
      || ' | unresolved_service_jobs=' || (SELECT n FROM unresolved)::TEXT
      || ' | n12_invariant_bad=' || (SELECT n FROM invariant)::TEXT
      || ' | n12_duplicate_drivers=' || (SELECT n FROM dup_drivers)::TEXT
      || ' | trigger_enabled=' || (SELECT n FROM trigger_state)::TEXT
      || ' | unpinned_functions=' || (SELECT n FROM unpinned)::TEXT
      || ' | unsafe_licence_precedence=' || (SELECT n FROM unsafe_precedence)::TEXT AS observed,
    CASE
        WHEN (SELECT n FROM missing_cols) > 0 THEN 'NO-GO: a required column is absent'
        WHEN (SELECT n FROM unresolved) > 0 THEN 'NO-GO: acquisition-sensitive jobs with unresolvable service'
        WHEN (SELECT n FROM invariant) > 0 THEN 'NO-GO: N12 invariant missing or malformed'
        WHEN (SELECT n FROM dup_drivers) > 0 THEN 'NO-GO: duplicate occupying drivers (operator review)'
        WHEN (SELECT n FROM trigger_state) > 0 THEN 'NO-GO: acquisition trigger is ENABLED before Phase C'
        WHEN (SELECT n FROM unpinned) > 0 THEN 'NO-GO: a Phase A function is not pinned to search_path'
        WHEN (SELECT n FROM unsafe_precedence) > 0
            THEN 'NO-GO: canonical licence expiry shadows usable compatibility data (operator data repair required)'
        ELSE 'PASS'
    END AS verdict;
