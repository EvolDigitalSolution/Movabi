import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
describe('Batch 1M sandbox wallet UI and return',()=>{
 it('keeps exact currency, owner isolation, safe return and no balance credit',()=>{
  const out=execFileSync(process.execPath,[resolve('scripts/check-wallet-sandbox-ui-batch1m-runtime.mjs')],{encoding:'utf8',timeout:30000});
  expect(out).toContain('BATCH1M_WALLET_SANDBOX_UI_RUNTIME=24_PASSED');
 });
 it('checks own server eligibility and actual authenticated route',()=>{
  const out=execFileSync(process.execPath,[resolve('scripts/check-wallet-sandbox-eligibility-batch1m-runtime.mjs')],{encoding:'utf8',timeout:30000});
  expect(out).toContain('BATCH1M_ELIGIBILITY_SERVICE_AND_ROUTE_RUNTIME=11_PASSED');
 });
});
