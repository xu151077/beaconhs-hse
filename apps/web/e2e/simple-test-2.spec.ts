import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Simple navigation to home', async ({ page }) => {
  console.log(`[Simple] Navigating to ${TEST_URL}`)
  await page.goto(`${TEST_URL}`, { waitUntil: 'domcontentloaded' })

  console.log(`[Simple] Page title: ${await page.title()}`)
  console.log(`[Simple] URL: ${page.url()}`)

  // Check if page loaded
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '')
  console.log(`[Simple] Body text preview: ${bodyText.slice(0, 200)}`)
})
