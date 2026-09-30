import { DriverRequirementService, type CanonicalDriverService } from './driver-requirement.service';
import { mapDriverVehicleRow } from '../models/driver-vehicle.model';

/**
 * Map a job service slug to the frozen internal taxonomy (ride / errand /
 * delivery / van-moving). Returns null when the slug cannot be resolved.
 */
export function toCanonicalDriverService(raw: string | null | undefined): CanonicalDriverService | null {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return null;
    if (value === 'ride') return 'ride';
    if (['delivery', 'deliver', 'package', 'package_delivery', 'parcel', 'courier'].includes(value)) return 'delivery';
    if (['errand', 'shop', 'shopping', 'errands'].includes(value)) return 'errand';
    if (['van-moving', 'van_moving', 'van', 'moving', 'move'].includes(value)) return 'van-moving';
    return null;
}

/**
 * Service-scoped canonical eligibility for NEW work acquisition.
 *
 * Consumes DriverRequirementService.resolve() output — it does NOT reconstruct
 * requirement rules. A driver is eligible for a service when:
 *   - the account is not paused/suspended, and
 *   - the driver is approved, and
 *   - no requirement applicable to that service (or account-level, i.e.
 *     `services` is empty) is blocking for online.
 *
 * Blocking-for-online covers missing / invalid / expired / under_review.
 * `expiringSoon` is NOT blocking.
 */
export function isDriverEligibleForService(
    profile: Record<string, any>,
    vehicle: Record<string, any> | null,
    service: CanonicalDriverService,
    authEmailConfirmed = true,
    now?: Date
): boolean {
    const resolution = DriverRequirementService.resolve({
        profile: profile || {},
        vehicle: vehicle ? mapDriverVehicleRow(vehicle as any) : null,
        authEmailConfirmed,
        adminRequests: [],
        countryCode: profile?.country_code || profile?.country || null,
        now
    });

    if (resolution.overallStatus === 'paused') return false;

    // Historical review approval — a driver must have been approved at least once.
    const approved = profile?.is_verified === true || profile?.verification_status === 'approved';
    if (!approved) return false;

    // Current account-level action required (needs resubmit / admin request)
    // blocks NEW work even when the historical approval flag is still set.
    if (profile?.verification_status === 'action_required' || profile?.driver_review_status === 'action_required') return false;

    const blockingForService = resolution.automaticRequirements.filter((requirement) =>
        (requirement.services.length === 0 || requirement.services.includes(service)) &&
        requirement.blockingForOnline
    );

    return blockingForService.length === 0;
}
