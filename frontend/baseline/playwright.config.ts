import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  outputDir: fileURLToPath(new URL('../baseline-results', import.meta.url)),
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: fileURLToPath(new URL('../playwright-report', import.meta.url)),
        open: 'never',
      },
    ],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4179',
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config baseline/vite.config.ts',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: !process.env.CI,
  },
})
