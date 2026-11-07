import { defineConfig, devices } from '@playwright/test'

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * Playwright configuration for the BeaconHS E2E suites.
 *
 * TRACE RETENTION
 * ---------------
 * The default `on-first-retry` mode records a trace only when a test is retried.
 * Locally `retries` is 0, so a failing navigation produced NO trace at all —
 * which is exactly what made the Phase CT WOPI failure un-analysable after the
 * fact. The default is therefore `retain-on-failure`: a trace is recorded for
 * every run and kept only when the run fails, so a one-shot failure still leaves
 * evidence while passing runs stay cheap.
 *
 * Two suites that specifically investigate flaky or hanging navigation
 * (`phase-ct-wopi-freeze-diagnostic` / `phase-cx-file-authorization-e2e`) opt
 * into `trace: 'on'` themselves, so both their passing and failing runs are
 * retained; the phase CX authorization suite keeps traces because a denial that
 * unexpectedly succeeds must be reviewable too.
 *
 * TRACE CONTENT AND RETENTION
 * ---------------------------
 * Playwright traces contain DOM snapshots, network metadata and console output.
 * Cookies and Authorization headers are recorded in the trace's network data by
 * default, so a trace is treated as sensitive: it is written under
 * `apps/web/test-results/` (git-ignored), must never be attached to a report or
 * committed, and is deleted by the next run unless moved to a controlled
 * evidence directory. Screenshots and video stay failure-only to bound the size.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html'], ['list'], ['json', { outputFile: 'e2e/phase-bn-results.json' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 60000,
    actionTimeout: 60000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  // Tests target an already-running deployment; no local web server is started.
})
