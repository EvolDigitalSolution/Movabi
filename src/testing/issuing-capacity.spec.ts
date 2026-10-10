import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ balance: vi.fn(), query: vi.fn() }));
vi.mock('../../server/services/stripe.service', () => ({ stripe: { balance: { retrieve: mocks.balance } } }));
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: { from: () => ({
  select() { return this; }, eq() { return this; }, order() { return this; }, range: mocks.query
}) } }));
import { IssuingCapacityService } from '../../server/services/issuing-capacity.service';
describe('shopping capacity before payment', () => {
  beforeEach(() => {
    vi.stubEnv('STRIPE_ISSUING_ENABLED', 'true');
    mocks.balance.mockReset().mockResolvedValue({ issuing: { available: [{ currency: 'gbp', amount: 10000 }] } });
    mocks.query.mockReset().mockResolvedValue({ data: [], error: null });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('blocks the reported GBP120 budget against GBP100', async () => {
    await expect(IssuingCapacityService.assertAvailable(120, 'GBP')).rejects.toThrow('exceeds current funding capacity');
  });
  it('permits exactly the available capacity', async () => {
    await expect(IssuingCapacityService.assertAvailable(100, 'gbp')).resolves.toBeUndefined();
  });
  it('deducts another active jobs reserve', async () => {
    mocks.query.mockResolvedValue({ data: [{ job_id: 'other', amount_remaining: 30, jobs: { status: 'assigned' } }], error: null });
    await expect(IssuingCapacityService.assertAvailable(80, 'GBP')).rejects.toThrow('exceeds');
  });
  it('does not double count this jobs reserve or terminal jobs', async () => {
    mocks.query.mockResolvedValue({ data: [
      { job_id: 'own', amount_remaining: 30, jobs: { status: 'assigned' } },
      { job_id: 'done', amount_remaining: 40, jobs: { status: 'completed' } }
    ], error: null });
    await expect(IssuingCapacityService.assertAvailable(100, 'GBP', 'own')).resolves.toBeUndefined();
  });
  it('does not use GBP funds for another currency', async () => {
    await expect(IssuingCapacityService.assertAvailable(1, 'EUR')).rejects.toThrow('exceeds');
  });
  it('leaves zero budget tasks independent of Issuing', async () => {
    vi.stubEnv('STRIPE_ISSUING_ENABLED', 'false');
    await expect(IssuingCapacityService.assertAvailable(0, 'GBP')).resolves.toBeUndefined();
    expect(mocks.balance).not.toHaveBeenCalled();
  });
  it('blocks when reserve lookup fails', async () => {
    mocks.query.mockResolvedValue({ data: null, error: { message: 'offline' } });
    await expect(IssuingCapacityService.assertAvailable(10, 'GBP')).rejects.toThrow('could not be verified');
  });
  it('reads additional reserve pages rather than silently truncating', async () => {
    mocks.query.mockResolvedValueOnce({ data: Array.from({ length: 500 }, (_, i) => ({ job_id: String(i), amount_remaining: .1, jobs: { status: 'assigned' } })), error: null })
      .mockResolvedValueOnce({ data: [{ job_id: 'last', amount_remaining: 10, jobs: { status: 'assigned' } }], error: null });
    await expect(IssuingCapacityService.assertAvailable(50, 'GBP')).rejects.toThrow('exceeds');
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
  it('guards existing card intent reuse as well as creation', () => {
    const source = readFileSync('server/routes/payment.routes.ts', 'utf8');
    const guard = source.indexOf('await IssuingCapacityService.assertAvailable');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(source.indexOf('const existing = await stripe.paymentIntents.retrieve(job.payment_intent_id)'));
    expect(guard).toBeLessThan(source.indexOf('pi = await stripe.paymentIntents.create'));
  });
});
