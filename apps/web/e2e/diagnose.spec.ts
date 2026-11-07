import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Diagnose documents page', async ({ page }) => {
  console.log(`[Diagnose] Navigating to ${TEST_URL}/documents`)
  await page.goto(`${TEST_URL}/documents`, { waitUntil: 'load' })

  console.log(`[Diagnose] Page title: ${await page.title()}`)
  console.log(`[Diagnose] URL: ${page.url()}`)

  // Check if page loaded
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '')
  console.log(`[Diagnose] Body text preview: ${bodyText.slice(0, 500)}`)

  // Try to find "new document" button
  const newDocButtons = await page.getByRole('button', { name: /new document/i }).count()
  console.log(`[Diagnose] Found ${newDocButtons} 'new document' buttons`)

  if (newDocButtons > 0) {
    console.log(`[Diagnose] Clicking first 'new document' button`)
    await page
      .getByRole('button', { name: /new document/i })
      .first()
      .click()

    console.log(`[Diagnose] After click, URL: ${page.url()}`)
    console.log(`[Diagnose] After click, page title: ${await page.title()}`)

    // Wait a bit to see if anything happens
    await page.waitForTimeout(3000)
    console.log(`[Diagnose] After 3s, URL: ${page.url()}`)
  } else {
    console.log(`[Diagnose] No 'new document' button found`)
  }
})
