import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

let role: string = 'admin';
let adminTenantId: string | null = null; // null = global admin
let insertRow: Record<string, unknown> | null = null;
let updateRow: Record<string, unknown> | null = null;
let existingCampaign: Record<string, unknown> | null = { id: 'c1', tenant_id: 't1', version: 1 };
let auditLogged: Array<{ action: string; meta: Record<string, unknown> }> = [];

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
        from: (table: string) => {
            if (table === 'profiles') return {
                select: () => ({ eq: () => ({
                    maybeSingle: async () => ({ data: { role }, error: null }),
                    single: async () => ({ data: { tenant_id: adminTenantId }, error: null })
                }) })
            };
            if (table === 'campaigns') return {
                insert: (row: Record<string, unknown>) => {
                    insertRow = row;
                    return { select: () => ({ single: async () => ({ data: { id: 'c1', code: row.code, kind: row.kind, enabled: row.enabled, version: row.version }, error: null }) }) };
                },
                update: (row: Record<string, unknown>) => {
                    updateRow = row;
                    return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'c1', code: 'PROMO5', enabled: row.enabled, paused: row.paused, version: row.version }, error: null }) }) }) };
                },
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existingCampaign, error: null }), order: async () => ({ data: [], error: null }) }) })
            };
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), insert: async () => ({ error: null }), update: async () => ({ error: null }) };
        },
        rpc: async () => ({ data: null, error: null })
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

const validBody = () => ({
    tenant_id: 't1', code: 'PROMO5', kind: 'customer_discount',
    market_code: 'GB', currency_code: 'GBP', service_slug: 'ride',
    audience: 'customer', funding_party: 'platform', stacking: 'exclusive',
    value_type: 'percent', budget_minor: 100000, per_user_cap: 1,
    qualification: { firstBookingOnly: true, min_qualifying_fare_minor: 500, max_discount_minor: 2000 }
});

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

describe('campaign admin controls (real router)', () => {
    beforeEach(() => { role = 'admin'; adminTenantId = null; insertRow = null; updateRow = null; existingCampaign = { id: 'c1', tenant_id: 't1', version: 1 }; auditLogged = []; });

    it('create validates and defaults a 5% customer discount', async () => {
        const r = await post('/campaigns', validBody());
        expect(r.status).toBe(201);
        expect(insertRow).toBeTruthy();
        expect(insertRow!.value).toBe(5);          // approved 5% default
        expect(insertRow!.value_type).toBe('percent');
        expect(insertRow!.enabled).toBe(false);    // never enabled by omission
        expect(insertRow!.version).toBe(1);
        expect(insertRow!.referral_reward_bps).toBe(500); // 5% referral default
        expect(auditLogged[0]?.action).toBe('campaign_created');
    });

    it('create rejects an out-of-range percent', async () => {
        const b = validBody(); (b as any).value = 140;
        const r = await post('/campaigns', b);
        expect(r.status).toBe(400);
        expect(insertRow).toBeNull();
    });

    it('create rejects an invalid currency and invalid dates', async () => {
        const badCurrency = validBody(); (badCurrency as any).currency_code = 'GB';
        expect((await post('/campaigns', badCurrency)).status).toBe(400);
        const badDates = validBody();
        (badDates as any).valid_from = '2026-12-01T00:00:00Z';
        (badDates as any).valid_until = '2026-01-01T00:00:00Z';
        expect((await post('/campaigns', badDates)).status).toBe(400);
        expect(insertRow).toBeNull();
    });

    it('pause / resume / disable map to the tri-state lifecycle and audit', async () => {
        await post('/campaigns/c1/status', { state: 'paused' });
        expect(updateRow).toMatchObject({ enabled: true, paused: true });
        expect(auditLogged[0]?.action).toBe('campaign_paused');

        await post('/campaigns/c1/status', { state: 'enabled' });
        expect(updateRow).toMatchObject({ enabled: true, paused: false });
        expect(auditLogged[1]?.action).toBe('campaign_enabled');

        await post('/campaigns/c1/status', { state: 'disabled' });
        expect(updateRow).toMatchObject({ enabled: false, paused: false });
        expect(auditLogged[2]?.action).toBe('campaign_disabled');
    });

    it('pause does not erase obligations — it only flips lifecycle fields', async () => {
        await post('/campaigns/c1/status', { state: 'paused' });
        const keys = Object.keys(updateRow!).sort();
        expect(keys).toEqual(['enabled', 'paused', 'published_at', 'published_by', 'version']);
        // No application/reward/delete side-effects in a lifecycle transition.
    });

    it('invalid state is rejected before touching the database', async () => {
        const r = await post('/campaigns/c1/status', { state: 'activated' });
        expect(r.status).toBe(400);
        expect(updateRow).toBeNull();
    });

    it('non-admin access is forbidden and writes nothing', async () => {
        role = 'customer';
        expect((await post('/campaigns', validBody())).status).toBe(403);
        expect((await post('/campaigns/c1/status', { state: 'paused' })).status).toBe(403);
        expect(insertRow).toBeNull();
        expect(updateRow).toBeNull();
        expect(auditLogged).toHaveLength(0);
    });

    it('a tenant-scoped admin cannot manage another tenant\'s campaigns', async () => {
        adminTenantId = 't2'; // scoped to t2, body targets t1
        expect((await post('/campaigns', validBody())).status).toBe(403);
        expect(insertRow).toBeNull();
        expect((await post('/campaigns/c1/status', { state: 'paused' })).status).toBe(403);
        expect(updateRow).toBeNull();
    });

    it('a rate edit creates a new version via the edit endpoint', async () => {
        const r = await post('/campaigns/c1', { ...validBody(), value: 7 });
        expect(r.status).toBe(200);
        expect(updateRow).toMatchObject({ value: 7, version: 2 });
        expect(auditLogged[0]?.action).toBe('campaign_edited');
        expect(auditLogged[0]?.meta?.version).toBe(2);
    });
});
