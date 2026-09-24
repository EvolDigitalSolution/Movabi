/**
 * PHASE C2C — behavioral server tests for `LogisticsService.completeJob`.
 *
 * These prove the money-movement guard BEHAVIOR with spies on Stripe and a
 * fluent Supabase mock at the service boundary (vi.mock), rather than by
 * matching source text. They complement the structural SQL tests in
 * `batch2c-money-authority.spec.ts`, which pin the wallet RPC provenance guard
 * and the pre/post-flight SQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks. `vi.hoisted` runs before the module graph loads, so the real
// stripe.service / supabase.service are never constructed (no dotenv/config,
// no network client) and every transitive importer gets these same doubles.
// ---------------------------------------------------------------------------
const M = vi.hoisted(() => {
    const stripe = {
        paymentIntents: { capture: vi.fn() },
        transfers: { create: vi.fn() }
    };

    const state = {
        select: {} as Record<string, any>,
        update: {} as Record<string, any>,
        updateError: {} as Record<string, any>,
        upsertError: {} as Record<string, any>,
        rpcImpl: (fn: string, args: any) => ({ data: {} as any, error: null as any }),
        updatePayloads: [] as Array<{ table: string; payload: any }>,
        upsertPayloads: [] as Array<{ table: string; payload: any; opts: any }>,
        rpcCalls: [] as Array<{ fn: string; args: any }>
    };

    class Builder {
        op: 'select' | 'update' = 'select';
        constructor(readonly table: string) {}
        select() { return this; }
        eq() { return this; }
        ilike() { return this; }
        gt() { return this; }
        update(payload: any) {
            this.op = 'update';
            state.updatePayloads.push({ table: this.table, payload });
            return this;
        }
        maybeSingle() {
            return Promise.resolve({ data: state.select[this.table] ?? null, error: null });
        }
        single() {
            if (this.op === 'update') {
                return Promise.resolve({ data: state.update[this.table] ?? null, error: state.updateError[this.table] ?? null });
            }
            return Promise.resolve({ data: state.select[this.table] ?? null, error: null });
        }
        upsert(payload: any, opts: any) {
            state.upsertPayloads.push({ table: this.table, payload, opts });
            return Promise.resolve({ data: {}, error: state.upsertError[this.table] ?? null });
        }
        then(resolve: any, reject: any) {
            const result = this.op === 'update'
                ? { data: state.update[this.table] ?? null, error: state.updateError[this.table] ?? null }
                : { data: state.select[this.table] ?? null, error: null };
            return Promise.resolve(result).then(resolve, reject);
        }
    }

    const supabaseAdmin = {
        from: (table: string) => new Builder(table),
        rpc: (fn: string, args: any) => {
            state.rpcCalls.push({ fn, args });
            return Promise.resolve(state.rpcImpl(fn, args));
        }
    };

    return { stripe, supabaseAdmin, state };
});

vi.mock('../../server/services/stripe.service', () => ({ stripe: M.stripe }));
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: M.supabaseAdmin }));

import { LogisticsService } from '../../server/services/logistics.service';
import { AuditService } from '../../server/services/audit.service';
import { MarketplaceConfigService } from '../../server/services/marketplace-config.service';
import { IssuingService } from '../../server/services/issuing.service';

const JOB_ID = '11111111-2222-3333-4444-555555555555';
const DRIVER_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function baseJob(overrides: Record<string, any> = {}): any {
    return {
        id: JOB_ID,
        customer_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        driver_id: DRIVER_ID,
        payment_status: 'authorized',
        payment_method: 'card',
        payment_intent_id: 'pi_test_123',
        stripe_transfer_id: null,
        status: 'in_progress',
        agreed_fare: 100,
        total_price: 100,
        estimated_price: null,
        price: 100,
        currency_code: 'gbp',
        country_code: 'GB',
        service_slug: 'delivery',
        city_zone: null,
        tenant_id: null,
        driver_tier_at_assignment: null,
        fare_breakdown: null,
        commission_rate_used: null,
        metadata: {},
        created_at: '2026-01-01T00:00:00.000Z',
        transferred_at: null,
        completed_at: null,
        ...overrides
    };
}

function baseDriver(): any {
    return { id: DRIVER_ID, stripe_account_id: 'acct_test_connect', pricing_plan: 'starter' };
}

beforeEach(() => {
    vi.clearAllMocks();
    M.state.select = {};
    M.state.update = {};
    M.state.updateError = {};
    M.state.upsertError = {};
    M.state.updatePayloads = [];
    M.state.upsertPayloads = [];
    M.state.rpcCalls = [];
    M.state.rpcImpl = () => ({ data: {}, error: null });

    M.stripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_test_123', status: 'succeeded' });
    M.stripe.transfers.create.mockResolvedValue({ id: 'tr_test_transfer' });

    vi.spyOn(MarketplaceConfigService, 'getEffectiveCommissionPercent').mockResolvedValue(10);
    vi.spyOn(AuditService, 'logBooking').mockResolvedValue(undefined as any);
    vi.spyOn(IssuingService, 'freezeDriverCard').mockResolvedValue(undefined);
});

describe('PHASE C2C — completion money-movement behavior', () => {
    it('A. a paid earnings row short-circuits: no second capture, no second transfer', async () => {
        const job = baseJob({ status: 'completed', payment_status: 'paid' });
        M.state.select['jobs'] = job;
        M.state.select['driver_earnings'] = { job_id: JOB_ID }; // settled ('paid') earnings row

        const result = await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(result).toBe(job);
        expect(M.stripe.paymentIntents.capture).not.toHaveBeenCalled();
        expect(M.stripe.transfers.create).not.toHaveBeenCalled();
        expect(M.state.updatePayloads).toHaveLength(0);
        expect(M.state.upsertPayloads).toHaveLength(0);
    });

    it('B. a completed job with NO paid earnings row does NOT falsely short-circuit', async () => {
        M.state.select['jobs'] = baseJob({ status: 'completed', payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null; // trigger-created 'pending' or absent
        M.state.select['profiles'] = baseDriver();
        M.state.update['jobs'] = { ...baseJob({ status: 'completed', payment_status: 'paid' }), stripe_transfer_id: 'tr_test_transfer' };

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1);
    });

    it('C. capture is invoked exactly once with the deterministic capture-job key', async () => {
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();
        M.state.update['jobs'] = { ...baseJob({ status: 'completed', payment_status: 'paid' }), stripe_transfer_id: 'tr_test_transfer' };

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
        expect(M.stripe.paymentIntents.capture).toHaveBeenCalledWith(
            'pi_test_123',
            {},
            { idempotencyKey: `capture-job-${JOB_ID}` }
        );
    });

    it('D. an "already been captured" Stripe retry continues without a second economic capture', async () => {
        M.stripe.paymentIntents.capture.mockRejectedValue(
            new Error('You cannot capture this PaymentIntent because it has already been captured.')
        );
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();
        M.state.update['jobs'] = { ...baseJob({ status: 'completed', payment_status: 'paid' }), stripe_transfer_id: 'tr_test_transfer' };

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1); // proceeded to payout
    });

    it('E. transfer uses the deterministic transfer-job key and the derived payout basis', async () => {
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();
        M.state.update['jobs'] = { ...baseJob({ status: 'completed', payment_status: 'paid' }), stripe_transfer_id: 'tr_test_transfer' };

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1);
        const [payload, opts] = M.stripe.transfers.create.mock.calls[0];
        expect(opts).toEqual({ idempotencyKey: `transfer-job-${JOB_ID}` });
        expect(payload.destination).toBe('acct_test_connect');
        expect(payload.amount).toBe(9000); // 100 - 10% = 90 GBP -> 9000 pence
    });

    it('F. a persisted stripe_transfer_id skips transfer creation entirely', async () => {
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized', stripe_transfer_id: 'tr_existing' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();
        M.state.update['jobs'] = { ...baseJob({ status: 'completed', payment_status: 'paid' }), stripe_transfer_id: 'tr_existing' };

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.transfers.create).not.toHaveBeenCalled();
        const jobUpdate = M.state.updatePayloads.find(p => p.table === 'jobs');
        expect(jobUpdate.payload.stripe_transfer_id).toBe('tr_existing');
    });

    it('G1. a definitive (4xx) transfer rejection persists failed + error evidence and rethrows the original', async () => {
        const rejection = Object.assign(new Error('No such destination account'), {
            statusCode: 400,
            type: 'StripeInvalidRequestError'
        });
        M.stripe.transfers.create.mockRejectedValue(rejection);
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await expect(LogisticsService.completeJob(JOB_ID, null, DRIVER_ID)).rejects.toBe(rejection);

        const jobUpdate = M.state.updatePayloads.find(p => p.table === 'jobs');
        expect(jobUpdate.payload.stripe_transfer_status).toBe('failed');
        expect(jobUpdate.payload.metadata.stripe_transfer_error).toBe('No such destination account');
        expect(jobUpdate.payload.metadata.stripe_transfer_error_type).toBe('StripeInvalidRequestError');
        expect(M.state.upsertPayloads).toHaveLength(0); // no earnings row after failure
    });

    it('G2. an ambiguous (network/5xx) transfer failure persists unknown, not failed', async () => {
        const networkErr = new Error('Connection reset by peer'); // no statusCode
        M.stripe.transfers.create.mockRejectedValue(networkErr);
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await expect(LogisticsService.completeJob(JOB_ID, null, DRIVER_ID)).rejects.toBe(networkErr);

        const jobUpdate = M.state.updatePayloads.find(p => p.table === 'jobs');
        expect(jobUpdate.payload.stripe_transfer_status).toBe('unknown');
        expect(jobUpdate.payload.metadata.stripe_transfer_error).toBe('Connection reset by peer');
    });

    it('H. retry after an ambiguous transfer failure reuses the SAME keys and resumes', async () => {
        M.stripe.transfers.create.mockRejectedValueOnce(new Error('Connection reset by peer'));
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();
        M.state.update['jobs'] = { ...baseJob({ status: 'completed', payment_status: 'paid' }), stripe_transfer_id: 'tr_test_transfer' };

        await expect(LogisticsService.completeJob(JOB_ID, null, DRIVER_ID)).rejects.toThrow('Connection reset by peer');

        // Retry with the SAME persisted state: payment_status still 'authorized',
        // stripe_transfer_id still null (the completion UPDATE never ran).
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.updatePayloads = [];
        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        const captureKeys = M.stripe.paymentIntents.capture.mock.calls.map(c => (c[2] as any).idempotencyKey);
        const transferKeys = M.stripe.transfers.create.mock.calls.map(c => (c[1] as any).idempotencyKey);
        // Same idempotency key on both attempts => Stripe returns the SAME capture
        // and the SAME transfer, so neither is duplicated economically.
        expect(captureKeys).toEqual([`capture-job-${JOB_ID}`, `capture-job-${JOB_ID}`]);
        expect(transferKeys).toEqual([`transfer-job-${JOB_ID}`, `transfer-job-${JOB_ID}`]);

        const finalUpdate = M.state.updatePayloads.find(p => p.table === 'jobs');
        expect(finalUpdate.payload.stripe_transfer_id).toBe('tr_test_transfer');
        expect(finalUpdate.payload.stripe_transfer_status).toBe('paid');
    });

    it('I. the settlement basis is the persisted agreed_fare + persisted commission, not client input', async () => {
        M.state.select['jobs'] = baseJob({
            payment_status: 'authorized',
            agreed_fare: 100,
            fare_breakdown: { commissionPercent: 20 } // server-authored fare snapshot
        });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();
        M.state.update['jobs'] = { ...baseJob({ status: 'completed', payment_status: 'paid' }), stripe_transfer_id: 'tr_test_transfer' };

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        const [payload] = M.stripe.transfers.create.mock.calls[0];
        // 20% commission on 100 -> platform fee 20 -> driver payout 80 -> 8000 pence.
        expect(payload.amount).toBe(8000);
        expect(payload.metadata.driver_payout).toBe('80');
        expect(payload.metadata.platform_fee).toBe('20');
        expect(payload.metadata.total_price).toBe('100');
        // completeJob accepts no amount/commission parameter at all.
        expect(LogisticsService.completeJob.length).toBeLessThanOrEqual(3);
    });
});
