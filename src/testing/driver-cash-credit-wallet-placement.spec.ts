import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
describe('Cash credit Wallet tab placement',()=>{
 it('is contained by Wallet and preserves original dashboard and Earnings layout',()=>{
  const output=execFileSync(process.execPath,[path.resolve('scripts/check-driver-cash-credit-batch1g.cjs')],{encoding:'utf8'});
  expect(output).toContain('CASH_CREDIT_PLACEMENT=WALLET_TAB_ONLY');
 });
});
