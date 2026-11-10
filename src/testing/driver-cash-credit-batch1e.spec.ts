import { it,expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
it('keeps verified-credit cash pilot separate from legacy balances and preserves applied baselines',()=>{
 const output=execFileSync(process.execPath,[resolve('scripts/check-driver-cash-credit-batch1e.cjs')],{encoding:'utf8'});
 expect(output).toContain('BATCH1E_SOURCE_AND_BASELINES=PASSED');
});
