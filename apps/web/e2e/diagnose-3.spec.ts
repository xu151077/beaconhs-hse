import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Diagnose documents page with alert', async ({ page, context }) => {
  console.log(`[Diagnose] Navigating to ${TEST_URL}/documents`)
  await page.goto(`${TEST_URL}/documents`, { waitUntil: 'load' })

  console.log(`[Diagnose] Page title: ${await page.title()}`)

  // Handle alerts
  page.on('dialog', async (dialog) => {
    console.log(`[Diagnose] Alert: ${dialog.message()}`)
    await dialog.accept()
  })

  // Try to find "new document" button
  const newDocButtons = await page.getByRole('button', { name: /new document/i }).count()
  console.log(`[Diagnose] Found ${newDocButtons} 'new document' buttons`)

  if (newDocButtons > 0) {
    console.log(`[Diagnose] Clicking first 'new document' button`)
    await page
      .getByRole('button', { name: /new document/i })
      .first()
      .click()

    // Wait for alert to be handled
    await page.waitForTimeout(2000)

    // Wait for page to stabilize
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      console.log(`[Diagnose] networkidle timeout`)
    })

    console.log(`[Diagnose] After click, URL: ${page.url()}`)
    console.log(`[Diagnose] After click, page title: ${await page.title()}`)

    // Check if we are now on a document page
    if (page.url().includes('/documents/')) {
      console.log(`[Diagnose] Successfully navigated to document page`)
    } else {
      console.log(`[Diagnose] Still on documents page`)
    }
  }
})
