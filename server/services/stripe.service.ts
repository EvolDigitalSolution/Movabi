import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

if (!stripeSecretKey) {
  console.warn('[StripeService] STRIPE_SECRET_KEY is missing.');
}

if (!stripeWebhookSecret) {
  console.warn('[StripeService] STRIPE_WEBHOOK_SECRET is missing.');
}

export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2023-10-16' as any
});

export const verifyWebhookSignature = (
  payload: string | Buffer,
  signature: string
) => {
  if (!stripeWebhookSecret) {
    throw new Error('Stripe webhook secret is not configured.');
  }

  try {
    return stripe.webhooks.constructEvent(payload, signature, stripeWebhookSecret);
  } catch (err: any) {
    throw new Error(`Webhook Error: ${err.message}`);
  }
};

export const createStripeCheckoutSession = async (
  userId: string,
  tenantId: string,
  userEmail: string,
  priceId: string,
  countryCode?: string,
  currencyCode?: string,
  returnUrl?: string
) => {
  return stripe.checkout.sessions.create({
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

export const createStripePortalSession = async (
  customerId: string,
  returnUrl: string
) => {
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl
  });
};

export const cancelStripeSubscription = async (subscriptionId: string) => {
  return stripe.subscriptions.cancel(subscriptionId);
};

export const createConnectAccount = async (
  userId: string,
  email: string,
  tenantId?: string
) => {
  return stripe.accounts.create({
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

export const retrieveConnectAccount = async (accountId: string) => {
  return stripe.accounts.retrieve(accountId);
};

export const getConnectAccountStatus = async (accountId: string) => {
  const account = await retrieveConnectAccount(accountId);

  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const detailsSubmitted = account.details_submitted === true;

  let status: 'not_started' | 'pending' | 'restricted' | 'enabled' = 'not_started';

  if (chargesEnabled && payoutsEnabled) {
    status = 'enabled';
  } else if (
    account.requirements?.currently_due?.length ||
    account.requirements?.past_due?.length ||
    account.requirements?.disabled_reason
  ) {
    status = 'restricted';
  } else if (detailsSubmitted) {
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

export const createOnboardingLink = async (
  accountId: string,
  returnUrl: string,
  refreshUrl: string
) => {
  return stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding'
  });
};

export const createLoginLink = async (accountId: string) => {
  return stripe.accounts.createLoginLink(accountId);
};

export const createJobPaymentIntent = async (
  amount: number,
  currency: string,
  driverAccountId: string | null,
  platformFeeAmount: number,
  metadata: Record<string, string>
) => {
  const paymentIntentPayload: Stripe.PaymentIntentCreateParams = {
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

  return stripe.paymentIntents.create(paymentIntentPayload);
};
