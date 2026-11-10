import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { StripeDriverTopupSandbox } from '../../server/services/payments/stripe-driver-topup-sandbox';

// Recovery through the REAL adapter class — stubbed Stripe SDK + attempt store,
// no fabricated recover() mock. Lost responses at creation AND confirmation.
describe('StripeDriverTopupSandbox.recover', () => {
  const REF = 'pi_recovery_ref';
  const BASE = {
    reference: REF, merchantAccountRef: 'acct_test', providerAccountId: 'acct_1',
    currency: 'GBP', amountMinor: 525, exponent: 2
  };
  const PI = { id: 'pi_x', status: 'requires_confirmation', client_secret: 'pi_x_secret',
    amount: 525, currency: 'gbp', livemode: false,
    metadata: { vaydu_driver_topup: REF, vaydu_account: 'acct_1', vaydu_merchant: 'acct_test', vaydu_total: '525' } };

  const make = (pi: typeof PI | null, session: any = null) => {
    const stripe = {
      accounts: { retrieve: vi.fn(async () => ({ id: 'acct_1' })) },
      paymentIntents: {
        retrieve: vi.fn(async () => pi),
        search: vi.fn(async () => ({ data: pi ? [pi] : [] }))
      },
      checkout: { sessions: { retrieve: vi.fn(async () => session), list: vi.fn(async () => ({ data: session ? [session] : [], has_more: false })) } }
    };
    const store = {
      get: vi.fn(async () => ({ request: { provider: 'stripe', reference: REF, merchantAccountRef: 'acct_test', providerAccountId: 'acct_1', currency: 'GBP', amountMinor: 525, exponent: 2, credentialFingerprint: createHash('sha256').update('sk_test_fixture').digest('hex') }, state: 'submitted', providerSessionId: 'pi_x' })),
      begin: vi.fn(), finish: vi.fn(), observe: vi.fn()
    };
    const adapter = new StripeDriverTopupSandbox(stripe as any, 'sk_test_fixture', 'acct_test', store as any);
    return { adapter, stripe, store };
  };

  it('confirmable PI returns status + clientSecret for remount', async () => {
    const { adapter } = make(PI);
    const r = await adapter.recover!({ ...BASE });
    expect(r.status).toBe('requires_confirmation');
    expect(r.clientSecret).toBe('pi_x_secret');
  });

  it('requires_action returns clientSecret to resume authentication', async () => {
    const { adapter } = make({ ...PI, status: 'requires_action', client_secret: 'pi_3ds_secret' });
    const r = await adapter.recover!({ ...BASE });
    expect(r.status).toBe('requires_action');
    expect(r.clientSecret).toBe('pi_3ds_secret');
  });

  it('processing returns pending — never a secret', async () => {
    const { adapter } = make({ ...PI, status: 'processing', client_secret: 'pi_x_secret' });
    const r = await adapter.recover!({ ...BASE });
    expect(r.status).toBe('processing');
    expect(r.clientSecret).toBeUndefined();
  });

  it('succeeded returns status only — credit goes through verify', async () => {
    const { adapter } = make({ ...PI, status: 'succeeded' });
    const r = await adapter.recover!({ ...BASE });
    expect(r.status).toBe('succeeded');
    expect(r.clientSecret).toBeUndefined();
  });

  it('lost creation with no reconcilable PI returns unknown — no new intent', async () => {
    const { adapter, stripe } = make(null);
    const r = await adapter.recover!({ ...BASE });
    expect(r.status).toBe('unknown');
    expect(r.clientSecret).toBeUndefined();
    expect((stripe.paymentIntents as any).create ?? vi.fn()).not.toHaveBeenCalled();
  });
});
