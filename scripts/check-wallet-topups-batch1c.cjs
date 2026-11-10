// Supplemental source checks, not runtime or PostgreSQL proof.
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'supabase/migrations/20261246000000_wallet_topups_batch1c.sql'),'utf8');
const ts=fs.readFileSync(path.join(root,'server/services/payments/wallet-topup-orchestration.ts'),'utf8');
for(const marker of ['pg_temp._b1c_assert_index','x.indisunique=y.indisunique','x.indisvalid AND x.indisready','x.indnkeyatts=y.indnkeyatts','x.indclass=y.indclass','pg_get_expr(x.indpred','convalidated','base_expr,collect_expr','_b1c_assert_table','claim_wallet_topup_submission','pg_advisory_xact_lock','wallet_collection_enabled','wallet-topup:','post_wallet_reversal']) assert.ok(sql.includes(marker),marker);
assert.ok(!sql.includes("LIKE '%capabilities <@%'"),'no loose capability matching');
assert.ok(ts.includes("kind: 'pending'"));
assert.ok(!ts.includes("providerReference: ''"));
console.log('WALLET_TOPUPS_BATCH1C_SOURCE_CHECKS=17_PASSED (supplemental only)');
