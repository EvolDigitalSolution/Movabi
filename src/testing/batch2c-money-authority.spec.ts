/**
 * PHASE C2 — MONEY AUTHORITY REGRESSION GUARD.
 *
 * These are STRUCTURAL assertions over the exact authority boundaries that C2
 * corrected. The repository has no live database harness, so each test pins the
 * source text that closes a proven client-authority hole: it fails if the hole
 * is re-opened (the "absence" assertions) or the fix is removed (the "presence"
 * assertions). They do not execute HTTP or SQL.
 *
 * Covered boundaries:
 *   create-intent amount is server-derived (no req.body.amount fallback, no
 *   client fare_breakdown/marketplace_flags/negotiation_mode re-write);
 *   refund requires an authenticated admin and a server-derived intent/amount;
 *   logistics enqueue requires auth + job ownership + a paid job;
 *   the Stripe payment webhook is reachable, idempotent via stripe_events, and
 *   advances only an unpaid, unowned job;
 *   completion payout uses the same agreed_fare-first basis as the charge;
 *   completion short-circuits only on a SETTLED (status='paid') earnings row.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const PAYMENT = read('server/routes/payment.routes.ts');
const LOGISTICS_ROUTE = read('server/routes/logistics.routes.ts');
const LOGISTICS_SERVICE = read('server/services/logistics.service.ts');
const WEBHOOK = read('server/routes/stripe-webhook.routes.ts');

describe('PHASE C2 — customer checkout, payment & money authority', () => {
    it('1. create-intent amount is server-derived: no client amount fallback', () => {
        expect(PAYMENT).not.toContain('money(req.body.amount)');
        expect(PAYMENT).toContain('PaymentAuthorityService.resolve(job)');
    });

    it('2. create-intent does not re-write client fare_breakdown / marketplace_flags / negotiation mode', () => {
        expect(PAYMENT).toContain('const optionalUpdatePayload: Record<string, unknown> = {};');
        expect(PAYMENT).not.toContain('optionalUpdatePayload.fare_breakdown');
        expect(PAYMENT).not.toContain('optionalUpdatePayload.negotiation_mode_enabled');
        expect(PAYMENT).not.toContain('optionalUpdatePayload.bid_mode_enabled');
        expect(PAYMENT).not.toContain('surge_multiplier: Number(surgeMultiplier || 1)');
    });

    it('3. refund requires an authenticated admin and derives intent/amount server-side', () => {
        expect(PAYMENT).toContain("router.post('/refund'");
        expect(PAYMENT).toContain("profile?.role !== 'admin'");
        expect(PAYMENT).toContain('const authUserId = await getAuthUserId(req);');
        // No client-supplied paymentIntentId or amount is accepted.
        expect(PAYMENT).not.toContain('const { paymentIntentId, amount, jobId } = req.body;');
        expect(PAYMENT).toContain('job.payment_intent_id');
        expect(PAYMENT).toContain('pi.amount_received');
    });

    it('4. logistics enqueue requires auth + job ownership + a paid job', () => {
        expect(LOGISTICS_ROUTE).toContain("router.post('/enqueue'");
        expect(LOGISTICS_ROUTE).toContain('const authUserId = await getAuthUserId(req);');
        expect(LOGISTICS_ROUTE).toContain("job.customer_id !== authUserId");
        expect(LOGISTICS_ROUTE).toContain("code: 'PAYMENT_REQUIRED'");
        expect(LOGISTICS_ROUTE).toContain('.select(\'id,customer_id,tenant_id,city_id,payment_status,status\')');
    });

    it('5. Stripe payment webhook is live, idempotent and guarded', () => {
        expect(WEBHOOK).toContain("case 'payment_intent.succeeded':");
        expect(WEBHOOK).toContain("case 'payment_intent.payment_failed':");
        expect(WEBHOOK).toContain(".from('stripe_events')");
        expect(WEBHOOK).toContain(".eq('payment_status', 'pending')");
        expect(WEBHOOK).toContain(".is('driver_id', null)");
    });

    it('6. completion payout uses the same agreed_fare-first basis as the charge', () => {
        expect(LOGISTICS_SERVICE).toContain('Number(job.agreed_fare ?? job.total_price ?? job.estimated_price ?? job.price ?? 0)');
    });

    it('7. completion short-circuits only on a settled earnings row', () => {
        expect(LOGISTICS_SERVICE).toContain(".eq('status', 'paid')");
        // The short-circuit must still exist and consult hasDriverEarnings.
        expect(LOGISTICS_SERVICE).toContain('hasDriverEarnings(job.id)');
    });
});

describe('PHASE C2A.1 — server-owned confirmation & negotiation authority', () => {
    const BOOKING_ROUTE = read('server/routes/booking.routes.ts');
    const BOOKING_SVC = read('src/app/core/services/booking/booking.service.ts');
    const MIGRATION = read('supabase/migrations/20261201000000_money_authority_wallet_acl.sql');
    const DIAGNOSTIC = read('scripts/db/diagnostic_phase_c1_schema_lineage.sql');

    it('8. server confirm endpoint derives and verifies every authority value', () => {
        expect(PAYMENT).toContain("router.post('/confirm'");
        expect(PAYMENT).toContain('PAYMENT_INTENT_MISMATCH');
        expect(PAYMENT).toContain('CURRENCY_MISMATCH');
        expect(PAYMENT).toContain('AMOUNT_MISMATCH');
        expect(PAYMENT).toContain("pi.status !== 'requires_capture' && pi.status !== 'succeeded'");
        expect(PAYMENT).toContain(".eq('payment_status', 'pending')");
        // The client body amount / intent id are not read.
        expect(PAYMENT).not.toMatch(/confirm[^{]*req\.body\.amount/);
    });

    it('9. webhook handles the manual-capture authorization event', () => {
        expect(WEBHOOK).toContain("case 'payment_intent.amount_capturable_updated':");
        expect(WEBHOOK).toContain("payment_status: 'authorized', status: 'searching'");
    });

    it('10. client confirmJobPayment no longer performs a direct jobs payment/status write', () => {
        expect(BOOKING_SVC).toContain("getApiUrl('/api/payment/confirm')");
        expect(BOOKING_SVC).not.toContain("payment_status: isWallet ? 'wallet_funded' : 'authorized'");
        expect(BOOKING_SVC).not.toContain('status: hasLockedDriver ? \'assigned\' : \'searching\'');
    });

    it('11. booking create derives negotiation/bidding modes server-side and never trusts the client', () => {
        expect(BOOKING_ROUTE).toContain('determineJobModes(canonicalService)');
        expect(BOOKING_ROUTE).toContain('insertPayload.agreed_fare = null');
        expect(BOOKING_ROUTE).toContain("insertPayload.status = modes.negotiation ? 'pending_fare_confirmation' : 'requested'");
    });

    it('12. marketplace negotiation RPCs bind p_driver_id to auth.uid()', () => {
        expect(MIGRATION).toContain('auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id');
        expect(MIGRATION).toContain('auth.uid() <> v_session.active_driver_id');
    });

    it('13. diagnostic no longer expects a public.payments table', () => {
        expect(DIAGNOSTIC).not.toContain("('public.payments')");
    });
});

describe('PHASE C2 FINAL — shared payable resolver & provenance', () => {
    const RESOLVER = read('server/services/payment-authority.service.ts');
    const WALLET = read('server/routes/wallet.routes.ts');
    const NEG_SVC = read('src/app/core/services/marketplace/marketplace-negotiation.service.ts');

    it('14. agreed_fare is trusted only when a server RPC set fare_agreed WITH a driver', () => {
        expect(RESOLVER).toContain("status === 'fare_agreed' && !!job?.driver_id");
        expect(RESOLVER).toContain('return money(job.total_price) || money(job.estimated_price) || money(job.price);');
    });

    it('15. create-intent, confirm and wallet all use the shared resolver', () => {
        expect(PAYMENT).toContain('PaymentAuthorityService.resolve(job)');
        expect(WALLET).toContain('PaymentAuthorityService.resolve(job)');
        expect(WALLET).toContain('const paymentAmount = payable.totalAuthorisationMajor;');
    });

    it('16. webhook verifies the stored PaymentIntent binding and authoritative amount', () => {
        expect(WEBHOOK).toContain('verifyJobPaymentIntent');
        expect(WEBHOOK).toContain('job.payment_intent_id !== paymentIntent.id');
        expect(WEBHOOK).toContain('PaymentAuthorityService.minorUnits(payable.totalAuthorisationMajor)');
    });

    it('17. lockAgreedFare no longer writes jobs.agreed_fare / status', () => {
        expect(NEG_SVC).toContain('void jobId;');
        expect(NEG_SVC).not.toContain('agreed_fare: amount');
        expect(NEG_SVC).not.toContain("status: 'fare_agreed'");
    });

    it('18. wallet amount is server-derived, not from the body or a bare agreed_fare', () => {
        expect(WALLET).not.toContain('job.agreed_fare ?? breakdown');
        expect(WALLET).not.toMatch(/paymentAmount\s*=\s*Number\s*\(\s*req\.body/);
    });
});

describe('PHASE C2B — migration/preflight exact-signature contract', () => {
    const MIG = read('supabase/migrations/20261201000000_money_authority_wallet_acl.sql');
    const PRE = read('scripts/db/preflight_20261201000000_money_authority_wallet_acl.sql');

    const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    const migrationTargets = () => [...MIG.matchAll(/ON FUNCTION public\.([a-z_]+\([^)]*\))/g)].map(m => norm(m[1]));
    const preflightRequired = () => [...PRE.matchAll(/'([a-z_]+\([^)]*\))'/g)].map(m => norm(m[1]));

    it('19. every explicit migration function target is required by the preflight contract', () => {
        const required = new Set(preflightRequired());
        const untracked = migrationTargets().filter(sig => !required.has(sig));
        expect(untracked, 'migration references a signature the preflight does not verify (would abort at runtime)').toEqual([]);
    });

    it('20. the nonexistent 3-arg finalize_wallet_topup signature is NOT a migration target', () => {
        expect(migrationTargets()).not.toContain('finalize_wallet_topup(uuid,numeric,text)');
    });

    it('21. both real production finalize_wallet_topup 4-arg signatures ARE migration targets', () => {
        const targets = migrationTargets();
        expect(targets).toContain('finalize_wallet_topup(numeric,text,text,uuid)');
        expect(targets).toContain('finalize_wallet_topup(uuid,numeric,text,text)');
    });

    it('22. the preflight requires both real finalize signatures and has a non-zero hard gate', () => {
        const required = new Set(preflightRequired());
        expect(required.has('finalize_wallet_topup(numeric,text,text,uuid)')).toBe(true);
        expect(required.has('finalize_wallet_topup(uuid,numeric,text,text)')).toBe(true);
        expect(PRE).toContain('RAISE EXCEPTION');
        expect(PRE).toContain('to_regprocedure');
    });

    it('23. extra-overload detection uses canonical type-only identity, not named arguments', () => {
        // pg_get_function_identity_arguments returns NAMED args (p_user_id uuid, ...),
        // which never matches a type-only contract tuple and falsely classifies every
        // expected overload as EXTRA. oidvectortypes(p.proargtypes) returns the
        // type-only tuple (uuid, numeric, text, text) and matches the contract.
        expect(PRE).toContain('oidvectortypes(p.proargtypes)');
        expect(PRE).not.toContain('pg_get_function_identity_arguments');
    });

    it('24. all 11 required type-only signatures remain unchanged', () => {
        const required = new Set(preflightRequired());
        for (const sig of [
            'credit_wallet_topup(uuid,numeric,text,text)',
            'credit_wallet_topup(uuid,numeric,text,text,jsonb)',
            'finalize_wallet_topup(numeric,text,text,uuid)',
            'finalize_wallet_topup(uuid,numeric,text,text)',
            'pay_job_from_wallet(uuid,uuid,numeric,text,uuid)',
            'claim_marketplace_negotiation(uuid,uuid)',
            'release_marketplace_negotiation(uuid,uuid,text)',
            'fetch_hybrid_opportunities(uuid)',
            'get_marketplace_commission(text,text,text,uuid)',
            'get_marketplace_setting(text,uuid)',
            'settle_job_wallet_reservation(uuid,numeric)'
        ]) {
            expect(required.has(norm(sig)), `${sig} must remain required`).toBe(true);
        }
    });

    it('25. the five money overload canonical tuples are type-only in the comparison list', () => {
        const body = norm(PRE);
        for (const tuple of ['uuid,numeric,text,text', 'uuid,numeric,text,text,jsonb', 'numeric,text,text,uuid', 'uuid,uuid,numeric,text,uuid']) {
            expect(body.includes(tuple), `tuple ${tuple} must be present in the extra-overload comparison`).toBe(true);
        }
    });
});

describe('PHASE C2B — postflight index diagnostic', () => {
    const POST = read('scripts/db/postflight_20261201000000_money_authority_wallet_acl.sql');

    it('26. the N12 index check uses pg_index (indexrelid), not the pg_indexes view', () => {
        // pg_indexes has schemaname/tablename/indexname/indexdef but NOT indexrelid;
        // referencing i.indexrelid against it raised "column i.indexrelid does not exist".
        expect(POST).not.toContain('LEFT JOIN pg_indexes');
        expect(POST).toContain('LEFT JOIN pg_index i');
        expect(POST).toContain('i.indexrelid');
        expect(POST).toContain("to_regclass('public.idx_jobs_one_active_per_driver')");
        expect(POST).toContain('i.indisunique');
        expect(POST).toContain('i.indisvalid');
    });

    it('27. postflight retains the read-only envelope, hard-fail gate and PASS sentinel', () => {
        expect(POST).toContain('BEGIN TRANSACTION READ ONLY');
        expect(POST).toContain('ROLLBACK');
        expect(POST).toContain('RAISE EXCEPTION');
        expect(POST).toContain('POSTFLIGHT_COMPLETE');
    });
});

describe('PHASE C2C — settlement idempotency', () => {
    const SETTLE_MIG = read('supabase/migrations/20261202000000_settlement_idempotency.sql');

    it('28. wallet payment RPC short-circuits on wallet PROVENANCE, not generic paid', () => {
        // The guard must prove the wallet operation, not "some payment completed".
        expect(SETTLE_MIG).toContain("IF v_job.payment_method = 'wallet' OR v_job.payment_status = 'wallet_funded' THEN");
        expect(SETTLE_MIG).toContain("'status', 'already_paid'");
        expect(SETTLE_MIG).toContain('FOR UPDATE');
        // Generic 'paid' must NOT appear in the idempotency predicate (card jobs
        // also reach 'paid' and must not be treated as wallet-funded).
        expect(SETTLE_MIG).not.toContain("payment_status IN ('wallet_funded', 'paid', 'wallet_settled')");
        expect(SETTLE_MIG).not.toContain("v_job.payment_status = 'paid'");
    });

    it('29. completion persists an HONEST transfer-failure marker and preserves the error', () => {
        expect(LOGISTICS_SERVICE).toContain("stripe_transfer_status: markerStatus");
        expect(LOGISTICS_SERVICE).toContain("const markerStatus = (statusCode >= 400 && statusCode < 500) ? 'failed' : 'unknown'");
        expect(LOGISTICS_SERVICE).toContain('stripe_transfer_error: message');
        expect(LOGISTICS_SERVICE).toContain('stripe_transfer_error_type: String(transferError?.type || \'\')');
        expect(LOGISTICS_SERVICE).toContain('throw transferError instanceof Error ? transferError : new Error(message)');
    });

    it('30. C2C does not weaken C2B, N12, Phase A, or change any ACL', () => {
        expect(SETTLE_MIG).not.toMatch(/REVOKE|GRANT|SECURITY DEFINER/);
        expect(SETTLE_MIG).not.toContain('idx_jobs_one_active_per_driver');
        expect(SETTLE_MIG).not.toContain('ENABLE TRIGGER');
        expect(SETTLE_MIG).not.toContain('trg_enforce_job_acquisition_eligibility');
    });
});

describe('PHASE C2C — preflight/postflight companions', () => {
    const C2C_PRE = read('scripts/db/preflight_20261202000000_settlement_idempotency.sql');
    const C2C_POST = read('scripts/db/postflight_20261202000000_settlement_idempotency.sql');

    it('31. preflight is read-only, hard-gates prerequisites, and ends with a PASS sentinel', () => {
        expect(C2C_PRE).toContain('BEGIN TRANSACTION READ ONLY');
        expect(C2C_PRE).toContain('ROLLBACK');
        expect(C2C_PRE).toContain('RAISE EXCEPTION');
        expect(C2C_PRE).toContain("'pay_job_from_wallet(uuid,uuid,numeric,text,uuid)'");
        expect(C2C_PRE).toContain("v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''");
        expect(C2C_PRE).toContain("'PREFLIGHT_COMPLETE'");
        expect(C2C_PRE).toContain("'PASS'");
        expect(C2C_PRE).toContain('trg_enforce_job_acquisition_eligibility');
        expect(C2C_PRE).toContain('idx_jobs_one_active_per_driver');
    });

    it('32. postflight is read-only, hard-gates the result, and verifies the frozen N12 set', () => {
        expect(C2C_POST).toContain('BEGIN TRANSACTION READ ONLY');
        expect(C2C_POST).toContain('ROLLBACK');
        expect(C2C_POST).toContain('RAISE EXCEPTION');
        expect(C2C_POST).toContain("v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''");
        expect(C2C_POST).toContain('driver_occupying_statuses()');
        expect(C2C_POST).toContain('regexp_matches');
        expect(C2C_POST).toContain('service_role');
        expect(C2C_POST).toContain('POSTFLIGHT_COMPLETE');
    });

    it('33. postflight sentinel is POSTFLIGHT_COMPLETE | PASS (never the C2B VERIFIED form)', () => {
        expect(C2C_POST).toContain("'POSTFLIGHT_COMPLETE'");
        expect(C2C_POST).toContain("'PASS'");
        // The C2B shell check keyed on a VERIFIED/PASS mismatch; C2C must end PASS.
        expect(C2C_POST).not.toContain("'VERIFIED'");
    });

    it('34. preflight hard-gate DO block (not the informational SELECTs) enforces all 12 gates', () => {
        // The informational SELECTs above the DO block only DISPLAY posture; the
        // preflight must fail closed, so every gate must be an executable RAISE
        // inside the DO block. Slice the DO block out and assert its raises.
        const doBlock = C2C_PRE.slice(C2C_PRE.indexOf('DO $$'), C2C_PRE.indexOf('-- 10. Sentinel'));
        expect(doBlock.length).toBeGreaterThan(200);

        // 1. exact target function exists
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: pay_job_from_wallet(uuid,uuid,numeric,text,uuid) does not exist'");
        // 2. zero unexpected overloads
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: unexpected pay_job_from_wallet overload(s) present'");
        expect(doBlock).toContain("p.oid <> to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)')");
        // 3. SECURITY INVOKER
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: pay_job_from_wallet is SECURITY DEFINER (expected INVOKER)'");
        // 4. unpinned search_path
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: pay_job_from_wallet has a pinned search_path (expected unpinned)'");
        // 5. old body anchor PRESENT (hard gate via v_def NOT LIKE, not informational)
        expect(doBlock).toContain("v_def NOT LIKE '%v_job.status IN (''cancelled'', ''completed'')%'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: expected pre-C2C body anchor (v_job.status IN (cancelled, completed)) is missing'");
        // 6. new C2C guard ABSENT (hard gate via v_def LIKE -> RAISE)
        expect(doBlock).toContain("v_def LIKE '%v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''%'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: C2C wallet-provenance guard is already present in pay_job_from_wallet'");
        // 7. service_role EXECUTE
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: service_role lacks EXECUTE on pay_job_from_wallet'");
        // 8. PUBLIC/anon/authenticated NO EXECUTE
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: PUBLIC/anon/authenticated has EXECUTE on pay_job_from_wallet'");
        expect(doBlock).toContain("(a.grantee = 0 OR COALESCE(r.rolname,'') IN ('anon','authenticated'))");
        // 9. required columns
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: missing required column(s): %', missing_cols");
        // 10. transaction_type OR type
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: wallet_transactions has neither transaction_type nor type column'");
        // 11. Phase A trigger MUST EXIST, non-internal, disabled (absence -> NO-GO)
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: Phase A trigger missing or not disabled'");
        expect(doBlock).toContain('AND NOT tg.tgisinternal');
        expect(doBlock).toContain("AND tg.tgenabled = 'D'");
        expect(doBlock).toContain('IF NOT EXISTS (');
        // 12. N12 index unique + valid
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: idx_jobs_one_active_per_driver missing, not unique, or not valid'");
    });
});

describe('PHASE C2C — corrective schema-qualified migration', () => {
    const CORRECTIVE_MIG = read('supabase/migrations/20261202010000_settlement_idempotency_corrective.sql');
    const CORRECTIVE_PRE = read('scripts/db/preflight_20261202010000_settlement_idempotency_corrective.sql');
    const CORRECTIVE_POST = read('scripts/db/postflight_20261202010000_settlement_idempotency_corrective.sql');

    it('35. corrective migration is schema-qualified and drops only the exact auth overload', () => {
        // A: the production defect was an UNqualified function name. The corrective
        // migration MUST declare the schema explicitly, and must NOT contain an
        // executable unqualified CREATE (line-anchored so a comment mention is ignored).
        expect(CORRECTIVE_MIG).toContain('CREATE OR REPLACE FUNCTION public.pay_job_from_wallet(');
        expect(CORRECTIVE_MIG).not.toMatch(/^\s*CREATE\s+OR\s+REPLACE\s+FUNCTION\s+pay_job_from_wallet\s*\(/m);
        // D: drop ONLY the exact accidental auth overload, no CASCADE, no broad drop.
        expect(CORRECTIVE_MIG).toContain('DROP FUNCTION IF EXISTS auth.pay_job_from_wallet(uuid, uuid, numeric, text, uuid);');
        expect(CORRECTIVE_MIG).not.toMatch(/DROP\s+FUNCTION\s+pay_job_from_wallet/);
        expect(CORRECTIVE_MIG).not.toMatch(/^\s*[^-][^\n]*\bCASCADE\b/m);
        // E: no ACL broadening (CREATE OR REPLACE preserves existing grants).
        expect(CORRECTIVE_MIG).not.toMatch(/GRANT\s+(EXECUTE|ALL|USAGE|SELECT|INSERT|UPDATE|DELETE)/);
        // No Phase A enablement, no N12 mutation.
        expect(CORRECTIVE_MIG).not.toContain('ENABLE TRIGGER');
        expect(CORRECTIVE_MIG).not.toContain('idx_jobs_one_active_per_driver');
        // The intended guard is present.
        expect(CORRECTIVE_MIG).toContain("IF v_job.payment_method = 'wallet' OR v_job.payment_status = 'wallet_funded' THEN");
        expect(CORRECTIVE_MIG).toContain("'status', 'already_paid'");
    });

    it('36. corrective preflight has executable RAISE hard gates for every required condition', () => {
        const doBlock = CORRECTIVE_PRE.slice(CORRECTIVE_PRE.indexOf('DO $$'), CORRECTIVE_PRE.indexOf('-- 8. Sentinel'));
        expect(CORRECTIVE_PRE).toContain('BEGIN TRANSACTION READ ONLY');
        expect(CORRECTIVE_PRE).toContain('ROLLBACK');
        expect(CORRECTIVE_PRE).toContain('CORRECTIVE_PREFLIGHT_COMPLETE');
        expect(CORRECTIVE_PRE).toContain("'PASS'");

        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid) does not exist'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: expected exactly one public pay_job_from_wallet overload'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: public pay_job_from_wallet is SECURITY DEFINER (expected INVOKER)'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: public pay_job_from_wallet has a pinned search_path'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: public pay_job_from_wallet already contains the C2C guard'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: public pay_job_from_wallet missing the pre-C2C terminal-status anchor'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: accidental auth.pay_job_from_wallet overload not found'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: auth.pay_job_from_wallet does not contain the exact C2C guard'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: service_role lacks EXECUTE on public.pay_job_from_wallet'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: PUBLIC/anon/authenticated has EXECUTE on public.pay_job_from_wallet'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: missing required column(s): %'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: wallet_transactions has neither transaction_type nor type'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: Phase A trigger missing or not disabled'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: idx_jobs_one_active_per_driver missing, not unique, or not valid'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: N12 predicate status cardinality diverged from frozen set'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: N12 predicate status set diverged from frozen set'");
    });

    it('37. corrective postflight structurally proves the public guard, fixes BUG1+BUG2, and gates the auth absence', () => {
        const doBlock = CORRECTIVE_POST.slice(CORRECTIVE_POST.indexOf('DO $$'), CORRECTIVE_POST.indexOf('-- 7. Sentinel'));
        expect(CORRECTIVE_POST).toContain('BEGIN TRANSACTION READ ONLY');
        expect(CORRECTIVE_POST).toContain('ROLLBACK');
        expect(CORRECTIVE_POST).toContain('CORRECTIVE_POSTFLIGHT_COMPLETE');
        expect(CORRECTIVE_POST).toContain("'PASS'");

        // public-specific (schema-qualified) + auth-absence gates.
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid) missing'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: accidental auth.pay_job_from_wallet overload still exists'");
        expect(doBlock).toContain("to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)')");
        expect(doBlock).toContain("to_regprocedure('auth.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)')");

        // BUG 1 fix: structural strpos-based guard presence + ordering (not a loose LIKE).
        expect(doBlock).toContain("strpos(v_def, 'IF v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded'' THEN')");
        expect(doBlock).toContain("strpos(v_def, '''status'', ''already_paid''')");
        expect(doBlock).toContain('v_guard_pos > v_wallet_insert_pos');
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: guard must occur before wallet INSERT, wallet UPDATE, and jobs UPDATE'");

        // BUG 2 fix: no `array_agg(s ...)` over EXCEPT; uses aliased array_agg(x ORDER BY x).
        expect(doBlock).not.toContain('array_agg(s');
        expect(doBlock).toContain('array_agg(x ORDER BY x)');
        expect(doBlock).toContain('unnest(v_helper) AS u(x)');

        // Phase A + N12 + frozen predicate.
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: Phase A trigger missing or not disabled'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: idx_jobs_one_active_per_driver missing, not unique, or not valid'");
        expect(doBlock).toContain("RAISE EXCEPTION 'NO-GO: N12 predicate status set diverged from frozen set'");
    });
});

describe('PHASE 2.1 — release closure authority hardening', () => {
    const AUTH_MIG = read('supabase/migrations/20261203000000_release_authority_hardening.sql');
    const AUTH_PRE = read('scripts/db/preflight_20261203000000_release_authority_hardening.sql');
    const AUTH_POST = read('scripts/db/postflight_20261203000000_release_authority_hardening.sql');
    const BOOKING_ROUTE = read('server/routes/booking.routes.ts');
    const PRICING_SERVICE = read('server/services/pricing.service.ts');
    const INDEX_TS = read('server/index.ts');

    it('38. migration closes direct-client money/acquisition writes on jobs', () => {
        // Revoke table-level UPDATE from client roles, then grant only safe columns.
        expect(AUTH_MIG).toContain('REVOKE UPDATE ON public.jobs FROM anon, authenticated;');
        expect(AUTH_MIG).toContain('GRANT UPDATE (');
        expect(AUTH_MIG).toContain('payment_status');
        // Sensitive columns are NOT in the safe grant set.
        expect(AUTH_MIG).toContain('negotiation_mode_enabled');
        expect(AUTH_MIG).toContain('pickup_lat');
    });

    it('39. migration gates assign_driver_to_job and claim/release/fetch identity', () => {
        expect(AUTH_MIG).toContain("RAISE EXCEPTION 'Only an administrator can assign a driver to a job'");
        expect(AUTH_MIG).toContain("IF auth.uid() IS NOT NULL AND NOT EXISTS (");
        expect(AUTH_MIG).toContain("RAISE EXCEPTION 'You can only claim a negotiation for yourself'");
        expect(AUTH_MIG).toContain("RAISE EXCEPTION 'System release requires service role'");
        expect(AUTH_MIG).toContain("RAISE EXCEPTION 'You can only fetch your own opportunities'");
        expect(AUTH_MIG).toContain('REVOKE ALL ON FUNCTION public.claim_marketplace_negotiation(uuid, uuid) FROM PUBLIC;');
        expect(AUTH_MIG).toContain('REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(uuid) FROM anon;');
        expect(AUTH_MIG).toContain('GRANT EXECUTE ON FUNCTION public.claim_marketplace_negotiation(uuid, uuid) TO authenticated, service_role;');
    });

    it('40. booking create forces payment_status pending and drops client commission/payout', () => {
        expect(BOOKING_ROUTE).toContain("insertPayload.payment_status = 'pending';");
        expect(BOOKING_ROUTE).toContain('insertPayload.commission_rate_used = null;');
        expect(BOOKING_ROUTE).toContain('insertPayload.driver_payout = null;');
    });

    it('41. completion commission is server-authoritative (no client fare_breakdown/commission_rate_used)', () => {
        const LOGISTICS_SERVICE = read('server/services/logistics.service.ts');
        // The client-snapshotted commission fields are no longer the payout basis.
        expect(LOGISTICS_SERVICE).toContain('const commissionRate = plan === \'pro\' ? 0 : Number(effectiveCommissionRate ?? 0);');
        expect(LOGISTICS_SERVICE).not.toContain('Number(storedCommission ?? 0)');
    });

    it('42. pricing propagates quoteReference into the market-pricing audit', () => {
        expect(PRICING_SERVICE).toContain('quoteReference?: string | null;');
        expect(PRICING_SERVICE).toContain('quoteReference: options.quoteReference || null,');
    });

    it('43. duplicate legacy Stripe webhook route is removed (single authoritative path)', () => {
        expect(INDEX_TS).not.toContain('webhookRoutes');
        expect(INDEX_TS).toContain('stripeWebhookRoutes');
        expect(INDEX_TS).not.toContain("app.use('/api/webhook', webhookRoutes)");
    });

    it('44. authority preflight/postflight have read-only envelope + PASS sentinel', () => {
        expect(AUTH_PRE).toContain('BEGIN TRANSACTION READ ONLY');
        expect(AUTH_PRE).toContain('ROLLBACK');
        expect(AUTH_PRE).toContain("'PREFLIGHT_COMPLETE'");
        expect(AUTH_POST).toContain('BEGIN TRANSACTION READ ONLY');
        expect(AUTH_POST).toContain('ROLLBACK');
        expect(AUTH_POST).toContain("'POSTFLIGHT_COMPLETE'");
        expect(AUTH_POST).toContain("has_column_privilege('authenticated', 'public.jobs', 'payment_status', 'UPDATE')");
    });
});

describe('PHASE 2.1 — final zero-blocker hardening', () => {
    const FINAL_MIG = read('supabase/migrations/20261204000000_release_final_hardening.sql');
    const FINAL_PRE = read('scripts/db/preflight_20261204000000_release_final_hardening.sql');
    const FINAL_POST = read('scripts/db/postflight_20261204000000_release_final_hardening.sql');
    const LOGISTICS_SERVICE = read('server/services/logistics.service.ts');
    const DISPATCH_SERVICE = read('server/services/dispatch.service.ts');
    const PAYMENT_ROUTE = read('server/routes/payment.routes.ts');
    const BOOKING_SERVICE = read('src/app/core/services/booking/booking.service.ts');

    it('45. final migration retires the payout trigger and installs payment-eligibility + secret store', () => {
        expect(FINAL_MIG).toContain('DROP TRIGGER IF EXISTS tr_calculate_job_payouts ON public.jobs;');
        expect(FINAL_MIG).toContain('DROP FUNCTION IF EXISTS public.calculate_job_payouts();');
        expect(FINAL_MIG).toContain('CREATE TRIGGER trg_enforce_job_payment_eligibility');
        expect(FINAL_MIG).toContain("NEW.payment_status NOT IN (");
        expect(FINAL_MIG).toContain('CREATE TABLE IF NOT EXISTS public.job_completion_secrets');
        expect(FINAL_MIG).toContain('Customers can view own completion pin');
    });

    it('46. final migration keeps wallet total_price as the service fare (no budget inflation)', () => {
        expect(FINAL_MIG).toContain('total_price = COALESCE(total_price, v_amount)');
        expect(FINAL_MIG).not.toContain('total_price = v_amount');
    });

    it('47. completion payout basis is the service fare; card errands capture fare + actual spend', () => {
        expect(LOGISTICS_SERVICE).toContain('const totalPrice = requestedTotalPrice;');
        expect(LOGISTICS_SERVICE).not.toContain('resolveWalletSettlementAmount(job, requestedTotalPrice)');
        expect(LOGISTICS_SERVICE).toContain('amount_to_capture: captureAmountInPence');
        expect(LOGISTICS_SERVICE).toContain('PaymentAuthorityService.resolve(job)');
    });

    it('48. completion PIN is server-side (secret table) and not driver-readable via metadata', () => {
        expect(LOGISTICS_SERVICE).toContain("from('job_completion_secrets')");
        expect(LOGISTICS_SERVICE).toContain('secretRow?.completion_pin');
        expect(BOOKING_SERVICE).not.toContain('completion_pin: completionPin');
        expect(BOOKING_SERVICE).toContain('completion_pin_required: true');
    });

    it('49. scheduled bookings defer dispatch until scheduled_time and activate exactly once', () => {
        expect(PAYMENT_ROUTE).toContain('scheduledInFuture');
        expect(PAYMENT_ROUTE).toContain("(scheduledInFuture ? 'requested' : 'searching')");
        expect(DISPATCH_SERVICE).toContain('activateDueScheduledJobs');
        expect(DISPATCH_SERVICE).toContain(".lte('scheduled_time', nowIso())");
        expect(DISPATCH_SERVICE).toContain(".eq('status', 'requested')");
    });

    it('50. final preflight/postflight have read-only envelope + PASS sentinel', () => {
        expect(FINAL_PRE).toContain('BEGIN TRANSACTION READ ONLY');
        expect(FINAL_PRE).toContain('ROLLBACK');
        expect(FINAL_PRE).toContain("'PREFLIGHT_COMPLETE'");
        expect(FINAL_POST).toContain('BEGIN TRANSACTION READ ONLY');
        expect(FINAL_POST).toContain('ROLLBACK');
        expect(FINAL_POST).toContain("'POSTFLIGHT_COMPLETE'");
        expect(FINAL_POST).toContain('trg_enforce_job_payment_eligibility');
    });
});

describe('PHASE 2.1 — wallet-errand settlement economics', () => {
    const SETTLE_MIG = read('supabase/migrations/20261205000000_settle_errand_economics.sql');
    const SETTLE_PRE = read('scripts/db/preflight_20261205000000_settle_errand_economics.sql');
    const SETTLE_POST = read('scripts/db/postflight_20261205000000_settle_errand_economics.sql');

    it('51. settle errand total = service fare + actual spend; unused budget released; fare never capped', () => {
        // The old conflation (LEAST(v_amount, actual_spending)) must be gone.
        expect(SETTLE_MIG).not.toContain('LEAST(v_amount, v_actual_spending)');
        // Settlement = fare + spend.
        expect(SETTLE_MIG).toContain('v_settlement_amount := ROUND((v_amount + v_actual_spending)::NUMERIC, 2)');
        // Unused budget release.
        expect(SETTLE_MIG).toContain('v_budget := ROUND(GREATEST(v_job_reserved - v_amount, 0)::NUMERIC, 2)');
        expect(SETTLE_MIG).toContain('v_refund_amount := ROUND(GREATEST(v_job_reserved - v_settlement_amount, 0)::NUMERIC, 2)');
        // Idempotency + non-errand preserved.
        expect(SETTLE_MIG).toContain("'already_settled'");
        expect(SETTLE_MIG).toContain('LEAST(v_reserved, v_job_reserved)');
        // Schema-qualified CREATE OR REPLACE.
        expect(SETTLE_MIG).toContain('CREATE OR REPLACE FUNCTION public.settle_job_wallet_reservation(');
    });

    it('52. settle preflight/postflight are read-only with PASS sentinels', () => {
        expect(SETTLE_PRE).toContain('BEGIN TRANSACTION READ ONLY');
        expect(SETTLE_PRE).toContain('ROLLBACK');
        expect(SETTLE_PRE).toContain("'PREFLIGHT_COMPLETE'");
        expect(SETTLE_PRE).toContain('LEAST(v_amount, v_actual_spending)');
        expect(SETTLE_POST).toContain('BEGIN TRANSACTION READ ONLY');
        expect(SETTLE_POST).toContain('ROLLBACK');
        expect(SETTLE_POST).toContain("'POSTFLIGHT_COMPLETE'");
        expect(SETTLE_POST).toContain('v_settlement_amount := ROUND((v_amount + v_actual_spending)');
    });
});
