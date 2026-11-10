import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
for(const [script,expected]of [
 ['check-market-navigation-hardening-v23.cjs','MARKET_NAVIGATION_HARDENING_CASES=39_PASSED'],
 ['check-driver-market-feed-v23.cjs','ACTUAL_DRIVER_FEED_AND_WALLET_CASES=8_PASSED'],
 ['check-wallet-owner-boundary-v23.cjs','ACTUAL_WALLET_OWNER_BOUNDARY_CASES=10_PASSED'],
 ['check-fresh-booking-quote-v23.cjs','ACTUAL_FRESH_BOOKING_QUOTE_CASES=7_PASSED']
])it(script,()=>{const output=execFileSync(process.execPath,['--experimental-vm-modules',resolve('scripts',script)],{encoding:'utf8'});expect(output).toContain(expected);});
