/**
 * Batch 2C / Phase A — canonical driver service eligibility (TypeScript).
 *
 * AUTHORITY
 * ============================================================================
 * The DATABASE is authoritative for acquisition. Once the Phase C trigger
 * `trg_enforce_job_acquisition_eligibility` is enabled,
 * `public.driver_service_eligibility(uuid, text, timestamptz)` decides whether a
 * driver may acquire a job, inside the acquiring transaction.
 *
 * This module is the SERVER-SIDE MIRROR: it produces the same verdict from the
 * same rule table so the API can return structured, human-usable explanations
 * and so pre-checks can be surfaced in onboarding/UI. It must never be the
 * acquisition authority, and it must never be used by an Angular client to
 * decide.
 *
 * PARITY
 * ============================================================================
 * DRIVER_ELIGIBILITY_RULES below is a literal copy of the VALUES rows in
 * `public.driver_compliance_rules()` (migration
 * supabase/migrations/20260925000000_driver_compliance_eligibility_phase_a.sql).
 * SQL and TypeScript cannot import the same runtime table, so parity is
 * ENFORCED BY TEST rather than assumed:
 *   src/testing/batch2c-phase-a-eligibility.spec.ts parses the migration's rule
 *   rows and compares them to this array field-by-field, plus service-scoping
 *   and expiry-boundary parity, plus a mutation test proving that a code drift
 *   is detected. Editing one side without the other fails the suite.
 *
 * PHASE A SCOPE
 * ============================================================================
 * Nothing imports this module yet. It is additive: wiring it into the live
 * online gate (`DriverRequirementService.resolve()` /
 * `DriverOnlineEligibilityService.evaluate()`) is Phase B/C work, precisely
 * because doing so in Phase A would change current driver eligibility.
 * No blocking semantics are changed by the existence of this file.
 *
 * `planPassengerLicenceBackfill()` is PHASE B READINESS ONLY: a pure description
 * of what the future controlled data-reconciliation UPDATE would change. It is
 * called by nothing, and Phase A executes no backfill at all.
 */

/** The frozen internal service taxonomy. Never renamed. */
export const CANONICAL_DRIVER_SERVICES = ['ride', 'errand', 'delivery', 'van-moving'] as const;
export type CanonicalDriverService = (typeof CANONICAL_DRIVER_SERVICES)[number];

export type DriverComplianceCheckType =
    | 'boolean_true'
    | 'text_present'
    | 'date_not_expired'
    | 'number_gt_1900'
    | 'status_ok'
    | 'tax_ok';

export type DriverComplianceCondition = 'always' | 'motor' | 'non_gb';
export type DriverComplianceFieldSource = 'profile' | 'vehicle' | 'derived';

export interface DriverEligibilityRule {
    ruleCode: string;
    serviceScope: 'all' | CanonicalDriverService;
    countryScope: 'any' | string;
    condition: DriverComplianceCondition;
    kind: string;
    field: string;
    fieldSource: DriverComplianceFieldSource;
    checkType: DriverComplianceCheckType;
    blocking: boolean;
    label: string;
}

/**
 * Canonical blocking-code vocabulary. Mirrors `public.driver_compliance_rules()`.
 *
 * `blocking: false` rows are NAMED POLICY DECISIONS, not oversights: they record
 * requirements a legacy engine mentions but no authoritative engine enforces.
 * They are reported as advisory and can be promoted in Phase C by flipping one
 * boolean, with no schema change.
 *   TODO-POLICY-2C-1  document.courier_insurance (errand/delivery) — the legacy
 *                     compliance.service.ts requires it; the authoritative
 *                     engine does not. Batch 2C does not invent a business rule.
 *   TODO-POLICY-2C-2  moving / public liability (van-moving) — legacy only.
 *   TODO-POLICY-2C-3  *_status rejected/expired — the authoritative engine tests
 *                     document presence via URL, never the status column.
 *   TODO-POLICY-2C-4  MOT / tax / vehicle_verified — present in production, read
 *                     by no acquisition path today.
 *   TODO-POLICY-2C-5  goods-in-transit for GB van-moving — the authoritative
 *                     engine exempts GB; the exemption is explicit here.
 */
export const DRIVER_ELIGIBILITY_RULES: readonly DriverEligibilityRule[] = [
    // account / approval -----------------------------------------------------
    { ruleCode: 'account.not_active', serviceScope: 'all', countryScope: 'any', condition: 'always', kind: 'account', field: 'account_active', fieldSource: 'derived', checkType: 'boolean_true', blocking: true, label: 'Driver account is active' },
    { ruleCode: 'onboarding.not_approved', serviceScope: 'all', countryScope: 'any', condition: 'always', kind: 'approval', field: 'is_approved', fieldSource: 'derived', checkType: 'boolean_true', blocking: true, label: 'Driver is approved' },
    { ruleCode: 'onboarding.not_complete', serviceScope: 'all', countryScope: 'any', condition: 'always', kind: 'approval', field: 'onboarding_complete', fieldSource: 'derived', checkType: 'boolean_true', blocking: true, label: 'Driver onboarding is complete' },
    { ruleCode: 'agreement.not_accepted', serviceScope: 'all', countryScope: 'any', condition: 'always', kind: 'approval', field: 'agreement_accepted', fieldSource: 'derived', checkType: 'boolean_true', blocking: true, label: 'Driver agreement is accepted' },
    // profile basics ---------------------------------------------------------
    { ruleCode: 'profile.full_name', serviceScope: 'all', countryScope: 'any', condition: 'always', kind: 'profile', field: 'full_name', fieldSource: 'profile', checkType: 'text_present', blocking: true, label: 'Full legal name is present' },
    { ruleCode: 'profile.phone', serviceScope: 'all', countryScope: 'any', condition: 'always', kind: 'profile', field: 'phone', fieldSource: 'profile', checkType: 'text_present', blocking: true, label: 'Contact phone is present' },
    { ruleCode: 'profile.address', serviceScope: 'all', countryScope: 'any', condition: 'always', kind: 'profile', field: 'address_present', fieldSource: 'derived', checkType: 'boolean_true', blocking: true, label: 'Residential address is present' },
    { ruleCode: 'profile.date_of_birth', serviceScope: 'all', countryScope: 'any', condition: 'always', kind: 'profile', field: 'driver_is_adult', fieldSource: 'derived', checkType: 'boolean_true', blocking: true, label: 'Driver meets the minimum age' },
    { ruleCode: 'work.right_to_work', serviceScope: 'all', countryScope: 'GB', condition: 'always', kind: 'document', field: 'right_to_work_present', fieldSource: 'derived', checkType: 'boolean_true', blocking: true, label: 'Right to work evidence is present' },
    // vehicle ----------------------------------------------------------------
    { ruleCode: 'vehicle.present', serviceScope: 'all', countryScope: 'any', condition: 'always', kind: 'vehicle', field: 'vehicle_present', fieldSource: 'derived', checkType: 'boolean_true', blocking: true, label: 'A vehicle is registered' },
    { ruleCode: 'vehicle.make', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'vehicle', field: 'make', fieldSource: 'vehicle', checkType: 'text_present', blocking: true, label: 'Vehicle make is present' },
    { ruleCode: 'vehicle.model', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'vehicle', field: 'model', fieldSource: 'vehicle', checkType: 'text_present', blocking: true, label: 'Vehicle model is present' },
    { ruleCode: 'vehicle.colour', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'vehicle', field: 'vehicle_colour', fieldSource: 'derived', checkType: 'text_present', blocking: true, label: 'Vehicle colour is present' },
    { ruleCode: 'vehicle.year', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'vehicle', field: 'year', fieldSource: 'vehicle', checkType: 'number_gt_1900', blocking: true, label: 'Vehicle year is valid' },
    { ruleCode: 'vehicle.registration', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'vehicle', field: 'license_plate', fieldSource: 'vehicle', checkType: 'text_present', blocking: true, label: 'Vehicle registration is present' },
    // base documents ---------------------------------------------------------
    { ruleCode: 'document.driving_licence', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'document', field: 'driver_license_url', fieldSource: 'profile', checkType: 'text_present', blocking: true, label: 'Driving licence document is present' },
    { ruleCode: 'document.driving_licence.expiry', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'document', field: 'driver_license_expiry', fieldSource: 'profile', checkType: 'date_not_expired', blocking: true, label: 'Driving licence is not expired' },
    { ruleCode: 'document.insurance', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'document', field: 'insurance_url', fieldSource: 'profile', checkType: 'text_present', blocking: true, label: 'Vehicle insurance document is present' },
    { ruleCode: 'document.insurance.expiry', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'document', field: 'insurance_expiry', fieldSource: 'profile', checkType: 'date_not_expired', blocking: true, label: 'Vehicle insurance is not expired' },
    // ride-only passenger licensing ------------------------------------------
    // Read precedence: canonical typed column FIRST, then the legacy
    // verification_items compatibility key, then the legacy alias column.
    // Resolved by readPassengerLicence() below so the rule table stays scalar.
    { ruleCode: 'licence.private_hire.council', serviceScope: 'ride', countryScope: 'any', condition: 'always', kind: 'licence', field: 'licence_council_name', fieldSource: 'derived', checkType: 'text_present', blocking: true, label: 'Licensing authority is present' },
    { ruleCode: 'licence.private_hire.number', serviceScope: 'ride', countryScope: 'any', condition: 'always', kind: 'licence', field: 'licence_number', fieldSource: 'derived', checkType: 'text_present', blocking: true, label: 'Private hire licence number is present' },
    { ruleCode: 'licence.private_hire.badge', serviceScope: 'ride', countryScope: 'any', condition: 'always', kind: 'licence', field: 'licence_badge_number', fieldSource: 'derived', checkType: 'text_present', blocking: true, label: 'Taxi or private hire badge is present' },
    { ruleCode: 'licence.private_hire.expiry', serviceScope: 'ride', countryScope: 'any', condition: 'always', kind: 'licence', field: 'licence_expiry', fieldSource: 'derived', checkType: 'date_not_expired', blocking: true, label: 'Private hire licence is not expired' },
    { ruleCode: 'document.private_hire_insurance', serviceScope: 'ride', countryScope: 'any', condition: 'always', kind: 'document', field: 'private_hire_insurance_url', fieldSource: 'profile', checkType: 'text_present', blocking: true, label: 'Private hire insurance is present' },
    // van-moving -------------------------------------------------------------
    { ruleCode: 'document.goods_in_transit', serviceScope: 'van-moving', countryScope: 'any', condition: 'non_gb', kind: 'document', field: 'goods_in_transit_insurance_url', fieldSource: 'profile', checkType: 'text_present', blocking: true, label: 'Goods in transit cover is present outside GB' },
    // ADVISORY — named policy decisions --------------------------------------
    { ruleCode: 'document.courier_insurance', serviceScope: 'errand', countryScope: 'any', condition: 'motor', kind: 'document', field: 'courier_insurance_url', fieldSource: 'profile', checkType: 'text_present', blocking: false, label: 'Courier insurance is present (advisory)' },
    { ruleCode: 'document.courier_insurance', serviceScope: 'delivery', countryScope: 'any', condition: 'motor', kind: 'document', field: 'courier_insurance_url', fieldSource: 'profile', checkType: 'text_present', blocking: false, label: 'Courier insurance is present (advisory)' },
    { ruleCode: 'document.courier_insurance.expiry', serviceScope: 'delivery', countryScope: 'any', condition: 'motor', kind: 'document', field: 'courier_insurance_expiry', fieldSource: 'profile', checkType: 'date_not_expired', blocking: false, label: 'Courier insurance is not expired (advisory)' },
    { ruleCode: 'document.moving_insurance', serviceScope: 'van-moving', countryScope: 'any', condition: 'always', kind: 'document', field: 'moving_insurance_url', fieldSource: 'profile', checkType: 'text_present', blocking: false, label: 'Moving insurance is present (advisory)' },
    { ruleCode: 'document.public_liability', serviceScope: 'van-moving', countryScope: 'any', condition: 'always', kind: 'document', field: 'public_liability_insurance_url', fieldSource: 'profile', checkType: 'text_present', blocking: false, label: 'Public liability insurance is present (advisory)' },
    { ruleCode: 'document.driving_licence.status', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'document', field: 'driver_license_status', fieldSource: 'profile', checkType: 'status_ok', blocking: false, label: 'Driving licence status is not rejected or expired (advisory)' },
    { ruleCode: 'document.insurance.status', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'document', field: 'insurance_status', fieldSource: 'profile', checkType: 'status_ok', blocking: false, label: 'Insurance status is not rejected or expired (advisory)' },
    { ruleCode: 'vehicle.mot_expiry', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'vehicle', field: 'mot_expiry_date', fieldSource: 'vehicle', checkType: 'date_not_expired', blocking: false, label: 'Vehicle MOT is not expired (advisory)' },
    { ruleCode: 'vehicle.tax_status', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'vehicle', field: 'dvla_tax_status', fieldSource: 'vehicle', checkType: 'tax_ok', blocking: false, label: 'Vehicle tax status is valid (advisory)' },
    { ruleCode: 'vehicle.verified', serviceScope: 'all', countryScope: 'any', condition: 'motor', kind: 'vehicle', field: 'vehicle_verified', fieldSource: 'vehicle', checkType: 'boolean_true', blocking: false, label: 'Vehicle is verified (advisory)' }
];

/**
 * Alias normalisation, identical to `public.canonical_driver_service(text)`.
 * Returns null when the service cannot be resolved, which callers MUST treat as
 * ineligible with the blocking code `service.unresolved` (fail closed).
 */
export function canonicalDriverService(raw: unknown): CanonicalDriverService | null {
    const value = String(raw ?? '').trim().toLowerCase();
    switch (value) {
        case 'ride': return 'ride';
        case 'errand': case 'shop': case 'shopping': return 'errand';
        case 'delivery': case 'deliver': return 'delivery';
        case 'van-moving': case 'van_moving': case 'move': case 'moving': case 'van': return 'van-moving';
        default: return null;
    }
}

/** Raised by the DB for a compliance rejection. Distinct from MB001 (busy). */
export const DRIVER_NOT_ELIGIBLE_SQLSTATE = 'MB002';
export const DRIVER_NOT_ELIGIBLE_CODE = 'DRIVER_NOT_ELIGIBLE';
/** Raised by the DB when the driver already owns an occupying job (N12). */
export const DRIVER_BUSY_SQLSTATE = 'MB001';
export const DRIVER_BUSY_CODE = 'DRIVER_BUSY';
/** Blocking code used whenever the service cannot be resolved. Fail closed. */
export const SERVICE_UNRESOLVED_CODE = 'service.unresolved';

/**
 * Batch 2C Phase B — the ONE acquisition error contract.
 *
 * `MB001` (busy / N12) and `MB002` (compliance) are reserved and distinct. Both
 * are recognised here, in one place, so every acquisition path maps them
 * identically and neither can be mistaken for the other or for a generic
 * failure. `MB002` carries requirement CODES only — never documents, admin notes
 * or reviewer identity.
 *
 * Returns null when the error is not an acquisition contract error.
 */
export interface DriverAcquisitionFailure {
    status: number;
    code: string;
    error: string;
    /** Requirement codes reported by the database. Codes only, never prose. */
    blocking?: string[];
}

export function mapDriverAcquisitionError(error: unknown): DriverAcquisitionFailure | null {
    const candidate = error as { code?: string; message?: string; details?: string } | null;
    if (!candidate) return null;

    if (candidate.code === DRIVER_NOT_ELIGIBLE_SQLSTATE) {
        const reported = String(candidate.details ?? '')
            .split(',')
            .map(value => value.trim())
            .filter(value => /^[a-z][a-z0-9_.]*$/.test(value));
        return {
            status: 409,
            code: DRIVER_NOT_ELIGIBLE_CODE,
            error: 'You are not eligible to take this service. Complete the listed requirements and try again.',
            blocking: reported
        };
    }

    if (candidate.code === DRIVER_BUSY_SQLSTATE) {
        return { status: 409, code: DRIVER_BUSY_CODE, error: 'You already have an active job.' };
    }

    return null;
}

export interface DriverEligibilityInput {
    profile: Record<string, unknown> | null | undefined;
    vehicle?: Record<string, unknown> | null;
    service: unknown;
    now?: Date;
}

export interface DriverServiceEligibility {
    service: CanonicalDriverService | null;
    eligible: boolean;
    blockingCodes: string[];
    advisoryCodes: string[];
}

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const present = (value: unknown): boolean => text(value).trim().length > 0;
/** First non-empty candidate, trimmed, or '' — mirrors a SQL COALESCE chain. */
const pickFirst = (...candidates: unknown[]): string => {
    for (const candidate of candidates) if (present(candidate)) return text(candidate).trim();
    return '';
};

/** Tolerant ISO DATE parse, identical in behaviour to `public.safe_iso_date`. */
export function safeIsoDate(value: unknown): string | null {
    const raw = text(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const [year, month, day] = raw.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return raw;
}

/** ISO date of `now` (UTC), matching `p_at::date` semantics. */
export function isoDateOf(now: Date): string {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Generic rule evaluation, mirroring `public.driver_compliance_rule_passes`.
 * DATE semantics are frozen here: a document is valid THROUGH its expiry date,
 * so only `expiry < today` is expired. Absent or malformed dates fail closed.
 */
export function complianceRulePasses(checkType: DriverComplianceCheckType, value: unknown, now: Date): boolean {
    switch (checkType) {
        case 'boolean_true':
            return text(value).toLowerCase() === 'true';
        case 'text_present':
            return present(value);
        case 'number_gt_1900':
            return /^\d{4}$/.test(text(value).trim()) && Number(text(value)) > 1900;
        case 'date_not_expired': {
            const iso = safeIsoDate(value);
            return iso !== null && iso >= isoDateOf(now);
        }
        case 'status_ok':
            return !['rejected', 'expired'].includes(text(value).trim().toLowerCase());
        case 'tax_ok':
            return !['untaxed', 'sorn', 'not_taxed'].includes(text(value).trim().toLowerCase());
        default:
            return false;
    }
}

/**
 * Passenger licence resolved with the frozen read precedence:
 *   1. the canonical typed profiles column (authoritative),
 *   2. the legacy `verification_items` compatibility key,
 *   3. the legacy alias column.
 * Compatibility storage is read ONLY when the canonical value is absent, so a
 * stale JSON mirror can never override the canonical column.
 */
export interface ResolvedPassengerLicence {
    councilName: string | null;
    number: string | null;
    badgeNumber: string | null;
    expiry: string | null;
}

export function readPassengerLicence(profile: Record<string, unknown> | null | undefined): ResolvedPassengerLicence {
    const row = profile ?? {};
    const rawItems = row['verification_items'];
    const items: Record<string, unknown> =
        rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)
            ? (rawItems as Record<string, unknown>)
            : {};
    const pick = (...candidates: unknown[]): string | null => {
        for (const candidate of candidates) {
            if (present(candidate)) return text(candidate).trim();
        }
        return null;
    };
    return {
        councilName: pick(row['council_name'], items['council_name'], row['council_license_authority']),
        number: pick(row['council_license_number'], items['council_license_number']),
        badgeNumber: pick(row['taxi_badge_number'], items['taxi_badge_number']),
        expiry: pick(row['taxi_license_expiry'], items['taxi_license_expiry'], row['council_license_expiry'])
    };
}

/**
 * The canonical passenger-licence columns a future backfill may fill, in the
 * order `public.profiles` declares them. NOTHING is written here.
 */
export const PASSENGER_LICENCE_BACKFILL_TARGETS = [
    'council_name',
    'council_license_number',
    'taxi_badge_number',
    'taxi_license_expiry'
] as const;
export type PassengerLicenceColumn = (typeof PASSENGER_LICENCE_BACKFILL_TARGETS)[number];

export interface PassengerLicenceBackfillPlan {
    /** Canonical columns that are NULL/blank and have a usable compatibility value. */
    updates: Partial<Record<PassengerLicenceColumn, string>>;
    /** Canonical columns that already hold a value: never overwritten. */
    preserved: PassengerLicenceColumn[];
    /** Compatibility keys that supplied a proposed value (for operator reporting). */
    sources: string[];
}

/** The compatibility key that feeds each canonical column. Same mapping as SQL. */
const BACKFILL_SOURCES: ReadonlyArray<{
    column: PassengerLicenceColumn;
    key: string;
    kind: 'text' | 'date';
}> = [
    { column: 'council_name', key: 'council_name', kind: 'text' },
    { column: 'council_license_number', key: 'council_license_number', kind: 'text' },
    { column: 'taxi_badge_number', key: 'taxi_badge_number', kind: 'text' },
    { column: 'taxi_license_expiry', key: 'taxi_license_expiry', kind: 'date' }
];

/**
 * PHASE B READINESS ONLY — a PURE description of the passenger-licence backfill.
 *
 * This function computes what a future `UPDATE public.profiles ...` WOULD change.
 * It performs no I/O, is called by nothing, and is not imported by any route,
 * service or client. Phase A deliberately executes no backfill: filling
 * `council_license_number` from `verification_items` would flip the LIVE online
 * gate (driver-requirement.service.ts) from fail to pass for affected drivers,
 * which is a behaviour change Phase A must not make. The actual statement lives
 * in Phase B — controlled data reconciliation.
 *
 * Guarantees encoded here and asserted by
 * src/testing/batch2c-phase-a-eligibility.spec.ts:
 *   * a canonical value that is present is NEVER proposed for change;
 *   * only NULL/blank canonical targets are ever proposed;
 *   * the compatibility storage is only READ — the plan can never express a
 *     change to `verification_items` or to any JSON;
 *   * a malformed/impossible compatibility date yields no proposal at all
 *     (`safeIsoDate` returns null), so a bad legacy value cannot propagate;
 *   * only OBJECT-shaped `verification_items` are considered; array and string
 *     shapes are ignored rather than guessed at.
 */
export function planPassengerLicenceBackfill(
    profile: Record<string, unknown> | null | undefined
): PassengerLicenceBackfillPlan {
    const row = profile ?? {};
    const rawItems = row['verification_items'];
    const items: Record<string, unknown> =
        rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)
            ? (rawItems as Record<string, unknown>)
            : {};

    const updates: Partial<Record<PassengerLicenceColumn, string>> = {};
    const preserved: PassengerLicenceColumn[] = [];
    const sources: string[] = [];

    for (const source of BACKFILL_SOURCES) {
        // Canonical-first: an existing canonical value always wins and is never
        // part of the proposal.
        if (present(row[source.column])) {
            preserved.push(source.column);
            continue;
        }
        const raw = items[source.key];
        const value = source.kind === 'date'
            ? safeIsoDate(raw)
            : (present(raw) ? text(raw).trim() : null);
        if (value === null) continue;
        updates[source.column] = value;
        sources.push(source.key);
    }

    return { updates, preserved, sources };
}

function derivedFlags(profile: Record<string, unknown>, vehicle: Record<string, unknown> | null, now: Date): Record<string, string> {
    const vehicleText = `${text(vehicle?.['capacity'])} ${text(vehicle?.['type'])}`.toLowerCase();
    const vehiclePresent = vehicle !== null && vehicle !== undefined;
    const dob = safeIsoDate(profile['date_of_birth']);
    const adultCutoff = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
    const licence = readPassengerLicence(profile);
    return {
        account_active: String(!['paused', 'suspended', 'blocked'].includes(text(profile['account_status'] || 'active').toLowerCase())),
        is_approved: String(profile['is_verified'] === true || text(profile['verification_status']).toLowerCase() === 'approved'),
        onboarding_complete: String(profile['onboarding_completed'] === true || text(profile['onboarding_completed']).toLowerCase() === 'true'),
        agreement_accepted: String(present(profile['accepted_driver_agreement_at'])),
        address_present: String(present(profile['current_address']) || present(profile['address_line1']) || present(profile['home_address'])),
        driver_is_adult: String(dob !== null && dob <= isoDateOf(adultCutoff)),
        right_to_work_present: String(present(profile['right_to_work_url']) || present(profile['right_to_work_share_code'])),
        vehicle_present: String(vehiclePresent),
        driver_is_motor: String(vehiclePresent && !/bicycle|bike|cycle/.test(vehicleText)),
        // Production stores the colour in `color`; the repository's mapped
        // driver-vehicle model presents it as `colour`. Accept both, `color` first.
        vehicle_colour: pickFirst(vehicle?.['color'], vehicle?.['colour']),
        licence_council_name: licence.councilName ?? '',
        licence_number: licence.number ?? '',
        licence_badge_number: licence.badgeNumber ?? '',
        licence_expiry: licence.expiry ?? ''
    };
}

/**
 * The canonical verdict. Same rule table, same scoping, same expiry semantics as
 * the SQL function; proven equivalent by the parity tests.
 */
export function evaluateDriverServiceEligibility(input: DriverEligibilityInput): DriverServiceEligibility {
    const now = input.now ?? new Date();
    const service = canonicalDriverService(input.service);

    if (!input.profile) {
        return { service, eligible: false, blockingCodes: [SERVICE_UNRESOLVED_CODE], advisoryCodes: [] };
    }
    if (!service) {
        return { service: null, eligible: false, blockingCodes: [SERVICE_UNRESOLVED_CODE], advisoryCodes: [] };
    }

    const profile = input.profile;
    const vehicle = input.vehicle ?? null;
    const derived = derivedFlags(profile, vehicle, now);
    const country = text(profile['country_code']).trim().toUpperCase();

    const blockingCodes = new Set<string>();
    const advisoryCodes = new Set<string>();

    for (const rule of DRIVER_ELIGIBILITY_RULES) {
        if (rule.serviceScope !== 'all' && rule.serviceScope !== service) continue;
        if (rule.countryScope !== 'any' && rule.countryScope !== country) continue;
        if (rule.condition === 'motor' && derived['driver_is_motor'] !== 'true') continue;
        if (rule.condition === 'non_gb' && country === 'GB') continue;

        const value = rule.fieldSource === 'vehicle'
            ? vehicle?.[rule.field]
            : rule.fieldSource === 'derived'
                ? derived[rule.field]
                : profile[rule.field];

        if (complianceRulePasses(rule.checkType, value, now)) continue;
        (rule.blocking ? blockingCodes : advisoryCodes).add(rule.ruleCode);
    }

    return {
        service,
        eligible: blockingCodes.size === 0,
        blockingCodes: Array.from(blockingCodes).sort(),
        advisoryCodes: Array.from(advisoryCodes).sort()
    };
}
