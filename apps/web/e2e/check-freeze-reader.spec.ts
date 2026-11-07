import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Check if freeze reader is registered', async ({ page }) => {
  console.log(`[Diagnose] Navigating to ${TEST_URL}/documents`)
  await page.goto(`${TEST_URL}/documents`, { waitUntil: 'load' })

  // Try to upload a small file to see if it fails with STORAGE_FREEZE_STATE_UNKNOWN
  const documentId = await createDocument(page)
  console.log(`[Diagnose] Created document: ${documentId}`)

  // Switch to PDF mode
  await page.getByRole('button', { name: /^PDF$/ }).first().click()
  await page.waitForTimeout(2000)

  // Try to upload a small file
  const smallFile = Buffer.from('test content')
  const started = Date.now()
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: smallFile,
  })
  console.log(`[Diagnose] setInputFiles done after ${((Date.now() - started) / 1000).toFixed(1)}s`)

  // Wait for error message
  await page.waitForTimeout(5000)
  const errorText = await page
    .locator('[data-sonner-toast]')
    .first()
    .innerText()
    .catch(() => '')
  console.log(`[Diagnose] Error text: ${errorText}`)

  if (
    errorText.includes('STORAGE_FREEZE_STATE_UNKNOWN') ||
    errorText.includes('no freeze-state reader')
  ) {
    console.log(`[Diagnose] Freeze reader is NOT registered`)
  } else if (errorText.includes('workspace is frozen')) {
    console.log(`[Diagnose] Freeze reader IS registered and tenant is frozen`)
  } else {
    console.log(`[Diagnose] Freeze reader IS registered and tenant is ACTIVE`)
  }
})

async function createDocument(page: import('@playwright/test').Page): Promise<string> {
  await page.goto(`${TEST_URL}/documents`, { waitUntil: 'load' })

  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
    page
      .getByRole('button', { name: /new document/i })
      .first()
      .click(),
  ])

  const documentId = page.url().split('/documents/')[1]!.split(/[?#]/)[0]!
  return documentId
}
