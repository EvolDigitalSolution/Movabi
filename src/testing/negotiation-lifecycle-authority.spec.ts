/**
 * PATCH 1A — negotiation lifecycle authority: client-derivable guarantees.
 *
 * SCOPE NOTE: this spec covers ONLY what Patch 1A changed in the client:
 *  - canonical phase/turn derivation (negotiation-state.ts)
 *  - Activities admission of a live negotiation
 *  - removal of the invalid profiles->vehicles embed
 *  - driver claimed-session recovery lookup
 *  - reopen = read-only reconstruction (no duplicate session)
 *
 * The database-authority guarantees (RPC transitions, RLS narrowing, raw-23505
 * suppression, server-side round/expiry enforcement) are NOT implemented in Patch 1A
 * and are therefore NOT asserted here — asserting them would be a false signal.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  LIFECYCLE_EVENTS,
  canCustomer,
  canDriver,
  getNegotiationState,
  latestEventOf,
  latestFareEvent,
  type NegotiationEventLike,
  type NegotiationSessionLike
} from '../app/shared/marketplace/negotiation-state';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const future = (seconds = 120) => new Date(NOW + seconds * 1000).toISOString();
const past = (seconds = 30) => new Date(NOW - seconds * 1000).toISOString();

const session = (over: Partial<NegotiationSessionLike> = {}): NegotiationSessionLike => ({
  status: 'open', active_driver_id: null, customer_offer: 6.78, driver_counter_offer: null,
  agreed_fare: null, round_count: 1, expires_at: future(), ...over
});
const offerEvent = (role: 'customer' | 'driver', type: string, at: string): NegotiationEventLike => ({
  event_type: type, proposed_by_role: role, created_at: at
});

describe('Patch 1A — canonical negotiation state derivation', () => {
  it('1/8. session_claimed does NOT transfer the turn (lifecycle event)', () => {
    // Driver claimed, driver authored the newest event, but the turn stays with the DRIVER.
    const events = [
      offerEvent('customer', 'customer_offer', '2026-10-02T11:59:00.000Z'),
      offerEvent('driver', 'session_claimed', '2026-10-02T11:59:30.000Z')
    ];
    const state = getNegotiationState(session({ status: 'driver_claimed', active_driver_id: 'd1' }), events, NOW);
    expect(state.phase).toBe('driver_turn');
    expect(canDriver(state, 'accept')).toBe(true);
    expect(canCustomer(state, 'make_offer')).toBe(false);
    // and the classification is explicit, not incidental
    for (const e of ['session_claimed', 'session_released', 'session_expired', 'payment_completed']) {
      expect(LIFECYCLE_EVENTS.has(e)).toBe(true);
    }
  });

  it('2/5/6/7. a second counter by the same party is not permitted (turn authority)', () => {
    // Latest fare proposal is the customer's -> driver's turn; customer gets NO counter.
    const customerTurnDone = [offerEvent('customer', 'customer_offer', '2026-10-02T11:59:00.000Z')];
    const claimed = getNegotiationState(session({ status: 'driver_claimed', active_driver_id: 'd1' }), customerTurnDone, NOW);
    expect(claimed.phase).toBe('driver_turn');
    expect(canCustomer(claimed, 'counter')).toBe(false);
    expect(canCustomer(claimed, 'make_offer')).toBe(false);

    // Latest fare proposal is the driver's -> customer's turn; driver gets NO second counter.
    const driverTurnDone = [
      offerEvent('customer', 'customer_offer', '2026-10-02T11:58:00.000Z'),
      offerEvent('driver', 'driver_counter', '2026-10-02T11:59:00.000Z')
    ];
    const counterState = getNegotiationState(
      session({ status: 'negotiating', active_driver_id: 'd1', driver_counter_offer: 7.0 }), driverTurnDone, NOW);
    expect(counterState.phase).toBe('customer_turn');
    expect(canDriver(counterState, 'counter')).toBe(false);
    expect(canCustomer(counterState, 'counter')).toBe(true);
  });

  it('4. Make an Offer is unavailable while a customer offer is outstanding', () => {
    const outstanding = [offerEvent('customer', 'customer_offer', '2026-10-02T11:59:00.000Z')];
    for (const status of ['open', 'driver_claimed', 'negotiating']) {
      const state = getNegotiationState(
        session({ status, active_driver_id: status === 'open' ? null : 'd1' }), outstanding, NOW);
      expect(canCustomer(state, 'make_offer'), status).toBe(false);
      expect(state.allowedCustomerActions).not.toContain('make_offer');
    }
  });

  it('customer offer, UNCLAIMED -> waiting_for_driver with Cancel Offer only', () => {
    const state = getNegotiationState(session({ status: 'open' }),
      [offerEvent('customer', 'customer_offer', '2026-10-02T11:59:00.000Z')], NOW);
    expect(state.phase).toBe('waiting_for_driver');
    // Accept Original Fare & Pay is intentionally ABSENT: its authoritative RPC does
    // not exist, and an outstanding offer must not expose a competing action.
    expect(state.allowedCustomerActions).toEqual(['cancel_offer']);
    expect(state.allowedDriverActions).toEqual([]);          // no driver actions until claimed
    expect(state.pendingOffer).toEqual({ by: 'customer', amount: 6.78 });
  });

  it('customer offer, CLAIMED -> driver may accept/counter/release', () => {
    const state = getNegotiationState(session({ status: 'driver_claimed', active_driver_id: 'd1' }),
      [offerEvent('customer', 'customer_offer', '2026-10-02T11:59:00.000Z')], NOW);
    expect(state.phase).toBe('driver_turn');
    expect(state.allowedDriverActions).toEqual(['accept', 'counter', 'release']);
    expect(state.allowedCustomerActions).toEqual(['cancel_offer']);
  });

  it('driver counter -> customer may Accept / Counter / Decline', () => {
    const state = getNegotiationState(
      session({ status: 'negotiating', active_driver_id: 'd1', driver_counter_offer: 7.0 }),
      [offerEvent('driver', 'driver_counter', '2026-10-02T11:59:00.000Z')], NOW);
    expect(state.phase).toBe('customer_turn');
    expect(state.allowedCustomerActions).toEqual(['accept', 'counter', 'decline']);
    expect(state.pendingOffer).toEqual({ by: 'driver', amount: 7.0 });
  });

  it('agreed -> customer may only Pay; driver has no fare mutation', () => {
    const state = getNegotiationState(
      session({ status: 'fare_agreed', active_driver_id: 'd1', agreed_fare: 7.0 }), [], NOW);
    expect(state.phase).toBe('agreed_payment_required');
    expect(state.allowedCustomerActions).toEqual(['pay']);
    expect(state.allowedDriverActions).toEqual([]);
  });

  it('paid / cancelled / expired expose no negotiation mutation actions', () => {
    expect(getNegotiationState(session({ status: 'paid' }), [], NOW).phase).toBe('paid');

    const cancelled = getNegotiationState(session({ status: 'customer_declined' }), [], NOW);
    expect(cancelled.phase).toBe('cancelled');
    expect([...cancelled.allowedCustomerActions, ...cancelled.allowedDriverActions]).toEqual([]);

    const expired = getNegotiationState(session({ status: 'open', expires_at: past() }), [], NOW);
    expect(expired.phase).toBe('expired');
    expect(expired.allowedCustomerActions).toEqual([]);
  });

  it('expiry is enforced from persisted expires_at even before cleanup runs (item 10, client side)', () => {
    const events = [offerEvent('customer', 'customer_offer', '2026-10-02T11:59:00.000Z')];
    expect(getNegotiationState(session({ expires_at: future() }), events, NOW).phase).toBe('waiting_for_driver');
    expect(getNegotiationState(session({ expires_at: past() }), events, NOW).phase).toBe('expired');
  });

  it('a fresh session allows the customer to open an offer', () => {
    const state = getNegotiationState(session({ customer_offer: null }), [], NOW);
    expect(state.phase).toBe('waiting_for_driver');
    expect(canCustomer(state, 'make_offer')).toBe(true);
  });

  it('helpers select the latest fare event and ignore lifecycle events for turn purposes', () => {
    const events = [
      offerEvent('customer', 'customer_offer', '2026-10-02T11:57:00.000Z'),
      offerEvent('driver', 'session_claimed', '2026-10-02T11:58:00.000Z'),
      offerEvent('driver', 'driver_counter', '2026-10-02T11:59:30.000Z'),
      offerEvent('system', 'session_expired', '2026-10-02T11:59:59.000Z')
    ];
    expect(latestEventOf(events)?.event_type).toBe('session_expired');
    expect(latestFareEvent(events)?.event_type).toBe('driver_counter');
    expect(getNegotiationState(session({ status: 'negotiating', active_driver_id: 'd1' }), events, NOW).phase)
      .toBe('customer_turn');
  });

  it('null/empty inputs degrade safely', () => {
    // A MISSING session is the legitimate pre-negotiation state (job created, no
    // offer yet) and must still allow `make_offer` — see the regression suite below.
    const notStarted = getNegotiationState(null, [], NOW);
    expect(notStarted.phase).toBe('not_started');
    expect(notStarted.allowedCustomerActions).toEqual(['make_offer']);
    expect(notStarted.pendingOffer).toBeNull();
    expect(getNegotiationState(session(), null, NOW).phase).toBe('waiting_for_driver');
    expect(latestEventOf([])).toBeNull();
    expect(latestFareEvent([offerEvent('driver', 'session_claimed', '2026-10-02T11:59:00.000Z')])).toBeNull();
  });
});

describe('Patch 1A — Activities persistence (item 17)', () => {
  const source = read('src/app/core/services/booking/booking.service.ts');

  it('isPendingMarketplaceBooking no longer early-returns false for pending_fare_confirmation', () => {
    const body = source.slice(
      source.indexOf('isPendingMarketplaceBooking('),
      source.indexOf('getServiceTypes()')
    );
    // The contradiction that hid every live negotiation must be gone.
    expect(body).not.toMatch(/status\s*===\s*'pending_fare_confirmation'\s*\)\s*\{\s*return false/);
    expect(body).toContain("['negotiating', 'fare_agreed_unpaid'].includes(state)");
    // 'expired' must still be excluded.
    expect(body).toContain("status === 'expired'");
  });

  it("the lifecycle mapper still classifies pending_fare_confirmation as 'negotiating'", () => {
    const mapper = source.slice(
      source.indexOf('getBookingLifecycleState('),
      source.indexOf('isVisibleActivityBooking(')
    );
    expect(mapper).toContain("['pending_fare_confirmation', 'negotiating'].includes(status)");
  });

  it('the history query does not filter out drafts and Activities routes to marketplace-fare', () => {
    const history = source.slice(source.indexOf('async getHistory()'), source.indexOf('async rateBooking('));
    expect(history).not.toContain('is_draft');
    expect(read('src/app/apps/mobile/features/customer/activity/activity.page.ts'))
      .toContain("'/customer/marketplace-fare', booking.id");
  });
});

describe('Patch 1A — reopen reconstructs, never duplicates (items 18/19)', () => {
  it('marketplace-fare loads the existing session and events without inserting', () => {
    const page = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
    const loader = page.slice(page.indexOf('private async loadHybridSession('), page.indexOf('private async loadDriverProfile('));
    expect(loader).toContain('getSessionByJob(jobId)');
    expect(loader).toContain('getSessionEvents(session.id)');
    expect(loader).not.toContain('insert(');
    expect(loader).not.toContain('createCustomerOffer');
  });

  it('session creation happens only from the explicit offer submit path', () => {
    const page = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
    // slice from the METHOD definition, not the template's (click) binding
    const start = page.indexOf('async submitHybridOffer(');
    expect(start).toBeGreaterThan(-1);
    const submit = page.slice(start, start + 4000);
    expect(submit).toContain('createCustomerOffer');
    // and it must be the only caller of session creation in the whole page
    expect(page.split('createCustomerOffer').length - 1).toBe(1);
  });
});

describe('Patch 1A — profiles/vehicles embed removed (item 24)', () => {
  const profile = read('src/app/core/services/profile/profile.service.ts');

  it('no profiles->vehicles embed remains anywhere in the client', () => {
    // Assert the executable STATEMENT form so the docblock that quotes the old defect
    // is not mistaken for live code.
    expect(profile).not.toContain("select('*, vehicles(*)')");
    expect(profile).not.toContain('.select(`*, vehicles(*)`)');
    expect(profile).toContain("from('profiles')");
    expect(profile).toContain(".select('*')");
  });

  it('the customer page still degrades gracefully when vehicle detail is absent', () => {
    const page = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
    const loader = page.slice(page.indexOf('private async loadDriverProfile('), page.indexOf('private async loadDriverProfile(') + 900);
    expect(loader).toContain('this.driverVehicle.set(');
    expect(loader).toContain('catch (error)');
  });
});

describe('Patch 1A — driver claimed-session recovery (items 20/21)', () => {
  const hybrid = read('src/app/core/services/marketplace/marketplace-hybrid.service.ts');

  it('a persisted lookup for the authenticated driver\'s active claims exists', () => {
    expect(hybrid).toContain('async getActiveDriverSessions(');
    const body = hybrid.slice(hybrid.indexOf('async getActiveDriverSessions('), hybrid.indexOf('async createCustomerOffer('));
    // identity comes from the session, never an arbitrary client-supplied id
    expect(body).toContain('this.auth.currentUser()?.id');
    expect(body).toContain(".eq('active_driver_id', userId)");
    // only genuinely active driver states
    expect(body).toContain("['driver_claimed', 'negotiating']");
    // released/terminal/expired must not surface as active
    expect(body).not.toContain("'released'");
    expect(body).not.toContain("'expired'");
    expect(body).not.toContain("'paid'");
    // past-window sessions are filtered out client-side as well
    expect(body).toContain('expiresAt > now');
  });

  it('recovery is a read, not a second claim', () => {
    const body = hybrid.slice(hybrid.indexOf('async getActiveDriverSessions('), hybrid.indexOf('async createCustomerOffer('));
    expect(body).not.toContain('.insert(');
    expect(body).not.toContain('.update(');
    expect(body).not.toContain('rpc(');
  });
});

describe('Patch 1A — preserves proven behaviour (item 25)', () => {
  it('the duration/identity fix is untouched by this patch', () => {
    const fix = read('supabase/migrations/20261230000000_hybrid_opportunity_duration_fix.sql');
    expect(fix).toContain("BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\\.[0-9]+)?$'");
    expect(fix).toContain("RAISE EXCEPTION 'You can only fetch your own opportunities';");
    expect(fix).toContain('s.active_driver_id IS NULL');
  });
});

/**
 * REGRESSION SUITE — "Make an Offer" was hidden on a session-less booking.
 *
 * dc812c5 gated the control on `makeOfferEnabled && canCustomer('make_offer')`, but
 * getNegotiationState(null, …) returned phase 'cancelled' with NO actions. A freshly
 * created negotiating job has NO session row until the customer offers, so the
 * legitimate initial state produced no `make_offer` and the negotiation path was
 * unreachable in the browser.
 */
describe('regression — session-less pre-negotiation state must expose Make an Offer', () => {
  const FARE_PAGE = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');

  it('1. eligible initial page with NO session => make_offer is allowed', () => {
    const state = getNegotiationState(null, [], NOW);
    expect(state.phase).toBe('not_started');
    expect(canCustomer(state, 'make_offer')).toBe(true);
    // and it must NOT masquerade as an outstanding offer
    expect(state.pendingOffer).toBeNull();
    expect(canCustomer(state, 'cancel_offer')).toBe(false);
    expect(canCustomer(state, 'accept_original_fare')).toBe(false);
    // the page gate is the AND of the market flag and this canonical action
    expect(FARE_PAGE).toContain("makeOfferEnabled && canCustomer('make_offer')");
  });

  it('1b. an undefined session behaves the same as an empty one', () => {
    expect(canCustomer(getNegotiationState(undefined, undefined, NOW), 'make_offer')).toBe(true);
    expect(getNegotiationState(undefined, undefined, NOW).phase).toBe('not_started');
  });

  it('1c. "offer sent" panel is NOT shown before any offer exists', () => {
    // the page derives it from these two phases, which the pre-negotiation phase is not
    expect(getNegotiationState(null, [], NOW).phase).not.toBe('waiting_for_driver');
    expect(getNegotiationState(null, [], NOW).phase).not.toBe('driver_turn');
    expect(FARE_PAGE).toContain("state.phase === 'waiting_for_driver' || state.phase === 'driver_turn'");
  });

  it('2. outstanding customer offer => duplicate make_offer unavailable', () => {
    for (const status of ['open', 'driver_claimed', 'negotiating']) {
      const state = getNegotiationState(
        session({ status, active_driver_id: status === 'open' ? null : 'd1' }),
        [offerEvent('customer', 'customer_offer', '2026-10-02T11:59:00.000Z')], NOW);
      expect(canCustomer(state, 'make_offer'), status).toBe(false);
      expect(canCustomer(state, 'cancel_offer'), status).toBe(true);
    }
  });

  it('3. outstanding customer offer => Accept Original Fare unavailable', () => {
    // Not merely unrendered: the action is absent from the canonical state, so a future
    // caller cannot wire a button for it while an offer is outstanding.
    for (const status of ['open', 'driver_claimed', 'negotiating']) {
      const state = getNegotiationState(
        session({ status, active_driver_id: status === 'open' ? null : 'd1' }),
        [offerEvent('customer', 'customer_offer', '2026-10-02T11:59:00.000Z')], NOW);
      expect(canCustomer(state, 'accept_original_fare'), status).toBe(false);
      expect(state.allowedCustomerActions).not.toContain('accept_original_fare');
    }
    // ...and it must not reappear on the driver-counter turn either
    const counterTurn = getNegotiationState(
      session({ status: 'negotiating', active_driver_id: 'd1', driver_counter_offer: 7 }),
      [offerEvent('driver', 'driver_counter', '2026-10-02T11:59:00.000Z')], NOW);
    expect(canCustomer(counterTurn, 'accept_original_fare')).toBe(false);
    // no UI or helper surface exposes it at all
    expect(FARE_PAGE).not.toContain('accept_original_fare');
    expect(read('src/app/shared/marketplace/negotiation-state.ts')).not.toContain("'accept_original_fare']");
  });

  it('4. cancellation / release / terminal states stay canonical (no stale flags)', () => {
    const cancelled = getNegotiationState(session({ status: 'customer_declined' }), [], NOW);
    expect(cancelled.phase).toBe('cancelled');
    expect([...cancelled.allowedCustomerActions, ...cancelled.allowedDriverActions]).toEqual([]);

    const released = getNegotiationState(
      session({ status: 'released', active_driver_id: null }), [], NOW);
    // released is LIVE (driver left; request back in the pool with the offer retained)
    expect(released.phase).toBe('waiting_for_driver');
    expect(canCustomer(released, 'cancel_offer')).toBe(true);
    expect(canCustomer(released, 'make_offer')).toBe(false);   // offer retained: no duplicate
    // released without a retained offer falls back to the pre-negotiation state
    const releasedNoOffer = getNegotiationState(
      session({ status: 'released', active_driver_id: null, customer_offer: null }), [], NOW);
    expect(releasedNoOffer.phase).toBe('not_started');
    expect(canCustomer(releasedNoOffer, 'make_offer')).toBe(true);

    const expired = getNegotiationState(session({ status: 'open', expires_at: past() }), [], NOW);
    expect(expired.phase).toBe('expired');
    expect(expired.allowedCustomerActions).toEqual([]);

    const agreed = getNegotiationState(session({ status: 'fare_agreed' }), [], NOW);
    expect(agreed.allowedCustomerActions).toEqual(['pay']);
    expect(canCustomer(agreed, 'make_offer')).toBe(false);
  });
});
