/**
 * NEGOTIATION ROUND-TRIP hardening.
 *
 * Three proven live defects:
 *  #1 "Send Offer" always dispatched create_customer_offer, so a customer counter
 *     after a driver counter was rejected with
 *     'An offer is already awaiting a response for this request'.
 *  #2 the customer page subscribed only when a session ALREADY existed at entry,
 *     so a driver counter never pushed and required leave/re-enter.
 *  #3 "Sending offer..." was dismissed only on the success path, so a rejected RPC
 *     left the overlay up indefinitely.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  getNegotiationState,
  type NegotiationEventLike,
  type NegotiationSessionLike
} from '../app/shared/marketplace/negotiation-state';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const CUSTOMER = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
const DRIVER = read('src/app/apps/mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page.ts');
const SERVICE = read('src/app/core/services/marketplace/marketplace-hybrid.service.ts');

const submitOffer = () => CUSTOMER.slice(CUSTOMER.indexOf('async submitHybridOffer()'), CUSTOMER.indexOf('private hybridRealtimeDispose'));
const driverSubmit = () => DRIVER.slice(DRIVER.indexOf('async startNegotiation()'), DRIVER.indexOf('private async showToast('));

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const future = () => new Date(NOW + 120_000).toISOString();
const past = () => new Date(NOW - 30_000).toISOString();
const DRIVER_ID = 'driver-1';

const session = (o: Partial<NegotiationSessionLike> = {}): NegotiationSessionLike => ({
  status: 'negotiating',
  active_driver_id: DRIVER_ID,
  customer_offer: 6.67,
  driver_counter_offer: null,
  agreed_fare: null,
  round_count: 1,
  expires_at: future(),
  ...o
});
const ev = (role: 'customer' | 'driver', type: string, at: string): NegotiationEventLike =>
  ({ event_type: type, proposed_by_role: role, created_at: at });

describe('#1 turn-aware customer dispatch', () => {
  it('3. existing session + customer_turn dispatches customer_counter_offer, NOT create_customer_offer', () => {
    const fn = submitOffer();
    expect(fn).toContain("const isCustomerCounter = !!session && phase === 'customer_turn';");
    expect(fn).toContain('await this.hybridService.customerCounterOffer(session!.id, amount)');
    expect(fn).toContain('await this.hybridService.createCustomerOffer(job.id, amount)');
    // the counter branch is selected by isCustomerCounter, the create branch is the else
    expect(fn.indexOf('isCustomerCounter')).toBeGreaterThan(-1);
    expect(fn).toContain('? await this.hybridService.customerCounterOffer');
    expect(fn).toContain(': await this.hybridService.createCustomerOffer');
  });

  it('1. the initial proposal (no session) still uses create_customer_offer', () => {
    const fn = submitOffer();
    // dispatch is driven by persisted session + canonical phase, not a local flag
    expect(fn).toContain('const session = this.hybridSession();');
    expect(fn).toContain('const phase = this.negotiationState().phase;');
  });

  it('4/16. waiting_for_driver / driver_turn / terminal phases refuse a new proposal', () => {
    const fn = submitOffer();
    expect(fn).toContain("if (session && !isCustomerCounter && phase !== 'not_started') {");
    expect(fn).toContain("'Your offer is already awaiting a response.'");
    expect(fn).toContain("'This negotiation has expired.'");
    expect(fn).toContain("'This negotiation has ended.'");
    // refusal path reconciles authoritative state before messaging
    expect(fn.indexOf('await this.reconcileHybridNegotiation(job.id);')).toBeLessThan(
      fn.indexOf("'Your offer is already awaiting a response.'")
    );
  });

  it('uses canonical getNegotiationState only (no local turn booleans)', () => {
    expect(CUSTOMER).toContain('getNegotiationState(this.hybridSession(), this.hybridEvents()');
    expect(submitOffer()).not.toContain('this.showCounterInput()');
  });
});

describe('#3 loading cleanup can never leak', () => {
  it('12. "Sending offer..." is dismissed in finally on the RPC-rejection path', () => {
    const fn = submitOffer();
    const finallyIdx = fn.lastIndexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(-1);
    const finallyBlock = fn.slice(finallyIdx);
    expect(finallyBlock).toContain('await loading.dismiss();');
    expect(finallyBlock).toContain('this.negotiationBusy.set(false);');
    // dismissal is guarded so a double dismiss cannot throw out of finally
    expect(finallyBlock).toContain('catch { /* already dismissed */ }');
  });

  it('13. a controlled rejection reconciles authoritative state (catch)', () => {
    const fn = submitOffer();
    const catchBlock = fn.slice(fn.indexOf('} catch (error)'), fn.lastIndexOf('} finally {'));
    expect(catchBlock).toContain("showToast('Unable to send offer. Please try again.', 'danger')");
    expect(catchBlock).toContain('await this.reconcileHybridNegotiation(jobId);');
  });

  it('14. every driver mutation releases loading in finally', () => {
    const fn = driverSubmit();
    for (const fnName of ['startNegotiation', 'acceptSuggested', 'pass']) {
      const start = fn.indexOf(`async ${fnName}(`);
      expect(start, fnName).toBeGreaterThan(-1);
      const next = fn.indexOf('async ', start + 10);
      const body = fn.slice(start, next === -1 ? undefined : next);
      const finallyIdx = body.lastIndexOf('} finally {');
      expect(finallyIdx, fnName).toBeGreaterThan(-1);
      expect(body.slice(finallyIdx), fnName).toContain('loading.dismiss()');
    }
    // and mutationBusy is released for the busy-guarded mutations
    expect(driverSubmit()).toContain('this.mutationBusy.set(false);');
  });

  it('double-submit is blocked while a mutation is pending', () => {
    expect(submitOffer()).toContain('if (this.negotiationBusy()) return;');
    expect(driverSubmit()).toContain('if (this.mutationBusy()) return;');
  });
});

describe('#2 realtime convergence', () => {
  it('the shared service primitive subscribes to session + events and coalesces', () => {
    expect(SERVICE).toContain('subscribeToNegotiation(sessionId: string, onReload: () => void): () => void {');
    expect(SERVICE).toContain('const sessionChannel = this.subscribeToSession(sessionId, schedule);');
    expect(SERVICE).toContain('const eventsChannel = this.subscribeToEvents(sessionId, schedule);');
    // coalescing: a session write + event insert for one transition => one reload
    expect(SERVICE).toContain('if (coalesced) return;');
    expect(SERVICE).toContain('coalesced = true;');
    // returns a disposer for caller-owned teardown
    expect(SERVICE).toContain('return () => {');
    expect(SERVICE).toContain('sessionChannel?.unsubscribe();');
    expect(SERVICE).toContain('eventsChannel?.unsubscribe();');
  });

  it('6. customer page reloads authoritatively from the subscription (driver counter appears)', () => {
    expect(CUSTOMER).toContain('this.hybridService.subscribeToNegotiation(sessionId, () => {');
    expect(CUSTOMER).toContain('void this.reconcileHybridNegotiation(jobId);');
    // subscription is established from the RECONCILED session, so it also covers
    // the "no session existed at page entry" case
    expect(CUSTOMER).toContain('this.ensureHybridSubscription(session);');
    expect(CUSTOMER).toContain('private subscribeToHybridSession(jobId: string): void {');
    expect(CUSTOMER).toContain('void this.reconcileHybridNegotiation(jobId);');
  });

  it('7. driver page reloads authoritatively from the subscription (customer counter appears)', () => {
    expect(DRIVER).toContain('this.hybridService.subscribeToNegotiation(sessionId, () => {');
    expect(DRIVER).toContain('void this.reconcile();');
  });

  it('10. re-entry creates only ONE active subscription (idempotent per session)', () => {
    for (const src of [CUSTOMER, DRIVER]) {
      expect(src).toMatch(/if \((?:this\.hybridRealtimeSessionId|this\.realtimeSessionId) === sessionId && this\.(?:hybridRealtimeDispose|realtimeDispose)\) return;/);
    }
  });

  it('8. no duplicate channels after re-entry (dispose before re-subscribe)', () => {
    expect(CUSTOMER).toContain('this.disposeHybridSubscription();');
    expect(DRIVER).toContain('this.disposeRealtimeSubscription();');
    // dispose clears the tracked session id so the next ensure re-arms cleanly
    expect(CUSTOMER).toContain('this.hybridRealtimeSessionId = null;');
    expect(DRIVER).toContain('this.realtimeSessionId = null;');
  });

  it('9. subscriptions are disposed on page teardown', () => {
    const customerDestroy = CUSTOMER.slice(CUSTOMER.indexOf('ngOnDestroy()'), CUSTOMER.indexOf('ngOnDestroy()') + 900);
    expect(customerDestroy).toContain('this.disposeHybridSubscription();');
    const driverDestroy = DRIVER.slice(DRIVER.indexOf('ngOnDestroy()'), DRIVER.indexOf('ngOnDestroy()') + 300);
    expect(driverDestroy).toContain('this.disposeRealtimeSubscription();');
  });

  it('11. a stale async reload cannot overwrite newer state', () => {
    expect(CUSTOMER).toContain('private hybridReloadToken = 0;');
    expect(CUSTOMER).toContain('const token = ++this.hybridReloadToken;');
    expect(CUSTOMER).toContain('if (token !== this.hybridReloadToken) return;');
    expect(DRIVER).toContain('private reloadToken = 0;');
    expect(DRIVER).toContain('const token = ++this.reloadToken;');
    expect(DRIVER).toContain('if (token !== this.reloadToken) return;');
  });

  it('no polling is introduced', () => {
    for (const src of [CUSTOMER, DRIVER, SERVICE]) {
      expect(src).not.toContain('setInterval(() => this.reconcile');
    }
  });
});

describe('canonical round-trip state (no client lifecycle rules)', () => {
  it('2/5. driver counter then customer counter move the turn canonically', () => {
    // driver counter is live -> customer's turn
    const afterDriver = getNegotiationState(
      session({ driver_counter_offer: 7.0 }),
      [ev('customer', 'customer_offer', '2026-10-03T11:58:00.000Z'), ev('driver', 'driver_counter', '2026-10-03T11:59:00.000Z')],
      NOW);
    expect(afterDriver.phase).toBe('customer_turn');
    expect(afterDriver.allowedCustomerActions).toEqual(['accept', 'counter', 'decline']);

    // customer counters -> driver's turn (driver_counter_offer cleared by the RPC)
    const afterCustomer = getNegotiationState(
      session({ customer_offer: 7.2, driver_counter_offer: null }),
      [ev('driver', 'driver_counter', '2026-10-03T11:59:00.000Z'), ev('customer', 'customer_offer', '2026-10-03T11:59:30.000Z')],
      NOW);
    expect(afterCustomer.phase).toBe('driver_turn');
    expect(afterCustomer.allowedDriverActions).toEqual(['accept', 'counter', 'release']);
  });

  it('16. expired and terminal sessions offer no countering action', () => {
    expect(getNegotiationState(session({ expires_at: past() }), [], NOW).allowedDriverActions).toEqual([]);
    expect(getNegotiationState(session({ status: 'customer_declined' }), [], NOW).allowedDriverActions).toEqual([]);
    expect(getNegotiationState(session({ status: 'fare_agreed' }), [], NOW).allowedDriverActions).toEqual([]);
  });

  it('15. max-round authority stays server-side (no client round arithmetic)', () => {
    // the client never decides rounds; the RPC enforces maxRounds
    expect(CUSTOMER).not.toContain('maxRounds');
    expect(DRIVER).not.toContain('maxRounds');
  });

  it('18. migration 320 eligibility parity is untouched by this pass', () => {
    const m320 = read('supabase/migrations/20261232000000_negotiation_eligibility_parity.sql');
    expect(m320).toContain('public.driver_vehicle_can_accept_job');
    expect(m320).toContain("RAISE EXCEPTION 'You are not eligible for this service'");
    // no NEW negotiation statuses were invented anywhere
    expect(CUSTOMER).not.toContain("'driver_waiting'");
    expect(DRIVER).not.toContain("'driver_waiting'");
  });
});
