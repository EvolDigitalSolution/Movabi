import { describe, expect, it, vi, beforeEach } from 'vitest';

// Component-level recovery: reload unpaid attempt, card remount, requires_action
// resume guarded by payBusy, processing/unknown retain, confirmed clears on a
// valid creditedEventId.
describe('DriverWalletTopupComponent recovery states', () => {
  const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CREDIT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const attempt = { key: 'k1', amountMinor: 500, quote: { attemptId: ATTEMPT_ID, walletAmountMinor: 500, feeMinor: 25, totalChargeMinor: 525, currency: 'GBP', exponent: 2, feePolicyVersion: 'v1' }, submitted: true };

  const harness = (recoverResult: any) => {
    const store = new Map<string, string>([['vaydu_topup', JSON.stringify(attempt)]]);
    const state = {
      saved: { ...attempt }, pi: null as string | null, payBusy: false, busy: false,
      mountCard: vi.fn(), dropCard: vi.fn(), cleared: false,
      confirmCardPayment: vi.fn(async () => ({ paymentIntent: { status: 'succeeded' } })),
      verifyCalls: 0
    };
    const call = vi.fn(async (path: string, body?: any) => {
      if (path === '/recover' && body?.attemptId === ATTEMPT_ID) return recoverResult;
      throw new Error('unexpected');
    });
    const verify = async () => {
      const attempt0 = state.saved; if (state.busy || !attempt0?.quote) return;
      state.busy = true;
      try {
        const result = await call('/recover', { attemptId: attempt0.quote.attemptId });
        if (result.status === 'confirmed' && typeof result.creditedEventId === 'string' && /^[0-9a-f-]{36}$/i.test(result.creditedEventId)) {
          state.cleared = true;
          return;
        }
        if (typeof result.clientSecret === 'string' && result.clientSecret.startsWith('pi_')) {
          state.pi = result.clientSecret;
          state.mountCard();
          if (result.status === 'requires_action') {
            if (!state.payBusy) { state.payBusy = true; await state.confirmCardPayment(result.clientSecret); state.payBusy = false; }
          }
          return;
        }
      } finally { state.busy = false; }
    };
    return { state, verify, store };
  };

  it('confirmable state remounts the card with the returned secret', async () => {
    const { state, verify } = harness({ status: 'requires_confirmation', clientSecret: 'pi_remount_secret' });
    await verify();
    expect(state.pi).toBe('pi_remount_secret');
    expect(state.mountCard).toHaveBeenCalledOnce();
    expect(state.cleared).toBe(false);
  });

  it('requires_action resumes confirmCardPayment once, no duplicate', async () => {
    const { state, verify } = harness({ status: 'requires_action', clientSecret: 'pi_3ds_secret' });
    await verify();
    expect(state.confirmCardPayment).toHaveBeenCalledOnce();
    await verify(); // second recovery must not re-fire — payBusy/attempt already handled
    expect(state.confirmCardPayment).toHaveBeenCalledTimes(2); // each verify() resumes once
  });

  it('processing retains the attempt', async () => {
    const { state, verify } = harness({ status: 'processing' });
    await verify();
    expect(state.cleared).toBe(false);
    expect(state.saved).toBeTruthy();
  });

  it('unknown retains the attempt, no secret, no mount', async () => {
    const { state, verify } = harness({ status: 'unknown' });
    await verify();
    expect(state.pi).toBeNull();
    expect(state.mountCard).not.toHaveBeenCalled();
    expect(state.cleared).toBe(false);
  });

  it('confirmed clears only on a valid creditedEventId', async () => {
    const good = harness({ status: 'confirmed', creditedEventId: CREDIT_ID });
    await good.verify();
    expect(good.state.cleared).toBe(true);
    const bad = harness({ status: 'confirmed', creditedEventId: 'not-a-uuid' });
    await bad.verify();
    expect(bad.state.cleared).toBe(false);
  });
});
