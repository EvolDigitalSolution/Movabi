import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
describe('Batch 1I read-only top-up readiness',()=>{
 it('checks configured currencies, denied capabilities and actual authenticated route',()=>{
  const output=execFileSync(process.execPath,[resolve('scripts/check-wallet-topup-readiness-batch1i-runtime.mjs')],{encoding:'utf8',timeout:30000});
  expect(output).toContain('BATCH1I_READINESS_SERVICE_AND_ROUTE_RUNTIME=33_PASSED');
 });
});
