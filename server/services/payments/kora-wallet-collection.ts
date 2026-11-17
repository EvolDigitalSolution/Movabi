import { PaymentLayerError } from './payment-contracts';
import { KoraSandbox, koraNgnMinor } from './kora-sandbox';
import type { KoraAttemptStore } from './kora-sandbox';
import type { DriverCardTopupAdapter, DriverCardInput, DriverCardExpected } from './driver-card-topup-contracts';

/**
 * Customer wallet collection adapter for the approved NG Kora sandbox route.
 * Maps the verified KoraSandbox hosted-checkout client onto the shared
 * DriverCardTopupAdapter contract used by CustomerWalletCollectionService:
 *
 *   preflight     -> frozen-terms validation only. The durable provider
 *                    boundary is KoraSandbox.createCheckout itself, which
 *                    reserves the reference BEFORE POSTing and marks the
 *                    attempt 'unknown' on any uncertain response — so an
 *                    unverifiable submission can never be silently retried.
 *   createCheckout-> POST /merchant/api/v1/charges/initialize (hosted page:
 *                    card channel; bank_transfer remains available to the
 *                    provider checkout but is not a saved-card substitute)
 *   verify        -> GET /merchant/api/v1/charges/<reference>; returns
 *                    'succeeded' only on status==='success' with the exact
 *                    frozen amount/currency, otherwise throws UNCONFIRMED
 *                    (the service leaves the credit pending/reconcilable).
 *
 * Saved cards are intentionally NOT installed (Kora tokenisation is not
 * integrated): saveForFuture stays refused upstream.
 */
export class KoraWalletCollection implements DriverCardTopupAdapter {
  readonly provider = 'kora';
  constructor(private readonly sandbox: KoraSandbox, private readonly merchant: string) {}
  private expected(input: { merchantAccountRef: string; currency: string; amountMinor: number }) {
    if (input.merchantAccountRef !== this.merchant || input.currency !== 'NGN'
        || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new PaymentLayerError('PAYMENT_ROUTE_MISMATCH', 'Use the approved Kora sandbox merchant and NGN currency');
    return { merchantAccountRef: this.merchant, currency: 'NGN' as const, amountMinor: input.amountMinor };
  }
  async preflight(input: DriverCardInput): Promise<void> {
    this.expected(input);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))
      throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'A verified customer email is required');
    koraNgnMinor(input.amountMinor / 100); // total must be representable in kobo
  }
  async createCheckout(input: DriverCardInput) {
    const expected = this.expected(input);
    const checkout = await this.sandbox.createCheckout({
      ...expected, reference: input.reference, email: input.email,
      redirectUrl: input.redirectUrl, methods: ['card'],
    });
    if (checkout.provider !== 'kora' || checkout.reference !== input.reference
        || checkout.amountMinor !== input.amountMinor || typeof checkout.checkoutUrl !== 'string' || !checkout.checkoutUrl)
      throw new PaymentLayerError('PAYMENT_RESPONSE_UNCONFIRMED', 'Kora checkout response could not be confirmed');
    return { providerReference: checkout.reference, checkoutUrl: checkout.checkoutUrl };
  }
  async verify(input: DriverCardExpected) {
    const verified = await this.sandbox.verify({
      reference: input.reference, merchantAccountRef: input.merchantAccountRef,
      currency: 'NGN', amountMinor: input.amountMinor,
    });
    if (verified.provider !== 'kora' || verified.state !== 'captured')
      throw new PaymentLayerError('PAYMENT_RESPONSE_UNCONFIRMED', 'Kora payment is not confirmed captured');
    return { reference: verified.reference, merchantAccountRef: verified.merchantAccountRef,
      currency: verified.currency, chargedAmountMinor: verified.amountMinor, finalStatus: 'succeeded' as const };
  }
}
