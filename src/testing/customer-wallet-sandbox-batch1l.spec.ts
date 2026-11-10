import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
describe('Batch 1L isolated customer wallet sandbox',()=>{
 it('derives owner and verifies sandbox checkout without financial credit',()=>{
  const out=execFileSync(process.execPath,[resolve('scripts/check-customer-wallet-sandbox-batch1l-runtime.mjs')],{encoding:'utf8',timeout:30000});
  expect(out).toContain('BATCH1L_SANDBOX_SERVICE_AND_ROUTE_RUNTIME=24_PASSED');
 });
});
