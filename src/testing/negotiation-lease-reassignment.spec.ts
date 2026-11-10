/**
 * NEGOTIATION LEASE / REASSIGNMENT hardening (frontend contract).
 *
 * Proven live defects:
 *  - `session.expires_at` (the per-driver lease) lapsed while the OVERALL request
 *    was still live, and nothing released the claimed session, so the request was
 *    neither actionable (expired) nor discoverable (active_driver_id still set).
 *  - the canonical state computed never re-derived at local expiry, so a stale
 *    driver counter stayed actionable.
 *  - "Try Another Driver" invoked the DRIVER-owned release RPC.
 *
 * The SQL side (lease release + refresh) is runtime-verified against a faithful
 * clone; these pin the client contract.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { getNegotiationState, type NegotiationSessionLike } from '../app/shared/marketplace/negotiation-state';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const CUSTOMER = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
const DRIVER = read('src/app/apps/mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page.ts');
const MIG = read('supabase/migrations/20261234000000_negotiation_lease_release.sql');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const future = () => new Date(NOW + 90_000).toISOString();
const past = () => new Date(NOW - 1_000).toISOString();

describe('6. "Try Another Driver" uses CUSTOMER authority', () => {
  const fn = () => CUSTOMER.slice(CUSTOMER.indexOf('async tryAnotherDriver()'), CUSTOMER.indexOf('async cancelHybridRequest()'));

  it('calls customerDeclineCounter, never the driver-owned release RPC', () => {
    expect(fn()).toContain('this.hybridService.customerDeclineCounter(session.id)');
    // the driver-owned release is never INVOKED from this customer action
    expect(fn()).not.toContain('this.hybridService.releaseSession');
    expect(fn()).not.toContain("rpc('release_marketplace_negotiation'");
  });

  it('keeps the request live and reconciles authoritatively', () => {
    expect(fn()).toContain('await this.reconcileHybridNegotiation(session.job_id);');
    expect(fn()).toContain("showToast('Looking for another driver.', 'success')");
  });

  it('releases busy and reconciles even on failure', () => {
    expect(fn()).toContain('this.negotiationBusy.set(false);');
    const catchBlock = fn().slice(fn().indexOf('} catch (error)'));
    expect(catchBlock).toContain('reconcileHybridNegotiation');
  });
});

describe('7. timer convergence — canonical state reacts at lease expiry', () => {
  it('the customer canonical state is fed a wall-clock tick', () => {
    expect(CUSTOMER).toContain('getNegotiationState(this.hybridSession(), this.hybridEvents(), this.negotiationClock())');
    expect(CUSTOMER).toContain('private negotiationClock = signal<number>(Date.now());');
  });

  it('the driver canonical state is fed a wall-clock tick', () => {
    expect(DRIVER).toContain('getNegotiationState(this.session(), this.events(), this.leaseClock())');
    expect(DRIVER).toContain('private leaseClock = signal<number>(Date.now());');
  });

  it('expiry triggers exactly ONE authoritative reconcile per lapsed lease (no polling loop)', () => {
    for (const src of [CUSTOMER, DRIVER]) {
      expect(src).toContain('this.leaseReconciledFor = key;');
      expect(src).toMatch(/if \(!key \|\| this\.leaseReconciledFor === key\) return;/);
      // the timer re-arms only when the lease is live again
      expect(src).toContain('this.leaseReconciledFor = null;');
    }
    // no continuous database polling was introduced
    expect(CUSTOMER).not.toMatch(/setInterval\([^)]*reconcileHybridNegotiation\(/);
    expect(DRIVER).not.toMatch(/setInterval\([^)]*reconcile\(/);
  });

  it('lease timers are started and torn down with the page', () => {
    expect(CUSTOMER).toContain('this.startLeaseTimer();');
    expect(CUSTOMER).toContain('this.stopLeaseTimer();');
    expect(DRIVER).toContain('this.startLeaseTimer();');
    expect(DRIVER).toContain('this.stopLeaseTimer();');
  });

  it('a lapsed lease removes the stale driver counter from the actionable set', () => {
    const s: NegotiationSessionLike = {
      status: 'negotiating', active_driver_id: 'driver-a',
      customer_offer: 6.67, driver_counter_offer: 10.0,
      agreed_fare: null, round_count: 2, expires_at: past()
    };
    const expired = getNegotiationState(s, [], NOW);
    expect(expired.phase).toBe('expired');
    expect(expired.allowedCustomerActions).toEqual([]);
    expect(expired.allowedDriverActions).toEqual([]);

    // same session while the lease is still live => actionable
    const live = getNegotiationState({ ...s, expires_at: future() }, [], NOW);
    expect(live.phase).toBe('customer_turn');
    expect(live.allowedCustomerActions).toContain('accept');
  });
});

describe('8. SQL lease model (runtime-verified shape)', () => {
  it('defines ONE effective-expiry rule capped by the overall job deadline', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.negotiation_lease_expiry(');
    expect(MIG).toContain('RETURN LEAST(now() + v_lease, v_deadline);');
    expect(MIG).toContain('FROM public.jobs');
  });

  it('the release clears the stale driver counter but RETAINS the customer offer', () => {
    const releaser = MIG.slice(MIG.indexOf('public.release_stale_negotiation_lease('), MIG.indexOf('2. DISCOVERY'));
    expect(releaser).toContain('active_driver_id = NULL,');
    expect(releaser).toContain('driver_counter_offer = NULL,');
    expect(releaser).toContain('attempt_count = attempt_count + 1,');
    expect(releaser).toContain("status = 'released',");
    // customer offer is never cleared
    expect(releaser).not.toContain('customer_offer = NULL');
  });

  it('the release re-asserts the retained customer proposal so the turn is correct', () => {
    const releaser = MIG.slice(MIG.indexOf('public.release_stale_negotiation_lease('), MIG.indexOf('2. DISCOVERY'));
    expect(releaser).toContain("'customer_offer', v_session.customer_offer, v_session.round_count, now()");
  });

  it('recycling STOPS once the overall job deadline has passed', () => {
    const releaser = MIG.slice(MIG.indexOf('public.release_stale_negotiation_lease('), MIG.indexOf('2. DISCOVERY'));
    expect(releaser).toContain("IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'open') THEN");
    expect(releaser).toContain('IF v_job.expires_at IS NOT NULL AND v_job.expires_at <= now() THEN');
  });

  it('discovery converges stale leases before listing', () => {
    expect(MIG).toContain('PERFORM public.release_stale_negotiation_lease(s.id)');
  });

  it('claim honours the EXISTING claimTimeoutSeconds config instead of a hard-coded 120', () => {
    const claim = MIG.slice(MIG.indexOf('public.claim_marketplace_negotiation('), MIG.indexOf('4. DRIVER COUNTER'));
    expect(claim).toContain("->>'claimTimeoutSeconds'");
    expect(claim).toContain('public.negotiation_lease_expiry(p_job_id, v_claim_lease)');
  });

  it('both counters refresh the lease from the existing timeoutSeconds config', () => {
    expect(MIG).toContain("->>'timeoutSeconds'");
    expect(MIG).toContain('expires_at = public.negotiation_lease_expiry(v_session.job_id, v_turn_lease),');
  });

  it('migration-320 eligibility parity is preserved inside the re-issued functions', () => {
    expect(MIG).toContain('public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)');
    expect(MIG).toContain('public.driver_vehicle_can_accept_job(p_job_id, p_driver_id)');
  });

  it('internal helpers are revoked from client roles; mutations stay authenticated-only', () => {
    expect(MIG).toContain('REVOKE EXECUTE ON FUNCTION public.release_stale_negotiation_lease(UUID) FROM anon, authenticated;');
    expect(MIG).toContain('REVOKE EXECUTE ON FUNCTION public.negotiation_lease_expiry(UUID, INTEGER) FROM anon, authenticated;');
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.customer_decline_counter(UUID) TO authenticated;');
  });

  it('no new negotiation statuses or N12/payment changes were introduced', () => {
    // no executable N12 / payment / commission statements (comments may mention them)
    expect(MIG).not.toMatch(/RAISE EXCEPTION '(MB001|MB002)/);
    expect(MIG).not.toContain('driver_occupying_statuses');
    expect(MIG).not.toMatch(/payment_status\s*=/);
    expect(MIG).not.toMatch(/commission_percent|platform_fee\s*=/);
    expect(MIG).not.toContain('stripe.paymentIntents');
  });
});
