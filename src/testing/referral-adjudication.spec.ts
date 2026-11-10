import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: any; error: any } = { data: { id: 'r1', referrer_id: 'ref', status: 'reversed' }, error: null };
let updateRow: Record<string, unknown> | null = null;
let auditLogged: Array<{ action: string }> = [];

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
        from: (table: string) => {
            if (table === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'admin' }, error: null }) }) }) };
            if (table === 'referrals') return {
                update: (row: Record<string, unknown>) => { updateRow = row; return { eq: () => ({ in: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'r1', referrer_id: 'ref', status: row.status }, error: null }) }) }) }) }; }
            };
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), update: async () => ({ error: null }) };
        },
        rpc: async (name: string, args: Record<string, unknown>) => { rpcCalls.push({ name, args }); return rpcResult; }
    }
}));
vi.mock('../../server/services/audit.service', () => ({
    AuditService: { logAdminAction: async (_a: string, action: string) => { auditLogged.push({ action }); } }
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
            fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body) })
                .then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

describe('referral adjudication (real router)', () => {
    beforeEach(() => {
        rpcCalls = [];
        rpcResult = { data: { id: 'r1', referrer_id: 'ref', status: 'reversed' }, error: null };
        updateRow = null;
        auditLogged = [];
    });

    it('reversal delegates to reverse_referral_reward (referral + credit atomic)', async () => {
        const r = await post('/referrals/r1/adjudicate', { status: 'reversed' });
        expect(r.status).toBe(200);
        expect(rpcCalls[0]?.name).toBe('reverse_referral_reward');
        expect(rpcCalls[0]?.args.p_referral).toBe('r1');
        expect(updateRow).toBeNull(); // no bare status write for reversal
        expect(auditLogged[0]?.action).toBe('referral_reversed');
    });

    it('reversal of a non-reversible referral is refused', async () => {
        rpcResult = { data: { id: 'r1', referrer_id: 'ref', status: 'rejected' }, error: null };
        const r = await post('/referrals/r1/adjudicate', { status: 'reversed' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('REFERRAL_STATE');
    });

    it('release still uses the guarded status write (no credit reversal)', async () => {
        const r = await post('/referrals/r1/adjudicate', { status: 'released' });
        expect(r.status).toBe(200);
        expect(rpcCalls).toHaveLength(0);
        expect(updateRow).toMatchObject({ status: 'released' });
        expect(auditLogged[0]?.action).toBe('referral_released');
    });
});
