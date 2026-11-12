/**
 * Customer-facing text for the server's cancellation fee quote (GET /api/booking/:jobId/cancel-preview).
 * The server decides; this only states its decision. The amount uses the exponent the server returned,
 * so the text matches what would be charged.
 */
export interface CancellationFeePreview {
  due: boolean; reasonCode: string; feeMinor: number; currency: string; exponent: number | null;
  graceSeconds: number | null; graceUntil: string | null; driverAssigned: boolean;
}

export function formatQuotedMinor(minor: number, currency: string, exponent: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0 || !Number.isInteger(exponent) || exponent < 0 || exponent > 4 || !/^[A-Z]{3}$/.test(currency)) {
    return 'an amount we could not display';
  }
  const padded = String(minor).padStart(exponent + 1, '0');
  const whole = (exponent ? padded.slice(0, -exponent) : padded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${whole}${exponent ? '.' + padded.slice(-exponent) : ''}`;
}

/** null preview = the check failed: say so rather than implying the cancellation is free. */
export function cancellationFeeMessage(p: CancellationFeePreview | null): string {
  if (!p) return 'We could not check whether a cancellation fee applies. Any fee follows the published policy for your market.';
  if (p.due && p.feeMinor > 0 && p.exponent !== null) {
    return `A cancellation fee of ${formatQuotedMinor(p.feeMinor, p.currency, p.exponent)} applies because your driver accepted this booking and the free cancellation period has ended.`;
  }
  if (p.reasonCode === 'within_grace') return 'You can cancel now without a fee — the free cancellation period has not ended.';
  return 'No cancellation fee applies.';
}
