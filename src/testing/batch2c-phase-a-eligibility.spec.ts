import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
    CANONICAL_DRIVER_SERVICES,
    DRIVER_ELIGIBILITY_RULES,
    DRIVER_NOT_ELIGIBLE_SQLSTATE,
    PASSENGER_LICENCE_BACKFILL_TARGETS,
    SERVICE_UNRESOLVED_CODE,
    canonicalDriverService,
    complianceRulePasses,
    evaluateDriverServiceEligibility,
    planPassengerLicenceBackfill,
    readPassengerLicence,
    safeIsoDate,
    type DriverEligibilityRule
} from '../../server/services/driver-eligibility.service';

/**
 * Batch 2C / Phase A — N13 + N14 compliance foundations.
 *
 * STATIC + PURE-FUNCTION TESTS ONLY. There is no live PostgreSQL harness in this
 * workspace, so nothing here executes SQL against a server. What it proves:
 *
 *   1. SQL and TypeScript carry the SAME rule table (parity), so the two
 *      implementations cannot drift silently;
 *   2. the frozen semantics (canonical services, fail-closed unresolved
 *      service, DATE expiry boundary, ride-only passenger licensing, canonical
 *      passenger-licence read precedence) are what the report claims;
 *   3. Phase A really is INERT: it contains no application-data UPDATE, INSERT
 *      or DELETE of any kind, enables no RLS, changes no privilege, and creates
 *      the acquisition trigger DISABLED;
 *   4. the acquisition/reassignment/release semantics are exactly as specified;
 *   5. the advisory policy rows cannot block, so Phase A introduces no new
 *      blocking requirement;
 *   6. the passenger-licence backfill exists only as READINESS: the Phase B
 *      statement is retained as documentation and a pure planner describes what
 *      it would change, but Phase A executes no backfill.
 *
 * AUTHORITY: the database is authoritative for acquisition. This module is the
 * server-side mirror and is proven equivalent here — never the other way round.
 */

const MIGRATION = 'supabase/migrations/20260925000000_driver_compliance_eligibility_phase_a.sql';
const PREFLIGHT = 'scripts/db/preflight_20260925000000_driver_compliance_eligibility_phase_a.sql';
const POSTFLIGHT = 'scripts/db/postflight_20260925000000_driver_compliance_eligibility_phase_a.sql';
const N12_MIGRATION = 'supabase/migrations/20260924000000_driver_single_active_job.sql';

/** Read a file as UTF-8 and normalise CRLF -> LF. The structural fixtures and
 *  the postflight SHA-256 are authored against LF content; a Windows checkout
 *  with core.autocrlf=true materialises CRLF, which would otherwise change the
 *  hash and break the line-anchored regexes below. Content drift is still caught:
 *  normalisation only removes \r before \n, never any assertion-relevant text. */
const readNormalized = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const migrationRaw = readNormalized(MIGRATION);
const migration = migrationRaw.replace(/\s+/g, '').toLowerCase();

/** Comment lines removed, so assertions target executable text. */
const sqlCode = (text: string): string =>
    text.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

const migrationCode = sqlCode(migrationRaw);
const preflightCode = sqlCode(readNormalized(PREFLIGHT));
const postflightCode = sqlCode(readNormalized(POSTFLIGHT));

const flat = (text: string): string => text.replace(/\s+/g, '').toLowerCase();

const sorted = (values: Iterable<string>): string[] => Array.from(values).sort();

// ---------------------------------------------------------------------------
// SQL rule-table parsing
// ---------------------------------------------------------------------------

/** The `driver_compliance_rules()` body only. */
const rulesBody = (() => {
    const marker = 'CREATE OR REPLACE FUNCTION public.driver_compliance_rules()';
    const start = migrationCode.indexOf(marker);
    expect(start, 'driver_compliance_rules() not found').toBeGreaterThan(-1);
    const end = migrationCode.indexOf('$$;', start + marker.length);
    expect(end, 'driver_compliance_rules() terminator not found').toBeGreaterThan(start);
    return migrationCode.slice(start, end);
})();

const RULE_ROW = /\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(TRUE|FALSE)\s*,\s*'([^']*)'\s*\)/gi;

/** Parse the SQL rule table into the TypeScript rule shape. */
const parseSqlRules = (body: string): DriverEligibilityRule[] =>
    Array.from(body.matchAll(RULE_ROW)).map(m => ({
        ruleCode: m[1],
        serviceScope: m[2] as DriverEligibilityRule['serviceScope'],
        countryScope: m[3],
        condition: m[4] as DriverEligibilityRule['condition'],
        kind: m[5],
        field: m[6],
        fieldSource: m[7] as DriverEligibilityRule['fieldSource'],
        checkType: m[8] as DriverEligibilityRule['checkType'],
        blocking: m[9].toUpperCase() === 'TRUE',
        label: m[10]
    }));

const sqlRules = parseSqlRules(rulesBody);

const ruleKey = (r: DriverEligibilityRule): string =>
    [r.ruleCode, r.serviceScope, r.countryScope, r.condition, r.kind, r.field, r.fieldSource, r.checkType, String(r.blocking), r.label].join('|');

/** Full row-by-row comparison. Returns the differing keys. */
const parityDiff = (sql: DriverEligibilityRule[], ts: readonly DriverEligibilityRule[]): string[] => {
    const a = sql.map(ruleKey).sort();
    const b = ts.map(ruleKey).sort();
    const onlySql = a.filter(k => !b.includes(k));
    const onlyTs = b.filter(k => !a.includes(k));
    return [...onlySql.map(k => `sql-only:${k}`), ...onlyTs.map(k => `ts-only:${k}`)];
};

// ---------------------------------------------------------------------------
// Phase A inertness probes
// ---------------------------------------------------------------------------

/** Does the migration ENABLE the acquisition trigger (it must not)? */
const enablesAcquisitionTrigger = (text: string): boolean =>
    /ALTER\s+TABLE\s+(public\.)?jobs\s+ENABLE\s+TRIGGER\s+trg_enforce_job_acquisition_eligibility/i.test(sqlCode(text));

/** Does the migration ENABLE RLS on profiles (it must not)? */
const enablesProfilesRls = (text: string): boolean =>
    /ALTER\s+TABLE\s+(public\.)?profiles\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sqlCode(text));

/** Does the migration revoke or grant table/column privileges (it must not)? */
const changesTablePrivileges = (text: string): boolean =>
    /\b(GRANT|REVOKE)\b[^;]*\bON\s+(TABLE\s+)?(public\.)?(profiles|jobs|vehicles)\b/i.test(sqlCode(text));

/** Does the migration create or drop any RLS policy (it must not)? */
const changesPolicies = (text: string): boolean =>
    /\b(CREATE|DROP|ALTER)\s+POLICY\b/i.test(sqlCode(text));

/** Is the trigger left disabled? */
const disablesAcquisitionTrigger = (text: string): boolean =>
    /ALTER\s+TABLE\s+(public\.)?jobs\s+DISABLE\s+TRIGGER\s+trg_enforce_job_acquisition_eligibility/i.test(sqlCode(text));

/**
 * Every application-data mutation in EXECUTABLE SQL. Comment lines are removed
 * first, so the Phase B backfill that Phase A retains as documentation does NOT
 * count — only real statements do. Phase A must return an empty list.
 *
 * UPDATE requires a following SET, so `BEFORE UPDATE OF driver_id` (trigger
 * definition) and `TG_OP = 'UPDATE'` (comparison) are correctly ignored.
 */
const APPLICATION_DML_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
    ['UPDATE', /\bUPDATE\s+(?:ONLY\s+)?[a-z_][a-z0-9_.]*(?:\s+[a-z_][a-z0-9_]*)?\s+SET\b/gi],
    ['INSERT', /\bINSERT\s+INTO\s+[a-z_][a-z0-9_.]*/gi],
    ['DELETE', /\bDELETE\s+FROM\s+[a-z_][a-z0-9_.]*/gi],
    ['TRUNCATE', /\bTRUNCATE\b/gi],
    ['MERGE', /\bMERGE\s+INTO\s+[a-z_][a-z0-9_.]*/gi],
    ['COPY', /\bCOPY\s+[a-z_][a-z0-9_.]*/gi],
    ['jsonb_set', /\bjsonb_set\s*\(/gi]
];

const applicationDataDml = (text: string): string[] => {
    const bare = sqlCode(text);
    const hits: string[] = [];
    for (const [label, pattern] of APPLICATION_DML_PATTERNS) {
        const matches = bare.match(pattern) ?? [];
        for (const match of matches) hits.push(`${label}: ${match.replace(/\s+/g, ' ').trim()}`);
    }
    return hits;
};

/** SHA-256 of a file's exact bytes, matching Get-FileHash / sha256sum. */
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase();

// ---------------------------------------------------------------------------
// Mutation helpers (operate on in-memory copies; never touch the working tree)
// ---------------------------------------------------------------------------

const withoutRuleCode = (text: string, code: string): string =>
    text.split('\n').filter(line => !line.includes(`'${code}'`)).join('\n');

const withRuleScope = (text: string, code: string, scope: string): string =>
    text.replace(new RegExp(`('${code.replace(/\./g, '\\.')}',\\s*')[a-z-]+(')`), `$1${scope}$2`);

const withRuleBlocking = (text: string, code: string, blocking: boolean): string =>
    text.replace(new RegExp(`('${code.replace(/\./g, '\\.')}'[\\s\\S]{0,160}?)(TRUE|FALSE)(\\s*,\\s*'[^']*'\\s*\\))`), `$1${blocking ? 'TRUE' : 'FALSE'}$3`);

const withRuleField = (text: string, code: string, field: string): string =>
    text.replace(new RegExp(`('${code.replace(/\./g, '\\.')}'[\\s\\S]{0,120}?)'[a-z_]+'(\\s*,\\s*'[a-z_]+'\\s*,)`), `$1'${field}'$2`);

// ---------------------------------------------------------------------------
// Postflight service-resolution fixture (the corrected verification gate)
//
// The postflight's resolution fixture declares an EXPLICIT expected canonical
// value per raw input. These helpers extract that fixture from the postflight,
// evaluate it against the canonical implementation, and inspect whether the
// final GO / NO-GO is actually wired to the resulting failure counter.
// ---------------------------------------------------------------------------

const FIXTURE_MARKER = 'service_fixtures(raw, expected) AS (';
/** One `('raw', 'expected')` or `('raw', NULL)` fixture row. */
const FIXTURE_ROW = /\(\s*'([^']*)'\s*,\s*(?:'([^']*)'|NULL)\s*\)/gi;

interface ServiceFixture {
    raw: string;
    expected: string | null;
}

/** Every fixture block in a script, marker through the closing `),`. */
const fixtureBlocks = (text: string): string[] => {
    const blocks: string[] = [];
    let from = 0;
    for (;;) {
        const start = text.indexOf(FIXTURE_MARKER, from);
        if (start === -1) return blocks;
        const end = text.indexOf('\n),', start);
        if (end === -1) return blocks;
        blocks.push(text.slice(start, end));
        from = end + 1;
    }
};

const parseFixtures = (block: string): ServiceFixture[] =>
    Array.from(block.matchAll(FIXTURE_ROW)).map(m => ({
        raw: m[1],
        expected: m[2] === undefined ? null : m[2]
    }));

/**
 * Evaluate a fixture against the canonical implementation: the rows a database
 * WOULD count as service-resolution failures. This is the evaluated check, not a
 * text-presence check — a wrong expectation always surfaces here.
 */
const fixtureResolutionFailures = (fixtures: readonly ServiceFixture[]): ServiceFixture[] =>
    fixtures.filter(f => canonicalDriverService(f.raw) !== f.expected);

/** Does the final GO / NO-GO both REPORT and GATE the alias failure counter? */
const gateReportsAliasFailures = (text: string): boolean =>
    text.includes(`' | service_resolution_failures=' || (SELECT n FROM service_resolution_failures)`);

const gateGatesOnAliasFailures = (text: string): boolean =>
    /WHEN\s*\(SELECT\s+n\s+FROM\s+service_resolution_failures\)\s*>\s*0\s*THEN\s*'NO-GO:/.test(text);

/** Every counter the final verdict branches on, in file order. */
const gatedCounters = (text: string): string[] => {
    const start = text.indexOf("'PHASE A POST-MIGRATION GO / NO-GO'");
    const body = start === -1 ? text : text.slice(start);
    return Array.from(body.matchAll(/WHEN\s*\(SELECT\s+n\s+FROM\s+([a-z_][a-z0-9_]*)\)/g)).map(m => m[1]);
};

/** Change a raw fixture input's expected canonical value. */
const withAliasExpectation = (text: string, raw: string, expected: string): string =>
    text.replace(new RegExp(`(\\('${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*)'[a-z-]+'`, 'g'), `$1'${expected}'`);

// ===========================================================================
describe('Phase A canonical service normalisation (SQL + TS parity)', () => {
    it('1. the frozen taxonomy is exactly the four internal types', () => {
        expect(CANONICAL_DRIVER_SERVICES).toEqual(['ride', 'errand', 'delivery', 'van-moving']);
    });

    it('1b. aliases normalise to the frozen types, matching the SQL function', () => {
        // Aliases are taken from the repository's own existing semantics:
        // driver-requirement.service.ts:83 normalises shop/shopping -> errand,
        // deliver -> delivery, move/moving/van/van_moving -> van-moving.
        expect(canonicalDriverService('shop')).toBe('errand');
        expect(canonicalDriverService('shopping')).toBe('errand');
        expect(canonicalDriverService('errand')).toBe('errand');
        expect(canonicalDriverService('deliver')).toBe('delivery');
        expect(canonicalDriverService('delivery')).toBe('delivery');
        expect(canonicalDriverService('move')).toBe('van-moving');
        expect(canonicalDriverService('moving')).toBe('van-moving');
        expect(canonicalDriverService('van')).toBe('van-moving');
        expect(canonicalDriverService('van_moving')).toBe('van-moving');
        expect(canonicalDriverService('van-moving')).toBe('van-moving');
        expect(canonicalDriverService('ride')).toBe('ride');
        expect(canonicalDriverService('RIDE')).toBe('ride');
        expect(canonicalDriverService('Ride')).toBe('ride');
        expect(canonicalDriverService(' ride ')).toBe('ride');

        // The SQL CASE must carry the same alias set.
        const fn = migrationCode.slice(
            migrationCode.indexOf('CREATE OR REPLACE FUNCTION public.canonical_driver_service('));
        const body = fn.slice(0, fn.indexOf('$$;'));
        for (const alias of ['ride', 'errand', 'shop', 'shopping', 'delivery', 'deliver',
            'van-moving', 'van_moving', 'move', 'moving', 'van']) {
            expect(body, `SQL normaliser must handle ${alias}`).toContain(`'${alias}'`);
        }
        for (const service of CANONICAL_DRIVER_SERVICES) {
            expect(body, `SQL normaliser must emit ${service}`).toContain(`THEN '${service}'`);
        }
    });

    it('2. an unresolved service fails closed with service.unresolved', () => {
        for (const bad of [null, undefined, '', '   ', 'bogus', 'car', 'flight']) {
            expect(canonicalDriverService(bad), `raw=${String(bad)} must not resolve`).toBeNull();
            const verdict = evaluateDriverServiceEligibility({
                profile: { role: 'driver' },
                vehicle: { type: 'car', capacity: 'standard' },
                service: bad
            });
            expect(verdict.eligible).toBe(false);
            expect(verdict.blockingCodes).toContain(SERVICE_UNRESOLVED_CODE);
        }

        // A missing profile also fails closed rather than erroring.
        const noProfile = evaluateDriverServiceEligibility({ profile: null, service: 'ride' });
        expect(noProfile.eligible).toBe(false);
        expect(noProfile.blockingCodes).toContain(SERVICE_UNRESOLVED_CODE);

        // The SQL side must implement the same guard.
        expect(flat(migrationCode)).toContain("'service.unresolved'");
        expect(flat(migrationCode)).toContain('ifv_serviceisnullthen');
    });
});

// ===========================================================================
describe('Phase A SQL/TS rule-table parity', () => {
    it('3. every SQL rule row exists in TypeScript and vice versa, field by field', () => {
        expect(sqlRules.length, 'the SQL rule table parsed to zero rows').toBeGreaterThan(0);
        expect(parityDiff(sqlRules, DRIVER_ELIGIBILITY_RULES)).toEqual([]);
        expect(sqlRules.length).toBe(DRIVER_ELIGIBILITY_RULES.length);
    });

    it('3b. the blocking-code vocabulary is identical on both sides', () => {
        const sqlCodes = sorted(new Set(sqlRules.map(r => r.ruleCode)));
        const tsCodes = sorted(new Set(DRIVER_ELIGIBILITY_RULES.map(r => r.ruleCode)));
        expect(sqlCodes).toEqual(tsCodes);
        expect(sqlCodes.length).toBeGreaterThan(0);
    });

    it('4. service scoping is identical on both sides', () => {
        for (const rule of DRIVER_ELIGIBILITY_RULES) {
            const sqlMatches = sqlRules.filter(r =>
                r.ruleCode === rule.ruleCode && r.field === rule.field && r.serviceScope === rule.serviceScope);
            expect(sqlMatches.length, `${rule.ruleCode}/${rule.field} scope parity`).toBeGreaterThan(0);
        }
        const scopeSet = (rules: readonly DriverEligibilityRule[]) =>
            sorted(new Set(rules.map(r => `${r.ruleCode}|${r.serviceScope}|${r.countryScope}|${r.condition}`)));
        expect(scopeSet(sqlRules)).toEqual(scopeSet(DRIVER_ELIGIBILITY_RULES));
    });

    it('4b. expiry rule fields and check types are identical on both sides', () => {
        const expiry = (rules: readonly DriverEligibilityRule[]) =>
            sorted(rules.filter(r => r.checkType === 'date_not_expired').map(r => `${r.ruleCode}|${r.field}|${r.blocking}`));
        expect(expiry(sqlRules)).toEqual(expiry(DRIVER_ELIGIBILITY_RULES));
        expect(expiry(sqlRules).length).toBeGreaterThanOrEqual(3);
    });
});

// ===========================================================================
describe('Phase A expiry semantics (DATE: valid THROUGH the expiry date)', () => {
    const now = new Date(Date.UTC(2026, 7, 7, 0, 1, 0)); // 2026-08-07

    it('5. yesterday is expired, today is valid, tomorrow is valid', () => {
        expect(complianceRulePasses('date_not_expired', '2026-08-06', now)).toBe(false);
        expect(complianceRulePasses('date_not_expired', '2026-08-07', now)).toBe(true);
        expect(complianceRulePasses('date_not_expired', '2026-08-08', now)).toBe(true);
    });

    it('5b. an absent or malformed expiry fails closed; the parser never guesses', () => {
        for (const bad of [null, undefined, '', '   ', 'not-a-date', '2026-13-01', '2026-02-30', '07/08/2026']) {
            expect(complianceRulePasses('date_not_expired', bad, now), `value=${String(bad)}`).toBe(false);
            expect(safeIsoDate(bad)).toBeNull();
        }
    });

    it('5c. the SQL side compares against p_at::date with the same boundary', () => {
        // Frozen as expiry >= p_at::date — only a strictly earlier date is expired.
        expect(flat(migrationCode)).toContain('public.safe_iso_date(p_value)>=p_at::date');
        expect(flat(migrationCode)).toContain("'date_not_expired'");
    });

    it('5d. an expired ride licence blocks acquisition but an in-date one does not', () => {
        const base = {
            role: 'driver', country_code: 'GB', account_status: 'active', is_verified: true,
            onboarding_completed: true, accepted_driver_agreement_at: '2026-01-01',
            full_name: 'A Driver', phone: '07000', current_address: '1 Road',
            date_of_birth: '1990-01-01', right_to_work_url: 'rtw.pdf',
            driver_license_url: 'dl.pdf', driver_license_expiry: '2030-01-01',
            insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01',
            council_name: 'Oldham Council', council_license_number: 'PHV/1',
            taxi_badge_number: 'B-1', private_hire_insurance_url: 'phv.pdf'
        };
        const vehicle = { type: 'car', capacity: 'standard', make: 'Ford', model: 'Focus', color: 'Blue', year: 2020, license_plate: 'AB12' };

        expect(evaluateDriverServiceEligibility({ profile: { ...base, taxi_license_expiry: '2030-01-01' }, vehicle, service: 'ride', now }).eligible).toBe(true);
        const expired = evaluateDriverServiceEligibility({ profile: { ...base, taxi_license_expiry: '2026-08-06' }, vehicle, service: 'ride', now });
        expect(expired.eligible).toBe(false);
        expect(expired.blockingCodes).toContain('licence.private_hire.expiry');
        // The boundary day itself is still valid.
        expect(evaluateDriverServiceEligibility({ profile: { ...base, taxi_license_expiry: '2026-08-07' }, vehicle, service: 'ride', now }).eligible).toBe(true);
    });

    it('5e. SQL safe_iso_date is TOTAL: impossible calendar dates cannot abort a check', () => {
        // `2026-13-01` satisfies the frozen shape regex and is then REJECTED by
        // the DATE cast, which RAISES in PostgreSQL instead of returning NULL.
        // A bare cast would therefore abort the acquiring transaction with a
        // raw date/time error rather than producing a verdict, so the SQL body
        // must catch the cast. This is asserted structurally: there is no
        // PostgreSQL engine in this workspace, so nothing here executes it.
        const marker = 'CREATE OR REPLACE FUNCTION public.safe_iso_date(';
        const start = migrationCode.indexOf(marker);
        expect(start, 'safe_iso_date() not found in the migration').toBeGreaterThan(-1);
        const fn = migrationCode.slice(start);
        const body = fn.slice(0, fn.indexOf('$$;'));
        expect(flat(body), 'the DATE cast must be guarded by an exception handler').toContain('exceptionwhenothersthen');
        expect(flat(body)).toContain('returnnull;');
        // ...and the shape guard still precedes the cast.
        expect(flat(body)).toContain("v_raw!~'^\\d{4}-\\d{2}-\\d{2}$'");
        // TypeScript agrees for exactly those inputs.
        for (const impossible of ['2026-13-01', '2026-02-30', '2026-00-10', '0000-01-01', '9999-13-31']) {
            expect(safeIsoDate(impossible), `safeIsoDate(${impossible})`).toBeNull();
            expect(complianceRulePasses('date_not_expired', impossible, now)).toBe(false);
        }
        expect(safeIsoDate('9999-12-31')).toBe('9999-12-31');
        expect(safeIsoDate('2026-02-28')).toBe('2026-02-28');
    });
});

// ===========================================================================
describe('Phase A service-specific scoping (passenger licensing is RIDE ONLY)', () => {
    const now = new Date(Date.UTC(2026, 7, 7));
    const profile = {
        role: 'driver', country_code: 'GB', account_status: 'active', is_verified: true,
        onboarding_completed: true, accepted_driver_agreement_at: '2026-01-01',
        full_name: 'A Driver', phone: '07000', current_address: '1 Road',
        date_of_birth: '1990-01-01', right_to_work_url: 'rtw.pdf',
        driver_license_url: 'dl.pdf', driver_license_expiry: '2030-01-01',
        insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01'
    };
    const vehicle = { type: 'car', capacity: 'standard', make: 'Ford', model: 'Focus', color: 'Blue', year: 2020, license_plate: 'AB12' };

    it('6. no ride licence data means ride is blocked, with the granular codes', () => {
        const verdict = evaluateDriverServiceEligibility({ profile, vehicle, service: 'ride', now });
        expect(verdict.eligible).toBe(false);
        expect(verdict.blockingCodes).toContain('licence.private_hire.council');
        expect(verdict.blockingCodes).toContain('licence.private_hire.number');
        expect(verdict.blockingCodes).toContain('licence.private_hire.badge');
        expect(verdict.blockingCodes).toContain('licence.private_hire.expiry');
    });

    it('7. errand, delivery and van-moving never inherit passenger licensing', () => {
        // The claim under test is scoping: no non-ride service may inherit a
        // passenger/PHV licensing requirement. Whether a service has OTHER
        // requirements (e.g. van-moving goods-in-transit outside GB) is a
        // separate, deliberately preserved rule.
        for (const service of ['errand', 'delivery', 'van-moving'] as const) {
            const verdict = evaluateDriverServiceEligibility({
                profile: { ...profile, country_code: 'NG' }, vehicle, service, now
            });
            const licensing = [...verdict.blockingCodes, ...verdict.advisoryCodes]
                .filter(c => c.startsWith('licence.private_hire'));
            expect(licensing, `${service} must not inherit passenger licensing`).toEqual([]);
        }

        // errand and delivery currently carry no service-specific document rule.
        for (const service of ['errand', 'delivery'] as const) {
            expect(evaluateDriverServiceEligibility({
                profile: { ...profile, country_code: 'NG' }, vehicle, service, now
            }).eligible, `${service} must be eligible without licence data`).toBe(true);
        }

        // van-moving outside GB requires goods-in-transit cover — a preserved
        // rule, not a passenger-licensing one. With cover supplied it is eligible.
        const vanBase = { ...profile, country_code: 'NG' };
        const vanWithout = evaluateDriverServiceEligibility({ profile: vanBase, vehicle, service: 'van-moving', now });
        expect(vanWithout.blockingCodes).toContain('document.goods_in_transit');
        expect(vanWithout.blockingCodes.filter(c => c.startsWith('licence.private_hire'))).toEqual([]);
        expect(evaluateDriverServiceEligibility({
            profile: { ...vanBase, goods_in_transit_insurance_url: 'git.pdf' }, vehicle, service: 'van-moving', now
        }).eligible).toBe(true);

        // GB van-moving is exempt, matching the authoritative engine.
        expect(evaluateDriverServiceEligibility({
            profile: { ...profile, country_code: 'GB' }, vehicle, service: 'van-moving', now
        }).eligible).toBe(true);
    });

    it('7b. the rule table itself scopes passenger licensing to ride only', () => {
        const licensing = DRIVER_ELIGIBILITY_RULES.filter(r =>
            r.ruleCode.startsWith('licence.private_hire') || r.ruleCode === 'document.private_hire_insurance');
        expect(licensing.length).toBeGreaterThan(0);
        for (const rule of licensing) {
            expect(rule.serviceScope, `${rule.ruleCode} must be ride-scoped`).toBe('ride');
        }
        // ...and the SQL carries the same scoping.
        const sqlLicensing = sqlRules.filter(r =>
            r.ruleCode.startsWith('licence.private_hire') || r.ruleCode === 'document.private_hire_insurance');
        expect(sqlLicensing.length).toBe(licensing.length);
        for (const rule of sqlLicensing) expect(rule.serviceScope).toBe('ride');

        // The migration must not scope any licence rule to a non-ride service.
        for (const scope of ['errand', 'delivery', 'van-moving']) {
            expect(sqlRules.some(r => r.ruleCode.startsWith('licence.private_hire') && r.serviceScope === scope)).toBe(false);
        }
    });
});

// ===========================================================================
describe('Phase A passenger-licence storage: canonical column first, legacy fallback second', () => {
    it('8. the canonical typed column wins when present', () => {
        const resolved = readPassengerLicence({
            council_name: 'Canonical Council',
            council_license_number: 'CANON-1',
            taxi_badge_number: 'CANON-BADGE',
            taxi_license_expiry: '2030-01-01',
            verification_items: {
                council_name: 'Legacy Council',
                council_license_number: 'LEGACY-1',
                taxi_badge_number: 'LEGACY-BADGE',
                taxi_license_expiry: '2020-01-01'
            }
        });
        expect(resolved).toEqual({
            councilName: 'Canonical Council',
            number: 'CANON-1',
            badgeNumber: 'CANON-BADGE',
            expiry: '2030-01-01'
        });
    });

    it('9. the legacy compatibility bag is used only when the canonical value is absent', () => {
        const resolved = readPassengerLicence({
            council_name: '',
            verification_items: {
                council_name: 'Legacy Council',
                council_license_number: 'LEGACY-1',
                taxi_badge_number: 'LEGACY-BADGE',
                taxi_license_expiry: '2027-05-05'
            }
        });
        expect(resolved).toEqual({
            councilName: 'Legacy Council',
            number: 'LEGACY-1',
            badgeNumber: 'LEGACY-BADGE',
            expiry: '2027-05-05'
        });

        // The legacy alias column is the third tier.
        expect(readPassengerLicence({ council_license_authority: 'Alias Council' }).councilName).toBe('Alias Council');

        // Non-object compatibility shapes are ignored rather than guessed at.
        expect(readPassengerLicence({ verification_items: [{ key: 'council_name', value: 'X' }] }).councilName).toBeNull();
        expect(readPassengerLicence({ verification_items: 'council_name=X' }).councilName).toBeNull();
        expect(readPassengerLicence(null)).toEqual({ councilName: null, number: null, badgeNumber: null, expiry: null });
    });

    it('9b. the SQL side resolves the same three tiers in the same order', () => {
        const code = flat(migrationCode);
        // Canonical column -> legacy JSON key -> legacy alias column.
        expect(code).toContain("'licence_council_name',coalesce(");
        expect(code).toContain("v_profile->>'council_name'");
        expect(code).toContain("v_items->>'council_name'");
        expect(code).toContain("v_profile->>'council_license_authority'");
        // Canonical column appears before the JSON key in every COALESCE chain.
        // Anchor on the DERIVED assignment (the rule-table row also names the
        // field, but only the assignment carries the resolution order).
        const anchor = code.indexOf("'licence_council_name',coalesce(");
        expect(anchor, 'derived licence_council_name assignment not found').toBeGreaterThan(-1);
        const chain = code.slice(anchor, anchor + 400);
        const canonical = chain.indexOf("v_profile->>'council_name'");
        const legacyJson = chain.indexOf("v_items->>'council_name'");
        const legacyAlias = chain.indexOf("v_profile->>'council_license_authority'");
        expect(canonical).toBeGreaterThan(-1);
        expect(canonical).toBeLessThan(legacyJson);
        expect(legacyJson).toBeLessThan(legacyAlias);
    });

    it('10. Phase A executes NO backfill: the design is retained as comments only', () => {
        // The Phase B statement is still present in the file...
        expect(migrationRaw, 'the Phase B backfill design must be retained').toMatch(/UPDATE public\.profiles/);
        expect(migrationRaw).toMatch(/PHASE B/);
        // ...but only inside comments, so the comment-stripped SQL executes none
        // of it, and the migration mutates no application data at all.
        expect(sqlCode(migrationRaw), 'the backfill must not be executable').not.toMatch(/\bUPDATE\s+public\.profiles\b/i);
        expect(applicationDataDml(migrationRaw), 'Phase A must mutate no application data').toEqual([]);
        // Present in raw text AND absent from executable text: the pair is what
        // proves the retention is documentation and nothing more.
        expect(sqlCode(migrationRaw).length).toBeLessThan(migrationRaw.length);
    });
});

// ===========================================================================
describe('Phase A passenger-licence BACKFILL READINESS (designed, never executed)', () => {
    const designBlock = (() => {
        const start = migrationRaw.indexOf('-- PHASE B — NOT EXECUTED BY PHASE A');
        expect(start, 'the Phase B design marker is missing').toBeGreaterThan(-1);
        const end = migrationRaw.indexOf('-- END PHASE B DESIGN.', start);
        expect(end, 'the Phase B design terminator is missing').toBeGreaterThan(start);
        return migrationRaw.slice(start, end);
    })();

    it('10a. the retained design still carries the frozen backfill properties', () => {
        expect(designBlock).toContain('COALESCE(');
        expect(designBlock).toContain('IS NULL');
        expect(designBlock).toContain("'driver'");
        expect(flat(designBlock), 'the design must only read object-shaped compatibility storage')
            .toContain("jsonb_typeof(to_jsonb(p)->'verification_items')='object'");
        // Non-destructive: the compatibility bag is never assigned or reshaped.
        expect(designBlock).not.toMatch(/verification_items\s*=/i);
        expect(designBlock).not.toMatch(/jsonb_set/i);
        // An existing canonical value is never overwritten by the JSON value.
        expect(designBlock).not.toMatch(/SET\s+council_name\s*=\s*s\.items/i);
        // Every non-empty line of the design block is a comment, which is what
        // makes it retained-but-inert.
        const lines = designBlock.split('\n').filter(line => line.trim().length > 0);
        expect(lines.length).toBeGreaterThan(10);
        expect(lines.every(line => line.trimStart().startsWith('--'))).toBe(true);
    });

    it('10b. a populated canonical value is NEVER part of the proposal', () => {
        const plan = planPassengerLicenceBackfill({
            council_name: 'Canonical Council',
            council_license_number: 'CANON-1',
            taxi_badge_number: 'CANON-BADGE',
            taxi_license_expiry: '2030-01-01',
            verification_items: {
                council_name: 'Stale Council',
                council_license_number: 'STALE-1',
                taxi_badge_number: 'STALE-BADGE',
                taxi_license_expiry: '2020-01-01'
            }
        });
        expect(plan.updates).toEqual({});
        expect(sorted(plan.preserved)).toEqual(sorted(PASSENGER_LICENCE_BACKFILL_TARGETS));
        expect(plan.sources).toEqual([]);
    });

    it('10c. only NULL/empty canonical targets are proposed', () => {
        const plan = planPassengerLicenceBackfill({
            council_name: 'Canonical Council',
            council_license_number: '   ',
            verification_items: {
                council_name: 'Stale Council',
                council_license_number: 'LEGACY-1',
                taxi_badge_number: 'LEGACY-BADGE',
                taxi_license_expiry: '2027-05-05'
            }
        });
        expect(plan.updates).toEqual({
            council_license_number: 'LEGACY-1',
            taxi_badge_number: 'LEGACY-BADGE',
            taxi_license_expiry: '2027-05-05'
        });
        expect(plan.preserved).toEqual(['council_name']);
        expect(plan.sources).toEqual(['council_license_number', 'taxi_badge_number', 'taxi_license_expiry']);
    });

    it('10d. malformed compatibility dates are never proposed', () => {
        for (const bad of ['not-a-date', '2026-13-01', '2026-02-30', '', '   ', '07/08/2026', 20270505]) {
            const plan = planPassengerLicenceBackfill({ verification_items: { taxi_license_expiry: bad } });
            expect(plan.updates, `compatibility expiry ${JSON.stringify(bad)} must not be proposed`)
                .not.toHaveProperty('taxi_license_expiry');
        }
        expect(planPassengerLicenceBackfill({ verification_items: { taxi_license_expiry: '2027-05-05' } }).updates)
            .toEqual({ taxi_license_expiry: '2027-05-05' });
    });

    it('10e. the plan can never express a change to compatibility storage', () => {
        const plan = planPassengerLicenceBackfill({
            verification_items: { council_name: 'Legacy Council', council_license_number: 'LEGACY-1' }
        });
        const keys = Object.keys(plan.updates);
        expect(keys).not.toContain('verification_items');
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) expect(PASSENGER_LICENCE_BACKFILL_TARGETS).toContain(key);
        // The planner is pure: its input is never mutated.
        const profile = { verification_items: { council_name: 'Legacy Council' } };
        const before = JSON.stringify(profile);
        planPassengerLicenceBackfill(profile);
        expect(JSON.stringify(profile)).toBe(before);
    });

    it('10f. only OBJECT-shaped compatibility storage is considered', () => {
        expect(planPassengerLicenceBackfill({ verification_items: [{ key: 'council_name', value: 'X' }] }).updates).toEqual({});
        expect(planPassengerLicenceBackfill({ verification_items: 'council_name=X' }).updates).toEqual({});
        expect(planPassengerLicenceBackfill({ verification_items: null }).updates).toEqual({});
        expect(planPassengerLicenceBackfill(null).updates).toEqual({});
        expect(planPassengerLicenceBackfill({ verification_items: { council_name: 'X' } }).updates)
            .toEqual({ council_name: 'X' });
    });

    it('10g. the read precedence agrees with the planner: canonical first, compatibility second', () => {
        const profile = {
            council_name: 'Canonical Council',
            council_license_number: '',
            verification_items: { council_license_number: 'LEGACY-1' }
        };
        // Reads already fall through to the compatibility key when the canonical
        // value is blank...
        expect(readPassengerLicence(profile).number).toBe('LEGACY-1');
        // ...and the Phase B plan proposes promoting exactly that value, never the
        // populated canonical council name.
        expect(planPassengerLicenceBackfill(profile).updates).toEqual({ council_license_number: 'LEGACY-1' });
    });
});

// ===========================================================================
describe('Phase A acquisition trigger: created, DISABLED, and correctly scoped', () => {
    it('11. the trigger is created and the migration leaves it DISABLED', () => {
        expect(migrationCode).toContain('CREATE TRIGGER trg_enforce_job_acquisition_eligibility');
        expect(migrationCode).toContain('BEFORE UPDATE OF driver_id ON public.jobs');
        expect(migrationCode).toContain('FOR EACH ROW');
        expect(disablesAcquisitionTrigger(migrationRaw), 'the migration must DISABLE the trigger').toBe(true);
        expect(enablesAcquisitionTrigger(migrationRaw), 'Phase A must never ENABLE the trigger').toBe(false);
    });

    it('12. same-driver re-assertion is allowed', () => {
        const body = flat(migrationCode.slice(migrationCode.indexOf('CREATE OR REPLACE FUNCTION public.enforce_job_acquisition_eligibility()')));
        expect(body).toContain("iftg_op='update'andnew.driver_id=old.driver_idthenreturnnew;");
    });

    it('13. release to NULL is allowed', () => {
        const fn = flat(migrationCode.slice(migrationCode.indexOf('CREATE OR REPLACE FUNCTION public.enforce_job_acquisition_eligibility()')));
        expect(fn).toContain('ifnew.driver_idisnullthenreturnnew;');
    });

    it('14. A -> B reassignment is treated as an acquisition, not as harmless re-assertion', () => {
        // The re-assertion guard must be EQUALITY (same driver), never
        // "both are non-null" — which would silently wave A -> B through.
        const fn = flat(migrationCode.slice(migrationCode.indexOf('CREATE OR REPLACE FUNCTION public.enforce_job_acquisition_eligibility()')));
        expect(fn).toContain('new.driver_id=old.driver_id');
        expect(fn).not.toContain('new.driver_idisnotnullandold.driver_idisnotnullthenreturnnew');

        // Everything that is not a release or a same-driver re-assertion falls
        // through to the eligibility evaluation.
        const afterGuards = fn.slice(fn.indexOf('ifnew.driver_idisnullthenreturnnew;'));
        const eligibilityIdx = afterGuards.indexOf('v_service:=public.job_canonical_service(new.id);');
        const reassertIdx = afterGuards.indexOf("iftg_op='update'andnew.driver_id=old.driver_idthenreturnnew;");
        expect(reassertIdx).toBeGreaterThan(-1);
        expect(eligibilityIdx).toBeGreaterThan(reassertIdx);

        // Semantics proven on the TS mirror: reassigning to an ineligible driver
        // is rejected, and the incoming driver is the one evaluated.
        const now = new Date(Date.UTC(2026, 7, 7));
        const ineligible = evaluateDriverServiceEligibility({
            profile: { role: 'driver', account_status: 'suspended' },
            vehicle: null,
            service: 'ride',
            now
        });
        expect(ineligible.eligible).toBe(false);
        expect(ineligible.blockingCodes).toContain('account.not_active');
    });

    it('14b. the trigger function is DEFINER, pinned, and free of dynamic SQL', () => {
        const fn = migrationCode.slice(migrationCode.indexOf('CREATE OR REPLACE FUNCTION public.enforce_job_acquisition_eligibility()'));
        const head = flat(fn.slice(0, fn.indexOf('AS $$')));
        expect(head).toContain('securitydefiner');
        expect(head).toContain('setsearch_path=public,pg_temp');
        expect(flat(fn)).not.toContain('executeformat');
        expect(flat(fn)).not.toContain('quote_ident');
    });
});

// ===========================================================================
describe('Phase A error contract', () => {
    it('15. MB002 carries requirement CODES ONLY and stays distinct from MB001', () => {
        expect(DRIVER_NOT_ELIGIBLE_SQLSTATE).toBe('MB002');
        const fn = migrationCode.slice(migrationCode.indexOf('CREATE OR REPLACE FUNCTION public.enforce_job_acquisition_eligibility()'));
        expect(fn).toContain("ERRCODE    = 'MB002'");
        expect(fn).toContain('CONSTRAINT = ');
        // DETAIL is a comma-joined list of codes and nothing else.
        expect(flat(fn)).toContain('detail=array_to_string(');
        expect(flat(fn)).toContain('coalesce(v_result.blocking_codes,array[]::text[])');
        // No prose, URLs, notes or reviewer identity travel through the error.
        expect(flat(fn)).not.toContain('driver_license_url');
        expect(flat(fn)).not.toContain('verification_notes');
        expect(flat(fn)).not.toContain('driver_review_notes');
        expect(flat(fn)).not.toContain("'http");
        // MB001 (N12 busy) is not touched anywhere in this migration.
        expect(flat(migrationCode)).not.toContain("'mb001'");
    });
});

// ===========================================================================
describe('Phase A inertness: no enforcement is activated', () => {
    it('16. the migration does not enable RLS, does not change privileges and does not touch policies', () => {
        expect(enablesProfilesRls(migrationRaw), 'profiles RLS must NOT be enabled in Phase A').toBe(false);
        expect(changesTablePrivileges(migrationRaw), 'no table/column GRANT or REVOKE in Phase A').toBe(false);
        expect(changesPolicies(migrationRaw), 'no policy created/dropped/altered in Phase A').toBe(false);
        // Only FUNCTION-level revokes are permitted, and they must be explicit
        // per role (the Batch 1 / 2A lesson).
        expect(migrationCode).toContain('REVOKE ALL ON FUNCTION public.driver_service_eligibility(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;');
        expect(migrationCode).toContain('REVOKE EXECUTE ON FUNCTION public.driver_service_eligibility(UUID, TEXT, TIMESTAMPTZ) FROM anon, authenticated, service_role;');
        expect(migrationCode).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.driver_/i);
    });

    it('16b. every Phase A function is INTERNAL (EXECUTE revoked from every role)', () => {
        for (const sig of [
            'canonical_driver_service(TEXT)',
            'job_canonical_service(UUID)',
            'safe_iso_date(TEXT)',
            'driver_compliance_rules()',
            'driver_compliance_rule_passes(TEXT, TEXT, TIMESTAMPTZ)',
            'driver_service_eligibility(UUID, TEXT, TIMESTAMPTZ)',
            'enforce_job_acquisition_eligibility()'
        ]) {
            expect(migrationCode, `REVOKE ALL for ${sig}`).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
            expect(migrationCode, `role revoke for ${sig}`).toContain(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon, authenticated, service_role;`);
        }
    });

    it('16c. the advisory policy rows cannot block, so Phase A adds no new blocking requirement', () => {
        const advisoryCodes = [
            'document.courier_insurance', 'document.courier_insurance.expiry', 'document.moving_insurance',
            'document.public_liability', 'document.driving_licence.status', 'document.insurance.status',
            'vehicle.mot_expiry', 'vehicle.tax_status', 'vehicle.verified'
        ];
        for (const code of advisoryCodes) {
            const rows = DRIVER_ELIGIBILITY_RULES.filter(r => r.ruleCode === code);
            expect(rows.length, `${code} must be present as an advisory row`).toBeGreaterThan(0);
            for (const row of rows) expect(row.blocking, `${code} must NOT block in Phase A`).toBe(false);
        }
        // ...and the SQL agrees.
        for (const code of advisoryCodes) {
            for (const row of sqlRules.filter(r => r.ruleCode === code)) expect(row.blocking).toBe(false);
        }
        // The blocking set excludes every advisory code.
        const blockingCodes = new Set(DRIVER_ELIGIBILITY_RULES.filter(r => r.blocking).map(r => r.ruleCode));
        for (const code of advisoryCodes) expect(blockingCodes.has(code)).toBe(false);
    });

    it('16d. the migration contains NO application-data mutation of any kind', () => {
        // Phase A's objective is "changes no live enforcement behaviour". A
        // backfill that fills council_license_number would flip the LIVE online
        // gate (driver-requirement.service.ts) from fail to pass even though it
        // only loosens, so NO application-table DML is permitted here.
        expect(applicationDataDml(migrationRaw), 'Phase A must contain no application-data DML').toEqual([]);
        expect(migrationCode).not.toMatch(/\bverification_items\s*=/i);
        expect(migrationCode).not.toMatch(/\bjsonb_set\b/i);
        // The prohibition is specific to data: function DDL and function-level
        // REVOKE are still present and allowed.
        expect(migrationCode).toContain('CREATE OR REPLACE FUNCTION public.driver_service_eligibility(');
        expect(migrationCode).toContain('REVOKE EXECUTE ON FUNCTION public.driver_service_eligibility(UUID, TEXT, TIMESTAMPTZ) FROM anon, authenticated, service_role;');
    });

    it('16e. the postflight records the exact migration source hash it verifies', () => {
        // Structural proof of identity: the postflight declares the SHA-256 of the
        // migration, and the suite proves that declaration equals the real file.
        // Editing the migration without updating the postflight fails here.
        const declared = /'sha256=([0-9a-f]{64})'/i.exec(postflightCode)?.[1] ?? null;
        expect(declared, 'the postflight must record a SHA-256 for the migration').not.toBeNull();
        expect(declared?.toUpperCase()).toBe(sha256(migrationRaw));
        // ...and no placeholder may survive.
        expect(postflightCode).not.toContain('PENDING_HASH');
    });
});

// ===========================================================================
describe('Phase A N12 regression boundary and operational scripts', () => {
    it('17. the Phase A migration does not touch any N12 object', () => {
        for (const frozen of [
            'idx_jobs_one_active_per_driver',
            'driver_occupying_statuses',
            'driver_has_other_active_job',
            'driver_has_active_job'
        ]) {
            // It may not CREATE OR REPLACE, DROP or ALTER any N12 object.
            expect(migrationCode, `${frozen} must not be re-created`).not.toContain(`CREATE OR REPLACE FUNCTION public.${frozen}`);
            expect(migrationCode, `${frozen} must not be dropped`).not.toContain(`DROP FUNCTION IF EXISTS public.${frozen}`);
            expect(migrationCode, `${frozen} must not be indexed`).not.toContain(`INDEX IF NOT EXISTS ${frozen}`);
        }
        expect(migrationCode).not.toContain('CREATE UNIQUE INDEX');
        expect(migrationCode).not.toMatch(/ALTER\s+TABLE\s+public\.jobs\s+ALTER\s+COLUMN/i);
        // The Batch 2B migration file itself is untouched by Phase A.
        expect(readNormalized(N12_MIGRATION)).toContain('idx_jobs_one_active_per_driver');
    });

    it('17b. preflight and postflight are read-only and never invoke an acquisition RPC', () => {
        const stripLiterals = (text: string): string => text.replace(/'(?:[^']|'')*'/g, "''");
        for (const [label, code] of [['preflight', preflightCode], ['postflight', postflightCode]] as Array<[string, string]>) {
            const bare = stripLiterals(code);
            expect(bare, `${label} must contain no DDL`).not.toMatch(/\bcreate\s+(table|index|function|trigger|policy)\b/i);
            expect(bare, `${label} must contain no DROP/ALTER`).not.toMatch(/\b(drop|alter)\s+(table|index|function|trigger|policy)\b/i);
            expect(bare, `${label} must contain no DML`).not.toMatch(/\b(insert\s+into|delete\s+from|update\s+public\.|truncate)\b/i);
            expect(bare, `${label} must contain no GRANT/REVOKE`).not.toMatch(/\b(grant|revoke)\s+[a-z]/i);
            expect(bare, `${label} must not invoke an acquisition RPC`).not.toMatch(
                /\b(select|perform|call)\s+public\.(accept_searching_job|assign_driver_to_job|accept_assigned_job|accept_fare_negotiation)\s*\(/i);
        }
    });

    it('17c. the preflight never statically invokes a Phase A object', () => {
        // Clean-install lesson: the preflight runs BEFORE the migration, so every
        // optional object must be reached through a to_regprocedure/to_regclass
        // STRING. A statically written call would be resolved by the parser and
        // abort the script.
        const bare = preflightCode.replace(/'(?:[^']|'')*'/g, "''");
        for (const name of [
            'canonical_driver_service', 'job_canonical_service', 'safe_iso_date',
            'driver_compliance_rules', 'driver_compliance_rule_passes',
            'driver_service_eligibility', 'enforce_job_acquisition_eligibility'
        ]) {
            const calls = bare.match(new RegExp(`(?:public\\s*\\.\\s*)?\\b${name}\\s*\\(`, 'gi')) ?? [];
            expect(calls.length, `preflight must not invoke ${name}()`).toBe(0);
        }
        // ...and it does use catalog introspection for them.
        expect(preflightCode).toContain('to_regprocedure');
        expect(preflightCode).toContain('to_regclass');
        // The postflight runs AFTER, so it may call them.
        expect(postflightCode).toContain('public.driver_service_eligibility(');
    });

    it('17d. the preflight and postflight cast internal "char" catalog columns', () => {
        // tgenabled (pg_trigger) and provolatile (pg_proc) are internal "char";
        // concatenating them without a cast is ambiguous and aborts the script.
        expect(preflightCode).toContain('t.tgenabled::TEXT');
        expect(postflightCode).toContain('t.tgenabled::TEXT');
        expect(postflightCode).toContain('p.provolatile::TEXT');
        expect(preflightCode).not.toMatch(/tgenabled\s*\|\|/);
        expect(postflightCode).not.toMatch(/provolatile\s*\|\|/);
        expect(preflightCode).not.toMatch(/defaclobjtype\s*\|\|/);
        expect(postflightCode).not.toMatch(/defaclobjtype\s*\|\|/);
    });

    it('17e. the migration introduces no vehicle_class dependency', () => {
        expect(migrationCode).not.toContain('vehicle_class');
        expect(preflightCode).not.toMatch(/[\s.(]vehicle_class\s*[),=]/);
        expect(postflightCode).not.toContain('vehicle_class');
    });

    it('17f. the preflight GATES licence read-precedence safety but never gates backfillability', () => {
        // Precedence safety IS a GO/NO-GO failure: a present-but-unusable
        // canonical expiry shadows real licence evidence, and the Phase B
        // NULL-only backfill cannot repair a non-NULL canonical value.
        expect(preflightCode).toContain('unsafe_precedence');
        expect(preflightCode).toContain('UNSAFE_SHADOWED');
        expect(preflightCode).toContain('LICENCE EXPIRY precedence safety');
        expect(preflightCode).toMatch(/NO-GO: canonical licence expiry shadows usable compatibility data/);
        // The gate covers BOTH ways a present canonical value can be unusable:
        // a value that is not even date-shaped, and an impossible calendar date.
        expect(preflightCode).toContain('canon_unshaped');
        expect(preflightCode).toContain('canonical_impossible_calendar');
        expect(preflightCode).toContain('canonical_bad_shape');
        // Backfillability is reported, never gated: Phase A mutates nothing, so
        // "there are rows to fill" is not a Phase A precondition.
        expect(preflightCode).toContain('PHASE B BACKFILL rows that would be changed');
        expect(preflightCode).not.toMatch(/NO-GO:[^']*backfill/i);
        // The preflight must never CAST licence expiry to DATE: an impossible
        // calendar date would RAISE and abort the read-only script.
        expect(preflightCode).not.toMatch(/taxi_license_expiry\s*\)?\s*::\s*DATE/i);
        expect(preflightCode).not.toMatch(/council_license_expiry\s*\)?\s*::\s*DATE/i);
    });

    it('17g. the postflight proves no Phase A object can write application data', () => {
        // Runtime structural proof: the only trigger wired to a Phase A function
        // is the DISABLED acquisition trigger, and no Phase A function body
        // contains application DML.
        expect(postflightCode).toContain('no Phase A function is wired as an active trigger');
        expect(postflightCode).toContain('Phase A function bodies contain no application DML');
        expect(postflightCode).toContain('t.tgenabled::TEXT');
        expect(flat(postflightCode)).toContain('p.prosrc~*');
        // It states plainly that row equality is NOT claimed.
        const raw = readNormalized(POSTFLIGHT);
        expect(raw).toMatch(/Row-level equality is NOT proven here and is NOT claimed/);
        expect(raw).not.toMatch(/rows are unchanged/i);
        expect(raw).not.toMatch(/row equality (was )?(runtime-)?proven/i);
    });
});

// ===========================================================================
describe('Phase A mutation self-checks (the guards are not vacuous)', () => {
    it('18a. removing an expiry rule is detected', () => {
        const mutated = withoutRuleCode(migrationRaw, 'document.insurance.expiry');
        const mutatedRules = parseSqlRules(sqlCode(mutated).slice(
            sqlCode(mutated).indexOf('CREATE OR REPLACE FUNCTION public.driver_compliance_rules()')));
        expect(parityDiff(mutatedRules, DRIVER_ELIGIBILITY_RULES).length).toBeGreaterThan(0);
        expect(mutatedRules.length).toBe(DRIVER_ELIGIBILITY_RULES.length - 1);
        // The real file is intact.
        expect(parityDiff(sqlRules, DRIVER_ELIGIBILITY_RULES)).toEqual([]);
    });

    it('18b. adding a PHV licensing rule to a non-ride service is detected', () => {
        const mutated = withRuleScope(migrationRaw, 'licence.private_hire.council', 'delivery');
        const mutatedRules = parseSqlRules(sqlCode(mutated).slice(
            sqlCode(mutated).indexOf('CREATE OR REPLACE FUNCTION public.driver_compliance_rules()')));
        const leaked = mutatedRules.filter(r => r.ruleCode.startsWith('licence.private_hire') && r.serviceScope !== 'ride');
        expect(leaked.length).toBeGreaterThan(0);
        // ...which is exactly what the ride-only assertions reject.
        const realLeaks = sqlRules.filter(r => r.ruleCode.startsWith('licence.private_hire') && r.serviceScope !== 'ride');
        expect(realLeaks).toEqual([]);
    });

    it('18c. removing the service.unresolved fail-closed guard is detected', () => {
        const mutated = migrationRaw.replace(/'service\.unresolved'/g, "'service.ok'");
        expect(flat(sqlCode(mutated))).not.toContain("'service.unresolved'");
        expect(flat(migrationCode)).toContain("'service.unresolved'");
    });

    it('18d. enabling the trigger inside the migration is detected', () => {
        const mutated = `${migrationRaw}\nALTER TABLE public.jobs ENABLE TRIGGER trg_enforce_job_acquisition_eligibility;\n`;
        expect(enablesAcquisitionTrigger(mutated)).toBe(true);
        expect(enablesAcquisitionTrigger(migrationRaw)).toBe(false);
    });

    it('18e. SQL/TS blocking-code drift is detected', () => {
        const drifted = withRuleField(migrationRaw, 'document.insurance', 'insurance_expiry');
        const driftedRules = parseSqlRules(sqlCode(drifted).slice(
            sqlCode(drifted).indexOf('CREATE OR REPLACE FUNCTION public.driver_compliance_rules()')));
        expect(parityDiff(driftedRules, DRIVER_ELIGIBILITY_RULES).length).toBeGreaterThan(0);
        expect(parityDiff(sqlRules, DRIVER_ELIGIBILITY_RULES)).toEqual([]);
    });

    it('18f. promoting an advisory row to blocking is detected', () => {
        const promoted = withRuleBlocking(migrationRaw, 'document.courier_insurance', true);
        const promotedRules = parseSqlRules(sqlCode(promoted).slice(
            sqlCode(promoted).indexOf('CREATE OR REPLACE FUNCTION public.driver_compliance_rules()')));
        const promotedAdvisory = promotedRules.filter(r =>
            r.ruleCode === 'document.courier_insurance' && r.blocking);
        expect(promotedAdvisory.length).toBeGreaterThan(0);
        // ...which the Phase A advisory assertion rejects.
        for (const row of sqlRules.filter(r => r.ruleCode === 'document.courier_insurance')) {
            expect(row.blocking).toBe(false);
        }
    });

    it('18g. enabling profiles RLS inside the migration is detected', () => {
        const mutated = `${migrationRaw}\nALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;\n`;
        expect(enablesProfilesRls(mutated)).toBe(true);
        expect(enablesProfilesRls(migrationRaw)).toBe(false);
    });

    it('18h. an application-data UPDATE inserted into the migration is detected', () => {
        // The exact correction this revision makes: Phase A must never carry an
        // executable write to profiles, not even a self-assignment no-op.
        const mutated = `${migrationRaw}\nUPDATE public.profiles\n   SET council_license_number = council_license_number;\n`;
        expect(applicationDataDml(mutated), 'an executable UPDATE must be detected').not.toEqual([]);
        expect(applicationDataDml(mutated).join(' ')).toMatch(/UPDATE/);
        expect(applicationDataDml(migrationRaw)).toEqual([]);
        // Detected also through an alias, and when wrapped in a CTE.
        expect(applicationDataDml(`${migrationRaw}\nUPDATE p SET council_name = 'x' FROM public.profiles p;\n`)).not.toEqual([]);
        expect(applicationDataDml(
            `${migrationRaw}\nWITH src AS (SELECT 1 AS id) UPDATE public.profiles p SET council_name = 'x' FROM src s WHERE p.id = s.id;\n`
        )).not.toEqual([]);
    });

    it('18i. INSERT, DELETE and TRUNCATE against application tables are detected', () => {
        expect(applicationDataDml(`${migrationRaw}\nINSERT INTO public.profiles (id) VALUES (gen_random_uuid());\n`)).not.toEqual([]);
        expect(applicationDataDml(`${migrationRaw}\nDELETE FROM public.profiles WHERE id IS NULL;\n`)).not.toEqual([]);
        expect(applicationDataDml(`${migrationRaw}\nTRUNCATE public.profiles;\n`)).not.toEqual([]);
        expect(applicationDataDml(migrationRaw)).toEqual([]);
    });

    it('18j. removing the total-DATE guard from safe_iso_date is detected', () => {
        const marker = 'EXCEPTION WHEN others THEN';
        expect(migrationRaw, 'the guard must exist before it can be removed').toContain(marker);
        const mutated = migrationRaw.replace(marker, '');
        expect(flat(sqlCode(mutated))).not.toContain('exceptionwhenothersthen');
        expect(flat(sqlCode(migrationRaw))).toContain('exceptionwhenothersthen');
    });

    it('18k. the detector distinguishes retained design comments from executable DML', () => {
        // A comment-only backfill is not DML...
        expect(applicationDataDml('-- UPDATE public.profiles SET council_name = council_name;\n')).toEqual([]);
        // ...and the real migration is clean for exactly that reason.
        expect(applicationDataDml(migrationRaw)).toEqual([]);
        // Un-commenting the retained Phase B design makes it detectable, which is
        // what proves the pass above is comment-stripping and not a blind spot.
        const uncommented = migrationRaw.replace(/^--/gm, '');
        expect(applicationDataDml(uncommented)).not.toEqual([]);
    });
});

// ===========================================================================
describe('Phase A postflight service-resolution fixture and final gate', () => {
    const postflightRaw = readNormalized(POSTFLIGHT);
    const blocks = fixtureBlocks(postflightRaw);
    /** SECTION 4.1 (per-row report) and SECTION 6 (the GO/NO-GO gate). */
    const reportBlock = blocks[0] ?? '';
    const gateBlock = blocks[1] ?? '';
    const reportFixtures = parseFixtures(reportBlock);
    const gateFixtures = parseFixtures(gateBlock);

    it('19a. the postflight declares an explicit expected canonical value per fixture row', () => {
        expect(blocks.length, 'both the report and the gate must carry the fixture').toBe(2);
        expect(reportFixtures.length).toBeGreaterThanOrEqual(20);
        expect(gateFixtures.length).toBe(reportFixtures.length);
        // The report and the gate must use the SAME fixture, byte for byte, so a
        // failure can never be reported in one place and ignored in the other.
        expect(gateBlock).toBe(reportBlock);
        // Every row carries an expectation: either a canonical service or an
        // explicit NULL. Nothing is left untyped or derived from the raw input.
        const shape = /\(\s*'([^']*)'\s*,\s*(?:'[^']*'|NULL)\s*\)/;
        for (const row of reportBlock.split('\n')) {
            if (!row.includes("('")) continue;
            expect(shape.test(row.trim()), `fixture row lacks an explicit expectation: ${row.trim()}`).toBe(true);
        }
    });

    it('19b. every fixture expectation matches the canonical implementation', () => {
        // THE evaluated assertion. If any expectation is wrong — including a
        // mutation such as RIDE -> errand — this fails, and so does the suite.
        expect(fixtureResolutionFailures(reportFixtures)).toEqual([]);
        expect(fixtureResolutionFailures(gateFixtures)).toEqual([]);
    });

    it('19c. uppercase RIDE resolves to ride, in the fixture and in the implementation', () => {
        // The exact production defect: the old verdict compared the RAW text
        // against a lowercase alias list, so a correctly resolved 'RIDE' printed
        // FAIL. The fixture now freezes the expectation explicitly.
        expect(canonicalDriverService('RIDE')).toBe('ride');
        expect(canonicalDriverService('Ride')).toBe('ride');
        expect(reportFixtures).toContainEqual({ raw: 'RIDE', expected: 'ride' });
        expect(reportFixtures).toContainEqual({ raw: 'Ride', expected: 'ride' });
        expect(gateFixtures).toContainEqual({ raw: 'RIDE', expected: 'ride' });
        // ...and the resolution expression in the report compares against the
        // expectation, never against the raw text.
        expect(reportBlock).toBe(gateBlock);
        expect(postflightRaw).toContain('public.canonical_driver_service(f.raw) AS resolved');
        expect(postflightRaw).toContain('CASE WHEN r.resolved IS NOT DISTINCT FROM r.expected THEN');
        // The defective formulation must be gone.
        expect(postflightRaw).not.toMatch(/t\.raw\s+IN\s*\(\s*'ride'/i);
        expect(postflightRaw).not.toMatch(/t\.raw\s+NOT\s+IN/i);
    });

    it('19d. uppercase aliases normalise to their canonical services', () => {
        for (const [raw, expected] of [
            ['RIDE', 'ride'], ['Ride', 'ride'], ['  RIDE  ', 'ride'], ['  ride  ', 'ride'],
            ['ERRAND', 'errand'], ['SHOP', 'errand'],
            ['DELIVERY', 'delivery'], ['VAN-MOVING', 'van-moving']
        ] as const) {
            expect(canonicalDriverService(raw), `canonicalDriverService(${JSON.stringify(raw)})`).toBe(expected);
            expect(reportFixtures, `fixture must freeze ${raw} -> ${expected}`)
                .toContainEqual({ raw, expected });
        }
    });

    it('19e. unknown and blank services stay NULL and fail closed', () => {
        // The postflight fixture freezes NULL expectations...
        expect(reportFixtures).toContainEqual({ raw: 'bogus', expected: null });
        expect(reportFixtures).toContainEqual({ raw: '', expected: null });
        expect(reportFixtures).toContainEqual({ raw: '   ', expected: null });
        // ...and the implementation agrees.
        for (const raw of ['bogus', '', '   ', 'RIDE-MOVING', 'rides']) {
            expect(canonicalDriverService(raw), `canonicalDriverService(${JSON.stringify(raw)})`).toBeNull();
        }
        // An unresolvable service blocks acquisition with service.unresolved.
        const verdict = evaluateDriverServiceEligibility({
            profile: { role: 'driver' }, vehicle: { type: 'car', capacity: 'standard' }, service: 'bogus'
        });
        expect(verdict.eligible).toBe(false);
        expect(verdict.blockingCodes).toEqual([SERVICE_UNRESOLVED_CODE]);
    });

    it('19f. the final GO / NO-GO reports AND gates the alias-failure counter', () => {
        // The gate must both display the counter and branch on it; a counter that
        // is only displayed cannot influence the verdict.
        expect(gateReportsAliasFailures(postflightRaw), 'the counter must be reported').toBe(true);
        expect(gateGatesOnAliasFailures(postflightRaw), 'the counter must gate the verdict').toBe(true);
        // ...and it must be derived from the SAME fixture as the report.
        expect(postflightRaw).toContain('service_resolution_failures AS (');
        expect(postflightRaw).toMatch(/FROM\s+service_fixtures\s+f\s+WHERE\s+public\.canonical_driver_service\(f\.raw\)\s+IS\s+DISTINCT\s+FROM\s+f\.expected/);

        // Every counter the verdict depends on, including the alias counter.
        const gated = gatedCounters(postflightRaw);
        for (const counter of [
            'missing_objects', 'unpinned', 'client_grants', 'trigger_enabled',
            'service_resolution_failures', 'ride_scope_leak', 'advisory_leak',
            'n12_statuses', 'profiles_rls'
        ]) {
            expect(gated, `the final verdict must branch on ${counter}`).toContain(counter);
        }

        // Evaluated, not merely present: with the real fixture there are zero
        // failures, so the alias condition is FALSE and cannot mask the verdict.
        expect(fixtureResolutionFailures(gateFixtures)).toEqual([]);
    });

    it('19g. a deliberately wrong alias expectation fails BOTH the alias check and the final gate', () => {
        const mutated = withAliasExpectation(postflightRaw, 'RIDE', 'errand');
        expect(mutated, 'the mutation must actually change the fixture').not.toBe(postflightRaw);

        const mutatedGate = parseFixtures(fixtureBlocks(mutated)[1] ?? '');
        // (1) the per-row alias check fails: the wrong expectation is detected.
        const failures = fixtureResolutionFailures(mutatedGate);
        expect(failures.map(f => f.raw)).toContain('RIDE');
        expect(failures.length).toBeGreaterThan(0);
        // (2) and the final gate is wired to that same counter, so the aggregate
        //     can no longer print PASS while an alias row is wrong.
        expect(gateGatesOnAliasFailures(mutated), 'the gate must still branch on the counter').toBe(true);
        expect(gateReportsAliasFailures(mutated)).toBe(true);

        // The unmutated file has neither problem.
        expect(fixtureResolutionFailures(gateFixtures)).toEqual([]);
        expect(gateGatesOnAliasFailures(postflightRaw)).toBe(true);
    });

    it('19h. removing the alias-failure condition from the final gate is detected', () => {
        const withoutCondition = postflightRaw.replace(
            /[ \t]*WHEN \(SELECT n FROM service_resolution_failures\) > 0 THEN 'NO-GO[^\n]*\n/, '');
        expect(withoutCondition, 'the mutation must actually remove the condition').not.toBe(postflightRaw);
        expect(gateGatesOnAliasFailures(withoutCondition), 'the gate must no longer branch on it').toBe(false);
        expect(gateGatesOnAliasFailures(postflightRaw)).toBe(true);

        // Removing the counter itself is detected too.
        const withoutCounter = postflightRaw.replace(
            /[ \t]*\|\| ' \| service_resolution_failures=' \|\| \(SELECT n FROM service_resolution_failures\)::TEXT\n/, '');
        expect(gateReportsAliasFailures(withoutCounter)).toBe(false);
        expect(gateReportsAliasFailures(postflightRaw)).toBe(true);
    });
});
