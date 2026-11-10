"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PayoutEligibilityService = exports.PayoutEligibilityError = exports.SUPPORTED_PAYOUT_COUNTRIES = void 0;
const stripe_service_1 = require("./stripe.service");
const supabase_service_1 = require("./supabase.service");
/**
 * Payout eligibility authority.
 *
 * A driver is only eligible to receive payouts when ALL of the following hold:
 *   - the profile role is `driver`
 *   - registration market eligibility was activated (registration_activated_at)
 *   - the driver's authoritative country is in the supported payout scope
 *   - a connected Stripe account exists and its ACTUAL account country is in
 *     the supported scope (never trusting a local country mirror)
 *   - the Stripe account has charges and payouts enabled
 *
 * This release restricts payouts to the UK. Unknown data fails CLOSED.
 */
exports.SUPPORTED_PAYOUT_COUNTRIES = ['GB'];
class PayoutEligibilityError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'PayoutEligibilityError';
    }
}
exports.PayoutEligibilityError = PayoutEligibilityError;
class PayoutEligibilityService {
    static isSupportedCountry(country) {
        const code = String(country || '').trim().toUpperCase();
        return exports.SUPPORTED_PAYOUT_COUNTRIES.includes(code);
    }
    /**
     * Verify a driver is eligible to receive payouts. Fails closed: a missing
     * profile, unknown country or unverifiable Stripe account is ineligible.
     */
    static async evaluateDriver(userId, stripeAccountId) {
        const { data: profile } = await supabase_service_1.supabaseAdmin
            .from('profiles')
            .select('role, registration_activated_at, registration_country_code, country_code, stripe_account_id')
            .eq('id', userId)
            .maybeSingle();
        if (!profile) {
            return { eligible: false, code: 'PROFILE_MISSING', reason: 'Driver profile not found.' };
        }
        if (String(profile.role || '').toLowerCase() !== 'driver') {
            return { eligible: false, code: 'NOT_DRIVER_ROLE', reason: 'Only driver accounts can onboard for payouts.' };
        }
        if (!profile.registration_activated_at) {
            return { eligible: false, code: 'REGISTRATION_PENDING', reason: 'Registration market eligibility is required before payouts.' };
        }
        const country = String(profile.registration_country_code || profile.country_code || '').trim().toUpperCase() || null;
        if (!this.isSupportedCountry(country)) {
            return {
                eligible: false,
                code: 'PAYOUT_COUNTRY_UNSUPPORTED',
                reason: 'Driver payout country is not supported in this release.',
                driverCountry: country
            };
        }
        const accountId = stripeAccountId || profile.stripe_account_id || null;
        if (!accountId) {
            return { eligible: false, code: 'NO_STRIPE_ACCOUNT', reason: 'Driver has no connected Stripe account.', driverCountry: country };
        }
        try {
            const account = await stripe_service_1.stripe.accounts.retrieve(accountId);
            if (account.metadata?.user_id && String(account.metadata.user_id) !== userId)
                return { eligible: false, code: 'PAYOUT_ACCOUNT_OWNER_MISMATCH', reason: 'Connected payout account owner could not be verified.', driverCountry: country };
            const accountCountry = String(account.country || '').trim().toUpperCase() || null;
            if (!this.isSupportedCountry(accountCountry)) {
                return {
                    eligible: false,
                    code: 'PAYOUT_COUNTRY_UNSUPPORTED',
                    reason: 'Connected account country is not supported in this release.',
                    driverCountry: country,
                    accountCountry,
                    chargesEnabled: account.charges_enabled,
                    payoutsEnabled: account.payouts_enabled,
                    detailsSubmitted: account.details_submitted
                };
            }
            const ready = Boolean(account.charges_enabled && account.payouts_enabled);
            return {
                eligible: ready,
                code: ready ? 'OK' : 'ACCOUNT_NOT_READY',
                reason: ready ? undefined : 'Stripe account is not fully onboarded (charges or payouts disabled).',
                driverCountry: country,
                accountCountry,
                chargesEnabled: account.charges_enabled,
                payoutsEnabled: account.payouts_enabled,
                detailsSubmitted: account.details_submitted
            };
        }
        catch (error) {
            return {
                eligible: false,
                code: 'ACCOUNT_UNVERIFIABLE',
                reason: 'Could not verify the connected Stripe account.',
                driverCountry: country
            };
        }
    }
    /** Throw a PayoutEligibilityError unless the driver is eligible. */
    static async assertEligible(userId, stripeAccountId) {
        const result = await this.evaluateDriver(userId, stripeAccountId);
        if (!result.eligible) {
            throw new PayoutEligibilityError(result.code || 'INELIGIBLE', result.reason || 'Driver is not payout-eligible.');
        }
        return result;
    }
}
exports.PayoutEligibilityService = PayoutEligibilityService;
