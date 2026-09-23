/**
 * PHASE C1 — READ-ONLY DIAGNOSTIC SAFETY GUARD.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The first production run of `scripts/db/diagnostic_phase_c1_schema_lineage.sql`
 * ABORTED THE WHOLE READ-ONLY TRANSACTION, so sections 2-10 never ran:
 *
 *   ERROR: relation "supabase_migrations.schema_migrations" does not exist
 *
 * Root cause: PostgreSQL resolves every relation named in a statement at
 * PARSE/PLAN time, before any predicate can be evaluated. Guarding a reference
 * behind a CASE or a WHERE therefore does not help — an unconditional
 *   SELECT ... FROM supabase_migrations.schema_migrations
 * is a hard error wherever the ledger is absent, and once a statement errors the
 * surrounding transaction is poisoned (25P02) so every later section fails too.
 * The same class of defect appeared as `'public.jobs'::regclass`: the ::regclass
 * CAST raises 42P01 when the relation is missing, whereas `to_regclass(...)`
 * RETURNS NULL, which is exactly what an absence-safe diagnostic needs.
 *
 * An absence-safe diagnostic may only touch POSSIBLY-ABSENT objects through
 * catalog introspection (to_regclass / to_regnamespace + pg_catalog), and must
 * report ABSENT rather than raising.
 *
 * WHAT IS GUARDED
 *   1. the migration ledger is never referenced in a FROM/JOIN clause;
 *   2. every mention of the ledger is a to_regclass() probe (or a comment);
 *   3. no ::regclass / ::regnamespace cast is used anywhere (they raise on
 *      absence; the to_* functions return NULL);
 *   4. absence is decided through catalog introspection;
 *   5. BEGIN TRANSACTION READ ONLY and a final ROLLBACK are present;
 *   6. no write DDL/DML appears anywhere;
 *   7. a completion sentinel exists so a wrapper can distinguish "ran to the end"
 *      from "aborted part-way" (the original wrapper trusted `tee`'s exit code);
 *   8. every expected object is reported one row per object, so absence is
 *      EVIDENCE (ABSENT) rather than a silently empty result set.
 *
 * This test is deliberately STRUCTURAL and needs NO database.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIAGNOSTIC = 'scripts/db/diagnostic_phase_c1_schema_lineage.sql';
const RAW = readFileSync(resolve(process.cwd(), DIAGNOSTIC), 'utf8');

/** Strip `--` line comments so prose can neither satisfy nor violate an assertion. */
function stripComments(sql: string): string {
    return sql
        .split(/\r?\n/)
        .map(line => line.replace(/--.*$/, ''))
        .join('\n');
}

const EXEC = stripComments(RAW);

/** Non-empty, comment-stripped lines — the script's executable form. */
const EXEC_LINES = EXEC.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

describe('PHASE C1 — read-only diagnostic safety (absence-safe, no live DB)', () => {
    it('0. the diagnostic exists and is non-trivial', () => {
        expect(RAW.length, `${DIAGNOSTIC} must exist and be non-empty`).toBeGreaterThan(2000);
        expect(EXEC_LINES.length).toBeGreaterThan(20);
    });

    it('1. the migration ledger is NEVER referenced in a FROM or JOIN clause', () => {
        // This is the exact defect that aborted production: a parse-time relation
        // reference. CASE/WHERE guards cannot make it safe.
        const fromRef = /(?:FROM|JOIN)\s+supabase_migrations\s*\./i;
        expect(
            EXEC,
            'supabase_migrations.schema_migrations must never appear in FROM/JOIN: '
            + 'PostgreSQL resolves it at parse time and raises 42P01 when absent, '
            + 'which aborts the READ ONLY transaction and skips every later section.'
        ).not.toMatch(fromRef);
    });

    it('2. every ledger mention is a to_regclass() probe, never a bare relation name', () => {
        const needle = 'supabase_migrations.schema_migrations';
        const mentions = [...EXEC.matchAll(new RegExp(needle.replace(/\./g, '\\.'), 'g'))];
        const unguarded = mentions
            .map(match => EXEC.slice(Math.max(0, (match.index ?? 0) - 14), match.index))
            .filter(prefix => !/to_regclass\(['"]$/.test(prefix));
        expect(
            unguarded.length,
            `every executable mention of ${needle} must be preceded by to_regclass(' so the `
            + 'reference is a function argument (execution-time) rather than a parsed relation'
        ).toBe(0);
    });

    it('3. no ::regclass / ::regnamespace cast is used (they raise on absence)', () => {
        expect(
            EXEC,
            "::regclass raises 42P01 for a missing relation; use to_regclass('...') which returns NULL"
        ).not.toMatch(/::\s*regclass/i);
        expect(
            EXEC,
            "::regnamespace raises for a missing schema; use to_regnamespace('...') which returns NULL"
        ).not.toMatch(/::\s*regnamespace/i);
    });

    it('4. absence is decided through catalog introspection, and absence-safe probes are present', () => {
        for (const probe of ['to_regclass(', 'to_regnamespace(']) {
            expect(EXEC, `the diagnostic must use ${probe}`).toContain(probe);
        }
        const catalogs = ['pg_attribute', 'pg_constraint', 'pg_proc', 'pg_trigger', 'pg_policy', 'pg_indexes'];
        for (const catalog of catalogs) {
            expect(EXEC, `expected catalog introspection via ${catalog}`).toContain(catalog);
        }
    });

    it('5. the read-only envelope is present and the final statement is ROLLBACK', () => {
        expect(EXEC).toMatch(/BEGIN\s+TRANSACTION\s+READ\s+ONLY\s*;/i);
        expect(EXEC_LINES.at(-1), 'the last executable statement must be ROLLBACK;').toBe('ROLLBACK;');
        // The transaction must open before anything else runs.
        const beginAt = EXEC_LINES.findIndex(line => /^BEGIN\s+TRANSACTION\s+READ\s+ONLY\s*;/i.test(line));
        expect(beginAt, 'BEGIN TRANSACTION READ ONLY must be the first executable statement').toBe(0);
    });

    it('6. no write DDL/DML appears anywhere in the executable text', () => {
        // Statement-initial write keywords. `SET` is included because a bare SET is
        // session mutation, and current_setting() is a function, not a statement.
        const writeStatement = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|VACUUM|ANALYZE|COMMENT|COPY|DO|CALL|REFRESH|CLUSTER|REINDEX|SET)\b/im;
        const offending = EXEC_LINES.filter(line => writeStatement.test(line));
        expect(
            offending,
            'the diagnostic must contain no write DDL/DML; a diagnostic that can mutate is not read-only'
        ).toEqual([]);
    });

    it('7. a completion sentinel exists so a wrapper cannot mistake an abort for success', () => {
        // The original wrapper ran `psql ... | tee ...` and reported DIAGNOSTIC_EXIT=0
        // because tee succeeds regardless of psql's status.
        expect(EXEC, 'the diagnostic must emit a completion sentinel').toContain('DIAGNOSTIC_COMPLETE');
        expect(EXEC, 'the sentinel must state that all sections ran').toContain('COMPLETED');
        const sentinelAt = EXEC_LINES.findIndex(line => line.includes('DIAGNOSTIC_COMPLETE'));
        expect(sentinelAt, 'the sentinel must be emitted before the final ROLLBACK').toBeLessThan(EXEC_LINES.length - 1);
    });

    it('8. expected objects are enumerated one row per object so absence reports ABSENT', () => {
        // Every absent-object conclusion must be expressible as a row. An inner join
        // that yields zero rows for a missing object is indistinguishable from a
        // query that silently returned nothing.
        expect(EXEC, 'the diagnostic must emit an explicit ABSENT verdict').toContain("'ABSENT'");
        expect(EXEC, 'the diagnostic must emit an explicit EXISTS verdict').toContain("'EXISTS'");
        expect(EXEC, 'the diagnostic must report the ledger sentinel token').toContain('MIGRATION_LEDGER=');
        // One-row drivers used to LEFT JOIN catalogs, so a missing object still
        // produces a row: `FROM (SELECT 1) AS one` or a VALUES list.
        expect(EXEC, 'expected a one-row driver or VALUES list for absence-safe enumeration')
            .toMatch(/FROM\s*\(\s*SELECT\s+1\s*\)\s+AS\s+one/i);
    });
});
