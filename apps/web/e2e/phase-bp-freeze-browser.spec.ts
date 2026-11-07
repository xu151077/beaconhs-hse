import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * Phase BP — storage write-freeze, BROWSER layer (isolated tenant only).
 *
 * This spec does NOT drive the freeze itself and does NOT touch the database.
 * The state machine is driven by the test-only driver
 * (`/tmp/opencode/bp-freeze-driver.mts`); this spec only observes what a real
 * browser sees while the tenant is in a given state. Run it once per state:
 *
 *   BP_EXPECT=allowed  → the gated writes must SUCCEED
 *   BP_EXPECT=refused  → the gated writes must be REFUSED, leave no master,
 *                        and surface an error to the user
 *
 * Both write paths a user can reach from the document pane are covered:
 *   - "Start blank"      → server-generated DOCX → `putObject` (no presign)
 *   - "Import Word file" → server-proxied upload (`/api/storage/upload`)
 *
 * The oracle is the real download route, not a UI affordance:
 *   GET /documents/{id}/master → 200 with the DOCX once the master exists,
 *   404 `Not found` while it does not. (The Write ↔ PDF control nearby is a
 *   *tab* that always renders, so it cannot judge this.)
 *
 * The route is probed from the PAGE (`page.evaluate(fetch)`) rather than from
 * the `request` fixture: the page carries the active-tenant cookie, while the
 * standalone APIRequestContext does not, and would otherwise resolve a
 * different tenant and report every document as "not found".
 *
 * The isolated tenant is selected with the SAME `bhs-active-tenant` cookie the
 * application's own view-as path uses, never the shared `phase-aj-test` tenant.
 */

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'
const FIXTURES_DIR = process.env.E2E_FIXTURES_DIR ?? '/tmp/beaconhs-test-fixtures'
const FIXTURE = join(FIXTURES_DIR, '测试文档.docx')
const ISOLATED_TENANT = 'ea5a149b-ea76-48e0-abbe-fa360f520d8e'
const EXPECT = (process.env.BP_EXPECT ?? 'refused') as 'refused' | 'allowed'

test.use({ storageState: AUTH_FILE })

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** HTTP status of the master download, fetched with the page's own cookies. */
async function masterStatus(page: Page, url: string): Promise<number> {
  return await page.evaluate(async (target) => {
    const response = await fetch(target, { redirect: 'manual' })
    // An opaque redirect means the request was bounced (unauthenticated) rather
    // than answered; report it as 0 so it can never be mistaken for a master.
    return response.type === 'opaqueredirect' ? 0 : response.status
  }, url)
}

async function masterBytes(page: Page, url: string): Promise<Buffer> {
  const bytes = await page.evaluate(async (target) => {
    const response = await fetch(target)
    return Array.from(new Uint8Array(await response.arrayBuffer()))
  }, url)
  return Buffer.from(bytes)
}

/** sonner toasts — the surface "Start blank" failures use. */
async function toastText(page: Page): Promise<string> {
  const texts = await page
    .locator('[data-sonner-toast]')
    .allInnerTexts()
    .catch(() => [] as string[])
  return texts.join(' | ').trim()
}

/**
 * The inline uploader error row — the surface "Import Word file" failures use.
 * `FileUploader` renders a Dismiss button only for errored items, so that
 * button is the stable signal that an upload was rejected.
 */
async function uploaderErrorText(page: Page): Promise<string> {
  const dismiss = page.getByRole('button', { name: /dismiss/i })
  if ((await dismiss.count()) === 0) return ''
  const row = page.locator('li').filter({ has: dismiss }).first()
  return (await row.innerText().catch(() => '')).trim()
}

/** Create an empty document and return its id. */
async function createEmptyDocument(page: Page): Promise<string> {
  await page.goto(`${TEST_URL}/documents`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('body')).toBeVisible()
  await page
    .getByRole('button', { name: /new document/i })
    .first()
    .click()
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}/, { timeout: 30_000 })
  return page.url().split('/documents/')[1]!.split(/[?#]/)[0]!
}

/** Poll the master route until the state is settled for this expectation. */
async function settleMaster(
  page: Page,
  url: string,
  label: string,
  refusalNotice: () => Promise<string>,
): Promise<{ master: number; notice: string }> {
  let master = await masterStatus(page, url)
  let notice = ''
  for (let i = 0; i < 120; i++) {
    master = await masterStatus(page, url)
    if (EXPECT === 'refused') notice = notice || (await refusalNotice())
    const settled = EXPECT === 'allowed' ? master === 200 : notice !== '' && master === 404
    if (settled) {
      console.log(`[${EXPECT}/${label}] settled after ${(i * 0.5).toFixed(1)}s (master=${master})`)
      break
    }
    await page.waitForTimeout(500)
  }
  return { master, notice }
}

test.describe('Phase BP — storage write freeze, browser layer (isolated tenant)', () => {
  test.describe.configure({ timeout: 150_000 })

  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: 'bhs-active-tenant',
        value: ISOLATED_TENANT,
        domain: 'beaconhs-test.xuhaoqing.top',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ])
  })

  test(`Start blank is ${EXPECT} in the isolated tenant`, async ({ page }) => {
    const documentId = await createEmptyDocument(page)
    const masterUrl = `${TEST_URL}/documents/${documentId}/master`

    await page
      .getByRole('button', { name: /start blank/i })
      .first()
      .click()

    const { master, notice } = await settleMaster(page, masterUrl, 'blank', () => toastText(page))

    if (EXPECT === 'allowed') {
      // The gated `putObject` went through: the master download now exists.
      expect(master, `expected the blank master to exist; notice="${notice}"`).toBe(200)
    } else {
      // The authoritative oracle: the download route still has NO master, i.e.
      // the gated storage write was refused and the transaction rolled back.
      expect(master, `expected NO blank master while frozen; notice="${notice}"`).toBe(404)
      console.log(`[refused] Start blank notice (doc=${documentId}): ${notice}`)
      expect(notice, `expected a visible refusal while frozen; doc=${documentId}`).not.toBe('')
    }
  })

  test(`Word import is ${EXPECT} in the isolated tenant`, async ({ page }) => {
    const documentId = await createEmptyDocument(page)
    const masterUrl = `${TEST_URL}/documents/${documentId}/master`
    const fixture = readFileSync(FIXTURE)

    await page
      .getByRole('button', { name: /import word file/i })
      .first()
      .click()
    await page.waitForTimeout(1000)
    await page.locator('input[type=file]').first().setInputFiles(FIXTURE)

    const { master, notice } = await settleMaster(page, masterUrl, 'import', () =>
      uploaderErrorText(page),
    )

    if (EXPECT === 'allowed') {
      // The presigned upload path went through and the bytes are the fixture.
      expect(master, `expected the imported master to exist; notice="${notice}"`).toBe(200)
      expect(sha256(await masterBytes(page, masterUrl))).toBe(sha256(fixture))
    } else {
      // `requestUpload` refuses the presign and reports it inline in the uploader.
      expect(master, `expected NO imported master while frozen; notice="${notice}"`).toBe(404)
      console.log(`[refused] Word import notice (doc=${documentId}): ${notice}`)
      expect(notice, `expected a visible refusal while frozen; doc=${documentId}`).not.toBe('')
    }
  })
})
