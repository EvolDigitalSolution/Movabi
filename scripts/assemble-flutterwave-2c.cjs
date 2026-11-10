// Assemble 2C migration + rollback using the verbatim generated bodies,
// replacing any earlier handwritten reproductions.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

const pweW = fs.readFileSync(path.join(root, 'scripts/.gen-post-wallet-event-widened.sql'), 'utf8').trimEnd();
const iwtW = fs.readFileSync(path.join(root, 'scripts/.gen-initiate-wallet-topup-widened.sql'), 'utf8').trimEnd();
const pweO = fs.readFileSync(path.join(root, 'scripts/.gen-post-wallet-event-original.sql'), 'utf8').trimEnd();
const iwtO = fs.readFileSync(path.join(root, 'scripts/.gen-initiate-wallet-topup-original.sql'), 'utf8').trimEnd();

function replaceFn(file, fnStart, newBody) {
  let s = fs.readFileSync(file, 'utf8');
  const start = s.indexOf(fnStart);
  if (start < 0) throw new Error('fn not found in ' + file + ': ' + fnStart);
  const close = s.indexOf('\n$$;', start);
  if (close < 0) throw new Error('close not found');
  s = s.slice(0, start) + newBody + s.slice(close + '\n$$;'.length);
  fs.writeFileSync(file, s);
}

replaceFn(path.join(root, 'supabase/migrations/20261254200000_flutterwave_provider_accept_batch2c.sql'),
  'CREATE OR REPLACE FUNCTION public.post_wallet_event(', pweW);
replaceFn(path.join(root, 'supabase/migrations/20261254200000_flutterwave_provider_accept_batch2c.sql'),
  'CREATE OR REPLACE FUNCTION public.initiate_wallet_topup(', iwtW);
replaceFn(path.join(root, 'scripts/rollback-wallet-flutterwave-batch2a.sql'),
  'CREATE OR REPLACE FUNCTION public.post_wallet_event(', pweO);
replaceFn(path.join(root, 'scripts/rollback-wallet-flutterwave-batch2a.sql'),
  'CREATE OR REPLACE FUNCTION public.initiate_wallet_topup(', iwtO);
console.log('2C + rollback function bodies replaced with verbatim generated bodies');
