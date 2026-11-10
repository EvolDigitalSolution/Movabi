import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentLayerError, positiveMinor, requiredText } from './payment-contracts';

export interface KoraAttemptStore {
  begin(reference: string, request: Readonly<Record<string, unknown>>): Promise<boolean>;
  finish(reference: string, state: 'submitted' | 'unknown', checkoutUrl?: string): Promise<void>;
}
export interface KoraExpectedPayment {
  reference: string; merchantAccountRef: string; currency: 'NGN'; amountMinor: number;
}
export interface KoraCheckoutInput extends KoraExpectedPayment {
  email: string; redirectUrl: string; notificationUrl?: string;
  methods: readonly ('card' | 'bank_transfer')[];
  saveForFuture?: boolean;
}
function unconfirmed(): never {
  throw new PaymentLayerError('PAYMENT_RESPONSE_UNCONFIRMED', 'Kora result requires reconciliation');
}
function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'A server-owned HTTPS URL is required');
  return url;
}
// Exact decimal conversion: reject missing values, exponents, fractional kobo and unsafe amounts.
export function koraNgnMinor(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return unconfirmed();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return unconfirmed();
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return unconfirmed();
  return Number(minor);
}
/** Sandbox-only NGN hosted collection. NOT a booking gateway authorisation adapter.
 * No live route, card token storage, driver payouts or automatic fallback. */
export class KoraSandbox {
  constructor(private readonly key: string, private readonly merchantAccountRef: string,
    private readonly attempts: KoraAttemptStore, private readonly request: typeof fetch = fetch) {
    if (!/^sk_test_[A-Za-z0-9_-]+$/.test(key))
      throw new PaymentLayerError('KORA_SANDBOX_REQUIRED', 'An explicit Kora test secret key is required');
    requiredText(merchantAccountRef, 'Kora sandbox merchant account');
  }
  private expected(input: KoraExpectedPayment): KoraExpectedPayment {
    requiredText(input.reference, 'Payment reference'); positiveMinor(input.amountMinor);
    if (input.merchantAccountRef !== this.merchantAccountRef || input.currency !== 'NGN')
      throw new PaymentLayerError('PAYMENT_ROUTE_MISMATCH', 'Use the original Kora sandbox account and NGN currency');
    return Object.freeze({reference: input.reference, merchantAccountRef: input.merchantAccountRef,
      currency: input.currency, amountMinor: input.amountMinor});
  }
  private async call(path: string, body?: unknown): Promise<any> {
    const response = await this.request('https://api.korapay.com/merchant/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: {Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return unconfirmed();
    const result: any = await response.json();
    if (result?.status !== true || !result.data || typeof result.data !== 'object') return unconfirmed();
    return result.data;
  }
  async createCheckout(input: KoraCheckoutInput) {
    const expected = this.expected(input);
    if (input.saveForFuture) throw new PaymentLayerError('PAYMENT_CAPABILITY_UNAVAILABLE', 'Kora saved cards are not installed');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || !input.methods.length ||
      input.methods.some(m => !['card', 'bank_transfer'].includes(m)))
      throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'Explicit customer email and checkout methods are required');
    const payload = Object.freeze({reference: expected.reference, currency: expected.currency,
      amount: expected.amountMinor / 100, customer: Object.freeze({email: input.email}),
      channels: Object.freeze([...input.methods]), redirect_url: httpsUrl(input.redirectUrl).href,
      ...(input.notificationUrl ? {notification_url: httpsUrl(input.notificationUrl).href} : {}), merchant_bears_cost: true});
    if (koraNgnMinor(payload.amount) !== expected.amountMinor)
      throw new PaymentLayerError('INVALID_PAYMENT_AMOUNT', 'Amount cannot be represented safely for checkout');
    // Reserve durably before POST. Never retry an uncertain POST with a new reference/provider.
    if (!await this.attempts.begin(expected.reference, Object.freeze({provider: 'kora',
      merchantAccountRef: expected.merchantAccountRef, amountMinor: expected.amountMinor, ...payload})))
      throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED', 'This reference was already submitted; reconcile it');
    try {
      const result = await this.call('/charges/initialize', payload);
      if (result.reference !== expected.reference) return unconfirmed();
      const url = httpsUrl(result.checkout_url);
      if (!['checkout.korapay.com', 'test-checkout.korapay.com'].includes(url.hostname) || url.port) return unconfirmed();
      await this.attempts.finish(expected.reference, 'submitted', url.href);
      return Object.freeze({provider: 'kora' as const, ...expected, checkoutUrl: url.href, state: 'processing' as const});
    } catch {
      await this.attempts.finish(expected.reference, 'unknown');
      throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED', 'Do not retry with another provider; reconcile this reference');
    }
  }
  /** expected must come from the persisted server attempt, never from a redirect/browser body. */
  async verify(input: KoraExpectedPayment) {
    const expected = this.expected(input);
    const result = await this.call('/charges/' + encodeURIComponent(expected.reference));
    if (result.reference !== expected.reference || result.currency !== expected.currency ||
      result.status !== 'success' || koraNgnMinor(result.amount) !== expected.amountMinor ||
      koraNgnMinor(result.amount_paid) !== expected.amountMinor) return unconfirmed();
    // Return only verified terms; never card tokens, customer data or raw provider responses.
    return Object.freeze({provider: 'kora' as const, ...expected, state: 'captured' as const});
  }
  async initiateRefund(input: KoraExpectedPayment & {refundReference: string; completionStatus: 'success' | 'failed'; webhookUrl?: string}) {
    const expected = this.expected(input);
    if (!/^vaydu-refund-[a-f0-9]{32}$/.test(input.refundReference) ||
        !['success', 'failed'].includes(input.completionStatus) || expected.amountMinor < 10000)
      throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'An explicit sandbox full refund of at least NGN100 is required');
    const amount = expected.amountMinor / 100;
    if (koraNgnMinor(amount) !== expected.amountMinor) return unconfirmed();
    const result = await this.call('/refunds/initiate', {payment_reference: expected.reference,
      reference: input.refundReference, amount, reason: 'Vaydu sandbox booking full refund',
      completion_status: input.completionStatus,
      ...(input.webhookUrl ? {webhook_url: httpsUrl(input.webhookUrl).href} : {})});
    if (result.refund_reference !== input.refundReference || result.payment_reference !== expected.reference ||
        result.currency !== expected.currency || koraNgnMinor(result.amount_returned) !== expected.amountMinor ||
        !['processing', 'success', 'failed'].includes(result.status)) return unconfirmed();
    // Initiation is not evidence of completed refund. Query the immutable refund reference next.
    return Object.freeze({refundReference: input.refundReference, state: 'processing' as const});
  }
  async verifyRefund(input: KoraExpectedPayment & {refundReference: string}) {
    const expected = this.expected(input);
    if (!/^vaydu-refund-[a-f0-9]{32}$/.test(input.refundReference)) return unconfirmed();
    const result = await this.call('/refunds/' + encodeURIComponent(input.refundReference));
    if (result.reference !== input.refundReference || result.payment_reference !== expected.reference ||
        result.currency !== expected.currency || koraNgnMinor(result.amount) !== expected.amountMinor ||
        !['processing', 'success', 'failed'].includes(result.status)) return unconfirmed();
    return Object.freeze({refundReference: input.refundReference,
      state: result.status as 'processing' | 'success' | 'failed'});
  }
  /** Signature authenticates data only. Always verify() stored terms before granting value.
   * Do not trust the unsigned event field to choose a payment operation. */
  authenticWebhook(data: unknown, signature: unknown): boolean {
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
      typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
    const expected = createHmac('sha256', this.key).update(JSON.stringify(data)).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }
}
export class KoraDbAttempts implements KoraAttemptStore {
  constructor(private readonly db: any) {}
  async begin(reference: string, request: Readonly<Record<string, unknown>>): Promise<boolean> {
    const result = await this.db.from('payment_checkout_attempts').insert({reference, request, state: 'started'});
    if (result.error?.code === '23505') return false;
    if (result.error) throw new PaymentLayerError('PAYMENT_STORE_UNAVAILABLE', 'Could not reserve payment reference');
    return true;
  }
  async finish(reference: string, state: 'submitted' | 'unknown', checkoutUrl?: string): Promise<void> {
    const result = await this.db.from('payment_checkout_attempts').update({state, checkout_url: checkoutUrl || null})
      .eq('reference', reference).select('reference').maybeSingle();
    if (result.error || !result.data)
      throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED', 'Payment attempt requires reconciliation');
  }
}
