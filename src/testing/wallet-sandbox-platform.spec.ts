import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
describe('Wallet sandbox localhost and native browser',()=>{
 it('preserves checkout and reconciliation across supported client platforms',()=>{
  const out=execFileSync(process.execPath,[resolve('scripts/check-wallet-sandbox-platform-runtime.mjs')],{encoding:'utf8',timeout:30000});
  expect(out).toContain('WALLET_SANDBOX_PLATFORM_RUNTIME=26_PASSED');
 });
});
