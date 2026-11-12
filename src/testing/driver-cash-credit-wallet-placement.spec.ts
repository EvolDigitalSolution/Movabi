import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import path from 'node:path';

// Durable placement invariants for the cash-ride credit card (Batch 1G). Previously this ran
// scripts/check-driver-cash-credit-batch1g.cjs, which compares an exact copy of the Batch 1G card
// markup and a SHA-256 of the WHOLE dashboard and Earnings files as they were at Batch 1G. That was a
// one-off proof that Batch 1G changed nothing else; it cannot pass after any later legitimate change
// (95d745b, the top-up close/reset work, the D9 metrics card). The script is kept as historical evidence
// for its own commit; the requirement it protected is asserted here directly.
const read=(p:string)=>readFileSync(path.resolve(p),'utf8').replace(/\r\n/g,'\n');
const dashboard=read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');
const earnings=read('src/app/apps/mobile/features/driver/earnings/earnings.page.ts');
const walletStart=dashboard.indexOf("} @else if (activeHubTab() === 'wallet') {");
const walletEnd=dashboard.indexOf("} @else if (activeHubTab() === 'profile') {",walletStart);
const card='aria-labelledby="cash-credit-title"';

describe('Cash credit Wallet tab placement',()=>{
 it('the cash-ride credit card exists exactly once, inside the Driver Hub Wallet tab',()=>{
  expect(walletStart).toBeGreaterThan(-1);
  expect(walletEnd).toBeGreaterThan(walletStart);
  expect(dashboard.split(card).length-1).toBe(1);
  const at=dashboard.indexOf(card);
  expect(at).toBeGreaterThan(walletStart);
  expect(at).toBeLessThan(walletEnd);
 });
 it('the Earnings page never shows cash-ride credit (it is not earnings)',()=>{
  expect(earnings).not.toContain('Cash-ride credit');
  expect(earnings).not.toContain('cash-credit-title');
 });
});
