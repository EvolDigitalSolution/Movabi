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
  payment_deadline?: string | null;
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
  /**
   * True when the RETAINED customer proposal is waiting for a driver AFTER a
   * previous driver's claim ended (session status 'released' — e.g. the driver
   * lease lapsed and the request was handed back to the market).
   *
   * This is FINDING ANOTHER DRIVER: the retained offer is still authoritative and
   * the customer may only cancel — they must NOT be offered a fresh initial
   * proposal. It is deliberately NOT the same as 'not_started'.
   */
  awaitingNextDriver?: boolean;
  /**
   * True when a fare agreement is unpaid but its AUTHORITATIVE payment window has
   * elapsed (session.payment_deadline, falling back to expires_at). Pay is then
   * gone and only the expiry/restart action remains — the page must never offer
   * payment, and must never call the withdrawal RPC for this state.
   */
  paymentExpired?: boolean;
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
    const isAgreed = status === 'fare_agreed';
    const payDeadline = String(session.payment_deadline ?? session.expires_at ?? '').trim();
    const payDeadlineMs = payDeadline ? Date.parse(payDeadline) : NaN;
    const paymentExpired = isAgreed && Number.isFinite(payDeadlineMs) && payDeadlineMs <= now;

    return {
      phase: isAgreed ? 'agreed_payment_required' : 'paid',
      pendingOffer: null,
      paymentExpired,
      // Before the deadline the customer may pay OR withdraw the unpaid
      // agreement. After it, Pay is gone and only the expiry/restart action
      // remains — the withdrawal RPC must not be offered for this state.
      allowedCustomerActions: isAgreed
        ? (paymentExpired ? ['cancel_offer'] : ['pay', 'cancel_offer'])
        : [],
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
          // The customer proposal survived the previous driver: the request is
          // FINDING ANOTHER DRIVER, never a fresh negotiation.
          awaitingNextDriver: true,
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
  let byCustomer = String(proposal?.proposed_by_role ?? '') === 'customer';
  let byDriver = String(proposal?.proposed_by_role ?? '') === 'driver';

  // PERSISTED-SESSION FALLBACK. The event ledger is canonical for proposal
  // ORDERING when it is available, but it may legitimately be empty or stale:
  // submitHybridOffer sets the session from the RPC response before events are
  // reloaded, and realtime delivery can lag. Correctness must not depend on the
  // ledger, or a persisted outstanding offer is misread as a "fresh session" and
  // the UI re-offers Make an Offer next to an "Offer sent" panel.
  //
  // The SQL transitions keep these two fields sufficient to recover the LIVE
  // proposal without the ledger:
  //   * driver_counter_offer is cleared by the customer's next counter/accept, so
  //     a non-null value IS the live driver proposal;
  //   * customer_offer is retained as the live customer proposal until answered.
  if (!byCustomer && !byDriver) {
    if (Number.isFinite(counter) && counter > 0) {
      byDriver = true;
    } else if (Number.isFinite(offer) && offer > 0) {
      byCustomer = true;
    }
  }

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

/**
 * SHARED PAYMENT/LEASE DEADLINE HELPERS.
 *
 * One pure implementation for every countdown in the app, so the customer and
 * driver screens can never disagree. The DEADLINE ITSELF is always the
 * persisted authority (marketplace_negotiation_sessions.payment_deadline /
 * expires_at); these only convert it against a wall-clock tick. No timers, no
 * polling, no global interval service — each caller owns its own 1-second tick.
 */

/** Remaining milliseconds until an ISO deadline (never negative; 0 if absent/invalid). */
export function deadlineRemainingMs(deadline: string | null | undefined, now: number = Date.now()): number {
  const raw = String(deadline ?? '').trim();
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed - now);
}

/** True only when a real ISO deadline exists AND has elapsed. */
export function isDeadlineElapsed(deadline: string | null | undefined, now: number = Date.now()): boolean {
  const raw = String(deadline ?? '').trim();
  if (!raw) return false;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed <= now;
}

/** Zero-padded MM:SS for a remaining duration (e.g. 300000 -> "05:00"). */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Stable one-shot key for a session+deadline, so a 1s tick cannot re-fire a mutation. */
export function deadlineKey(sessionId: string | null | undefined, deadline: string | null | undefined): string {
  const id = String(sessionId ?? '').trim();
  const at = String(deadline ?? '').trim();
  if (!id || !at) return '';
  return `${id}:${at}`;
}

/** Phases in which the negotiation is over or not actionable by either party. */
const TERMINAL_PHASES: ReadonlySet<NegotiationPhase> = new Set<NegotiationPhase>([
  'not_started',
  'agreed_payment_required',
  'paid',
  'cancelled',
  'expired'
]);

/** True when the canonical phase is terminal / no longer actionable. */
export const isTerminalNegotiationPhase = (phase: NegotiationPhase): boolean => TERMINAL_PHASES.has(phase);

/**
 * A LIVE negotiation this driver already authoritatively OWNS.
 *
 * Exists to RECOVER an owned negotiation whose ancillary configuration read is
 * unavailable — e.g. the driver-side `jobs` SELECT is filtered by RLS while
 * `jobs.driver_id` is still NULL and the job is `pending_fare_confirmation`, so
 * the page cannot resolve `effectiveHybridStatus`. Unknown configuration must not
 * be mistaken for explicitly-disabled configuration when the driver demonstrably
 * owns a live session.
 *
 * Ownership and liveness are taken ONLY from authoritative persisted state:
 *   1. the session exists;
 *   2. `session.active_driver_id` === the authenticated driver;
 *   3. the canonical phase is not terminal — so expired / cancelled / paid /
 *      already-agreed sessions are rejected here by the SAME rules as everywhere
 *      else, never by a second hand-rolled status list.
 */
export function isLiveOwnedNegotiation(
  session: NegotiationSessionLike | null | undefined,
  driverId: string | null | undefined,
  events: readonly NegotiationEventLike[] | null | undefined,
  now: number = Date.now()
): boolean {
  if (!session) return false;

  const owner = String(session.active_driver_id ?? '').trim();
  const driver = String(driverId ?? '').trim();
  if (!owner || !driver || owner !== driver) return false;

  return !isTerminalNegotiationPhase(getNegotiationState(session, events, now).phase);
}
