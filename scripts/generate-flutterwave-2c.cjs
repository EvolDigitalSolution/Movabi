// Generate Batch 2C + rollback function bodies VERBATIM from the applied
// Batch 1B/1C migrations, applying ONLY the provider-whitelist change.
// This guarantees byte-exact restoration on rollback (no handwritten drift).
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function extractFn(sql, fnSignatureStart) {
  const start = sql.indexOf(fnSignatureStart);
  if (start < 0) throw new Error('signature not found: ' + fnSignatureStart);
  const asIdx = sql.indexOf('AS $$', start);
  const close = sql.indexOf('\n$$;', asIdx);
  if (asIdx < 0 || close < 0) throw new Error('dollar-quote not found for ' + fnSignatureStart);
  return { header: sql.slice(start, asIdx + 'AS $$'.length), body: sql.slice(asIdx + 'AS $$'.length, close), close: '\n$$;' };
}

const b1b = fs.readFileSync(path.join(root, 'supabase/migrations/20261245000000_wallet_accounting_foundation_batch1b.sql'), 'utf8');
const b1c = fs.readFileSync(path.join(root, 'supabase/migrations/20261246000000_wallet_topups_batch1c.sql'), 'utf8');

// post_wallet_event (Batch 1B): widen provider list only.
const pwe = extractFn(b1b, 'CREATE OR REPLACE FUNCTION public.post_wallet_event(');
const pweWidened = pwe.header + pwe.body.replace("NOT IN ('stripe','kora','fincra')", "NOT IN ('stripe','kora','fincra','flutterwave')") + pwe.close;

// initiate_wallet_topup (Batch 1C): widen provider list only.
const iwt = extractFn(b1c, 'CREATE OR REPLACE FUNCTION public.initiate_wallet_topup(');
const iwtWidened = iwt.header + iwt.body.replace("NOT IN ('stripe','kora')", "NOT IN ('stripe','kora','flutterwave')") + iwt.close;

fs.writeFileSync(path.join(root, 'scripts/.gen-post-wallet-event-widened.sql'), pweWidened + '\n');
fs.writeFileSync(path.join(root, 'scripts/.gen-initiate-wallet-topup-widened.sql'), iwtWidened + '\n');
fs.writeFileSync(path.join(root, 'scripts/.gen-post-wallet-event-original.sql'), pwe.header + pwe.body + pwe.close + '\n');
fs.writeFileSync(path.join(root, 'scripts/.gen-initiate-wallet-topup-original.sql'), iwt.header + iwt.body + iwt.close + '\n');
console.log('generated widened + original function bodies from exact applied migrations');
console.log('post_wallet_event widened bytes:', Buffer.byteLength(pweWidened));
console.log('initiate_wallet_topup widened bytes:', Buffer.byteLength(iwtWidened));
