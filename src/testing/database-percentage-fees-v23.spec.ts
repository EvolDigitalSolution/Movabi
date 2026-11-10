import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
it('actual quote finalization preserves database percentage fees across currencies and GBP protection',()=>{
 const output=execFileSync(process.execPath,['--experimental-vm-modules',resolve('scripts/check-database-percentage-fees-v23.cjs')],{encoding:'utf8'});
 expect(output).toContain('DATABASE_PERCENTAGE_ACTUAL_QUOTE_CASES=13_PASSED');
});
