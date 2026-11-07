import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Phase BO — end-to-end closure suite.
 *
 * Unlike the earlier Phase BN suite, every test here asserts a concrete,
 * reproducible outcome against the LIVE test environment:
 *
 *   Scenario A — Collabora open → edit → save persists into the DOCX master.
 *   Scenario B — upload → download is byte-identical (SHA-256) and the
 *                Content-Disposition preserves the original filename
 *                (RFC 5987 `filename*=UTF-8''…` for Chinese names).
 *   Coverage   — every navigation module loads for an authenticated user.
 *   Security   — protected modules redirect an anonymous caller to /login.
 *
 * Authentication: the suite signs in with a captured Better-Auth session
 * (env `E2E_STORAGE_STATE`, default `/tmp/beaconhs-e2e-auth.json`) so it can
 * exercise authenticated surfaces. The file lives outside the repo.
 */

const TEST_URL = process.env.E2E_BASE_URL ?? 'https://beaconhs-test.xuhaoqing.top'
const FIXTURES_DIR = process.env.E2E_FIXTURES_DIR ?? '/tmp/beaconhs-test-fixtures'
const AUTH_FILE = process.env.E2E_STORAGE_STATE ?? '/tmp/beaconhs-e2e-auth.json'
const CHINESE_DOCX = join(FIXTURES_DIR, '测试文档.docx')

// Nav registry modules — the same list the sidebar resolves from.
const MODULE_ROUTES = [
  '/dashboard',
  '/assistant',
  '/feed',
  '/my',
  '/notifications',
  '/inspections',
  '/hazard-assessments',
  '/journals',
  '/observations',
  '/incidents',
  '/corrective-actions',
  '/tools',
  '/training',
  '/documents',
  '/help',
  '/people',
  '/locations',
  '/equipment',
  '/ppe',
  '/compliance',
  '/insights',
  '/reports',
  '/admin',
  '/apps',
]

test.use({ storageState: AUTH_FILE })

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Read one entry out of a zip (the DOCX master) using the host `unzip`. */
function unzipEntry(bytes: Buffer, entry: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bo-docx-'))
  const file = join(dir, 'master.docx')
  writeFileSync(file, bytes)
  return execFileSync('unzip', ['-p', file, entry], { maxBuffer: 32 * 1024 * 1024 }).toString(
    'utf8',
  )
}

/** Create a fresh document and start the server-side blank DOCX master. */
async function createBlankDocument(page: Page): Promise<string> {
  await page.goto(`${TEST_URL}/documents`)
  await page
    .getByRole('button', { name: /new document/i })
    .first()
    .click()
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}/)
  const id = page.url().split('/documents/')[1]!.split(/[?#]/)[0]!
  await page
    .getByRole('button', { name: /start blank/i })
    .first()
    .click()
  await expect(page.getByRole('button', { name: /^Write$/ }).last()).toBeVisible({
    timeout: 60_000,
  })
  return id
}

/** Wait for the Collabora Writer frame to finish loading. */
async function waitForCollabora(page: Page) {
  await page
    .getByRole('button', { name: /^Write$/ })
    .last()
    .click()
  await expect
    .poll(() => page.frames().some((f) => f.url().includes('cool.html')), { timeout: 60_000 })
    .toBe(true)
  const frame = page.frames().find((f) => f.url().includes('cool.html'))!
  // The canvas only exists once Writer has mounted; a short settle lets the
  // status bar / page metrics finish before we type.
  await frame.locator('#document-canvas').waitFor({ state: 'visible', timeout: 90_000 })
  await page.waitForTimeout(2500)
  return frame
}

test.describe('Phase BO — E2E closure', () => {
  test.describe.configure({ timeout: 180_000 })

  test('Scenario A — Collabora edit + save persists into the master DOCX', async ({
    page,
    request,
  }) => {
    const id = await createBlankDocument(page)
    const frame = await waitForCollabora(page)

    const marker = `BHS-BO-COLLABORA-${Date.now()}`
    await frame.locator('body').click({ position: { x: 420, y: 360 } })
    await page.waitForTimeout(800)
    await page.keyboard.type(marker)
    await page.waitForTimeout(1500)

    // Save through the editor's own Ctrl+S (Collabora handles it in-frame).
    await page.keyboard.press('Control+s')
    await page.waitForTimeout(6000)

    // The persisted artifact is the source of truth: download the master and
    // assert the marker is really inside word/document.xml.
    const resp = await request.get(`${TEST_URL}/documents/${id}/master`)
    expect(resp.status()).toBe(200)
    const xml = unzipEntry(await resp.body(), 'word/document.xml')
    expect(xml).toContain(marker)
  })

  test('Scenario B — upload → download is byte-identical and keeps its Unicode name', async ({
    page,
    request,
  }) => {
    const id = await createBlankDocument(page)
    const fixture = readFileSync(CHINESE_DOCX)
    const fixtureSha = sha256(fixture)

    // Import the Chinese-named DOCX as the working master.
    await page
      .getByRole('button', { name: /^Replace$/ })
      .last()
      .click()
    await page.waitForTimeout(1500)
    await page.locator('input[type=file]').first().setInputFiles(CHINESE_DOCX)

    const masterUrl = `${TEST_URL}/documents/${id}/master`
    // The import lands asynchronously; poll until the master is the fixture.
    await expect
      .poll(
        async () => {
          const r = await request.get(masterUrl)
          return sha256(await r.body())
        },
        { timeout: 60_000 },
      )
      .toBe(fixtureSha)

    // Integrity: the bytes that come back are the bytes that went in.
    const resp = await request.get(masterUrl)
    const body = await resp.body()
    expect(body.length).toBe(fixture.length)
    expect(sha256(body)).toBe(fixtureSha)

    // Filename: RFC 5987 extended parameter carries the original Chinese name,
    // and the plain `filename` parameter is a conformant ASCII fallback (RFC 6266).
    const cd = resp.headers()['content-disposition'] ?? ''
    console.log(`[Scenario B] raw Content-Disposition: ${cd}`)
    expect(cd).toContain("filename*=UTF-8''")
    const encoded = cd.split("filename*=UTF-8''")[1]!
    expect(decodeURIComponent(encoded)).toBe('测试文档.docx')

    // The whole header must be ASCII: the plain parameter is the fallback a
    // browser that ignores `filename*` would save, so it cannot carry raw UTF-8
    // or an unterminated quote.
    expect(cd).toMatch(/^[\x20-\x7E]+$/)
    const plain = cd.split('filename="')[1]!.split('"')[0]!
    expect(plain).toMatch(/\.docx$/)
    expect(plain).not.toMatch(/["\\\r\n]/)
    expect(decodeURIComponent(encoded)).not.toBe(plain)

    // Browser-level confirmation: what the download dialog would actually save.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.goto(masterUrl, { waitUntil: 'commit' }).catch(() => undefined),
    ])
    expect(download.suggestedFilename()).toBe('测试文档.docx')
  })

  // NOTE: the app authenticates client-side. The SSR shell answers 200 for a
  // protected route and the shell then navigates to /login, so an
  // APIRequestContext probe cannot observe the guard — these checks drive a
  // real browser and assert the FINAL url.
  test('Coverage — every navigation module renders for an authenticated user', async ({ page }) => {
    const failures: string[] = []
    for (const route of MODULE_ROUTES) {
      const resp = await page.goto(`${TEST_URL}${route}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      const status = resp?.status() ?? 0
      if (status >= 400 || page.url().includes('/login') || !page.url().includes(route)) {
        failures.push(`${route} → ${status} @ ${page.url()}`)
      }
    }
    expect(failures, `modules that failed to render:\n${failures.join('\n')}`).toEqual([])
  })
})

test.describe('Phase BO — anonymous access is refused', () => {
  test.use({ storageState: { cookies: [], origins: [] } })
  test.describe.configure({ timeout: 90_000 })

  test('Protected modules redirect an anonymous caller to /login', async ({ page }) => {
    for (const route of ['/dashboard', '/documents', '/admin', '/platform/tenants']) {
      await page.goto(`${TEST_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await expect
        .poll(() => page.url(), { timeout: 20_000, message: `${route} must land on /login` })
        .toContain('/login')
    }
  })
})
