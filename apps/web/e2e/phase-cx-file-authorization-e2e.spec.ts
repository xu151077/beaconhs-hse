import { test, expect, type Page } from '@playwright/test'

const TEST_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const SITE_A_STORAGE = process.env.CX_SITE_A_STORAGE ?? '/tmp/opencode/phase-cx-site-a-auth.json'
const CROSS_STORAGE = process.env.CX_CROSS_STORAGE ?? '/tmp/opencode/phase-cx-cross-auth.json'

// Authorization refusal statuses.
//
// A refusal must never be reported as 500: that made "you may not" look like
// "we broke". The routes now cross `withRouteErrors`, which maps ForbiddenError
// and ImpersonationBlockedError to 403. A 404 is the established answer when a
// resource's existence is hidden from the caller (cross-tenant reads). The
// assertion therefore accepts only 403/404 and explicitly rejects 5xx.
function expectDenied(status: number): void {
  expect([403, 404]).toContain(status)
  expect(status).toBeLessThan(500)
}

function expectLoginChallenge(status: number): void {
  // requireRequestContext redirects an unauthenticated caller to /login; a
  // direct 401 is also an established answer.
  expect([301, 302, 303, 307, 308, 401]).toContain(status)
}

// Land on a stable route before issuing in-page fetches.
//
// The app root issues a client-side redirect from `/` to `/dashboard` once the
// session resolves. `page.goto('/')` returns at `load`, which is BEFORE that
// redirect completes, so an immediately-following `page.evaluate` can have its
// execution context destroyed — a test-driver race, not an authorization
// outcome. Navigating straight to the authenticated landing route removes the
// redirect from the critical path without changing any assertion.
async function landOnApp(page: Page): Promise<void> {
  await page.goto(`${TEST_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForURL('**/dashboard', { timeout: 15_000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
}

test.describe('Phase CX — file authorization matrix', () => {
  test.describe('site-scoped user', () => {
    test.use({ storageState: SITE_A_STORAGE })

    test('sees only its own site incidents', async ({ page }) => {
      await page.goto(`${TEST_URL}/incidents`)
      await expect(page.getByText('Hand tool dropped from scaffold').first()).toBeAttached()
      await expect(page.getByText('Slip on wet floor in mechanical room')).toHaveCount(0)
    })

    test('cannot open another site incident by URL', async ({ page }) => {
      await page.goto(`${TEST_URL}/incidents/4f2ab438-d89f-4a99-b9fb-690442334691`)
      await expect(page.getByText('Page not found')).toBeVisible()
    })

    test('cannot download a cross-tenant attachment', async ({ page }) => {
      await landOnApp(page)
      const status = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' })
        return res.status
      }, `${TEST_URL}/api/attachments/cae6c747-1138-4545-911d-646e61fdb606`)
      expect(status).toBe(404)
    })

    test('cannot download a cross-tenant document master', async ({ page }) => {
      await landOnApp(page)
      const response = await page.request.get(
        `${TEST_URL}/documents/6362fee2-3339-4fa2-8de4-757b80bfb120/master`,
        {
          maxRedirects: 0,
        },
      )
      expectDenied(response.status())
    })

    test('cannot export incidents without export permission', async ({ page }) => {
      await landOnApp(page)
      const status = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' })
        return res.status
      }, `${TEST_URL}/incidents/export.csv`)
      expectDenied(status)
    })

    test('cannot download a cross-tenant published version', async ({ page }) => {
      await landOnApp(page)
      const status = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' })
        return res.status
      }, `${TEST_URL}/documents/6362fee2-3339-4fa2-8de4-757b80bfb120/versions/00000000-0000-0000-0000-000000000000/download`)
      expectDenied(status)
    })
  })

  test.describe('unauthenticated caller', () => {
    test.use({ storageState: { cookies: [], origins: [] } })

    test('is challenged at the login boundary, not served a 500', async ({ request }) => {
      const response = await request.get(
        `${TEST_URL}/documents/6362fee2-3339-4fa2-8de4-757b80bfb120/master`,
        { maxRedirects: 0 },
      )
      expectLoginChallenge(response.status())
    })

    test('is challenged before the incidents export runs', async ({ request }) => {
      const response = await request.get(`${TEST_URL}/incidents/export.csv`, {
        maxRedirects: 0,
      })
      expectLoginChallenge(response.status())
    })
  })

  test.describe('cross-tenant user', () => {
    test.use({ storageState: CROSS_STORAGE })

    test('cannot open a document from another tenant by URL', async ({ page }) => {
      await page.goto(`${TEST_URL}/documents/6362fee2-3339-4fa2-8de4-757b80bfb120`)
      await expect(page.getByText('Page not found')).toBeVisible()
    })

    test('cannot read an incident from another tenant by URL', async ({ page }) => {
      await page.goto(`${TEST_URL}/incidents/50b3f232-afca-4f6c-951b-ef989e621b1c`)
      await expect(page.getByText('Page not found')).toBeVisible()
    })
  })
})
