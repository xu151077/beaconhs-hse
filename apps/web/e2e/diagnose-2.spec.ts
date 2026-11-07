import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Diagnose documents page with loading state', async ({ page }) => {
  console.log(`[Diagnose] Navigating to ${TEST_URL}/documents`)
  await page.goto(`${TEST_URL}/documents`, { waitUntil: 'load' })

  console.log(`[Diagnose] Page title: ${await page.title()}`)

  // Try to find "new document" button
  const newDocButtons = await page.getByRole('button', { name: /new document/i }).count()
  console.log(`[Diagnose] Found ${newDocButtons} 'new document' buttons`)

  if (newDocButtons > 0) {
    console.log(`[Diagnose] Clicking first 'new document' button`)
    await page
      .getByRole('button', { name: /new document/i })
      .first()
      .click()

    // Wait for loading state to clear
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      console.log(`[Diagnose] networkidle timeout`)
    })

    // Wait for URL to change or page to stabilize
    await page.waitForTimeout(5000)

    console.log(`[Diagnose] After click, URL: ${page.url()}`)
    console.log(`[Diagnose] After click, page title: ${await page.title()}`)

    // Check for loading indicators
    const loadingTexts = await page.getByText(/loading/i, { exact: false }).count()
    console.log(`[Diagnose] Found ${loadingTexts} 'loading' text elements`)

    // Check if the page has changed
    const newDocButtonsAfter = await page.getByRole('button', { name: /new document/i }).count()
    console.log(`[Diagnose] 'new document' buttons after: ${newDocButtonsAfter}`)
  }
})
