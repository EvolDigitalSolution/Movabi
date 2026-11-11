export type DriverTopupOutcome = 'pending'|'action_required'|'not_completed'|'failed'|'cancelled'|'review'|'credit_pending'|'unavailable';

/**
 * Maps a server verification error code to a UI state and message.
 * Only explicit server codes distinguish outcomes; anything else (network,
 * timeout, 5xx without a known code) is "temporarily unavailable" and never
 * implies success or failure.
 */
export function verifyOutcome(code: unknown): [DriverTopupOutcome, string] {
  switch (code) {
    case 'PAYMENT_PENDING': return ['pending','Your payment is still processing. No credit has been added yet. Check again shortly.'];
    case 'PAYMENT_ACTION_REQUIRED': return ['action_required','Your bank needs you to confirm this payment. No credit has been added yet. Continue to complete the confirmation, or discard it.'];
    case 'PAYMENT_NOT_COMPLETED': return ['not_completed','This payment has not been completed and nothing has been charged. Continue the payment, or discard it.'];
    case 'PAYMENT_FAILED': return ['failed','The card payment failed and no credit was added. Try the card again, or discard this attempt.'];
    case 'PAYMENT_CANCELLED': return ['cancelled','This payment was cancelled. No credit was added. Discard it to start a new top-up.'];
    case 'PAYMENT_RECEIVED_CREDIT_PENDING': return ['credit_pending','Payment received. Your wallet credit is pending; check again shortly. Do not pay again.'];
    case 'PAYMENT_RECONCILIATION_REQUIRED': case 'PAYMENT_RESPONSE_UNCONFIRMED': return ['review','This payment needs review before any credit. Do not pay again; check again later.'];
    default: return ['unavailable','Payment status is temporarily unavailable. Your attempt is saved; check again shortly. Do not pay again.'];
  }
}

/** An in-app provider payment to continue: always the attempt's ORIGINAL provider payment. */
export interface DriverTopupInAppPayment { provider: string; clientSecret: string; mode: 'authenticate'|'card'; }

/**
 * Validates a server response that opens the in-app payment of the saved attempt (/checkout or
 * /resume) and returns what to continue. Provider-neutral: the provider comes from the server
 * (the attempt's frozen provider) and must equal the one the saved quote was issued for, so a
 * response for another provider is rejected and never handed to a provider UI. Each provider
 * UI validates its own secret format. 'authenticate': finish pending customer authentication
 * without collecting new details. null = not provably this attempt's payment (do nothing).
 */
export function inAppPayment(result: unknown, attemptId: string, expectedProvider: string | undefined): DriverTopupInAppPayment | null {
  const r = result as {attemptId?:unknown; provider?:unknown; clientSecret?:unknown; nextAction?:unknown}|null;
  if (!r || typeof r !== 'object' || r.attemptId !== attemptId || typeof r.clientSecret !== 'string' || !r.clientSecret) return null;
  if (typeof r.provider !== 'string' || !/^[a-z][a-z0-9_-]{1,31}$/.test(r.provider) || !expectedProvider || r.provider !== expectedProvider) return null;
  return {provider: r.provider, clientSecret: r.clientSecret, mode: r.nextAction === true ? 'authenticate' : 'card'};
}
