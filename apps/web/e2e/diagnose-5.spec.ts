import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Navigate to existing document', async ({ page }) => {
  // Use one of the document IDs from the page snapshot
  const documentId = '6c93326b-a35c-4db0-b5f7-db745d7a3fa7'

  console.log(`[Diagnose] Navigating to document: ${documentId}`)
  await page.goto(`${TEST_URL}/documents/${documentId}`, { waitUntil: 'load' })

  console.log(`[Diagnose] Page title: ${await page.title()}`)
  console.log(`[Diagnose] URL: ${page.url()}`)

  // Check if we are on the document page
  if (page.url().includes(documentId)) {
    console.log(`[Diagnose] Successfully navigated to document page`)

    // Try to find Collabora button
    const collaboraButtons = await page.getByRole('button', { name: /collabora|open/i }).count()
    console.log(`[Diagnose] Found ${collaboraButtons} Collabora/Open buttons`)

    if (collaboraButtons > 0) {
      console.log(`[Diagnose] Clicking first Collabora/Open button`)
      await page
        .getByRole('button', { name: /collabora|open/i })
        .first()
        .click()

      // Wait for Collabora page to load
      await page.waitForTimeout(5000)

      console.log(`[Diagnose] After click, URL: ${page.url()}`)

      // Check if Collabora iframe is rendered
      const iframe = page.locator('iframe')
      const iframeCount = await iframe.count()
      console.log(`[Diagnose] Iframe count: ${iframeCount}`)

      if (iframeCount > 0) {
        console.log(`[Diagnose] Collabora iframe is rendered`)
      }
    }
  } else {
    console.log(`[Diagnose] Failed to navigate to document`)
  }
})
