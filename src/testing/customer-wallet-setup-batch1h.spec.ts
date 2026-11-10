import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
describe('Batch 1H multi-region zero-wallet setup',()=>{
 it('uses verified owner and configured currencies through the actual API route',()=>{
  const out=execFileSync(process.execPath,[path.resolve('scripts/check-customer-wallet-setup-batch1h-runtime.mjs')],{encoding:'utf8'});
  expect(out).toContain('BATCH1H_SERVER_AND_ROUTE_RUNTIME=20_PASSED');
 });
 it('uses the authenticated, empty-body setup fallback without changing money',()=>{
  const out=execFileSync(process.execPath,[path.resolve('scripts/check-customer-wallet-currency-runtime.mjs')],{encoding:'utf8'});
  expect(out).toContain('BATCH1H_CLIENT_WALLET_RUNTIME=33_PASSED');
 });
});
