import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// Guard for 20261266000000_driver_cash_credit_market_pilot: the committed migration and rollback
// are exactly what the generator derives from the DEPLOYED function text, and each replaced
// function differs from the deployed one only in the global pilot check.
const require = createRequire(import.meta.url);
const gen = require('../../scripts/generate-cash-credit-market-pilot.cjs');
const read = (p: string) => readFileSync(resolve(p), 'utf8').replace(/\r\n/g, '\n');
const lines = (s: string) => s.split('\n');
function changedLines(before: string, after: string) {
  const a = lines(before), b = lines(after);
  return { removed: a.filter(l => !b.includes(l)), added: b.filter(l => !a.includes(l)) };
}

describe('market-scoped cash-ride pilot migration', () => {
  it('committed files equal the generator output', () => {
    expect(read('supabase/migrations/' + gen.NAME + '.sql')).toBe(gen.up);
    expect(read('deploy/vaydu-cash-ride-market-pilot/' + gen.NAME + '.down.sql')).toBe(gen.down);
  });
  it('the status RPC changes only pilotEnabled, now per the driver market', () => {
    const d = changedLines(gen.deployedBodies.status, gen.newBodies.status);
    expect(d.removed).toHaveLength(1); expect(d.added).toHaveLength(1);
    expect(d.removed[0]).toContain('public.driver_cash_credit_enabled_v1e()');
    expect(d.added[0]).toContain('public.driver_cash_credit_market_enabled_v1e(v_country,v_currency)');
  });
  it('the jobs trigger only enforces cash credit in an enabled market', () => {
    const d = changedLines(gen.deployedBodies.trigger, gen.newBodies.trigger);
    expect(d.removed).toEqual([" IF NOT public.driver_cash_credit_enabled_v1e() OR NEW.payment_method IS DISTINCT FROM 'cash' THEN RETURN NEW; END IF;"]);
    expect(d.added).toEqual([" IF NEW.payment_method IS DISTINCT FROM 'cash' OR NOT public.driver_cash_credit_market_enabled_v1e(NEW.country_code,NEW.currency_code) THEN RETURN NEW; END IF;"]);
  });
  it('reserve checks the JOB market right after locking the job; nothing else changes', () => {
    const d = changedLines(gen.deployedBodies.reserve, gen.newBodies.reserve);
    expect(d.removed).toEqual([" IF NOT public.driver_cash_credit_enabled_v1e() THEN RAISE EXCEPTION 'Cash credit pilot disabled' USING ERRCODE='CE001'; END IF;"]);
    expect(d.added).toEqual([" IF NOT public.driver_cash_credit_market_enabled_v1e(j.country_code,j.currency_code) THEN RAISE EXCEPTION 'Cash credit pilot disabled for this market' USING ERRCODE='CE001'; END IF;"]);
    const body = lines(gen.newBodies.reserve);
    expect(body.findIndex((l: string) => l.includes('driver_cash_credit_market_enabled_v1e'))).toBe(body.findIndex((l: string) => l.includes('SELECT * INTO STRICT j FROM public.jobs')) + 1);
  });
  it('enables no market, keeps the global kill switch, and mirrors the switch privileges', () => {
    expect(gen.up).not.toMatch(/INSERT INTO public\.driver_cash_credit_(markets|config)_v1e/);
    expect(gen.up).not.toMatch(/UPDATE public\.driver_cash_credit_(markets|config)_v1e/);
    expect(gen.up).toContain('SELECT public.driver_cash_credit_enabled_v1e()');
    expect(gen.up).toContain('upper(a.supported_currency)=upper(p_currency)');
    expect(gen.up).toMatch(/REVOKE ALL ON TABLE public\.driver_cash_credit_markets_v1e FROM service_role/);
    expect(gen.up).toMatch(/REVOKE ALL ON FUNCTION public\.driver_cash_credit_market_enabled_v1e\(text, text\) FROM authenticated/);
  });
  it('the rollback restores the three deployed bodies verbatim', () => {
    for (const body of Object.values(gen.deployedBodies) as string[]) expect(gen.down).toContain(body.replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION'));
    expect(gen.down).toContain('DROP TABLE public.driver_cash_credit_markets_v1e;');
  });
});
