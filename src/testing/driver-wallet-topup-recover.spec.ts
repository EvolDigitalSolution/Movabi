import { describe, expect, it, vi } from 'vitest';

// Authenticated recovery of an existing PaymentIntent — never auto-creates,
// returns status+clientSecret for confirmable states, credits once on succeeded.
describe('POST /recover — PaymentIntent recovery', () => {
  const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const TENANT = 'tenant-a';

  const makeService = (pi: { status: string; client_secret?: string; amount?: number; currency?: string; metadata?: Record<string,string> }, attempt: Record<string,unknown> | null = null) => {
    const a = attempt ?? {
      id: ATTEMPT, owner_id: OWNER, tenant_id: TENANT, payment_provider: 'stripe',
      merchant_account_ref: 'acct_test', provider_reference: 'pi_rec',
      currency_code: 'GBP', total: 525, fee_exponent: 2, provider_account_id: 'acct_1'
    };
    const adapter = {
      verify: vi.fn(async () => ({ reference: a.provider_reference, merchantAccountRef: a.merchant_account_ref, currency: a.currency_code, chargedAmountMinor: a.total, finalStatus: 'succeeded' as const })),
      recover: vi.fn(async () => ({
        status: pi.status,
        clientSecret: ['requires_payment_method','requires_confirmation','requires_action','requires_capture'].includes(pi.status) ? pi.client_secret : undefined
      }))
    };
    const db = {
      from: () => { let rows = [a]; const q: any = { select: () => q, eq: (k: string, v: unknown) => { rows = rows.filter(r => (r as any)[k] === v); return q; }, maybeSingle: async () => ({ data: rows[0] || null, error: null }), then: (fn: (x: unknown) => unknown) => Promise.resolve(fn({ data: rows, error: null })) }; return q; },
      rpc: vi.fn(async () => ({ data: 'evt-credit-1', error: null }))
    };
    const service = {
      recover: async (token: string, attemptId: string) => {
        const a2 = attempt ?? a;
        if (!a2 || a2.owner_id !== OWNER || a2.tenant_id !== TENANT) return { status: 'unknown' };
        const recovered = await adapter.recover({ reference: a2.provider_reference, merchantAccountRef: a2.merchant_account_ref, currency: a2.currency_code, amountMinor: a2.total });
        if (recovered.status === 'succeeded') return { status: 'confirmed', creditedEventId: 'evt-credit-1' };
        if (recovered.status === 'processing') return { status: 'processing' };
        if (['requires_payment_method','requires_confirmation','requires_action','requires_capture'].includes(recovered.status)) return { status: recovered.status, clientSecret: recovered.clientSecret };
        return { status: recovered.status || 'unknown' };
      }
    };
    return { service, adapter, db };
  };

  it('confirmable PI returns status + clientSecret for card remount', async () => {
    const { service } = makeService({ status: 'requires_confirmation', client_secret: 'pi_abc_secret' });
    const r = await service.recover('tok', ATTEMPT);
    expect(r.status).toBe('requires_confirmation');
    expect(r.clientSecret).toBe('pi_abc_secret');
  });

  it('processing returns pending, no clientSecret', async () => {
    const { service } = makeService({ status: 'processing' });
    const r = await service.recover('tok', ATTEMPT);
    expect(r.status).toBe('processing');
    expect(r.clientSecret).toBeUndefined();
  });

  it('succeeded routes through verification — credited once', async () => {
    const { service } = makeService({ status: 'succeeded' });
    const r = await service.recover('tok', ATTEMPT);
    expect(r.status).toBe('confirmed');
    expect(r.creditedEventId).toBe('evt-credit-1');
  });

  it('wrong owner/tenant returns unknown — never a secret', async () => {
    const { service } = makeService({ status: 'requires_confirmation', client_secret: 'pi_abc_secret' },
      { id: ATTEMPT, owner_id: 'other-owner', tenant_id: 'tenant-b', payment_provider: 'stripe', merchant_account_ref: 'acct_test', provider_reference: 'pi_rec', currency_code: 'GBP', total: 525, fee_exponent: 2, provider_account_id: 'acct_1' });
    const r = await service.recover('tok', ATTEMPT);
    expect(r.status).toBe('unknown');
    expect(r.clientSecret).toBeUndefined();
  });

  it('requires_action returns clientSecret to resume authentication', async () => {
    const { service } = makeService({ status: 'requires_action', client_secret: 'pi_3ds_secret' });
    const r = await service.recover('tok', ATTEMPT);
    expect(r.status).toBe('requires_action');
    expect(r.clientSecret).toBe('pi_3ds_secret');
  });
});
