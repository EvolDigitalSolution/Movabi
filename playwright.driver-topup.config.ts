import {defineConfig,devices} from '@playwright/test';
// Driver top-up browser regression with REAL Stripe.js. Own dev server and port, so it never
// reuses an unrelated server on :3000 that may be serving a different checkout.
export default defineConfig({
  testDir:'./e2e',testMatch:/driver-topup-(continue-payment|lifecycle).spec.ts/,workers:1,timeout:120_000,
  expect:{timeout:15_000},reporter:'list',
  // test-results/ holds tracked files in this repo; keep this run's output out of it.
  outputDir:'.temp/playwright-driver-topup',
  use:{...devices['Pixel 7'],viewport:{width:412,height:915},baseURL:'http://localhost:3101',screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'npx ng serve mobile --configuration develop --port=3101 --host=127.0.0.1',url:'http://localhost:3101',reuseExistingServer:false,timeout:240_000},
});
