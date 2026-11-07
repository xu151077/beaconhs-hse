import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Navigate to Collabora directly', async ({ page }) => {
  // Use one of the document IDs from the page snapshot
  const documentId = '6c93326b-a35c-4db0-b5f7-db745d7a3fa7'

  console.log(`[Diagnose] Navigating to document: ${documentId}`)
  await page.goto(`${TEST_URL}/documents/${documentId}`, { waitUntil: 'load' })

  console.log(`[Diagnose] Page title: ${await page.title()}`)
  console.log(`[Diagnose] URL: ${page.url()}`)

  // Try to navigate directly to Collabora
  const collaboraUrl = `${TEST_URL}/documents/${documentId}/collabora`
  console.log(`[Diagnose] Navigating to Collabora: ${collaboraUrl}`)

  await page.goto(collaboraUrl, { waitUntil: 'load' })

  console.log(`[Diagnose] After Collabora navigation, URL: ${page.url()}`)
  console.log(`[Diagnose] Page title: ${await page.title()}`)

  // Check if Collabora iframe is rendered
  const iframe = page.locator('iframe')
  const iframeCount = await iframe.count()
  console.log(`[Diagnose] Iframe count: ${iframeCount}`)

  if (iframeCount > 0) {
    console.log(`[Diagnose] Collabora iframe is rendered`)
  } else {
    console.log(`[Diagnose] No iframe found`)
  }

  // Check for frozen UI text
  const frozenTexts = await page.getByText(/This workspace is frozen/i).count()
  console.log(`[Diagnose] Frozen UI text count: ${frozenTexts}`)

  if (frozenTexts > 0) {
    console.log(`[Diagnose] Frozen UI is displayed`)
  } else {
    console.log(`[Diagnose] Frozen UI is NOT displayed`)
  }
})
