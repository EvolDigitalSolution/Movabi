export interface DriverVehicleRow {
  id: string;
  user_id: string;
  type: string | null;
  vehicle_subtype: string | null;
  make: string | null;
  model: string | null;
  color: string | null;
  year: number | string | null;
  license_plate: string | null;
  capacity: string | null;
  service_eligibility: string[] | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface DriverVehicle {
  id: string;
  userId: string;
  type: string;
  subtype: string | null;
  make: string | null;
  model: string | null;
  colour: string | null;
  year: number | null;
  registrationNumber: string | null;
  capacity: string | null;
  serviceEligibility: string[];
  status: string;
}

export interface DriverVehicleInput {
  vehicleType: string;
  vehicleSubtype: string | null;
  make: string;
  model: string;
  colour: string;
  year: number;
  registrationNumber: string;
  capacity: string | null;
  serviceEligibility: string[];
}

const text = (value: unknown): string => String(value ?? '').trim();

export function mapDriverVehicleRow(row: DriverVehicleRow): DriverVehicle {
  const numericYear = Number(row.year);
  return {
    id: row.id,
    userId: row.user_id,
    type: text(row.type),
    subtype: text(row.vehicle_subtype) || null,
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

const canonicalBikeSubtypes = ['pedal_bicycle', 'e_bike', 'motorcycle', 'moped'];

export function parseDriverVehicleInput(value: unknown): DriverVehicleInput {
  const input = value && typeof value === 'object' ? value as { [key: string]: unknown } : {};
  const year = Number(input['year'] ?? input['vehicle_year']);
  const serviceEligibility = input['serviceEligibility'] ?? input['service_eligibility'];
  const rawSubtype = text(input['vehicleSubtype'] ?? input['vehicle_subtype'] ?? input['subtype']);
  const parsed = {
    vehicleType: text(input['vehicleType'] ?? input['type'] ?? input['vehicle_type']),
    vehicleSubtype: rawSubtype && canonicalBikeSubtypes.includes(rawSubtype) ? rawSubtype : null,
    make: text(input['make']), model: text(input['model']),
    colour: text(input['colour'] ?? input['color']), year,
    registrationNumber: text(input['registrationNumber'] ?? input['licensePlate'] ?? input['license_plate'] ?? input['registration_number']),
    capacity: text(input['capacity']) || null,
    serviceEligibility: Array.isArray(serviceEligibility) ? serviceEligibility.map(text).filter(Boolean) : []
  };
  if (!parsed.make || !parsed.model || !parsed.colour || !parsed.vehicleType) throw new Error('Make, model, colour and vehicle type are required.');
  if (!Number.isInteger(year) || year < 1900 || year > new Date().getUTCFullYear() + 2) throw new Error('Enter a valid vehicle year.');
  // Pedal bicycles do not require a motor-vehicle registration; all other bikes and motor vehicles do.
  const needsRegistration = parsed.vehicleSubtype !== 'pedal_bicycle';
  if (needsRegistration && !parsed.registrationNumber) throw new Error('Vehicle registration is required.');
  return parsed;
}
