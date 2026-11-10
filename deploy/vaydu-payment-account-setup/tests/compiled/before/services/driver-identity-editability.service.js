"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverIdentityEditabilityService = void 0;
class DriverIdentityEditabilityService {
    static resolve(profile, requests = []) {
        const correctionAllowed = requests.some(request => request.request_type === 'identity_correction' && request.status === 'approved' && !request.permission_consumed_at);
        const status = String(profile.driver_review_status || profile.verification_status || '').toLowerCase();
        const submitted = profile.onboarding_completed === true || ['pending', 'under_review', 'action_required', 'approved', 'paused', 'rejected', 'ready_for_admin_review'].includes(status);
        const verified = profile.is_verified === true || status === 'approved';
        const dateOfBirthEditable = correctionAllowed
            ? true
            : !submitted;
        const fullNameEditable = !verified;
        const countryCodeEditable = !verified;
        return {
            dateOfBirthEditable,
            fullNameEditable,
            countryCodeEditable,
            reason: correctionAllowed
                ? 'An administrator has allowed a date of birth correction.'
                : (submitted ? 'Date of birth cannot be changed after verification has started.' : null),
            fullNameReason: verified
                ? 'Your legal name is tied to your verified driver identity. Contact support to request a name change.'
                : null,
            countryCodeReason: verified
                ? 'Your operating country is tied to your verified driver identity. Contact support to request a change.'
                : null
        };
    }
}
exports.DriverIdentityEditabilityService = DriverIdentityEditabilityService;
