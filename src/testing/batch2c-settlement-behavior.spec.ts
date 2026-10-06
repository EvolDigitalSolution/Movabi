/**
 * PHASE C2C — behavioural server tests for `LogisticsService.completeJob`.
 *
 * These exercise the money-movement guard BEHAVIOUR with spies on Stripe and a
 * fluent Supabase mock at the service boundary, including the settlement
 * state-machine claim/reconcile/record RPCs. They complement the structural
 * guards, proving (not asserting by source text) that settlement is single-writer,
 * crash-recoverable and fails closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks. `vi.hoisted` runs before the module graph loads, so the real
// stripe.service / supabase.service are never constructed.
// ---------------------------------------------------------------------------
const M = vi.hoisted(() => {
    const stripe = {
        paymentIntents: { capture: vi.fn() },
        transfers: { create: vi.fn(), list: vi.fn() },
        accounts: { retrieve: vi.fn() }
    };

    const state = {
        select: {} as Record<string, any>,
        update: {} as Record<string, any>,
        updateError: {} as Record<string, any>,
        upsertError: {} as Record<string, any>,
        recordError: null as any,
        rpcCalls: [] as Array<{ fn: string; args: any }>,
        updatePayloads: [] as Array<{ table: string; payload: any }>,
        upsertPayloads: [] as Array<{ table: string; payload: any; opts: any }>
    };

    class Builder {
        op: 'select' | 'update' = 'select';
        constructor(readonly table: string) {}
        select() { return this; }
        eq() { return this; }
        neq() { return this; }
        is() { return this; }
        in() { return this; }
        or() { return this; }
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
            let result: { data: any; error: any };

            if (fn === 'claim_job_settlement') {
                // Faithfully simulate the atomic claim. A 'claimed' row is NEVER
                // re-claimable — even with an expired lease — because the original
                // worker may still be in-flight with Stripe.
                const job = state.select['jobs'] || {};
                const claimable = !job.stripe_transfer_id
                    && (!job.settlement_status || job.settlement_status === 'pending' || job.settlement_status === 'failed');
                if (claimable) {
                    state.select['jobs'] = {
                        ...job,
                        settlement_status: 'claimed',
                        settlement_claimed_at: new Date().toISOString(),
                        settlement_lease_expires_at: new Date(Date.now() + (Number(args.p_lease_seconds) || 120) * 1000).toISOString(),
                        settlement_amount_minor: args.p_amount_minor,
                        settlement_currency: args.p_currency,
                        settlement_destination_account: args.p_destination
                    };
                    result = { data: true, error: null };
                } else {
                    result = { data: false, error: null };
                }
            } else if (fn === 'record_job_settlement') {
                if (state.recordError) {
                    result = { data: null, error: state.recordError };
                } else {
                    const prior = state.select['jobs'] || {};
                    const recorded = {
                        ...prior,
                        status: args.p_was_already_completed ? prior.status : 'completed',
                        payment_status: 'paid',
                        driver_payout: args.p_driver_payout,
                        platform_fee: args.p_platform_fee,
                        stripe_transfer_id: args.p_stripe_transfer_id,
                        settlement_status: 'transferred'
                    };
                    result = { data: [recorded], error: null };
                }
            } else if (fn === 'settle_job_wallet_reservation') {
                result = { data: { status: 'settled', amount_settled: 0, amount_released: 0 }, error: null };
            } else {
                result = { data: {}, error: null };
            }

            return Promise.resolve(result);
        }
    };

    return { stripe, supabaseAdmin, state };
});

vi.mock('../../server/services/stripe.service', () => ({ stripe: M.stripe }));
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: M.supabaseAdmin }));

import { LogisticsService } from '../../server/services/logistics.service';
import { AuditService } from '../../server/services/audit.service';
import { IssuingService } from '../../server/services/issuing.service';

const JOB_ID = '11111111-2222-3333-4444-555555555555';
const DRIVER_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa';

const SNAPSHOT = {
    policyVersion: 'fare-split-v1',
    baseServiceFare: 100,
    customerCharge: 100,
    platformFeeAmount: 0,
    driverBase: 100,
    driverCommissionAmount: 10,
    driverEntitlement: 90,
    grossRevenue: 10,
    currency: 'GBP',
    isPro: false,
    commissionPercent: 10
};

function baseJob(overrides: Record<string, any> = {}): any {
    return {
        id: JOB_ID,
        customer_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        driver_id: DRIVER_ID,
        payment_status: 'authorized',
        payment_method: 'card',
        payment_intent_id: 'pi_test_123',
        stripe_transfer_id: null,
        settlement_status: 'pending',
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
        fare_breakdown: { ...SNAPSHOT },
        commission_rate_used: null,
        metadata: {},
        created_at: '2026-01-01T00:00:00.000Z',
        transferred_at: null,
        completed_at: null,
        ...overrides
    };
}

function baseDriver(): any {
    return {
        id: DRIVER_ID,
        role: 'driver',
        registration_activated_at: '2026-01-01T00:00:00.000Z',
        registration_country_code: 'GB',
        country_code: 'GB',
        stripe_account_id: 'acct_test_connect',
        pricing_plan: 'starter'
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    M.state.select = {};
    M.state.update = {};
    M.state.updateError = {};
    M.state.upsertError = {};
    M.state.recordError = null;
    M.state.updatePayloads = [];
    M.state.upsertPayloads = [];
    M.state.rpcCalls = [];

    M.stripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_test_123', status: 'succeeded' });
    M.stripe.transfers.create.mockResolvedValue({ id: 'tr_test_transfer' });
    M.stripe.transfers.list.mockResolvedValue({ data: [] });
    M.stripe.accounts.retrieve.mockResolvedValue({
        id: 'acct_test_connect', country: 'GB', charges_enabled: true, payouts_enabled: true, details_submitted: true
    });

    vi.spyOn(AuditService, 'logBooking').mockResolvedValue(undefined as any);
    vi.spyOn(IssuingService, 'freezeDriverCard').mockResolvedValue(undefined);
});

const recordArgs = () => {
    const call = M.state.rpcCalls.find(c => c.fn === 'record_job_settlement');
    return call ? call.args : null;
};

describe('PHASE C2C — completion money-movement behaviour (state machine)', () => {
    it('A. a paid earnings row short-circuits: no capture, no transfer, no claim', async () => {
        const job = baseJob({ status: 'completed', payment_status: 'paid' });
        M.state.select['jobs'] = job;
        M.state.select['driver_earnings'] = { job_id: JOB_ID };

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.paymentIntents.capture).not.toHaveBeenCalled();
        expect(M.stripe.transfers.create).not.toHaveBeenCalled();
        expect(M.state.rpcCalls.some(c => c.fn === 'claim_job_settlement')).toBe(false);
        expect(M.state.rpcCalls.some(c => c.fn === 'record_job_settlement')).toBe(false);
    });

    it('B. a completed job with NO paid earnings row resumes and settles', async () => {
        M.state.select['jobs'] = baseJob({ status: 'completed', payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1);
        expect(M.state.rpcCalls.some(c => c.fn === 'record_job_settlement')).toBe(true);
    });

    it('C. capture is invoked once with the deterministic capture-job key', async () => {
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.paymentIntents.capture).toHaveBeenCalledWith(
            'pi_test_123', {}, { idempotencyKey: `capture-job-${JOB_ID}` }
        );
    });

    it('D. an "already been captured" Stripe retry continues without a second economic capture', async () => {
        M.stripe.paymentIntents.capture.mockRejectedValue(new Error('You cannot capture this PaymentIntent because it has already been captured.'));
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1);
    });

    it('E. transfer uses the deterministic key, transfer_group, and the frozen snapshot amount', async () => {
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        const [payload, opts] = M.stripe.transfers.create.mock.calls[0];
        expect(opts).toEqual({ idempotencyKey: `transfer-job-${JOB_ID}` });
        expect(payload.destination).toBe('acct_test_connect');
        expect(payload.transfer_group).toBe(`job_${JOB_ID}`);
        expect(payload.amount).toBe(9000); // frozen 90 GBP -> 9000 pence
    });

    it('F. a persisted genuine stripe_transfer_id skips the transfer and records it', async () => {
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized', stripe_transfer_id: 'tr_existing' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.transfers.create).not.toHaveBeenCalled();
        expect(recordArgs()?.p_stripe_transfer_id).toBe('tr_existing');
    });

    it('G1. a definitive (4xx) rejection persists failed and releases the claim', async () => {
        M.stripe.transfers.create.mockRejectedValue(Object.assign(new Error('No such destination account'), { statusCode: 400, type: 'StripeInvalidRequestError' }));
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await expect(LogisticsService.completeJob(JOB_ID, null, DRIVER_ID)).rejects.toThrow('No such destination account');

        const marker = M.state.updatePayloads.find(p => p.table === 'jobs');
        expect(marker.payload.settlement_status).toBe('failed');
        expect(marker.payload.stripe_transfer_status).toBe('failed');
        expect(marker.payload.stripe_transfer_id).toBeNull();
        expect(M.state.rpcCalls.some(c => c.fn === 'record_job_settlement')).toBe(false);
    });

    it('G2. an ambiguous (network) failure persists unknown and BLOCKS a retry', async () => {
        M.stripe.transfers.create.mockRejectedValue(new Error('Connection reset by peer')); // no statusCode
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await expect(LogisticsService.completeJob(JOB_ID, null, DRIVER_ID)).rejects.toThrow('Connection reset by peer');

        const marker = M.state.updatePayloads.find(p => p.table === 'jobs');
        expect(marker.payload.settlement_status).toBe('unknown');
        expect(marker.payload.stripe_transfer_status).toBe('unknown');
    });

    it('I. settlement uses the frozen snapshot — a later config change does not alter a frozen fare', async () => {
        M.state.select['jobs'] = baseJob({
            payment_status: 'authorized',
            fare_breakdown: { ...SNAPSHOT, driverCommissionAmount: 20, driverEntitlement: 80, grossRevenue: 20, commissionPercent: 20 }
        });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        const [payload] = M.stripe.transfers.create.mock.calls[0];
        expect(payload.amount).toBe(8000); // frozen 20% commission, NOT live config
    });

    it('J. commission basis excludes the customer-side platform fee (frozen snapshot)', async () => {
        M.state.select['jobs'] = baseJob({
            payment_status: 'authorized',
            agreed_fare: null, total_price: 7.15, price: 7.15,
            fare_breakdown: {
                policyVersion: 'fare-split-v1', baseServiceFare: 7.0, customerCharge: 7.15,
                platformFeeAmount: 0.15, driverBase: 7.0, driverCommissionAmount: 0.7,
                driverEntitlement: 6.3, grossRevenue: 0.85, currency: 'GBP', isPro: false, commissionPercent: 10
            }
        });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        const [payload] = M.stripe.transfers.create.mock.calls[0];
        expect(payload.amount).toBe(630); // (7.15 - 0.15) * 0.9
        expect(Number(payload.metadata.driver_payout)).toBe(6.3);
        expect(Number(payload.metadata.platform_fee)).toBe(0.15);
    });
});

describe('settlement recovery (executable behaviour)', () => {
    it('1. simultaneous settlement calls transfer exactly once', async () => {
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await Promise.all([
            LogisticsService.completeJob(JOB_ID, null, DRIVER_ID),
            LogisticsService.completeJob(JOB_ID, null, DRIVER_ID)
        ]);

        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1);
        expect(M.state.rpcCalls.filter(c => c.fn === 'record_job_settlement')).toHaveLength(1);
    });

    it('2. an expired claim is NEVER re-claimable: it blocks (unknown), it does not re-transfer', async () => {
        // A worker claimed, then its lease expired while it may still be in-flight.
        const pastLease = new Date(Date.now() - 60_000).toISOString();
        M.state.select['jobs'] = baseJob({
            payment_status: 'authorized',
            settlement_status: 'claimed',
            settlement_claimed_at: pastLease,
            settlement_lease_expires_at: pastLease,
            stripe_transfer_id: null
        });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();
        M.stripe.transfers.list.mockResolvedValue({ data: [] }); // nothing found yet

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        // No transfer is created, and the stale claim is demoted to 'unknown'.
        expect(M.stripe.transfers.create).not.toHaveBeenCalled();
        expect(M.state.rpcCalls.filter(c => c.fn === 'record_job_settlement')).toHaveLength(0);
        const marker = M.state.updatePayloads.find(p => p.table === 'jobs');
        expect(marker.payload.settlement_status).toBe('unknown');
    });

    it('2b. an expired in-flight claim that DID transfer is resumed by transfer_group, not duplicated', async () => {
        // The original worker's transfer later succeeded on Stripe; a recovery
        // attempt must adopt the SAME transfer, never create a second one.
        const pastLease = new Date(Date.now() - 60_000).toISOString();
        M.state.select['jobs'] = baseJob({
            payment_status: 'authorized',
            settlement_status: 'claimed',
            settlement_claimed_at: pastLease,
            settlement_lease_expires_at: pastLease,
            stripe_transfer_id: null
        });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();
        M.stripe.transfers.list.mockResolvedValue({ data: [{ id: 'tr_original_worker' }] });

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.transfers.create).not.toHaveBeenCalled(); // no duplicate
        expect(recordArgs()?.p_stripe_transfer_id).toBe('tr_original_worker');
    });

    it('3. Stripe succeeds but the record write fails: a retry reconciles by transfer_group, no duplicate transfer', async () => {
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        // First attempt: transfer succeeds, but the atomic record fails.
        M.state.recordError = { message: 'database write failed' };
        await expect(LogisticsService.completeJob(JOB_ID, null, DRIVER_ID)).rejects.toThrow('database write failed');
        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1);

        // Stripe later reveals the transfer via transfer_group (durable, not the
        // short-lived idempotency key).
        M.stripe.transfers.list.mockResolvedValue({ data: [{ id: 'tr_test_transfer' }] });
        M.state.recordError = null;

        // Retry: the job is still 'claimed' (lease may still be active). The claim
        // is refused, so the code reconciles and resumes with the real id.
        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1); // no duplicate
        expect(recordArgs()?.p_stripe_transfer_id).toBe('tr_test_transfer');
    });

    it('4. a timeout leaves the job unknown and a blind retry does NOT transfer again', async () => {
        M.stripe.transfers.create.mockRejectedValue(new Error('ETIMEDOUT')); // no statusCode -> unknown
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await expect(LogisticsService.completeJob(JOB_ID, null, DRIVER_ID)).rejects.toThrow('ETIMEDOUT');
        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1);

        // Retry: job is now 'unknown'. No transfer_group result -> blocked, no transfer.
        M.state.select['jobs'] = { ...baseJob({ payment_status: 'authorized' }), settlement_status: 'unknown' };
        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.transfers.create).toHaveBeenCalledTimes(1); // still exactly one
        expect(M.state.rpcCalls.filter(c => c.fn === 'record_job_settlement')).toHaveLength(0);
    });

    it('5. after the idempotency window, reconciliation by transfer_group (not the key) resumes', async () => {
        // The job is 'unknown' (a previous ambiguous attempt). The idempotency key
        // is no longer useful; recovery is by durable transfer_group lookup.
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized', settlement_status: 'unknown', stripe_transfer_id: null });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();
        M.stripe.transfers.list.mockResolvedValue({ data: [{ id: 'tr_recovered' }] });

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        expect(M.stripe.transfers.create).not.toHaveBeenCalled();
        expect(M.stripe.transfers.list).toHaveBeenCalledWith({ transfer_group: `job_${JOB_ID}`, destination: 'acct_test_connect', limit: 5 });
        expect(recordArgs()?.p_stripe_transfer_id).toBe('tr_recovered');
    });

    it('6. transfer success and earnings recording are atomic (single record_job_settlement RPC)', async () => {
        M.state.select['jobs'] = baseJob({ payment_status: 'authorized' });
        M.state.select['driver_earnings'] = null;
        M.state.select['profiles'] = baseDriver();

        await LogisticsService.completeJob(JOB_ID, null, DRIVER_ID);

        const records = M.state.rpcCalls.filter(c => c.fn === 'record_job_settlement');
        expect(records).toHaveLength(1);
        // No separate earnings upsert — the atomic RPC is the only settlement write.
        expect(M.state.upsertPayloads.filter(p => p.table === 'driver_earnings')).toHaveLength(0);
        // The RPC carries the full immutable identity in one call.
        expect(records[0].args).toMatchObject({
            p_job_id: JOB_ID,
            p_driver_payout: 90,
            p_platform_fee: 0,
            p_stripe_transfer_id: 'tr_test_transfer'
        });
    });
});
