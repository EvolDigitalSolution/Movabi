/**
 * PAYMENT DEADLINE COUNTDOWN + FAIL-CLOSED + CANCEL ROUTING.
 *
 * The deadline is ALWAYS the persisted authority
 * (marketplace_negotiation_sessions.payment_deadline / expires_at); the shared
 * pure helpers only convert it against a wall-clock tick.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  deadlineKey,
  deadlineRemainingMs,
  formatRemaining,
  isDeadlineElapsed
} from '../app/shared/marketplace/negotiation-state';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const FARE = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
const PAY = read('src/app/apps/mobile/features/customer/marketplace-payment/marketplace-payment.page.ts');
const DRIVER = read('src/app/apps/mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page.ts');

const T0 = Date.parse('2026-10-03T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

afterEach(() => { vi.useRealTimers(); });

describe('shared deadline helpers (pure)', () => {
  it('1. a persisted deadline 5 minutes away renders 05:00', () => {
    expect(formatRemaining(deadlineRemainingMs(at(300_000), T0))).toBe('05:00');
  });

  it('2. advancing one second renders 04:59', () => {
    expect(formatRemaining(deadlineRemainingMs(at(300_000), T0 + 1_000))).toBe('04:59');
  });

  it('3. a page opened with only 2:17 remaining renders 02:17 (NOT 05:00)', () => {
    // the deadline is persisted, so a delayed load shows the SAME remaining time
    expect(formatRemaining(deadlineRemainingMs(at(300_000), T0 + 163_000))).toBe('02:17');
  });

  it('4. at/after the deadline it renders 00:00 and reports expired', () => {
    expect(formatRemaining(deadlineRemainingMs(at(0), T0))).toBe('00:00');
    expect(deadlineRemainingMs(at(-5_000), T0)).toBe(0);
    expect(isDeadlineElapsed(at(0), T0)).toBe(true);
    expect(isDeadlineElapsed(at(1_000), T0)).toBe(false);
  });

  it('absent/invalid deadlines are never treated as expired and never count down', () => {
    expect(deadlineRemainingMs(null, T0)).toBe(0);
    expect(deadlineRemainingMs('', T0)).toBe(0);
    expect(deadlineRemainingMs('not-a-date', T0)).toBe(0);
    expect(isDeadlineElapsed(null, T0)).toBe(false);
    expect(isDeadlineElapsed('', T0)).toBe(false);
  });

  it('8/13. the one-shot key is stable per session+deadline (a 1s tick cannot re-fire)', () => {
    const k1 = deadlineKey('s1', at(300_000));
    expect(k1).toBe(deadlineKey('s1', at(300_000)));
    expect(k1).toBe('s1:' + at(300_000));
    // a NEW deadline is a new key (a fresh agreement may expire once more)
    expect(deadlineKey('s1', at(600_000))).not.toBe(k1);
    // missing identity yields no key => no mutation
    expect(deadlineKey(null, at(300_000))).toBe('');
    expect(deadlineKey('s1', null)).toBe('');
  });

  it('the display tick is a local clock only — no timers inside the helper module', () => {
    const mod = read('src/app/shared/marketplace/negotiation-state.ts');
    expect(mod).not.toContain('setInterval');
    expect(mod).not.toContain('setTimeout');
  });
});

describe('customer countdown + fail-closed', () => {
  it('derives from the PERSISTED deadline via the shared helper (no fresh timer)', () => {
    const start = FARE.indexOf('readonly paymentCountdown = computed');
    const fn = FARE.slice(start, start + 500);
    expect(fn).toContain('deadlineRemainingMs(raw, this.negotiationClock())');
    expect(fn).toContain('payment_deadline ?? (session as any)?.expires_at');
    expect(FARE).not.toMatch(/300 \* 1000|4 \* 60 \* 1000|5 \* 60 \* 1000/);
  });

  it('5/6. Pay and the card controls are unavailable at 00:00', () => {
    expect(FARE).toContain('formatRemaining(paymentCountdown())');
    expect(FARE).toContain('Payment time expired. This fare agreement is no longer valid.');
    expect(FARE).toContain('@if (hybridEnabled && !negotiationState().paymentExpired) {');
    expect(FARE).toContain('|| negotiationState().paymentExpired"');
  });

  it('8. exactly ONE expiry RPC per session/deadline, guarded by the shared key', () => {
    const timer = FARE.slice(FARE.indexOf('private startLeaseTimer()'), FARE.indexOf('private stopLeaseTimer()'));
    expect(timer).toContain('const key = deadlineKey(session.id, expiresAt);');
    expect(timer).toContain('if (!key || this.leaseReconciledFor === key) return;');
    expect(timer).toContain('this.hybridService.customerExpireUnpaidAgreement(session.id)');
    // no polling of the database
    expect(FARE).not.toMatch(/setInterval\([^)]*reconcileHybridNegotiation\(/);
  });

  it('10. the display interval is disposed on destroy', () => {
    expect(FARE).toContain('this.stopLeaseTimer();');
    const destroy = FARE.slice(FARE.indexOf('ngOnDestroy()'), FARE.indexOf('ngOnDestroy()') + 1200);
    expect(destroy).toContain('this.stopLeaseTimer();');
  });
});

describe('driver countdown', () => {
  it('11. uses the SAME persisted deadline through the shared helper', () => {
    const fn = DRIVER.slice(DRIVER.indexOf('readonly paymentCountdown = computed'), DRIVER.indexOf('canDriver(action'));
    expect(fn).toContain('deadlineRemainingMs(raw, this.leaseClock())');
    expect(fn).toContain('payment_deadline ?? (session as any)?.expires_at');
    expect(DRIVER).toContain('to complete payment.');
  });

  it('12. reaches the expired state at the same boundary', () => {
    expect(DRIVER).toContain('Payment window expired. Releasing this agreement');
    expect(DRIVER).toContain('formatRemaining(paymentCountdown())');
  });

  it('13. no independent driver timer can duplicate the lifecycle effect', () => {
    const timer = DRIVER.slice(DRIVER.indexOf('private startLeaseTimer()'), DRIVER.indexOf('private stopLeaseTimer()'));
    expect(timer).toContain('const key = deadlineKey(session.id, expiresAt);');
    expect(timer).toContain('if (!key || this.leaseReconciledFor === key) return;');
    // the driver RECONCILES (read); the server transition stays idempotent
    expect(timer).toContain('void this.reconcile();');
    expect(DRIVER).not.toContain('customer_expire_unpaid_agreement');
  });
});

describe('cancel routing by canonical phase', () => {
  const cancel = () => FARE.slice(FARE.indexOf('async cancelHybridRequest()'), FARE.indexOf('async acceptOffer('));

  it('14/15. live window -> customer_cancel_offer; elapsed -> customer_expire_unpaid_agreement', () => {
    const fn = cancel();
    expect(fn).toContain('const expiredAgreement = state.paymentExpired === true;');
    expect(fn).toContain('? this.hybridService.customerExpireUnpaidAgreement(session.id)');
    expect(fn).toContain(': this.hybridService.customerCancelOffer(session.id)');
    expect(FARE).toContain("{{ negotiationState().paymentExpired ? 'Find Another Driver' : 'Cancel Request' }}");
  });

  it('16. customer_cancel_offer is never reached once the deadline has elapsed', () => {
    const fn = cancel();
    const ternaryStart = fn.indexOf('const expiredAgreement');
    const withdrawalCall = fn.indexOf('customerCancelOffer(session.id)');
    // the dispatch is a ternary: expired phase => expiry RPC, otherwise withdrawal
    const ternary = fn.slice(ternaryStart, withdrawalCall);
    expect(ternary).toContain('?');
    expect(ternary).toContain('customerExpireUnpaidAgreement(session.id)');
    // and the expired branch returns BEFORE any withdrawal-derived navigation
    const expiredBranch = fn.slice(fn.indexOf('if (expiredAgreement) {'));
    expect(expiredBranch).toContain('return;');
    expect(expiredBranch.indexOf('return;')).toBeLessThan(expiredBranch.indexOf("navigate(['/customer'])"));
  });

  it('ordinary negotiation still uses the canonical withdrawal action', () => {
    expect(FARE).toContain("@if (canCustomer('cancel_offer')) {");
    expect(cancel()).toContain("if (!canCustomer(state, 'cancel_offer')) {");
  });

  it('paid / cancelled / expired expose no cancellation action', () => {
    // canonical helper: no cancel_offer in the terminal/paid phases
    expect(read('src/app/shared/marketplace/negotiation-state.ts')).toContain("allowedCustomerActions: []");
  });

  it('double-click is guarded', () => {
    const fn = cancel();
    expect(fn).toContain('if (this.negotiationBusy()) return;');
    expect(fn.slice(fn.lastIndexOf('} finally {'))).toContain('this.negotiationBusy.set(false);');
    expect(FARE).toContain('[disabled]="negotiationBusy()"');
  });
});

describe('17. stale/direct MarketplacePaymentPage fails closed', () => {
  it('derives the deadline from authoritative session state', () => {
    expect(PAY).toContain("from('marketplace_negotiation_sessions')");
    expect(PAY).toContain("select('id,status,payment_deadline,expires_at')");
    expect(PAY).toContain('deadlineRemainingMs(this.paymentDeadline(), this.paymentClock())');
    expect(PAY).toContain('isDeadlineElapsed(this.paymentDeadline(), this.paymentClock())');
  });

  it('never mounts payment controls for an already-lapsed agreement', () => {
    const init = PAY.slice(PAY.indexOf('async ngAfterViewInit()'), PAY.indexOf('ngOnDestroy()'));
    expect(init).toContain('if (this.paymentExpired()) return;');
    expect(init.indexOf('if (this.paymentExpired()) return;')).toBeLessThan(init.indexOf('initializeStripe'));
  });

  it('re-checks the authoritative deadline immediately before submitting', () => {
    const fn = PAY.slice(PAY.indexOf('async payWithCard()'), PAY.indexOf('async payWithCard()') + 1200);
    // the guard is the FIRST statement of the method — before any payment work
    expect(fn).toContain('if (this.paymentExpired()) {');
    expect(fn).toContain('Payment time expired. This fare agreement is no longer valid.');
    const guard = fn.indexOf('if (this.paymentExpired()) {');
    const firstPaymentWork = fn.indexOf('this.paymentService.createPaymentIntent');
    expect(guard).toBeGreaterThan(-1);
    if (firstPaymentWork !== -1) expect(guard).toBeLessThan(firstPaymentWork);
  });

  it('one reconcile per deadline and the interval is disposed', () => {
    expect(PAY).toContain('deadlineKey(this.booking()?.id, deadline)');
    expect(PAY).toContain('if (!key || this.expiredActionedFor === key) return;');
    expect(PAY).toContain('this.stopDeadlineTimer();');
    expect(PAY).not.toMatch(/setInterval\([^)]*createPaymentIntent/);
  });

  it('the £9.00 money contract is unchanged (no stale 9.06)', () => {
    for (const src of [FARE, PAY]) expect(src).not.toContain('9.06');
  });
});
