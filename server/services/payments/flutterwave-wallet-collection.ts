import { createHash, timingSafeEqual } from 'node:crypto';
import { PaymentLayerError, positiveMinor, requiredText } from './payment-contracts';

/** Sandbox-only Flutterwave hosted collection. Mirrors the tested KoraSandbox
 * pattern and supports any currency with a configured minor-unit exponent
 * (0, 2 or 3 decimals) via the approved fee-policy exponent. Verify always
 * re-queries the provider by reference before crediting. */
export interface FlutterwaveAttemptStore {
  begin(reference: string, request: Readonly<Record<string, unknown>>): Promise<boolean>;
  finish(reference: string, state: 'submitted' | 'unknown', checkoutUrl?: string, providerSessionId?:string): Promise<void>;
  get(reference: string): Promise<{request: Record<string, unknown>; state: string; providerSessionId?:string|null} | null>;
  observe?(reference: string, evidence: Readonly<Record<string, unknown>>): Promise<void>;
}
export interface FlutterwaveExpectedPayment {
  reference: string; merchantAccountRef: string; currency: string; amountMinor: number;
  /** Configured minor-unit exponent for the currency (from the approved fee policy). */
  exponent: number;
  providerAccountId?: string;
}
export interface FlutterwaveCheckoutInput extends FlutterwaveExpectedPayment {
  email: string; redirectUrl: string; notificationUrl?: string;
}

function unconfirmed(): never {
  throw new PaymentLayerError('PAYMENT_RESPONSE_UNCONFIRMED', 'Flutterwave result requires reconciliation');
}
function httpsUrl(value: string, allowLoopback = false): URL {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) || url.username || url.password || url.hash)
    throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'A server-owned HTTPS URL is required');
  return url;
}
/** Exact minorâ†’major decimal for any exponent (0/2/3), no floating-point drift. */
export function flutterwaveMajor(amountMinor: number, exponent: number): string {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 3 || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return unconfirmed();
  if (exponent === 0) return String(amountMinor);
  const s = String(amountMinor).padStart(exponent + 1, '0');
  const int = s.slice(0, -exponent);
  const frac = s.slice(-exponent).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

export class FlutterwaveWalletCollection {
  readonly provider = 'flutterwave';
  constructor(
    private readonly secretKey: string,
    private readonly merchantAccountRef: string,
    private readonly attempts: FlutterwaveAttemptStore,
    private readonly webhookSecret: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!/^FLWSECK_TEST-[A-Za-z0-9_-]+$/.test(secretKey))
      throw new PaymentLayerError('FLUTTERWAVE_SANDBOX_REQUIRED', 'An explicit Flutterwave test secret key is required');
    if (!/^[A-Za-z0-9_-]{8,}$/.test(webhookSecret))
      throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'A separate Flutterwave verif-hash webhook secret is required');
    requiredText(merchantAccountRef, 'Flutterwave sandbox merchant account');
  }

  private expected(input: FlutterwaveExpectedPayment): FlutterwaveExpectedPayment & { exponent: number } {
    requiredText(input.reference, 'Payment reference');
    positiveMinor(input.amountMinor);
    requiredText(input.currency, 'Currency');
    // Exponent is the configured authority (from the approved fee policy), never
    // a fixed currency map in the adapter.
    const exponent = input.exponent;
    if (!Number.isInteger(exponent) || exponent < 0 || exponent > 3)
      throw new PaymentLayerError('PAYMENT_CURRENCY_UNSUPPORTED', 'Configured minor-unit exponent must be 0..3');
    if (input.merchantAccountRef !== this.merchantAccountRef)
      throw new PaymentLayerError('PAYMENT_ROUTE_MISMATCH', 'Use the original Flutterwave account and configured currency');
    return Object.freeze({ ...input, exponent });
  }

  private async call(path: string, body?: unknown): Promise<any> {
    const response = await this.request('https://api.flutterwave.com/v3' + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + this.secretKey, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return unconfirmed();
    // Preserve JSON monetary number tokens exactly, including near-safe-limit
    // values. Strings are matched first so customer text is never rewritten.
    const raw = await response.text();
    const result: any = JSON.parse(raw.replace(/("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (token, quoted) => quoted ? token : JSON.stringify(token)));
    if (result?.status !== 'success' || !result.data || typeof result.data !== 'object') return unconfirmed();
    return result.data;
  }

  async createCheckout(input: FlutterwaveCheckoutInput) {
    const expected = this.expected(input);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))
      throw new PaymentLayerError('INVALID_PAYMENT_INPUT', 'Explicit customer email is required');
    const amount = flutterwaveMajor(expected.amountMinor, expected.exponent);
    const payload = Object.freeze({
      tx_ref: expected.reference, amount, currency: expected.currency,
      payment_options: 'card',
      customer: Object.freeze({ email: input.email }),
      redirect_url: httpsUrl(input.redirectUrl, true).href,
      ...(input.notificationUrl ? { customizations: Object.freeze({ title: 'Vaydu wallet top-up' }) } : {}),
    });
    const fingerprint = createHash('sha256').update(this.secretKey).digest('hex');
    if (!(await this.attempts.begin(expected.reference, Object.freeze({ provider: 'flutterwave', merchantAccountRef: expected.merchantAccountRef, amountMinor: expected.amountMinor, exponent: expected.exponent, ...(expected.providerAccountId?{providerAccountId:expected.providerAccountId}:{}), credentialFingerprint: fingerprint, ...payload }))))
      throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED', 'This reference was already submitted; reconcile it');
    try {
      const result = await this.call('/payments', payload);
      if (!result.link) return unconfirmed();
      if (result.tx_ref !== undefined && result.tx_ref !== null && result.tx_ref !== expected.reference) return unconfirmed();
      const url = httpsUrl(result.link);
      if (!['checkout.flutterwave.com', 'ravemodal-dev.flutterwave.com'].includes(url.hostname) || url.port) return unconfirmed();
      await this.attempts.finish(expected.reference, 'submitted', url.href);
      return Object.freeze({ provider: 'flutterwave' as const, ...expected, providerReference: expected.reference, checkoutUrl: url.href, state: 'processing' as const });
    } catch {
      await this.attempts.finish(expected.reference, 'unknown');
      throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED', 'Do not retry with another provider; reconcile this reference');
    }
  }

  /** Fee estimate is an additional check, not proof of the dashboard setting
   * or of every card's fee. The reviewed scope and hosted final total still apply. */
  async preflight(input:FlutterwaveCheckoutInput):Promise<void> {
    const expected=this.expected(input);
    const result=await this.call('/transactions/fee?amount='+encodeURIComponent(flutterwaveMajor(expected.amountMinor,expected.exponent))+'&currency='+encodeURIComponent(expected.currency)+'&payment_type=card');
    const reported=String(result.charge_amount??'');
    const value=(raw:unknown)=>{const text=String(raw??'');return text.length<=80&&/^\d+(?:\.\d+)?$/.test(text)?text:null;};
    if(this.attempts.observe)await this.attempts.observe(expected.reference,{source:'server-fee-query',provider:'flutterwave',reference:expected.reference,currency:expected.currency,providerAccountId:expected.providerAccountId??null,paymentMethod:'card',chargedAmountMajor:value(result.charge_amount),appFeeMajor:value(result.flutterwave_fee??result.fee),merchantFeeMajor:value(result.merchant_fee),stampDutyFeeMajor:value(result.stamp_duty_fee)});
    if((result.currency!==undefined&&result.currency!==expected.currency)||this.parseMinor(reported,expected.exponent)!==expected.amountMinor)
      throw new PaymentLayerError('PAYMENT_CHECKOUT_TOTAL_MISMATCH','Provider estimate differs from the agreed total; no checkout submitted');
  }

  /** Re-query the provider by reference before crediting; validate tx_ref,
   * currency, the actual charged amount and a successful status. */
  async verify(input: FlutterwaveExpectedPayment) {
    const expected = this.expected(input);
    const stored = await this.attempts.get(expected.reference);
    const req = stored?.request;
    if (!stored || !['started', 'submitted', 'unknown'].includes(stored.state) || !req ||
        req.provider !== 'flutterwave' || req.tx_ref !== expected.reference ||
        req.merchantAccountRef !== expected.merchantAccountRef || req.currency !== expected.currency ||
        req.amountMinor !== expected.amountMinor || req.exponent !== expected.exponent ||
        (expected.providerAccountId!==undefined && req.providerAccountId!==expected.providerAccountId) ||
        req.credentialFingerprint !== createHash('sha256').update(this.secretKey).digest('hex'))
      throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED', 'Original provider credentials and frozen terms are required');
    const result = await this.call('/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(expected.reference));
    const decimal = (value: unknown): string | null => {
      const text = String(value ?? '');
      return text.length <= 80 && /^-?\d+(?:\.\d+)?$/.test(text) ? text : null;
    };
    const evidence = Object.freeze({
      source: 'server-query', provider:'flutterwave', reference: typeof result.tx_ref === 'string' ? result.tx_ref.slice(0,200) : null,
      currency: typeof result.currency === 'string' ? result.currency.slice(0,3) : null,
      status: typeof result.status === 'string' ? result.status.slice(0,40) : null,
      paymentMethod: typeof result.payment_type==='string'?result.payment_type.slice(0,40):null,
      providerAccountId: decimal(result.account_id), amountMajor: decimal(result.amount),
      chargedAmountMajor: decimal(result.charged_amount), appFeeMajor: decimal(result.app_fee),
      merchantFeeMajor: decimal(result.merchant_fee), amountSettledMajor: decimal(result.amount_settled),
    });
    if (this.attempts.observe) await this.attempts.observe(expected.reference, evidence);
    // Missing actual charged amount must never fall back to the requested amount.
    const chargedMinor = this.parseMinor(result.charged_amount, expected.exponent);
    if (result.tx_ref !== expected.reference || result.currency !== expected.currency
      || !['successful', 'success'].includes(result.status)
      || (expected.providerAccountId !== undefined && String(result.account_id) !== expected.providerAccountId)
      || result.payment_type !== 'card'
      || !/^[1-9][0-9]*$/.test(String(result.account_id??''))
      || this.parseMinor(result.amount,expected.exponent)!==expected.amountMinor
      || chargedMinor !== expected.amountMinor) return unconfirmed();
    return Object.freeze({ provider: 'flutterwave' as const, ...expected, providerAccountId:String(result.account_id), chargedAmountMinor: chargedMinor, finalStatus: 'succeeded' as const, state: 'captured' as const });
  }

  private parseMinor(value: unknown, exponent: number): number {
    const s = String(value ?? '');
    const m = /^(\d+)(?:\.(\d{0,}))?$/.exec(s);
    if (!m) return unconfirmed();
    const frac = (m[2] || '').padEnd(exponent, '0');
    if (frac.length > exponent) return unconfirmed();
    const minor = BigInt(m[1]) * (10n ** BigInt(exponent)) + BigInt(frac || '0');
    if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return unconfirmed();
    return Number(minor);
  }

  /** Flutterwave's verif-hash header is the secret hash itself: compare the
   *  header directly against the separately configured secret, constant-time. */
  authenticWebhook(signature: unknown): boolean {
    if (typeof signature !== 'string' || signature.length === 0) return false;
    const received = Buffer.from(signature);
    const expected = Buffer.from(this.webhookSecret);
    if (received.length !== expected.length) return false;
    return timingSafeEqual(received, expected);
  }
}
