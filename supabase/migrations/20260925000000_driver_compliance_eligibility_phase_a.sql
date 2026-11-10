-- ============================================================================
-- MOVABI — BATCH 2C / PHASE A: N13 + N14 compliance foundations
--
-- ADDITIVE + INERT. This migration changes NO live enforcement behaviour and
-- mutates NO application data:
--   * NO UPDATE / INSERT / DELETE against any application table,
--   * no RLS is enabled,
--   * no existing RLS policy is altered,
--   * no table or column privilege is revoked or granted,
--   * the acquisition trigger is CREATED but left DISABLED,
--   * no current API or client path invokes any object created here,
--   * DriverRequirementService behaviour is unchanged,
--   * jobs ownership behaviour is unchanged,
--   * is_online / is_available behaviour is unchanged.
--
-- Phase B (API/client transition) and Phase C (enforcement activation) are
-- deliberately NOT in this file. See the Phase A report for the staging plan.
--
-- WHAT THIS FILE CREATES
--   A. public.canonical_driver_service(text)          -- alias -> frozen taxonomy
--   B. public.job_canonical_service(uuid)             -- job -> canonical service
--   C. public.safe_iso_date(text)                     -- tolerant DATE parse
--   D. public.driver_compliance_rules()               -- THE canonical rule table
--   E. public.driver_service_eligibility(uuid,text,timestamptz)
--   F. public.enforce_job_acquisition_eligibility() + trigger (DISABLED)
--   G. passenger-licence canonical READ reconciliation (NO data mutation):
--      read precedence canonical column -> compatibility key -> legacy alias,
--      plus the Phase B backfill retained as DESIGN ONLY inside comments.
--
-- WHY EVERY FIELD IS READ VIA to_jsonb(row) ->> 'field'
-- ============================================================================
-- Repository SQL evidence does NOT contain all of the columns this rule set
-- needs. Verified against supabase_incremental_schema_reconcile.sql and
-- supabase/migrations/*.sql:
--
--   PRESENT in repository SQL: current_address, address_line1, home_address,
--   date_of_birth, country_code, accepted_driver_agreement_at,
--   driver_review_status, account_status, right_to_work_url,
--   right_to_work_share_code, driver_license_status, driver_license_expiry,
--   insurance_status, insurance_expiry, council_name, council_license_number,
--   council_license_authority, council_license_expiry, taxi_badge_number,
--   taxi_license_expiry, private_hire_driver_license_url,
--   private_hire_vehicle_license_url, private_hire_insurance_url,
--   courier_insurance_url/expiry, goods_in_transit_insurance_url/expiry,
--   moving_insurance_url/expiry, public_liability_insurance_url/expiry,
--   service_eligibility (vehicles), is_verified (vehicles)
--
--   ** ABSENT from repository SQL but required **: onboarding_completed,
--   verification_status, verification_items, driver_license_url,
--   insurance_url, goods_in_transit_url, and on production vehicles:
--   vehicle_verified, dvla_mot_status, mot_expiry_date, dvla_tax_status.
--
-- They exist in production (confirmed by the Batch 2C production evidence and
-- by live code that writes them) but are not defined by any repository
-- migration. A function that named them directly would fail at first execution
-- on any database built only from this repository. Reading them through
-- to_jsonb() ->> makes an absent column degrade to NULL instead of aborting -
-- the same reasoning Batch 1 used and documented for vehicles.service_class
-- (20260921000000:121-127). The Phase A preflight VERIFIES their real presence
-- in the target database so the operator is never guessing.
--
-- RESULT: this file never assumes a column exists; the preflight proves it.
--
-- DATE SEMANTICS (frozen)
-- ============================================================================
-- Every *_expiry field is a DATE meaning "valid through this date". Therefore
--     EXPIRED  <=>  expiry < p_at::date
-- and an expiry equal to the current date remains VALID for that whole calendar
-- day. Frozen by tests (yesterday = expired, today = valid). Comparison is
-- against the calling transaction's p_at, so the first acquisition attempted at
-- 00:01 after expiry is denied with no scheduled job and no cached state.
--
-- N12 FROZEN BOUNDARY — NOT TOUCHED
-- ============================================================================
-- idx_jobs_one_active_per_driver, the 16 frozen occupying statuses,
-- driver_occupying_statuses(), driver_has_active_job(),
-- driver_has_other_active_job() and MB001 semantics are read-only dependencies
-- of this file and are neither altered nor re-created here.
-- Compliance rejection uses SQLSTATE MB002, distinct from MB001.
-- ============================================================================


-- ============================================================================
-- SECTION A — CANONICAL SERVICE TAXONOMY
--
-- Output is one of the four frozen internal types or NULL. `NULL` means the
-- service could not be resolved and MUST fail closed as 'service.unresolved'.
-- The internal taxonomy is not renamed.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.canonical_driver_service(p_raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE LOWER(BTRIM(COALESCE(p_raw, '')))
        WHEN 'ride'        THEN 'ride'
        WHEN 'errand'      THEN 'errand'
        WHEN 'shop'        THEN 'errand'
        WHEN 'shopping'    THEN 'errand'
        WHEN 'delivery'    THEN 'delivery'
        WHEN 'deliver'     THEN 'delivery'
        WHEN 'van-moving'  THEN 'van-moving'
        WHEN 'van_moving'  THEN 'van-moving'
        WHEN 'move'        THEN 'van-moving'
        WHEN 'moving'      THEN 'van-moving'
        WHEN 'van'         THEN 'van-moving'
        ELSE NULL
    END;
$$;

CREATE OR REPLACE FUNCTION public.job_canonical_service(p_job_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.canonical_driver_service(
        COALESCE(
            (SELECT COALESCE(st.slug::TEXT, st.name::TEXT)
               FROM public.service_types st
              WHERE st.id = j.service_type_id),
            j.metadata ->> 'service_slug',
            ''
        )
    )
    FROM public.jobs j
    WHERE j.id = p_job_id;
$$;

-- Tolerant DATE parse: returns NULL for absent, blank, malformed OR impossible
-- calendar input, so a bad legacy value can never abort an acquisition check.
--
-- The exception handler is REQUIRED, not defensive decoration. A value such as
-- 2026-13-01 satisfies the frozen shape regex and is then REJECTED by the DATE
-- cast, which RAISES rather than degrading to NULL in PostgreSQL. Without the
-- handler the acquisition trigger would abort the acquiring transaction with a
-- raw date/time error instead of returning a compliance verdict. The TypeScript
-- mirror (safeIsoDate) already validates the calendar round-trip, so this keeps
-- SQL and TypeScript identical on that class of input.
CREATE OR REPLACE FUNCTION public.safe_iso_date(p_raw TEXT)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_raw TEXT;
BEGIN
    v_raw := NULLIF(BTRIM(COALESCE(p_raw, '')), '');
    IF v_raw IS NULL OR v_raw !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RETURN NULL;
    END IF;
    BEGIN
        RETURN v_raw::DATE;
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;
END;
$$;


-- ============================================================================
-- SECTION D — THE CANONICAL RULE TABLE
--
-- ONE row per blocking/advisory requirement. Single source of truth in SQL;
-- server/services/driver-eligibility.service.ts carries the SAME rows and a
-- structural test compares them field-by-field, so drift is detected rather
-- than discovered in production.
--
-- Columns (all scalar, deliberately, so the parity test can parse them):
--   rule_code      stable blocking-code vocabulary shared with TypeScript
--   service_scope  'all' or a canonical service name
--   country_scope  'any' or an upper ISO country code
--   condition      'always' | 'motor' | 'non_gb'
--   kind           grouping only (account/approval/profile/vehicle/document/licence/service)
--   field          the field name this rule evaluates
--   field_source   'profile' | 'vehicle' | 'derived'
--   check_type     'boolean_true' | 'text_present' | 'date_not_expired' | 'number_gt_1900'
--   blocking       TRUE blocks acquisition; FALSE is advisory/reported only
--   label          operator-facing text (apostrophe-free)
--
-- BLOCKING POLICY (Phase A decision — see the Phase A report)
-- ============================================================================
-- blocking = TRUE mirrors the requirements the AUTHORITATIVE engine already
-- enforces today (server/services/driver-requirement.service.ts, which is what
-- gates going online): profile basics, age, agreement, service selection,
-- right-to-work in GB, vehicle presence + vehicle detail fields, driving
-- licence and insurance PRESENCE, ride-only passenger licensing (council,
-- number, badge, expiry) and ride-only private-hire insurance presence, and
-- van-moving goods-in-transit outside GB. Expiry is now derived for those
-- documents that are already required, which is the mechanism Batch 2C exists
-- to provide.
--
-- blocking = FALSE is deliberate and is a NAMED POLICY DECISION, not an
-- oversight. Requirements that some legacy engine mentions but that no
-- authoritative engine currently enforces are carried as advisory rows so they
-- are visible in diagnostics and can be promoted to blocking by flipping ONE
-- boolean in Phase C WITHOUT a schema change:
--
--   TODO-POLICY-2C-1  document.courier_insurance   (errand, delivery)
--       src/app/core/services/compliance/compliance.service.ts:302 requires
--       courier insurance for delivery/errand, but the authoritative engine
--       requires no service insurance for those services. The two engines
--       disagree; Batch 2C does not invent a business rule.
--   TODO-POLICY-2C-2  document.moving_insurance / document.public_liability
--       (van-moving) — present only in the legacy engine
--       (compliance.service.ts:313-320).
--   TODO-POLICY-2C-3  document.driving_licence.status / document.insurance.status
--       The authoritative engine tests document PRESENCE via URL, never the
--       *_status column, so a rejected/expired status does not currently block.
--       Authority to make status authoritative is a policy decision.
--   TODO-POLICY-2C-4  vehicle.mot_expired / vehicle.tax_untaxed / vehicle.not_verified
--       vehicles.vehicle_verified, dvla_mot_status, mot_expiry_date and
--       dvla_tax_status exist in production but are read by NO acquisition path
--       today, and driver_online_eligibility.service.ts declares
--       VEHICLE_NOT_APPROVED without ever emitting it.
--   TODO-POLICY-2C-5  document.goods_in_transit for GB van-moving
--       The authoritative engine exempts GB (driver-requirement.service.ts:64);
--       the advisory row records the exemption explicitly.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.driver_compliance_rules()
RETURNS TABLE (
    rule_code     TEXT,
    service_scope TEXT,
    country_scope TEXT,
    condition     TEXT,
    kind          TEXT,
    field         TEXT,
    field_source  TEXT,
    check_type    TEXT,
    blocking      BOOLEAN,
    label         TEXT
)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT * FROM (VALUES
        -- account / approval ------------------------------------------------
        ('account.not_active',        'all',        'any', 'always', 'account',  'account_active',        'derived', 'boolean_true',    TRUE,  'Driver account is active'),
        ('onboarding.not_approved',   'all',        'any', 'always', 'approval', 'is_approved',           'derived', 'boolean_true',    TRUE,  'Driver is approved'),
        ('onboarding.not_complete',   'all',        'any', 'always', 'approval', 'onboarding_complete',   'derived', 'boolean_true',    TRUE,  'Driver onboarding is complete'),
        ('agreement.not_accepted',    'all',        'any', 'always', 'approval', 'agreement_accepted',    'derived', 'boolean_true',    TRUE,  'Driver agreement is accepted'),
        -- profile basics ----------------------------------------------------
        ('profile.full_name',         'all',        'any', 'always', 'profile',  'full_name',             'profile', 'text_present',    TRUE,  'Full legal name is present'),
        ('profile.phone',             'all',        'any', 'always', 'profile',  'phone',                 'profile', 'text_present',    TRUE,  'Contact phone is present'),
        ('profile.address',           'all',        'any', 'always', 'profile',  'address_present',       'derived', 'boolean_true',    TRUE,  'Residential address is present'),
        ('profile.date_of_birth',     'all',        'any', 'always', 'profile',  'driver_is_adult',       'derived', 'boolean_true',    TRUE,  'Driver meets the minimum age'),
        ('work.right_to_work',        'all',        'GB',  'always', 'document', 'right_to_work_present', 'derived', 'boolean_true',    TRUE,  'Right to work evidence is present'),
        -- vehicle -----------------------------------------------------------
        ('vehicle.present',           'all',        'any', 'always', 'vehicle',  'vehicle_present',       'derived', 'boolean_true',    TRUE,  'A vehicle is registered'),
        ('vehicle.make',              'all',        'any', 'motor',  'vehicle',  'make',                  'vehicle', 'text_present',    TRUE,  'Vehicle make is present'),
        ('vehicle.model',             'all',        'any', 'motor',  'vehicle',  'model',                 'vehicle', 'text_present',    TRUE,  'Vehicle model is present'),
        ('vehicle.colour',            'all',        'any', 'motor',  'vehicle',  'vehicle_colour',        'derived', 'text_present',    TRUE,  'Vehicle colour is present'),
        ('vehicle.year',              'all',        'any', 'motor',  'vehicle',  'year',                  'vehicle', 'number_gt_1900',  TRUE,  'Vehicle year is valid'),
        ('vehicle.registration',      'all',        'any', 'motor',  'vehicle',  'license_plate',         'vehicle', 'text_present',    TRUE,  'Vehicle registration is present'),
        -- base documents (presence — mirrors the authoritative engine) ------
        ('document.driving_licence',        'all', 'any', 'motor',  'document', 'driver_license_url',              'profile', 'text_present',    TRUE, 'Driving licence document is present'),
        ('document.driving_licence.expiry', 'all', 'any', 'motor',  'document', 'driver_license_expiry',           'profile', 'date_not_expired', TRUE, 'Driving licence is not expired'),
        ('document.insurance',              'all', 'any', 'motor',  'document', 'insurance_url',                   'profile', 'text_present',    TRUE, 'Vehicle insurance document is present'),
        ('document.insurance.expiry',       'all', 'any', 'motor',  'document', 'insurance_expiry',                'profile', 'date_not_expired', TRUE, 'Vehicle insurance is not expired'),
        -- ride-only passenger licensing -------------------------------------
        -- Read precedence is canonical-typed-column FIRST, then the legacy
        -- verification_items compatibility key, then the legacy alias column.
        -- Resolved into derived fields below so the evaluator stays generic.
        ('licence.private_hire.council',    'ride', 'any', 'always', 'licence', 'licence_council_name',           'derived', 'text_present',    TRUE, 'Licensing authority is present'),
        ('licence.private_hire.number',     'ride', 'any', 'always', 'licence', 'licence_number',                 'derived', 'text_present',    TRUE, 'Private hire licence number is present'),
        ('licence.private_hire.badge',      'ride', 'any', 'always', 'licence', 'licence_badge_number',           'derived', 'text_present',    TRUE, 'Taxi or private hire badge is present'),
        ('licence.private_hire.expiry',     'ride', 'any', 'always', 'licence', 'licence_expiry',                 'derived', 'date_not_expired', TRUE, 'Private hire licence is not expired'),
        ('document.private_hire_insurance', 'ride', 'any', 'always', 'document','private_hire_insurance_url',    'profile', 'text_present',    TRUE, 'Private hire insurance is present'),
        -- van-moving --------------------------------------------------------
        ('document.goods_in_transit',       'van-moving', 'any', 'non_gb', 'document', 'goods_in_transit_insurance_url', 'profile', 'text_present', TRUE, 'Goods in transit cover is present outside GB'),
        -- ADVISORY (blocking = FALSE) — named policy decisions, see header --
        ('document.courier_insurance',      'errand',     'any', 'motor', 'document', 'courier_insurance_url',          'profile', 'text_present',    FALSE, 'Courier insurance is present (advisory)'),
        ('document.courier_insurance',      'delivery',   'any', 'motor', 'document', 'courier_insurance_url',          'profile', 'text_present',    FALSE, 'Courier insurance is present (advisory)'),
        ('document.courier_insurance.expiry','delivery',  'any', 'motor', 'document', 'courier_insurance_expiry',       'profile', 'date_not_expired',FALSE, 'Courier insurance is not expired (advisory)'),
        ('document.moving_insurance',       'van-moving', 'any', 'always','document', 'moving_insurance_url',           'profile', 'text_present',    FALSE, 'Moving insurance is present (advisory)'),
        ('document.public_liability',       'van-moving', 'any', 'always','document', 'public_liability_insurance_url', 'profile', 'text_present',    FALSE, 'Public liability insurance is present (advisory)'),
        ('document.driving_licence.status', 'all',       'any', 'motor', 'document', 'driver_license_status',          'profile', 'status_ok',       FALSE, 'Driving licence status is not rejected or expired (advisory)'),
        ('document.insurance.status',       'all',       'any', 'motor', 'document', 'insurance_status',               'profile', 'status_ok',       FALSE, 'Insurance status is not rejected or expired (advisory)'),
        ('vehicle.mot_expiry',              'all',       'any', 'motor', 'vehicle',  'mot_expiry_date',                'vehicle', 'date_not_expired',FALSE, 'Vehicle MOT is not expired (advisory)'),
        ('vehicle.tax_status',              'all',       'any', 'motor', 'vehicle',  'dvla_tax_status',                'vehicle', 'tax_ok',          FALSE, 'Vehicle tax status is valid (advisory)'),
        ('vehicle.verified',                'all',       'any', 'motor', 'vehicle',  'vehicle_verified',               'vehicle', 'boolean_true',    FALSE, 'Vehicle is verified (advisory)')
    ) AS r(rule_code, service_scope, country_scope, condition, kind, field, field_source, check_type, blocking, label);
$$;


-- ============================================================================
-- SECTION E — CANONICAL ELIGIBILITY
--
-- AUTHORITATIVE FOR ACQUISITION once the trigger is enabled in Phase C.
-- TypeScript (server/services/driver-eligibility.service.ts) mirrors this rule
-- set for server-side explanations and pre-checks and is proven equivalent by
-- tests; it is NOT the acquisition authority.
--
-- STABLE, SECURITY DEFINER, pinned search_path, no dynamic SQL: the function
-- only reads public.profiles and public.vehicles by primary key and evaluates
-- the rule table. It writes nothing and takes no lock.
--
-- Fail-closed rules: an unresolvable service yields eligible = false with
-- blocking_codes = {'service.unresolved'}. A missing profile yields the same.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.driver_service_eligibility(
    p_driver_id UUID,
    p_service   TEXT,
    p_at        TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (eligible BOOLEAN, blocking_codes TEXT[], advisory_codes TEXT[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_service  TEXT;
    v_profile  JSONB;
    v_vehicle  JSONB;
    v_items    JSONB;
    v_derived  JSONB;
    v_vehicle_text TEXT;
    v_country  TEXT;
    v_blocking TEXT[];
    v_advisory TEXT[];
BEGIN
    v_service := public.canonical_driver_service(p_service);

    SELECT to_jsonb(p) INTO v_profile FROM public.profiles p WHERE p.id = p_driver_id;
    IF v_profile IS NULL THEN
        RETURN QUERY SELECT FALSE, ARRAY['service.unresolved']::TEXT[], ARRAY[]::TEXT[];
        RETURN;
    END IF;

    IF v_service IS NULL THEN
        RETURN QUERY SELECT FALSE, ARRAY['service.unresolved']::TEXT[], ARRAY[]::TEXT[];
        RETURN;
    END IF;

    SELECT to_jsonb(v) INTO v_vehicle
      FROM public.vehicles v
     WHERE v.user_id = p_driver_id
     ORDER BY v.created_at DESC NULLS LAST, v.id DESC
     LIMIT 1;

    v_vehicle_text := LOWER(
        COALESCE(v_vehicle ->> 'capacity', '') || ' ' || COALESCE(v_vehicle ->> 'type', '')
    );
    v_country := UPPER(COALESCE(v_profile ->> 'country_code', ''));

    -- Legacy compatibility bag. Only the object shape the onboarding flow writes
    -- is read; the array/string shapes the TypeScript parser also tolerates are
    -- deliberately not guessed at here.
    v_items := CASE WHEN jsonb_typeof(v_profile -> 'verification_items') = 'object'
                    THEN v_profile -> 'verification_items'
                    ELSE '{}'::JSONB END;

    -- Derived flags. Every one is a boolean in text form so the rule table can
    -- stay scalar and the parity test can compare it directly.
    v_derived := jsonb_build_object(
        'account_active',      (COALESCE(v_profile ->> 'account_status', 'active') NOT IN ('paused', 'suspended', 'blocked'))::TEXT,
        'is_approved',         ((v_profile ->> 'is_verified')::TEXT = 'true'
                                OR COALESCE(v_profile ->> 'verification_status', '') = 'approved')::TEXT,
        'onboarding_complete', (COALESCE(v_profile ->> 'onboarding_completed', 'false') = 'true')::TEXT,
        'agreement_accepted',  (NULLIF(BTRIM(COALESCE(v_profile ->> 'accepted_driver_agreement_at', '')), '') IS NOT NULL)::TEXT,
        'address_present',     ((NULLIF(BTRIM(COALESCE(v_profile ->> 'current_address', '')), '') IS NOT NULL)
                                OR (NULLIF(BTRIM(COALESCE(v_profile ->> 'address_line1', '')), '') IS NOT NULL)
                                OR (NULLIF(BTRIM(COALESCE(v_profile ->> 'home_address', '')), '') IS NOT NULL))::TEXT,
        'driver_is_adult',     (public.safe_iso_date(v_profile ->> 'date_of_birth') IS NOT NULL
                                AND public.safe_iso_date(v_profile ->> 'date_of_birth')
                                    <= (p_at::DATE - INTERVAL '18 years')::DATE)::TEXT,
        'right_to_work_present', ((NULLIF(BTRIM(COALESCE(v_profile ->> 'right_to_work_url', '')), '') IS NOT NULL)
                                OR (NULLIF(BTRIM(COALESCE(v_profile ->> 'right_to_work_share_code', '')), '') IS NOT NULL))::TEXT,
        'vehicle_present',     (v_vehicle IS NOT NULL)::TEXT,
        'driver_is_motor',     (v_vehicle IS NOT NULL
                                AND v_vehicle_text !~ 'bicycle|bike|cycle')::TEXT,
        -- Production stores the vehicle colour in the color column, while the
        -- mapped driver-vehicle model presents it as colour. Accept both, color
        -- first. Avoid apostrophes inside these comments: the repository SQL
        -- lexer does not strip comments inside dollar-quoted bodies.
        'vehicle_colour',      COALESCE(
            NULLIF(BTRIM(COALESCE(v_vehicle ->> 'color', '')), ''),
            NULLIF(BTRIM(COALESCE(v_vehicle ->> 'colour', '')), '')),
        -- Passenger licence: canonical typed column FIRST, then the legacy
        -- verification_items compatibility key, then the legacy alias column.
        'licence_council_name', COALESCE(
            NULLIF(BTRIM(COALESCE(v_profile ->> 'council_name', '')), ''),
            NULLIF(BTRIM(COALESCE(v_items ->> 'council_name', '')), ''),
            NULLIF(BTRIM(COALESCE(v_profile ->> 'council_license_authority', '')), '')),
        'licence_number',       COALESCE(
            NULLIF(BTRIM(COALESCE(v_profile ->> 'council_license_number', '')), ''),
            NULLIF(BTRIM(COALESCE(v_items ->> 'council_license_number', '')), '')),
        'licence_badge_number', COALESCE(
            NULLIF(BTRIM(COALESCE(v_profile ->> 'taxi_badge_number', '')), ''),
            NULLIF(BTRIM(COALESCE(v_items ->> 'taxi_badge_number', '')), '')),
        'licence_expiry',       COALESCE(
            v_profile ->> 'taxi_license_expiry',
            v_items ->> 'taxi_license_expiry',
            v_profile ->> 'council_license_expiry')
    );

    SELECT
        array_agg(DISTINCT r.rule_code ORDER BY r.rule_code) FILTER (WHERE r.blocking),
        array_agg(DISTINCT r.rule_code ORDER BY r.rule_code) FILTER (WHERE NOT r.blocking)
      INTO v_blocking, v_advisory
      FROM public.driver_compliance_rules() r
     WHERE (r.service_scope = 'all' OR r.service_scope = v_service)
       AND (r.country_scope = 'any' OR r.country_scope = v_country)
       AND (r.condition = 'always'
            OR (r.condition = 'motor'  AND (v_derived ->> 'driver_is_motor') = 'true')
            OR (r.condition = 'non_gb' AND v_country <> 'GB'))
       AND NOT public.driver_compliance_rule_passes(
                   r.check_type,
                   CASE r.field_source
                       WHEN 'vehicle' THEN v_vehicle ->> r.field
                       WHEN 'derived' THEN v_derived ->> r.field
                       ELSE v_profile ->> r.field
                   END,
                   p_at);

    RETURN QUERY SELECT
        COALESCE(array_length(v_blocking, 1), 0) = 0,
        COALESCE(v_blocking, ARRAY[]::TEXT[]),
        COALESCE(v_advisory, ARRAY[]::TEXT[]);
END;
$$;

-- Single generic rule evaluator, kept separate so `driver_service_eligibility`
-- stays readable and so tests can exercise each check type directly.
CREATE OR REPLACE FUNCTION public.driver_compliance_rule_passes(
    p_check_type TEXT,
    p_value      TEXT,
    p_at         TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_check_type
        WHEN 'boolean_true'    THEN COALESCE(p_value, 'false') = 'true'
        WHEN 'text_present'    THEN NULLIF(BTRIM(COALESCE(p_value, '')), '') IS NOT NULL
        WHEN 'number_gt_1900'  THEN p_value ~ '^\d{4}$' AND (p_value)::NUMERIC > 1900
        -- DATE semantics: valid THROUGH the expiry date, so only
        -- expiry < p_at::date is expired. An absent or malformed date fails
        -- closed (a document whose expiry cannot be read is not evidence).
        WHEN 'date_not_expired' THEN public.safe_iso_date(p_value) IS NOT NULL
                                   AND public.safe_iso_date(p_value) >= p_at::DATE
        WHEN 'status_ok'       THEN COALESCE(LOWER(p_value), '') NOT IN ('rejected', 'expired')
        WHEN 'tax_ok'          THEN COALESCE(LOWER(p_value), '') NOT IN ('untaxed', 'sorn', 'not_taxed')
        ELSE FALSE
    END;
$$;


-- ============================================================================
-- SECTION F — ACQUISITION TRIGGER (CREATED **DISABLED**)
--
-- Disabled by design in Phase A: this migration must not change driver
-- eligibility or jobs ownership behaviour. Phase C enables it explicitly, and
-- emergency rollback is a single ALTER TABLE ... DISABLE TRIGGER.
-- No feature flag / system_settings row is introduced, so eligibility stays
-- stateless and this file depends on no new runtime configuration.
--
-- WHAT COUNTS AS AN ACQUISITION
--   NEW.driver_id IS NULL                     -> release,        ALLOW
--   NEW.driver_id = OLD.driver_id             -> re-assertion,   ALLOW
--   OLD.driver_id IS NULL, NEW is not null    -> acquisition,    REQUIRE eligibility for NEW
--   OLD.driver_id <> NEW.driver_id (A -> B)   -> REASSIGNMENT,   REQUIRE eligibility for NEW
--
-- A -> B reassignment is reachable in this repository and is therefore NOT
-- treated as harmless re-assertion:
--   * server/routes/booking.routes.ts:1026 legacy negotiation accept sets
--     driver_id = acceptedDriverId with no driver_id predicate, and
--     acceptedDriverId may be a driver OTHER than the job's current driver;
--   * public.lock_marketplace_fare (reconcile:3542-3547) updates driver_id with
--     no driver predicate at all.
-- The inbound driver B is the one acquiring ownership, so B is the driver whose
-- eligibility is enforced; the outbound driver A needs nothing. This makes the
-- guard fail closed for reassignment instead of silently allowing it.
-- Phase C additionally routes reassignment through an explicit
-- release-to-NULL-then-approved-assignment step to close those two predicates;
-- that is Phase C work and is not implemented here.
--
-- SECURITY DEFINER + pinned search_path: the trigger must evaluate eligibility
-- identically regardless of who performs the write, including service_role.
-- No dynamic SQL; arguments are values only.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.enforce_job_acquisition_eligibility()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_service TEXT;
    v_result  RECORD;
BEGIN
    -- Release to unowned: always allowed.
    IF NEW.driver_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Same-driver re-assertion (e.g. completion re-writing the same owner):
    -- not an acquisition, always allowed.
    IF TG_OP = 'UPDATE' AND NEW.driver_id = OLD.driver_id THEN
        RETURN NEW;
    END IF;

    -- Genuine acquisition OR reassignment: the INCOMING driver must be eligible
    -- for the canonical service of this job.
    v_service := public.job_canonical_service(NEW.id);

    SELECT * INTO v_result
      FROM public.driver_service_eligibility(NEW.driver_id, v_service, now());

    IF v_result.eligible IS NOT TRUE THEN
        -- Codes only. Never document URLs, admin notes, reviewer identity or
        -- checklist prose: those must not travel through a database error.
        RAISE EXCEPTION 'Driver is not eligible for this service'
            USING ERRCODE    = 'MB002',
                  CONSTRAINT = 'enforce_job_acquisition_eligibility',
                  DETAIL     = array_to_string(
                                   COALESCE(v_result.blocking_codes, ARRAY[]::TEXT[]), ',');
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_job_acquisition_eligibility ON public.jobs;
CREATE TRIGGER trg_enforce_job_acquisition_eligibility
    BEFORE UPDATE OF driver_id ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_job_acquisition_eligibility();

-- *** PHASE A: LEAVE DISABLED. *** Phase C enables this trigger deliberately.
-- No live path INSERTs jobs with driver_id set (server/routes/booking.routes.ts:65
-- inserts customer-owned jobs with no driver_id), so only the UPDATE trigger is
-- required; an INSERT trigger is a Phase C decision.
ALTER TABLE public.jobs DISABLE TRIGGER trg_enforce_job_acquisition_eligibility;


-- ============================================================================
-- SECTION G — PASSENGER-LICENCE CANONICAL READ RECONCILIATION
--              (and Phase B backfill READINESS — DESIGN ONLY, NEVER EXECUTED)
--
-- This section contains ZERO data mutation. It exists so that the canonical
-- passenger-licence model is fully specified, readable and testable in Phase A
-- while Phase A itself stays inert.
--
-- STORAGE MODEL
--   Canonical storage          = the dedicated typed profiles columns:
--                                council_name, council_license_number,
--                                taxi_badge_number, taxi_license_expiry
--   Compatibility storage      = profiles.verification_items (OBJECT shape),
--                                written by the onboarding flow
--                                (src/app/apps/mobile/features/driver/onboarding/
--                                onboarding.page.ts:1536-1539) and by the server
--                                passenger-licence endpoint.
--   Legacy alias storage       = council_license_authority,
--                                council_license_expiry
--
-- FROZEN READ PRECEDENCE (implemented in SECTION E derived flags; mirrored by
-- readPassengerLicence() in server/services/driver-eligibility.service.ts):
--   1. the canonical typed column (authoritative),
--   2. the verification_items compatibility key,
--   3. the legacy alias column.
-- A present canonical value therefore ALWAYS wins, so a stale JSON mirror can
-- never override the canonical column. Compatibility storage is read only when
-- the canonical value is absent, and only when it is OBJECT-shaped: the
-- array/string shapes are skipped rather than guessed at.
--
-- WHY THE ACTUAL BACKFILL IS NOT HERE
-- ============================================================================
-- Filling the canonical columns from verification_items is NOT behaviour-neutral
-- today: server/services/driver-requirement.service.ts (the LIVE online gate)
-- reads council_license_number, so any row whose canonical column is empty while
-- the JSON key is populated would flip its ride gate from fail to pass. A
-- loosening is still a behaviour change, and Phase A must change nothing.
-- The actual UPDATE therefore moves to PHASE B — controlled data reconciliation,
-- with the Phase A preflight blast-radius counts reviewed by an operator first.
-- The design is retained below, commented out, so it cannot be lost and so tests
-- can prove exactly what a future backfill would and would not do.
--
-- PROPERTIES THE PHASE B BACKFILL MUST KEEP (asserted by the Phase A suite
-- against planPassengerLicenceBackfill(), which is a PURE description and is
-- called by nothing):
--   * ADDITIVE        — COALESCE, an existing canonical value always wins
--   * IDEMPOTENT      — a second run finds nothing left to fill
--   * NULL/EMPTY-ONLY — a row is touched only when a target is NULL or blank
--   * NON-DESTRUCTIVE — verification_items is never modified, re-written or
--                       deleted, and no JSON is reshaped (no jsonb_set)
--   * SHAPE-GUARDED   — only OBJECT-shaped verification_items are read
--   * SAFE            — a malformed compatibility date becomes NULL
--                       (safe_iso_date) instead of aborting
--   * DRIVER-SCOPED   — profile rows with role = 'driver' only
-- ============================================================================
--
-- ---------------------------------------------------------------------------
-- PHASE B — NOT EXECUTED BY PHASE A. Retained as design only.
--
-- WITH src AS (
--     SELECT p.id,
--            CASE WHEN jsonb_typeof(to_jsonb(p) -> 'verification_items') = 'object'
--                 THEN to_jsonb(p) -> 'verification_items'
--            END AS items
--       FROM public.profiles p
--      WHERE COALESCE(to_jsonb(p) ->> 'role', '') = 'driver'
-- )
-- UPDATE public.profiles p
--    SET council_name           = COALESCE(NULLIF(BTRIM(p.council_name), ''),           NULLIF(BTRIM(s.items ->> 'council_name'), '')),
--        council_license_number = COALESCE(NULLIF(BTRIM(p.council_license_number), ''), NULLIF(BTRIM(s.items ->> 'council_license_number'), '')),
--        taxi_badge_number      = COALESCE(NULLIF(BTRIM(p.taxi_badge_number), ''),      NULLIF(BTRIM(s.items ->> 'taxi_badge_number'), '')),
--        taxi_license_expiry    = COALESCE(p.taxi_license_expiry,                        public.safe_iso_date(s.items ->> 'taxi_license_expiry'))
--   FROM src s
--  WHERE p.id = s.id
--    AND s.items IS NOT NULL
--    AND ( NULLIF(BTRIM(COALESCE(p.council_name, '')), '') IS NULL
--       OR NULLIF(BTRIM(COALESCE(p.council_license_number, '')), '') IS NULL
--       OR NULLIF(BTRIM(COALESCE(p.taxi_badge_number, '')), '') IS NULL
--       OR p.taxi_license_expiry IS NULL );
--
-- END PHASE B DESIGN. Nothing above this marker is executable: every line is a
-- comment. SECTION G executes no SQL statement at all.
-- ---------------------------------------------------------------------------


-- ============================================================================
-- SECTION H — PRIVILEGES
--
-- Every new object is INTERNAL. Production carries broad DEFAULT FUNCTION
-- privileges, so REVOKE FROM PUBLIC alone is not sufficient: each must-not-have
-- role is revoked explicitly (the Batch 1 / 2A discipline). Nothing is granted,
-- so no client can probe another driver's eligibility.
--
-- No existing privilege is revoked or granted anywhere in this file: the Phase A
-- constraint forbids column/table privilege changes.
-- ============================================================================
REVOKE ALL ON FUNCTION public.canonical_driver_service(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_canonical_service(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.safe_iso_date(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_compliance_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_compliance_rule_passes(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_service_eligibility(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_job_acquisition_eligibility() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.canonical_driver_service(TEXT) FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.job_canonical_service(UUID) FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.safe_iso_date(TEXT) FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.driver_compliance_rules() FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.driver_compliance_rule_passes(TEXT, TEXT, TIMESTAMPTZ) FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.driver_service_eligibility(UUID, TEXT, TIMESTAMPTZ) FROM anon, authenticated, service_role;
-- The trigger function is executed by the table owner; no role needs EXECUTE.
REVOKE EXECUTE ON FUNCTION public.enforce_job_acquisition_eligibility() FROM anon, authenticated, service_role;

-- PHASE A EXPLICIT NON-ACTIONS (asserted by the static tests):
--   * no UPDATE / INSERT / DELETE against any application table (SECTION G
--     executes no statement at all: the Phase B backfill exists only as comments)
--   * no ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY
--   * no CREATE/DROP POLICY
--   * no REVOKE/GRANT on TABLES or COLUMNS
--   * no ALTER TABLE public.jobs ENABLE TRIGGER
