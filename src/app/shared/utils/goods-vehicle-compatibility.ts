// Goods requests express minimum carrying capacity; passenger rules remain strict.
export function isGoodsService(service: unknown): boolean {
    return ['delivery', 'errand'].includes(String(service || '').trim().toLowerCase());
}

export function matchesVehicleCapacity(service: unknown, required: string, capabilities: readonly string[]): boolean {
    if (!isGoodsService(service)) return capabilities.includes(required);
    if (required === 'bike') return capabilities.some(value => ['bike', 'car', 'small_van', 'large_van'].includes(value));
    if (required === 'car' || required === 'standard') return capabilities.some(value => ['car', 'small_van', 'large_van'].includes(value));
    if (required === 'small_van') return capabilities.some(value => ['small_van', 'large_van'].includes(value));
    return capabilities.includes(required);
}

// Used by dispatch, whose database vehicle rows may have type but no vehicle_class.
export function goodsVehicleMatches(job: any, vehicle: any): boolean {
    if (!vehicle) return false;
    const service = job?.service_slug || job?.service_type?.slug;
    if (!isGoodsService(service)) return false;
    let metadata = job?.metadata || {};
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { return false; }
    }
    const raw = String(metadata.service_vehicle_class || metadata.vehicle_class || metadata.vehicleClass ||
        metadata.delivery_details?.vehicleClass || metadata.errand_details?.vehicleClass || 'car').toLowerCase();
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
    return matchesVehicleCapacity(service, required, capabilities);
}
