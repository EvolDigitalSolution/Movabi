import { supabaseAdmin } from './supabase.service';

/**
 * Driver offer/cancellation metrics — read-only, no penalties.
 *
 * Counts come from `driver_offer_metrics_v2` (one bounded SQL aggregate over recorded
 * `driver_offer_events` and the actor recorded at cancellation), so no client row limit can
 * truncate them.
 * - Acceptance rate: accepted / acknowledged OFFERS (per job + offer key). An offer counts only
 *   with an authenticated acknowledgement; accepting records it atomically (close_driver_offer).
 *   delivery_attempted alone is informational.
 * - Cancellation rate (policy D9, 2026-11-12: driver-initiated only): (bookings the assigned
 *   driver cancelled + accepted offers the driver handed back) / bookings the driver accepted in
 *   the period. The actor is server-verified; customer/admin cancellations and legacy rows with no
 *   recorded actor never count (the latter are reported as unattributedCancellations).
 */

const MIN_ACKNOWLEDGED = 5; // insufficient-data below this
const MIN_ACCEPTED = 3;

export interface DriverOfferMetrics {
  driverId: string;
  periodDays: number;
  acknowledgedOffers: number;
  deliveredAttempts: number;      // informational only — never the denominator
  acceptedOffers: number;
  declinedOffers: number;
  expiredOffers: number;
  acceptanceRate: number | null;          // null = insufficient data
  acceptedBookings: number;
  driverCancellations: number;            // driverCancelledBookings + driverHandoffs
  driverCancelledBookings: number;
  driverHandoffs: number;
  unattributedCancellations: number;      // informational: cancelled with no recorded actor
  cancellationRate: number | null;        // null = insufficient data
  insufficientData: { offers: boolean; cancellations: boolean };
}

const count = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('driver_offer_metrics_v2 returned an invalid count');
  return n;
};

export async function reportDriverOfferMetrics(driverId: string, periodDays = 30): Promise<DriverOfferMetrics> {
  const since = new Date(Date.now() - periodDays * 86400_000).toISOString();
  const { data, error } = await supabaseAdmin.rpc('driver_offer_metrics_v2', { p_driver: driverId, p_since: since });
  if (error) throw error;
  const r: any = data || {};
  const acknowledgedOffers = count(r.acknowledgedOffers);
  const acceptedOffers = count(r.acceptedOffers);
  const acceptedBookings = count(r.acceptedBookings);
  const driverCancelledBookings = count(r.driverCancelledBookings);
  const driverHandoffs = count(r.driverHandoffs);
  const driverCancellations = driverCancelledBookings + driverHandoffs;
  return {
    driverId,
    periodDays,
    acknowledgedOffers,
    deliveredAttempts: count(r.deliveredAttempts),
    acceptedOffers,
    declinedOffers: count(r.declinedOffers),
    expiredOffers: count(r.expiredOffers),
    acceptanceRate: acknowledgedOffers >= MIN_ACKNOWLEDGED ? Math.round((acceptedOffers / acknowledgedOffers) * 1000) / 1000 : null,
    acceptedBookings,
    driverCancellations,
    driverCancelledBookings,
    driverHandoffs,
    unattributedCancellations: count(r.unattributedCancellations),
    cancellationRate: acceptedBookings >= MIN_ACCEPTED ? Math.round((driverCancellations / acceptedBookings) * 1000) / 1000 : null,
    insufficientData: {
      offers: acknowledgedOffers < MIN_ACKNOWLEDGED,
      cancellations: acceptedBookings < MIN_ACCEPTED,
    },
  };
}
