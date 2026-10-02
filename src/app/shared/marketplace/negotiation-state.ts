/**
 * CANONICAL NEGOTIATION STATE DERIVATION — MOVABI 2.1 (Patch 1A).
 *
 * ONE pure helper that turns PERSISTED state into the customer/driver phase and the set of
 * actions each party may take. No component-local flags, no parallel client state, no DB
 * turn column: everything is derived from
 *
 *   session.status, session.active_driver_id, and the latest FARE-PROPOSAL event.
 *
 * WHY THE LATEST EVENT ALONE IS WRONG
 * -----------------------------------
 * Lifecycle events are authored by a party but do NOT transfer the negotiation turn.
 * `session_claimed` is written by the DRIVER, yet after a claim the driver is the one who
 * must act — deriving "latest event author => other party's turn" would hand the turn to
 * the customer and enable illegal actions. Lifecycle events are therefore excluded from
 * turn derivation and only the fare/action events below move the turn.
 */

export type NegotiationPhase =
  | 'not_started'
  | 'waiting_for_driver'
  | 'driver_turn'
  | 'customer_turn'
  | 'agreed_payment_required'
  | 'paid'
  | 'cancelled'
  | 'expired';

export type NegotiationEventType =
  | 'customer_offer'
  | 'driver_counter'
  | 'customer_accept'
  | 'driver_accept'
  | 'customer_decline'
  | 'driver_decline'
  | 'session_claimed'
  | 'session_released'
  | 'session_expired'
  | 'payment_completed';

export type NegotiationAction =
  | 'make_offer'
  | 'cancel_offer'
  | 'accept'
  | 'counter'
  | 'decline'
  | 'release'
  | 'accept_original_fare'
  | 'pay';

/** Events that move the negotiation turn (fare/action events). */
const FARE_EVENTS: ReadonlySet<string> = new Set<NegotiationEventType>([
  'customer_offer', 'driver_counter', 'customer_accept', 'driver_accept',
  'customer_decline', 'driver_decline'
]);

/**
 * Events that MUST NOT transfer the turn. Exported so tests and callers can assert the
 * classification explicitly rather than trusting a comment.
 */
export const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set<NegotiationEventType>([
  'session_claimed', 'session_released', 'session_expired', 'payment_completed'
]);

/** Minimal structural shape — avoids importing Angular service types into a pure module. */
export interface NegotiationSessionLike {
  status?: string | null;
  active_driver_id?: string | null;
  customer_offer?: number | null;
  driver_counter_offer?: number | null;
  agreed_fare?: number | null;
  round_count?: number | null;
  expires_at?: string | null;
}

export interface NegotiationEventLike {
  event_type?: string | null;
  proposed_by_role?: string | null;
  amount?: number | null;
  round_number?: number | null;
  created_at?: string | null;
}

export interface NegotiationState {
  phase: NegotiationPhase;
  /** The outstanding proposal awaiting a response, if any. */
  pendingOffer: { by: 'customer' | 'driver'; amount: number } | null;
  allowedCustomerActions: NegotiationAction[];
  allowedDriverActions: NegotiationAction[];
}

/** Genuinely TERMINAL customer-facing states. `released` is deliberately NOT here. */
const TERMINAL_CANCELLED = new Set(['customer_declined', 'driver_declined']);

/** Latest event by created_at (malformed/missing timestamps fall back to array order). */
export function latestEventOf(events: readonly NegotiationEventLike[] | null | undefined): NegotiationEventLike | null {
  if (!events || !events.length) return null;
  let best = events[0];
  let bestTime = Date.parse(String(best?.created_at ?? '')) || 0;
  for (const candidate of events) {
    const time = Date.parse(String(candidate?.created_at ?? '')) || 0;
    if (time >= bestTime) { best = candidate; bestTime = time; }
  }
  return best ?? null;
}

/** Latest FARE-PROPOSAL event only — lifecycle events are ignored for turn purposes. */
export function latestFareEvent(
  events: readonly NegotiationEventLike[] | null | undefined
): NegotiationEventLike | null {
  if (!events || !events.length) return null;
  const ordered = [...events].sort(
    (a, b) => (Date.parse(String(a?.created_at ?? '')) || 0) - (Date.parse(String(b?.created_at ?? '')) || 0)
  );
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const type = String(ordered[i]?.event_type ?? '');
    if (FARE_EVENTS.has(type)) return ordered[i];
  }
  return null;
}

const isExpired = (session: NegotiationSessionLike, now: number): boolean => {
  if (String(session.status ?? '').toLowerCase() === 'expired') return true;
  const expiresAt = String(session.expires_at ?? '').trim();
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= now;
};

/**
 * Derive the canonical phase and both parties' allowed actions.
 *
 * `now` is injectable so expiry behaviour is deterministically testable.
 */
export function getNegotiationState(
  session: NegotiationSessionLike | null | undefined,
  events: readonly NegotiationEventLike[] | null | undefined,
  now: number = Date.now()
): NegotiationState {
  // NO SESSION ROW YET = the legitimate PRE-NEGOTIATION state (a freshly created
  // negotiating job has no session until the customer submits an offer). This must
  // still permit `make_offer`. It is deliberately its OWN phase rather than
  // 'waiting_for_driver' so the UI does not render an "offer sent / waiting for a
  // driver" panel before any offer exists. Returning no actions here is the
  // regression that hid "Make an Offer" on an eligible, session-less booking.
  if (!session) {
    return {
      phase: 'not_started',
      pendingOffer: null,
      allowedCustomerActions: ['make_offer'],
      allowedDriverActions: []
    };
  }

  const status = String(session.status ?? '').toLowerCase();
  const claimed = !!String(session.active_driver_id ?? '').trim();
  const offer = Number(session.customer_offer);
  const counter = Number(session.driver_counter_offer);

  // ---- terminal / non-turn phases are resolved BEFORE turn derivation ----
  if (status === 'paid') {
    return { phase: 'paid', pendingOffer: null, allowedCustomerActions: [], allowedDriverActions: [] };
  }
  if (['fare_agreed', 'payment_pending'].includes(status)) {
    return {
      phase: status === 'fare_agreed' ? 'agreed_payment_required' : 'paid',
      pendingOffer: null,
      allowedCustomerActions: status === 'fare_agreed' ? ['pay'] : [],
      allowedDriverActions: []
    };
  }
  if (isExpired(session, now)) {
    return { phase: 'expired', pendingOffer: null, allowedCustomerActions: [], allowedDriverActions: [] };
  }
  if (TERMINAL_CANCELLED.has(status)) {
    return { phase: 'cancelled', pendingOffer: null, allowedCustomerActions: [], allowedDriverActions: [] };
  }

  // `released` is NOT terminal. The driver left and the request went back to the
  // opportunity pool: fetch_hybrid_opportunities accepts status IN ('open','released'),
  // create_customer_offer re-opens a released row, and customer_cancel_offer explicitly
  // allows cancelling a released session. The customer's offer is retained, so they are
  // still "waiting for a driver" and may cancel — but may NOT submit a duplicate offer.
  if (status === 'released') {
    return Number.isFinite(offer) && offer > 0
      ? {
          phase: 'waiting_for_driver',
          pendingOffer: { by: 'customer', amount: offer },
          allowedCustomerActions: ['cancel_offer'],
          allowedDriverActions: []
        }
      : {
          phase: 'not_started',
          pendingOffer: null,
          allowedCustomerActions: ['make_offer'],
          allowedDriverActions: []
        };
  }

  // ---- turn comes ONLY from the latest fare proposal ----
  const proposal = latestFareEvent(events);
  const byCustomer = String(proposal?.proposed_by_role ?? '') === 'customer';
  const byDriver = String(proposal?.proposed_by_role ?? '') === 'driver';

  if (byDriver) {
    // Driver proposed -> customer's turn. Customer may also abandon for the original fare.
    return {
      phase: 'customer_turn',
      pendingOffer: Number.isFinite(counter) && counter > 0 ? { by: 'driver', amount: counter } : null,
      allowedCustomerActions: ['accept', 'counter', 'decline'],
      allowedDriverActions: []
    };
  }

  if (byCustomer) {
    // Customer proposed -> waiting, or the claimed driver's turn. NO second customer offer.
    return {
      phase: claimed ? 'driver_turn' : 'waiting_for_driver',
      pendingOffer: Number.isFinite(offer) && offer > 0 ? { by: 'customer', amount: offer } : null,
      allowedCustomerActions: ['cancel_offer'],
      allowedDriverActions: claimed ? ['accept', 'counter', 'release'] : []
    };
  }

  // No fare proposal yet: fresh session. Only the customer may open an offer.
  return {
    phase: claimed ? 'driver_turn' : 'waiting_for_driver',
    pendingOffer: null,
    allowedCustomerActions: ['make_offer'],
    allowedDriverActions: claimed ? ['accept', 'counter', 'release'] : []
  };
}

/** Convenience predicates so callers never re-implement the rules. */
export const canCustomer = (state: NegotiationState, action: NegotiationAction): boolean =>
  state.allowedCustomerActions.includes(action);
export const canDriver = (state: NegotiationState, action: NegotiationAction): boolean =>
  state.allowedDriverActions.includes(action);
