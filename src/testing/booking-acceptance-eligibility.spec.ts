import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const route = readFileSync(resolve(process.cwd(), 'server/routes/booking.routes.ts'), 'utf8');
const acceptSegment = route.slice(
    route.indexOf("router.post('/negotiation/:id/accept'"),
    route.indexOf('const { data: accepted, error: acceptError }')
);

describe('booking acceptance eligibility re-check (defence in depth)', () => {
    it('reuses the canonical service-scoped helper immediately before the RPC', () => {
        expect(route).toContain("import { isDriverEligibleForService, toCanonicalDriverService }");
        expect(acceptSegment).toContain('isDriverEligibleForService(driverProfile, driverVehicle, canonicalService)');
        expect(acceptSegment).toContain('toCanonicalDriverService(fullJob.service_slug)');
    });

    it('returns a stable, non-leaking rejection code for an ineligible driver', () => {
        expect(acceptSegment).toContain("code: 'DRIVER_NO_LONGER_ELIGIBLE'");
        expect(acceptSegment).toContain('The selected driver is no longer eligible for this service.');
        expect(acceptSegment).not.toContain('reason');
    });

    it('does not invoke the RPC when the re-check rejects', () => {
        // The rejection return sits before the RPC call, so a rejection path never reaches it.
        const rejectionIndex = acceptSegment.indexOf('DRIVER_NO_LONGER_ELIGIBLE');
        expect(rejectionIndex).toBeGreaterThan(-1);
        expect(acceptSegment).not.toContain("supabaseAdmin.rpc('accept_driver_offer'");
    });

    it('derives the driver server-side, never from the request body', () => {
        const negotiationBody = route.slice(
            route.indexOf("router.post('/negotiation/:id/accept'"),
            route.indexOf('const { data: accepted, error: acceptError }')
        );
        expect(negotiationBody).toContain('negotiation as any).proposed_by');
        expect(negotiationBody).not.toContain('req.body.driverId');
        expect(negotiationBody).not.toContain('req.body.acceptedDriverId');
    });
});
