import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
describe('Batch 1F production cash-credit service and authenticated route',()=>{
 it('runs 37 behavioral cases without provider calls',()=>{
  const output=execFileSync(process.execPath,[path.resolve('scripts/check-driver-cash-credit-batch1f-runtime.mjs')],{encoding:'utf8'});
  expect(output).toContain('BATCH1F_ALL_BEHAVIORAL_RUNTIME=37_PASSED');
 });
});
