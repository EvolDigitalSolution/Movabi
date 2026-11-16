import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
 testDir:'./e2e',testMatch:/booking-form-lifecycle\.spec\.ts/,workers:1,timeout:90_000,
 expect:{timeout:15_000},reporter:'list',outputDir:'.temp/playwright-booking-lifecycle',
 use:{...devices['Pixel 7'],viewport:{width:412,height:915},baseURL:process.env.E2E_BASE_URL||'http://localhost:3105',screenshot:'only-on-failure',trace:'retain-on-failure'},
 webServer:process.env.E2E_BASE_URL?undefined:{command:'npx ng serve mobile --configuration development --prebundle=false --hmr=false --port=3105 --host=127.0.0.1',url:'http://localhost:3105',reuseExistingServer:false,timeout:240_000},
});
