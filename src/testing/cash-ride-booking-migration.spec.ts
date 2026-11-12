import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// Guard for 20261266100000_cash_ride_booking_fee_hold: committed files equal the generator output
// from the DEPLOYED baseline; the acquisition trigger gains exactly one condition; the payment
// status check gains exactly the two cash states.
const require = createRequire(import.meta.url);
const gen = require('../../scripts/generate-cash-ride-booking-migration.cjs');
const read = (p: string) => readFileSync(resolve(p), 'utf8').replace(/\r\n/g, '\n');

describe('cash-ride booking migration (phase 1)', () => {
  it('committed files equal the generator output', () => {
    expect(read('supabase/migrations/' + gen.NAME + '.sql')).toBe(gen.up);
    expect(read('deploy/vaydu-cash-ride-market-pilot/' + gen.NAME + '.down.sql')).toBe(gen.down);
  });
  it('the acquisition trigger only gains the cash-ride exception', () => {
    const a = gen.deployedBodies.eligibility.split('\n'), b = gen.newBodies.eligibility.split('\n');
    expect(b.filter((l: string) => !a.includes(l))).toEqual(['        ) AND NOT public.cash_ride_acquirable_v1e(NEW) THEN']);
    expect(a.filter((l: string) => !b.includes(l))).toEqual(['        ) THEN']);
  });
  it('the payment status check gains exactly cash_due and cash_collected', () => {
    expect(gen.newCheck).toBe(gen.oldCheck.replace("'requires_review'::text]", "'requires_review'::text, 'cash_due'::text, 'cash_collected'::text]"));
  });
  it('the cash exception is strictly boolean and requires market, Ride, custody, no PaymentIntent and an authorised hold', () => {
    const fn = gen.up.slice(gen.up.indexOf('CREATE FUNCTION public.cash_ride_acquirable_v1e'), gen.up.indexOf('REVOKE ALL ON FUNCTION public.cash_ride_acquirable_v1e'));
    expect(fn).toMatch(/SELECT coalesce\(\(/); expect(fn).toMatch(/\), false\) \$\$;/);
    for (const part of ["j.payment_method = 'cash'", "j.payment_status = 'cash_due'", 'j.payment_intent_id IS NULL',
      "j.metadata->>'cash_collection_mode' = 'full_customer_charge'", "s.slug = 'ride'",
      'public.driver_cash_credit_market_enabled_v1e(j.country_code, j.currency_code)', "h.status = 'authorized'",
      'h.customer_id = j.customer_id', 'h.tenant_id = j.tenant_id', 'h.currency_code = j.currency_code']) expect(fn).toContain(part);
  });
  it('enables no market and grants nothing to anon/authenticated', () => {
    expect(gen.up).not.toMatch(/INSERT INTO public\.driver_cash_credit_(markets|config)_v1e/);
    expect(gen.up).toMatch(/REVOKE ALL ON TABLE public\.cash_ride_fee_holds_v1e FROM authenticated/);
    expect(gen.up).toMatch(/REVOKE ALL ON FUNCTION public\.cash_ride_acquirable_v1e\(public\.jobs\) FROM authenticated/);
  });
  it('the rollback restores the deployed trigger body and the original status check', () => {
    expect(gen.down).toContain(gen.deployedBodies.eligibility.replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION'));
    expect(gen.down).toContain('ADD CONSTRAINT jobs_payment_status_check ' + gen.oldCheck + ';');
  });
});
