// Source and supplied-evidence checks ONLY, not PostgreSQL proof.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const sql=read('supabase/migrations/20261247000000_wallet_authorization_batch1d.sql');
assert.ok(!/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i.test(sql),'migration must not replace financial function bodies');
assert.ok(!/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(?:wallets|wallet_transactions|driver_earnings)\b/i.test(sql),'no financial DML');
for(const marker of ['TRUNCATE,REFERENCES,TRIGGER','has_column_privilege','AS RESTRICTIVE','_b1d_rpc_before','_b1d_trigger_before','remaining inherited RPC EXECUTE','public.approve_errand_over_budget(uuid)','wallet_collection_enabled'])assert.ok(sql.includes(marker),marker);
const hashes={
 '20261244000000_wallet_metadata_batch1a.sql':'d5ac0f133b5104516c0106da3fe1dd50e2536564c95649b305989d6d9ee2cdfc',
 '20261245000000_wallet_accounting_foundation_batch1b.sql':'e0a29c0288043b007d53dd94be1f501084e3da2c6ae9c57fdfba5b4f1e8cb56c',
 '20261246000000_wallet_topups_batch1c.sql':'29e6803de08b574691011f8c8c90c3aaa5d6de58bc0f171209d4e6d5a47a790d'};
for(const [file,hash] of Object.entries(hashes))assert.equal(crypto.createHash('sha256').update(read((fs.existsSync(path.join(root,'supabase/migrations',file))?'supabase/migrations/':'dependencies/')+file).replace(/\r\n/g,'\n')).digest('hex'),hash,file);
const observed=JSON.parse(read('docs/WALLET_AUTHORIZATION_BATCH1D_RPC_CONTRACT.json'));assert.equal(observed.length,17);
for(const f of observed)assert.ok(sql.includes("'"+f.signature+"'"),f.signature);
console.log('WALLET_AUTHORIZATION_BATCH1D_SOURCE_AND_BASELINES=PASSED (not runtime proof)');
