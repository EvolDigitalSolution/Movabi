import { it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
it('Batch 1D changes authorization without replacing financial RPC bodies',()=>{
 const sql=readFileSync('supabase/migrations/20261247000000_wallet_authorization_batch1d.sql','utf8');
 expect(sql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
 expect(sql).toContain('TRUNCATE,REFERENCES,TRIGGER');
 expect(sql).toContain('has_column_privilege');
 expect(sql).toContain('AS RESTRICTIVE');
 expect(sql).toContain('public.approve_errand_over_budget(uuid)');
});
