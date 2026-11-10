import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const state = { blob: null as Buffer | null, lastRpc: null as any };

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        storage: { from: () => ({
            download: async () => state.blob ? { data: { arrayBuffer: async () => state.blob!.buffer.slice(state.blob!.byteOffset, state.blob!.byteOffset + state.blob!.byteLength) }, error: null } : { data: null, error: { message: 'not found' } },
            upload: async () => ({ data: {}, error: null })
        }) },
        rpc: async (_fn: string, args: any) => { state.lastRpc = args; return { data: { id: 'p1', status: 'under_review' }, error: null }; },
        from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }),
        auth: { getUser: async () => ({ data: { user: { id: 'drv-1' } }, error: null }) },
    },
}));
vi.mock('express-rate-limit', () => ({ rateLimit: () => (_r: any, _s: any, n: any) => n() }));

import router from '../../server/routes/driver-onboarding.routes';

function call(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve) => {
        const app = express();
        app.use(express.json());
        app.use(router);
        const srv = app.listen(0, () => {
            const port = (srv.address() as any).port;
            fetch(`http://localhost:${port}/inspection-photo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
                body: JSON.stringify(body)
            }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

const jpeg = async () => {
    const sharp = (await import('sharp')).default;
    return sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toBuffer();
};

describe('POST /inspection-photo', () => {
    beforeEach(async () => { state.blob = await jpeg(); state.lastRpc = null; });

    it('rejects unknown slot', async () => {
        expect((await call({ slot: 'engine', path: 'inspection/drv-1/engine-x.jpg' })).status).toBe(400);
    });

    it('rejects path outside driver prefix (ownership check)', async () => {
        expect((await call({ slot: 'front', path: 'inspection/other/front-x.jpg' })).status).toBe(403);
    });

    it('rejects non-image signature', async () => {
        state.blob = Buffer.from('not an image at all.....................................');
        expect((await call({ slot: 'front', path: 'inspection/drv-1/front-x.jpg' })).status).toBe(422);
    });

    it('records a valid JPEG via submit_inspection_photo', async () => {
        const r = await call({ slot: 'front', path: 'inspection/drv-1/front-x.jpg' });
        expect(r.status).toBe(201);
        expect(state.lastRpc.p_slot).toBe('front');
        expect(state.lastRpc.p_ctype).toBe('image/jpeg');
    });
});
