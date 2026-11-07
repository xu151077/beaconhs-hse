import { expect, type Page } from '@playwright/test'

export const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'

/**
 * Create a document from the library and return its id.
 *
 * "New document" is a server action that redirects to the new document's detail
 * page, so the click and the navigation must be awaited together — awaiting only
 * the click leaves `page.url()` on the library page.
 */
export async function createDocument(page: Page): Promise<string> {
  await page.goto(`${TEST_URL}/documents`, { waitUntil: 'load' })
  await Promise.all([
    page.waitForURL(/\/documents\/[0-9a-fA-F-]{36}/, { timeout: 60_000 }),
    page
      .getByRole('button', { name: /new document/i })
      .first()
      .click(),
  ])
  const match = page.url().match(/\/documents\/([0-9a-fA-F-]{36})/)
  const documentId = match?.[1]
  if (!documentId) throw new Error(`Could not read a document id from ${page.url()}`)
  return documentId
}

/** Open a document's detail page directly. */
export async function openDocument(page: Page, documentId: string): Promise<void> {
  await page.goto(`${TEST_URL}/documents/${documentId}`, { waitUntil: 'load' })
}

/**
 * Switch the document pane to PDF mode and wait for the PDF surface to settle.
 *
 * The pane is client-side, so the Write↔PDF switch is a button, not a route. The
 * pane's own "No PDF yet" card is the signal that its server action has resolved
 * and the uploader is mounted.
 */
export async function openPdfPane(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'PDF', exact: true }).first().click()
  await expect(page.getByText(/no pdf yet/i)).toBeVisible({ timeout: 30_000 })
}

/** The PDF pane's file input (the uploader only renders in PDF mode). */
export function pdfFileInput(page: Page) {
  return page.locator('input[type=file]').first()
}
