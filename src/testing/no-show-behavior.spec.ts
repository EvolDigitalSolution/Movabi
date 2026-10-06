/**
 * Ride no-show — wiring assertions (server-authoritative arrival, terminal
 * no-show, default-off, disclosure persistence, migration guards).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const BOOKING = read('server/routes/booking.routes.ts');
const NOSHOW = read('server/services/no-show.service.ts');
const PRICING = read('server/services/pricing.service.ts');
const DRIVER_SVC = read('src/app/core/services/driver/driver.service.ts');
const MIG = read('supabase/migrations/20261241300000_ride_no_show.sql');
const MIG415 = read('supabase/migrations/20261241500000_no_show_settlement_security.sql');

describe('default-off', () => {
  it('the feature is default-off and gated server-side (not button hiding)', () => {
    expect(BOOKING).toContain("(await NoShowService.getEnabledConfig()).noShowEnabled");
    expect(NOSHOW).toContain("return { noShowEnabled: false }");
    expect(NOSHOW).toContain("eq('key', 'no_show')");
    expect(NOSHOW).toContain('Boolean(config?.noShowEnabled)');
  });
});

describe('server-authoritative arrival', () => {
  it('checks assigned-driver ownership and location proximity', () => {
    expect(BOOKING).toContain("router.post('/arrive'");
    expect(BOOKING).toContain('NOT_ASSIGNED_DRIVER');
    expect(BOOKING).toContain('ARRIVAL_LOCATION_INVALID');
    expect(BOOKING).toContain('LogisticsService.calculateDistance(');
    expect(BOOKING).toContain('NO_SHOW_ARRIVAL_MAX_DISTANCE_M');
  });

  it('validates a location measurement timestamp (stale/future rejected)', () => {
    expect(BOOKING).toContain('measuredAt');
    expect(BOOKING).toContain('ARRIVAL_LOCATION_STALE');
    expect(BOOKING).toContain('NO_SHOW_ARRIVAL_MAX_LOCATION_AGE_MS');
    expect(BOOKING).toContain('Client coordinates/timestamps remain SPOOFABLE');
  });

  it('records an immutable server deadline and never resets it on repeat', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.mark_job_arrived(');
    expect(MIG).toContain('no_show_arrived_at IS NOT NULL THEN RETURN v_job');
    expect(MIG).toContain('no_show_grace_until = now() + make_interval(mins');
  });

  it('arrival is restricted to an eligible ride-pickup state', () => {
    expect(MIG).toContain("v_job.status NOT IN ('assigned','accepted','driver_arrived')");
  });
});

describe('no-show finalise', () => {
  it('requires grace elapsed, ownership, still-arrived, and disclosure', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.finalize_job_no_show(');
    expect(MIG).toContain("v_job.status <> 'arrived'");
    expect(MIG).toContain('v_job.no_show_grace_until > now()');
    expect(MIG).toContain("fare_breakdown->>'noShowPolicyVersion' IS NULL");
  });

  it('ends as a terminal cancellation and never re-releases', () => {
    expect(MIG).toContain("status = 'cancelled'");
    expect(MIG).toContain("no_show_status = 'pending'");
    // No driver_id clearing / redispatch.
    expect(MIG).not.toMatch(/driver_id = NULL/);
  });

  it('blocks direct client arrival writes for disclosed bookings', () => {
    expect(MIG).toContain('trg_guard_direct_arrival');
    expect(MIG).toContain('Arrival must be recorded through mark_job_arrived');
  });

  it('revokes anonymous execute and grants authenticated only', () => {
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.mark_job_arrived');
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.finalize_job_no_show');
  });

  it('the final fee policy is encoded (min £5 / 50%, 80/20)', () => {
    expect(NOSHOW).toContain('Math.min(NO_SHOW_FEE_CAP_MINOR, Math.floor(fareMinor / 2))');
    expect(NOSHOW).toContain('NO_SHOW_FEE_CAP_MINOR = 500');
    expect(NOSHOW).toContain('Math.round((feeMinor * NO_SHOW_DRIVER_SHARE_PERCENT) / 100)');
  });

  it('driver compensation uses a distinct settlement purpose', () => {
    expect(NOSHOW).toContain("transfer_group: `no_show_${jobId}`");
    expect(NOSHOW).toContain("purpose: 'no_show_compensation'");
  });
});

describe('disclosure', () => {
  it('persists the immutable no-show split at agreement', () => {
    expect(PRICING).toContain("scaledBreakdown['noShowPolicyVersion'] = noShow.policyVersion;");
    expect(PRICING).toContain("scaledBreakdown['noShowFeeMinor'] = noShow.feeMinor;");
    expect(PRICING).toContain('NoShowService.computeNoShowSplit(');
  });
});

describe('one settlement authority', () => {
  it('no-show compensation uses the hardened claim -> transfer -> record machinery', () => {
    expect(NOSHOW).toContain("supabaseAdmin.rpc('claim_job_settlement'");
    expect(NOSHOW).toContain("supabaseAdmin.rpc('record_no_show_settlement'");
    expect(NOSHOW).toContain("transfer_group: `no_show_${jobId}`");
    expect(NOSHOW).toContain("purpose: 'no_show_compensation'");
  });

  it('records compensation atomically while preserving the cancelled status', () => {
    expect(MIG415).toContain('CREATE OR REPLACE FUNCTION public.record_no_show_settlement(');
    expect(MIG415).toContain("WHERE id = p_job_id AND status = 'cancelled'");
    expect(MIG415).toContain("settlement_purpose = 'no_show_compensation'");
    expect(MIG415).toContain("INSERT INTO public.driver_earnings");
  });

  it('prevents ordinary completion and no-show from both settling', () => {
    expect(MIG415).toContain('settlement_purpose text NOT NULL DEFAULT \'job_earnings\'');
    expect(MIG415).toContain('ON CONFLICT (job_id) DO UPDATE');
  });
});

describe('server-only financial RPCs', () => {
  it('revokes execute from PUBLIC and grants only to service_role', () => {
    expect(MIG415).toContain('REVOKE ALL ON FUNCTION public.claim_job_settlement');
    expect(MIG415).toContain('REVOKE ALL ON FUNCTION public.finalize_job_no_show');
    expect(MIG415).toContain('REVOKE ALL ON FUNCTION public.reserve_refund_operation');
    expect(MIG415).toContain('GRANT EXECUTE ON FUNCTION public.claim_job_settlement');
    expect(MIG415).toContain('TO service_role');
  });
});

describe('client UI wiring (driver service)', () => {
  it('drives arrival through the server endpoint (location + measured timestamp)', () => {
    expect(DRIVER_SVC).toContain("getApiUrl('/api/booking/arrive')");
    expect(DRIVER_SVC).toContain('measuredAt');
    expect(DRIVER_SVC).toContain('grace_until');
  });

  it('drives no-show confirmation through the server endpoint with explicit confirmation', () => {
    expect(DRIVER_SVC).toContain("getApiUrl('/api/booking/no-show')");
    expect(DRIVER_SVC).toContain('contactAttempted');
    expect(DRIVER_SVC).toContain('confirmed');
  });
});

describe('server booking disclosure contract', () => {
  it('verifies acknowledgement and persists a SERVER-computed snapshot (never client fee/version)', () => {
    expect(BOOKING).toContain("metadata.no_show_acknowledged !== true");
    expect(BOOKING).toContain('NO_SHOW_ACKNOWLEDGEMENT_REQUIRED');
    expect(BOOKING).toContain('NoShowService.computeNoShowSplit(');
    expect(BOOKING).toContain('Math.round(quotedFare * 100)');
    expect(BOOKING).toContain("insertPayload.fare_breakdown = {");
    expect(BOOKING).toContain('noShowPolicyVersion: noShow.policyVersion');
    // Enablement is server config, not a client override.
    expect(BOOKING).toContain('NoShowService.getEnabledConfig()');
  });
});
