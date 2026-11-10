import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Batch 1A — supplemental SOURCE check (Vitest form).
 * Regex/string assertions only; these do NOT prove nullable columns, runtime
 * index semantics, intact guards, or successful writer execution. Those are
 * covered by the disposable-database harness
 * (scripts/check-wallet-metadata-batch1a-db.sql), which must be run separately.
 */
const root = process.cwd();

const migration = readFileSync(
  join(root, 'supabase/migrations/20261244000000_wallet_metadata_batch1a.sql'),
  'utf8',
);
const contracts = readFileSync(join(root, 'server/services/payments/payment-contracts.ts'), 'utf8');
const registry = readFileSync(join(root, 'server/services/payments/market-payment-registry.ts'), 'utf8');

const NEW_COLUMNS: Array<[string, string]> = [
  ['tenant_id', 'uuid'],
  ['currency_code', 'text'],
  ['amount_minor', 'bigint'],
  ['balance_purpose', 'text'],
  ['payment_provider', 'text'],
  ['merchant_account_ref', 'text'],
  ['provider_reference', 'text'],
  ['event_key', 'text'],
];

describe('Batch 1A wallet metadata migration (source contract)', () => {
  it('contains ADD COLUMN statements for the eight metadata columns', () => {
    for (const [name, type] of NEW_COLUMNS) {
      expect(migration).toMatch(
        new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${name}\\s+${type}\\b`, 'm'),
      );
    }
  });

  it('contains the partial event-key uniqueness index statement', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_event_key_uniq[\s\S]*?WHERE event_key IS NOT NULL/,
    );
  });

  it('contains precondition RAISE EXCEPTION statements', () => {
    expect(migration.match(/RAISE EXCEPTION/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('contains no INSERT column list that references the new columns', () => {
    const dir = resolve(root, 'supabase/migrations');
    const referenced = new Set<string>();
    for (const file of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      const re = /INSERT INTO (?:public\.)?wallet_transactions\s*\(([^)]*)\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(src))) {
        for (const col of match[1].split(',').map((s) => s.trim().split(/\s+/)[0])) {
          if (col && col !== '%I') referenced.add(col);
        }
      }
    }
    for (const [name] of NEW_COLUMNS) {
      expect(referenced.has(name)).toBe(false);
    }
  });

  it('still contains Kora/Fincra readiness strings (functional integrity is a DB-test concern)', () => {
    expect(registry).toContain('PAYMENT_PROVIDER_NOT_READY');
    expect(registry).toContain('kora');
    expect(registry).toContain('fincra');
  });

  it('does not add a collect capability in this metadata batch', () => {
    expect(contracts).not.toContain("'collect'");
  });
});
