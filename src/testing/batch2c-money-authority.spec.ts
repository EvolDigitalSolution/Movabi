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
        expect(PAYMENT).toContain("money(job.agreed_fare)");
        expect(PAYMENT).not.toContain('money(req.body.amount)');
        expect(PAYMENT).toContain('money(job.price);');
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
