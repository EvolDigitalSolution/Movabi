import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Guards 20261269000000: the committed migration and rollback must be exactly what the generator
// produces from the current sources (so a later edit to either chain's function bodies fails here and
// must be re-merged). Behaviour is proven on real PostgreSQL: bash scripts/migration-merge/verify-merge.sh
const require = createRequire(import.meta.url);
const gen = require('../../scripts/migration-merge/generate-cash-roadmap-merge.cjs');
const read = (p: string) => readFileSync(resolve(p), 'utf8').replace(/\r\n/g, '\n');

describe('cash-pilot / roadmap merge migration', () => {
    it('the committed migration and rollback equal the generator output', () => {
        expect(read(`supabase/migrations/${gen.NAME}.sql`)).toBe(gen.up);
        expect(read(`scripts/migration-merge/${gen.NAME}.down.sql`)).toBe(gen.down);
    });
    it('installs exactly one merged body per shared function and enables nothing', () => {
        for (const fn of ['enforce_job_payment_eligibility', 'enforce_ride_cash_credit_v1e', 'reserve_cash_job_credit_v1e', 'driver_cash_credit_status_v1f']) {
            expect(gen.up.split(`CREATE OR REPLACE FUNCTION public.${fn}(`).length - 1, fn).toBe(1);
        }
        expect(gen.up).toContain('courier_enabled boolean NOT NULL DEFAULT false');
        expect(gen.up).not.toMatch(/INSERT INTO public\.driver_cash_credit_markets_v1e|UPDATE public\.driver_cash_credit_markets_v1e|driver_cash_credit_config_v1e/);
        // The restored disabled-acquisition gate and the cash-ride plan rule are both present.
        expect(gen.up).toContain("RAISE EXCEPTION 'Cash is not enabled for this service in this market' USING ERRCODE='CE001'");
        expect(gen.up).toContain('public.cash_ride_acquirable_v1e(j)');
        // The global switch is never consulted on its own any more (market-scoped).
        expect(gen.up).not.toContain('IF NOT public.driver_cash_credit_enabled_v1e()');
    });
});
