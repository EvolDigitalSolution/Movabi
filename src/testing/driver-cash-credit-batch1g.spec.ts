import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
describe('Batch 1G owner-isolated cash-credit display',()=>{
 it('passes production reader and service behavior checks',()=>{
  const output=execFileSync(process.execPath,[path.resolve('scripts/check-driver-cash-credit-batch1g-runtime.mjs')],{encoding:'utf8'});
  expect(output).toContain('BATCH1G_ALL_BEHAVIORAL_RUNTIME=35_PASSED');
 });
 it('preserves existing template, styles and payout action',()=>{
  const output=execFileSync(process.execPath,[path.resolve('scripts/check-driver-cash-credit-batch1g.cjs')],{encoding:'utf8'});
  expect(output).toContain('BATCH1G_EXISTING_LAYOUT_AND_ACTIONS=PRESERVED');
 });
});
