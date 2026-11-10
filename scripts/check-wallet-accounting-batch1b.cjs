// Batch 1B supplemental SOURCE check (plain Node). Regex/string assertions only;
// they do NOT prove runtime behaviour — that requires the disposable-database
// runner + concurrency script.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261245000000_wallet_accounting_foundation_batch1b.sql'),
  'utf8',
);

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
}

// Tables + isolation.
ok(/CREATE TABLE IF NOT EXISTS public\.wallet_accounts/.test(migration), 'wallet_accounts');
ok(/CREATE TABLE IF NOT EXISTS public\.wallet_business_events/.test(migration), 'wallet_business_events');
ok(/CREATE TABLE IF NOT EXISTS public\.wallet_movements/.test(migration), 'wallet_movements');
ok(/UNIQUE NULLS NOT DISTINCT \(tenant_id, owner_id, currency_code, balance_purpose\)/.test(migration), 'account scope unique');

// Signed, balanced movements.
ok(/amount_minor bigint NOT NULL CHECK \(amount_minor <> 0\)/.test(migration), 'signed non-zero legs');
ok(/unbalanced event/.test(migration), 'balance check');

// Durable identity + replay + reversal.
ok(/event_key text NOT NULL UNIQUE/.test(migration), 'event_key unique');
ok(/reused with different terms/.test(migration), 'replay-term validation');
ok(/unique_violation/.test(migration), 'concurrent duplicate handling');
ok(/p_reverses_event_id uuid DEFAULT NULL/.test(migration), 'reversal link parameter');
ok(/reverses_event_id uuid REFERENCES public\.wallet_business_events\(id\)/.test(migration), 'original-event relationship');
ok(/CREATE OR REPLACE FUNCTION public\.post_wallet_reversal/.test(migration), 'controlled reversal function');

// Corrected signature.
ok(/p_entries jsonb,\n  p_payment_provider text DEFAULT NULL/.test(migration), 'p_entries precedes defaulted params');

// Overload resolved by exact type signature (not a bare type list).
ok(/to_regprocedure\('public\.post_wallet_event\(text,text,uuid,uuid,text,jsonb,text,text,text,uuid\)'\)/.test(migration),
   'overload resolved via to_regprocedure type signature');
ok(/pg_get_function_result/.test(migration), 'return type validated separately');

// Distinct SQLSTATE identifiers.
for (const c of ['BP001', 'BP002', 'BP003', 'BP004', 'BP005', 'BP006']) {
  ok(new RegExp(`ERRCODE = '${c}'`).test(migration), `SQLSTATE ${c}`);
}

// Canonical currency authority (no arbitrary 3-letter fallback) + exponent helper.
ok(/market_availability WHERE upper\(supported_currency\) = p_currency_code/.test(migration),
   'currency validated against market_availability');
ok(/wallet_currency_minor_exponent/.test(migration), 'currency exponent helper');
ok(/v_sum numeric/.test(migration), 'numeric accumulation (no overflow)');

// Reversible bigint boundary (reject INT64_MIN).
ok(/reversible bigint range/.test(migration), 'reversible bigint range enforced');

// Post-canonicalization range validation (merged totals).
ok(/merged amountMinor out of reversible bigint range/.test(migration), 'post-canonicalization range validation');

// Server-side leg canonicalization + deterministic locking.
ok(/merge duplicate account purposes|GROUP BY e\.value->>'accountPurpose'/.test(migration), 'server-side leg canonicalization');
ok(/FOR UPDATE/.test(migration), 'deterministic account locking');

// Financial-history protection.
ok(/wallet_ledger_append_only/.test(migration), 'append-only guard');
ok(/ON DELETE RESTRICT/.test(migration), 'no DELETE CASCADE');
ok(/REVOKE ALL ON public\.wallet_accounts, public\.wallet_business_events, public\.wallet_movements FROM PUBLIC, anon, authenticated, service_role/.test(migration),
   'direct writes revoked from every role');
ok(/SET search_path = pg_catalog, public/.test(migration), 'pinned search_path');

// Server-only diagnostic view.
ok(/wallet_reconciliation_projection/.test(migration), 'reconciliation projection');
ok(/REVOKE ALL ON public\.wallet_reconciliation_projection FROM PUBLIC, anon, authenticated/.test(migration), 'projection server-only');

// Safe rerun: policies idempotent, conflicts distinguished.
ok(/DROP POLICY IF EXISTS/.test(migration), 'policies idempotent (DROP IF EXISTS)');
ok(/GET STACKED DIAGNOSTICS/.test(migration), 'conflict source distinguished via stacked diagnostics');

// Provider-neutral.
ok(/payment_provider IN \('stripe','kora','fincra'\)/.test(migration), 'provider set');
ok(/internal event must not carry merchant\/provider identity/.test(migration), 'explicit internal-event semantics');

console.log(`WALLET_ACCOUNTING_BATCH1B_SOURCE_CHECKS=${passed}_PASSED (supplemental; not runtime proof)`);
