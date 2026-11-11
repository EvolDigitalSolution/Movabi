export type DriverTopupOutcome = 'pending'|'not_completed'|'failed'|'cancelled'|'review'|'credit_pending'|'unavailable';

/**
 * Maps a server verification error code to a UI state and message.
 * Only explicit server codes distinguish outcomes; anything else (network,
 * timeout, 5xx without a known code) is "temporarily unavailable" and never
 * implies success or failure.
 */
export function verifyOutcome(code: unknown): [DriverTopupOutcome, string] {
  switch (code) {
    case 'PAYMENT_PENDING': return ['pending','Your payment is still processing. No credit has been added yet. Check again shortly.'];
    case 'PAYMENT_NOT_COMPLETED': return ['not_completed','This payment has not been completed and nothing has been charged. Continue the payment, or discard it.'];
    case 'PAYMENT_FAILED': return ['failed','The card payment failed and no credit was added. Try the card again, or discard this attempt.'];
    case 'PAYMENT_CANCELLED': return ['cancelled','This payment was cancelled. No credit was added. Discard it to start a new top-up.'];
    case 'PAYMENT_RECEIVED_CREDIT_PENDING': return ['credit_pending','Payment received. Your wallet credit is pending; check again shortly. Do not pay again.'];
    case 'PAYMENT_RECONCILIATION_REQUIRED': case 'PAYMENT_RESPONSE_UNCONFIRMED': return ['review','This payment needs review before any credit. Do not pay again; check again later.'];
    default: return ['unavailable','Payment status is temporarily unavailable. Your attempt is saved; check again shortly. Do not pay again.'];
  }
}
