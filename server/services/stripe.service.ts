import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

if (!stripeSecretKey) {
  console.warn('Stripe Secret Key is missing in environment variables.');
}

export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2023-10-16',
});

export const verifyWebhookSignature = (payload: string | Buffer, signature: string) => {
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
  currencyCode?: string
) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    mode: 'subscription',
    customer_email: userEmail,
    client_reference_id: userId,
    metadata: {
      userId,
      tenantId,
      countryCode: countryCode || '',
      currencyCode: currencyCode || '',
    },
    success_url: `${process.env.APP_URL}/driver/subscription?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/driver/subscription`,
  });

  return session;
};

export const createStripePortalSession = async (customerId: string, returnUrl: string) => {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session;
};

export const cancelStripeSubscription = async (subscriptionId: string) => {
  return await stripe.subscriptions.cancel(subscriptionId);
};

/**
 * Create a Stripe Connect Express account for a driver
 */
export const createConnectAccount = async (userId: string, email: string) => {
  const account = await stripe.accounts.create({
    type: 'express',
    email,
    metadata: {
      userId,
    },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });
  return account;
};

/**
 * Create an onboarding link for a Connect account
 */
export const createOnboardingLink = async (accountId: string, returnUrl: string, refreshUrl: string) => {
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return accountLink;
};

/**
 * Create a login link for the Connect dashboard
 */
export const createLoginLink = async (accountId: string) => {
  const loginLink = await stripe.accounts.createLoginLink(accountId);
  return loginLink;
};

/**
 * Create a PaymentIntent for a job with split payment
 */
export const createJobPaymentIntent = async (
  amount: number,
  currency: string,
  driverAccountId: string,
  platformFeeAmount: number,
  metadata: any
) => {
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // Convert to cents
    currency,
    payment_method_types: ['card'],
    application_fee_amount: Math.round(platformFeeAmount * 100),
    transfer_data: {
      destination: driverAccountId,
    },
    metadata,
  });
  return paymentIntent;
};
