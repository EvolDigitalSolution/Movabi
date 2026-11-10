import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Batch 1B — supplemental SOURCE check (Vitest form). Regex/string assertions
 * only; runtime behaviour requires the disposable-database runner + concurrency
 * script (scripts/run-wallet-accounting-batch1b-db.sh).
 */
const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261245000000_wallet_accounting_foundation_batch1b.sql'),
  'utf8',
);

describe('Batch 1B accounting migration (source contract)', () => {
  it('isolates accounts by tenant, owner, currency, and purpose', () => {
    expect(migration).toMatch(/UNIQUE NULLS NOT DISTINCT \(tenant_id, owner_id, currency_code, balance_purpose\)/);
  });

  it('records signed, balanced, append-only movements', () => {
    expect(migration).toMatch(/amount_minor bigint NOT NULL CHECK \(amount_minor <> 0\)/);
    expect(migration).toMatch(/unbalanced event/);
    expect(migration).toMatch(/wallet_ledger_append_only/);
  });

  it('validates currency against the canonical market_availability authority', () => {
    expect(migration).toMatch(/market_availability WHERE upper\(supported_currency\) = p_currency_code/);
    expect(migration).toMatch(/wallet_currency_minor_exponent/);
  });

  it('enforces a reversible bigint range', () => {
    expect(migration).toMatch(/reversible bigint range/);
  });

  it('canonicalizes legs server-side and locks accounts deterministically', () => {
    expect(migration).toMatch(/GROUP BY e\.value->>'accountPurpose'/);
    expect(migration).toMatch(/FOR UPDATE/);
  });

  it('distinguishes event-key vs reversal-uniqueness conflicts', () => {
    expect(migration).toMatch(/GET STACKED DIAGNOSTICS/);
    expect(migration).toMatch(/wallet_business_events_reversal_unique/);
  });

  it('provides controlled, idempotent reversals', () => {
    expect(migration).toMatch(/post_wallet_reversal/);
    expect(migration).toMatch(/reverses_event_id/);
  });

  it('uses distinct SQLSTATE identifiers and idempotent policies', () => {
    for (const code of ['BP001', 'BP002', 'BP003', 'BP004', 'BP005', 'BP006']) {
      expect(migration).toMatch(new RegExp(`ERRCODE = '${code}'`));
    }
    expect(migration).toMatch(/DROP POLICY IF EXISTS/);
  });

  it('keeps the projection server-only and revokes direct writes from every role', () => {
    expect(migration).toMatch(/REVOKE ALL ON public\.wallet_reconciliation_projection FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/REVOKE ALL ON public\.wallet_accounts, public\.wallet_business_events, public\.wallet_movements FROM PUBLIC, anon, authenticated, service_role/);
  });

  it('is provider-neutral with explicit internal-event semantics', () => {
    expect(migration).toMatch(/payment_provider IN \('stripe','kora','fincra'\)/);
    expect(migration).toMatch(/internal event must not carry merchant\/provider identity/);
  });
});
