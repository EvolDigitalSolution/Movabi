export type DriverRequirementSeverity = 'blocker' | 'warning' | 'review';
export type DriverRequirementStatus = 'missing' | 'uploaded' | 'under_review' | 'approved' | 'not_required' | 'rejected' | 'expired';
export type DriverRequirementCategory = 'profile' | 'vehicle' | 'document' | 'service' | 'payout' | 'country';
export type DriverVehicleClass = 'bike' | 'car' | 'xl_7_seater' | 'small_van' | 'large_van';
export type DriverServiceType = 'ride' | 'errand' | 'delivery' | 'van';

export interface DriverRequirementResult {
  key: string;
  label: string;
  message: string;
  status: DriverRequirementStatus;
  severity: DriverRequirementSeverity;
  category: DriverRequirementCategory;
  required: boolean;
  serviceTypes?: DriverServiceType[];
  vehicleClasses?: DriverVehicleClass[];
}

export interface DriverRequirementsInput {
  countryCode?: string | null;
  driver?: any;
  vehicle?: any;
  documents?: any;
  selectedServices?: string[] | null;
}

const COUNTRY_CONFIGS: Record<string, {
  expiryWarningDays: number;
  requireDateOfBirth: boolean;
  requireCourierInsurance: boolean;
  requireGoodsInTransitForVan: boolean;
  requirePublicLiabilityForVan: boolean;
  rideRequiresPrivateHire: boolean;
  rideRequiresBackgroundCheck: boolean;
  adminWarning?: string;
}> = {
  GB: {
    expiryWarningDays: 30,
    requireDateOfBirth: true,
    requireCourierInsurance: true,
    requireGoodsInTransitForVan: true,
    requirePublicLiabilityForVan: false,
    rideRequiresPrivateHire: true,
    rideRequiresBackgroundCheck: true
  },
  US: {
    expiryWarningDays: 30,
    requireDateOfBirth: true,
    requireCourierInsurance: false,
    requireGoodsInTransitForVan: false,
    requirePublicLiabilityForVan: false,
    rideRequiresPrivateHire: false,
    rideRequiresBackgroundCheck: false,
    adminWarning: 'US driver requirements are using default-safe placeholders.'
  },
  NG: {
    expiryWarningDays: 30,
    requireDateOfBirth: true,
    requireCourierInsurance: false,
    requireGoodsInTransitForVan: false,
    requirePublicLiabilityForVan: false,
    rideRequiresPrivateHire: false,
    rideRequiresBackgroundCheck: false,
    adminWarning: 'Nigeria driver requirements are using default-safe placeholders.'
  },
  CA: {
    expiryWarningDays: 30,
    requireDateOfBirth: true,
    requireCourierInsurance: false,
    requireGoodsInTransitForVan: false,
    requirePublicLiabilityForVan: false,
    rideRequiresPrivateHire: false,
    rideRequiresBackgroundCheck: false,
    adminWarning: 'Canada driver requirements are using default-safe placeholders.'
  },
  AU: {
    expiryWarningDays: 30,
    requireDateOfBirth: true,
    requireCourierInsurance: false,
    requireGoodsInTransitForVan: false,
    requirePublicLiabilityForVan: false,
    rideRequiresPrivateHire: false,
    rideRequiresBackgroundCheck: false,
    adminWarning: 'Australia driver requirements are using default-safe placeholders.'
  },
  DEFAULT: {
    expiryWarningDays: 30,
    requireDateOfBirth: true,
    requireCourierInsurance: false,
    requireGoodsInTransitForVan: false,
    requirePublicLiabilityForVan: false,
    rideRequiresPrivateHire: false,
    rideRequiresBackgroundCheck: false,
    adminWarning: 'Country requirements are not fully configured yet.'
  }
};

const ALLOWED_SERVICES: Record<DriverVehicleClass, DriverServiceType[]> = {
  bike: ['errand', 'delivery'],
  car: ['ride', 'errand', 'delivery'],
  xl_7_seater: ['ride', 'errand', 'delivery'],
  small_van: ['delivery', 'van'],
  large_van: ['delivery', 'van']
};

const REGISTRATION_KEYS = ['license_plate', 'registration_plate', 'registration_number', 'plate_number', 'vehicle_registration', 'registration'];

const RIDE_COMPLIANCE_KEYS = {
  councilName: ['council_name', 'councilName', 'licensing_authority', 'private_hire_authority', 'council_license_authority'],
  councilLicenseNumber: ['council_license_number', 'councilLicenceNumber', 'council_licence_number', 'private_hire_license_number', 'private_hire_licence_number', 'taxi_licence_number'],
  taxiBadgeNumber: ['taxi_badge_number', 'taxiBadgeNumber', 'badge_number', 'driver_badge_number'],
  taxiLicenseExpiry: ['taxi_license_expiry', 'taxiLicenceExpiry', 'taxi_licence_expiry', 'private_hire_license_expiry', 'private_hire_licence_expiry', 'private_hire_expiry', 'council_license_expiry'],
  privateHireVehicleLicenseUrl: ['private_hire_vehicle_license_url', 'privateHireVehicleLicenseUrl', 'phv_license_url', 'vehicle_license_url', 'private_hire_vehicle_licence_url', 'phv_licence_url']
};

export function normaliseVehicleClass(vehicle?: any): DriverVehicleClass {
  const raw = safeLower(valueFrom(vehicle, ['vehicle_class', 'service_class', 'type', 'capacity', 'vehicle_type']));
  if (raw.includes('bike') || raw.includes('bicycle') || raw.includes('cycle') || raw.includes('scooter') || raw.includes('moped')) return 'bike';
  if (raw.includes('large_van') || raw.includes('large van') || raw.includes('luton') || raw.includes('box van')) return 'large_van';
  if (raw.includes('small_van') || raw.includes('small van') || raw === 'van' || raw.includes('medium van')) return 'small_van';
  if (raw.includes('xl') || raw.includes('7') || raw.includes('seven') || raw.includes('minibus')) return 'xl_7_seater';
  return 'car';
}

export function normaliseSelectedServices(driver?: any, vehicle?: any, selectedServices?: string[] | null): DriverServiceType[] {
  const verificationItems = parseVerificationItems(driver?.verification_items);
  const rawValues = [
    selectedServices,
    vehicle?.service_eligibility,
    vehicle?.driver_service_types,
    driver?.service_eligibility,
    driver?.driver_service_types,
    verificationItems.driver_service_types,
    verificationItems.selected_services,
    verificationItems.service_types
  ];
  return unique(rawValues.flatMap(parseServiceValue)
    .map((value) => safeLower(value).replace(/\s+/g, '_'))
    .map((value) => value === 'van-moving' || value === 'van_moving' || value === 'moving' ? 'van' : value)
    .map((value) => value === 'package' || value === 'package_delivery' || value === 'parcel' ? 'delivery' : value)
    .filter((value): value is DriverServiceType => ['ride', 'errand', 'delivery', 'van'].includes(value)));
}

export function isRideSelected(driver?: any, vehicle?: any): boolean {
  return normaliseSelectedServices(driver, vehicle).includes('ride');
}

export function vehicleRequiresRegistration(vehicleClass: DriverVehicleClass, _selectedServices: string[] = [], _countryCode?: string | null): boolean {
  return vehicleClass !== 'bike';
}

export function getVehiclePlateValue(vehicle?: any): string {
  return String(valueFrom(vehicle, REGISTRATION_KEYS) || '').trim();
}

export function getDriverRequirements(input: DriverRequirementsInput): DriverRequirementResult[] {
  const driver = { ...parseVerificationItems(input.driver?.verification_items), ...(input.driver || {}) };
  const vehicle = input.vehicle || {};
  const documents = { ...driver, ...vehicle, ...(input.documents || {}) };
  const countryCode = safeUpper(input.countryCode || driver.country_code || driver.country || vehicle.country_code || 'DEFAULT');
  const country = COUNTRY_CONFIGS[countryCode] || COUNTRY_CONFIGS.DEFAULT;
  const vehicleClass = normaliseVehicleClass(vehicle);
  const selectedServices = normaliseSelectedServices(driver, vehicle, input.selectedServices);
  const requirements: DriverRequirementResult[] = [];

  if (country.adminWarning) requirements.push(result('country_config', 'Country requirements', country.adminWarning, 'uploaded', 'warning', 'country', false));
  if (!selectedServices.length) requirements.push(result('selected_services', 'Services', 'Select at least one service type before review.', 'missing', 'blocker', 'service', true));

  selectedServices
    .filter((service) => !ALLOWED_SERVICES[vehicleClass].includes(service))
    .forEach((service) => requirements.push(result(`service_${service}_not_allowed`, 'Service eligibility', `${serviceLabel(service)} is not available for ${vehicleClassLabel(vehicleClass)}.`, 'missing', 'blocker', 'service', true, [service], [vehicleClass])));

  requirements.push(textRequirement(driver, ['full_name', 'legal_name'], 'full_legal_name', 'Full legal name', 'Full legal name is missing.', 'profile'));
  requirements.push(emailRequirement(driver));
  requirements.push(textRequirement(driver, ['phone', 'phone_number', 'mobile'], 'phone', 'Phone number', 'Phone number is missing.', 'profile'));
  if (country.requireDateOfBirth) {
    requirements.push(textRequirement(driver, ['date_of_birth', 'dob'], 'date_of_birth', 'Date of birth', 'Date of birth is missing.', 'profile'));
  }
  requirements.push(textRequirement(vehicle, ['make'], 'vehicle_make', 'Vehicle make', 'Vehicle make is missing.', 'vehicle'));
  requirements.push(textRequirement(vehicle, ['model'], 'vehicle_model', 'Vehicle model', 'Vehicle model is missing.', 'vehicle'));
  requirements.push(textRequirement(vehicle, ['color', 'colour'], 'vehicle_colour', 'Vehicle colour', 'Vehicle colour is missing.', 'vehicle'));
  requirements.push(textRequirement(vehicle, ['year'], 'vehicle_year', 'Vehicle year', 'Vehicle year is missing.', 'vehicle'));

  if (vehicleRequiresRegistration(vehicleClass, selectedServices, countryCode)) {
    requirements.push(textRequirement(vehicle, REGISTRATION_KEYS, 'vehicle_registration', 'Vehicle registration', 'Vehicle registration number is missing.', 'vehicle'));
  } else {
    requirements.push(result('vehicle_registration', 'Vehicle registration', 'Vehicle registration is not required for bike or bicycle drivers.', 'not_required', 'warning', 'vehicle', false, selectedServices, [vehicleClass]));
  }

  if (vehicleClass === 'bike') {
    requirements.push(documentRequirement(documents, ['photo_id_url', 'driver_license_url'], ['photo_id_status', 'driver_license_status'], 'photo_id', 'Photo ID', 'Photo ID is missing.'));
  } else {
    requirements.push(documentRequirement(documents, ['driver_license_url', 'driving_licence_url'], ['driver_license_status', 'driving_licence_status'], 'driver_license', 'Driving licence', 'Driver licence document is missing.'));
  }

  if (selectedServices.some((service) => service === 'errand' || service === 'delivery')) {
    const insuranceKeys = vehicleClass === 'bike' || country.requireCourierInsurance
      ? ['courier_insurance_url', 'hire_reward_insurance_url', 'insurance_url']
      : ['insurance_url', 'courier_insurance_url', 'hire_reward_insurance_url'];
    requirements.push(documentRequirement(documents, insuranceKeys, ['courier_insurance_status', 'insurance_status'], 'courier_insurance', 'Courier insurance', 'Upload correct insurance before accepting this job type.'));
  } else if (selectedServices.includes('ride') || selectedServices.includes('van')) {
    requirements.push(documentRequirement(documents, ['insurance_url'], ['insurance_status'], 'insurance', 'Insurance', 'Insurance document is missing.'));
  }

  if (selectedServices.includes('ride') && country.rideRequiresPrivateHire) {
    requirements.push(textRequirement(driver, RIDE_COMPLIANCE_KEYS.councilName, 'council_name', 'Council / licensing authority', 'Council/private hire authority is missing.', 'profile', ['ride']));
    requirements.push(textRequirement(driver, RIDE_COMPLIANCE_KEYS.councilLicenseNumber, 'council_license_number', 'Council licence number', 'Council licence number is missing.', 'profile', ['ride']));
    requirements.push(textRequirement(driver, RIDE_COMPLIANCE_KEYS.taxiBadgeNumber, 'taxi_badge_number', 'Taxi badge number', 'Taxi badge number is missing.', 'profile', ['ride']));
    requirements.push(textRequirement(driver, RIDE_COMPLIANCE_KEYS.taxiLicenseExpiry, 'taxi_license_expiry', 'Taxi licence expiry date', 'Taxi licence expiry date is missing.', 'profile', ['ride']));
    requirements.push(documentRequirement(driver, RIDE_COMPLIANCE_KEYS.privateHireVehicleLicenseUrl, ['private_hire_vehicle_license_status', 'vehicle_license_status', 'private_hire_vehicle_licence_status'], 'private_hire_vehicle_license', 'Private hire vehicle licence', 'Private hire vehicle licence is missing.', ['ride']));
    requirements.push(documentRequirement(driver, ['private_hire_insurance_url', 'insurance_url'], ['private_hire_insurance_status', 'insurance_status'], 'private_hire_insurance', 'Private hire insurance', 'Private hire insurance is missing.', ['ride']));
  } else {
    requirements.push(result('council_name', 'Council / taxi licence', 'Council/taxi fields are not required unless Ride is selected for a configured country.', 'not_required', 'warning', 'profile', false, selectedServices));
  }

  if (selectedServices.includes('van')) {
    if (country.requireGoodsInTransitForVan) requirements.push(documentRequirement(driver, ['goods_in_transit_url'], ['goods_in_transit_status'], 'goods_in_transit', 'Goods in transit insurance', 'Goods in transit insurance is missing.', ['van']));
    if (country.requirePublicLiabilityForVan) requirements.push(documentRequirement(driver, ['public_liability_url'], ['public_liability_status'], 'public_liability', 'Public liability insurance', 'Public liability insurance is missing.', ['van']));
  }

  const stripeReady = ['enabled', 'connected'].includes(safeLower(driver.stripe_connect_status)) || hasText(driver.stripe_account_id);
  requirements.push(result('stripe_connect', 'Stripe Connect', stripeReady ? 'Stripe payout setup is connected.' : 'Stripe payout setup is missing.', stripeReady ? 'approved' : 'missing', stripeReady ? 'warning' : 'blocker', 'payout', true));

  return uniqueByKey(requirements);
}

export function getBlockingRequirements(input: DriverRequirementsInput): DriverRequirementResult[] {
  return getDriverRequirements(input).filter((requirement) => requirement.required && requirement.severity === 'blocker' && ['missing', 'rejected', 'expired'].includes(requirement.status));
}

export function getAdminReviewRequirements(input: DriverRequirementsInput): DriverRequirementResult[] {
  return getDriverRequirements(input).filter((requirement) => requirement.severity === 'review' || requirement.status === 'under_review');
}

export function canDriverGoOnline(input: DriverRequirementsInput): boolean {
  return getBlockingRequirements(input).length === 0;
}

export function canDriverAcceptService(input: DriverRequirementsInput, serviceType: DriverServiceType): boolean {
  return getBlockingRequirements({ ...input, selectedServices: [serviceType] }).length === 0;
}

export function getChecklistSummary(input: DriverRequirementsInput): { title: string; rows: DriverRequirementResult[] } {
  const vehicleClass = normaliseVehicleClass(input.vehicle);
  return {
    title: vehicleClass === 'bike' ? 'Bike details and ID checks' : 'Vehicle and service requirements',
    rows: getDriverRequirements(input).filter((requirement) => requirement.required)
  };
}

export function getNotApplicableRequirements(input: DriverRequirementsInput): DriverRequirementResult[] {
  return getDriverRequirements(input).filter((requirement) => requirement.status === 'not_required');
}

function textRequirement(source: any, keys: string[], key: string, label: string, missingMessage: string, category: DriverRequirementCategory, serviceTypes?: DriverServiceType[]): DriverRequirementResult {
  const ok = hasText(valueFrom(source, keys));
  return result(key, label, ok ? `${label} is present.` : missingMessage, ok ? 'uploaded' : 'missing', ok ? 'warning' : 'blocker', category, true, serviceTypes);
}

function emailRequirement(driver: any): DriverRequirementResult {
  const email = driver?.email || driver?.auth_email || driver?.user?.email;
  const ok = hasText(email);
  return result('email', 'Email address', ok ? 'Email address is present.' : 'Email address is missing.', ok ? 'uploaded' : 'missing', ok ? 'warning' : 'blocker', 'profile', true);
}

function documentRequirement(source: any, urlKeys: string[], statusKeys: string[], key: string, label: string, missingMessage: string, serviceTypes?: DriverServiceType[]): DriverRequirementResult {
  const hasFile = hasText(valueFrom(source, urlKeys));
  const status = normaliseDocumentStatus(valueFrom(source, statusKeys));
  if (!hasFile) return result(key, label, missingMessage, 'missing', 'blocker', 'document', true, serviceTypes);
  if (status === 'rejected' || status === 'expired') return result(key, label, `${label} is ${status}.`, status, 'blocker', 'document', true, serviceTypes);
  if (status === 'under_review') return result(key, label, `${label} is under admin review.`, 'under_review', 'review', 'document', true, serviceTypes);
  return result(key, label, `${label} is uploaded.`, status || 'uploaded', 'warning', 'document', true, serviceTypes);
}

function normaliseDocumentStatus(value: unknown): DriverRequirementStatus | null {
  const status = safeLower(value).replace(/\s+/g, '_');
  if (!status) return null;
  if (['approved', 'verified', 'valid'].includes(status)) return 'approved';
  if (['under_review', 'review_required', 'pending_review', 'pending'].includes(status)) return 'under_review';
  if (['rejected', 'failed'].includes(status)) return 'rejected';
  if (status === 'expired') return 'expired';
  if (['uploaded', 'provided'].includes(status)) return 'uploaded';
  return null;
}

function result(key: string, label: string, message: string, status: DriverRequirementStatus, severity: DriverRequirementSeverity, category: DriverRequirementCategory, required: boolean, serviceTypes?: DriverServiceType[], vehicleClasses?: DriverVehicleClass[]): DriverRequirementResult {
  return { key, label, message, status, severity, category, required, serviceTypes, vehicleClasses };
}

function parseServiceValue(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(parseServiceValue);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value.split(',');
    }
  }
  return [value];
}

function parseVerificationItems(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>((items, entry) => {
      if (!entry || typeof entry !== 'object') return items;
      const record = entry as Record<string, unknown>;
      const key = String(record.key || record.name || record.field || '').trim();
      if (key) items[key] = record.value ?? record.label ?? '';
      return items;
    }, {});
  }
  if (typeof value === 'string') {
    try {
      return parseVerificationItems(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function valueFrom(source: any, keys: string[]): unknown {
  if (!source) return '';
  for (const key of keys) {
    const value = source[key];
    if (hasText(value) || typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value)) return value;
  }
  return '';
}

function hasText(value: unknown): boolean {
  return String(value ?? '').trim().length > 0;
}

function safeLower(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function safeUpper(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function uniqueByKey(values: DriverRequirementResult[]): DriverRequirementResult[] {
  const map = new Map<string, DriverRequirementResult>();
  for (const value of values) {
    if (!map.has(value.key)) map.set(value.key, value);
  }
  return Array.from(map.values());
}

function serviceLabel(service: DriverServiceType): string {
  return { ride: 'Ride', errand: 'Errand', delivery: 'Delivery', van: 'Van / moving' }[service];
}

function vehicleClassLabel(vehicleClass: DriverVehicleClass): string {
  return { bike: 'bike', car: 'car', xl_7_seater: 'XL / 7 seater', small_van: 'small van', large_van: 'large van' }[vehicleClass];
}
