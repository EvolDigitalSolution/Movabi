/**
 * NEGOTIATION ELIGIBILITY PARITY + CANONICAL STATE + ERROR PROPAGATION.
 *
 * Covers the production-proven defects:
 *   * a BIKE-only driver could DISCOVER and CLAIM an ERRAND negotiation although
 *     ordinary acquisition correctly excludes them;
 *   * a persisted outstanding customer offer was rendered as a "fresh session"
 *     when the event ledger was empty, exposing Make an Offer next to "Offer sent";
 *   * authority rejections (P0001) were collapsed into one generic message.
 *
 * SQL assertions here are SOURCE/CONTRACT assertions. Runtime RPC behaviour was
 * validated separately against a PostgreSQL clone; these pin the source contract.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  canCustomer,
  canDriver,
  getNegotiationState,
  type NegotiationEventLike,
  type NegotiationSessionLike
} from '../app/shared/marketplace/negotiation-state';
import { mapNegotiationError, negotiationErrorMessage } from '../app/shared/marketplace/negotiation-error';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const MIG = read('supabase/migrations/20261232000000_negotiation_eligibility_parity.sql');
const RECONCILE = read('supabase_incremental_schema_reconcile.sql');
const SERVICE = read('src/app/core/services/marketplace/marketplace-hybrid.service.ts');
const DRIVER_PAGE = read('src/app/apps/mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page.ts');

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const future = () => new Date(NOW + 120_000).toISOString();
const past = () => new Date(NOW - 30_000).toISOString();

const session = (o: Partial<NegotiationSessionLike> = {}): NegotiationSessionLike => ({
  status: 'open', active_driver_id: null, customer_offer: null, driver_counter_offer: null,
  agreed_fare: null, round_count: 1, expires_at: future(), ...o
});
const ev = (role: 'customer' | 'driver', type: string, at = '2026-10-02T11:59:00.000Z'): NegotiationEventLike =>
  ({ event_type: type, proposed_by_role: role, created_at: at });

describe('PATCH 1 — eligibility + expiry parity (SQL contract)', () => {
  it('1/6. discovery applies the canonical eligibility predicate AND expiry', () => {
    const fn = MIG.slice(MIG.indexOf('public.fetch_hybrid_opportunities('), MIG.indexOf('2. CLAIM'));
    expect(fn).toContain('public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)');
    expect(fn).toContain('AND s.expires_at > now()');
    // preserved hardening
    expect(fn).toContain("RAISE EXCEPTION 'You can only fetch your own opportunities';");
    expect(fn).toContain("BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\\.[0-9]+)?$'");
    expect(fn).toContain("s.status IN ('open', 'released')");
    expect(fn).toContain('s.active_driver_id IS NULL');
  });

  it('2. claim re-checks eligibility and expiry before becoming the active driver', () => {
    const fn = MIG.slice(MIG.indexOf('public.claim_marketplace_negotiation('), MIG.indexOf('3. DRIVER COUNTER'));
    expect(fn).toContain('public.driver_vehicle_can_accept_job(p_job_id, p_driver_id)');
    expect(fn).toContain("RAISE EXCEPTION 'You are not eligible for this service'");
    expect(fn).toContain('IF v_session.expires_at <= now() THEN');
    // identity guard must survive verbatim
    expect(fn).toContain("IF auth.uid() IS NULL OR auth.uid() <> p_driver_id THEN");
    expect(fn).toContain("RAISE EXCEPTION 'You can only claim a negotiation for yourself';");
    // eligibility must be checked BEFORE the claim mutation
    expect(fn.indexOf('driver_vehicle_can_accept_job')).toBeLessThan(fn.indexOf('SET active_driver_id = p_driver_id'));
  });

  it('3. driver counter re-checks eligibility (TOCTOU, at act time)', () => {
    const fn = MIG.slice(MIG.indexOf('public.driver_counter_offer('), MIG.indexOf('4. DRIVER ACCEPT'));
    expect(fn).toContain('public.driver_vehicle_can_accept_job(v_session.job_id, v_actor)');
    expect(fn.indexOf('driver_vehicle_can_accept_job')).toBeLessThan(fn.indexOf('SET driver_counter_offer = p_amount'));
    // turn authority + max rounds preserved
    expect(fn).toContain("IS DISTINCT FROM 'customer'");
    expect(fn).toContain('Maximum negotiation rounds reached');
  });

  it('4. driver accept re-checks eligibility (TOCTOU, at act time)', () => {
    const fn = MIG.slice(MIG.indexOf('public.driver_accept_customer_offer('));
    expect(fn).toContain('public.driver_vehicle_can_accept_job(v_session.job_id, v_actor)');
    expect(fn.indexOf('driver_vehicle_can_accept_job')).toBeLessThan(fn.indexOf('SET agreed_fare = v_agreed'));
  });

  it('5. the canonical predicate itself is reused, not redefined', () => {
    // No second compatibility table/matrix is invented.
    expect(MIG).not.toContain('CREATE OR REPLACE FUNCTION public.driver_vehicle_can_accept_job');
    expect(MIG).toContain('driver_vehicle_can_accept_job');
  });

  it('6/22. the disabled Phase-A trigger and N12/MB semantics are untouched', () => {
    // No trigger is enabled by this migration (the header only *mentions* it as
    // deliberately left disabled).
    expect(MIG).not.toMatch(/ENABLE\s+TRIGGER/i);
    expect(MIG).not.toMatch(/ALTER\s+TABLE[^;]*ENABLE\s+TRIGGER/i);
    expect(MIG).not.toContain("'MB001'");
    expect(MIG).not.toContain("'MB002'");
    expect(MIG).not.toContain('driver_occupying_statuses');
  });

  it('19. expired sessions are excluded from discovery and rejected on claim', () => {
    const disc = MIG.slice(MIG.indexOf('public.fetch_hybrid_opportunities('), MIG.indexOf('2. CLAIM'));
    expect(disc).toContain('AND s.expires_at > now()');
    expect(MIG.slice(MIG.indexOf('public.claim_marketplace_negotiation('), MIG.indexOf('3. DRIVER COUNTER')))
      .toContain("RAISE EXCEPTION 'Negotiation has expired'");
  });

  it('ACL is re-asserted for every replaced function', () => {
    for (const sig of [
      'public.fetch_hybrid_opportunities(UUID)',
      'public.claim_marketplace_negotiation(UUID, UUID)',
      'public.driver_counter_offer(UUID, NUMERIC)',
      'public.driver_accept_customer_offer(UUID)'
    ]) {
      expect(MIG, sig).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
    }
  });

  it('reconcile converges: it must not restore the ineligible definition', () => {
    const fn = RECONCILE.slice(
      RECONCILE.indexOf('CREATE OR REPLACE FUNCTION public.fetch_hybrid_opportunities'),
      RECONCILE.indexOf('GRANT EXECUTE ON FUNCTION public.fetch_hybrid_opportunities')
    );
    expect(fn).toContain('public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)');
    expect(fn).toContain('AND s.expires_at > now()');
    // preserves prior hardening
    expect(fn).toContain("RAISE EXCEPTION 'You can only fetch your own opportunities';");
    expect(fn).toContain("BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\\.[0-9]+)?$'");
  });
});

describe('PATCH 2 — canonical state from persisted session (empty/stale events)', () => {
  it('11. live customer offer + EMPTY events must NOT permit make_offer', () => {
    const state = getNegotiationState(session({ status: 'open', customer_offer: 6.67 }), [], NOW);
    expect(canCustomer(state, 'make_offer')).toBe(false);
    expect(state.allowedCustomerActions).not.toContain('make_offer');
    expect(state.pendingOffer).toEqual({ by: 'customer', amount: 6.67 });
  });

  it('12. live customer offer + EMPTY events DOES permit cancel_offer', () => {
    const state = getNegotiationState(session({ status: 'open', customer_offer: 6.67 }), [], NOW);
    expect(canCustomer(state, 'cancel_offer')).toBe(true);
    expect(state.phase).toBe('waiting_for_driver');
  });

  it('13. session fields and the matching event produce the SAME canonical state', () => {
    const fromFields = getNegotiationState(session({ status: 'open', customer_offer: 6.67 }), [], NOW);
    const fromEvent = getNegotiationState(
      session({ status: 'open', customer_offer: 6.67 }),
      [ev('customer', 'customer_offer')], NOW);
    expect(fromFields.phase).toBe(fromEvent.phase);
    expect(fromFields.allowedCustomerActions).toEqual(fromEvent.allowedCustomerActions);
    expect(fromFields.pendingOffer).toEqual(fromEvent.pendingOffer);
  });

  it('claimed + live customer offer + empty events => driver turn, no customer make_offer', () => {
    const state = getNegotiationState(
      session({ status: 'negotiating', active_driver_id: 'd1', customer_offer: 6.67 }), [], NOW);
    expect(state.phase).toBe('driver_turn');
    expect(canCustomer(state, 'make_offer')).toBe(false);
    expect(canDriver(state, 'accept')).toBe(true);
  });

  it('14. live driver counter => customer accept/counter/decline only', () => {
    for (const events of [[], [ev('driver', 'driver_counter')]]) {
      const state = getNegotiationState(
        session({ status: 'negotiating', active_driver_id: 'd1', customer_offer: 6.67, driver_counter_offer: 7.0 }),
        events, NOW);
      expect(state.phase).toBe('customer_turn');
      expect(state.allowedCustomerActions).toEqual(['accept', 'counter', 'decline']);
      expect(canCustomer(state, 'make_offer')).toBe(false);
    }
  });

  it('15. released session retaining a customer offer cannot duplicate make_offer', () => {
    const state = getNegotiationState(
      session({ status: 'released', active_driver_id: null, customer_offer: 6.67 }), [], NOW);
    expect(state.phase).toBe('waiting_for_driver');
    expect(canCustomer(state, 'make_offer')).toBe(false);
    expect(canCustomer(state, 'cancel_offer')).toBe(true);
  });

  it('16. terminal session exposes no offer action (incl. with stale fields present)', () => {
    for (const status of ['customer_declined', 'driver_declined', 'paid']) {
      const state = getNegotiationState(
        session({ status, customer_offer: 6.67, driver_counter_offer: 7 }), [], NOW);
      expect([...state.allowedCustomerActions, ...state.allowedDriverActions], status).toEqual([]);
      expect(canCustomer(state, 'make_offer'), status).toBe(false);
    }
    const expired = getNegotiationState(
      session({ status: 'open', customer_offer: 6.67, expires_at: past() }), [], NOW);
    expect(expired.phase).toBe('expired');
    expect(expired.allowedCustomerActions).toEqual([]);
  });
});

describe('PATCH 4 — authority error propagation', () => {
  it('maps the duplicate/outstanding-offer rejection to actionable copy', () => {
    const mapped = mapNegotiationError({ code: 'P0001', message: 'An offer is already awaiting a response for this request' });
    expect(mapped?.code).toBe('OFFER_OUTSTANDING');
    expect(mapped?.message).toMatch(/already have an offer/i);
  });

  it('maps closed/expired, wrong-turn, eligibility, claimed and ownership rejections', () => {
    expect(mapNegotiationError({ message: 'This negotiation is already closed' })?.code).toBe('NEGOTIATION_CLOSED');
    expect(mapNegotiationError({ message: 'Negotiation has expired' })?.code).toBe('NEGOTIATION_EXPIRED');
    expect(mapNegotiationError({ message: 'There is no customer offer awaiting a response' })?.code).toBe('WRONG_TURN');
    expect(mapNegotiationError({ message: 'You are not eligible for this service' })?.code).toBe('DRIVER_NOT_ELIGIBLE_FOR_SERVICE');
    expect(mapNegotiationError({ message: 'Session already claimed' })?.code).toBe('ALREADY_CLAIMED');
    expect(mapNegotiationError({ message: 'Only the job customer can open a negotiation' })?.code).toBe('NOT_JOB_OWNER');
    expect(mapNegotiationError({ message: 'Authentication required' })?.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('never leaks unknown database text and falls back safely', () => {
    const raw = { code: 'XX000', message: 'relation "pg_catalog.pg_authid" does not exist', details: 'secret internals', hint: 'do x' };
    expect(mapNegotiationError(raw)).toBeNull();
    expect(negotiationErrorMessage(raw, 'fallback')).toBe('fallback');
    // the fallback must not contain raw internals
    expect(negotiationErrorMessage(raw, 'fallback')).not.toContain('pg_authid');
  });

  it('service composes MB001/MB002 FIRST, then negotiation mapping, then fallback', () => {
    const helper = SERVICE.slice(SERVICE.indexOf('private negotiationError('), SERVICE.indexOf('async getSessionByJob('));
    expect(helper).toContain('acquisitionErrorMessage(error, negotiationErrorMessage(error, fallback))');
    // The NEGOTIATION transitions route through the composite...
    expect(SERVICE).toContain("throw new Error(this.negotiationError(error, 'This offer could not be sent.'))");
    expect(SERVICE).toContain("throw new Error(this.negotiationError(error, 'This counter-offer could not be sent.'))");
    // ...while the LEGACY acquisition lock (lock_marketplace_fare / MB001) stays on
    // the acquisition mapper, so its MB001 busy mapping is never routed away.
    expect(SERVICE).toContain("throw new Error(acquisitionErrorMessage(error, 'This fare could not be locked.'))");
  });

  it('MB001/MB002 handling is not weakened', () => {
    const acq = read('src/app/core/services/compliance/acquisition-error.ts');
    expect(acq).toContain("export const DRIVER_BUSY_SQLSTATE = 'MB001';");
    expect(acq).toContain("export const DRIVER_NOT_ELIGIBLE_SQLSTATE = 'MB002';");
    // the negotiation mapper must not re-declare or re-handle the reserved states
    const neg = read('src/app/shared/marketplace/negotiation-error.ts');
    expect(neg).not.toContain('DRIVER_BUSY_SQLSTATE');
    expect(neg).not.toContain('DRIVER_NOT_ELIGIBLE_SQLSTATE');
    expect(neg).not.toContain("'MB001'");
    expect(neg).not.toContain("'MB002'");
  });
});

describe('PATCH 3 — driver mutation UI ordering', () => {
  it('18. a failed driver accept does not optimistically close the UI', () => {
    const fn = DRIVER_PAGE.slice(DRIVER_PAGE.indexOf('async acceptOffer('), DRIVER_PAGE.indexOf('async submitCounter('));
    // success path refreshes from persisted state
    expect(fn).toContain('await this.load();');
    // failure path ALSO reconciles from persisted state before reporting
    const catchBlock = fn.slice(fn.indexOf('catch (error: any)'));
    expect(catchBlock).toContain('await this.load();');
    expect(catchBlock).toContain('showToast');
    // busy guard wraps the whole mutation and always resets
    expect(fn).toContain('if (this.mutationBusy()) return;');
    expect(fn).toContain('this.mutationBusy.set(true);');
    expect(fn).toContain('this.mutationBusy.set(false);');
  });

  it('the card is never removed before the RPC resolves (no early navigate on failure)', () => {
    const fn = DRIVER_PAGE.slice(DRIVER_PAGE.indexOf('async acceptOffer('), DRIVER_PAGE.indexOf('async submitCounter('));
    const navigateIdx = fn.indexOf('navigate');
    const catchIdx = fn.indexOf('catch (error: any)');
    // any navigation must sit on the success side, never inside the catch
    if (navigateIdx !== -1) expect(navigateIdx).toBeLessThan(catchIdx);
  });
});

describe('PATCH 5 + boundaries — preserved behaviour', () => {
  it('20. normal Accept Fare & Pay navigation is unchanged', () => {
    const page = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
    expect(page).toContain("if (this.booking()?.status === 'fare_agreed')");
    expect(page).toContain("await this.router.navigate(['/customer/marketplace-payment', job.id]);");
  });

  it('21. no negotiation transition marks a job paid', () => {
    expect(MIG).not.toMatch(/status\s*=\s*'paid'/);
    expect(MIG).not.toContain("'payment_completed'");
    // negotiation agreement stops at fare_agreed and defers payment to the existing flow
    expect(MIG).toContain("status = 'fare_agreed'");
  });

  it('no pricing, commission, threshold or Stripe change in this patch', () => {
    expect(MIG).not.toContain('commission_percent');
    expect(MIG).not.toMatch(/platform_fee\s*=/);
    expect(MIG).not.toContain('stripe');
  });
});

describe('eligibility parity is enforced at every driver authority boundary', () => {
  it('all four driver-capable boundaries call the canonical predicate', () => {
    const boundaries = [
      MIG.slice(MIG.indexOf('public.fetch_hybrid_opportunities('), MIG.indexOf('2. CLAIM')),
      MIG.slice(MIG.indexOf('public.claim_marketplace_negotiation('), MIG.indexOf('3. DRIVER COUNTER')),
      MIG.slice(MIG.indexOf('public.driver_counter_offer('), MIG.indexOf('4. DRIVER ACCEPT')),
      MIG.slice(MIG.indexOf('public.driver_accept_customer_offer('))
    ];
    for (const b of boundaries) expect(b).toContain('driver_vehicle_can_accept_job');
  });
});
