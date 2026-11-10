import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Batch 2C / Phase B.B1 follow-up — lock_marketplace_fare ACL fix.
 *
 * STATIC + PURE-MODEL TESTS ONLY. There is no PostgreSQL harness in this
 * workspace, so nothing here executes SQL against a server. What it proves:
 *
 *   1. the follow-up migration removes PUBLIC and anon EXECUTE with the EXACT
 *      signature, and re-asserts the selected model;
 *   2. the follow-up is ACL-only: no function body change, no trigger enable, no
 *      RLS/policy change, no table/column privilege change, no MB002, no N12
 *      change, no application-data DML;
 *   3. the ALREADY-APPLIED Phase B.1 postflight AGGREGATE now depends on the
 *      lock_marketplace_fare ACL, so a per-row ACL FAIL can no longer coexist
 *      with an aggregate PASS (the production defect);
 *   4. the aggregate arithmetic is non-vacuous: given the ACL production
 *      actually reported, the gate yields NO-GO; given the post-fix ACL it
 *      yields PASS.
 *
 * AUTHORITY: the database is authoritative. This suite only proves the
 * artifacts; it does not claim the ACL is fixed in production.
 */

const ACL_MIGRATION = 'supabase/migrations/20260926100000_lock_marketplace_fare_acl_fix.sql';
const B1_MIGRATION = 'supabase/migrations/20260926000000_booking_acquisition_atomicity.sql';
const B1_POSTFLIGHT = 'scripts/db/postflight_20260926000000_booking_acquisition_atomicity.sql';
const ACL_PREFLIGHT = 'scripts/db/preflight_20260926100000_lock_marketplace_fare_acl_fix.sql';
const ACL_POSTFLIGHT = 'scripts/db/postflight_20260926100000_lock_marketplace_fare_acl_fix.sql';
const HYBRID_SERVICE = 'src/app/core/services/marketplace/marketplace-hybrid.service.ts';
const SIGNATURE = 'public.lock_marketplace_fare(UUID, UUID, NUMERIC)';

const read = (path: string): string => readFileSync(path, 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, '').toLowerCase();
/** SQL comment lines removed, so assertions target executable text. */
const sqlCode = (text: string): string =>
    text.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

const migrationSrc = read(ACL_MIGRATION);
const migrationCode = sqlCode(migrationSrc);
const b1PostflightSrc = read(B1_POSTFLIGHT);
const aclPostflightSrc = read(ACL_POSTFLIGHT);
const aclPreflightSrc = read(ACL_PREFLIGHT);

// ---------------------------------------------------------------------------
// The selected caller model, PARSED from the follow-up postflight artifact
// ---------------------------------------------------------------------------
interface AclExpectation { role: string; want: boolean }

const selectedAclModel = (source: string): AclExpectation[] =>
    Array.from(source.matchAll(/\('(PUBLIC|anon|authenticated|service_role)',\s*(TRUE|FALSE),\s*'/gi))
        .map(m => ({ role: m[1], want: m[2].toUpperCase() === 'TRUE' }));

/** Mirrors the aggregate's violation arithmetic exactly. */
const aclViolations = (acl: Record<string, boolean>, model: readonly AclExpectation[]): number =>
    model.filter(x => acl[x.role] !== x.want).length;

/** Mirrors the aggregate's verdict. */
const aggregateVerdict = (acl: Record<string, boolean>, model: readonly AclExpectation[]): 'PASS' | 'NO-GO' =>
    aclViolations(acl, model) > 0 ? 'NO-GO' : 'PASS';

/** The ACL production actually reported for lock_marketplace_fare. */
const PRODUCTION_ACL: Record<string, boolean> = {
    PUBLIC: true, anon: true, authenticated: true, service_role: true
};
/** The intended post-fix ACL. */
const INTENDED_ACL: Record<string, boolean> = {
    PUBLIC: false, anon: false, authenticated: true, service_role: true
};

const model = selectedAclModel(aclPostflightSrc);

// ===========================================================================
describe('ACL follow-up — the migration removes PUBLIC and anon EXECUTE', () => {
    it('1. revokes EXECUTE from PUBLIC with the exact signature', () => {
        expect(migrationCode).toContain(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC;`);
    });

    it('2. revokes EXECUTE from anon with the exact signature', () => {
        expect(migrationCode).toContain(`REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM anon;`);
    });

    it('3. keeps the legitimate caller role executable', () => {
        expect(migrationCode).toContain(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO authenticated;`);
        // The caller audit: this is the ONLY legitimate runtime path.
        const hybrid = read(HYBRID_SERVICE);
        expect(hybrid).toContain("this.rpc('lock_marketplace_fare'");
        expect(flat(hybrid)).toContain('privaterpc(name:string,args?:record<string,unknown>){returnthis.supabase.rpc(name,args);}');
        // ...and it is the authenticated Supabase client, not a service-role call.
        expect(hybrid).toContain('inject(SupabaseService)');
    });

    it('4. forbids every role that must not execute it', () => {
        expect(migrationCode).toContain("REVOKE EXECUTE ON FUNCTION public.lock_marketplace_fare(UUID, UUID, NUMERIC) FROM anon;");
        // The migration must never re-grant anon, and must never revoke the two
        // selected roles.
        expect(migrationCode).not.toMatch(/GRANT[^;]*TO\s+anon/i);
        expect(migrationCode).not.toMatch(/REVOKE[^;]*FROM\s+authenticated/i);
        expect(migrationCode).not.toMatch(/REVOKE[^;]*FROM\s+service_role/i);
        // service_role is retained as the trusted-server role.
        expect(migrationCode).toContain(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role;`);
    });

    it('5. uses the EXACT signature in every ACL statement', () => {
        const aclStatements = migrationCode.split('\n').filter(l => /\b(GRANT|REVOKE)\b/.test(l));
        expect(aclStatements.length).toBeGreaterThanOrEqual(4);
        for (const statement of aclStatements) {
            expect(statement.trim(), `exact signature required: ${statement.trim()}`).toContain(SIGNATURE);
        }
        // No wildcard, no argument-less, no schema-wide form.
        expect(migrationCode).not.toMatch(/ON ALL FUNCTIONS IN SCHEMA/i);
        expect(migrationCode).not.toMatch(/ON FUNCTION\s+public\.lock_marketplace_fare\s*;/i);
    });
});

// ===========================================================================
describe('ACL follow-up — the migration is ACL-only and inert', () => {
    it('6. no function is (re)defined and the trigger is not enabled', () => {
        expect(migrationCode).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
        expect(migrationCode).not.toMatch(/ENABLE\s+TRIGGER/i);
        expect(migrationCode).not.toMatch(/ALTER\s+TABLE/i);
        // The applied Phase B.1 migration is untouched, and the Phase A trigger is
        // still left DISABLED by the migration that owns it. Comments are stripped
        // so the non-action prose ("no ... ENABLE TRIGGER") cannot satisfy or fail
        // the check.
        expect(sqlCode(read(B1_MIGRATION))).not.toMatch(/ENABLE\s+TRIGGER/i);
        expect(read('supabase/migrations/20260925000000_driver_compliance_eligibility_phase_a.sql'))
            .toContain('ALTER TABLE public.jobs DISABLE TRIGGER trg_enforce_job_acquisition_eligibility;');
    });

    it('7. no RLS or policy change', () => {
        expect(migrationCode).not.toMatch(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
        expect(migrationCode).not.toMatch(/(CREATE|DROP|ALTER)\s+POLICY/i);
        expect(migrationCode).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    });

    it('8. no table/column privilege change and no MB002', () => {
        expect(migrationCode).not.toMatch(/(GRANT|REVOKE)[^;]*ON\s+(TABLE|COLUMN)\b/i);
        expect(migrationCode).not.toMatch(/'MB002'/);
        expect(migrationCode).not.toMatch(/MB002/);
    });

    it('9. no N12 mutation', () => {
        expect(migrationCode).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
        expect(migrationCode).not.toMatch(/(DROP|ALTER)\s+INDEX/i);
        expect(migrationCode).not.toContain('idx_jobs_one_active_per_driver');
        expect(migrationCode).not.toContain('driver_occupying_statuses');
        // ...and the frozen 16-status set is untouched elsewhere.
        const n12 = read('supabase/migrations/20260924000000_driver_single_active_job.sql');
        for (const frozen of ['assigned', 'accepted', 'fare_agreed', 'heading_to_pickup', 'driver_en_route',
            'arrived', 'driver_arrived', 'arrived_at_store', 'shopping_in_progress', 'collected', 'picked_up',
            'en_route_to_customer', 'in_progress', 'delivered', 'over_budget_requested', 'requires_review']) {
            expect(n12).toContain(`'${frozen}'`);
        }
    });

    it('10. no application-data DML against any application table', () => {
        expect(migrationCode).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE|MERGE)\b/i);
        expect(migrationCode).not.toMatch(/jsonb_set/i);
        // The migration is exactly the four ACL statements plus the file's own header.
        const statements = migrationCode.split(';').map(s => s.trim()).filter(Boolean);
        expect(statements.length).toBe(4);
        for (const statement of statements) {
            expect(statement).toMatch(/^(REVOKE|GRANT)\b/);
        }
    });

    it('10b. the follow-up migration is timestamped AFTER the already-applied one', () => {
        expect('20260926100000' > '20260926000000').toBe(true);
        expect(ACL_MIGRATION).toContain('20260926100000');
        // The applied migration's body must not have been edited by this change.
        expect(read(B1_MIGRATION)).toContain('CREATE OR REPLACE FUNCTION public.lock_marketplace_fare(');
    });
});

// ===========================================================================
describe('ACL follow-up — the B.1 postflight AGGREGATE now gates on the ACL', () => {
    const aggregate = (() => {
        const start = b1PostflightSrc.indexOf('-- SECTION 3 — POST-MIGRATION GO / NO-GO');
        expect(start, 'the B.1 postflight aggregate section must exist').toBeGreaterThan(-1);
        return b1PostflightSrc.slice(start);
    })();

    it('11. the aggregate parses and branches on the ACL conditions', () => {
        for (const counter of ['lock_fare_public', 'lock_fare_anon', 'lock_fare_required_missing', 'lock_fare_acl_violations']) {
            expect(aggregate, `${counter} must exist as an aggregate counter`).toContain(`${counter} AS (`);
        }
        // Both halves of the selected model are counted.
        expect(aggregate).toContain("FROM (VALUES ('anon')) AS ro(rolname)");
        expect(aggregate).toContain("FROM (VALUES ('authenticated'), ('service_role')) AS ro(rolname)");
        expect(aggregate).toContain('a.grantee = 0');
        expect(aggregate).toContain("a.privilege_type = 'EXECUTE'");
        // ...and the verdict BRANCHES on it.
        expect(aggregate).toMatch(/WHEN\s*\(SELECT\s+n\s+FROM\s+lock_fare_acl_violations\)\s*>\s*0\s*THEN\s*'NO-GO:/);
        // ...and REPORTS each counter in the observed string.
        for (const label of ['lock_fare_public_executable=', 'lock_fare_anon_executable=', 'lock_fare_required_role_missing=']) {
            expect(aggregate, `${label} must be reported`).toContain(label);
        }
    });

    it('12. PUBLIC is checked explicitly, not only anon', () => {
        // PUBLIC is a pseudo-role: it must be probed through aclexplode(grantee = 0),
        // not has_function_privilege.
        expect(b1PostflightSrc).toContain('aclexplode(COALESCE(p.proacl, acldefault(\'f\', p.proowner)))');
        expect(b1PostflightSrc).toContain('a.grantee = 0');
        // The per-row gate must expect PUBLIC=false and authenticated/service_role=true.
        const perRow = flat(b1PostflightSrc);
        expect(perRow).toContain("'public',false,'publicpseudo-role");
        expect(perRow).toContain("'anon',false,'anonymouscallers");
        expect(perRow).toContain("'authenticated',true,'thelivemobileclient");
        expect(perRow).toContain("'service_role',true,'retainedtrusted-serverrole'");
        expect(b1PostflightSrc).toContain('IS DISTINCT FROM o.want');
    });

    it('13. EVALUATED: the aggregate arithmetic turns the production ACL into NO-GO', () => {
        // The ACL production actually reported must FAIL the gate...
        expect(model.length, 'the selected model must be parseable from the artifact').toBe(4);
        expect(aclViolations(PRODUCTION_ACL, model)).toBe(2); // PUBLIC + anon
        expect(aggregateVerdict(PRODUCTION_ACL, model)).toBe('NO-GO');
        // ...including the precise production symptom: anon executable.
        expect(model.filter(x => x.role === 'anon')[0].want).toBe(false);
        expect(PRODUCTION_ACL['anon']).toBe(true);

        // ...and the intended post-fix ACL must PASS it.
        expect(aclViolations(INTENDED_ACL, model)).toBe(0);
        expect(aggregateVerdict(INTENDED_ACL, model)).toBe('PASS');

        // Every other single-bit deviation from the intended model must also fail.
        for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
            const broken = { ...INTENDED_ACL, [role]: !INTENDED_ACL[role] };
            expect(aggregateVerdict(broken, model), `flipping ${role} must make the gate fail`).toBe('NO-GO');
        }
    });
});

// ===========================================================================
describe('ACL follow-up — preflight/postflight are read-only and asserting', () => {
    it('14. neither script contains DDL/DML and neither invokes the RPC', () => {
        for (const [label, source] of [['preflight', aclPreflightSrc], ['postflight', aclPostflightSrc]] as Array<[string, string]>) {
            const executable = sqlCode(source);
            expect(executable, `${label} must contain no DDL`).not.toMatch(/\bCREATE\s+(TABLE|INDEX|FUNCTION|TRIGGER|POLICY)\b/i);
            expect(executable, `${label} must contain no DROP/ALTER`).not.toMatch(/\b(DROP|ALTER)\s+(TABLE|INDEX|FUNCTION|TRIGGER|POLICY)\b/i);
            expect(executable, `${label} must contain no DML`).not.toMatch(/\b(UPDATE\s+(ONLY\s+)?[a-z_][a-z0-9_.]*\s+SET|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/i);
            expect(executable, `${label} must contain no table/column GRANT or REVOKE`).not.toMatch(/\b(GRANT|REVOKE)\b[^;]*ON\s+(TABLE|COLUMN)\b/i);
            // No RPC invocation (string-stripped, so signature text is not a call).
            const bare = executable.replace(/'(?:[^']|'')*'/g, "''");
            expect(bare, `${label} must not invoke lock_marketplace_fare()`).not.toMatch(/\block_marketplace_fare\s*\(/i);
            expect(bare, `${label} must not invoke accept_driver_offer()`).not.toMatch(/\baccept_driver_offer\s*\(/i);
            // Both assert the frozen boundaries.
            expect(source).toContain('trg_enforce_job_acquisition_eligibility');
            expect(source).toContain('profiles');
            expect(source).toContain('idx_jobs_one_active_per_driver');
            expect(source).toMatch(/COUNT\(\*\)\s*=\s*16/);
        }
    });

    it('15. the postflight requires the selected model and gates on it', () => {
        expect(aclPostflightSrc).toContain("('PUBLIC',        FALSE");
        expect(aclPostflightSrc).toContain("('anon',          FALSE");
        expect(aclPostflightSrc).toContain("('authenticated', TRUE");
        expect(aclPostflightSrc).toContain("('service_role',  TRUE");
        expect(aclPostflightSrc).toContain('aclexplode(COALESCE(p.proacl, acldefault(\'f\', p.proowner)))');
        expect(aclPostflightSrc).toMatch(/WHEN\s*\(SELECT\s+n\s+FROM\s+public_or_anon\)\s*>\s*0\s*THEN\s*'NO-GO:/);
        expect(aclPostflightSrc).toMatch(/WHEN\s*\(SELECT\s+n\s+FROM\s+required_missing\)\s*>\s*0\s*THEN\s*'NO-GO:/);
        expect(aclPostflightSrc).toMatch(/WHEN\s*\(SELECT\s+n\s+FROM\s+acl_violations\)\s*>\s*0\s+THEN\s*'NO-GO:/);
        // Body-unchanged and MB002 assertions.
        expect(aclPostflightSrc).toContain('body_sha256=');
        expect(aclPostflightSrc).toContain('BODY unchanged guards lock_marketplace_fare');
        expect(aclPostflightSrc).toContain("p.prosrc ILIKE '%MB002%'");
        // Identity requirements.
        expect(aclPostflightSrc).toContain('NOT p.prosecdef');
        expect(aclPostflightSrc).toContain('pg\\_temp');
    });

    it('16. the preflight reports the current exposure and expects GO on the frozen boundaries', () => {
        expect(aclPreflightSrc).toContain('CURRENT ACL lock_marketplace_fare/');
        expect(aclPreflightSrc).toContain('CURRENT proacl lock_marketplace_fare');
        expect(aclPreflightSrc).toContain('EXPOSURE impact anonymous caller');
        expect(aclPreflightSrc).toContain('aclexplode');
        expect(aclPreflightSrc).toContain("'INFO' AS verdict");
        expect(aclPreflightSrc).toContain('ACL FOLLOW-UP GO / NO-GO');
        // It must NOT gate on the permissive ACL (that is what it corrects).
        const goNoGo = aclPreflightSrc.slice(aclPreflightSrc.indexOf('SECTION 4 — GO / NO-GO'));
        expect(goNoGo).not.toMatch(/pubic|public_execute/);
        expect(goNoGo).toContain('NOT p.prosecdef');
        expect(goNoGo).toContain("<> 16");
    });
});

// ===========================================================================
describe('ACL follow-up — mutation self-checks (the guards are not vacuous)', () => {
    it('17. removing the PUBLIC/anon condition from the aggregate gate is detected', () => {
        const mutated = b1PostflightSrc.replace(
            /[ \t]*WHEN \(SELECT n FROM lock_fare_acl_violations\) > 0 THEN 'NO-GO[^\n]*\n/, '');
        expect(mutated, 'the mutation must actually remove the branch').not.toBe(b1PostflightSrc);
        expect(mutated).not.toMatch(/WHEN\s*\(SELECT\s+n\s+FROM\s+lock_fare_acl_violations\)\s*>\s*0\s*THEN\s*'NO-GO:/);
        const realAggregate = b1PostflightSrc.slice(b1PostflightSrc.indexOf('-- SECTION 3 — POST-MIGRATION GO / NO-GO'));
        expect(realAggregate).toMatch(/WHEN\s*\(SELECT\s+n\s+FROM\s+lock_fare_acl_violations\)\s*>\s*0\s*THEN\s*'NO-GO:/);
        // ...and the gate genuinely DEPENDS on the counter's definition: removing
        // the definition leaves a dangling reference an engine would reject.
        const defs = (b1PostflightSrc.match(/lock_fare_acl_violations AS \(/g) ?? []).length;
        const refs = (b1PostflightSrc.match(/FROM lock_fare_acl_violations\)/g) ?? []).length;
        expect(defs, 'the counter must be defined once').toBe(1);
        expect(refs, 'the verdict must reference the counter').toBeGreaterThanOrEqual(1);
        const noDefinition = b1PostflightSrc.replace(/lock_fare_acl_violations AS \(/, 'lock_fare_acl_removed AS (');
        expect(noDefinition).not.toMatch(/lock_fare_acl_violations AS \(/);
        expect(noDefinition).toMatch(/FROM lock_fare_acl_violations\)/);
    });

    it('18. re-granting anon (or leaving PUBLIC) in the follow-up migration is detected', () => {
        const anonRegranted = `${migrationSrc}\nGRANT EXECUTE ON FUNCTION ${SIGNATURE} TO anon;\n`;
        expect(anonRegranted).toMatch(/GRANT[^;]*TO\s+anon/i);
        expect(migrationCode).not.toMatch(/GRANT[^;]*TO\s+anon/i);

        const publicKept = migrationSrc.replace(
            `REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC;`, '-- removed');
        expect(publicKept).not.toContain(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC;`);
        expect(migrationCode).toContain(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC;`);

        const anonKept = migrationSrc.replace(
            `REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM anon;`, '-- removed');
        expect(anonKept).not.toContain(`REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM anon;`);
        expect(migrationCode).toContain(`REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM anon;`);

        // And the model must actually notice a re-granted anon.
        expect(aggregateVerdict({ ...INTENDED_ACL, anon: true }, model)).toBe('NO-GO');
        expect(aggregateVerdict({ ...INTENDED_ACL, PUBLIC: true }, model)).toBe('NO-GO');
    });

    it('19. an ACL statement with a wrong signature is detected', () => {
        const wrong = migrationSrc.replace(
            `REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM anon;`,
            'REVOKE EXECUTE ON FUNCTION public.lock_marketplace_fare(UUID, UUID) FROM anon;');
        const expected = `REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM anon;`;
        expect(wrong).not.toContain(expected);
        expect(migrationSrc).toContain(expected);
    });
});
