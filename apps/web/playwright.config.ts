import { defineConfig, devices } from '@playwright/test'
import { authFile, previewPorts, webOrigin } from './e2e/preview'

// Browser tests run against the preview (`corepack pnpm preview`): a running
// preview on the same ports is reused, otherwise one is started and removed
// again when the run ends.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'sign-in', testMatch: /sign-in\.setup\.ts/ },
    {
      name: 'desktop',
      dependencies: ['sign-in'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        storageState: authFile,
      },
    },
    {
      name: 'phone',
      dependencies: ['sign-in'],
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 375, height: 812 },
        storageState: authFile,
      },
    },
  ],
  webServer: {
    command: 'node_modules/.bin/tsx scripts/preview/run.ts',
    cwd: '../server',
    env: {
      PREVIEW_WEB_PORT: String(previewPorts.web),
      PREVIEW_API_PORT: String(previewPorts.api),
    },
    url: `${webOrigin}/login`,
    reuseExistingServer: true,
    timeout: 300_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
    stdout: 'pipe',
  },
})
