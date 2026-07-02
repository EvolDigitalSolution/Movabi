import { Injectable } from '@angular/core';
import { DriverProfile, Profile, ServiceTypeEnum, Vehicle } from '@shared/models/booking.model';

export type AccountComplianceStatus = 'draft' | 'pending_review' | 'approved' | 'action_required' | 'suspended';
export type DocumentComplianceStatus = 'missing' | 'uploaded' | 'under_review' | 'approved' | 'rejected' | 'expired';
export type ComplianceServiceType = ServiceTypeEnum | 'ride' | 'delivery' | 'errand' | 'van' | 'van-moving' | 'base';

export interface ComplianceRequirement {
    key: string;
    label: string;
    message: string;
    severity: 'blocker' | 'warning';
    status?: DocumentComplianceStatus;
}

export interface ComplianceCountryConfig {
    customerRequiredFields: string[];
    driverBaseRequiredFields: string[];
    rideRequiredFields: string[];
    deliveryRequiredFields: string[];
    errandRequiredFields: string[];
    vanRequiredFields: string[];
    requiredDocuments: string[];
    optionalDocuments: string[];
    requireCustomerPhoneVerification: boolean;
    requireDriverPhoneVerification: boolean;
    requireRightToWork: boolean;
    requireRideBackgroundCheck: boolean;
    requireDeliveryCourierInsurance: boolean;
    requireGoodsInTransit: boolean;
    requireVanPublicLiability: boolean;
    highRiskCustomerIdChecks: boolean;
    expiryWarningDays: number;
}

const DOCUMENT_STATUSES = ['missing', 'uploaded', 'under_review', 'approved', 'rejected', 'expired'] as const;

@Injectable({ providedIn: 'root' })
export class ComplianceService {
    private readonly defaultExpiryWarningDays = 30;

    readonly countryConfigs: Record<string, ComplianceCountryConfig> = {
        GB: {
            customerRequiredFields: ['full_name', 'email_verified', 'phone', 'accepted_terms_at', 'accepted_privacy_at'],
            driverBaseRequiredFields: ['full_legal_name', 'date_of_birth', 'current_address', 'phone_verified', 'email_verified', 'profile_photo', 'live_selfie', 'driver_license', 'right_to_work', 'vehicle', 'insurance', 'payout_setup', 'agreements'],
            rideRequiredFields: ['private_hire_driver_license', 'private_hire_vehicle_license', 'council_license', 'private_hire_insurance', 'operator_compliance', 'background_check'],
            deliveryRequiredFields: ['courier_insurance'],
            errandRequiredFields: ['courier_insurance'],
            vanRequiredFields: ['vehicle_size', 'moving_insurance', 'goods_in_transit'],
            requiredDocuments: ['driver_license', 'insurance', 'right_to_work'],
            optionalDocuments: ['profile_photo', 'live_selfie', 'goods_in_transit', 'public_liability'],
            requireCustomerPhoneVerification: true,
            requireDriverPhoneVerification: true,
            requireRightToWork: true,
            requireRideBackgroundCheck: true,
            requireDeliveryCourierInsurance: true,
            requireGoodsInTransit: true,
            requireVanPublicLiability: false,
            highRiskCustomerIdChecks: false,
            expiryWarningDays: 30
        },
        NG: {
            customerRequiredFields: ['full_name', 'email_verified', 'phone', 'accepted_terms_at', 'accepted_privacy_at'],
            driverBaseRequiredFields: ['full_legal_name', 'date_of_birth', 'current_address', 'phone_verified', 'email_verified', 'profile_photo', 'live_selfie', 'driver_license', 'vehicle', 'insurance', 'payout_setup', 'agreements'],
            rideRequiredFields: ['ride_insurance'],
            deliveryRequiredFields: ['courier_insurance'],
            errandRequiredFields: ['courier_insurance'],
            vanRequiredFields: ['vehicle_size', 'moving_insurance'],
            requiredDocuments: ['driver_license', 'insurance'],
            optionalDocuments: ['profile_photo', 'live_selfie', 'goods_in_transit', 'background_check'],
            requireCustomerPhoneVerification: true,
            requireDriverPhoneVerification: true,
            requireRightToWork: false,
            requireRideBackgroundCheck: false,
            requireDeliveryCourierInsurance: true,
            requireGoodsInTransit: false,
            requireVanPublicLiability: false,
            highRiskCustomerIdChecks: true,
            expiryWarningDays: 30
        },
        US: {
            customerRequiredFields: ['full_name', 'email_verified', 'phone', 'accepted_terms_at', 'accepted_privacy_at'],
            driverBaseRequiredFields: ['full_legal_name', 'date_of_birth', 'current_address', 'phone_verified', 'email_verified', 'profile_photo', 'live_selfie', 'driver_license', 'vehicle', 'insurance', 'payout_setup', 'agreements'],
            rideRequiredFields: ['ride_insurance'],
            deliveryRequiredFields: ['courier_insurance'],
            errandRequiredFields: ['courier_insurance'],
            vanRequiredFields: ['vehicle_size', 'moving_insurance', 'goods_in_transit'],
            requiredDocuments: ['driver_license', 'insurance'],
            optionalDocuments: ['profile_photo', 'live_selfie', 'goods_in_transit', 'public_liability'],
            requireCustomerPhoneVerification: true,
            requireDriverPhoneVerification: true,
            requireRightToWork: false,
            requireRideBackgroundCheck: false,
            requireDeliveryCourierInsurance: true,
            requireGoodsInTransit: true,
            requireVanPublicLiability: false,
            highRiskCustomerIdChecks: true,
            expiryWarningDays: 30
        },
        DEFAULT: {
            customerRequiredFields: ['full_name', 'email_verified', 'phone', 'accepted_terms_at', 'accepted_privacy_at'],
            driverBaseRequiredFields: ['full_legal_name', 'date_of_birth', 'current_address', 'phone_verified', 'email_verified', 'profile_photo', 'live_selfie', 'driver_license', 'vehicle', 'insurance', 'payout_setup', 'agreements'],
            rideRequiredFields: ['ride_insurance'],
            deliveryRequiredFields: ['courier_insurance'],
            errandRequiredFields: ['courier_insurance'],
            vanRequiredFields: ['vehicle_size', 'moving_insurance'],
            requiredDocuments: ['driver_license', 'insurance'],
            optionalDocuments: ['profile_photo', 'live_selfie', 'goods_in_transit', 'public_liability'],
            requireCustomerPhoneVerification: false,
            requireDriverPhoneVerification: false,
            requireRightToWork: false,
            requireRideBackgroundCheck: false,
            requireDeliveryCourierInsurance: false,
            requireGoodsInTransit: false,
            requireVanPublicLiability: false,
            highRiskCustomerIdChecks: false,
            expiryWarningDays: 30
        }
    };

    getCustomerMissingRequirements(profile: Partial<Profile> | null | undefined): ComplianceRequirement[] {
        const config = this.configFor(profile?.country_code);
        const missing: ComplianceRequirement[] = [];

        if (!this.hasFullName(profile)) {
            missing.push(this.blocker('full_name', 'Full name', 'Complete your profile before booking.'));
        }

        if (!this.hasEmail(profile)) {
            missing.push(this.blocker('email', 'Email address', 'Add an email address before booking.'));
        } else if (this.emailVerificationSupported(profile) && !this.isEmailVerified(profile)) {
            missing.push(this.blocker('email_verified', 'Email verified', 'Verify your email before booking.'));
        }

        if (!this.hasText(profile?.phone)) {
            missing.push(this.blocker('phone', 'Phone number', 'Add your mobile number before booking.'));
        } else if (config.requireCustomerPhoneVerification && this.phoneVerificationSupported(profile) && !this.isPhoneVerified(profile)) {
            missing.push(this.blocker('phone_verified', 'Phone verified', 'Verify your phone number before booking.'));
        }

        if (!this.hasDate(profile?.accepted_terms_at)) {
            missing.push(this.blocker('accepted_terms_at', 'Terms accepted', 'Accept the Movabi terms before booking.'));
        }

        if (!this.hasDate(profile?.accepted_privacy_at)) {
            missing.push(this.blocker('accepted_privacy_at', 'Privacy accepted', 'Accept the Movabi privacy notice before booking.'));
        }

        return missing;
    }

    getDriverMissingRequirements(
        profile: Partial<DriverProfile> | Partial<Profile> | null | undefined,
        vehicle?: Partial<Vehicle> | null,
        documents?: Record<string, unknown> | null,
        serviceType: ComplianceServiceType = 'base'
    ): ComplianceRequirement[] {
        const config = this.configFor(profile?.country_code);
        const relaxedLegacy = this.isLegacyApprovedDriver(profile);
        const missing: ComplianceRequirement[] = [];
        const docBag = { ...(documents || {}), ...(profile || {}) } as Record<string, unknown>;

        this.pushBaseDriverRequirements(missing, profile, vehicle, docBag, config, relaxedLegacy);

        if (serviceType !== 'base') {
            this.pushServiceRequirements(missing, profile, vehicle, docBag, serviceType, config, relaxedLegacy);
        }

        this.pushExpiryChecks(missing, profile, vehicle, docBag, config);

        return this.uniqueRequirements(missing);
    }

    getDriverBaseMissingRequirements(
        profile: Partial<DriverProfile> | Partial<Profile> | null | undefined,
        vehicle?: Partial<Vehicle> | null,
        documents?: Record<string, unknown> | null
    ): ComplianceRequirement[] {
        return this.getDriverMissingRequirements(profile, vehicle, documents, 'base');
    }

    canCustomerBook(profile: Partial<Profile> | null | undefined): { allowed: boolean; missing: ComplianceRequirement[] } {
        const missing = this.getCustomerMissingRequirements(profile).filter((item) => item.severity === 'blocker');
        return { allowed: missing.length === 0, missing };
    }

    canDriverAcceptService(
        profile: Partial<DriverProfile> | Partial<Profile> | null | undefined,
        vehicle: Partial<Vehicle> | null | undefined,
        documents: Record<string, unknown> | null | undefined,
        serviceType: ComplianceServiceType
    ): { allowed: boolean; missing: ComplianceRequirement[] } {
        const missing = this.getDriverMissingRequirements(profile, vehicle, documents, serviceType)
            .filter((item) => item.severity === 'blocker');
        return { allowed: missing.length === 0, missing };
    }

    formatMissingRequirements(missing: ComplianceRequirement[], fallback = 'Complete the missing requirements before continuing.'): string {
        if (!missing.length) return '';
        const labels = missing.slice(0, 4).map((item) => item.message || item.label);
        const suffix = missing.length > labels.length ? ` and ${missing.length - labels.length} more` : '';
        return `${fallback} ${labels.join(' ')}${suffix}.`;
    }

    getCountryConfig(countryCode?: string | null): ComplianceCountryConfig {
        return this.configFor(countryCode);
    }

    getCountryConfigurationWarning(countryCode?: string | null): string | null {
        const code = String(countryCode || '').trim().toUpperCase();
        if (!code || code === 'GB') return null;
        return `${code} country requirement is not fully configured. DEFAULT-safe checks are being used.`;
    }

    private pushBaseDriverRequirements(
        missing: ComplianceRequirement[],
        profile: Partial<DriverProfile> | Partial<Profile> | null | undefined,
        vehicle: Partial<Vehicle> | null | undefined,
        documents: Record<string, unknown>,
        config: ComplianceCountryConfig,
        relaxedLegacy: boolean
    ) {
        this.requireText(missing, this.hasFullName(profile), 'full_legal_name', 'Full legal name', 'Add your full legal name.', relaxedLegacy);
        this.requireText(missing, this.hasDate(profile?.date_of_birth), 'date_of_birth', 'Date of birth', 'Add your date of birth.', relaxedLegacy);
        this.requireText(missing, this.hasCurrentAddress(profile), 'current_address', 'Current address', 'Add your current address.', relaxedLegacy);

        if (this.emailVerificationSupported(profile) && !this.isEmailVerified(profile)) {
            missing.push(this.driverRequirement('email_verified', 'Email verified', 'Verify your email address.', relaxedLegacy));
        } else if (!this.hasEmail(profile)) {
            missing.push(this.driverRequirement('email', 'Email address', 'Add your email address.', relaxedLegacy));
        }

        if (config.requireDriverPhoneVerification && this.phoneVerificationSupported(profile) && !this.isPhoneVerified(profile)) {
            missing.push(this.driverRequirement('phone_verified', 'Phone verified', 'Verify your phone number.', relaxedLegacy));
        } else if (!this.hasText(profile?.phone)) {
            missing.push(this.driverRequirement('phone', 'Phone number', 'Add your mobile number.', relaxedLegacy));
        }

        this.warnDocument(missing, 'profile_photo', 'Profile photo', 'Add a clear driver profile photo.', documents, ['avatar_url', 'profile_photo_url']);
        this.warnDocument(missing, 'live_selfie', 'Live selfie', 'Live selfie verification will be required when enabled.', documents, ['live_selfie_url', 'selfie_url']);
        this.requireDocument(missing, 'driver_license', 'Driving licence', 'Upload your driving licence document.', documents, ['driver_license_url'], relaxedLegacy, ['driver_license_status']);

        if (config.requireRightToWork) {
            const hasRightToWork = this.hasTextValue(documents['right_to_work_url']) || this.hasTextValue(documents['right_to_work_share_code']);
            this.requireText(missing, hasRightToWork, 'right_to_work', 'Right to work', 'Upload right to work evidence or add your share code.', relaxedLegacy);
        }

        if (!vehicle) {
            missing.push(this.driverRequirement('vehicle', 'Vehicle details', 'Add vehicle or bike details.', relaxedLegacy));
        } else {
            this.requireText(missing, this.hasText(vehicle.make), 'vehicle_make', 'Vehicle make', 'Add vehicle make.', relaxedLegacy);
            this.requireText(missing, this.hasText(vehicle.model), 'vehicle_model', 'Vehicle model', 'Add vehicle model.', relaxedLegacy);
            this.requireText(missing, this.hasText(vehicle.color), 'vehicle_colour', 'Vehicle colour', 'Add vehicle colour.', relaxedLegacy);

            if (this.requiresRegistration(vehicle)) {
                this.requireText(missing, this.hasText(vehicle.license_plate), 'vehicle_registration', 'Vehicle registration', 'Add vehicle registration.', relaxedLegacy);
            }
        }

        this.requireDocument(missing, 'insurance', 'Insurance', 'Upload correct insurance before accepting this job type.', documents, ['insurance_url'], relaxedLegacy, ['insurance_status']);

        const payoutReady =
            profile?.stripe_connect_status === 'enabled' ||
            profile?.stripe_connect_status === 'connected' ||
            (profile as Partial<DriverProfile>)?.subscription_status === 'active';
        this.requireText(missing, payoutReady, 'payout_setup', 'Payout setup', 'Complete Stripe Connect payout setup.', relaxedLegacy);

        const agreementsAccepted = this.hasDate(profile?.accepted_terms_at) &&
            this.hasDate(profile?.accepted_privacy_at) &&
            this.hasDate(profile?.accepted_driver_agreement_at);
        this.requireText(missing, agreementsAccepted, 'agreements', 'Driver agreements', 'Accept the terms, privacy notice, and driver agreement.', relaxedLegacy);
    }

    private pushServiceRequirements(
        missing: ComplianceRequirement[],
        profile: Partial<DriverProfile> | Partial<Profile> | null | undefined,
        vehicle: Partial<Vehicle> | null | undefined,
        documents: Record<string, unknown>,
        serviceType: ComplianceServiceType,
        config: ComplianceCountryConfig,
        relaxedLegacy: boolean
    ) {
        const normalized = this.normaliseService(serviceType);

        if (normalized !== 'base' && !this.driverSelectedService(profile, vehicle, normalized)) {
            missing.push(this.driverRequirement(
                `service_${normalized}`,
                'Selected service',
                'Enable this service in Driver Setup before accepting this job type.',
                false
            ));
            return;
        }

        if (normalized === 'ride') {
            missing.push(...this.rideRequirements(profile, documents, config, relaxedLegacy));
            return;
        }

        if (normalized === 'delivery' || normalized === 'errand') {
            if (config.requireDeliveryCourierInsurance) {
                this.requireDocument(missing, 'courier_insurance', 'Courier insurance', 'Upload hire and reward/courier insurance before accepting this job type.', documents, ['courier_insurance_url', 'insurance_url'], relaxedLegacy, ['courier_insurance_status', 'insurance_status']);
            }

            if (config.requireGoodsInTransit && normalized === 'delivery') {
                this.requireDocument(missing, 'goods_in_transit', 'Goods in transit', 'Upload goods in transit insurance for delivery jobs.', documents, ['goods_in_transit_insurance_url'], relaxedLegacy, ['goods_in_transit_insurance_status']);
            }
            return;
        }

        if (normalized === 'van') {
            this.requireText(missing, !!vehicle?.capacity || ['small_van', 'large_van', 'van', 'minibus'].includes(String(vehicle?.type || '')), 'vehicle_size', 'Vehicle size', 'Add the van size/type you use for moving jobs.', relaxedLegacy);
            this.requireDocument(missing, 'moving_insurance', 'Moving insurance', 'Upload insurance suitable for paid moving work.', documents, ['moving_insurance_url', 'insurance_url'], relaxedLegacy, ['moving_insurance_status', 'insurance_status']);

            if (config.requireGoodsInTransit) {
                this.requireDocument(missing, 'goods_in_transit', 'Goods in transit', 'Upload goods in transit insurance for moving jobs.', documents, ['goods_in_transit_insurance_url'], relaxedLegacy, ['goods_in_transit_insurance_status']);
            }

            if (config.requireVanPublicLiability) {
                this.requireDocument(missing, 'public_liability', 'Public liability', 'Upload public liability insurance for moving jobs.', documents, ['public_liability_insurance_url'], relaxedLegacy, ['public_liability_insurance_status']);
            }
        }
    }

    private rideRequirements(
        profile: Partial<DriverProfile> | Partial<Profile> | null | undefined,
        documents: Record<string, unknown>,
        config: ComplianceCountryConfig,
        relaxedLegacy: boolean
    ): ComplianceRequirement[] {
        const missing: ComplianceRequirement[] = [];

        const fields = new Set(config.rideRequiredFields || []);

        if (fields.has('private_hire_driver_license')) {
            this.requireDocument(missing, 'private_hire_driver_license', 'Private hire/taxi driver licence', 'Passenger rides require local private hire/taxi approval.', documents, ['private_hire_driver_license_url', 'driver_license_url'], relaxedLegacy, ['private_hire_driver_license_status', 'driver_license_status']);
        }

        if (fields.has('private_hire_vehicle_license')) {
            this.requireDocument(missing, 'private_hire_vehicle_license', 'Private hire/taxi vehicle licence', 'Upload your private hire/taxi vehicle licence.', documents, ['private_hire_vehicle_license_url', 'vehicle_license_url'], relaxedLegacy, ['private_hire_vehicle_license_status', 'vehicle_license_status']);
        }

        if (fields.has('council_license')) {
            this.requireText(missing, this.hasTextValue(documents['council_license_authority']) || this.hasVerificationItem(profile, 'council_name'), 'council_license_authority', 'Licence authority', 'Add your council or TfL licence authority.', relaxedLegacy);
            this.requireText(missing, this.hasTextValue(documents['council_license_number']) || this.hasVerificationItem(profile, 'council_license_number'), 'council_license_number', 'Licence number', 'Add your private hire/taxi licence number.', relaxedLegacy);
            this.requireText(missing, this.hasDateValue(documents['council_license_expiry']) || this.hasVerificationItem(profile, 'taxi_license_expiry'), 'council_license_expiry', 'Licence expiry', 'Add your licence expiry date.', relaxedLegacy);
        }

        if (fields.has('private_hire_insurance') || fields.has('ride_insurance')) {
            this.requireDocument(missing, 'private_hire_insurance', 'Ride insurance', 'Upload insurance suitable for passenger ride jobs.', documents, ['private_hire_insurance_url', 'ride_insurance_url', 'insurance_url'], relaxedLegacy, ['private_hire_insurance_status', 'ride_insurance_status', 'insurance_status']);
        }

        if (fields.has('operator_compliance')) {
            this.requireText(missing, this.statusApproved(documents['operator_compliance_status']) || relaxedLegacy, 'operator_compliance', 'Operator compliance', 'Operator/compliance check is required before enabling ride jobs.', relaxedLegacy);
        }

        if (fields.has('local_transport_permit')) {
            this.requireText(missing, this.hasTextValue(documents['local_transport_permit_url']) || this.hasTextValue(documents['local_transport_permit_number']), 'local_transport_permit', 'Local transport permit', 'Add your local transport permit where required.', relaxedLegacy);
        }

        if (fields.has('vehicle_roadworthiness')) {
            this.requireText(missing, this.hasTextValue(documents['roadworthiness_certificate_url']) || this.hasTextValue(documents['mot_url']), 'vehicle_roadworthiness', 'Roadworthiness', 'Upload vehicle roadworthiness evidence where required.', relaxedLegacy);
        }

        if (fields.has('local_tnc_permit')) {
            this.requireText(missing, this.hasTextValue(documents['local_tnc_permit_url']) || this.hasTextValue(documents['local_tnc_permit_number']), 'local_tnc_permit', 'Local TNC permit', 'Add your local ride-hailing/TNC permit where required.', relaxedLegacy);
        }

        if (fields.has('local_ride_approval')) {
            this.requireText(missing, this.hasTextValue(documents['local_ride_approval_url']) || this.hasTextValue(documents['local_ride_approval_number']), 'local_ride_approval', 'Local ride approval', 'Add local passenger ride approval where required.', relaxedLegacy);
        }

        if (config.requireRideBackgroundCheck) {
            this.requireText(missing, this.statusApproved(documents['background_check_status']) || this.statusApproved(documents['dbs_status']) || relaxedLegacy, 'background_check', 'Background check', 'DBS/background-check status is required where local law requires it.', relaxedLegacy);
        }

        return missing;
    }

    private pushExpiryChecks(
        missing: ComplianceRequirement[],
        profile: Partial<DriverProfile> | Partial<Profile> | null | undefined,
        vehicle: Partial<Vehicle> | null | undefined,
        documents: Record<string, unknown>,
        config: ComplianceCountryConfig
    ) {
        const checks: Array<[string, string, unknown]> = [
            ['driver_license_expiry', 'Driving licence', documents['driver_license_expiry']],
            ['insurance_expiry', 'Insurance', documents['insurance_expiry']],
            ['mot_expiry', 'MOT/roadworthiness', documents['mot_expiry']],
            ['vehicle_license_expiry', 'Vehicle licence', documents['vehicle_license_expiry']],
            ['council_license_expiry', 'Council licence', documents['council_license_expiry']],
            ['courier_insurance_expiry', 'Courier insurance', documents['courier_insurance_expiry']],
            ['goods_in_transit_insurance_expiry', 'Goods in transit insurance', documents['goods_in_transit_insurance_expiry']],
            ['public_liability_insurance_expiry', 'Public liability insurance', documents['public_liability_insurance_expiry']]
        ];

        for (const [key, label, value] of checks) {
            const parsed = this.parseDate(value);
            if (!parsed) continue;

            const now = new Date();
            now.setHours(0, 0, 0, 0);
            parsed.setHours(0, 0, 0, 0);
            const daysUntilExpiry = Math.ceil((parsed.getTime() - now.getTime()) / 86400000);

            if (daysUntilExpiry < 0) {
                missing.push({
                    key,
                    label,
                    message: `${label} has expired.`,
                    severity: 'blocker',
                    status: 'expired'
                });
            } else if (daysUntilExpiry <= (config.expiryWarningDays || this.defaultExpiryWarningDays)) {
                missing.push({
                    key,
                    label,
                    message: `${label} expires in ${daysUntilExpiry} days.`,
                    severity: 'warning'
                });
            }
        }
    }

    private requireDocument(
        missing: ComplianceRequirement[],
        key: string,
        label: string,
        message: string,
        documents: Record<string, unknown>,
        urlKeys: string[],
        relaxedLegacy: boolean,
        statusKeys: string[] = []
    ) {
        const hasDocument = urlKeys.some((urlKey) => this.hasTextValue(documents[urlKey]));
        const status = this.firstDocumentStatus(documents, statusKeys);

        if (!hasDocument) {
            missing.push(this.driverRequirement(key, label, message, relaxedLegacy, 'missing'));
            return;
        }

        if (!status) return;

        if (status === 'approved') return;

        if (status === 'expired' || status === 'rejected') {
            missing.push(this.blocker(key, label, status === 'expired' ? `${label} has expired.` : `${label} was rejected. Upload a new document.`, status));
            return;
        }

        if (status === 'uploaded' || status === 'under_review') {
            missing.push(this.blocker(key, label, 'Your documents are under review.', status));
        }
    }

    private warnDocument(
        missing: ComplianceRequirement[],
        key: string,
        label: string,
        message: string,
        documents: Record<string, unknown>,
        urlKeys: string[]
    ) {
        const hasDocument = urlKeys.some((urlKey) => this.hasTextValue(documents[urlKey]));
        if (hasDocument) return;
        missing.push({ key, label, message, severity: 'warning', status: 'missing' });
    }

    private requireText(
        missing: ComplianceRequirement[],
        condition: boolean,
        key: string,
        label: string,
        message: string,
        relaxedLegacy: boolean
    ) {
        if (condition) return;
        missing.push(this.driverRequirement(key, label, message, relaxedLegacy));
    }

    private driverRequirement(key: string, label: string, message: string, relaxedLegacy: boolean, status?: DocumentComplianceStatus): ComplianceRequirement {
        return relaxedLegacy
            ? { key, label, message, severity: 'warning', status }
            : this.blocker(key, label, message, status);
    }

    private blocker(key: string, label: string, message: string, status?: DocumentComplianceStatus): ComplianceRequirement {
        return { key, label, message, severity: 'blocker', status };
    }

    private configFor(countryCode?: string | null): ComplianceCountryConfig {
        return this.countryConfigs[String(countryCode || '').toUpperCase()] || this.countryConfigs['DEFAULT'];
    }

    private normaliseService(serviceType: ComplianceServiceType): 'ride' | 'delivery' | 'errand' | 'van' | 'base' {
        const value = String(serviceType || 'base');
        if (value === ServiceTypeEnum.VAN || value === 'van' || value === 'van-moving') return 'van';
        if (value === ServiceTypeEnum.DELIVERY || value === 'delivery') return 'delivery';
        if (value === ServiceTypeEnum.ERRAND || value === 'errand') return 'errand';
        if (value === ServiceTypeEnum.RIDE || value === 'ride') return 'ride';
        return 'base';
    }

    private driverSelectedService(
        profile: Partial<DriverProfile> | Partial<Profile> | null | undefined,
        vehicle: Partial<Vehicle> | null | undefined,
        service: 'ride' | 'delivery' | 'errand' | 'van'
    ): boolean {
        const selected = this.getSelectedServices(profile, vehicle);
        if (!selected.length) return true;
        return selected.includes(service);
    }

    private getSelectedServices(
        profile: Partial<DriverProfile> | Partial<Profile> | null | undefined,
        vehicle: Partial<Vehicle> | null | undefined
    ): Array<'ride' | 'delivery' | 'errand' | 'van'> {
        const values: unknown[] = [];
        const vehicleServices = (vehicle as any)?.service_eligibility;

        if (Array.isArray(vehicleServices)) {
            values.push(...vehicleServices);
        } else if (typeof vehicleServices === 'string') {
            values.push(vehicleServices);
        }

        const items = this.parseVerificationItems(profile?.verification_items);
        if (items['driver_service_types']) values.push(items['driver_service_types']);

        return this.normaliseServiceList(values);
    }

    private normaliseServiceList(values: unknown[]): Array<'ride' | 'delivery' | 'errand' | 'van'> {
        const flattened = values.flatMap(value => {
            if (Array.isArray(value)) return value;
            if (typeof value === 'string') {
                try {
                    const parsed = JSON.parse(value);
                    if (Array.isArray(parsed)) return parsed;
                } catch {
                    return value.split(',');
                }
            }
            return [value];
        });

        return Array.from(new Set(flattened
            .map(value => String(value || '').trim().toLowerCase())
            .map(value => value === 'van-moving' || value === 'moving' ? 'van' : value)
            .map(value => value === 'package' || value === 'package_delivery' ? 'delivery' : value)
            .filter((value): value is 'ride' | 'delivery' | 'errand' | 'van' => ['ride', 'delivery', 'errand', 'van'].includes(value))));
    }

    private hasFullName(profile?: Partial<Profile> | null): boolean {
        return this.hasText(profile?.full_name) || (this.hasText(profile?.first_name) && this.hasText(profile?.last_name));
    }

    private hasEmail(profile?: Partial<Profile> | null): boolean {
        const record = (profile || {}) as Record<string, unknown>;
        return this.hasText(profile?.email) ||
            this.hasText(record['auth_email']) ||
            this.hasText((record['user'] as Record<string, unknown> | undefined)?.['email']) ||
            this.hasText(record['customer_settings_email']);
    }

    private isEmailVerified(profile?: Partial<Profile> | null): boolean {
        return profile?.email_verified === true || this.hasDate(profile?.email_confirmed_at) || this.isLegacyApprovedDriver(profile);
    }

    private emailVerificationSupported(profile?: Partial<Profile> | null): boolean {
        return profile?.email_verified !== null && profile?.email_verified !== undefined ||
            this.hasDate(profile?.email_confirmed_at);
    }

    private isPhoneVerified(profile?: Partial<Profile> | null): boolean {
        return profile?.phone_verified === true || this.hasDate(profile?.phone_verified_at);
    }

    private phoneVerificationSupported(profile?: Partial<Profile> | null): boolean {
        return profile?.phone_verification_supported === true;
    }

    private hasCurrentAddress(profile?: Partial<Profile> | null): boolean {
        return this.hasText(profile?.current_address) ||
            this.hasText(profile?.address_line1) ||
            this.hasText(profile?.home_address);
    }

    private isLegacyApprovedDriver(profile?: Partial<DriverProfile> | Partial<Profile> | null): boolean {
        return profile?.role === 'driver' && (
            profile?.is_verified === true ||
            profile?.verification_status === 'approved' ||
            profile?.testing_approval_override === true ||
            profile?.compliance_status === 'approved'
        );
    }

    private requiresRegistration(vehicle?: Partial<Vehicle> | null): boolean {
        const type = String(vehicle?.type || '').toLowerCase();
        return type !== 'bike' && type !== 'bicycle' && type !== 'cycle';
    }

    private firstDocumentStatus(documents: Record<string, unknown>, statusKeys: string[]): DocumentComplianceStatus | null {
        for (const key of statusKeys) {
            const raw = String(documents[key] || '').toLowerCase();
            if ((DOCUMENT_STATUSES as readonly string[]).includes(raw)) {
                return raw as DocumentComplianceStatus;
            }
        }

        return null;
    }

    private statusApproved(value: unknown): boolean {
        return String(value || '').toLowerCase() === 'approved';
    }

    private hasVerificationItem(profile: Partial<Profile> | null | undefined, key: string): boolean {
        return this.hasTextValue(this.parseVerificationItems(profile?.verification_items)[key]);
    }

    private parseVerificationItems(value: unknown): Record<string, unknown> {
        if (!value) return {};

        if (Array.isArray(value)) {
            return value.reduce<Record<string, unknown>>((items, entry) => {
                if (!entry || typeof entry !== 'object') {
                    return items;
                }

                const record = entry as Record<string, unknown>;
                const key = String(record['key'] || record['name'] || record['field'] || '').trim();
                if (key) items[key] = record['value'] ?? record['label'] ?? '';
                return items;
            }, {});
        }

        if (typeof value === 'object') {
            return value as Record<string, unknown>;
        }

        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return this.parseVerificationItems(parsed);
            } catch {
                return {};
            }
        }

        return {};
    }

    private hasDate(value: unknown): boolean {
        return !!this.parseDate(value);
    }

    private hasDateValue(value: unknown): boolean {
        return this.hasDate(value);
    }

    private parseDate(value: unknown): Date | null {
        if (!value) return null;
        const parsed = value instanceof Date ? value : new Date(String(value));
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    private hasText(value?: unknown): boolean {
        return this.hasTextValue(value);
    }

    private hasTextValue(value: unknown): boolean {
        return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined && value !== '';
    }

    private uniqueRequirements(items: ComplianceRequirement[]): ComplianceRequirement[] {
        const seen = new Set<string>();
        return items.filter((item) => {
            const key = `${item.key}:${item.severity}:${item.status || ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
}
