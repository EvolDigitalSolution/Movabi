import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// Guard for 20261266200000_cash_ride_activation: generated from the deployed policy; the policy
// gains exactly 'cash_due' in the unassigned-job branch; activation is service-role only.
const require = createRequire(import.meta.url);
const gen = require('../../scripts/generate-cash-ride-activation-migration.cjs');
const read = (p: string) => readFileSync(resolve(p), 'utf8').replace(/\r\n/g, '\n');

describe('cash-ride activation migration (phase 2)', () => {
  it('committed files equal the generator output', () => {
    expect(read('supabase/migrations/' + gen.NAME + '.sql')).toBe(gen.up);
    expect(read('deploy/vaydu-cash-ride-market-pilot/' + gen.NAME + '.down.sql')).toBe(gen.down);
  });
  it('the driver read policy only gains cash_due for unassigned jobs', () => {
    expect(gen.newPolicy).toBe(gen.policy.replace(
      "(payment_status = ANY (ARRAY['pending'::text, 'authorized'::text, 'wallet_funded'::text, 'paid'::text]))",
      "(payment_status = ANY (ARRAY['pending'::text, 'authorized'::text, 'wallet_funded'::text, 'paid'::text, 'cash_due'::text]))"));
    expect(gen.down).toContain(gen.policy);
  });
  it('activation re-proves the cash ride and the exact hold under lock, then starts the search', () => {
    const fn = gen.up.slice(gen.up.indexOf('CREATE FUNCTION public.activate_cash_ride_v1e'), gen.up.indexOf('REVOKE ALL ON FUNCTION public.activate_cash_ride_v1e'));
    for (const part of ['FOR UPDATE', "j.payment_method IS DISTINCT FROM 'cash'", "j.payment_status IS DISTINCT FROM 'cash_due'", 'j.payment_intent_id IS NOT NULL',
      "interval '5 minutes'", "s.slug = 'ride'", 'driver_cash_credit_market_enabled_v1e', "h.status IS DISTINCT FROM 'created'",
      'h.provider_payment_reference IS DISTINCT FROM p_provider_payment_reference', 'h.amount_minor IS DISTINCT FROM p_amount_minor',
      "SET status = 'authorized'", "SET status = 'searching'"]) expect(fn).toContain(part);
    expect(gen.up).toMatch(/REVOKE ALL ON FUNCTION public\.activate_cash_ride_v1e\(uuid, uuid, text, text, bigint, text\) FROM authenticated/);
  });
});
