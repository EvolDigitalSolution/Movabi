/**
 * NEGOTIATION REALTIME CONVERGENCE + "FINDING ANOTHER DRIVER" canonical state.
 *
 * Two live defects:
 *  #1 a successful driver counter never reached an open customer page. ROOT CAUSE:
 *     marketplace_negotiation_sessions / _events were never added to the
 *     `supabase_realtime` PUBLICATION, so the correctly-scoped client
 *     subscription could never receive a WAL event. Fixed by migration 350.
 *  #2 after a lease expiry/release the retained customer offer was still
 *     authoritative, but the UI exposed the initial Send Offer form again.
 *     Fixed canonically (awaitingNextDriver) + a canonical gate on the form.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  canCustomer,
  getNegotiationState,
  isLiveOwnedNegotiation,
  type NegotiationEventLike,
  type NegotiationSessionLike
} from '../app/shared/marketplace/negotiation-state';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const CUSTOMER = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
const SERVICE = read('src/app/core/services/marketplace/marketplace-hybrid.service.ts');
const MIG350 = read('supabase/migrations/20261235000000_negotiation_realtime_publication.sql');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const future = () => new Date(NOW + 80_000).toISOString();
const past = () => new Date(NOW - 1_000).toISOString();
const A = 'driver-a';
const B = 'driver-b';

const session = (o: Partial<NegotiationSessionLike> = {}): NegotiationSessionLike => ({
  status: 'negotiating', active_driver_id: A, customer_offer: 8.15,
  driver_counter_offer: null, agreed_fare: null, round_count: 1,
  expires_at: future(), ...o
});
const ev = (role: 'customer' | 'driver', type: string, at: string): NegotiationEventLike =>
  ({ event_type: type, proposed_by_role: role, created_at: at });

describe('A/G. customer converges to the driver counter via canonical state', () => {
  it('a live driver counter renders customer_turn with the counter actionable', () => {
    const s = session({ driver_counter_offer: 10.0, round_count: 2 });
    const state = getNegotiationState(s, [
      ev('customer', 'customer_offer', '2026-10-03T11:58:00.000Z'),
      ev('driver', 'driver_counter', '2026-10-03T11:59:00.000Z')
    ], NOW);
    expect(state.phase).toBe('customer_turn');
    expect(state.pendingOffer).toEqual({ by: 'driver', amount: 10.0 });
    expect(state.allowedCustomerActions).toEqual(['accept', 'counter', 'decline']);
    expect(state.awaitingNextDriver).toBeFalsy();
  });

  it('the same counter is reachable from the session FIELDS alone (event ledger not required)', () => {
    const state = getNegotiationState(session({ driver_counter_offer: 10.0 }), [], NOW);
    expect(state.phase).toBe('customer_turn');
    expect(state.pendingOffer).toEqual({ by: 'driver', amount: 10.0 });
  });

  it('the reload is AUTHORITATIVE (subscription requests a reload, never injects state)', () => {
    expect(SERVICE).toContain('subscribeToNegotiation(sessionId: string, onReload: () => void): () => void {');
    expect(CUSTOMER).toContain('this.hybridService.subscribeToNegotiation(sessionId, () => {');
    expect(CUSTOMER).toContain('void this.reconcileHybridNegotiation(jobId);');
    // the callback does not write a payload-derived session
    const sub = CUSTOMER.slice(CUSTOMER.indexOf('this.hybridService.subscribeToNegotiation(sessionId, () => {'));
    expect(sub.slice(0, 400)).not.toContain('.set(payload');
  });
});

describe('B/C. subscription lifecycle', () => {
  it('B. the subscription is armed from the RECONCILED session (works when none existed at load)', () => {
    // enter-time convergence always reconciles first, then arms the subscription
    const enter = CUSTOMER.slice(CUSTOMER.indexOf('private subscribeToHybridSession('), CUSTOMER.indexOf('private isPaymentHandled('));
    expect(enter).toContain('void this.reconcileHybridNegotiation(jobId);');
    const reconcile = CUSTOMER.slice(CUSTOMER.indexOf('private async reconcileHybridNegotiation('), CUSTOMER.indexOf('private ensureHybridSubscription('));
    expect(reconcile).toContain('this.ensureHybridSubscription(session);');
    // and a successful create re-arms it through the same reconcile
    expect(CUSTOMER).toContain('await this.reconcileHybridNegotiation(job.id);');
  });

  it('C. re-entry / reload cannot create a duplicate channel (idempotent per session)', () => {
    expect(CUSTOMER).toContain('if (this.hybridRealtimeSessionId === sessionId && this.hybridRealtimeDispose) return;');
    expect(CUSTOMER).toContain('this.disposeHybridSubscription();');
    expect(CUSTOMER).toContain('this.hybridRealtimeSessionId = null;');
  });

  it('subscriptions are disposed with the page', () => {
    expect(CUSTOMER).toContain('this.disposeHybridSubscription();');
    expect(CUSTOMER.slice(CUSTOMER.indexOf('ngOnDestroy()'), CUSTOMER.indexOf('ngOnDestroy()') + 900))
      .toContain('this.disposeHybridSubscription();');
  });
});

describe('D. stale/out-of-order reload cannot regress the UI', () => {
  it('a monotonic token discards a superseded reload after every await', () => {
    expect(CUSTOMER).toContain('const token = ++this.hybridReloadToken;');
    const reconcile = CUSTOMER.slice(CUSTOMER.indexOf('private async reconcileHybridNegotiation('), CUSTOMER.indexOf('private ensureHybridSubscription('));
    const guards = reconcile.split('if (token !== this.hybridReloadToken) return;').length - 1;
    expect(guards).toBeGreaterThanOrEqual(3);
  });
});

describe('E/F/H. reassignment canonical state', () => {
  it('E. released + retained offer is FINDING ANOTHER DRIVER, never not_started', () => {
    const released = getNegotiationState(session({ status: 'released', active_driver_id: null }), [], NOW);
    expect(released.phase).toBe('waiting_for_driver');
    expect(released.awaitingNextDriver).toBe(true);
    expect(released.pendingOffer).toEqual({ by: 'customer', amount: 8.15 });
    // cancel allowed, a fresh initial offer is NOT
    expect(canCustomer(released, 'cancel_offer')).toBe(true);
    expect(canCustomer(released, 'make_offer')).toBe(false);
    expect(released.allowedCustomerActions).not.toContain('make_offer');
  });

  it('E2. released WITHOUT a retained offer is genuinely fresh (make_offer allowed)', () => {
    const fresh = getNegotiationState(session({ status: 'released', active_driver_id: null, customer_offer: null }), [], NOW);
    expect(fresh.phase).toBe('not_started');
    expect(fresh.awaitingNextDriver).toBeFalsy();
    expect(canCustomer(fresh, 'make_offer')).toBe(true);
  });

  it('E3. the offer form is canonically gated so create_customer_offer is unreachable', () => {
    const open = CUSTOMER.slice(CUSTOMER.indexOf('openHybridOfferInput() {'), CUSTOMER.indexOf('async submitHybridOffer()'));
    expect(open).toContain("if (!canCustomer(state, 'make_offer') && !canCustomer(state, 'counter')) {");
    expect(open).toContain("'Finding another driver for your offer.'");
    expect(open).toContain("'Your offer is already awaiting a response.'");
  });

  it('F. after B claims, the retained offer is preserved and stale A identity is gone', () => {
    const afterB = getNegotiationState(session({ active_driver_id: B, driver_counter_offer: null }), [
      ev('customer', 'customer_offer', '2026-10-03T11:59:30.000Z')
    ], NOW);
    expect(afterB.phase).toBe('driver_turn');
    expect(afterB.pendingOffer).toEqual({ by: 'customer', amount: 8.15 });
    expect(afterB.allowedDriverActions).toEqual(['accept', 'counter', 'release']);
    expect(afterB.awaitingNextDriver).toBeFalsy();
    // and a driver-owned B session is still a live owned negotiation (recovery intact)
    expect(isLiveOwnedNegotiation(session({ active_driver_id: B }), B, [], NOW)).toBe(true);
  });

  it('H. Try Another Driver uses the CUSTOMER authority only', () => {
    const fn = CUSTOMER.slice(CUSTOMER.indexOf('async tryAnotherDriver()'), CUSTOMER.indexOf('async cancelHybridRequest()'));
    expect(fn).toContain('this.hybridService.customerDeclineCounter(session.id)');
    expect(fn).not.toContain('this.hybridService.releaseSession');
  });

  it('E4. the finding-another-driver presentation is canonical, not a button hide', () => {
    expect(CUSTOMER).toContain('readonly awaitingNextDriver = computed<boolean>(() => this.negotiationState().awaitingNextDriver === true);');
    expect(CUSTOMER).toContain("{{ awaitingNextDriver() ? 'Finding another driver…' : 'Waiting for a driver response.' }}");
  });

  it('the driver-counter controls are gated by canonical actions, so a lapsed counter is not actionable', () => {
    expect(CUSTOMER).toContain("@if (canCustomer('accept') || canCustomer('decline')) {");
    expect(CUSTOMER).toContain("@if (canCustomer('counter')) {");
    expect(CUSTOMER).toContain("@if (canCustomer('decline')) {");
  });

  it('a lapsed lease removes every customer action (stale £10 counter not actionable)', () => {
    const lapsed = getNegotiationState(session({ driver_counter_offer: 10.0, expires_at: past() }), [], NOW);
    expect(lapsed.phase).toBe('expired');
    expect(lapsed.allowedCustomerActions).toEqual([]);
    expect(canCustomer(lapsed, 'accept')).toBe(false);
    expect(canCustomer(lapsed, 'counter')).toBe(false);
  });
});

describe('I/J. timer convergence + loading cleanup', () => {
  it('I. exactly one reconcile per lapsed lease and no polling', () => {
    expect(CUSTOMER).toContain('const key = deadlineKey(session.id, expiresAt);');
    expect(CUSTOMER).toContain('if (!key || this.leaseReconciledFor === key) return;');
    expect(CUSTOMER).toContain('this.leaseReconciledFor = null;');
    expect(CUSTOMER).not.toMatch(/setInterval\([^)]*reconcileHybridNegotiation\(/);
  });

  it('J. the Send Offer overlay is dismissed in finally on every path', () => {
    const submit = CUSTOMER.slice(CUSTOMER.indexOf('async submitHybridOffer()'), CUSTOMER.indexOf('private hybridRealtimeDispose'));
    const finallyBlock = submit.slice(submit.lastIndexOf('} finally {'));
    expect(finallyBlock).toContain('await loading.dismiss();');
    expect(finallyBlock).toContain('this.negotiationBusy.set(false);');
  });
});

describe('migration 350 — Realtime publication enrollment (SQL contract)', () => {
  it('enrolls BOTH negotiation tables in supabase_realtime, idempotently', () => {
    expect(MIG350).toContain("pg_publication WHERE pubname = 'supabase_realtime'");
    expect(MIG350).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_negotiation_sessions;');
    expect(MIG350).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_negotiation_events;');
    // guarded so a re-run / non-Realtime environment is a clean no-op
    expect(MIG350).toContain('FROM pg_publication_tables');
    expect(MIG350).toContain('RETURN;');
  });

  it('changes no RLS, schema, function or prior migration', () => {
    for (const forbidden of ['CREATE POLICY', 'DROP POLICY', 'ALTER TABLE', 'CREATE OR REPLACE FUNCTION', 'GRANT ', 'REVOKE ']) {
      expect(MIG350, forbidden).not.toContain(forbidden);
    }
  });

  it('does not touch migrations 340 / payment / N12 semantics', () => {
    expect(MIG350).not.toContain('release_stale_negotiation_lease');
    expect(MIG350).not.toContain('payment_status');
    expect(MIG350).not.toContain('MB001');
  });
});
