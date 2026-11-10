import { supabaseAdmin } from './supabase.service';

/**
 * Driver offer/cancellation metrics — read-only, no penalties.
 * Acceptance rate denominator counts ONLY offers with authenticated
 * acknowledgement (delivery_attempted alone proves nothing about receipt).
 * Accepting an offer records its acknowledgement atomically in
 * close_driver_offer, so accepted offers always appear delivered.
 * Cancellations count only driver-attributable cancels on accepted
 * bookings — attribution uses the canonical metadata.cancellation_reason
 * convention (see LogisticsService.updateDriverReliability). An
 * 'unanswered offer' can never appear here: cancelled+driver_id requires
 * an actual acceptance first.
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
  driverCancellations: number;
  cancellationRate: number | null;        // null = insufficient data
  insufficientData: { offers: boolean; cancellations: boolean };
}

export async function reportDriverOfferMetrics(driverId: string, periodDays = 30): Promise<DriverOfferMetrics> {
  const since = new Date(Date.now() - periodDays * 86400_000).toISOString();

  const { data: events, error: evErr } = await supabaseAdmin
    .from('driver_offer_events')
    .select('event, job_id, driver_id')
    .eq('driver_id', driverId)
    .gte('event_at', since);
  if (evErr) throw evErr;

  // Reliably delivered = authenticated acknowledgement only.
  const acknowledged = new Set(
    (events || []).filter((e: any) => e.event === 'acknowledged').map((e: any) => e.job_id)
  );
  const attempted = new Set(
    (events || []).filter((e: any) => e.event === 'delivery_attempted').map((e: any) => e.job_id)
  );
  const accepted = (events || []).filter((e: any) => e.event === 'accepted' && acknowledged.has(e.job_id));
  const declined = (events || []).filter((e: any) => e.event === 'declined' && acknowledged.has(e.job_id));
  const expired = (events || []).filter((e: any) => e.event === 'expired' && acknowledged.has(e.job_id));

  // Canonical convention: reason lives in jobs.metadata.cancellation_reason;
  // driver attribution = reason contains 'driver' (LogisticsService:467).
  const { data: cancels, error: cErr } = await supabaseAdmin
    .from('jobs')
    .select('id, metadata, driver_id')
    .eq('driver_id', driverId)
    .eq('status', 'cancelled')
    .gte('updated_at', since);
  if (cErr) throw cErr;

  const driverCancels = (cancels || []).filter((j: any) =>
    String((j.metadata as any)?.cancellation_reason ?? '').toLowerCase().includes('driver')
  );

  const { data: assigned, error: aErr } = await supabaseAdmin
    .from('jobs')
    .select('id')
    .eq('driver_id', driverId)
    .gte('updated_at', since);
  if (aErr) throw aErr;
  const acceptedBookings = (assigned || []).length;

  const acknowledgedCount = acknowledged.size;
  return {
    driverId,
    periodDays,
    acknowledgedOffers: acknowledgedCount,
    deliveredAttempts: attempted.size,
    acceptedOffers: accepted.length,
    declinedOffers: declined.length,
    expiredOffers: expired.length,
    acceptanceRate: acknowledgedCount >= MIN_ACKNOWLEDGED ? Math.round((accepted.length / acknowledgedCount) * 1000) / 1000 : null,
    acceptedBookings,
    driverCancellations: driverCancels.length,
    cancellationRate: acceptedBookings >= MIN_ACCEPTED ? Math.round((driverCancels.length / acceptedBookings) * 1000) / 1000 : null,
    insufficientData: {
      offers: acknowledgedCount < MIN_ACKNOWLEDGED,
      cancellations: acceptedBookings < MIN_ACCEPTED,
    },
  };
}
