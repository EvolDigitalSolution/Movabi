/**
 * BATCH 2C / PHASE C1 — SCHEMA LINEAGE & RELEASE INTEGRITY GUARD.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Phase C0 established that the repository could not describe the database that
 * production actually depends on:
 *   * three migration-shaped files sat in `supabase/migrations/` but were
 *     GITIGNORED and never committed, because `.gitignore:66` is `*.sql`;
 *   * those files are the ONLY place that defines `jobs.negotiation_mode_enabled`,
 *     `jobs.bid_mode_enabled`, `jobs.marketplace_flags`, `jobs.estimated_duration`
 *     and the `pricing_config` shop/multiplier columns — all of which committed
 *     server code reads and committed migrations guard on;
 *   * six settlement columns written by committed code
 *     (`stripe_transfer_id`, `stripe_transfer_status`, `transferred_at`,
 *     `completed_at`, `refund_id`, `cancellation_fee`) have no tracked definition
 *     at all.
 *
 * A `.gitignore` that hides an entire class of release-critical file is a trap
 * that has now fired twice in this repository (the API startup outage and this
 * lineage gap). The fix is not more care — it is an executable check.
 *
 * WHAT IS GUARDED
 *   A. every migration-shaped file in `supabase/migrations/` is TRACKED.
 *   B. no committed spec hard-depends on a file that is untracked or absent.
 *   C. every release-critical column referenced by committed code has a tracked
 *      ADD COLUMN declaration somewhere in the repository.
 *
 * WHAT IS DELIBERATELY *NOT* GUARDED
 *   * Scratch/manual SQL outside `supabase/migrations/` (root `*.sql`, `scripts/`,
 *     `server/*.txt`) is NOT required to be tracked-enumerated, and new ad-hoc
 *     files there will not fail this guard. Only migration-shaped lineage is
 *     protected, so legitimate local SQL is not rejected.
 *   * `existsSync('<path>')`-style NEGATIVE assertions are excluded from B. This
 *     is required, not cosmetic: `batch2c-phase-b-transition.spec.ts:484`
 *     legitimately asserts that a Phase B migration does NOT exist.
 *
 * IMPLEMENTATION NOTES
 *   * "Tracked" is answered by `git ls-files`, which is authoritative. The child
 *     process writes to a FILE rather than a pipe, so the guard behaves the same
 *     under a confined sandbox (where Node's piped-stdio spawn is denied) and in
 *     CI.
 *   * If git cannot be executed this test FAILS LOUDLY rather than skipping:
 *     a guard that silently passes when it cannot see the repository is worse
 *     than no guard.
 *   * The production startup guard in `batch2c-api-startup-compile.spec.ts` is
 *     untouched and still applies.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const MIGRATIONS_DIR = 'supabase/migrations';

/**
 * Release-critical columns that committed server code reads or writes, each with
 * the tracked declaration this guard requires. Narrow by design: adding a column
 * here is a deliberate statement that losing its lineage would break a release.
 */
const RELEASE_CRITICAL_COLUMNS: ReadonlyArray<{ object: string; column: string; why: string }> = [
    { object: 'public.jobs', column: 'negotiation_mode_enabled', why: 'gates every negotiation route (booking.routes.ts:1333,1524,1632)' },
    { object: 'public.jobs', column: 'bid_mode_enabled', why: 'written at booking create and create-intent' },
    { object: 'public.jobs', column: 'marketplace_flags', why: 'recorded marketplace decision snapshot' },
    { object: 'public.jobs', column: 'negotiated_fare', why: 'read by accept_fare_negotiation / accept_driver_offer' },
    { object: 'public.jobs', column: 'fare_breakdown', why: 'commission source at completion (logistics.service.ts:230)' },
    { object: 'public.jobs', column: 'estimated_duration', why: 'written by the customer booking path' },
    { object: 'public.pricing_config', column: 'free_included_items', why: 'errand item pricing (pricing.service.ts:182-192)' },
    { object: 'public.pricing_config', column: 'extra_item_fee', why: 'errand item pricing (pricing.service.ts:182-192)' },
    { object: 'public.pricing_config', column: 'large_shopping_surcharge', why: 'errand large-shop surcharge' },
    { object: 'public.pricing_config', column: 'large_shopping_threshold', why: 'errand large-shop threshold' },
    { object: 'public.pricing_config', column: 'peak_multiplier', why: 'available to the pricing pipeline' },
    { object: 'public.pricing_config', column: 'weather_multiplier', why: 'available to the pricing pipeline' }
];

let trackedCache: Set<string> | null = null;

/** Authoritative tracked-file set. Throws (never skips) when git is unavailable. */
function trackedFiles(): Set<string> {
    if (trackedCache) return trackedCache;
    const outFile = join(tmpdir(), `movabi-lineage-guard-${process.pid}-${Date.now()}.txt`);
    const fd = openSync(outFile, 'w');
    let result;
    try {
        result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, stdio: ['ignore', fd, 'ignore'] });
    } finally {
        closeSync(fd);
    }
    let raw = '';
    try {
        raw = readFileSync(outFile, 'utf8');
    } finally {
        unlinkSync(outFile);
    }
    if (result.status !== 0) {
        throw new Error(
            `git ls-files failed (status=${result.status}, error=${result.error ? String(result.error) : 'none'}). `
            + 'The schema-lineage guard requires git and must not silently pass.'
        );
    }
    trackedCache = new Set(raw.split('\0').filter(Boolean).map(entry => entry.replace(/\\/g, '/')));
    return trackedCache;
}

function walk(dir: string, accept: (name: string) => boolean): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full, accept));
        else if (accept(entry)) out.push(full);
    }
    return out;
}

const readText = (relative: string): string => readFileSync(resolve(ROOT, relative), 'utf8');

describe('PHASE C1 — schema lineage & release integrity', () => {
    it('A. every migration-shaped file in supabase/migrations is tracked by git', () => {
        const tracked = trackedFiles();
        const onDisk = readdirSync(resolve(ROOT, MIGRATIONS_DIR))
            .filter(name => name.endsWith('.sql'))
            .sort();
        expect(onDisk.length, `${MIGRATIONS_DIR} must contain migrations`).toBeGreaterThan(0);

        const untracked = onDisk.filter(name => !tracked.has(`${MIGRATIONS_DIR}/${name}`));
        expect(
            untracked,
            'These migration files exist in the working tree but are NOT in git. '
            + '`*.sql` is gitignored (.gitignore:66), so they require an explicit force-add: '
            + `git add -f ${untracked.map(n => `${MIGRATIONS_DIR}/${n}`).join(' ')}`
        ).toEqual([]);
    });

    it('B. no committed spec hard-depends on an untracked or absent file', () => {
        const tracked = trackedFiles();
        const specFiles = walk(resolve(ROOT, 'src'), name => name.endsWith('.spec.ts'));
        expect(specFiles.length, 'expected committed specs to exist').toBeGreaterThan(0);

        const pathLiteral = /['"`]((?:supabase\/migrations|scripts\/db)\/[0-9A-Za-z_.-]+\.sql)['"`]/g;
        const missing: string[] = [];
        const untrackedRefs: string[] = [];

        for (const file of specFiles) {
            const relative = file.replace(resolve(ROOT), '').replace(/\\/g, '/').replace(/^\//, '');
            const lines = readText(relative).split(/\r?\n/);
            lines.forEach((line, index) => {
                // A negative existence probe is a legitimate assertion that a file
                // must NOT exist (e.g. the Phase B migration assertion). Excluded.
                if (line.includes('existsSync(')) return;
                for (const match of line.matchAll(pathLiteral)) {
                    const referenced = match[1];
                    const where = `${relative}:${index + 1}`;
                    if (!existsSync(resolve(ROOT, referenced))) missing.push(`${where} -> ${referenced}`);
                    else if (!tracked.has(referenced)) untrackedRefs.push(`${where} -> ${referenced}`);
                }
            });
        }

        expect(missing, 'committed specs must not read paths that do not exist').toEqual([]);
        expect(
            untrackedRefs,
            'committed specs must not depend on files that are absent from git '
            + '(force-add them, or stop depending on them)'
        ).toEqual([]);
    });

    it('C. every release-critical column has tracked MIGRATION lineage in the repository', () => {
        const tracked = trackedFiles();
        // Lineage means a file in supabase/migrations. A tracked .txt "reference
        // schema" copy under server/ is documentation, NOT lineage: no tooling
        // applies it, and server/marketplace-engine-migration.txt says so itself
        // ("REFERENCE SCHEMA ONLY ... Do not execute on production"). Likewise the
        // root-level supabase_incremental_schema_reconcile.sql is a tracked
        // baseline dump stored OUTSIDE the migrations directory, so nothing
        // applies it either. Requiring supabase/migrations keeps this check
        // honest about what the repository can actually reproduce.
        const corpus = [...tracked]
            .filter(path => path.startsWith(`${MIGRATIONS_DIR}/`) && path.endsWith('.sql'))
            .filter(path => existsSync(resolve(ROOT, path)));

        expect(corpus.length, 'expected tracked migrations').toBeGreaterThan(0);

        const unresolved: string[] = [];
        for (const { object, column, why } of RELEASE_CRITICAL_COLUMNS) {
            const declaration = new RegExp(
                `ADD\\s+COLUMN\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
                'i'
            );
            const declaredBy = corpus.filter(path => declaration.test(readText(path)));
            if (declaredBy.length === 0) {
                unresolved.push(`${object}.${column} (${why})`);
            }
        }

        expect(
            unresolved,
            'These columns are required by committed code but no TRACKED MIGRATION declares them. '
            + 'The repository therefore cannot reproduce the database it depends on. '
            + 'Fix by force-adding the migration that declares them (git add -f ...).'
        ).toEqual([]);
    });
});
