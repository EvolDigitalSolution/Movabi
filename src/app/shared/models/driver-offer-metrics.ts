/**
 * Driver acceptance/cancellation metrics as returned by GET /api/booking/offer-metrics (the driver)
 * and GET /api/admin/drivers/:driverId/offer-metrics (an admin). Policy D9: only driver-initiated
 * cancellations count — the assigned driver cancelled, or handed an accepted assignment back.
 */
export interface DriverOfferMetricsView {
  driverId: string;
  periodDays: number;
  acknowledgedOffers: number;
  deliveredAttempts: number;
  acceptedOffers: number;
  declinedOffers: number;
  expiredOffers: number;
  acceptanceRate: number | null;
  acceptedBookings: number;
  driverCancellations: number;
  driverCancelledBookings: number;
  driverHandoffs: number;
  excludedCancellations: { customer: number; admin: number; otherDriver: number; customerNoShow: number };
  unattributedCancellations: number;
  cancellationRate: number | null;
  insufficientData: { offers: boolean; cancellations: boolean };
}

/** "2 of 12 bookings (1 handed back)" — the counted cancellations and what they consist of. */
export function driverCancellationSummary(m: Pick<DriverOfferMetricsView, 'driverCancellations' | 'acceptedBookings' | 'driverHandoffs'>): string {
  const base = `${m.driverCancellations} of ${m.acceptedBookings} booking${m.acceptedBookings === 1 ? '' : 's'}`;
  return m.driverHandoffs > 0 ? `${base} (${m.driverHandoffs} handed back)` : base;
}

/** Cancellations shown for transparency but never counted against the driver. */
export function excludedCancellationSummary(m: Pick<DriverOfferMetricsView, 'excludedCancellations' | 'unattributedCancellations'>): string {
  const e = m.excludedCancellations;
  const parts: string[] = [];
  if (e.customer) parts.push(`${e.customer} by customer`);
  if (e.customerNoShow) parts.push(`${e.customerNoShow} customer no-show`);
  if (e.admin) parts.push(`${e.admin} by support`);
  if (e.otherDriver) parts.push(`${e.otherDriver} after reassignment`);
  if (m.unattributedCancellations) parts.push(`${m.unattributedCancellations} with no recorded actor`);
  return parts.length ? `Not counted: ${parts.join(', ')}.` : '';
}
