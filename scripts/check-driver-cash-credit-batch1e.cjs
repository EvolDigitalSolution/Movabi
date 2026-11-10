// Supplemental source/baseline checks; the isolated SQL suite establishes behavior.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const sql=read('supabase/migrations/20261248000000_driver_cash_credit_batch1e.sql');
for(const marker of ['eligibleDepositsMinor','driver_cash_credit_reserved','cash_fee_clearing','driver_cash_credit_enrolments_v1e','cash_collection_mode','full_customer_charge','AFTER INSERT OR UPDATE','pg_advisory_xact_lock','_b1e_assert_index','x.indisunique=y.indisunique','_b1e_assert_trigger','has_column_privilege','session_user','CE001','CE002','CE003','CE004','CE005','CE006'])assert.ok(sql.includes(marker),marker);
for(const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_0-9]+)\(/g))assert.ok(m[1].endsWith('_v1e'),'existing RPC must not be replaced: '+m[1]);
assert.ok(!/(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+public\.(?:wallets|wallet_transactions|driver_earnings)\b/i.test(sql),'no legacy financial DML');
const baselines={
'20261244000000_wallet_metadata_batch1a.sql':'d5ac0f133b5104516c0106da3fe1dd50e2536564c95649b305989d6d9ee2cdfc',
'20261245000000_wallet_accounting_foundation_batch1b.sql':'e0a29c0288043b007d53dd94be1f501084e3da2c6ae9c57fdfba5b4f1e8cb56c',
'20261246000000_wallet_topups_batch1c.sql':'29e6803de08b574691011f8c8c90c3aaa5d6de58bc0f171209d4e6d5a47a790d',
'20261247000000_wallet_authorization_batch1d.sql':'79f7bccfd97eadd8f20ebb1f6ec3e1e0609b0ba3077ab3770fb95579b7294cc7'};
for(const [file,hash] of Object.entries(baselines)){
 const p=fs.existsSync(path.join(root,'supabase/migrations',file))?'supabase/migrations/':'dependencies/';
 assert.equal(crypto.createHash('sha256').update(read(p+file).replace(/\r\n/g,'\n')).digest('hex'),hash,file);
}
console.log('BATCH1E_SOURCE_AND_BASELINES=PASSED (supplemental, not runtime proof)');
