/**
 * Bounded NEGOTIATION authority error mapping.
 *
 * The negotiation RPCs raise plpgsql exceptions (SQLSTATE `P0001`) whose messages
 * are FIXED, developer-authored strings that are part of the authority contract.
 * Because they are a closed set, they can be mapped to safe, actionable UI copy.
 *
 * What must NOT happen:
 *   * surfacing raw Postgres internals (detail / hint / arbitrary SQLSTATE text);
 *   * collapsing every authority rejection into one generic "could not be sent",
 *     which hides actionable causes such as "you already have an offer awaiting a
 *     response" and made a correct server rejection look like a transport fault.
 *
 * MB001 / MB002 keep their dedicated handling in `acquisition-error.ts` and are
 * deliberately NOT duplicated or weakened here.
 */

export interface NegotiationFailure {
    /** Machine-readable application code. */
    code: string;
    /** Safe, actionable, user-facing message. */
    message: string;
}

/**
 * Exact messages raised by the negotiation authority functions, in match order
 * (first substring hit wins). Keep in sync with the RPC `RAISE EXCEPTION` text.
 */
const AUTHORITY_MESSAGES: ReadonlyArray<{ match: string; code: string; message: string }> = [
    // --- duplicate / outstanding proposal ---
    {
        match: 'An offer is already awaiting a response for this request',
        code: 'OFFER_OUTSTANDING',
        message: 'You already have an offer awaiting a driver. Cancel it or wait for a response.'
    },
    // --- closed / expired negotiation ---
    {
        match: 'This negotiation is already closed',
        code: 'NEGOTIATION_CLOSED',
        message: 'This negotiation has already ended. Refresh to see the current state.'
    },
    { match: 'Negotiation is not open', code: 'NEGOTIATION_CLOSED', message: 'This negotiation is no longer open.' },
    { match: 'Negotiation has expired', code: 'NEGOTIATION_EXPIRED', message: 'This negotiation has expired. Refresh and try again.' },
    { match: 'Maximum negotiation rounds reached', code: 'MAX_ROUNDS', message: 'The maximum number of negotiation rounds has been reached.' },
    // --- eligibility (20261232000000 eligibility parity) ---
    {
        match: 'You are not eligible for this service',
        code: 'DRIVER_NOT_ELIGIBLE_FOR_SERVICE',
        message: 'Your current vehicle or service setup is not eligible for this request.'
    },
    // --- actor / ownership ---
    { match: 'Only the active driver', code: 'NOT_ACTIVE_DRIVER', message: 'You are no longer the active driver for this negotiation.' },
    { match: 'Only the job customer can open a negotiation', code: 'NOT_JOB_OWNER', message: 'Only the customer who created this request can negotiate it.' },
    { match: 'Only the customer', code: 'NOT_JOB_OWNER', message: 'Only the customer on this request can perform that action.' },
    { match: 'You can only claim a negotiation for yourself', code: 'NOT_JOB_OWNER', message: 'You can only act on your own negotiations.' },
    // --- turn ownership ---
    { match: 'There is no customer offer awaiting a response', code: 'WRONG_TURN', message: 'It is not your turn to act on this negotiation.' },
    { match: 'There is no customer offer to accept', code: 'WRONG_TURN', message: 'There is no customer offer to accept right now.' },
    { match: 'There is no driver counter-offer', code: 'WRONG_TURN', message: 'There is no driver counter-offer to respond to.' },
    // --- availability ---
    { match: 'Session already claimed', code: 'ALREADY_CLAIMED', message: 'Another driver has already taken this negotiation.' },
    { match: 'No negotiation session found for this job', code: 'ALREADY_CLAIMED', message: 'This negotiation is no longer available.' },
    { match: 'Negotiation session not found', code: 'ALREADY_CLAIMED', message: 'This negotiation is no longer available.' },
    { match: 'Job is not available for negotiation', code: 'JOB_NOT_NEGOTIABLE', message: 'This request is no longer available for negotiation.' },
    { match: 'Job is not in a negotiable state', code: 'JOB_NOT_NEGOTIABLE', message: 'This request is no longer available for negotiation.' },
    { match: 'Negotiation is not enabled for this job', code: 'JOB_NOT_NEGOTIABLE', message: 'Negotiation is not available for this request.' },
    // --- input / identity ---
    { match: 'Authentication required', code: 'AUTHENTICATION_REQUIRED', message: 'Please sign in again to continue.' },
    { match: 'Job not found', code: 'JOB_NOT_FOUND', message: 'This request could not be found.' },
    { match: 'Offer amount must be a positive value', code: 'INVALID_AMOUNT', message: 'Please enter a valid offer amount.' },
    { match: 'Counter amount must be a positive value', code: 'INVALID_AMOUNT', message: 'Please enter a valid counter amount.' },
    { match: 'No authoritative reference fare is available', code: 'FARE_UNAVAILABLE', message: 'We cannot confirm a fare for this request right now.' }
];

/**
 * Map a negotiation authority rejection. Returns null when the error is not one of
 * the known, closed-set authority messages, so the caller's own fallback is used
 * and no unknown database text is ever surfaced.
 */
export function mapNegotiationError(error: unknown): NegotiationFailure | null {
    const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
    if (!candidate) return null;

    const message = String(candidate.message ?? '');
    if (!message) return null;

    const hit = AUTHORITY_MESSAGES.find(entry => message.includes(entry.match));
    return hit ? { code: hit.code, message: hit.message } : null;
}

/**
 * Safe actionable message for a failed negotiation call: the mapped authority copy
 * when the rejection is a known authority message, otherwise the caller's fallback.
 */
export function negotiationErrorMessage(error: unknown, fallback: string): string {
    return mapNegotiationError(error)?.message ?? fallback;
}
