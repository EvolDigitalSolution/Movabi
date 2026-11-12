import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {readFileSync} from 'node:fs';
describe('Batch 1G owner-isolated cash-credit display',()=>{
 it('passes production reader and service behavior checks',()=>{
  const output=execFileSync(process.execPath,[path.resolve('scripts/check-driver-cash-credit-batch1g-runtime.mjs')],{encoding:'utf8'});
  expect(output).toContain('BATCH1G_ALL_BEHAVIORAL_RUNTIME=35_PASSED');
 });
 // Durable form of the Batch 1G "existing actions preserved" check. The original script
 // (scripts/check-driver-cash-credit-batch1g.cjs) hashed the whole dashboard/Earnings files as of Batch 1G,
 // which no later change can satisfy; it stays as historical evidence for its own commit. These are the
 // actions the Wallet tab must keep alongside the cash-ride credit card.
 it('keeps the existing Wallet actions (payout settings, earnings history) next to the cash-ride credit card',()=>{
  const dashboard=readFileSync(path.resolve('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts'),'utf8').replace(/\r\n/g,'\n');
  const start=dashboard.indexOf("} @else if (activeHubTab() === 'wallet') {");
  const wallet=dashboard.slice(start,dashboard.indexOf("} @else if (activeHubTab() === 'profile') {",start));
  expect(start).toBeGreaterThan(-1);
  expect(wallet).toContain('(click)="openPayoutSettings()"');
  expect(wallet).toContain("(click)=\"router.navigate(['/driver/earnings'])\"");
  expect(wallet).toContain('aria-labelledby="cash-credit-title"');
  expect(wallet).toContain('(click)="refreshCashCredit()"');
 });
});
