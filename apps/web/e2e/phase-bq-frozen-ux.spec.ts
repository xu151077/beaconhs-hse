import { existsSync, writeFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  STORAGE_FROZEN_ACTION,
  STORAGE_FROZEN_DETAIL,
  STORAGE_FROZEN_TITLE,
} from '../src/lib/storage-freeze-copy'
import { blankDocxBuffer } from '../src/lib/docx-blank'
import { createDocument, openDocument } from './helpers/documents'
import { blockWrites, ensureActive, releaseWrites } from './helpers/freeze-control'

/**
 * Phase BQ — frozen workspace UX regression.
 *
 * The freeze state is a REAL precondition driven through the production state
 * machine by `helpers/freeze-control`, and every assertion is a browser assertion
 * against the deployed HTTPS app. Nothing here writes freeze state directly or
 * emulates the gate.
 *
 * Surfaces under test (current UI):
 *   • Write pane empty state → "Start blank" (`createBlankDocumentMaster`)
 *   • Write pane empty state → "Import Word file" (`requestUpload` → `/api/storage/upload`)
 *   • Write pane with a Word master → the Collabora WOPI session (`getDocumentWriterSession`)
 */
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/opencode/bt-auth.json'
const DOCX_FIXTURE = '/tmp/opencode/bq-import-fixture.docx'

test.use({ storageState: AUTH_FILE })
test.describe.configure({ timeout: 300_000 })

test.describe('Phase BQ — frozen workspace UX regression', () => {
  test.beforeAll(() => {
    if (!existsSync(DOCX_FIXTURE)) writeFileSync(DOCX_FIXTURE, blankDocxBuffer())
  })

  test.afterAll(() => {
    ensureActive()
  })

  test('Scenario 1: frozen Start blank is refused with the frozen copy', async ({ page }) => {
    console.log(`[BQ] freeze state: ${blockWrites()}`)
    await createDocument(page)

    const startBlank = page.getByRole('button', { name: /start blank/i }).first()
    await expect(startBlank).toBeVisible({ timeout: 30_000 })
    await startBlank.click()

    // The refusal must be the determinate freeze copy, in plain language.
    const toast = page.locator('[data-sonner-toast]').first()
    await expect(toast).toBeVisible({ timeout: 30_000 })
    await expect(toast).toContainText(STORAGE_FROZEN_ACTION)
    await expect(toast).not.toContainText(/this workspace is unavailable/i)

    // No WOPI session was minted and no master was written.
    expect(await page.locator('iframe').count()).toBe(0)
    await page.reload({ waitUntil: 'load' })
    await expect(page.getByRole('button', { name: /start blank/i }).first()).toBeVisible({
      timeout: 30_000,
    })
  })

  test('Scenario 2: frozen Import Word is refused with the frozen copy', async ({ page }) => {
    console.log(`[BQ] freeze state: ${blockWrites()}`)
    await createDocument(page)

    await page
      .getByRole('button', { name: /import word file/i })
      .first()
      .click()
    const input = page.locator('input[type=file][accept=".docx"]').first()
    await expect(input).toBeAttached({ timeout: 30_000 })
    await input.setInputFiles(DOCX_FIXTURE)

    // The uploader reports the server's refusal inline.
    await expect(page.getByText(STORAGE_FROZEN_ACTION).first()).toBeVisible({ timeout: 60_000 })
    expect(await page.getByText(/upload could not be started/i).count()).toBe(0)

    // No editor and no master.
    expect(await page.locator('iframe').count()).toBe(0)
    await page.reload({ waitUntil: 'load' })
    await expect(page.getByRole('button', { name: /start blank/i }).first()).toBeVisible({
      timeout: 30_000,
    })
  })

  test('Scenario 3: ACTIVE workspace opens the editor normally', async ({ page }) => {
    console.log(`[BQ] released -> ${releaseWrites()}`)
    await createDocument(page)

    await page
      .getByRole('button', { name: /start blank/i })
      .first()
      .click()
    await expect(page.locator('iframe')).toHaveCount(1, { timeout: 120_000 })
    expect(await page.getByText(/this workspace is frozen/i).count()).toBe(0)
  })

  test('Scenario 4: server-side freeze gate refuses a WOPI session', async ({ page }) => {
    // Build a document that HAS a Word master while the workspace is writable.
    console.log(`[BQ] released -> ${releaseWrites()}`)
    const documentId = await createDocument(page)
    await page
      .getByRole('button', { name: /start blank/i })
      .first()
      .click()
    await expect(page.locator('iframe')).toHaveCount(1, { timeout: 120_000 })

    // Freeze, then reopen the same document: the server must refuse to mint a
    // WOPI session and the embed must show the frozen panel.
    console.log(`[BQ] freeze state: ${blockWrites()}`)
    await openDocument(page, documentId)

    await expect(page.getByText(STORAGE_FROZEN_TITLE).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(STORAGE_FROZEN_DETAIL).first()).toBeVisible({ timeout: 30_000 })
    expect(await page.locator('iframe').count()).toBe(0)
    expect(await page.getByText(/this workspace is unavailable/i).count()).toBe(0)
  })
})
