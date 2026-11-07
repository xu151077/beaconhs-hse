import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Simple navigation test', async ({ page }) => {
  console.log(`[Simple] Navigating to ${TEST_URL}/documents`)
  await page.goto(`${TEST_URL}/documents`, { waitUntil: 'domcontentloaded' })

  console.log(`[Simple] Page title: ${await page.title()}`)
  console.log(`[Simple] URL: ${page.url()}`)

  // Check if page loaded
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '')
  console.log(`[Simple] Body text preview: ${bodyText.slice(0, 200)}`)

  // Try to find "new document" button
  const newDocButtons = await page.getByRole('button', { name: /new document/i }).count()
  console.log(`[Simple] Found ${newDocButtons} 'new document' buttons`)

  if (newDocButtons > 0) {
    console.log(`[Simple] Clicking first 'new document' button`)
    await page
      .getByRole('button', { name: /new document/i })
      .first()
      .click()
    console.log(`[Simple] After click, URL: ${page.url()}`)
  } else {
    console.log(`[Simple] No 'new document' button found`)
  }
})
