import {describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

describe('Customer wallet collection — route, service and adapter runtime',()=>{
 it('drives the real checkout/verify routes through the real service, adapter and attempt store',()=>{
  const output=execFileSync(process.execPath,[resolve('scripts/check-customer-wallet-collection-runtime.mjs')],{encoding:'utf8'});
  expect(output).toContain('CUSTOMER_WALLET_COLLECTION_ROUTE_RUNTIME=8_PASSED');
 });
});
