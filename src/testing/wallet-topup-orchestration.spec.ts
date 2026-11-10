import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
it('runs actual orchestration and adapter behavioral regressions without network', () => {
  const result=execFileSync(process.execPath,['--experimental-transform-types',resolve('scripts/check-wallet-topup-orchestration-runtime.mjs')],{encoding:'utf8',timeout:30000});
  expect(result).toContain('BATCH1C_ORCHESTRATION_RUNTIME=20_PASSED');
});
