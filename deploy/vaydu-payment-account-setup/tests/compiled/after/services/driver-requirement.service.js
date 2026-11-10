"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverRequirementService = void 0;
const driver_profile_model_1 = require("../models/driver-profile.model");
const driver_passenger_licence_model_1 = require("../models/driver-passenger-licence.model");
class DriverRequirementService {
    static resolve(input) {
        const profile = input.profile || {}, onboardingItems = this.onboardingItems(profile.verification_items), vehicle = input.vehicle || { id: '', userId: '', type: '', make: null, model: null, colour: null, year: null, registrationNumber: null, capacity: null, serviceEligibility: [], status: 'missing' }, now = input.now || new Date();
        const canonicalProfile = input.canonicalProfile || (0, driver_profile_model_1.mapDriverProfile)({ id: String(profile.id || ''), ...profile }, input.authEmailConfirmed);
        const selectedServices = this.services(profile, vehicle, onboardingItems);
        const vehicleType = this.vehicle(vehicle, profile);
        const requirements = [];
        const add = (code, label, category, ok, reason, services = selectedServices, invalid = false, review = false, expiryDate = null, expiringSoon = false) => requirements.push({ code, label, category, status: ok ? (review ? 'under_review' : 'completed') : (invalid ? 'invalid' : 'missing'), required: true, completed: ok && !review, blockingForSubmission: !ok, blockingForOnline: !ok || review, needsAdminReview: review, reason, services, expiryDate, expiringSoon });
        // Document/licence requirement with canonical expiry evaluation. Expiry is
        // date-only (YYYY-MM-DD) and only checked when the document is present and
        // actually applicable to the selected services.
        const addDocument = (code, label, hasDoc, expiryValue, missingReason, services = selectedServices) => { const exp = this.expiryState(expiryValue, now); const expired = hasDoc && exp.expired; const ok = hasDoc && !expired; requirements.push({ code, label, category: 'documents', status: hasDoc ? (expired ? 'expired' : 'completed') : 'missing', required: true, completed: ok, blockingForSubmission: !ok, blockingForOnline: !ok, needsAdminReview: false, reason: expired ? `${label} has expired.` : missingReason, services, expiryDate: exp.expiryDate, expiringSoon: hasDoc && exp.expiringSoon }); };
        add('profile.full_name', 'Legal name', 'basic', this.has(canonicalProfile.fullName), 'Add your full legal name.');
        add('profile.phone', 'Phone', 'basic', this.has(canonicalProfile.phone), 'Add your contact number.');
        add('profile.address', 'Residential address', 'basic', this.has(canonicalProfile.residentialAddress), 'Add your current residential address.');
        add('profile.email_verification', 'Email verified', 'basic', canonicalProfile.emailConfirmed, 'Confirm your sign-in email address.');
        const age = this.age(canonicalProfile.dateOfBirth, now, 18);
        requirements.push({ code: 'profile.date_of_birth', label: 'Date of birth', category: 'basic', status: age.state, required: true, completed: age.eligible, blockingForSubmission: !age.eligible, blockingForOnline: !age.eligible, needsAdminReview: false, reason: age.reason || 'Date of birth confirmed.', services: [] });
        add('service.selection', 'Selected services', 'services', selectedServices.length > 0, 'Select at least one service.');
        add('agreement.driver_terms', 'Driver agreement', 'agreement', this.has(profile.accepted_driver_agreement_at), 'Review and accept the Driver Agreement.');
        const country = String(input.countryCode || profile.country_code || '').toUpperCase();
        if (country === 'GB')
            add('work.right_to_work', 'Right to work', 'documents', this.has(profile.right_to_work_url || profile.right_to_work_share_code), 'Provide right-to-work evidence.');
        if (selectedServices.length) {
            const motor = vehicleType !== null && vehicleType !== 'bicycle';
            const vehicleBased = motor || selectedServices.includes('ride') || selectedServices.includes('van-moving');
            add('vehicle.operating_method', 'Operating method', 'vehicle', vehicleType !== null, 'Choose how you will provide the selected services.');
            if (vehicleBased) {
                add('vehicle.make', 'Vehicle make', 'vehicle', this.has(vehicle.make), 'Add the vehicle make.');
                add('vehicle.model', 'Vehicle model', 'vehicle', this.has(vehicle.model), 'Add the vehicle model.');
                add('vehicle.colour', 'Vehicle colour', 'vehicle', this.has(vehicle.colour), 'Add the vehicle colour.');
                add('vehicle.year', 'Vehicle year', 'vehicle', Number(vehicle.year) > 1900, 'Add a valid vehicle year.');
                add('vehicle.registration', 'Vehicle registration', 'vehicle', this.has(vehicle.registrationNumber), 'Add the registration number.');
                addDocument('document.driving_licence', 'Driving licence', this.has(profile.driver_license_url || profile.driving_licence_url), profile.driver_license_expiry, 'Upload the appropriate driving licence.');
                addDocument('document.insurance', 'Vehicle insurance', this.has(profile.insurance_url || profile.courier_insurance_url || profile.hire_reward_insurance_url), profile.insurance_expiry, 'Insurance covering your vehicle for the services you accept.');
            }
            else if (vehicleType === 'bicycle') {
                add('vehicle.bicycle_declaration', 'Bicycle details', 'vehicle', this.has(vehicle.type) || onboardingItems['bicycle_declaration'] === true, 'Add bicycle details or confirm your bicycle declaration.');
                add('vehicle.delivery_equipment', 'Delivery equipment', 'vehicle', onboardingItems['delivery_equipment_confirmed'] === true, 'Confirm suitable delivery equipment.');
            }
            if (selectedServices.includes('ride')) {
                // Canonical passenger-licence evaluation: the licensing requirement is
                // satisfied by the canonical council_name + licence number + badge +
                // expiry (readPassengerLicence), NOT by an ad-hoc vehicle-licence URL.
                const passengerLicence = (0, driver_passenger_licence_model_1.readPassengerLicence)(profile, now);
                const hasAllLicenceFields = !!(passengerLicence.councilName && passengerLicence.licenceNumber && passengerLicence.badgeNumber && passengerLicence.expiryDate);
                const licenceExpired = !passengerLicence.complete && hasAllLicenceFields;
                const licenceExpiry = this.expiryState(passengerLicence.expiryDate, now);
                const licenceExpiringSoon = passengerLicence.complete && licenceExpiry.expiringSoon;
                // Name exactly which canonical fields are outstanding so a driver is never
                // left with an unexplained generic "Incomplete".
                const missingLicenceFields = [
                    !passengerLicence.councilName ? 'licensing authority' : null,
                    !passengerLicence.licenceNumber ? 'private hire licence number' : null,
                    !passengerLicence.badgeNumber ? 'taxi/private hire badge number' : null,
                    !passengerLicence.expiryDate ? 'licence expiry date' : null
                ].filter((item) => item !== null);
                const licenceReason = missingLicenceFields.length
                    ? `Provide the passenger-service licensing configured for this market. Missing: ${missingLicenceFields.join(', ')}.`
                    : 'Provide the passenger-service licensing configured for this market.';
                if (licenceExpired) {
                    requirements.push({ code: 'licence.private_hire', label: 'Private-hire/council licensing', category: 'licensing', status: 'expired', required: true, completed: false, blockingForSubmission: true, blockingForOnline: true, needsAdminReview: false, reason: 'Private-hire driver licence has expired.', services: ['ride'], expiryDate: passengerLicence.expiryDate, expiringSoon: false });
                }
                else {
                    add('licence.private_hire', 'Private-hire/council licensing', 'licensing', passengerLicence.complete, licenceReason, ['ride'], false, false, passengerLicence.expiryDate, licenceExpiringSoon);
                }
                addDocument('document.private_hire_vehicle_license', 'Private-hire vehicle licence', this.has(profile.private_hire_vehicle_license_url), profile.vehicle_license_expiry, 'Upload your private-hire/taxi vehicle licence.', ['ride']);
                add('document.private_hire_insurance', 'Private-hire insurance', 'documents', this.has(profile.private_hire_insurance_url), 'Insurance covering you to carry passengers for hire or reward.', ['ride']);
            }
            if (selectedServices.includes('van-moving')) {
                const gitRequired = country === 'GB';
                addDocument('document.goods_in_transit', 'Goods-in-transit cover', gitRequired ? this.has(profile.goods_in_transit_insurance_url) : true, gitRequired ? profile.goods_in_transit_insurance_expiry : null, 'Upload configured commercial or goods-in-transit cover.', ['van-moving']);
            }
        }
        // Selected develop TEST driver only. Other drivers retain deployed rules.
        if (input.paymentAccountRequired === true) {
            const payment = input.paymentAccount;
            const ready = payment?.provider === 'flutterwave' && payment.available === true && payment.state === 'completed';
            const reason = ready ? 'Payment account destination verified.' : payment?.state === 'reconciliation_required'
                ? 'Payment account setup needs reconciliation before continuing.'
                : 'Set up and verify your payment account before submitting onboarding.';
            requirements.push({ code: 'payout.payment_account', label: 'Payment account', category: 'documents', status: ready ? 'completed' : 'missing', required: true, completed: ready, blockingForSubmission: !ready, blockingForOnline: !ready, needsAdminReview: payment?.state === 'reconciliation_required', reason, services: selectedServices });
        }
        const automaticCodes = new Set(requirements.map(r => r.code));
        const adminRequests = (input.adminRequests || []).filter((request, index, array) => !automaticCodes.has(request.requirementCode) && array.findIndex(item => item.requirementCode === request.requirementCode && item.status !== 'approved') === index);
        const required = requirements.filter(r => r.required);
        const blockers = required.filter(r => r.blockingForSubmission);
        const openAdmin = adminRequests.filter(r => r.status !== 'approved');
        const review = profile.verification_status === 'under_review' || profile.driver_review_status === 'under_review';
        const actionRequired = profile.verification_status === 'action_required' || profile.driver_review_status === 'action_required';
        const approved = profile.is_verified === true || profile.verification_status === 'approved';
        const paused = ['paused', 'suspended', 'blocked'].includes(String(profile.account_status || '').toLowerCase());
        const overallStatus = paused ? 'paused' : actionRequired || openAdmin.length || requirements.some(r => r.status === 'invalid' || r.status === 'under_age' || r.status === 'rejected' || r.status === 'expired') ? 'action_required' : approved ? 'approved' : review ? 'under_review' : !selectedServices.length ? 'not_started' : blockers.length ? 'incomplete' : 'ready_to_submit';
        const onlineReasons = [...required.filter(r => r.blockingForOnline).map(r => r.reason), ...openAdmin.map(r => r.publicMessage || r.item)];
        for (const service of selectedServices) {
            const approvals = profile.service_approval_statuses || {};
            if ((service === 'ride' || service === 'van-moving') && approvals[service] !== 'approved')
                onlineReasons.push(`${service} approval is pending.`);
        }
        if (!approved)
            onlineReasons.push('Driver onboarding is not approved.');
        if (paused)
            onlineReasons.push('Driver account is paused or suspended.');
        const warnings = [];
        if (input.paymentAccountRequired !== true && profile.stripe_connect_status !== 'connected')
            warnings.push({ code: 'payout.stripe_connect', label: 'Stripe payouts', category: 'documents', status: 'missing', required: false, completed: false, blockingForSubmission: false, blockingForOnline: false, needsAdminReview: false, reason: 'Complete Stripe Connect before receiving payouts.', services: [] });
        const section = (rows, applicable = true) => { if (!applicable)
            return { applicable: false, status: 'not_applicable' }; if (rows.some(row => row.status === 'invalid' || row.status === 'under_age' || row.status === 'rejected' || row.status === 'expired'))
            return { applicable: true, status: 'action_required' }; if (rows.some(row => row.status === 'under_review'))
            return { applicable: true, status: 'under_review' }; return { applicable: true, status: rows.length > 0 && rows.every(row => row.completed) ? 'complete' : 'incomplete' }; };
        const byCategory = (category) => requirements.filter(row => row.category === category);
        const vehicleRows = byCategory('vehicle'), operatingRows = vehicleRows.filter(row => row.code === 'vehicle.operating_method'), vehicleDetailRows = vehicleRows.filter(row => row.code !== 'vehicle.operating_method');
        const licensingRows = byCategory('licensing');
        const sectionStatus = { basicDetails: section(byCategory('basic')), services: section(byCategory('services')), operatingMethod: section(operatingRows, selectedServices.length > 0), vehicle: section(vehicleDetailRows, selectedServices.length > 0), documents: section(byCategory('documents'), selectedServices.length > 0), serviceLicensing: section(licensingRows, licensingRows.length > 0), agreement: section(byCategory('agreement')), review: { applicable: true, status: approved ? 'complete' : review ? 'under_review' : actionRequired || openAdmin.length ? 'action_required' : 'incomplete' } };
        const applicableSections = Object.values(sectionStatus).filter(item => item.applicable), completed = applicableSections.filter(item => item.status === 'complete').length, total = applicableSections.length;
        return { selectedServices, vehicleType, automaticRequirements: requirements, adminRequests, warnings, sectionStatus, progress: { completed, total, percentage: total ? Math.round(completed / total * 100) : 0 }, overallStatus, onlineEligibility: { allowed: onlineReasons.length === 0, reasons: Array.from(new Set(onlineReasons)) }, age };
    }
    static services(profile, vehicle, onboardingItems) { const raw = profile.driver_service_types || onboardingItems['driver_service_types'] || vehicle.serviceEligibility || []; const values = Array.isArray(raw) ? raw : String(raw || '').replace(/[\[\]"]/g, '').split(','); return Array.from(new Set(values.map(v => String(v).trim().toLowerCase()).map(v => ['shop', 'shopping', 'errand'].includes(v) ? 'errand' : ['deliver', 'delivery'].includes(v) ? 'delivery' : ['move', 'moving', 'van', 'van_moving', 'van-moving'].includes(v) ? 'van-moving' : v).filter((v) => ['ride', 'delivery', 'errand', 'van-moving'].includes(v)))); }
    static onboardingItems(input) { if (!input)
        return {}; if (typeof input === 'string') {
        try {
            return this.onboardingItems(JSON.parse(input));
        }
        catch {
            return {};
        }
    } if (Array.isArray(input))
        return input.reduce((items, entry) => { if (!entry || typeof entry !== 'object')
            return items; const row = entry, key = String(row['key'] || row['name'] || '').trim(); if (key)
            items[key] = row['value'] === 'true' ? true : row['value'] === 'false' ? false : row['value']; return items; }, {}); return typeof input === 'object' ? input : {}; }
    static vehicle(vehicle, profile) { const value = String(vehicle.capacity || vehicle.type || profile.operating_vehicle || '').toLowerCase(); if (!value)
        return null; if (/bicycle|bike|cycle/.test(value))
        return 'bicycle'; if (/motorcycle|motorbike|moped|scooter/.test(value))
        return 'motorcycle'; if (/large.?van|luton|box.?van/.test(value))
        return 'large_van'; if (/small.?van|\bvan\b/.test(value))
        return 'small_van'; return 'car'; }
    static age(raw, now, minimum) { if (!raw)
        return { eligible: false, years: null, minimum, state: 'missing', reason: 'Add your date of birth.' }; try {
        const iso = (0, driver_profile_model_1.parseDriverDateOfBirth)(raw, now), years = (0, driver_profile_model_1.calculateCalendarAge)(iso, now), eligible = years >= minimum;
        return { eligible, years, minimum, state: eligible ? 'completed' : 'under_age', reason: eligible ? null : 'You must meet the minimum driver age requirement to register.' };
    }
    catch {
        return { eligible: false, years: null, minimum, state: 'invalid', reason: 'Enter a valid date of birth.' };
    } }
    static has(value) { return String(value ?? '').trim().length > 0; }
    /** Date-only expiry evaluation. A DATE expiring today remains valid today. */
    static expiryState(expiry, now) {
        const raw = typeof expiry === 'string' ? expiry.trim() : '';
        const dateOnly = raw.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly))
            return { expired: false, expiringSoon: false, expiryDate: null };
        const today = this.toDateOnly(now);
        const expired = dateOnly < today;
        const expiringSoon = !expired && dateOnly <= this.addDays(today, 30);
        return { expired, expiringSoon, expiryDate: dateOnly };
    }
    static toDateOnly(d) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    static addDays(dateOnly, days) {
        const [y, m, d] = dateOnly.split('-').map(Number);
        return this.toDateOnly(new Date(Date.UTC(y, m - 1, d + days)));
    }
}
exports.DriverRequirementService = DriverRequirementService;
