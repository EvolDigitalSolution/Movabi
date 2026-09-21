import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Static regression tests for the lifecycle RPC EXECUTE privilege matrix.
 *
 * WHY THIS TEST EXISTS
 * The original lifecycle migration relied on `REVOKE ALL ... FROM PUBLIC` alone.
 * That removes only the PUBLIC pseudo-role's grant; it does NOT remove EXECUTE
 * that a concrete role holds in its own right, and this database's schema owner
 * carries default privileges that handed EXECUTE directly to anon,
 * authenticated and service_role. Production postflight therefore found
 * effective EXECUTE where it must not exist and returned NO-GO.
 *
 * These tests assert the SOURCE SQL contains the explicit role-level REVOKEs and
 * GRANTs that converge to the documented matrix, so the defect cannot silently
 * return in a future edit.
 *
 * They are STATIC text assertions. They are not a substitute for the
 * effective-privilege checks in scripts/db/postflight_....sql, which run
 * has_function_privilege() against a live database. No PostgreSQL runtime is
 * available locally, so the privilege matrix itself is not executed here.
 */

const LIFECYCLE_MIGRATION = 'supabase/migrations/20260921000000_accept_rpc_lifecycle_reconcile.sql';
const ACL_REPAIR_MIGRATION = 'supabase/migrations/20260922000000_accept_rpc_acl_repair.sql';
const POSTFLIGHT = 'scripts/db/postflight_20260921000000_accept_rpc_lifecycle.sql';

/**
 * Collapse a SQL file to a single normalised string for matching:
 *  - strip comments so prose about privileges cannot satisfy an assertion
 *  - drop whitespace entirely, so "(uuid, uuid)" and "(UUID,UUID)" both match
 */
const flat = (path: string): string =>
    readFileSync(path, 'utf8')
        .split('\n')
        .filter(line => !line.trimStart().startsWith('--'))
        .join('\n')
        .toLowerCase()
        .replace(/\s+/g, '');

/** Normalise a signature the same way, so expectations match either formatting. */
const sig = (value: string): string => value.toLowerCase().replace(/\s+/g, '');

/** Normalise a SQL snippet (e.g. a REVOKE statement) for whitespace-insensitive matching. */
const snippet = (value: string): string => value.toLowerCase().replace(/\s+/g, '');

/**
 * Intended effective EXECUTE matrix.
 * driver_vehicle_can_accept_job is an internal predicate invoked only from
 * SECURITY DEFINER callers, so it needs no role grant at all.
 */
const ACL_MATRIX: Array<{
    fn: string;
    signature: string;
    mustRevoke: string[];
    mustGrant: string[];
}> = [
    {
        fn: 'driver_vehicle_can_accept_job',
        signature: 'public.driver_vehicle_can_accept_job(uuid, uuid)',
        mustRevoke: ['anon', 'authenticated', 'service_role'],
        mustGrant: []
    },
    {
        fn: 'accept_searching_job',
        signature: 'public.accept_searching_job(uuid, uuid)',
        mustRevoke: ['anon'],
        mustGrant: ['authenticated', 'service_role']
    },
    {
        fn: 'assign_driver_to_job',
        signature: 'public.assign_driver_to_job(uuid, uuid)',
        mustRevoke: ['anon'],
        mustGrant: ['authenticated', 'service_role']
    },
    {
        fn: 'accept_assigned_job',
        signature: 'public.accept_assigned_job(uuid, uuid)',
        mustRevoke: ['anon', 'service_role'],
        mustGrant: ['authenticated']
    },
    {
        fn: 'settle_job_wallet_reservation',
        signature: 'public.settle_job_wallet_reservation(uuid, numeric)',
        mustRevoke: ['anon', 'authenticated'],
        mustGrant: ['service_role']
    }
];

describe('lifecycle RPC EXECUTE privilege matrix (static source assertions)', () => {
    const lifecycle = flat(LIFECYCLE_MIGRATION);
    const repair = flat(ACL_REPAIR_MIGRATION);
    const postflight = flat(POSTFLIGHT);

    it('every function is revoked from PUBLIC in both the migration and the repair', () => {
        for (const entry of ACL_MATRIX) {
            const revokePublic = snippet(`REVOKE ALL ON FUNCTION ${entry.signature} FROM PUBLIC`);
            expect(lifecycle, `${entry.fn} REVOKE ALL FROM PUBLIC missing in migration`).toContain(revokePublic);
            expect(repair, `${entry.fn} REVOKE ALL FROM PUBLIC missing in repair`).toContain(revokePublic);
        }
    });

    it.each(ACL_MATRIX)('$fn explicitly revokes EXECUTE from every must-not-have role', (entry) => {
        // REVOKE FROM PUBLIC alone is exactly what failed in production, so each
        // must-not-have role needs its own explicit revocation in BOTH files.
        // A REVOKE statement may name several roles ("FROM anon, service_role"),
        // so accept either the single-role form or a comma-separated list.
        for (const role of entry.mustRevoke) {
            const sig = snippet(entry.signature).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(
                `REVOKE(ALL|EXECUTE)ONFUNCTION${sig}FROM(?:[a-z_]+,)*${role}(?![a-z_])`,
                'i'
            );
            expect(lifecycle, `${entry.fn} missing REVOKE from ${role} in migration`).toMatch(pattern);
            expect(repair, `${entry.fn} missing REVOKE from ${role} in repair`).toMatch(pattern);
        }
    });

    it.each(ACL_MATRIX)('$fn grants EXECUTE to exactly the intended roles', (entry) => {
        if (entry.mustGrant.length === 0) {
            // The internal helper must have NO role grant at all.
            expect(repair).not.toContain(snippet(`GRANT EXECUTE ON FUNCTION ${entry.signature} TO`));
            expect(lifecycle).not.toContain(snippet(`GRANT EXECUTE ON FUNCTION ${entry.signature} TO`));
            return;
        }
        const grant = snippet(`GRANT EXECUTE ON FUNCTION ${entry.signature} TO ${entry.mustGrant.join(', ')}`);
        expect(lifecycle, `${entry.fn} missing GRANT in migration`).toContain(grant);
        expect(repair, `${entry.fn} missing GRANT in repair`).toContain(grant);
    });

    it('the repair migration is privilege DDL only (no data writes, no object DDL)', () => {
        // The flat() helper already strips comments, so prose mentioning these
        // words cannot trigger a false pass or fail.
        for (const forbidden of [
            /\bINSERT\s+INTO\b/i,
            /\bUPDATE\s+/i,
            /\bDELETE\s+FROM\b/i,
            /\bCREATE\s+(TABLE|INDEX|FUNCTION|OR\s+REPLACE)\b/i,
            /\bDROP\s+(TABLE|INDEX|FUNCTION)\b/i,
            /\bALTER\s+(TABLE|FUNCTION)\b/i,
            /\bTRUNCATE\b/i
        ]) {
            expect(repair, `repair migration must not contain ${forbidden}`).not.toMatch(forbidden);
        }

        // The one permitted ALTER is the DEFAULT PRIVILEGES reset that stops the
        // defect recurring for future functions.
        expect(repair).toMatch(/alterdefaultprivileges/i);
    });

    it('the repair migration uses exact schema-qualified signatures', () => {
        for (const entry of ACL_MATRIX) {
            expect(repair).toContain(snippet(`FUNCTION ${entry.signature}`));
        }
        // Guard must abort when a required function is missing, rather than
        // repairing a subset.
        expect(repair).toContain(snippet('RAISE EXCEPTION'));
        expect(repair).toContain(snippet('to_regprocedure(expected.signature) IS NULL'));
    });

    it('the postflight gates on effective privileges for the full 5x3 client matrix', () => {
        // 15 policy cells: 5 functions x (anon, authenticated, service_role),
        // declared twice (the matrix row source and the section 9 acl_policy CTE).
        for (const entry of ACL_MATRIX) {
            for (const role of ['anon', 'authenticated', 'service_role']) {
                expect(postflight).toContain(snippet(`'${entry.fn}', '${role}'`));
            }
        }
        // Cross-check the actual number of cell literals present, so a dropped
        // cell fails rather than passing on a hard-coded expectation.
        const cellLiterals = (
            readFileSync(POSTFLIGHT, 'utf8').match(/'(?:anon|authenticated|service_role)',\s*(?:true|false)/g) ?? []
        ).length;
        expect(cellLiterals, '5 functions x 3 roles x 2 declarations').toBe(30);

        // The verdict must be driven by the effective-privilege violation set,
        // not by proacl text formatting.
        expect(postflight).toContain(snippet('has_function_privilege'));
        expect(postflight).toContain(snippet("WHEN (SELECT COUNT(*) FROM acl_violations) > 0 THEN 'NO-GO'"));
        expect(postflight).toContain(snippet("WHEN (SELECT COUNT(*) FROM public_grants) > 0 THEN 'NO-GO'"));
    });

    /**
     * Regression for the production defect:
     *   ERROR: column policy.signature does not exist
     * The privilege matrix joined a `sig(fname, signature)` VALUES alias but the
     * SELECT list referenced `policy.signature`, and the `policy` alias exposes
     * only (fname, rolname, can_execute). A real PostgreSQL parser catches this;
     * no engine is available here, so these structural assertions stand in for it.
     */
    it('does not reference a qualified column that its alias does not declare', () => {
        // Qualifier.column references that legitimately exist but are not derived
        // tables with an explicit column list (catalog functions, table aliases,
        // JSON field access). Anything else must be a declared derived-table column.
        const allowed: Record<string, string[]> = {
            pg_catalog: ['*'],
            information_schema: ['*'],
            metadata: ['*']
        };
        // Schema-qualified object names such as public.jobs live in FROM clauses,
        // never as an alias-qualified column in a SELECT list, so the derived-table
        // column set is the only cross-check needed here.
        const ignoreQualifiers = new Set(['public', 'auth', 'pg_catalog', 'information_schema', 'metadata']);

        for (const path of [POSTFLIGHT, ACL_REPAIR_MIGRATION, LIFECYCLE_MIGRATION]) {
            const raw = readFileSync(path, 'utf8')
                .split('\n')
                .filter(line => !line.trimStart().startsWith('--'))
                .join('\n');

            // Derived tables that declare an explicit column list. Two forms occur
            // in this SQL:
            //   ) AS alias(a, b, c)                     -- subquery / CTE body
            //   (VALUES ...) AS alias(a, b, c)          -- VALUES list
            // Matching the closing paren OR the VALUES keyword is what makes the
            // declaration set complete; without the VALUES form, aliases such as
            // f(fname, expected_signature) and sig(fname, signature) were missed.
            const declared = new Map<string, Set<string>>();
            for (const m of raw.matchAll(/(?:\)|\bVALUES\b[^;]*?)\s*AS\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gis)) {
                const alias = m[1].toLowerCase();
                const cols = m[2].split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
                const existing = declared.get(alias);
                if (existing) {
                    for (const c of cols) existing.add(c);
                } else {
                    declared.set(alias, new Set(cols));
                }
            }

            const offenders: string[] = [];
            for (const m of raw.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
                const qualifier = m[1].toLowerCase();
                const column = m[2].toLowerCase();
                if (ignoreQualifiers.has(qualifier)) continue;
                if (allowed[qualifier]) continue;
                const cols = declared.get(qualifier);
                if (!cols) continue;              // table alias: columns verified by the engine
                if (cols.has('*')) continue;
                if (!cols.has(column)) offenders.push(`${qualifier}.${column}`);
            }

            expect(
                Array.from(new Set(offenders)),
                `${path}: qualified column(s) not declared by their alias`
            ).toEqual([]);
        }
    });
});
