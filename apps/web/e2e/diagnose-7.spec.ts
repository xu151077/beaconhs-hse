import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Create document via form submission', async ({ page }) => {
  console.log(`[Diagnose] Navigating to ${TEST_URL}/documents`)
  await page.goto(`${TEST_URL}/documents`, { waitUntil: 'load' })

  console.log(`[Diagnose] Page title: ${await page.title()}`)

  // Click the "New document" button and wait for navigation
  console.log(`[Diagnose] Clicking 'New document' button`)

  // Use Promise.all to wait for navigation and click simultaneously
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => null),
    page
      .getByRole('button', { name: /new document/i })
      .first()
      .click(),
  ])

  console.log(`[Diagnose] After click, URL: ${page.url()}`)
  console.log(`[Diagnose] After click, page title: ${await page.title()}`)

  // Check if we are now on a document page
  if (page.url().includes('/documents/') && !page.url().endsWith('/documents')) {
    console.log(`[Diagnose] Successfully navigated to document page`)
    const documentId = page.url().split('/documents/')[1]!.split(/[?#]/)[0]!
    console.log(`[Diagnose] Document ID: ${documentId}`)
  } else {
    console.log(`[Diagnose] Still on documents page`)
  }
})
