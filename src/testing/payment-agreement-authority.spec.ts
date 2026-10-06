/**
 * PAYMENT AUTHORITY + AGREED-FARE PAYMENT DEADLINE.
 *
 * Defect 1: the payment card showed Total Authorisation £9.06 (the STALE original
 *   quote) while Service Fare showed the negotiated £9.00. Both payment pages
 *   preferred `fare_breakdown.totalAuthorisation` over the agreed fare.
 * Defect 2: the ~300 s payment window lived only on session.expires_at, was
 *   hard-coded in both acceptance RPCs, `payment_deadline` was never written, and
 *   NO server boundary enforced it — so a stale agreement stayed payable forever.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const FARE = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
const PAY = read('src/app/apps/mobile/features/customer/marketplace-payment/marketplace-payment.page.ts');
const PAY_ROUTE = read('server/routes/payment.routes.ts');
const AUTHORITY = read('server/services/payment-authority.service.ts');
const LOGISTICS = read('server/services/logistics.service.ts');
const MIG = read('supabase/migrations/20261236000000_fare_agreement_payment_deadline.sql');

const fareTotal = () => FARE.slice(FARE.indexOf('paymentTotal(): number {'), FARE.indexOf('fareBreakdown(): any {'));
const payTotal = () => PAY.slice(PAY.indexOf('paymentTotal(): number {'), PAY.indexOf('// Backward-compatible alias'));

describe('A/B. displayed payment amount uses the authoritative negotiated fare', () => {
  it('marketplace-fare paymentTotal prefers agreed_fare + budget over the stale quote total', () => {
    const fn = fareTotal();
    expect(fn).toContain('const agreed = Number(job?.agreed_fare);');
    expect(fn).toContain('return this.toMoney(agreed + this.itemBudget());');
    // the stale quote total is only the NON-negotiated path
    expect(fn.indexOf('const agreed = Number(job?.agreed_fare);'))
      .toBeLessThan(fn.indexOf("fb?.['totalAuthorisation']"));
  });

  it('marketplace-payment paymentTotal does the same', () => {
    const fn = payTotal();
    expect(fn).toContain('const agreed = Number(job?.agreed_fare);');
    expect(fn).toContain('return this.toMoney(agreed + this.itemBudget());');
    expect(fn.indexOf('const agreed = Number(job?.agreed_fare);'))
      .toBeLessThan(fn.indexOf("fb?.['totalAuthorisation']"));
  });

  it('C. the server amount is PaymentAuthorityService (agreed_fare + itemBudget), not the client body', () => {
    expect(AUTHORITY).toContain('if (negotiated) {');
    expect(AUTHORITY).toContain('const agreed = money(job.agreed_fare);');
    expect(AUTHORITY).toContain('totalAuthorisationMajor: Number((serviceFareMajor + itemBudgetMajor).toFixed(2))');
    expect(PAY_ROUTE).toContain('const payable = await PaymentAuthorityService.resolve(job);');
    expect(PAY_ROUTE).toContain('amount: Math.round(totalAuthorisation * 100),');
  });

  it('D. a client-supplied amount is never authoritative', () => {
    expect(PAY_ROUTE).toContain('the client body amount is');
    // the request amount is only ever logged for diagnostics
    expect(PAY_ROUTE).toContain('requestAmount: req.body.amount');
    expect(PAY_ROUTE).not.toMatch(/amount:\s*Math\.round\(Number\(req\.body\.amount/);
  });

  it('E. the non-negotiated path is unchanged (quote breakdown remains authoritative)', () => {
    expect(fareTotal()).toContain("fb?.['totalAuthorisation'] ||");
    expect(payTotal()).toContain("fb?.['totalAuthorisation'] || (this.serviceFare() + this.itemBudget())");
  });

  it('F. the shopping budget is added exactly once', () => {
    for (const fn of [fareTotal(), payTotal()]) {
      expect(fn.split('this.itemBudget()').length - 1).toBe(2); // negotiated + fallback, never doubled
    }
  });

  it('G. the stale quote platform fee is not presented as an extra charge for a negotiated job', () => {
    const start = PAY.indexOf('platformFeeAmount(): number {');
    const fn = PAY.slice(start, start + 1500);
    expect(fn).toContain('if (Number(job?.agreed_fare) > 0) return 0;');
    expect(fn).toContain("return this.toMoney(fb?.['platformFeeAmount'] ?? fb?.['platformFee']);");
  });

  it('H. settlement reads the frozen fare-split snapshot (agreed fare and service fare are inside it)', () => {
    expect(LOGISTICS).toContain('FareSplitService.fromSnapshot(job.fare_breakdown, job.currency_code)');
    expect(LOGISTICS).toContain('const driverPayout = split.driverEntitlement;');
  });
});

describe('I/P/Q. server rejects stale / expired / inactive agreements', () => {
  const guard = () => PAY_ROUTE.slice(PAY_ROUTE.indexOf('NEGOTIATED AGREEMENT DEADLINE'), PAY_ROUTE.indexOf('if (job.payment_intent_id)'));

  it('checks the persisted negotiation session BEFORE PaymentIntent reuse', () => {
    expect(guard()).toContain("from('marketplace_negotiation_sessions')");
    expect(PAY_ROUTE.indexOf('NEGOTIATED AGREEMENT DEADLINE')).toBeLessThan(PAY_ROUTE.indexOf('if (job.payment_intent_id)'));
  });

  it('O. rejects payment once the persisted deadline has passed', () => {
    expect(guard()).toContain("(agreedSession as any).payment_deadline || (agreedSession as any).expires_at");
    expect(guard()).toContain('deadlinePassed');
    expect(guard()).toContain("code: 'AGREEMENT_EXPIRED'");
    expect(guard()).toContain('Payment time expired. This fare agreement is no longer valid.');
  });

  it('Q/P. rejects a released/cancelled/superseded agreement (status must still be fare_agreed)', () => {
    expect(guard()).toContain("if (agreementStatus !== 'fare_agreed')");
    expect(guard()).toContain("code: 'AGREEMENT_NOT_ACTIVE'");
  });
});

describe('J/K/L/M. authoritative payment deadline', () => {
  it('J. both acceptance RPCs write payment_deadline from the existing config', () => {
    expect(MIG).toContain("->>'paymentDeadlineAfterFareAgreement'");
    const writes = MIG.split('payment_deadline = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),').length - 1;
    expect(writes).toBe(2); // driver_accept_customer_offer + customer_accept_driver_counter
  });

  it('both RPCs keep expires_at equal to the same deadline (one authoritative window)', () => {
    const pairs = MIG.split('expires_at = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),').length - 1;
    expect(pairs).toBe(2);
    // no EXECUTABLE hard-coded 300s window remains (the header comment only
    // DESCRIBES the defect it fixes)
    const executable = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(executable).not.toMatch(/expires_at = now\(\) \+ interval '300 seconds'/);
  });

  it('K/L. the countdown source is the persisted deadline (client exposes it)', () => {
    expect(read('src/app/core/services/marketplace/marketplace-hybrid.service.ts')).toContain('payment_deadline: string | null;');
  });
});

describe('N/R/S/X. authoritative expiry transition', () => {
  it('R. unpaid expiry while the job deadline is live releases the SAME request to the market', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.expire_unpaid_fare_agreement(');
    expect(MIG).toContain("SET status = 'released',");
    expect(MIG).toContain('agreed_fare = NULL,');
    expect(MIG).toContain("SET status = 'pending_fare_confirmation',");
  });

  it('never creates a replacement job', () => {
    const fn = MIG.slice(MIG.indexOf('expire_unpaid_fare_agreement('), MIG.indexOf('2. DISCOVERY'));
    expect(fn).not.toContain('INSERT INTO public.jobs');
  });

  it('S. once the overall jobs.expires_at has passed the request is terminalised, not recycled', () => {
    const fn = MIG.slice(MIG.indexOf('expire_unpaid_fare_agreement('), MIG.indexOf('2. DISCOVERY'));
    expect(fn).toContain('IF v_job.expires_at IS NOT NULL AND v_job.expires_at <= now() THEN');
    expect(fn).toContain("status = 'expired',");
  });

  it('X. a PAID job can never be released by expiry processing', () => {
    const fn = MIG.slice(MIG.indexOf('expire_unpaid_fare_agreement('), MIG.indexOf('2. DISCOVERY'));
    expect(fn).toContain("IF v_payment IN ('authorized', 'requires_capture', 'succeeded', 'captured', 'paid', 'wallet_funded') THEN");
    expect(fn).toContain('RETURN FALSE;');
  });

  it('U. the transition is driven from authoritative boundaries, not a browser', () => {
    expect(MIG).toContain('PERFORM public.expire_unpaid_fare_agreement(s.id)');
    expect(MIG).toContain('WHERE s.status = \'fare_agreed\'');
  });

  it('V. the helper is internal (no client execution) and idempotent by status', () => {
    expect(MIG).toContain('REVOKE EXECUTE ON FUNCTION public.expire_unpaid_fare_agreement(UUID) FROM anon, authenticated;');
    const fn = MIG.slice(MIG.indexOf('expire_unpaid_fare_agreement('), MIG.indexOf('2. DISCOVERY'));
    expect(fn).toContain("IF v_session.status <> 'fare_agreed' THEN");
  });

  it('320 eligibility and 340 lease release remain intact', () => {
    expect(MIG).toContain('public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)');
    expect(MIG).toContain('public.release_stale_negotiation_lease(s.id)');
  });

  it('no timeout configuration, N12, MB codes or payment/Stripe architecture changed', () => {
    expect(MIG).not.toMatch(/timeoutSeconds\s*=/);
    expect(MIG).not.toMatch(/RAISE EXCEPTION 'MB00/);
    expect(MIG).not.toContain('driver_occupying_statuses');
    expect(MIG).not.toContain('stripe.paymentIntents');
  });
});

describe('countdown UX + payment-boundary persistence + cancellation authority', () => {
  const DRIVER = read('src/app/apps/mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page.ts');

  it('customer countdown derives from the PERSISTED payment_deadline (no fresh client timer)', () => {
    const fn = FARE.slice(FARE.indexOf('readonly paymentCountdown = computed'), FARE.indexOf('async openCounterInput'));
    expect(fn).toContain("(session as any)?.payment_deadline ?? (session as any)?.expires_at");
    expect(fn).toContain('deadlineRemainingMs(raw, this.negotiationClock())');
    // no independent 4/5-minute timer is created
    expect(FARE).not.toMatch(/4 \* 60 \* 1000|5 \* 60 \* 1000|300 \* 1000/);
  });

  it('driver countdown derives from the SAME persisted deadline', () => {
    const fn = DRIVER.slice(DRIVER.indexOf('readonly paymentCountdown = computed'), DRIVER.indexOf('canDriver(action'));
    expect(fn).toContain("(session as any)?.payment_deadline ?? (session as any)?.expires_at");
    expect(fn).toContain('deadlineRemainingMs(raw, this.leaseClock())');
    expect(DRIVER).toContain('to complete payment.');
    expect(DRIVER).toContain('Payment window expired. Releasing this agreement');
  });

  it('at 00:00 the customer UI removes the pay/card presentation and shows the expiry message', () => {
    expect(FARE).toContain('Payment time expired. This fare agreement is no longer valid.');
    expect(FARE).toContain('@if (hybridEnabled && !negotiationState().paymentExpired) {');
    expect(FARE).toContain('[disabled]="!cardReady() || paymentProcessing() || negotiationState().paymentExpired"');
    expect(FARE).toContain('Fare agreed — complete payment within {{ formatRemaining(paymentCountdown()) }}');
  });

  it('exactly ONE authoritative expiry attempt per lapsed deadline, and no polling', () => {
    const timer = FARE.slice(FARE.indexOf('private startLeaseTimer()'), FARE.indexOf('private stopLeaseTimer()'));
    expect(timer).toContain('if (!key || this.leaseReconciledFor === key) return;');
    expect(timer).toContain("if (sessionStatus === 'fare_agreed') {");
    expect(timer).toContain('this.hybridService.customerExpireUnpaidAgreement(session.id)');
    expect(FARE).not.toMatch(/setInterval\([^)]*reconcileHybridNegotiation\(/);
  });

  it('customer_cancel_offer is unreachable for the agreed/expired phases', () => {
    const fn = FARE.slice(FARE.indexOf('async cancelHybridRequest()'), FARE.indexOf('async acceptOffer('));
    // canonical guard precedes any RPC
    expect(fn).toContain("if (!canCustomer(state, 'cancel_offer')) {");
    expect(fn.indexOf("if (!canCustomer(state, 'cancel_offer')) {"))
      .toBeLessThan(fn.indexOf('customerCancelOffer(session.id)'));
    // the expired-agreement path uses the expiry RPC, never the withdrawal RPC
    expect(fn).toContain('? this.hybridService.customerExpireUnpaidAgreement(session.id)');
    expect(fn).toContain(': this.hybridService.customerCancelOffer(session.id)');
    expect(FARE).toContain("{{ negotiationState().paymentExpired ? 'Find Another Driver' : 'Cancel Request' }}");
  });

  it('repeated clicks cause ONE mutation (busy guard + finally cleanup + reconcile on conflict)', () => {
    const fn = FARE.slice(FARE.indexOf('async cancelHybridRequest()'), FARE.indexOf('async acceptOffer('));
    expect(fn).toContain('if (this.negotiationBusy()) return;');
    expect(FARE).toContain('[disabled]="negotiationBusy()"');
    expect(fn.slice(fn.lastIndexOf('} finally {'))).toContain('this.negotiationBusy.set(false);');
    expect(fn).toContain('await this.reconcileHybridNegotiation(session.job_id);');
  });

  it('the payment endpoint PERSISTS the transition (service authority) before responding', () => {
    const guard = PAY_ROUTE.slice(PAY_ROUTE.indexOf('NEGOTIATED AGREEMENT DEADLINE'), PAY_ROUTE.indexOf('if (job.payment_intent_id)'));
    expect(guard).toContain("supabaseAdmin.rpc('expire_unpaid_fare_agreement'");
    // persisted BEFORE the expiry response is returned
    expect(guard.indexOf("supabaseAdmin.rpc('expire_unpaid_fare_agreement'"))
      .toBeLessThan(guard.indexOf("code: 'AGREEMENT_EXPIRED'"));
  });

  it('the internal helper is service-only; the customer wrapper is authenticated-only and locked', () => {
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.expire_unpaid_fare_agreement(UUID) TO service_role;');
    expect(MIG).toContain('REVOKE EXECUTE ON FUNCTION public.expire_unpaid_fare_agreement(UUID) FROM anon, authenticated;');
    const wrapper = MIG.slice(MIG.indexOf('public.customer_expire_unpaid_agreement('), MIG.indexOf('ACL —'));
    expect(wrapper).toContain('v_session.customer_id IS DISTINCT FROM v_actor');
    expect(wrapper).toContain('FOR UPDATE');
    // cannot force-expire before the deadline (delegates to the guarded transition)
    expect(wrapper).toContain("IF v_session.status = 'fare_agreed' THEN");
    expect(wrapper).toContain('PERFORM public.expire_unpaid_fare_agreement(p_session_id);');
  });

  it('no stale £9.06 can reappear anywhere in the payment presentation', () => {
    for (const src of [FARE, PAY]) {
      expect(src).not.toContain('9.06');
    }
  });
});

/**
 * ATOMIC PAYMENT FINALIZATION (the Stripe TOCTOU).
 *
 * DEFECT: the real finalizers guarded only on jobs.payment_status='pending'
 * (and driver_id IS NULL for the webhook), but the expiry/cancel transitions
 * clear agreed_fare + driver_id while LEAVING payment_status='pending' - so a
 * released/cancelled/expired agreement whose Stripe authorization was already in
 * flight was resurrected as a paid booking. Finalization is now one atomic,
 * agreement-aware RPC.
 */
describe('atomic payment finalization authority (TOCTOU)', () => {
  const WEBHOOK = read('server/routes/stripe-webhook.routes.ts');
  const RPC = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.finalize_job_payment('), MIG.indexOf('ACL -'));

  it('360 defines the finalization RPC as SECURITY DEFINER with a fixed search_path', () => {
    expect(RPC).toContain('CREATE OR REPLACE FUNCTION public.finalize_job_payment(');
    expect(RPC).toContain('SECURITY DEFINER');
    expect(RPC).toContain('SET search_path = public');
  });

  it('locks the job and its session in a deterministic order', () => {
    expect(RPC).toContain('FROM public.jobs WHERE id = p_job_id FOR UPDATE');
    expect(RPC).toContain('FROM public.marketplace_negotiation_sessions');
    const jobLock = RPC.indexOf('FROM public.jobs WHERE id = p_job_id FOR UPDATE');
    const sessLock = RPC.indexOf('FROM public.marketplace_negotiation_sessions');
    expect(jobLock).toBeLessThan(sessLock);
  });

  it('re-verifies the agreement: still fare_agreed, not expired, driver + fare matched', () => {
    expect(RPC).toContain("IF v_session.status IS DISTINCT FROM 'fare_agreed' THEN");
    expect(RPC).toContain("RETURN 'agreement_lost';");
    expect(RPC).toContain("RETURN 'agreement_expired';");
    expect(RPC).toContain("RETURN 'agreed_fare_mismatch';");
    expect(RPC).toContain('IF v_job.driver_id IS DISTINCT FROM v_session.active_driver_id THEN');
    expect(RPC).toContain("RETURN 'job_terminal';");
    expect(RPC).toContain("RETURN 'already_finalized';");
    expect(RPC).toContain("RETURN 'intent_mismatch';");
  });

  it('is backend-only: revoked from PUBLIC/anon/authenticated, granted to service_role', () => {
    expect(MIG).toMatch(/REVOKE ALL ON FUNCTION public\.finalize_job_payment\([^)]*\) FROM PUBLIC;/);
    expect(MIG).toMatch(/REVOKE EXECUTE ON FUNCTION public\.finalize_job_payment\([^)]*\) FROM anon, authenticated;/);
    expect(MIG).toMatch(/GRANT EXECUTE ON FUNCTION public\.finalize_job_payment\([^)]*\) TO service_role;/);
  });

  it('/confirm routes its write through the RPC and never reactivates a lost agreement', () => {
    expect(PAY_ROUTE).toContain("supabaseAdmin.rpc('finalize_job_payment'");
    expect(PAY_ROUTE).toContain("if (finalizeResult !== 'finalized')");
    expect(PAY_ROUTE).toContain("code: 'AGREEMENT_LOST'");
  });

  it('the webhook obeys the same authority (delayed event cannot resurrect)', () => {
    const rpcCalls = WEBHOOK.split("supabase.rpc('finalize_job_payment'").length - 1;
    expect(rpcCalls).toBe(2);
    expect(WEBHOOK).toContain('p_require_unowned: true');
  });

  it('compensation follows the real manual-capture lifecycle and invents no refund', () => {
    expect(PAY_ROUTE).toContain('async function compensateUnauthorizedIntent(');
    expect(PAY_ROUTE).toContain('stripe.paymentIntents.cancel(intentId)');
    expect(PAY_ROUTE).toContain("'requires_capture'");
    expect(PAY_ROUTE).toContain("action: 'captured_requires_manual_reconciliation'");
    const helper = PAY_ROUTE.slice(
      PAY_ROUTE.indexOf('async function compensateUnauthorizedIntent('),
      PAY_ROUTE.indexOf("router.post('/confirm'")
    );
    expect(helper).not.toContain('stripe.refunds.create');
  });

  it('the amount authority is not duplicated into SQL (no money rules in the RPC)', () => {
    expect(RPC).not.toContain('itemBudget');
    expect(RPC).not.toContain('platformFee');
  });

  it('CAPTURED/SUCCEEDED policy: agreement_lost never resurrects and never auto-refunds', () => {
    const helper = PAY_ROUTE.slice(
      PAY_ROUTE.indexOf('async function compensateUnauthorizedIntent('),
      PAY_ROUTE.indexOf("router.post('/confirm'")
    );
    // a captured (succeeded) intent is NOT auto-refunded - manual reconciliation only
    expect(helper).toContain("if (pi.status === 'succeeded') {");
    expect(helper).toContain('captured_requires_manual_reconciliation');
    expect(helper).not.toContain('refunds.create');
    // ...and no code path in the helper re-activates the booking
    expect(helper).not.toMatch(/payment_status:\s*'(paid|authorized)'/);
    // /confirm returns a deterministic conflict and never reactivates the job
    expect(PAY_ROUTE).toContain("code: 'AGREEMENT_LOST'");
    expect(PAY_ROUTE).toContain("if (finalizeResult !== 'finalized')");
    const lostBranch = PAY_ROUTE.slice(
      PAY_ROUTE.indexOf("if (finalizeResult !== 'finalized')"),
      PAY_ROUTE.indexOf('const { data: updated }')
    );
    expect(lostBranch).not.toMatch(/payment_status:\s*'(paid|authorized)'/);
  });
});
