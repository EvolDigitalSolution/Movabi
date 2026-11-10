// Goods requests express minimum carrying capacity; passenger rules remain strict.
export function isGoodsService(service: unknown): boolean {
    return ['delivery', 'errand'].includes(String(service || '').trim().toLowerCase());
}

export function matchesVehicleCapacity(service: unknown, required: string, capabilities: readonly string[]): boolean {
    if (!isGoodsService(service)) return capabilities.includes(required);
    if (required === 'bike') return capabilities.some(value => ['bike'].includes(value));
    if (required === 'car' || required === 'standard') return capabilities.some(value => ['car', 'small_van', 'large_van'].includes(value));
    if (required === 'small_van') return capabilities.some(value => ['small_van', 'large_van'].includes(value));
    return capabilities.includes(required);
}

// Used by dispatch, whose database vehicle rows may have type but no vehicle_class.
export function bikeSubtypeFromVehicle(vehicle: any): string | null {
    const sub = String(vehicle?.vehicle_subtype || '').trim().toLowerCase();
    if (sub) return sub;
    const type = String(vehicle?.type || '').trim().toLowerCase();
    if (type.includes('pedal_bicycle') || type === 'pedal bicycle') return 'pedal_bicycle';
    if (type.includes('e_bike') || type === 'e-bike' || type === 'electric bike') return 'e_bike';
    if (type.includes('motorcycle')) return 'motorcycle';
    if (type.includes('moped')) return 'moped';
    if (type.includes('bike')) return 'pedal_bicycle';
    return null;
}

function bikeSubtypesCompatible(required: string, actual: string): boolean {
    if (!required || !actual) return true;
    if (required === actual) return true;
    const compatible: Record<string, string[]> = {
        'pedal_bicycle': ['pedal_bicycle'],
        'e_bike': ['e_bike'],
        'motorcycle': ['motorcycle', 'moped'],
        'moped': ['moped', 'motorcycle']
    };
    return (compatible[required] || []).includes(actual);
}

function subtypeMeetsParcelLimit(vehicleSubtype: string, snapshot: any): boolean {
    const requiredKg = Number(snapshot?.required_max_kg ?? 0);
    const requiredCm = Number(snapshot?.required_max_cm ?? 0);
    if (!requiredKg && !requiredCm) return true;

    const limits = snapshot?.bike_limits || {};
    const subtypeLimits = limits[vehicleSubtype] || limits['pedal_bicycle'] || {};
    if (requiredKg && Number(subtypeLimits.max_kg ?? 0) < requiredKg) return false;
    if (requiredCm && Number(subtypeLimits.max_cm ?? 0) < requiredCm) return false;
    return true;
}

export function goodsVehicleMatches(job: any, vehicle: any): boolean {
    if (!vehicle) return false;
    const service = job?.service_slug || job?.service_type?.slug;
    if (!isGoodsService(service)) return false;

    const snapshot = job?.fulfilment_snapshot || {};
    const persisted = String(job?.fulfilment_category || '').trim().toLowerCase();
    let metadata = job?.metadata || {};
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { return false; }
    }

    // Fulfilment snapshot is the frozen source of truth; fall back to persisted category or metadata only when absent.
    const raw = String(
        snapshot.category ||
        persisted ||
        metadata.service_vehicle_class || metadata.vehicle_class || metadata.vehicleClass ||
        metadata.delivery_details?.vehicleClass || metadata.errand_details?.vehicleClass || 'car'
    ).toLowerCase();

    const normalize = (value: string): string => {
        if (/bike|motorcycle|scooter/.test(value)) return 'bike';
        if (/large[_ ]van|luton/.test(value)) return 'large_van';
        if (/van/.test(value)) return 'small_van';
        if (/car|standard|minibus|seater|xl/.test(value)) return 'car';
        return '';
    };
    const required = normalize(raw);
    const actual = normalize(String(vehicle.type || vehicle.vehicle_class || '') + ' ' +
        String(vehicle.capacity || '') + ' ' + String(vehicle.service_class || ''));
    if (!required || !actual) return false;
    const capabilities = actual === 'large_van' ? ['car', 'small_van', 'large_van'] :
        actual === 'small_van' ? ['car', 'small_van'] : [actual];
    if (!matchesVehicleCapacity(service, required, capabilities)) return false;

    if (required === 'bike') {
        const vehicleSubtype = bikeSubtypeFromVehicle(vehicle);
        if (!vehicleSubtype) return false;

        const jobSubtype = String(snapshot.subtype || job?.fulfilment_subtype || '').trim().toLowerCase();
        if (jobSubtype && !bikeSubtypesCompatible(jobSubtype, vehicleSubtype)) return false;

        const allowed = Array.isArray(snapshot.allowed_subtypes) ? snapshot.allowed_subtypes : null;
        if (allowed && !allowed.includes(vehicleSubtype)) return false;

        if (!subtypeMeetsParcelLimit(vehicleSubtype, snapshot)) return false;
    }
    return true;
}
