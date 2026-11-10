/**
 * Batch 1C — provider-neutral wallet collection integration boundaries.
 * Adapters consume normalized responses from INJECTED provider clients.
 * Concrete SDK clients and raw response parsing are not supplied by this batch.
 * Tests mock the transport (the client), never the verification logic.
 * Unsupported capabilities fail closed. Card setup is separate from collection.
 */

export type WalletCollectionProvider = 'stripe' | 'kora';

export interface WalletCollectionAttempt {
  attemptKey: string;
  tenantId: string;
  ownerId: string;
  country: string;
  currency: string;
  amountMinor: bigint;
  destinationAccountPurpose: string;
  provider: WalletCollectionProvider;
  merchantAccountRef: string;
  providerIdempotencyIdentity: string;
}

/** Provider client (transport) — the thing tests mock. */
export interface WalletCollectionClient {
  createCollection(input: {
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
    returnUrl?: string;
  }): Promise<{ providerReference: string; checkoutUrl?: string; checkoutSecret?: string }>;
  verifyCollection(providerReference: string): Promise<{
    providerReference: string;
    merchantAccountRef: string;
    currency: string;
    amountMinor: bigint;
    finalStatus: string;
  }>;
}

export interface WalletCollectionInitiation {
  providerReference: string;
  checkoutUrl?: string;
  checkoutSecret?: string;
}

export interface WalletCollectionVerification {
  providerReference: string;
  merchantAccountRef: string;
  currency: string;
  amountMinor: bigint;
  finalStatus: 'succeeded' | 'completed' | 'failed' | 'pending' | 'unknown';
}

export interface WalletCollectionAdapter {
  readonly provider: WalletCollectionProvider;
  readonly merchantAccountRef: string;
  readonly capabilities: ReadonlyArray<string>;
  initiate(attempt: WalletCollectionAttempt): Promise<WalletCollectionInitiation>;
  verify(attempt: WalletCollectionAttempt, initiation: WalletCollectionInitiation): Promise<WalletCollectionVerification>;
}

abstract class BaseWalletCollectionAdapter implements WalletCollectionAdapter {
  abstract readonly provider: WalletCollectionProvider;
  readonly merchantAccountRef: string;
  readonly capabilities: ReadonlyArray<string>;

  constructor(merchantAccountRef: string, protected readonly client: WalletCollectionClient, capabilities: ReadonlyArray<string> = []) {
    this.merchantAccountRef = merchantAccountRef;
    this.capabilities = Object.freeze([...capabilities]);
  }

  protected assertCollect() {
    if (!this.capabilities.includes('collect')) {
      throw new Error('PAYMENT_CAPABILITY_UNAVAILABLE: collection not approved');
    }
  }

  async initiate(attempt: WalletCollectionAttempt): Promise<WalletCollectionInitiation> {
    this.assertCollect();
    if (attempt.provider !== this.provider || attempt.merchantAccountRef !== this.merchantAccountRef) throw new Error('ADAPTER_MISMATCH');
    const res = await this.client.createCollection({
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
      idempotencyKey: attempt.providerIdempotencyIdentity,
      returnUrl: this.returnUrl(),
    });
    if (!res.providerReference) throw new Error('INVALID_PROVIDER_RESPONSE: missing provider reference');
    return { providerReference: res.providerReference, checkoutUrl: res.checkoutUrl, checkoutSecret: res.checkoutSecret };
  }

  abstract verify(attempt: WalletCollectionAttempt, initiation: WalletCollectionInitiation): Promise<WalletCollectionVerification>;

  protected returnUrl(): string | undefined { return undefined; }
}

/** Stripe collection adapter: normalizes an injected client response; not a raw SDK parser. */
export class StripeWalletCollectionAdapter extends BaseWalletCollectionAdapter {
  readonly provider = 'stripe' as const;
  constructor(merchantAccountRef: string, client: WalletCollectionClient, capabilities: ReadonlyArray<string> = []) {
    super(merchantAccountRef, client, capabilities);
  }

  async verify(attempt: WalletCollectionAttempt, initiation: WalletCollectionInitiation): Promise<WalletCollectionVerification> {
    this.assertCollect();
    if (attempt.provider !== this.provider || attempt.merchantAccountRef !== this.merchantAccountRef) throw new Error('ADAPTER_MISMATCH');
    if (!initiation.providerReference?.trim()) throw new Error('NO_PROVIDER_REFERENCE');
    const v = await this.client.verifyCollection(initiation.providerReference);
    if (v.providerReference !== initiation.providerReference) throw new Error('PROVIDER_REFERENCE_MISMATCH');
    return {
      providerReference: v.providerReference,
      merchantAccountRef: v.merchantAccountRef,
      currency: v.currency,
      amountMinor: v.amountMinor,
      finalStatus: this.normalize(v.finalStatus),
    };
  }

  private normalize(s: string): WalletCollectionVerification['finalStatus'] {
    if (s === 'succeeded') return 'succeeded';
    if (s === 'completed') return 'completed';
    if (s === 'failed') return 'failed';
    if (s === 'pending') return 'pending';
    return 'unknown';
  }
}

/**
 * Kora collection adapter — integration-boundary interface awaiting a real
 * Kora SDK client. The hosted-checkout callback URL is injected (never a
 * hardcoded host). Unsupported capabilities fail closed.
 */
export class KoraWalletCollectionAdapter extends BaseWalletCollectionAdapter {
  readonly provider = 'kora' as const;
  constructor(merchantAccountRef: string, client: WalletCollectionClient, private readonly config: { checkoutCallbackUrl: string; capabilities?: ReadonlyArray<string> }) {
    super(merchantAccountRef, client, config.capabilities ?? []);
  }

  protected override returnUrl(): string | undefined { return this.config.checkoutCallbackUrl; }

  async verify(attempt: WalletCollectionAttempt, initiation: WalletCollectionInitiation): Promise<WalletCollectionVerification> {
    this.assertCollect();
    if (attempt.provider !== this.provider || attempt.merchantAccountRef !== this.merchantAccountRef) throw new Error('ADAPTER_MISMATCH');
    if (!initiation.providerReference?.trim()) throw new Error('NO_PROVIDER_REFERENCE');
    const v = await this.client.verifyCollection(initiation.providerReference);
    if (v.providerReference !== initiation.providerReference) throw new Error('PROVIDER_REFERENCE_MISMATCH');
    const status = v.finalStatus === 'succeeded' || v.finalStatus === 'completed'
      ? 'succeeded' : v.finalStatus === 'failed' ? 'failed' : v.finalStatus === 'pending' ? 'pending' : 'unknown';
    return { providerReference: v.providerReference, merchantAccountRef: v.merchantAccountRef, currency: v.currency, amountMinor: v.amountMinor, finalStatus: status };
  }
}
