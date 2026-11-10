import type Stripe from 'stripe';
import { PaymentGateway } from './payment-gateway';
import { StripePaymentAdapter } from './stripe-payment-adapter';
import { PaymentLayerError, positiveMinor, requiredText } from './payment-contracts';

export interface GbCheckoutParams {
  readonly customer?: string;
  readonly setup_future_usage?: 'on_session';
  readonly amount: number;
  readonly currency: string;
  readonly capture_method: 'manual';
  readonly payment_method_types: readonly ['card'];
  readonly metadata: Readonly<Record<string, string>>;
}

/** GB/GBP pilot only. Existing intents retain their original Stripe lifecycle.
 * Call only behind VAYDU_GB_GATEWAY_CHECKOUT_V23. No new provider is enabled.
 * The persisted jobs.payment_intent_id remains the lifecycle reference.
 */
export async function createGbGatewayCheckout(
  client: Stripe,
  country: unknown,
  params: GbCheckoutParams,
  idempotencyKey: string,
  persistedCurrency: unknown
): Promise<{ id: string; client_secret: string }> {
  if (country !== 'GB' || typeof persistedCurrency !== 'string' || persistedCurrency.toUpperCase() !== 'GBP' || params.currency !== 'gbp') {
    throw new PaymentLayerError('PAYMENT_MARKET_UNAVAILABLE', 'Gateway checkout pilot requires persisted GB/GBP booking terms');
  }
  positiveMinor(params.amount);
  requiredText(idempotencyKey, 'Idempotency key');
  if (idempotencyKey.length > 255 || params.capture_method !== 'manual'
    || params.payment_method_types.length !== 1 || params.payment_method_types[0] !== 'card'
    || params.metadata?.purpose !== 'job_payment' || params.metadata?.countryCode !== 'GB') {
    throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'Gateway checkout requires the original card-only booking payment terms');
  }
  requiredText(params.metadata.jobId, 'Job reference');
  const route = { provider: 'stripe' as const, merchantAccountRef: 'stripe-platform', country: 'GB', currency: 'GBP' };
  const gateway = new PaymentGateway([new StripePaymentAdapter(client)], [{
    ...route, enabled: true, merchantApproved: true,
    capabilities: ['authorise', 'capture', 'release', 'refund', 'retrieve']
  }]);
  // This pilot uses the same pre-existing platform account and market authority.
  // It does not establish approval for any additional merchant or market.
  const result = await gateway.execute({
    operation: 'authorise', route, amountMinor: params.amount, idempotencyKey,
    metadata: params.metadata, customerReference:params.customer, saveForFuture:params.setup_future_usage==='on_session'
  });
  if (result.amountMinor !== params.amount || !result.checkoutSecret) {
    throw new PaymentLayerError('PAYMENT_RESPONSE_UNCONFIRMED', 'Checkout response requires reconciliation with the original Stripe idempotency key');
  }
  return { id: result.reference, client_secret: result.checkoutSecret };
}
