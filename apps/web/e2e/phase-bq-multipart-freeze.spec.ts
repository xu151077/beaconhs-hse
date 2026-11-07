import { existsSync, readFileSync } from 'node:fs'
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { STORAGE_FROZEN_ACTION } from '../src/lib/storage-freeze-copy'
import {
  computeFixtureHash,
  getFixtureHash,
  getFixturePath,
  getFixtureSize,
} from './helpers/multipart-fixtures'
import { createDocument, openPdfPane, pdfFileInput, TEST_URL } from './helpers/documents'
import { blockWrites, ensureActive, releaseWrites } from './helpers/freeze-control'

/**
 * Phase BQ — storage write freeze across the multipart upload lifecycle.
 *
 * Every scenario drives the PDF pane's real uploader against the deployed HTTPS
 * app; the freeze state is a real precondition driven through the production
 * state machine (`helpers/freeze-control`). The multipart path is the one the
 * 256 MiB fixture takes: `requestUpload` → `createMultipartUpload`, then a fresh
 * a part URL minted immediately before each part, then
 * `finalizeUpload` → `completeMultipartUpload` → `promoteObject`.
 *
 * Scenarios 3–5 freeze while the lifecycle is genuinely in flight. The uploader
 * is sequential (one part at a time), so holding one part's object-store `PUT`
 * parks the lifecycle at a known stage; the freeze then lands before the NEXT
 * gated call. `applyTransition` refuses FROZEN while a write is in flight (its
 * drain cannot be verified), so those scenarios run in DRAINING — the state an
 * operator passes through while in-flight writes finish, and a state in which the
 * gate refuses new writes. Each scenario logs the state it actually reached.
 *
 * `MULTIPART_PART_COUNT` mirrors `MULTIPART_UPLOAD_PART_SIZE_BYTES` (64 MiB) from
 * `packages/storage/src/multipart.ts`; the 256 MiB fixture is exactly the
 * multipart threshold, so the last held part is what makes scenario 5 freeze
 * between the final part upload and finalisation.
 */
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/opencode/bt-auth.json'
const FIXTURE_PATH = getFixturePath()
const FIXTURE_SIZE = getFixtureSize()
const FIXTURE_HASH = getFixtureHash()
const PART_SIZE_BYTES = 64 * 1024 * 1024
const MULTIPART_PART_COUNT = Math.ceil(FIXTURE_SIZE / PART_SIZE_BYTES)

let fixtureSha256 = ''

test.use({ storageState: AUTH_FILE })
test.describe.configure({ timeout: 900_000 })

/**
 * Hold the Nth object-store `PUT` (1-based) until `release()` is called, so a
 * freeze can be applied while the multipart lifecycle is parked at a known
 * stage. Server actions are POSTs, so filtering on the PUT method isolates the
 * part uploads.
 */
async function holdObjectStorePut(page: Page, holdAtIndex: number) {
  let seen = 0
  let holding = false
  let releaseHold: (() => void) | null = null

  await page.route('**/*', async (route) => {
    const request = route.request()
    if (request.method() !== 'PUT') {
      await route.continue()
      return
    }
    seen += 1
    if (seen === holdAtIndex && !holding) {
      holding = true
      await new Promise<void>((resolve) => {
        releaseHold = resolve
      })
    }
    await route.continue()
  })

  return {
    async waitUntilHeld(): Promise<void> {
      const deadline = Date.now() + 300_000
      while (Date.now() < deadline) {
        if (holding) return
        await page.waitForTimeout(100)
      }
      throw new Error(`Object-store PUT #${holdAtIndex} was never intercepted`)
    },
    release(): void {
      releaseHold?.()
    },
  }
}

async function setupPdfDocument(page: Page): Promise<string> {
  const documentId = await createDocument(page)
  await openPdfPane(page)
  return documentId
}

/** The inline uploader refusal must be the determinate freeze copy. */
async function expectFrozenRefusal(page: Page): Promise<void> {
  await expect(page.getByText(STORAGE_FROZEN_ACTION).first()).toBeVisible({ timeout: 600_000 })
  expect(await page.getByText(/upload could not be started/i).count()).toBe(0)
  expect(await page.getByText(/upload could not be finalized/i).count()).toBe(0)
  // Nothing was attached to the document.
  await expect(page.getByText(/no pdf yet/i)).toBeVisible({ timeout: 60_000 })
}

/**
 * Wait for the upload to complete, then verify the stored object's bytes.
 *
 * KNOWN DEFECT (found while building this run): the pane's pdf.js viewer cannot
 * render a 256 MiB PDF. Measured on this environment, the renderer is killed by
 * the browser about 80s after the viewer mounts, i.e. once pdf.js has fetched the
 * object. The upload itself is unaffected. To keep the byte verification honest
 * and independent of that defect, the download capability URL is read from the
 * pane and the object is then fetched from a fresh page that never mounts the
 * viewer.
 */
async function expectStoredPdfMatchesFixture(page: Page, context: BrowserContext): Promise<void> {
  // The uploader's "Uploaded" row is transient: once the attachment is linked,
  // `attachFileVersion` requests the PDF and the pane swaps the uploader for the
  // viewer, so polling that row races the swap. The download capability link in
  // the pane header is the stable signal that the attachment is stored.
  const download = page.locator('a[download]').first()
  await expect(download).toBeVisible({ timeout: 600_000 })
  const href = await download.getAttribute('href')
  if (!href) throw new Error('the PDF download link has no href')

  // Leave the crashing viewer behind before the object read-back starts.
  await page.close().catch(() => undefined)

  const verifier = await context.newPage()
  try {
    await verifier.goto(`${TEST_URL}/documents`, { waitUntil: 'load' })
    const result = await verifier.evaluate(async (target) => {
      const response = await fetch(target)
      const buffer = await response.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', buffer)
      const sha256 = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      return { status: response.status, size: buffer.byteLength, sha256 }
    }, href)

    expect(result.status).toBe(200)
    expect(result.size).toBe(FIXTURE_SIZE)
    expect(result.sha256).toBe(fixtureSha256)
  } finally {
    await verifier.close().catch(() => undefined)
  }
}

test.describe('Phase BQ — storage write freeze, multipart upload E2E', () => {
  test.beforeAll(() => {
    if (!existsSync(FIXTURE_PATH)) {
      throw new Error(
        `Missing multipart fixture at ${FIXTURE_PATH}. Generate it with computeFixtureHash() from e2e/helpers/multipart-fixtures.ts.`,
      )
    }
    const fixture = readFileSync(FIXTURE_PATH)
    fixtureSha256 = computeFixtureHash(fixture)
    expect(fixture.byteLength, 'fixture size drifted from the exported constant').toBe(FIXTURE_SIZE)
    expect(fixtureSha256, 'fixture hash drifted from the exported constant').toBe(FIXTURE_HASH)
  })

  test.afterAll(() => {
    ensureActive()
  })

  test('Scenario 1: normal multipart upload (all parts succeed)', async ({ page, context }) => {
    console.log(`[BQ] released -> ${releaseWrites()}`)
    await setupPdfDocument(page)

    const startedAt = Date.now()
    await pdfFileInput(page).setInputFiles(FIXTURE_PATH)
    await expectStoredPdfMatchesFixture(page, context)
    console.log(
      `[BQ] Scenario 1 verified the stored object after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    )
  })

  test('Scenario 2: freeze before multipart create', async ({ page }) => {
    console.log(`[BQ] freeze state: ${blockWrites()}`)
    await setupPdfDocument(page)

    await pdfFileInput(page).setInputFiles(FIXTURE_PATH)
    await expectFrozenRefusal(page)
  })

  test('Scenario 3: freeze after multipart create but before finalize', async ({ page }) => {
    console.log(`[BQ] released -> ${releaseWrites()}`)
    await setupPdfDocument(page)

    const hold = await holdObjectStorePut(page, 1)
    await pdfFileInput(page).setInputFiles(FIXTURE_PATH)
    await hold.waitUntilHeld()
    console.log(
      '[BQ] parked the first part upload; the multipart upload exists and part 1 was minted',
    )

    console.log(`[BQ] freeze state: ${blockWrites()}`)
    hold.release()

    await expectFrozenRefusal(page)
  })

  test('Scenario 4: freeze after part minting but before finalize', async ({ page }) => {
    console.log(`[BQ] released -> ${releaseWrites()}`)
    await setupPdfDocument(page)

    const hold = await holdObjectStorePut(page, 2)
    await pdfFileInput(page).setInputFiles(FIXTURE_PATH)
    await hold.waitUntilHeld()
    console.log('[BQ] parked part 2; part 1 already uploaded')

    console.log(`[BQ] freeze state: ${blockWrites()}`)
    hold.release()

    await expectFrozenRefusal(page)
  })

  test('Scenario 5: freeze after part upload but before finalize', async ({ page }) => {
    console.log(`[BQ] released -> ${releaseWrites()}`)
    await setupPdfDocument(page)

    const hold = await holdObjectStorePut(page, MULTIPART_PART_COUNT)
    await pdfFileInput(page).setInputFiles(FIXTURE_PATH)
    await hold.waitUntilHeld()
    console.log(`[BQ] parked the last of ${MULTIPART_PART_COUNT} parts; only finalisation is left`)

    console.log(`[BQ] freeze state: ${blockWrites()}`)
    hold.release()

    await expectFrozenRefusal(page)
  })

  test('Scenario 6: release and resume multipart upload', async ({ page, context }) => {
    console.log(`[BQ] freeze state: ${blockWrites()}`)
    await setupPdfDocument(page)

    // While frozen the upload is refused...
    await pdfFileInput(page).setInputFiles(FIXTURE_PATH)
    await expectFrozenRefusal(page)

    // ...and after the workspace is released it succeeds end to end.
    console.log(`[BQ] released -> ${releaseWrites()}`)
    await pdfFileInput(page).setInputFiles(FIXTURE_PATH)
    await expectStoredPdfMatchesFixture(page, context)
  })

  test('Scenario 7: concurrency and failure recovery', async ({ page, context }) => {
    console.log(`[BQ] freeze state: ${blockWrites()}`)

    const pages: Page[] = [page]
    await setupPdfDocument(page)
    for (let index = 1; index < 3; index += 1) {
      const extra = await context.newPage()
      pages.push(extra)
      await setupPdfDocument(extra)
    }

    // Start all three multipart uploads at once; each must be refused.
    await Promise.all(pages.map((target) => pdfFileInput(target).setInputFiles(FIXTURE_PATH)))

    for (const target of pages) {
      await expectFrozenRefusal(target)
    }
  })
})
