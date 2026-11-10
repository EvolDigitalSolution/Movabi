import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
describe('Customer booking summaries retain recorded currency',()=>{
 it('uses each booking currency on Activity and Home',()=>{
  const out=execFileSync(process.execPath,[path.resolve('scripts/check-customer-booking-currency.mjs')],{encoding:'utf8'});
  expect(out).toContain('CUSTOMER_BOOKING_CURRENCY_RUNTIME=14_PASSED');
 });
});
