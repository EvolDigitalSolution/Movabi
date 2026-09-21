import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Batch 2B (N12) — single-active-job invariant.
 *
 * STATIC source assertions only. This repository has NO live PostgreSQL test
 * harness: nothing here executes SQL, and NOTHING here proves real concurrency
 * behaviour. What it proves is that the invariant's DEFINITION cannot silently
 * drift - in particular that the frozen occupying-status set is identical in
 * the runtime helper and in the partial-index predicate, that each acquisition
 * RPC integrates the handling, and that no path can report success after the
 * invariant rejects an assignment.
 *
 * The actual race guarantee belongs to the PostgreSQL partial unique index
 * idx_jobs_one_active_per_driver and is deliberately NOT claimed to be tested
 * here. It can only be verified by the read-only production preflight/postflight
 * and by real concurrent load.
 */

const MIGRATION = 'supabase/migrations/20260924000000_driver_single_active_job.sql';
const PREFLIGHT = 'scripts/db/preflight_20260924000000_driver_single_active_job.sql';
const POSTFLIGHT = 'scripts/db/postflight_20260924000000_driver_single_active_job.sql';
const INDEX_STEP = 'scripts/db/reference_only_concurrent_index_20260924000000_driver_single_active_job.sql';
const ROUTE = 'server/routes/booking.routes.ts';
const HYBRID = 'src/app/core/services/marketplace/marketplace-hybrid.service.ts';

/** The FROZEN occupying-status set. Approved; must not silently change. */
const FROZEN_OCCUPYING_STATUSES = [
    'assigned',
    'accepted',
    'fare_agreed',
    'heading_to_pickup',
    'driver_en_route',
    'arrived',
    'driver_arrived',
    'arrived_at_store',
    'shopping_in_progress',
    'collected',
    'picked_up',
    'en_route_to_customer',
    'in_progress',
    'delivered',
    'over_budget_requested',
    'requires_review'
];

/** Terminal / non-occupying history that must stay OUTSIDE the invariant. */
const TERMINAL_EXCLUDED_STATUSES = [
    'completed', 'settled', 'cancelled', 'failed', 'expired', 'no_driver_found'
];

const read = (path: string): string => readFileSync(path, 'utf8');

/** `--` comment lines removed, so assertions target executable text. */
const sqlCode = (path: string): string =>
    read(path).split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

/** Whitespace-free, lower-cased view for formatting-insensitive matching. */
const flat = (text: string): string => text.replace(/\s+/g, '').toLowerCase();

const migrationRaw = read(MIGRATION);
/** Comment-stripped: structural parsing must never see prose that mentions
 *  `CREATE UNIQUE INDEX` or a status name inside a comment. */
const migrationCode = sqlCode(MIGRATION);
const migration = flat(migrationRaw);
const preflightCode = sqlCode(PREFLIGHT);
const postflightCode = sqlCode(POSTFLIGHT);
const preflightRaw = read(PREFLIGHT);
const postflightRaw = read(POSTFLIGHT);
const indexStepRaw = read(INDEX_STEP);
const routeRaw = read(ROUTE);
const hybridRaw = read(HYBRID);

const sorted = (values: Iterable<string>): string[] => Array.from(values).sort();

/** All single-quoted literals inside a text region. */
const quotedLiterals = (region: string): string[] =>
    Array.from(region.matchAll(/'([^']*)'/g)).map(m => m[1]);

const sliceBetween = (source: string, startMarker: string, endMarker: string, label: string): string => {
    const start = source.indexOf(startMarker);
    expect(start, `${label}: start marker not found`).toBeGreaterThan(-1);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(end, `${label}: end marker not found`).toBeGreaterThan(start);
    return source.slice(start, end);
};

/** Extract the status literals of a `CREATE UNIQUE INDEX ... idx_jobs_one_active_per_driver` block. */
const indexPredicateStatuses = (source: string, label: string): Set<string> => {
    const block = sliceBetween(
        source,
        'CREATE UNIQUE INDEX',
        ');',
        `${label}: invariant index block`
    );
    return new Set(quotedLiterals(block));
};

/** Extract the frozen set from the canonical helper's ARRAY literal. */
const helperStatuses = (source: string, label: string): Set<string> => {
    const block = sliceBetween(
        source,
        'CREATE OR REPLACE FUNCTION public.driver_occupying_statuses()',
        '$$;',
        `${label}: driver_occupying_statuses body`
    );
    return new Set(quotedLiterals(block));
};

/** Extract a single function definition from the migration (up to its closing `$$`).
 *  Both terminators occur in this file - `$$;` and `$$ LANGUAGE plpgsql;` - so the
 *  body is delimited by the first dollar-quote PAIR after the CREATE marker. */
const functionBody = (marker: string, label: string): string => {
    const start = migrationCode.indexOf(marker);
    expect(start, `${label}: CREATE marker not found`).toBeGreaterThan(-1);
    const bodyOpen = migrationCode.indexOf('$$', start + marker.length);
    expect(bodyOpen, `${label}: body open not found`).toBeGreaterThan(-1);
    const bodyClose = migrationCode.indexOf('$$', bodyOpen + 2);
    expect(bodyClose, `${label}: body close not found`).toBeGreaterThan(bodyOpen);
    return migrationCode.slice(start, bodyClose);
};

const migrationIndexStatuses = indexPredicateStatuses(migrationCode, 'migration');
const migrationHelperStatuses = helperStatuses(migrationCode, 'migration');
const indexStepStatuses = indexPredicateStatuses(
    indexStepRaw.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n'),
    'index_step'
);

const acceptSearchingBody = functionBody(
    'CREATE OR REPLACE FUNCTION public.accept_searching_job(', 'accept_searching_job');
const assignDriverBody = functionBody(
    'CREATE OR REPLACE FUNCTION public.assign_driver_to_job(', 'assign_driver_to_job');
const acceptAssignedBody = functionBody(
    'CREATE OR REPLACE FUNCTION public.accept_assigned_job(', 'accept_assigned_job');
const acceptFareBody = functionBody(
    'CREATE OR REPLACE FUNCTION public.accept_fare_negotiation(', 'accept_fare_negotiation');
const lockFareBody = functionBody(
    'CREATE OR REPLACE FUNCTION public.lock_marketplace_fare(', 'lock_marketplace_fare');

/** The legacy negotiation accept handler only. */
const legacyHandler = (() => {
    const start = routeRaw.indexOf("router.post('/negotiation/:id/accept'");
    expect(start, 'legacy negotiation accept route not found').toBeGreaterThan(-1);
    const next = routeRaw.indexOf('router.post(', start + 10);
    return next > start ? routeRaw.slice(start, next) : routeRaw.slice(start);
})();
const legacyHandlerFlat = flat(legacyHandler);

describe('N12 frozen occupying-status set', () => {
    it('1. the migration declares the partial UNIQUE invariant', () => {
        expect(migration).toContain('createuniqueindexifnotexistsidx_jobs_one_active_per_driver');
        expect(migration).toContain('unique');
    });

    it('2. the invariant key is exactly jobs(driver_id)', () => {
        expect(migration).toContain('onpublic.jobs(driver_id)');
        expect(migration).toContain('wheredriver_idisnotnull');
    });

    it('3. the index predicate carries EXACTLY the frozen set - no more, no less', () => {
        expect(sorted(migrationIndexStatuses)).toEqual(sorted(FROZEN_OCCUPYING_STATUSES));
    });

    it('4. the canonical helper carries EXACTLY the same frozen set', () => {
        expect(sorted(migrationHelperStatuses)).toEqual(sorted(FROZEN_OCCUPYING_STATUSES));
        // ...and the two representations agree with each other.
        expect(sorted(migrationIndexStatuses)).toEqual(sorted(migrationHelperStatuses));
    });

    it('5. fare_agreed is inside the invariant in both representations', () => {
        expect(migrationIndexStatuses.has('fare_agreed')).toBe(true);
        expect(migrationHelperStatuses.has('fare_agreed')).toBe(true);
    });

    it('6. requires_review is inside the invariant in both representations', () => {
        expect(migrationIndexStatuses.has('requires_review')).toBe(true);
        expect(migrationHelperStatuses.has('requires_review')).toBe(true);
    });

    it('7. no terminal status leaks into the invariant', () => {
        for (const status of TERMINAL_EXCLUDED_STATUSES) {
            expect(migrationIndexStatuses.has(status), `${status} must not be occupying`).toBe(false);
            expect(migrationHelperStatuses.has(status), `${status} must not be occupying`).toBe(false);
        }
        expect(migrationIndexStatuses.has('completed')).toBe(false);
        expect(migrationIndexStatuses.has('cancelled')).toBe(false);
    });

    it('the CONCURRENTLY operator variant carries the identical predicate', () => {
        const concurrently = indexStepRaw.slice(
            indexStepRaw.indexOf('CREATE UNIQUE INDEX CONCURRENTLY')
        );
        expect(concurrently).toContain('CONCURRENTLY');
        expect(sorted(indexStepStatuses)).toEqual(sorted(FROZEN_OCCUPYING_STATUSES));
        // The migration itself must NOT use CONCURRENTLY (it may run inside a
        // transaction); that variant lives only in the operator step.
        expect(migrationCode.slice(migrationCode.indexOf('CREATE UNIQUE INDEX')))
            .not.toContain('CONCURRENTLY');
    });

    it('the invariant is guarded against predicate/helper drift at migration time', () => {
        expect(migration).toContain('frozenstatussetdiverged');
        expect(migration).toContain('idx_jobs_one_active_per_driver exists but is NOT UNIQUE'.toLowerCase().replace(/\s+/g, ''));
        expect(migration).toContain('regexp_matches');
        expect(migration).toContain('crossjoinlateral');
    });

    it('the migration is additive: no DROP FUNCTION, no data rewrite', () => {
        expect(migrationRaw).not.toMatch(/\bDROP\s+FUNCTION\b/i);
        expect(migrationRaw).not.toMatch(/\bDELETE\s+FROM\b/i);
        // Never rewrites, reassigns or repairs existing job rows.
        expect(migrationRaw).not.toMatch(/\bUPDATE\s+public\.jobs\s+SET[\s\S]{0,200}WHERE\s+driver_id\s+IS\s+NOT\s+NULL/i);
    });

    it('no separate is_busy representation was introduced', () => {
        expect(migrationCode).not.toMatch(/\bis_busy\b/i);
        expect(migrationCode).not.toMatch(/\bbusy_status\b/i);
        // is_available must not be repurposed or toggled by this batch.
        expect(migrationCode).not.toMatch(/is_available\s*=\s*(true|false|NOT\s+TRUE)/i);
    });
});

describe('N12 acquisition RPC integration', () => {
    it('9. accept_searching_job pre-checks AND catches the race', () => {
        const body = flat(acceptSearchingBody);
        expect(body).toContain('driver_has_other_active_job');
        expect(body).toContain('unique_violation');
        expect(body).toContain("getstackeddiagnosticsv_constraint=constraint_name");
        expect(body).toContain("v_constraint='idx_jobs_one_active_per_driver'");
        expect(body).toContain("errcode='mb001'");
        // Batch 1 semantics preserved.
        expect(body).toContain('driver_vehicle_can_accept_job');
        expect(body).toContain("statusin('pending','requested','searching','broadcasting','waiting')");
        expect(body).toContain('driver_idisnull');
        expect(body).toContain('accepted_driver_idisnull');
        expect(body).toContain('securitydefiner');
    });

    it('10. assign_driver_to_job catches the invariant violation and preserves assignment semantics', () => {
        const body = flat(assignDriverBody);
        expect(body).toContain('unique_violation');
        expect(body).toContain("v_constraint='idx_jobs_one_active_per_driver'");
        expect(body).toContain("errcode='mb001'");
        // Vehicle compatibility remains mandatory.
        expect(body).toContain('driver_vehicle_can_accept_job');
        // Source statuses unchanged.
        expect(body).toContain("statusin('pending','requested','searching')");
        expect(body).toContain('driver_idisnull');
        // Assignment write unchanged.
        expect(body).toContain('driver_id=p_driver_id');
        expect(body).toContain("status='assigned'");
        expect(body).toContain('updated_at=now()');
        // Boolean / FOUND contract unchanged.
        expect(body).toContain('returnsboolean');
        expect(body).toContain('v_updated:=found');
        expect(body).toContain('returnv_updated');
        // ...and it must NOT acquire the target job's acceptance markers.
        expect(body).not.toContain('accepted_driver_id');
        expect(body).not.toContain('accepted_at');
    });

    it('10b. assign_driver_to_job is SECURITY DEFINER with a pinned search_path', () => {
        // The confirmed privilege defect: as INVOKER it cannot execute its own
        // internal helper, whose EXECUTE is revoked from every client role.
        // SECURITY DEFINER is the fix; widening the helper ACL is not.
        const body = flat(assignDriverBody);
        expect(body).toContain('securitydefiner');
        expect(body).toContain('setsearch_path=public,pg_temp');
        // The DEFINER body must be schema-qualified throughout (no reliance on
        // the caller's search_path).
        expect(body).toContain('public.jobs');
        expect(body).toContain('public.driver_vehicle_can_accept_job(p_job_id,p_driver_id)');
        expect(body).toContain('public.driver_has_other_active_job(p_driver_id,p_job_id)');
        // No dynamic SQL and no caller-controlled identifier interpolation.
        expect(body).not.toContain('executeformat');
        expect(body).not.toContain('execute ');
        expect(body).not.toContain('quote_ident');
        expect(body).not.toContain('quote_literal');
        // No new caller-identity requirement: admin/service assignment semantics
        // must keep working.
        expect(body).not.toContain('auth.uid()');
    });

    it('10c. assign_driver_to_job gets the canonical busy pre-check, excluding its own target job', () => {
        expect(assignDriverBody).toContain('public.driver_has_other_active_job(p_driver_id, p_job_id)');
        // The pre-check is secondary: the index is still the authority, and the
        // unique_violation handler must remain.
        expect(flat(assignDriverBody)).toContain('whenunique_violation');
    });

    it('11. accept_assigned_job never rejects the driver with their OWN target job', () => {
        const body = flat(acceptAssignedBody);
        expect(body).toContain('driver_has_other_active_job');
        // The exclude argument must be the target job, so an idempotent
        // confirmation of J1 cannot fail because J1 is J1.
        expect(body).toContain('driver_has_other_active_job(v_caller,p_job_id)');
        expect(migrationRaw).toContain('driver_has_other_active_job(v_caller, p_job_id)');
        // Batch 1 guards preserved.
        expect(body).toContain("status='assigned'");
        expect(body).toContain('driver_id=v_caller');
        expect(body).toContain('accepted_driver_idisnull');
        expect(body).toContain('securitydefiner');
    });

    it('12. accept_fare_negotiation integrates busy handling and preserves Batch 2A', () => {
        const body = flat(acceptFareBody);
        expect(body).toContain('driver_has_other_active_job');
        expect(body).toContain('unique_violation');
        expect(body).toContain("v_constraint='idx_jobs_one_active_per_driver'");
        // Batch 2A semantics preserved.
        expect(body).toContain('forupdate');
        expect(body).toContain("proposed_by_role='customer'");
        expect(body).toContain("orderbycreated_atdesc,iddesc");
        expect(body).toContain("errcode='23505'");
        expect(body).toContain('jsonb_build_object');
        expect(body).toContain('securitydefiner');
        expect(body).toContain('setsearch_path=public,pg_temp');
    });

    it('13. the unique-violation race path is handled without swallowing unrelated errors', () => {
        for (const [label, body] of [
            ['accept_searching_job', acceptSearchingBody],
            ['assign_driver_to_job', assignDriverBody],
            ['accept_assigned_job', acceptAssignedBody],
            ['accept_fare_negotiation', acceptFareBody],
            ['lock_marketplace_fare', lockFareBody]
        ] as Array<[string, string]>) {
            const flatBody = flat(body);
            expect(flatBody, `${label}: must catch unique_violation`).toContain('whenunique_violation');
            expect(flatBody, `${label}: must identify the constraint`).toContain('constraint_name');
            expect(flatBody, `${label}: must name the index`).toContain('idx_jobs_one_active_per_driver');
            // A non-matching constraint must be re-raised, never re-coded.
            expect(flatBody, `${label}: must re-raise other violations`).toContain('raise;');
        }
    });

    it('the helper status set is never re-typed inside an RPC body', () => {
        for (const [label, body] of [
            ['accept_searching_job', acceptSearchingBody],
            ['assign_driver_to_job', assignDriverBody],
            ['accept_assigned_job', acceptAssignedBody],
            ['accept_fare_negotiation', acceptFareBody]
        ] as Array<[string, string]>) {
            expect(body, `${label} must reach the set through the helper`).not.toContain('requires_review');
            expect(body, `${label} must reach the set through the helper`).not.toContain('over_budget_requested');
        }
    });
});

describe('N12 error propagation to the client', () => {
    it('14. the legacy negotiation endpoint can no longer discard the assignment error', () => {
        expect(legacyHandlerFlat).toContain("const{error:jobupdateerror}=awaitsupabaseadmin");
        expect(legacyHandlerFlat).toContain('if(jobupdateerror)');
        expect(legacyHandlerFlat).toContain('isdriverbusyviolation(jobupdateerror)');
        expect(legacyHandlerFlat).toContain('driver_busy');
        // No false success: the success return must come AFTER the error branch.
        const errorBranch = legacyHandlerFlat.indexOf('if(jobupdateerror)');
        const successReturn = legacyHandlerFlat.indexOf("returnres.json({success:true,negotiation:");
        expect(errorBranch).toBeGreaterThan(-1);
        expect(successReturn).toBeGreaterThan(errorBranch);
        // The ownership write must precede the negotiation write, so a rejected
        // assignment cannot leave a falsely-accepted negotiation behind.
        const jobsWrite = legacyHandlerFlat.indexOf("from('jobs').update(");
        const negotiationWrite = legacyHandlerFlat.indexOf("from('fare_negotiations').update(");
        expect(jobsWrite).toBeGreaterThan(-1);
        expect(negotiationWrite).toBeGreaterThan(jobsWrite);
    });

    it('14b. the busy detector is narrow: unrelated 23505 must not become "driver busy"', () => {
        const helper = routeRaw.slice(routeRaw.indexOf('function isDriverBusyViolation'));
        const helperBody = helper.slice(0, helper.indexOf('\n}') + 2);
        const helperFlat = flat(helperBody);
        expect(helperFlat).toContain("if(candidate.code!=='23505')returnfalse;");
        expect(helperFlat).toContain('idx_jobs_one_active_per_driver');
        expect(helperFlat).toContain("candidate.code==='mb001'");
    });

    it('14c. the Batch 2A driver-accept route maps the dedicated busy SQLSTATE', () => {
        const start = routeRaw.indexOf("router.post('/negotiation/:jobId/driver-accept'");
        expect(start).toBeGreaterThan(-1);
        const next = routeRaw.indexOf('router.post(', start + 10);
        const handler = flat(next > start ? routeRaw.slice(start, next) : routeRaw.slice(start));
        expect(handler).toContain("sqlstate==='mb001'");
        expect(handler).toContain("code:'driver_busy'");
        // The pre-existing 23505 meaning is preserved and NOT reused for busy.
        expect(handler).toContain("sqlstate==='23505'");
        expect(handler).toContain("code:'offer_already_accepted'");
    });

    it('15. the hybrid ownership writer maps the violation and propagates it', () => {
        // The RPC reports the invariant violation deterministically...
        const lockBody = flat(lockFareBody);
        expect(lockBody).toContain('unique_violation');
        expect(lockBody).toContain("v_constraint='idx_jobs_one_active_per_driver'");
        expect(lockBody).toContain("errcode='mb001'");
        // ...and the ownership write is otherwise preserved.
        expect(lockBody).toContain('driver_id=p_driver_id');
        expect(lockBody).toContain("status='fare_agreed'");
        // The client can never turn that failure into a false success.
        const lockFareClient = hybridRaw.slice(hybridRaw.indexOf('async lockFare('));
        const clientBody = lockFareClient.slice(0, lockFareClient.indexOf('\n    }') + 6);
        expect(flat(clientBody)).toContain("if(error)throwerror;");
    });
});

describe('N12 ACL matrices preserved', () => {
    it('16. Batch 1 ACL semantics are preserved', () => {
        expect(migration).toContain(
            flat('GRANT EXECUTE ON FUNCTION public.accept_searching_job(UUID, UUID)\nTO authenticated, service_role;')
        );
        expect(migration).toContain(
            flat('REVOKE EXECUTE ON FUNCTION public.accept_searching_job(UUID, UUID) FROM anon;')
        );
        // accept_assigned_job: authenticated only.
        expect(migration).toContain(
            flat('REVOKE EXECUTE ON FUNCTION public.accept_assigned_job(UUID, UUID)\nFROM anon, service_role;')
        );
        expect(migration).toContain(
            flat('GRANT EXECUTE ON FUNCTION public.accept_assigned_job(UUID, UUID)\nTO authenticated;')
        );
        expect(migration).not.toMatch(
            /grantexecuteonfunctionpublic\.accept_assigned_job\(uuid,uuid\)to(anon|service_role)/
        );
    });

    it('16b. assign_driver_to_job external EXECUTE matrix is unchanged by the DEFINER change', () => {
        expect(migration).toContain(
            flat('REVOKE ALL ON FUNCTION public.assign_driver_to_job(UUID, UUID) FROM PUBLIC;')
        );
        expect(migration).toContain(
            flat('REVOKE ALL ON FUNCTION public.assign_driver_to_job(UUID, UUID) FROM anon;')
        );
        expect(migration).toContain(
            flat('GRANT EXECUTE ON FUNCTION public.assign_driver_to_job(UUID, UUID)\nTO authenticated;')
        );
        expect(migration).toContain(
            flat('GRANT EXECUTE ON FUNCTION public.assign_driver_to_job(UUID, UUID)\nTO service_role;')
        );
        // anon must never be granted; and the DEFINER change must not have
        // widened anything.
        expect(migration).not.toMatch(
            /grantexecuteonfunctionpublic\.assign_driver_to_job\(uuid,uuid\)toanon/
        );
    });

    it('16c. the vehicle helper must stay internal - it may never be granted to a client role', () => {
        // Regression guard against "fixing" the privilege defect by widening the
        // helper instead of making the RPC SECURITY DEFINER.
        expect(migration).toContain(
            flat('REVOKE ALL ON FUNCTION public.driver_vehicle_can_accept_job(UUID, UUID) FROM PUBLIC;')
        );
        expect(migration).toContain(
            flat('REVOKE EXECUTE ON FUNCTION public.driver_vehicle_can_accept_job(UUID, UUID)\nFROM anon, authenticated, service_role;')
        );
        expect(migration).not.toMatch(
            /grant\s+execute\s+on\s+function\s+public\.driver_vehicle_can_accept_job/i
        );
        // The postflight must gate on it too.
        expect(postflightRaw).toContain('INTERNAL HELPER driver_vehicle_can_accept_job not client-executable');
        expect(flat(postflightRaw)).toContain('vehicle_helper_grants');
        expect(flat(postflightRaw)).toContain(
            'no-go:driver_vehicle_can_accept_jobisclient-executable(fixviasecuritydefiner,notbywideninghelperacls)'
        );
    });

    it('17. Batch 2A service-role-only ACL for accept_fare_negotiation is preserved', () => {
        expect(migration).toContain(
            flat('REVOKE ALL ON FUNCTION public.accept_fare_negotiation(UUID, UUID)\nFROM anon, authenticated, service_role;')
        );
        expect(migration).toContain(
            flat('GRANT EXECUTE ON FUNCTION public.accept_fare_negotiation(UUID, UUID)\nTO service_role;')
        );
        expect(migration).not.toMatch(
            /grantexecuteonfunctionpublic\.accept_fare_negotiation\(uuid,uuid\)to(anon|authenticated)/
        );
    });

    it('the N12 predicates are internal: revoked from every role, granted to none', () => {
        for (const sig of [
            'driver_occupying_statuses()',
            'driver_has_other_active_job(UUID, UUID)',
            'driver_has_active_job(UUID)'
        ]) {
            expect(migration).toContain(flat(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`));
            expect(migration).toContain(
                flat(`REVOKE EXECUTE ON FUNCTION public.${sig}\nFROM anon, authenticated, service_role;`)
            );
            expect(migration).not.toMatch(
                new RegExp(`grantexecuteonfunctionpublic\\.${sig.replace(/[().]/g, '\\$&').replace(/, /g, ',')}`, 'i')
            );
        }
    });

    it('the hybrid writer ACL is deliberately untouched', () => {
        expect(migration).not.toMatch(/grant\s+execute\s+on\s+function\s+public\.lock_marketplace_fare/i);
        expect(migration).not.toMatch(/revoke\s+[^;]*on\s+function\s+public\.lock_marketplace_fare/i);
    });
});

describe('N12 operational scripts', () => {
    it('preflight and postflight are read-only and never invoke an assignment RPC', () => {
        // String literals are removed first: a literal is never DDL, and prose
        // such as '... the REVOKE/GRANT matrix ...' or a signature literal must
        // not be mistaken for executable privilege or invocation.
        const withoutStringLiterals = (text: string): string => text.replace(/'(?:[^']|'')*'/g, "''");

        for (const [label, code] of [['preflight', preflightCode], ['postflight', postflightCode]] as Array<[string, string]>) {
            const bare = withoutStringLiterals(code);
            expect(bare, `${label} must contain no DDL`).not.toMatch(
                /\bcreate\s+(table|index|function|or\s+replace|trigger|policy)\b/i
            );
            expect(bare, `${label} must contain no DROP/ALTER`).not.toMatch(/\b(drop|alter)\s+(table|index|function|trigger|policy)\b/i);
            expect(bare, `${label} must contain no DML`).not.toMatch(/\b(insert\s+into|delete\s+from|update\s+public\.|truncate)\b/i);
            expect(bare, `${label} must contain no GRANT/REVOKE`).not.toMatch(/\b(grant|revoke)\s+[a-z]/i);
            // to_regprocedure() references are fine; an actual CALL is not.
            expect(bare, `${label} must not invoke an acquisition RPC`).not.toMatch(
                /\b(select|perform|call)\s+public\.(accept_searching_job|assign_driver_to_job|accept_assigned_job|accept_fare_negotiation)\s*\(/i
            );
            // Positive control: the stripper does not hide a real invocation.
            expect(
                withoutStringLiterals("SELECT public.accept_searching_job('a','b');")
            ).toMatch(/select\s+public\.accept_searching_job\s*\(/i);
        }
    });

    it('the preflight restates the frozen set identically in every occupying CTE', () => {
        const blocks = Array.from(
            preflightRaw.matchAll(/WITH occupying\(status\) AS \(\s*VALUES([\s\S]*?)\n\)/g)
        );
        expect(blocks.length, 'expected several occupying CTEs').toBeGreaterThanOrEqual(5);
        for (const block of blocks) {
            expect(sorted(new Set(quotedLiterals(block[1])))).toEqual(sorted(FROZEN_OCCUPYING_STATUSES));
        }
    });

    it('the preflight reports the required evidence and a GO/NO-GO gate', () => {
        for (const needle of [
            'JOBS total row count',
            'JOBS rows with non-null driver_id',
            'OCCUPYING job row count',
            'DRIVERS with > 1 occupying job',
            'DUPDRIVER',
            'OCCUPYING rows with driver_id NULL',
            "profiles.is_available = true",
            "profiles.is_online = true",
            'STATUS ',
            'INDEX ',
            'INVARIANT idx_jobs_one_active_per_driver state',
            'FUNCTION ',
            'ROLE ',
            'DEFAULT ACL for public schema',
            'GO / NO-GO'
        ]) {
            expect(preflightRaw, `preflight must report ${needle}`).toContain(needle);
        }
        // GO requires zero duplicate occupying drivers.
        expect(flat(preflightRaw)).toContain('no-go:resolveduplicateoccupyingjobs(operatorreview)');
    });

    it('the preflight casts the internal "char" catalog column before concatenation', () => {
        // text || "char" is ambiguous and aborts the whole script (Batch 2A).
        expect(preflightCode).toContain('defaclobjtype::TEXT');
        expect(preflightCode).not.toMatch(/defaclobjtype\s*\|\|/);
    });

    it('the postflight gates on the invariant and the frozen set, and invokes no RPC', () => {
        for (const needle of [
            'idx_jobs_one_active_per_driver',
            'FROZEN SET helper vs index predicate',
            'fare_agreed',
            'requires_review',
            'has_function_privilege',
            'POST-MIGRATION GO / NO-GO',
            'INTERNAL HELPER driver_vehicle_can_accept_job not client-executable'
        ]) {
            expect(postflightRaw, `postflight must check ${needle}`).toContain(needle);
        }
        expect(flat(postflightRaw)).toContain("when(selectis_uniquefrominvariant)isnottrue");
        expect(flat(postflightRaw)).toContain("when(selectis_validfrominvariant)isnottrue");
        // assign_driver_to_job must be gated as DEFINER with a pinned search_path
        // and with both helper calls present.
        expect(postflightRaw).toContain("'%public.driver_has_other_active_job(p_driver_id, p_job_id)%', TRUE");
        expect(postflightRaw).toContain("'%public.driver_vehicle_can_accept_job(p_job_id, p_driver_id)%', TRUE");
        expect(flat(postflightRaw)).toContain("('assign_driver_to_job','public.assign_driver_to_job(uuid,uuid)','boolean',true)");
    });

    it('the index operator step is reference-only and the migration is the deployment artifact', () => {
        expect(indexStepRaw).toContain('NOT THE SELECTED PRODUCTION PATH');
        expect(indexStepRaw).toContain('DO NOT RUN THIS FILE AS PART OF THE BATCH 2B DEPLOYMENT');
        expect(indexStepRaw).toContain('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_one_active_per_driver');
        expect(indexStepRaw).toContain('indisvalid');
        // It must not perform data repair.
        expect(indexStepRaw).not.toMatch(/\bUPDATE\s+public\.jobs\b/i);
        expect(indexStepRaw).not.toMatch(/\bDELETE\s+FROM\b/i);
        // The migration is the authoritative artifact and is transactional.
        expect(migrationCode).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_per_driver');
        expect(migrationRaw).toContain('DECIDED: ordinary transactional CREATE UNIQUE INDEX');
    });
});

/**
 * STRUCTURAL alias/column audit.
 *
 * Resolves BOTH shapes: derived tables with an explicit column list
 * (`) AS a(x, y)`, `(VALUES ...) AS a(x, y)`) AND CTEs with an explicit column
 * list reached through a query alias (`WITH t(x, y) AS (...)` ... `FROM t q`).
 * It then flags every `alias.column` whose alias does not declare that column.
 *
 * This is the defect class that has twice reached production in this project
 * ("column policy.signature does not exist", "column m.literal does not exist"),
 * so it validates the real structure rather than searching for a known typo.
 */
const splitCols = (list: string): string[] =>
    list.split(',').map(c => c.trim().toLowerCase()).filter(Boolean);

/**
 * Split SQL into statements, honouring dollar-quoted function bodies, single
 * quotes, double-quoted identifiers, line comments and block comments. Auditing
 * per statement is required for correctness: the same short alias (p, e, r) is
 * legitimately reused for different relations in different statements, and a
 * file-global alias map would both mask real errors and invent false ones.
 */
const splitStatements = (sql: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let i = 0;
    const n = sql.length;

    while (i < n) {
        if (sql.startsWith('--', i)) {
            const j = sql.indexOf('\n', i);
            i = j === -1 ? n : j;
            continue;
        }
        if (sql.startsWith('/*', i)) {
            let depth = 1;
            i += 2;
            while (i < n && depth > 0) {
                if (sql.startsWith('/*', i)) { depth += 1; i += 2; }
                else if (sql.startsWith('*/', i)) { depth -= 1; i += 2; }
                else i += 1;
            }
            continue;
        }

        const c = sql[i];

        if (c === "'" || c === '"') {
            const quote = c;
            cur += c;
            i += 1;
            while (i < n) {
                if (sql[i] === quote) {
                    if (i + 1 < n && sql[i + 1] === quote) { cur += quote + quote; i += 2; continue; }
                    cur += quote;
                    i += 1;
                    break;
                }
                cur += sql[i];
                i += 1;
            }
            continue;
        }

        if (c === '$') {
            const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
            if (m) {
                const tag = m[0];
                const end = sql.indexOf(tag, i + tag.length);
                if (end === -1) { cur += sql.slice(i); i = n; continue; }
                cur += sql.slice(i, end + tag.length);
                i = end + tag.length;
                continue;
            }
        }

        if (c === ';') {
            out.push(cur);
            cur = '';
            i += 1;
            continue;
        }

        cur += c;
        i += 1;
    }

    if (cur.trim()) out.push(cur);
    return out;
};

/** Alias/column audit for ONE statement. Scope-local by construction: the same
 *  short alias (p, e, r, g) is legitimately reused for different relations in
 *  different statements, so a file-global alias map would invent offenders. */
const auditStatement = (raw: string): { declared: Map<string, Set<string>>; offenders: string[] } => {
    const declared = new Map<string, Set<string>>();
    const offenders: string[] = [];

    const register = (alias: string, cols: Iterable<string>): void => {
        const key = alias.toLowerCase();
        const set = declared.get(key) ?? new Set<string>();
        for (const c of cols) set.add(c);
        declared.set(key, set);
    };

    // 1. CTE column lists: `WITH t(x, y) AS (` and `, t(x, y) AS (`
    const cteColumns = new Map<string, Set<string>>();
    for (const m of raw.matchAll(/(?:\bWITH\b|,)\s*([a-z_][a-z0-9_]*)\s*\(([^)]*)\)\s*AS\s*\(/gis)) {
        cteColumns.set(m[1].toLowerCase(), new Set(splitCols(m[2])));
    }

    // 2. Derived-table column lists: `) AS a(x, y)` / `(VALUES ...) AS a(x, y)`
    for (const m of raw.matchAll(/(?:\)|\bVALUES\b[^;]*?)\s*AS\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gis)) {
        register(m[1], splitCols(m[2]));
    }

    // 3. Bind query aliases to their source so a CTE's declared columns are
    //    known through the alias the query actually references.
    for (const m of raw.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+([a-z_][a-z0-9_]*)\b/gi)) {
        const cols = declared.get(m[1].toLowerCase()) ?? cteColumns.get(m[1].toLowerCase());
        if (cols) register(m[2], cols);
    }

    const ignore = new Set(['public', 'auth', 'pg_catalog', 'information_schema', 'pg_temp']);
    for (const m of raw.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
        const qualifier = m[1].toLowerCase();
        const column = m[2].toLowerCase();
        if (ignore.has(qualifier)) continue;
        const cols = declared.get(qualifier);
        if (!cols) continue;                 // plain table alias: verified by the engine
        if (!cols.has(column)) offenders.push(`${qualifier}.${column}`);
    }

    return { declared, offenders: Array.from(new Set(offenders)) };
};

const aliasDiscipline = (source: string): { declared: Map<string, Set<string>>; offenders: string[] } => {
    const allDeclared = new Map<string, Set<string>>();
    const offenders: string[] = [];

    for (const statement of splitStatements(source)) {
        if (!statement.trim()) continue;
        const result = auditStatement(statement);
        offenders.push(...result.offenders);
        for (const [alias, cols] of result.declared) {
            const set = allDeclared.get(alias) ?? new Set<string>();
            for (const c of cols) set.add(c);
            allDeclared.set(alias, set);
        }
    }

    return { declared: allDeclared, offenders: Array.from(new Set(offenders)) };
};

describe('N12 alias/column discipline (structural)', () => {
    it('the audit is not vacuous: it detects a mis-attributed qualifier', () => {
        const fixture = [
            'WITH t(x, y) AS (VALUES (1, 2))',
            'SELECT q.x, q.z FROM t q;'
        ].join('\n');
        expect(aliasDiscipline(fixture).offenders).toEqual(['q.z']);

        const good = ['WITH t(x, y) AS (VALUES (1, 2))', 'SELECT q.x, q.y FROM t q;'].join('\n');
        expect(aliasDiscipline(good).offenders).toEqual([]);

        const derived = ') AS m(match)\nSELECT m.literal FROM jsc;';
        expect(aliasDiscipline(derived).offenders).toEqual(['m.literal']);
    });

    it('every new SQL artifact is free of alias/column mis-attribution', () => {
        for (const [label, path] of [
            ['migration', MIGRATION],
            ['preflight', PREFLIGHT],
            ['postflight', POSTFLIGHT],
            ['index_step', INDEX_STEP]
        ] as Array<[string, string]>) {
            const { offenders } = aliasDiscipline(read(path));
            expect(offenders, `${label} alias does not declare the referenced column`).toEqual([]);
        }
    });

    it('the postflight really does declare the columns it references through aliases', () => {
        const { declared } = aliasDiscipline(postflightRaw);
        // Positive controls: these are the aliases the audit actually resolved.
        expect(declared.get('e')).toEqual(new Set(['fn', 'sig', 'rettype', 'definer']));
        expect(declared.get('p') ?? declared.get('policy')).toBeTruthy();
    });

    it('no internal "char" catalog column is concatenated without an explicit cast', () => {
        const CHAR_CATALOG_COLUMNS = [
            'defaclobjtype', 'prokind', 'provolatile', 'proparallel',
            'relkind', 'relpersistence', 'relreplident',
            'contype', 'typtype', 'typcategory', 'oprkind', 'amtype',
            'tgenabled', 'ev_type', 'ev_enabled',
            'attidentity', 'attgenerated',
            'deptype', 'polcmd', 'privtype', 'substream'
        ];
        const uncastCharConcat = (text: string): string[] => {
            const stripped = text.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
            const offenders: string[] = [];
            const re = new RegExp(
                `\\b([A-Za-z_][A-Za-z0-9_]*)\\.(${CHAR_CATALOG_COLUMNS.join('|')})\\b`, 'gi');
            for (const m of stripped.matchAll(re)) {
                const at = m.index ?? 0;
                const after = stripped.slice(at + m[0].length);
                if (/^\s*::\s*(?:text|varchar|character\s+varying)\b/i.test(after)) continue;
                const before = stripped.slice(0, at);
                if (/^\s*\|\|/.test(after) || /\|\|\s*$/.test(before)) {
                    offenders.push(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
                }
            }
            return Array.from(new Set(offenders));
        };

        // Self-check the detector against the real Batch 2A production defect.
        expect(uncastCharConcat("'r' || d.defaclobjtype")).toEqual(['d.defaclobjtype']);
        expect(uncastCharConcat("'r' || d.defaclobjtype::text")).toEqual([]);

        for (const [label, path] of [
            ['preflight', PREFLIGHT],
            ['postflight', POSTFLIGHT],
            ['index_step', INDEX_STEP]
        ] as Array<[string, string]>) {
            expect(uncastCharConcat(read(path)), `${label} uncast internal "char" concatenation`).toEqual([]);
        }
    });
});

describe('N12 assertion self-checks (the guards are not vacuous)', () => {    it('the status-set parser detects a removed critical status', () => {
        // Fixture: the frozen set with fare_agreed deliberately removed, in both
        // representations. The real assertions above compare against
        // FROZEN_OCCUPYING_STATUSES, so this shape MUST fail them.
        const withoutFareAgreed = FROZEN_OCCUPYING_STATUSES.filter(s => s !== 'fare_agreed');

        const fixture = [
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_per_driver',
            '    ON public.jobs (driver_id)',
            ' WHERE driver_id IS NOT NULL',
            "   AND status IN (",
            withoutFareAgreed.map(s => `        '${s}'`).join(',\n'),
            '   );',
            '',
            'CREATE OR REPLACE FUNCTION public.driver_occupying_statuses()',
            'RETURNS TEXT[]',
            'AS $$',
            '    SELECT ARRAY[',
            withoutFareAgreed.map(s => `        '${s}'`).join(',\n'),
            '    ]::TEXT[];',
            '$$;'
        ].join('\n');

        const fixtureIndex = indexPredicateStatuses(fixture, 'fixture');
        const fixtureHelper = helperStatuses(fixture, 'fixture');

        expect(fixtureIndex.has('fare_agreed')).toBe(false);
        expect(fixtureHelper.has('fare_agreed')).toBe(false);
        // Exactly what assertion 3/4 would reject.
        expect(sorted(fixtureIndex)).not.toEqual(sorted(FROZEN_OCCUPYING_STATUSES));
        expect(sorted(fixtureHelper)).not.toEqual(sorted(FROZEN_OCCUPYING_STATUSES));
        // ...and the parser is not simply returning everything or nothing.
        expect(fixtureIndex.size).toBe(FROZEN_OCCUPYING_STATUSES.length - 1);
        expect(sorted(migrationIndexStatuses)).toEqual(sorted(FROZEN_OCCUPYING_STATUSES));
    });

    it('the status-set parser detects an extra status leaking into the invariant', () => {
        const withTerminal = [...FROZEN_OCCUPYING_STATUSES, 'completed'];
        const fixture = [
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_per_driver',
            '    ON public.jobs (driver_id)',
            withTerminal.map(s => `        '${s}'`).join(',\n'),
            ');'
        ].join('\n');

        const fixtureIndex = indexPredicateStatuses(fixture, 'fixture');
        expect(fixtureIndex.has('completed')).toBe(true);
        expect(sorted(fixtureIndex)).not.toEqual(sorted(FROZEN_OCCUPYING_STATUSES));
    });
});
