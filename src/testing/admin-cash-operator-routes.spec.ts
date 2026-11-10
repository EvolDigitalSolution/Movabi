import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

let role: string = 'admin';
let rpcResult: { data: any; error: any } = { data: null, error: null };
let rpcCalls: Record<string, unknown>[] = [];
let auditLogged: Record<string, unknown>[] = [];

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
        from: (table: string) => {
            if (table === 'profiles') return {
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role }, error: null }) }) })
            };
            const chain: any = { maybeSingle: async () => ({ data: null, error: null }) };
            chain.eq = () => chain; chain.neq = () => chain; chain.in = () => chain;
            chain.select = () => chain; chain.update = () => chain; chain.insert = () => chain;
            chain.order = () => chain; chain.limit = () => chain; chain.single = chain.maybeSingle;
            return chain;
        },
        rpc: async (name: string, args: Record<string, unknown>) => {
            rpcCalls.push({ name, args });
            return rpcResult;
        }
    }
}));
vi.mock('../../server/services/audit.service', () => ({
    AuditService: { logAdminAction: async (_a: string, action: string, _t: string, _e: string, meta: Record<string, unknown>) => { auditLogged.push({ action, meta }); } }
}));
vi.mock('express-rate-limit', () => {
    const passthrough = () => (_r: any, _s: any, n: any) => n();
    return { rateLimit: passthrough, default: passthrough };
});

import router from '../../server/routes/admin.routes';

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express();
        app.use(express.json());
        app.use(router);
        const srv = app.listen(0, () => {
            const port = (srv.address() as any).port;
            fetch(`http://localhost:${port}${path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
                body: JSON.stringify(body)
            }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

describe('admin cash-operator routes — authorisation + failure mapping', () => {
    beforeEach(() => { role = 'admin'; rpcResult = { data: null, error: null }; rpcCalls = []; auditLogged = []; });

    it('reassign requires admin (customer role denied)', async () => {
        role = 'customer';
        const r = await post('/cash-jobs/job-1/reassign', { newDriverId: 'd' });
        expect(r.status).toBe(403);
        expect(rpcCalls).toHaveLength(0);
    });

    it('reassign success audits and returns the new hold', async () => {
        rpcResult = { data: 'hold-9', error: null };
        const r = await post('/cash-jobs/job-1/reassign', { newDriverId: 'driver-2' });
        expect(r.status).toBe(200);
        expect(r.body.holdId).toBe('hold-9');
        expect(rpcCalls[0]?.name).toBe('reassign_cash_job_credit_v1f');
        expect(auditLogged[0]?.action).toBe('cash_reassign');
    });

    it('reassign CE004 maps to INSUFFICIENT_CREDIT with no state written', async () => {
        rpcResult = { data: null, error: { message: 'Top up driver cash credit before accepting this cash ride CE004' } };
        const r = await post('/cash-jobs/job-1/reassign', { newDriverId: 'driver-2' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('INSUFFICIENT_CREDIT');
        expect(auditLogged).toHaveLength(0); // failure is not audited as success
    });

    it('reassign CE005 maps to CASH_COLLECTED', async () => {
        rpcResult = { data: null, error: { message: 'Cash already collected - reassignment not allowed CE005' } };
        const r = await post('/cash-jobs/job-1/reassign', { newDriverId: 'driver-2' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('CASH_COLLECTED');
    });

    it('review flag sets disputed amount and audits', async () => {
        rpcResult = { data: { id: 'h1', review_required: true }, error: null };
        const r = await post('/cash-jobs/job-1/review', { disputedMinor: 1600 });
        expect(r.status).toBe(200);
        expect(rpcCalls[0]?.name).toBe('flag_cash_hold_review_v1f');
        expect(auditLogged[0]?.action).toBe('cash_review_flag');
    });

    it('review rejects non-positive disputedMinor before touching the RPC', async () => {
        const r = await post('/cash-jobs/job-1/review', { disputedMinor: 0 });
        expect(r.status).toBe(400);
        expect(rpcCalls).toHaveLength(0);
    });

    it('publish computes+persistes threshold and audits the version', async () => {
        rpcResult = { data: { id: 'p1', version: 3 }, error: null };
        const r = await post('/policies/cancellation/publish', {
            tenantId: 't', market: 'GB', referenceFareMinor: 20000, debtThresholdBps: 5000,
            graceSeconds: 300, feeMinor: 1500, compensationPercent: 80
        });
        expect(r.status).toBe(200);
        expect(rpcCalls[0]?.name).toBe('publish_cancellation_policy');
        expect(auditLogged[0]?.meta?.version).toBe(3);
    });

    it('margin preview is read-only RPC pass-through', async () => {
        rpcResult = { data: { vayduMarginMinor: 43 }, error: null };
        const r = await post('/policies/margin-preview', {
            fareSnapshot: { driverCommissionAmount: 35, platformFeeAmount: 35, customerCharge: 175, driverEntitlement: 105 },
            discountMinor: 9, referralLiabilityMinor: 10, processingMinor: 8
        });
        expect(r.status).toBe(200);
        expect(r.body.preview.vayduMarginMinor).toBe(43);
        expect(rpcCalls[0]?.name).toBe('preview_vaydu_margin');
    });
});
