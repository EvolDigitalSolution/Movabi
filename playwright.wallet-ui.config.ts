import {defineConfig,devices} from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:'wallet-isolated-ui.spec.ts',workers:1,timeout:30000,reporter:'list',use:{...devices['Pixel 7'],baseURL:'http://127.0.0.1:3789'},webServer:{command:'python scripts/serve-wallet-ui-test.py',url:'http://127.0.0.1:3789/driver',reuseExistingServer:true,timeout:15000}});
