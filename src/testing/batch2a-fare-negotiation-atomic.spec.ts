import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Batch 2A regression tests — N35 atomic fare-negotiation acceptance.
 *
 * STATIC source assertions only. There is no PostgreSQL or HTTP runtime in this
 * workspace, so NOTHING here proves real concurrency behaviour. What it proves
 * is that the two defects that made this path non-atomic cannot quietly return:
 *
 *   1. the route performed SELECT -> UPDATE fare_negotiations -> UPDATE jobs
 *      with no lock, no status predicate and no ownership predicate, so two
 *      concurrent drivers could both win;
 *   2. ownership was written by an unconditional UPDATE after the read, which
 *      could overwrite a rival's committed claim.
 *
 * Actual FOR UPDATE serialisation belongs to the RPC contract in
 * supabase/migrations/20260923000000_accept_fare_negotiation_atomic.sql and is
 * deliberately not claimed to be tested here.
 */

const MIGRATION = 'supabase/migrations/20260923000000_accept_fare_negotiation_atomic.sql';
const PREFLIGHT = 'scripts/db/preflight_20260923000000_accept_fare_negotiation_atomic.sql';
const ROUTE = 'server/routes/booking.routes.ts';
const POSTFLIGHT = 'scripts/db/postflight_20260923000000_accept_fare_negotiation_atomic.sql';
const PRICING_SERVICE = 'server/services/pricing.service.ts';

/** Whitespace-free, comment-stripped view for formatting-insensitive matching. */
const flatCode = (path: string): string =>
    readFileSync(path, 'utf8')
        .split('\n')
        .filter(line => !line.trimStart().startsWith('--'))
        .join('\n')
        .toLowerCase()
        .replace(/\s+/g, '');

const migration = flatCode(MIGRATION);
const postflight = flatCode(POSTFLIGHT);
const routeRaw = readFileSync(ROUTE, 'utf8');

/** Extract only the driver-accept route handler body. */
const routeHandler = (() => {
    const start = routeRaw.indexOf("router.post('/negotiation/:jobId/driver-accept'");
    expect(start, 'driver-accept route not found').toBeGreaterThan(-1);
    const next = routeRaw.indexOf('router.post(', start + 10);
    return next > start ? routeRaw.slice(start, next) : routeRaw.slice(start);
})();

const routeHandlerFlat = routeHandler.replace(/\s+/g, '').toLowerCase();

/** SQL with `--` comment lines removed: assertions target executable text only. */
const sqlCode = (path: string): string =>
    readFileSync(path, 'utf8')
        .split('\n')
        .filter(line => !line.trimStart().startsWith('--'))
        .join('\n');

/**
 * STRUCTURAL alias-discipline audit.
 *
 * Collects every derived table that declares an explicit column list
 * (`) AS a(x, y)` or `(VALUES ...) AS a(x, y)`) and every `alias.column`
 * reference whose alias does not declare that column.
 *
 * This validates the real shape of the SQL rather than searching for one
 * hard-coded typo, so it catches the entire defect class: a qualifier's
 * declared column list must contain every column referenced through it.
 * (Production has twice been broken by this exact class - a shipped
 * `column policy.signature does not exist` and `column m.literal does not
 * exist` - because a set-returning function's alias exposes only the columns
 * its declaration lists.)
 */
const aliasDiscipline = (raw: string): { declared: Map<string, Set<string>>; offenders: string[] } => {
    const declared = new Map<string, Set<string>>();
    for (const m of raw.matchAll(/(?:\)|\bVALUES\b[^;]*?)\s*AS\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gis)) {
        const alias = m[1].toLowerCase();
        const cols = m[2].split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
        const existing = declared.get(alias);
        if (existing) for (const c of cols) existing.add(c);
        else declared.set(alias, new Set(cols));
    }

    const ignore = new Set(['public', 'auth', 'pg_catalog', 'information_schema']);
    const offenders: string[] = [];
    for (const m of raw.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
        const qualifier = m[1].toLowerCase();
        const column = m[2].toLowerCase();
        if (ignore.has(qualifier)) continue;
        const cols = declared.get(qualifier);
        if (!cols) continue;             // plain table alias: verified by the engine
        if (!cols.has(column)) offenders.push(`${qualifier}.${column}`);
    }

    return { declared, offenders: Array.from(new Set(offenders)) };
};

describe('N35 migration: accept_fare_negotiation contract', () => {
    it('1. defines the exact signature and jsonb return', () => {
        expect(migration).toContain('createorreplacefunctionpublic.accept_fare_negotiation(');
        expect(migration).toContain('p_job_iduuid,');
        expect(migration).toContain('p_driver_iduuid');
        expect(migration).toContain('returnsjsonb');
    });

    it('2. locks the jobs row FOR UPDATE', () => {
        expect(migration).toMatch(/frompublic\.jobswhereid=p_job_idforupdate/);
    });

    it('3. locks the selected fare_negotiations row FOR UPDATE', () => {
        expect(migration).toMatch(/frompublic\.fare_negotiations.*forupdate/);
    });

    it('4. requires a CUSTOMER offer', () => {
        expect(migration).toContain("proposed_by_role='customer'");
    });

    it('5. requires pending status', () => {
        expect(migration).toContain("status='pending'");
    });

    it('6. establishes driver ownership inside the RPC', () => {
        expect(migration).toContain('driver_id=p_driver_id');
    });

    it('7. establishes fare_agreed state inside the RPC', () => {
        expect(migration).toContain("status='fare_agreed'");
    });

    it('8. marks the selected negotiation accepted inside the RPC', () => {
        expect(migration).toContain("status='accepted'");
    });

    it('9. pins search_path to public, pg_temp', () => {
        expect(migration).toContain('setsearch_path=public,pg_temp');
    });

    it('10. revokes every role explicitly, then grants only service_role', () => {
        for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
            expect(migration, `missing REVOKE from ${role}`).toContain(
                `revokeallonfunctionpublic.accept_fare_negotiation(uuid,uuid)from${role}`
            );
        }
        expect(migration).toContain('grantexecuteonfunctionpublic.accept_fare_negotiation(uuid,uuid)toservice_role');
        // No authenticated/anon grant anywhere.
        expect(migration).not.toMatch(/grantexecuteonfunctionpublic\.accept_fare_negotiation\(uuid,uuid\)to(anon|authenticated)/);
    });

    it('rejects already-owned jobs and keeps a deterministic offer selection', () => {
        expect(migration).toContain('alreadyownedbyanotherdriver');
        expect(migration).toContain('orderbycreated_atdesc,iddesc');
    });

    it('performs no data migration (no UPDATE over pre-existing rows outside the function)', () => {
        // The only UPDATE statements must live inside the function body.
        const outsideFunction = readFileSync(MIGRATION, 'utf8')
            .split('$$')[0]
            .replace(/--.*$/gm, '');
        expect(outsideFunction).not.toMatch(/\bUPDATE\s+public\./i);
        expect(outsideFunction).not.toMatch(/\bDELETE\s+FROM\b/i);
        expect(outsideFunction).not.toMatch(/\bINSERT\s+INTO\b/i);
    });
});

describe('N35 route: adapter around the atomic RPC', () => {
    it('11. driver identity comes from getAuthUserId(req)', () => {
        expect(routeHandlerFlat).toContain('constuserid=awaitgetauthuserid(req)');
    });

    it('12. calls accept_fare_negotiation', () => {
        expect(routeHandlerFlat).toContain("rpc('accept_fare_negotiation'");
        expect(routeHandlerFlat).toContain('p_job_id:jobid');
        expect(routeHandlerFlat).toContain('p_driver_id:userid');
    });

    it('13. no longer marks fare_negotiations accepted itself', () => {
        expect(routeHandler).not.toMatch(/from\('fare_negotiations'\)/);
        expect(routeHandlerFlat).not.toContain("status:'accepted',updated_at");
    });

    it('14. no longer writes jobs.driver_id itself', () => {
        // The only driver_id passed is the RPC ARGUMENT p_driver_id. There must
        // be no `.update({ ... driver_id: ... })` anywhere in this handler.
        expect(routeHandler).not.toMatch(/\.update\(\{[^}]*driver_id:/);
        // No direct jobs write that sets ownership at all.
        expect(routeHandlerFlat).not.toMatch(/from\('jobs'\)\.update\(\{[^}]*driver_id/);
        // The RPC argument is present and correctly named (positive control).
        expect(routeHandlerFlat).toContain('p_driver_id:userid');
    });

    it('15. notifies only after the RPC succeeded (no notify on the error paths)', () => {
        const rpcCall = routeHandlerFlat.indexOf("rpc('accept_fare_negotiation'");
        const notify = routeHandlerFlat.indexOf('notifyjobstatusupdate');
        expect(rpcCall).toBeGreaterThan(-1);
        expect(notify).toBeGreaterThan(rpcCall);
        // Every early return before the notify must be an error return.
        const between = routeHandlerFlat.slice(rpcCall, notify);
        const returns = between.match(/returnres\.status\(\d+\)/g) ?? [];
        // All intermediate returns are non-2xx error responses.
        for (const r of returns) {
            expect(r, `unexpected success return before notify: ${r}`).not.toMatch(/returnres\.status\(2/);
        }
    });

    it('16. maps lost/stale ownership to 409', () => {
        expect(routeHandlerFlat).toContain("sqlstate==='23505'");
        expect(routeHandlerFlat).toContain('returnres.status(409)');
        expect(routeHandlerFlat).toContain('offer_already_accepted');
    });

    it('maps not-found and bad-request deterministically without leaking SQL internals', () => {
        expect(routeHandlerFlat).toContain("sqlstate==='p0002'");
        expect(routeHandlerFlat).toContain('returnres.status(404)');
        expect(routeHandlerFlat).toContain("sqlstate==='22023'");
        expect(routeHandlerFlat).toContain('returnres.status(400)');
        // Unexpected failures must not echo the raw DB message.
        expect(routeHandlerFlat).toContain("returnres.status(500).json({error:'failedtoacceptoffer'})");
    });

    it('pricing refresh after the RPC is ownership-guarded and cannot undo the win', () => {
        // The guarded update must carry both ownership and status predicates.
        expect(routeHandlerFlat).toContain(".eq('driver_id',userid)");
        expect(routeHandlerFlat).toContain(".eq('status','fare_agreed')");
        // And a pricing failure must never convert a committed win into an error.
        const pricingBlock = routeHandlerFlat.slice(routeHandlerFlat.indexOf('applyagreedfare'));
        expect(pricingBlock).not.toMatch(/returnres\.status\(5\d\d\)[\s\S]{0,80}error:'failedtoacceptoffer'/);
    });
});

describe('preflight: alias discipline (structural)', () => {
    it('every derived-table alias declares every column referenced through it', () => {
        const { declared, offenders } = aliasDiscipline(sqlCode(PREFLIGHT));

        expect(offenders, 'alias does not declare the referenced column').toEqual([]);

        // Pin the real structure of the constraint-literal extraction.
        //
        // regexp_matches(text, pattern, 'g') is a set-returning function exposing
        // exactly ONE column, of type text[] (one row per match, one array
        // element per capture group). Its alias must therefore declare exactly
        // `match`, and the capture group can only be addressed as m.match[1].
        expect(declared.get('m')).toEqual(new Set(['match']));

        // ...and the CTE must PROJECT that capture group into a column named
        // `literal`, because the outer query reads a.literal / v.literal. Without
        // the explicit projection the CTE exposes `match` and every `a.literal`
        // reference becomes an invalid column reference.
        expect(sqlCode(PREFLIGHT)).toMatch(/m\.match\s*\[\s*1\s*\]\s+AS\s+literal/i);
    });
});

describe('postflight: alias discipline and effective-privilege gate', () => {
    it('every derived-table alias declares every column referenced through it', () => {
        const { declared, offenders } = aliasDiscipline(sqlCode(POSTFLIGHT));

        expect(offenders, 'alias does not declare the referenced column').toEqual([]);
        // The alias must genuinely declare the column referenced through it.
        expect(declared.get('policy')).toContain('signature');
        // And no MIS-ATTRIBUTION may exist in executable SQL: a qualifier.column
        // where that qualifier does not declare the column is caught above by
        // `offenders`. (The string "policy.signature" legitimately appears in this
        // file's comments as the write-up of the previous production defect, so
        // it is deliberately not asserted against the comment text.)
    });

    it('gates on effective privilege and cannot pass with a PUBLIC grant', () => {
        expect(postflight).toContain('has_function_privilege');
        expect(postflight).toContain("fromacl_violations)>0then'no-go'");
        expect(postflight).toContain("frompublic_grants)>0then'no-go'");
    });

    it('never invokes the state-changing RPC', () => {
        // The postflight must only introspect; it must not CALL the function.
        expect(postflight).not.toMatch(/selectpublic\.accept_fare_negotiation\(/);
        expect(postflight).not.toMatch(/performpublic\.accept_fare_negotiation\(/);
    });
});

// ============================================================================
// Pricing correction: PricingService.applyAgreedFare is a jobs PERSISTENCE
// payload, not a DTO.
//
// Production inspection proved public.jobs has NO app_confirmed_price,
// frontend_total_price or regional_price column - those are jobs.metadata keys
// written by BookingService.createBooking. applyAgreedFare used to emit all
// three at top level, so every `.from('jobs').update({ ...applyAgreedFare() })`
// was rejected as a WHOLE (unknown column) and the negotiated pricing refresh
// silently never applied.
//
// These assertions are SCOPED to the applyAgreedFare method and to its returned
// object literal. The three names are legitimate elsewhere (as jobs.metadata
// keys and in the booking payload), so nothing here forbids them
// repository-wide.
// ============================================================================

const pricingServiceSource = readFileSync(PRICING_SERVICE, 'utf8');

/** The applyAgreedFare method ONLY (not the rest of pricing.service.ts). */
const applyAgreedFareBody = (() => {
    const start = pricingServiceSource.indexOf('static applyAgreedFare(');
    expect(start, 'PricingService.applyAgreedFare not found').toBeGreaterThan(-1);
    const end = pricingServiceSource.indexOf('\n    }', start);
    expect(end, 'applyAgreedFare method terminator not found').toBeGreaterThan(start);
    return pricingServiceSource.slice(start, end);
})();

/** The returned jobs-persistence object literal ONLY. */
const applyAgreedFareReturn = (() => {
    const start = applyAgreedFareBody.lastIndexOf('return {');
    expect(start, 'applyAgreedFare return object not found').toBeGreaterThan(-1);
    return applyAgreedFareBody.slice(start);
})();

/** Top-level property names of the returned persistence object. */
const persistedFareKeys = Array.from(
    applyAgreedFareReturn.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)
).map(m => m[1].toLowerCase());

/** The ten pricing columns production confirms on public.jobs. */
const CANONICAL_JOB_FARE_COLUMNS = [
    'price', 'total_price', 'estimated_price', 'platform_fee', 'driver_payout',
    'tax_amount', 'base_fare_used', 'price_per_km_used', 'commission_rate_used',
    'fare_breakdown'
];

describe('pricing correction: applyAgreedFare persists only canonical jobs columns', () => {
    it('extraction is scoped to applyAgreedFare and located its return object', () => {
        // Positive controls: proves the scoped slice really is this method, so a
        // mis-sliced empty region cannot make the assertions below pass vacuously.
        expect(applyAgreedFareBody).toContain('const safeAgreed');
        expect(applyAgreedFareBody).toContain('const scaledBreakdown');
        expect(applyAgreedFareReturn.startsWith('return {')).toBe(true);
        expect(persistedFareKeys.length).toBeGreaterThanOrEqual(CANONICAL_JOB_FARE_COLUMNS.length);
    });

    it('does not return the three metadata-only concepts as top-level jobs fields', () => {
        for (const phantom of ['app_confirmed_price', 'frontend_total_price', 'regional_price']) {
            expect(persistedFareKeys, `${phantom} must not be a jobs persistence key`).not.toContain(phantom);
            // Also assert textual absence from the returned literal, so a computed
            // key (e.g. `['regional_price']: x`) cannot slip past the key parser.
            expect(applyAgreedFareReturn).not.toMatch(new RegExp(`['"]?${phantom}['"]?\\s*:`));
        }
        // Positive control: the scoped return object does mention the canonical
        // `price` family, so an empty slice cannot satisfy this test.
        expect(persistedFareKeys).toContain('price');
    });

    it('retains the ten production-confirmed canonical pricing columns', () => {
        expect(persistedFareKeys).toEqual(expect.arrayContaining(CANONICAL_JOB_FARE_COLUMNS));
    });

    it('contains no key that is not a canonical jobs column', () => {
        const unexpected = persistedFareKeys.filter(k => !CANONICAL_JOB_FARE_COLUMNS.includes(k));
        expect(unexpected, 'a non-column key rejects the whole jobs UPDATE').toEqual([]);
    });
});
