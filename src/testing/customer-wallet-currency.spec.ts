import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
describe('Recorded customer wallet currency',()=>{
 it('uses stored currencies and owner-isolated reads without invented balances',()=>{
  const out=execFileSync(process.execPath,[path.resolve('scripts/check-customer-wallet-currency-runtime.mjs')],{encoding:'utf8'});
  expect(out).toContain('CUSTOMER_WALLET_CURRENCY_RUNTIME=25_PASSED');
 });
 it('preserves existing financial writers and removes display-currency fallback',()=>{
  const out=execFileSync(process.execPath,[path.resolve('scripts/check-customer-wallet-currency.cjs')],{encoding:'utf8'});
  expect(out).toContain('CUSTOMER_WALLET_DISPLAY_AND_WRITERS=PASS');
 });
});
