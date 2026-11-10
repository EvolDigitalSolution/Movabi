import { describe, it, expect, vi } from 'vitest';
import { createGbGatewayCheckout, GbCheckoutParams } from '../../server/services/payments/gb-gateway-checkout';
const params: GbCheckoutParams = {
  amount: 1900, currency: 'gbp', capture_method: 'manual', payment_method_types: ['card'],
  metadata: { jobId: 'job-test', purpose: 'job_payment', countryCode: 'GB', capturePolicy: 'capture_only_when_job_completed' }
};
function fixture(result: any = { id: 'pi_test', currency: 'gbp', amount: 1900, status: 'requires_payment_method', client_secret: 'test_only' }) {
  const create = vi.fn().mockResolvedValue(result);
  return { create, client: { paymentIntents: { create } } as any };
}
describe('GB gateway checkout pilot', () => {
  it('preserves card-only manual capture, exact minor amount, metadata and idempotency key', async () => {
    const f = fixture();
    expect(await createGbGatewayCheckout(f.client, 'GB', params, 'original-key', 'GBP')).toEqual({ id: 'pi_test', client_secret: 'test_only' });
    expect(f.create).toHaveBeenCalledExactlyOnceWith({ amount: 1900, currency: 'gbp', capture_method: 'manual', payment_method_types: ['card'], metadata: params.metadata }, { idempotencyKey: 'original-key' });
  });
  it.each([undefined, '', 'gb', 'NG', 'US'])('rejects country %s before calling Stripe', async country => {
    const f = fixture();
    await expect(createGbGatewayCheckout(f.client, country, params, 'key', 'GBP')).rejects.toMatchObject({ code: 'PAYMENT_MARKET_UNAVAILABLE' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each(['usd', 'ngn', '', 'GBP'])('rejects currency %s before calling Stripe', async currency => {
    const f = fixture();
    await expect(createGbGatewayCheckout(f.client, 'GB', { ...params, currency }, 'key', 'GBP')).rejects.toMatchObject({ code: 'PAYMENT_MARKET_UNAVAILABLE' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid amount %s', async amount => {
    const f = fixture();
    await expect(createGbGatewayCheckout(f.client, 'GB', { ...params, amount }, 'key', 'GBP')).rejects.toMatchObject({ code: 'INVALID_PAYMENT_AMOUNT' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each(['', ' key ', 'x'.repeat(256)])('rejects invalid idempotency key', async key => {
    const f = fixture();
    await expect(createGbGatewayCheckout(f.client, 'GB', params, key, 'GBP')).rejects.toMatchObject({ code: 'INVALID_PAYMENT_INPUT' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([{ purpose: 'other' }, { countryCode: 'NG' }, { jobId: '' }])('rejects invalid booking metadata %j', async changed => {
    const f = fixture();
    await expect(createGbGatewayCheckout(f.client, 'GB', { ...params, metadata: { ...params.metadata, ...changed } }, 'key', 'GBP')).rejects.toMatchObject({ code: 'INVALID_PAYMENT_INPUT' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([{ amount: 1800 }, { client_secret: undefined }, { currency: 'usd' }, { id: '' }])('requires reconciliation for an unexpected response %j', async changed => {
    const f = fixture({ id: 'pi_test', currency: 'gbp', amount: 1900, client_secret: 'test_only', ...changed });
    await expect(createGbGatewayCheckout(f.client, 'GB', params, 'original-key', 'GBP')).rejects.toMatchObject({ code: 'PAYMENT_RESPONSE_UNCONFIRMED' });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, '', 'USD', 'NGN'])('requires persisted GBP currency %s', async persistedCurrency => {
    const f = fixture();
    await expect(createGbGatewayCheckout(f.client, 'GB', params, 'key', persistedCurrency)).rejects.toMatchObject({ code: 'PAYMENT_MARKET_UNAVAILABLE' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('propagates uncertainty without fallback or another create', async () => {
    const f = fixture(), failure = Error('timeout');
    f.create.mockRejectedValue(failure);
    await expect(createGbGatewayCheckout(f.client, 'GB', params, 'original-key', 'GBP')).rejects.toBe(failure);
    expect(f.create).toHaveBeenCalledTimes(1);
  });
});
