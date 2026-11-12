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
 * - Cancellation rate (policy D9, 2026-11-12: driver-initiated only): driver-initiated
 *   cancellations / accepted assignments. An assignment is (driver, job) accepted in the period,
 *   counted once however many offers it took. Driver-initiated = the assigned driver cancelled, or
 *   voluntarily handed the accepted assignment back (counted once, also reported as driverHandoffs).
 *   Customer, admin, other-driver and no-show cancellations are excluded and reported; historical
 *   cancellations with no recorded actor are reported as unattributedCancellations.
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
  acceptedBookings: number;               // accepted assignments in the period (denominator)
  driverCancellations: number;            // driverCancelledBookings + driverHandoffs (numerator)
  driverCancelledBookings: number;
  driverHandoffs: number;
  excludedCancellations: {                // never counted against the driver
    customer: number; admin: number; otherDriver: number; customerNoShow: number;
  };
  unattributedCancellations: number;      // historical: cancelled with no recorded actor
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
  const excludedCancellations = {
    customer: count(r.customerCancellations), admin: count(r.adminCancellations),
    otherDriver: count(r.otherDriverCancellations), customerNoShow: count(r.customerNoShows),
  };
  const unattributedCancellations = count(r.unattributedCancellations);
  // Every assignment is classified at most once, so the classes can never exceed the denominator.
  const classified = driverCancellations + excludedCancellations.customer + excludedCancellations.admin
    + excludedCancellations.otherDriver + excludedCancellations.customerNoShow + unattributedCancellations;
  if (classified > acceptedBookings) throw new Error('driver_offer_metrics_v2 classes exceed accepted assignments');
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
    excludedCancellations,
    unattributedCancellations,
    cancellationRate: acceptedBookings >= MIN_ACCEPTED ? Math.round((driverCancellations / acceptedBookings) * 1000) / 1000 : null,
    insufficientData: {
      offers: acknowledgedOffers < MIN_ACKNOWLEDGED,
      cancellations: acceptedBookings < MIN_ACCEPTED,
    },
  };
}
