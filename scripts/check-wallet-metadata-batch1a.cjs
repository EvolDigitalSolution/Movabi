// Batch 1A supplemental SOURCE check (plain Node, no external deps).
// Regex/string assertions only. These do NOT prove nullable columns, index
// runtime semantics, intact readiness guards, or successful execution of
// existing writers — those require the disposable-database harness
// (scripts/check-wallet-metadata-batch1a-db.sql). This file only confirms the
// migration text and that no existing INSERT column list references the new
// columns.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const migration = read('supabase/migrations/20261244000000_wallet_metadata_batch1a.sql');
const contracts = read('server/services/payments/payment-contracts.ts');
const registry = read('server/services/payments/market-payment-registry.ts');

const NEW_COLUMNS = [
  ['tenant_id', 'uuid'],
  ['currency_code', 'text'],
  ['amount_minor', 'bigint'],
  ['balance_purpose', 'text'],
  ['payment_provider', 'text'],
  ['merchant_account_ref', 'text'],
  ['provider_reference', 'text'],
  ['event_key', 'text'],
];

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
}

for (const [name, type] of NEW_COLUMNS) {
  ok(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${name}\\s+${type}\\b`, 'm').test(migration),
     `source: migration contains ADD COLUMN ${name} ${type}`);
}

ok(/CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_event_key_uniq[\s\S]*?WHERE event_key IS NOT NULL/.test(migration),
   'source: migration contains the partial unique index statement');

ok((migration.match(/RAISE EXCEPTION/g) || []).length >= 2,
   'source: migration contains precondition RAISE EXCEPTION statements');

// Source check: no existing INSERT column list references the new columns.
const dir = path.join(root, 'supabase', 'migrations');
const referenced = new Set();
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const re = /INSERT INTO (?:public\.)?wallet_transactions\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(src))) {
    for (const col of m[1].split(',').map((s) => s.trim().split(/\s+/)[0])) {
      if (col && col !== '%I') referenced.add(col);
    }
  }
}
for (const [name] of NEW_COLUMNS) {
  ok(!referenced.has(name), `source: no INSERT column list references ${name}`);
}

ok(/PAYMENT_PROVIDER_NOT_READY/.test(registry) && /kora/.test(registry) && /fincra/.test(registry),
   'source: registry still contains Kora/Fincra readiness strings (functional integrity is a DB-test concern)');

ok(!/'collect'/.test(contracts), "source: no 'collect' capability literal added");

console.log(`WALLET_METADATA_BATCH1A_SOURCE_CHECKS=${passed}_PASSED (supplemental; not runtime proof)`);
