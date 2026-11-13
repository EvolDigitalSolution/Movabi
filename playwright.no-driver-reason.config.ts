import {defineConfig,devices} from '@playwright/test';
// Area 1c: the customer tracking hint is the server-recorded availability reason.
// Own dev server and port, so it never reuses an unrelated server on :3000.
export default defineConfig({
  testDir:'./e2e',testMatch:/customer-no-driver-reason\.spec\.ts/,workers:1,timeout:120_000,
  expect:{timeout:15_000},reporter:'list',
  outputDir:'.temp/playwright-no-driver-reason-results',
  use:{...devices['Pixel 7'],viewport:{width:412,height:915},baseURL:'http://localhost:3103',screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'npx ng serve mobile --configuration develop --port=3103 --host=127.0.0.1',url:'http://localhost:3103',reuseExistingServer:false,timeout:240_000},
});
