import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

// Mock the module imports of driver-payment-account-develop.routes so the test
// exercises only the VAYDU_PAYMENT_ACCOUNT_SETUP branch and the runtime.cjs
// credential guard (which is loaded for real via require()).
vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: { supabaseUrl: 'https://movabi-supabase-develop.apps.evolsolution.com' }
}));
vi.mock('../../server/routes/driver-payment-account.routes', () => ({
    default: {},
    driverPaymentAccountRouter: () => {}
}));
vi.mock('../../server/services/driver-payment-account.service', () => ({
    DriverPaymentAccountService: class {},
    sandboxDestinationProvider: {}
}));
vi.mock('../../server/services/driver-collection-account.service', () => ({
    DriverCollectionAccountService: class {},
    SETUP_ONLY_COLLECTION_STORE: {}
}));
vi.mock('../../server/services/payments/flutterwave-collection-develop', () => ({
    confirmedDevelopCollectionScope: {},
    developCollectionProvider: () => () => {}
}));
vi.mock('../../server/payment-account-closure/router', () => ({
    driverPaymentAccountRouter: () => {}
}));
vi.mock('../../server/payment-account-closure/service', () => ({
    SetupService: class {}
}));

import { developDriverPaymentAccountRouter } from '../../server/routes/driver-payment-account-develop.routes';
import { supabaseAdmin } from '../../server/services/supabase.service';

const tempDirs: string[] = [];

describe('payment-account-setup startup isolation', () => {
    afterEach(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } tempDirs.length = 0; });

    it('an invalid binding yields a controlled 503 instead of crashing the API', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'vaydu-binding-'));
        tempDirs.push(dir);
        const secretFile = join(dir, 'binding.env');
        // A live key is present -> runtime.cjs must reject (test_only_binding_required
        // on POSIX, private_binding_permissions_required on Windows). Either way the
        // guard throws and must be contained.
        writeFileSync(secretFile, 'FLUTTERWAVE_LIVE_SECRET_KEY=live_secret_should_be_rejected\n');
        try { chmodSync(secretFile, 0o600); } catch {}

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            VAYDU_PAYMENT_ACCOUNT_SETUP: 'true',
            VAYDU_DEPLOYMENT_ENV: 'develop',
            VAYDU_PAYMENT_ACCOUNT_SECRET_FILE: secretFile
        };

        let router: express.Router;
        expect(() => { router = developDriverPaymentAccountRouter(supabaseAdmin, env); }).not.toThrow();

        const app = express();
        app.use(router as any);
        const res = await new Promise<{ status: number; body: any }>((resolve) => {
            const srv = app.listen(0, () => {
                const port = (srv.address() as any).port;
                fetch(`http://localhost:${port}/anything`).then(async (r) => {
                    srv.close();
                    resolve({ status: r.status, body: await r.json().catch(() => ({})) });
                });
            });
        });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('PAYMENT_ACCOUNT_SETUP_UNAVAILABLE');
        expect(res.body.error).toContain('temporarily unavailable');
    });

    it('unrelated routes are not affected by the unavailable integration', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'vaydu-binding-'));
        tempDirs.push(dir);
        const secretFile = join(dir, 'binding.env');
        writeFileSync(secretFile, 'FLUTTERWAVE_TEST_SECRET_KEY=not_a_test_key\n');
        try { chmodSync(secretFile, 0o600); } catch {}

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            VAYDU_PAYMENT_ACCOUNT_SETUP: 'true',
            VAYDU_DEPLOYMENT_ENV: 'develop',
            VAYDU_PAYMENT_ACCOUNT_SECRET_FILE: secretFile
        };
        const router = developDriverPaymentAccountRouter(supabaseAdmin, env) as any;

        const app = express();
        app.get('/health', (_req, res) => res.json({ ok: true }));
        app.use('/api/driver-payment-account', router);

        const health = await new Promise<number>((resolve) => {
            const srv = app.listen(0, () => {
                const port = (srv.address() as any).port;
                fetch(`http://localhost:${port}/health`).then(async (r) => { srv.close(); resolve(r.status); });
            });
        });
        expect(health).toBe(200);
    });
});
