import { test, expect } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'

test.use({ storageState: AUTH_FILE })

test('Create document via API', async ({ page }) => {
  console.log(`[Diagnose] Navigating to ${TEST_URL}/documents`)

  // Create a document via API
  const response = await page.evaluate(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'E2E Test Document',
        description: 'Created via E2E test',
      }),
    })
    return {
      status: res.status,
      statusText: res.statusText,
      data: await res.json(),
    }
  }, TEST_URL)

  console.log(`[Diagnose] API response: ${response.status} ${response.statusText}`)
  console.log(`[Diagnose] Document created:`, response.data)

  if (response.status === 200 && response.data?.id) {
    const documentId = response.data.id
    console.log(`[Diagnose] Document ID: ${documentId}`)
    console.log(`[Diagnose] Navigating to document: ${documentId}`)

    await page.goto(`${TEST_URL}/documents/${documentId}`, { waitUntil: 'load' })

    console.log(`[Diagnose] Page title: ${await page.title()}`)
    console.log(`[Diagnose] URL: ${page.url()}`)
  } else {
    console.log(`[Diagnose] Failed to create document`)
  }
})
