/**
 * CUSTOMER CANCELLATION + STALE REQUEST STATE (Bugs A & B).
 *
 * Bug B (authority hole): customer_cancel_offer terminalised only the session,
 * leaving jobs in pending_fare_confirmation/negotiating so Activity kept the
 * cancelled request under "Pending Marketplace". Fixed by migration 330, which
 * also terminalises the owning job.
 *
 * Bug A (stale map marker): MapRenderer reused the marker DOM element across a
 * service change, so an errand cart pin survived into a new Ride request. Fixed
 * by rebuilding the element when serviceType/kind changes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const MIG = read('supabase/migrations/20261233000000_customer_cancel_request_terminal.sql');
const MAPR = read('src/app/core/services/maps/map-renderer.service.ts');
const BOOKING_SVC = read('src/app/core/services/booking/booking.service.ts');

describe('Bug B — customer cancel must terminalise the JOB (authority)', () => {
  it('customer_cancel_offer now marks the owning job cancelled for negotiable statuses', () => {
    const fn = MIG.slice(MIG.indexOf('public.customer_cancel_offer('), MIG.indexOf('REVOKE ALL ON FUNCTION'));
    expect(fn).toContain("UPDATE public.jobs");
    expect(fn).toContain("SET status = 'cancelled'");
    expect(fn).toContain("status IN ('pending_fare_confirmation', 'negotiating', 'open')");
    // scoped by the job of the (already ownership-verified) session
    expect(fn).toContain('WHERE id = v_session.job_id');
  });

  it('session terminalisation from migration 310 is preserved', () => {
    const fn = MIG.slice(MIG.indexOf('public.customer_cancel_offer('), MIG.indexOf('REVOKE ALL ON FUNCTION'));
    expect(fn).toContain("status = 'customer_declined'");
    expect(fn).toContain('active_driver_id = NULL');
    expect(fn).toContain('driver_counter_offer = NULL');
    // identity + ownership guards intact
    expect(fn).toContain("v_actor UUID := auth.uid()");
    expect(fn).toContain("IF v_session.customer_id IS DISTINCT FROM v_actor THEN");
    expect(fn).toContain("RAISE EXCEPTION 'Only the customer can cancel this negotiation'");
    // no expiry check (withdrawal, not a stale response)
    expect(fn).toContain('NO expires_at check is applied here');
  });

  it('payment/Stripe are never touched by the cancel (job is unpaid at this stage)', () => {
    expect(MIG).not.toMatch(/payment_status\s*=/);
    expect(MIG).not.toContain('stripe.paymentIntents');
  });

  it('does not invent a new status and re-asserts ACL', () => {
    expect(MIG).toContain("status = 'cancelled'");
    expect(MIG).not.toMatch(/status\s*=\s*'cancelled_by_customer'/);
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.customer_cancel_offer(UUID) FROM PUBLIC;');
    expect(MIG).toContain("GRANT EXECUTE ON FUNCTION public.customer_cancel_offer(UUID) TO authenticated;");
  });

  it('Activity pending classification keys off job status, so cancelled cannot be pending', () => {
    // getBookingLifecycleState must not classify a cancelled job as 'negotiating'/
    // 'fare_agreed_unpaid', the two states isPendingMarketplaceBooking accepts.
    const mapper = BOOKING_SVC.slice(
      BOOKING_SVC.indexOf('getBookingLifecycleState('),
      BOOKING_SVC.indexOf('isVisibleActivityBooking(')
    );
    expect(mapper).toContain("if (status === 'cancelled') {");
    expect(mapper).toContain("['pending_fare_confirmation', 'negotiating'].includes(status)) return 'negotiating'");
    // the pending predicate only accepts negotiating / fare_agreed_unpaid
    const pred = BOOKING_SVC.slice(
      BOOKING_SVC.indexOf('isPendingMarketplaceBooking('),
      BOOKING_SVC.indexOf('async getServiceTypes(')
    );
    expect(pred).toContain("return ['negotiating', 'fare_agreed_unpaid'].includes(state)");
  });
});

describe('Bug A — map marker must not leak a stale service icon', () => {
  it('addOrUpdateMarker tracks serviceType/kind and rebuilds on change', () => {
    const fn = MAPR.slice(MAPR.indexOf('addOrUpdateMarker('), MAPR.indexOf('removeMarker(id: string)'));
    expect(fn).toContain('_movabiServiceType');
    expect(fn).toContain('_movabiKind');
    expect(fn).toContain('const changed = serviceType !== prevServiceType || kind !== prevKind');
    // on change: the old element is removed before recreation
    expect(fn).toContain('marker.remove();');
    expect(fn).toContain('this.markers.delete(options.id);');
    expect(fn).toContain('marker = null;');
  });

  it('same-id same-service update still only repositions (no rebuild churn)', () => {
    const fn = MAPR.slice(MAPR.indexOf('addOrUpdateMarker('), MAPR.indexOf('removeMarker(id: string)'));
    expect(fn).toContain('marker.setLngLat([options.coordinates.lng, options.coordinates.lat]);');
  });

  it('driver markers keep the animate path untouched', () => {
    const fn = MAPR.slice(MAPR.indexOf('addOrUpdateMarker('), MAPR.indexOf('removeMarker(id: string)'));
    expect(fn).toContain("options.kind === 'driver'");
    expect(fn).toContain('this.animateMarkerMovement(');
  });

  it('destroyMap still clears every marker and the tracking map', () => {
    const fn = MAPR.slice(MAPR.indexOf('destroyMap()'), MAPR.indexOf('onUserMapGesture('));
    expect(fn).toContain('this.markers.clear();');
    expect(fn).toContain('this.markerHeadings.clear();');
    expect(fn).toContain('this.map.remove();');
  });
});

describe('migration 320 eligibility parity remains intact', () => {
  it('320 is not edited by this patch and still carries the eligibility guards', () => {
    const m320 = read('supabase/migrations/20261232000000_negotiation_eligibility_parity.sql');
    expect(m320).toContain('public.driver_vehicle_can_accept_job');
    expect(m320).toContain("RAISE EXCEPTION 'You are not eligible for this service'");
  });

  it('330 does not touch driver eligibility / N12 / MB codes', () => {
    expect(MIG).not.toContain('driver_vehicle_can_accept_job');
    expect(MIG).not.toContain('trg_enforce_job_acquisition_eligibility');
    expect(MIG).not.toContain('MB001');
    expect(MIG).not.toContain('MB002');
    expect(MIG).not.toContain('driver_occupying_statuses');
  });
});

describe('Marketplace Fare terminal guard (stale/direct navigation)', () => {
  const FARE = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');

  it('isTerminalBooking covers cancelled/expired/no_driver_found/settled/completed + expired_at', () => {
    const guard = FARE.slice(FARE.indexOf('get isTerminalBooking()'), FARE.indexOf('private async initializeStripe()'));
    expect(guard).toContain("status === 'expired'");
    expect(guard).toContain('expired_at');
    expect(guard).toContain("['cancelled', 'no_driver_found', 'settled', 'completed']");
  });

  it('ngOnInit reconciles the authoritative job BEFORE any session/quote work and fails closed', () => {
    const init = FARE.slice(FARE.indexOf('async ngOnInit()'), FARE.indexOf('ngOnDestroy()'));
    // load the persisted job first
    expect(init.indexOf('await this.loadBooking(id);')).toBeGreaterThan(-1);
    // terminal guard fires after loadBooking and BEFORE loadSettings/loadHybridSession
    const loadBookingIdx = init.indexOf('await this.loadBooking(id);');
    const guardIdx = init.indexOf('if (this.isTerminalBooking)');
    const loadSettingsIdx = init.indexOf('await this.hybridService.loadSettings();');
    expect(guardIdx).toBeGreaterThan(loadBookingIdx);
    expect(guardIdx).toBeLessThan(loadSettingsIdx);
    // fails closed to Activity
    expect(init).toContain("await this.router.navigate(['/customer/activity'], { replaceUrl: true });");
    expect(init).toContain('return;');
  });

  it('a missing route id (fresh quote / no persisted job) navigates home and never requires a job', () => {
    const init = FARE.slice(FARE.indexOf('async ngOnInit()'), FARE.indexOf('ngOnDestroy()'));
    expect(init).toContain("const id = this.route.snapshot.paramMap.get('id');");
    expect(init).toContain("if (!id) {");
    expect(init).toContain("await this.router.navigate(['/customer']);");
    expect(init).toContain('return;');
  });

  it('acceptSuggestedFare remains gated on fare_agreed (no terminal job can pay)', () => {
    expect(FARE).toContain("if (this.booking()?.status === 'fare_agreed') {");
  });
});

describe('Map/route cleanup primitives remain available', () => {
  it('clearRoute removes the route layer and source', () => {
    const fn = MAPR.slice(MAPR.indexOf('clearRoute()'), MAPR.indexOf('heatmap-source'));
    expect(fn).toContain('removeLayer(this.routeLayerId)');
    expect(fn).toContain('removeSource(this.routeSourceId)');
  });

  it('removeMarker calls Marker.remove() before dropping the reference', () => {
    const fn = MAPR.slice(MAPR.indexOf('removeMarker(id: string)'), MAPR.indexOf('private markerHeadings'));
    expect(fn).toContain('marker.remove();');
    expect(fn).toContain('this.markers.delete(id);');
  });

  it('destroyMap clears the marker registry and headings', () => {
    const fn = MAPR.slice(MAPR.indexOf('destroyMap()'), MAPR.indexOf('onUserMapGesture('));
    expect(fn).toContain('this.markers.clear();');
    expect(fn).toContain('this.markerHeadings.clear();');
  });
});
