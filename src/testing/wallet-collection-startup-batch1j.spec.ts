import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
describe('Batch 1J startup Kora transport',()=>{
 it('uses startup secrets, frozen terms and durable submission claims',()=>{
  const out=execFileSync(process.execPath,[resolve('scripts/check-wallet-collection-startup-batch1j-runtime.mjs')],{encoding:'utf8',timeout:30000});
  expect(out).toContain('BATCH1J_STARTUP_AND_KORA_TRANSPORT_RUNTIME=30_PASSED');
 });
});
