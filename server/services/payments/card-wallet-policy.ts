import { paymentPolicies, selectMarketPayment } from './market-payment-registry';
import { STRIPE_MERCHANT } from './stripe-saved-cards';

/** Standalone saving starts with the existing GB/GBP Stripe account only. */
export function cardWalletSetupAllowed(input: {
  cardsEnabled: boolean; setupEnabled: boolean; country: string | null;
  currency: string | null; paymentEnabled: boolean; routes: string | undefined;
}): boolean {
  if (!input.cardsEnabled || !input.setupEnabled || input.country !== 'GB' || input.currency !== 'GBP') return false;
  try {
    const route = selectMarketPayment({countryCode: input.country, currency: input.currency,
      paymentEnabled: input.paymentEnabled}, paymentPolicies(input.routes), 'card',
      ['authorise', 'capture', 'release', 'refund', 'retrieve']);
    return route.provider === 'stripe' && route.merchantAccountRef === STRIPE_MERCHANT;
  } catch { return false; }
}
