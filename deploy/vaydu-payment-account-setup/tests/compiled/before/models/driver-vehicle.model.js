"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapDriverVehicleRow = mapDriverVehicleRow;
exports.parseDriverVehicleInput = parseDriverVehicleInput;
const text = (value) => String(value ?? '').trim();
function mapDriverVehicleRow(row) {
    const numericYear = Number(row.year);
    return {
        id: row.id,
        userId: row.user_id,
        type: text(row.type),
        make: text(row.make) || null,
        model: text(row.model) || null,
        colour: text(row.color) || null,
        year: Number.isInteger(numericYear) ? numericYear : null,
        registrationNumber: text(row.license_plate) || null,
        capacity: text(row.capacity) || null,
        serviceEligibility: Array.isArray(row.service_eligibility) ? row.service_eligibility.map(text).filter(Boolean) : [],
        status: text(row.status) || 'saved'
    };
}
function parseDriverVehicleInput(value) {
    const input = value && typeof value === 'object' ? value : {};
    const year = Number(input['year'] ?? input['vehicle_year']);
    const serviceEligibility = input['serviceEligibility'] ?? input['service_eligibility'];
    const parsed = {
        vehicleType: text(input['vehicleType'] ?? input['type'] ?? input['vehicle_type']),
        make: text(input['make']), model: text(input['model']),
        colour: text(input['colour'] ?? input['color']), year,
        registrationNumber: text(input['registrationNumber'] ?? input['licensePlate'] ?? input['license_plate'] ?? input['registration_number']),
        capacity: text(input['capacity']) || null,
        serviceEligibility: Array.isArray(serviceEligibility) ? serviceEligibility.map(text).filter(Boolean) : []
    };
    if (!parsed.make || !parsed.model || !parsed.colour || !parsed.vehicleType)
        throw new Error('Make, model, colour and vehicle type are required.');
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getUTCFullYear() + 2)
        throw new Error('Enter a valid vehicle year.');
    if (parsed.vehicleType !== 'motorcycle' && !parsed.registrationNumber)
        throw new Error('Vehicle registration is required.');
    return parsed;
}
