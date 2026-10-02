/**
 * PATCH 1A — quote/booking schema LINEAGE convergence (source/contract tests).
 *
 * IMPORTANT LIMITATION: these are SOURCE-STRING and CONTRACT assertions. They prove
 * that the repository now DECLARES the schema it depends on, and that the declaration
 * is additive and type-faithful. They do NOT prove runtime PostgreSQL behaviour —
 * that requires applying the migration to a real database and running SQL-level tests,
 * which is deliberately out of scope for this session.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const LINEAGE = 'supabase/migrations/20261230500000_quote_booking_lineage_reconcile.sql';
const RECONCILE = 'supabase_incremental_schema_reconcile.sql';
const OLD_INTENT = 'server/gb-app-store-launch-pricing-migration.txt';

const lineage = read(LINEAGE);

describe('Patch 1A — quote/booking lineage convergence', () => {
  it('declares jobs.quote_id idempotently as UUID (the proven live type)', () => {
    expect(lineage).toContain('ALTER TABLE public.jobs');
    expect(lineage).toContain('ADD COLUMN IF NOT EXISTS quote_id UUID');
    // Never a type-changing or destructive form.
    expect(lineage).not.toMatch(/ALTER\s+COLUMN\s+quote_id\s+TYPE/i);
    expect(lineage).not.toMatch(/DROP\s+COLUMN/i);
  });

  it('declares the partial unique quote-reference index idempotently', () => {
    expect(lineage).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_quote_reference');
    expect(lineage).toContain('ON public.jobs(quote_id)');
    expect(lineage).toContain('WHERE quote_id IS NOT NULL');
  });

  it('declares the three quote provenance columns as TEXT (proven live shape)', () => {
    for (const column of ['country_code', 'market_city', 'zone_id']) {
      expect(lineage, column).toContain(`ADD COLUMN IF NOT EXISTS ${column} TEXT`);
    }
  });

  it('introduces NO type-changing migration for the live TEXT provenance columns', () => {
    // The older intended varchar/uuid shapes must NOT be silently re-imposed.
    expect(lineage).not.toMatch(/country_code\s+varchar/i);
    expect(lineage).not.toMatch(/market_city\s+varchar/i);
    expect(lineage).not.toMatch(/zone_id\s+uuid/i);
    expect(lineage).not.toMatch(/ALTER\s+COLUMN\s+\w+\s+TYPE/i);
    expect(lineage).not.toMatch(/USING\s+\w+::/);
    // and the intent must be documented, not implicit
    expect(lineage).toMatch(/DELIBERATELY DOES NOT/i);
    expect(lineage).toMatch(/No type-changing migration/i);
  });

  it('the divergence from the older intended DDL is real and acknowledged', () => {
    // Evidence that the older artifact genuinely proposed different types, so the
    // "do not correct" rule is guarding a real divergence rather than a phantom.
    const intended = read(OLD_INTENT);
    expect(intended).toMatch(/country_code\s+varchar|market_city\s+varchar|zone_id\s+uuid/);
  });

  it('is additive only — no destructive or authority-changing statements', () => {
    for (const forbidden of [
      'DROP TABLE', 'DROP POLICY', 'DROP INDEX', 'DROP CONSTRAINT',
      'GRANT ', 'REVOKE ', 'ENABLE ROW LEVEL SECURITY', 'CREATE POLICY',
      'CREATE TRIGGER', 'DISABLE TRIGGER', 'DELETE FROM', 'UPDATE public.'
    ]) {
      expect(lineage.toUpperCase(), forbidden).not.toContain(forbidden.toUpperCase());
    }
  });

  it('states that creating the file is not permission to execute against production', () => {
    expect(lineage).toMatch(/NOT permission to execute/i);
    expect(lineage).toMatch(/ALREADY LIVE in production|already live/i);
  });

  it('does not fabricate the untracked pricing/quote table', () => {
    expect(lineage).not.toMatch(/CREATE TABLE[^;]*quote_market_adjustments/i);
    expect(lineage).not.toMatch(/ADD COLUMN IF NOT EXISTS quote_reference/i);
    expect(lineage).not.toMatch(/ADD COLUMN IF NOT EXISTS returned_customer_fare/i);
    // the omission must be explicitly documented instead
    expect(lineage).toMatch(/UNTRACKED/);
    expect(lineage).toMatch(/accept_original_fare remains blocked/i);
  });

  it('migration ordering is correct relative to the duration fix', () => {
    expect(LINEAGE > 'supabase/migrations/20261230000000_hybrid_opportunity_duration_fix.sql').toBe(true);
  });

  it('the proven duration/identity hardening is not disturbed by lineage work', () => {
    const fix = read('supabase/migrations/20261230000000_hybrid_opportunity_duration_fix.sql');
    expect(fix).toContain("BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\\.[0-9]+)?$'");
    expect(fix).toContain("RAISE EXCEPTION 'You can only fetch your own opportunities';");
    // and the reconcile still carries both
    const reconcile = read(RECONCILE);
    expect(reconcile).toContain("RAISE EXCEPTION 'You can only fetch your own opportunities';");
    expect(reconcile).toContain("BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\\.[0-9]+)?$'");
  });
});
