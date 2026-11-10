/**
 * Stripe error classification for refund/reversal operations.
 *
 * A DEFINITIVE rejection is a documented terminal case where the request will
 * never execute as-is (non-execution is established and a reservation may be
 * released). Everything else — connection errors, timeouts, 5xx, rate-limit,
 * idempotency conflicts, auth — is UNCERTAIN/conflicting and must retain the
 * reservation as 'unknown'.
 */

export function isDefinitiveStripeRejection(error: unknown): boolean {
  const type = String((error as any)?.type || '');
  const code = String((error as any)?.code || '');

  // `charge_already_refunded` means the operation DID execute (it should be
  // reconciled as executed, not released), so it is excluded.
  if (code === 'charge_already_refunded' || code === 'reversal_already_exists') {
    return false;
  }

  // A malformed/terminal request (StripeInvalidRequestError) will never succeed
  // without modification — the documented definitive non-execution case.
  if (type === 'StripeInvalidRequestError') {
    return true;
  }

  // Connection error, timeout, 5xx API error, rate-limit, idempotency conflict,
  // authentication — uncertain or conflicting; retain the reservation.
  return false;
}
