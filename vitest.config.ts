import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/app/core'),
      '@shared': resolve(__dirname, 'src/app/shared'),
      '@env': resolve(__dirname, 'src/environments'),
      '@admin': resolve(__dirname, 'src/app/apps/admin'),
      '@mobile': resolve(__dirname, 'src/app/apps/mobile')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['src/app/app.spec.ts'],
    passWithNoTests: false
  }
});
