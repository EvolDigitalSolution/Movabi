import { describe, expect, it } from 'vitest';
import {
  StripeWalletCollectionAdapter,
  KoraWalletCollectionAdapter,
  type WalletCollectionAttempt,
  type WalletCollectionClient,
} from '../../server/services/payments/wallet-collection';

/** Mocked TRANSPORT tests — the provider client is mocked; verification/parsing is real. */
const attempt: WalletCollectionAttempt = {
  attemptKey: 'internal:topup:test',
  tenantId: '11111111-1111-1111-1111-111111111111',
  ownerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  country: 'GB',
  currency: 'GBP',
  amountMinor: 10000n,
  destinationAccountPurpose: 'customer_credit',
  provider: 'stripe',
  merchantAccountRef: 'stripe-platform',
  providerIdempotencyIdentity: 'idem-1',
};

function client(overrides: Partial<WalletCollectionClient> = {}): WalletCollectionClient {
  return {
    createCollection: async () => ({ providerReference: 'pi_1' }),
    verifyCollection: async () => ({
      providerReference: 'pi_1', merchantAccountRef: 'stripe-platform',
      currency: 'GBP', amountMinor: 10000n, finalStatus: 'succeeded',
    }),
    ...overrides,
  };
}

describe('Batch 1C production collection adapters (mocked transport)', () => {
  it('Stripe adapter passes the frozen idempotency identity to the transport', async () => {
    let seenIdem = '';
    const c = client({ createCollection: async (i) => { seenIdem = i.idempotencyKey; return { providerReference: 'pi_1' }; } });
    const a = new StripeWalletCollectionAdapter('stripe-platform', c, ['collect']);
    await a.initiate(attempt);
    expect(seenIdem).toBe('idem-1');
  });

  it('Stripe adapter verifies currency/amount/status from the parsed response', async () => {
    const a = new StripeWalletCollectionAdapter('stripe-platform', client(), ['collect']);
    const init = await a.initiate(attempt);
    const v = await a.verify(attempt, init);
    expect(v.currency).toBe('GBP');
    expect(v.amountMinor).toBe(10000n);
    expect(v.finalStatus).toBe('succeeded');
  });

  it('Stripe adapter fails closed on a mismatched provider reference', async () => {
    const c = client({ verifyCollection: async () => ({
      providerReference: 'pi_other', merchantAccountRef: 'stripe-platform',
      currency: 'GBP', amountMinor: 10000n, finalStatus: 'succeeded' }) });
    const a = new StripeWalletCollectionAdapter('stripe-platform', c, ['collect']);
    await expect(a.verify(attempt, { providerReference: 'pi_1' })).rejects.toThrow('PROVIDER_REFERENCE_MISMATCH');
  });

  it('Kora adapter returns a hosted checkout URL (injected callback, no hardcoded host)', async () => {
    let seenReturnUrl = '';
    const c = client({ createCollection: async (i) => { seenReturnUrl = i.returnUrl ?? ''; return { providerReference: 'kora_ref_1', checkoutUrl: 'https://pay.kora.example/cb' }; } });
    const k = new KoraWalletCollectionAdapter('ng-merchant', c, { checkoutCallbackUrl: 'https://app.example/kora/callback', capabilities: ['collect'] });
    const init = await k.initiate({ ...attempt, provider: 'kora', merchantAccountRef: 'ng-merchant' });
    expect(seenReturnUrl).toBe('https://app.example/kora/callback');
    expect(init.checkoutUrl).toBe('https://pay.kora.example/cb');
  });

  it('unapproved collection actually fails before transport', async () => {
    let calls=0;
    const a=new StripeWalletCollectionAdapter('stripe-platform',client({createCollection:async()=>{calls++;return {providerReference:'unexpected'};}}));
    await expect(a.initiate(attempt)).rejects.toThrow('PAYMENT_CAPABILITY_UNAVAILABLE');
    expect(calls).toBe(0);
  });
});
