import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
it('actual pricing config lookup and final market guard preserve country, currency and legacy UK rates',()=>{
 const output=execFileSync(process.execPath,['--experimental-vm-modules',resolve('scripts/check-market-fare-v23.cjs')],{encoding:'utf8'});
 expect(output).toContain('MARKET_FARE_ACTUAL_LOOKUP_AND_GUARD_CASES=10_PASSED');
});
