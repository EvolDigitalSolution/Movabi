import {defineConfig,devices} from '@playwright/test';
// Customer cash-ride browser tests. Own dev server/port and an untracked output folder.
export default defineConfig({
  testDir:'./e2e',testMatch:/customer-cash-booking\.spec\.ts/,workers:1,timeout:120_000,
  expect:{timeout:15_000},reporter:'list',outputDir:'.temp/playwright-cash-booking',
  use:{...devices['Pixel 7'],viewport:{width:412,height:915},baseURL:'http://localhost:3102',screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'npx ng serve mobile --configuration develop --port=3102 --host=127.0.0.1',url:'http://localhost:3102',reuseExistingServer:false,timeout:240_000},
});
