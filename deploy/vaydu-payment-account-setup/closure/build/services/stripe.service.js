"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJobPaymentIntent = exports.createLoginLink = exports.createOnboardingLink = exports.getConnectAccountStatus = exports.retrieveConnectAccount = exports.createConnectAccount = exports.cancelStripeSubscription = exports.createStripePortalSession = exports.createStripeCheckoutSession = exports.verifyWebhookSignature = exports.stripe = void 0;
const stripe_payment_bridge_1 = require("./payments/stripe-payment-bridge");
const stripe_1 = __importDefault(require("stripe"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
if (!stripeSecretKey) {
    console.warn('[StripeService] STRIPE_SECRET_KEY is missing.');
}
if (!stripeWebhookSecret) {
    console.warn('[StripeService] STRIPE_WEBHOOK_SECRET is missing.');
}
const stripeClient = new stripe_1.default(stripeSecretKey, {
    apiVersion: '2023-10-16'
});
// v2.3 is opt-in. Missing/false flag returns the identical legacy SDK instance.
exports.stripe = (0, stripe_payment_bridge_1.createStripePaymentBridge)(stripeClient, process.env.VAYDU_SHARED_PAYMENTS_V23 === 'true');
const WEB_DRIVER_URL = 'https://movabi.apps.evolsolution.com/driver';
const NATIVE_DRIVER_URL = 'com.movabi.app://driver';
const isNativeConnectPlatform = (platform) => platform === 'android' || platform === 'ios' || platform === 'native';
const verifyWebhookSignature = (payload, signature, webhookSecret) => {
    if (!webhookSecret) {
        throw new Error('Stripe webhook secret is not configured.');
    }
    try {
        return exports.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    }
    catch (err) {
        throw new Error(`Webhook Error: ${err.message}`);
    }
};
exports.verifyWebhookSignature = verifyWebhookSignature;
const createStripeCheckoutSession = async (userId, tenantId, userEmail, priceId, countryCode, currencyCode, returnUrl) => {
    return exports.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'subscription',
        customer_email: userEmail,
        client_reference_id: userId,
        metadata: {
            userId,
            tenantId,
            countryCode: countryCode || '',
            currencyCode: currencyCode || ''
        },
        success_url: `https://movabi.apps.evolsolution.com/driver/subscription?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.APP_URL}/driver/subscription`
    });
};
exports.createStripeCheckoutSession = createStripeCheckoutSession;
const createStripePortalSession = async (customerId, returnUrl) => {
    return exports.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl
    });
};
exports.createStripePortalSession = createStripePortalSession;
const cancelStripeSubscription = async (subscriptionId) => {
    return exports.stripe.subscriptions.cancel(subscriptionId);
};
exports.cancelStripeSubscription = cancelStripeSubscription;
const createConnectAccount = async (userId, email, tenantId) => {
    return exports.stripe.accounts.create({
        type: 'express',
        email,
        metadata: {
            userId,
            tenantId: tenantId || ''
        },
        capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true }
        }
    });
};
exports.createConnectAccount = createConnectAccount;
const retrieveConnectAccount = async (accountId) => {
    return exports.stripe.accounts.retrieve(accountId);
};
exports.retrieveConnectAccount = retrieveConnectAccount;
const getConnectAccountStatus = async (accountId) => {
    const account = await (0, exports.retrieveConnectAccount)(accountId);
    const chargesEnabled = account.charges_enabled === true;
    const payoutsEnabled = account.payouts_enabled === true;
    const detailsSubmitted = account.details_submitted === true;
    let status = 'not_started';
    if (chargesEnabled && payoutsEnabled) {
        status = 'enabled';
    }
    else if (account.requirements?.currently_due?.length ||
        account.requirements?.past_due?.length ||
        account.requirements?.disabled_reason) {
        status = 'restricted';
    }
    else if (detailsSubmitted) {
        status = 'pending';
    }
    return {
        stripe_account_id: account.id,
        onboarding_complete: detailsSubmitted,
        payouts_enabled: payoutsEnabled,
        charges_enabled: chargesEnabled,
        details_submitted: detailsSubmitted,
        status,
        requirements: {
            currently_due: account.requirements?.currently_due || [],
            eventually_due: account.requirements?.eventually_due || [],
            past_due: account.requirements?.past_due || [],
            pending_verification: account.requirements?.pending_verification || [],
            disabled_reason: account.requirements?.disabled_reason || null
        }
    };
};
exports.getConnectAccountStatus = getConnectAccountStatus;
const createOnboardingLink = async (accountId, returnUrl, refreshUrl, platform = 'web') => {
    const resolvedReturnUrl = isNativeConnectPlatform(platform)
        ? `${NATIVE_DRIVER_URL}?stripe=success`
        : `${WEB_DRIVER_URL}?stripe=success`;
    const resolvedRefreshUrl = isNativeConnectPlatform(platform)
        ? `${NATIVE_DRIVER_URL}?stripe=refresh`
        : `${WEB_DRIVER_URL}?stripe=refresh`;
    return exports.stripe.accountLinks.create({
        account: accountId,
        refresh_url: resolvedRefreshUrl,
        return_url: resolvedReturnUrl,
        type: 'account_onboarding'
    });
};
exports.createOnboardingLink = createOnboardingLink;
const createLoginLink = async (accountId) => {
    return exports.stripe.accounts.createLoginLink(accountId);
};
exports.createLoginLink = createLoginLink;
const createJobPaymentIntent = async (amount, currency, driverAccountId, platformFeeAmount, metadata) => {
    const paymentIntentPayload = {
        amount: Math.round(Number(amount || 0) * 100),
        currency: String(currency || 'gbp').toLowerCase(),
        payment_method_types: ['card'],
        capture_method: 'manual',
        metadata
    };
    if (driverAccountId) {
        paymentIntentPayload.application_fee_amount = Math.round(Number(platformFeeAmount || 0) * 100);
        paymentIntentPayload.transfer_data = {
            destination: driverAccountId
        };
    }
    return exports.stripe.paymentIntents.create(paymentIntentPayload);
};
exports.createJobPaymentIntent = createJobPaymentIntent;
