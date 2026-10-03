/**
 * DRIVER RECOVERED-NEGOTIATION regression.
 *
 * A driver who already owns a live marketplace negotiation must be able to reopen
 * it even when the ancillary driver-side `jobs` SELECT is filtered by production
 * RLS (jobs.driver_id still NULL, job status pending_fare_confirmation), which
 * leaves `effectiveHybridStatus` UNKNOWN. Unknown must not be treated as
 * explicitly-disabled, and recovery must be authorised ONLY by canonical
 * persisted session state.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  getNegotiationState,
  isLiveOwnedNegotiation,
  isTerminalNegotiationPhase,
  type NegotiationEventLike,
  type NegotiationSessionLike
} from '../app/shared/marketplace/negotiation-state';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const PAGE = read('src/app/apps/mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page.ts');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const future = () => new Date(NOW + 120_000).toISOString();
const past = () => new Date(NOW - 30_000).toISOString();
const DRIVER = 'driver-1';

const session = (o: Partial<NegotiationSessionLike> = {}): NegotiationSessionLike => ({
  status: 'negotiating',
  active_driver_id: DRIVER,
  customer_offer: 6.67,
  driver_counter_offer: null,
  agreed_fare: null,
  round_count: 1,
  expires_at: future(),
  ...o
});
const ev = (role: 'customer' | 'driver', type: string): NegotiationEventLike =>
  ({ event_type: type, proposed_by_role: role, created_at: '2026-10-03T11:59:00.000Z' });

describe('isLiveOwnedNegotiation — authoritative recovery predicate', () => {
  it('1. owned + live session (jobs read unavailable) is recoverable', () => {
    expect(isLiveOwnedNegotiation(session(), DRIVER, [], NOW)).toBe(true);
  });

  it('1b. recoverable with and without an event ledger (ledger is not required)', () => {
    expect(isLiveOwnedNegotiation(session(), DRIVER, [], NOW)).toBe(true);
    expect(isLiveOwnedNegotiation(session(), DRIVER, [ev('customer', 'customer_offer')], NOW)).toBe(true);
  });

  it('3. active_driver_id != authenticated driver fails closed', () => {
    expect(isLiveOwnedNegotiation(session({ active_driver_id: 'other-driver' }), DRIVER, [], NOW)).toBe(false);
  });

  it('3b. missing/blank ownership fails closed', () => {
    expect(isLiveOwnedNegotiation(session({ active_driver_id: null }), DRIVER, [], NOW)).toBe(false);
    expect(isLiveOwnedNegotiation(session({ active_driver_id: '' }), DRIVER, [], NOW)).toBe(false);
    expect(isLiveOwnedNegotiation(session(), null, [], NOW)).toBe(false);
    expect(isLiveOwnedNegotiation(session(), '', [], NOW)).toBe(false);
  });

  it('4. expired owned session fails closed (expires_at in the past)', () => {
    expect(isLiveOwnedNegotiation(session({ expires_at: past() }), DRIVER, [], NOW)).toBe(false);
  });

  it('4b. status=expired fails closed even while still owned', () => {
    expect(isLiveOwnedNegotiation(session({ status: 'expired', expires_at: future() }), DRIVER, [], NOW)).toBe(false);
  });

  it('5. terminal owned sessions fail closed (declined / paid / fare_agreed)', () => {
    for (const status of ['customer_declined', 'driver_declined', 'paid', 'payment_pending', 'fare_agreed']) {
      expect(isLiveOwnedNegotiation(session({ status }), DRIVER, [], NOW), status).toBe(false);
    }
  });

  it('6. missing session fails closed', () => {
    expect(isLiveOwnedNegotiation(null, DRIVER, [], NOW)).toBe(false);
  });

  it('terminal-phase predicate matches the canonical helper (no second rule list)', () => {
    expect(isTerminalNegotiationPhase('expired')).toBe(true);
    expect(isTerminalNegotiationPhase('cancelled')).toBe(true);
    expect(isTerminalNegotiationPhase('paid')).toBe(true);
    expect(isTerminalNegotiationPhase('agreed_payment_required')).toBe(true);
    expect(isTerminalNegotiationPhase('not_started')).toBe(true);
    expect(isTerminalNegotiationPhase('driver_turn')).toBe(false);
    expect(isTerminalNegotiationPhase('customer_turn')).toBe(false);
    expect(isTerminalNegotiationPhase('waiting_for_driver')).toBe(false);
  });

  it('8. recovered session exposes exactly the canonical driver actions (driver_turn)', () => {
    const s = session();
    const state = getNegotiationState(s, [ev('customer', 'customer_offer')], NOW);
    expect(state.phase).toBe('driver_turn');
    expect(state.allowedDriverActions).toEqual(['accept', 'counter', 'release']);
    expect(isLiveOwnedNegotiation(s, DRIVER, [ev('customer', 'customer_offer')], NOW)).toBe(true);
  });

  it('customer-turn negotiation is still "live/owned" (driver waits, does not fail closed)', () => {
    const s = session({ driver_counter_offer: 7.0 });
    const state = getNegotiationState(s, [ev('driver', 'driver_counter')], NOW);
    expect(state.phase).toBe('customer_turn');
    expect(isLiveOwnedNegotiation(s, DRIVER, [ev('driver', 'driver_counter')], NOW)).toBe(true);
  });
});

describe('HybridNegotiationPage recovery wiring', () => {
  const init = () => PAGE.slice(PAGE.indexOf('async ngOnInit()'), PAGE.indexOf('ngOnDestroy()'));

  it('2. recovery keeps the page open and still starts the countdown', () => {
    const fn = init();
    expect(fn).toContain('this.startCountdown();');
    // startCountdown is reached after the guard, not skipped by an early return
    expect(fn.indexOf('this.startCountdown();')).toBeGreaterThan(fn.indexOf('recoverableOwnedSession'));
  });

  it('3/4/5/6. close still happens unless the owned session is live', () => {
    const fn = init();
    expect(fn).toContain('const configurationUnknown = this.effectiveHybridStatus() === null;');
    expect(fn).toContain('const recoverableOwnedSession = configurationUnknown && isLiveOwnedNegotiation(');
    expect(fn).toContain('if (!recoverableOwnedSession) {');
    expect(fn).toContain("await this.router.navigate(['/driver']);");
  });

  it('7. explicitly disabled configuration is never converted into allowed', () => {
    const fn = init();
    // recovery is gated on the status being UNKNOWN (null), not merely falsy
    expect(fn).toContain('configurationUnknown');
    expect(fn).toContain('this.effectiveHybridStatus() === null');
    // and it must not test the truthiness of enabled alone
    expect(fn).not.toContain('!this.effectiveHybridStatus()?.enabled');
  });

  it('4/5. expiry + terminal are delegated to the canonical helper (no local status list)', () => {
    const fn = init();
    expect(fn).toContain('isLiveOwnedNegotiation(');
    // no hand-rolled lifecycle status arrays in the page
    expect(fn).not.toContain("'customer_declined'");
    expect(fn).not.toContain("'driver_declined'");
    expect(fn).not.toContain("'expired'");
  });

  it('9. reopening NEVER invokes claim_marketplace_negotiation', () => {
    const fn = init();
    expect(fn).not.toContain('claimSession');
    expect(fn).not.toContain('claimHybridSession');
    expect(fn).not.toContain('claim_marketplace_negotiation');
    // the only user-initiated claim remains startNegotiation()
    const claimCalls = PAGE.split('claimSession(').length - 1;
    expect(claimCalls).toBe(1);
    expect(PAGE).toContain('async startNegotiation()');
  });

  it('missing route id still redirects (existing behaviour preserved)', () => {
    const fn = init();
    expect(fn).toContain("const id = this.route.snapshot.paramMap.get('id');");
    expect(fn).toContain('if (!id) {');
  });

  it('6. jobDetails is NOT required after recovery (only optional display)', () => {
    // jobDistanceEta tolerates a null jobDetails
    const eta = PAGE.slice(PAGE.indexOf('jobDistanceEta(): string {'), PAGE.indexOf('formatPrice(amount:'));
    expect(eta).toContain('const job = this.jobDetails();');
    expect(eta).toContain("if (!job) return '';");
    // no other member dereferences jobDetails
    const usages = PAGE.split('this.jobDetails()').length - 1;
    expect(usages).toBe(1);
  });

  it('transitions stay session/RPC-authoritative (no jobDetails dependency)', () => {
    expect(PAGE).toContain('this.hybridService.acceptCustomerOffer(session.id)');
    expect(PAGE).toContain('this.hybridService.releaseSession(');
  });

  it('no realtime subscription is added by the recovery path', () => {
    // the page has no subscription in EITHER path, so recovery cannot diverge
    expect(PAGE).not.toContain('.subscribe(');
  });
});
