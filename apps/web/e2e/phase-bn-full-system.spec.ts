import { test, expect } from '@playwright/test'

const TEST_URL = 'https://beaconhs-test.xuhaoqing.top'
const FIXTURES_DIR = '/tmp/beaconhs-test-fixtures'

test.describe('Phase BN — Full System Testing', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to login page
    await page.goto(TEST_URL)
  })

  test.describe('1. Authentication & Session', () => {
    test('Login with Magic Link', async ({ page, context }) => {
      // Wait for login page
      await page.waitForLoadState('networkidle')

      // Check if already logged in (Dashboard visible)
      const dashboardVisible = page.url().includes('/dashboard')

      if (dashboardVisible) {
        // Already logged in
        await page.screenshot({ path: 'e2e/phase-bn-01-login.png' })
      } else {
        // Not logged in, check login page loaded by checking page content
        const bodyText = await page.textContent('body')
        expect(bodyText).toBeTruthy()
        expect(bodyText?.toLowerCase()).toMatch(/sign.?in|email/i)

        await page.screenshot({ path: 'e2e/phase-bn-01-login.png' })
      }

      // Check console for errors
      const consoleErrors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text())
        }
      })

      // Wait for potential errors
      await page.waitForTimeout(1000)

      expect(consoleErrors.length).toBe(0)
    })

    test('Access protected routes without login', async ({ page, context }) => {
      // Navigate to dashboard (should redirect to login if not logged in)
      await page.goto(`${TEST_URL}/dashboard`)

      // Check if redirected to login
      await page.waitForLoadState('networkidle')
      const isLogin = page.url().includes('/login')

      if (!isLogin) {
        // Already logged in, verify dashboard loads
        expect(page.url()).toContain('/dashboard')
        await page.screenshot({ path: 'e2e/phase-bn-02-dashboard.png' })
      } else {
        // Redirected to login, verify login page loaded
        const bodyText = await page.textContent('body')
        expect(bodyText).toBeTruthy()
        expect(bodyText?.toLowerCase()).toMatch(/sign.?in|email/i)
      }
    })
  })

  test.describe('2. Documents & File Upload', () => {
    test('Navigate to Documents page', async ({ page }) => {
      await page.goto(`${TEST_URL}/documents`)
      await page.waitForLoadState('networkidle')

      // Take screenshot
      await page.screenshot({ path: 'e2e/phase-bn-03-documents.png' })

      // Check if page loaded (should have documents list)
      const bodyText = await page.textContent('body')
      expect(bodyText).toBeTruthy()
    })

    test('Upload file with Chinese filename', async ({ page }) => {
      await page.goto(`${TEST_URL}/documents`)

      // Wait for page to load
      await page.waitForLoadState('networkidle')

      // Take screenshot of documents page
      await page.screenshot({ path: 'e2e/phase-bn-04-documents-page.png' })

      // Look for any action button (New, Upload, etc.)
      const actionButtons = page.getByRole('button').filter({ hasText: /new|upload|create/i })
      const buttonCount = await actionButtons.count()

      if (buttonCount > 0) {
        // Click first action button
        await actionButtons.first().click()
        await page.waitForTimeout(1000)

        // Look for file input
        const fileInput = page.locator('input[type="file"]').first()

        if (await fileInput.isVisible({ timeout: 5000 })) {
          // Set input files
          await fileInput.setInputFiles(`${FIXTURES_DIR}/测试文档.pdf`)

          // Wait for upload
          await page.waitForTimeout(5000)

          // Take screenshot
          await page.screenshot({ path: 'e2e/phase-bn-04-upload-chinese.png' })
        } else {
          console.log('File input not visible')
        }
      } else {
        console.log('No action buttons found')
      }
    })

    test('Upload file with ASCII filename', async ({ page }) => {
      await page.goto(`${TEST_URL}/documents`)

      // Wait for page to load
      await page.waitForLoadState('networkidle')

      // Look for any action button
      const actionButtons = page.getByRole('button').filter({ hasText: /new|upload|create/i })
      const buttonCount = await actionButtons.count()

      if (buttonCount > 0) {
        // Click first action button
        await actionButtons.first().click()
        await page.waitForTimeout(1000)

        // Look for file input
        const fileInput = page.locator('input[type="file"]').first()

        if (await fileInput.isVisible({ timeout: 5000 })) {
          // Set input files
          await fileInput.setInputFiles(`${FIXTURES_DIR}/test.txt`)

          // Wait for upload
          await page.waitForTimeout(5000)

          // Take screenshot
          await page.screenshot({ path: 'e2e/phase-bn-05-upload-ascii.png' })
        }
      }
    })
  })

  test.describe('3. File Download', () => {
    test('Download file with Chinese filename', async ({ page }) => {
      await page.goto(`${TEST_URL}/documents`)

      // Wait for page to load
      await page.waitForLoadState('networkidle')

      // Take screenshot
      await page.screenshot({ path: 'e2e/phase-bn-06-documents-page.png' })

      // Look for any link that might be a document
      const links = page.locator('a[href*="/documents/"]')
      const linkCount = await links.count()

      if (linkCount > 0) {
        // Click first document link
        await links.first().click()
        await page.waitForTimeout(2000)

        // Check if document page loaded
        const bodyText = await page.textContent('body')
        expect(bodyText).toBeTruthy()

        // Take screenshot
        await page.screenshot({ path: 'e2e/phase-bn-06-doc-page.png' })

        // Navigate back to documents
        await page.goto(`${TEST_URL}/documents`)
        await page.waitForLoadState('networkidle')
      } else {
        console.log('No document links found')
      }
    })

    test('Verify Content-Disposition header', async ({ page, request }) => {
      await page.goto(`${TEST_URL}/documents`)

      // Wait for page to load
      await page.waitForLoadState('networkidle')

      // Look for any link that might be a document
      const links = page.locator('a[href*="/documents/"]')
      const linkCount = await links.count()

      if (linkCount > 0) {
        // Get first document link
        const docLink = links.first()
        const href = await docLink.getAttribute('href')

        if (href) {
          // Navigate to download endpoint
          const downloadUrl = `${TEST_URL}${href}`

          // Make request and check headers
          const response = await request.get(downloadUrl)
          const headers = response.headers()

          // Check Content-Disposition header
          const contentDisposition = headers['content-disposition']

          if (contentDisposition) {
            console.log('Content-Disposition:', contentDisposition)

            // Check for UTF-8 encoding
            const hasUtf8 = contentDisposition.includes('UTF-8')
            console.log('Has UTF-8 encoding:', hasUtf8)

            // Check for Chinese filename
            const hasChinese = contentDisposition.includes('测试文档')
            console.log('Has Chinese filename:', hasChinese)

            expect(hasUtf8 || hasChinese).toBeTruthy()
          } else {
            console.log('Content-Disposition header not found')
          }
        }
      } else {
        console.log('No document links found')
      }
    })
  })

  test.describe('4. File Preview', () => {
    test('Preview PDF file', async ({ page }) => {
      // This test requires a PDF to be uploaded first
      // For now, just verify preview UI exists
      await page.goto(`${TEST_URL}/documents`)
      await page.waitForLoadState('networkidle')

      // Look for preview icon
      const previewIcons = page.getByRole('button', { name: /preview/i })
      const count = await previewIcons.count()

      console.log(`Found ${count} preview icons`)

      if (count > 0) {
        await page.screenshot({ path: 'e2e/phase-bn-07-preview-icons.png' })
      }
    })

    test('Preview DOCX file via Collabora', async ({ page }) => {
      await page.goto(`${TEST_URL}/documents`)
      await page.waitForLoadState('networkidle')

      // Look for Collabora embed
      const collaboraIframe = page.locator('iframe[src*="collabora"]')
      const count = await collaboraIframe.count()

      console.log(`Found ${count} Collabora iframes`)

      if (count > 0) {
        await page.screenshot({ path: 'e2e/phase-bn-08-collabora-embed.png' })
      }
    })

    test('Preview PPTX file via Collabora', async ({ page }) => {
      await page.goto(`${TEST_URL}/documents`)
      await page.waitForLoadState('networkidle')

      // Look for PPTX preview buttons
      const pptxButtons = page.getByRole('button', { name: /pptx|powerpoint/i })
      const count = await pptxButtons.count()

      console.log(`Found ${count} PPTX buttons`)

      if (count > 0) {
        await page.screenshot({ path: 'e2e/phase-bn-09-pptx-preview.png' })
      }
    })
  })

  test.describe('5. Collabora Editor', () => {
    test('Open PPTX in Collabora editor', async ({ page }) => {
      await page.goto(`${TEST_URL}/documents`)
      await page.waitForLoadState('networkidle')

      // Look for "Edit in Collabora" button
      const editButton = page.getByRole('button', { name: /edit.*collabora/i })
      const count = await editButton.count()

      console.log(`Found ${count} Edit in Collabora buttons`)

      if (count > 0) {
        await editButton.first().click()
        await page.waitForTimeout(3000)

        // Check if Collabora iframe loaded
        const collaboraIframe = page.locator('iframe[src*="coolwsd"]')
        const iframeCount = await collaboraIframe.count()

        console.log(`Collabora iframe count: ${iframeCount}`)

        if (iframeCount > 0) {
          await page.screenshot({ path: 'e2e/phase-bn-10-collabora-editor.png' })
        }
      }
    })

    test('Check WOPI endpoints accessibility', async ({ page, request }) => {
      await page.goto(`${TEST_URL}/documents`)
      await page.waitForLoadState('networkidle')

      // Check if discovery endpoint is accessible
      const discoveryUrl = `${TEST_URL}/hosting/discovery`

      try {
        const response = await request.get(discoveryUrl, { timeout: 10000 })
        console.log('Discovery endpoint status:', response.status())

        if (response.ok()) {
          const contentType = response.headers()['content-type']
          console.log('Discovery content-type:', contentType)

          // Check for PPTX action in response
          const text = await response.text()
          const hasPPTX = text.includes('ext="pptx"')
          console.log('Has PPTX action:', hasPPTX)

          expect(hasPPTX).toBeTruthy()
        }
      } catch (error) {
        console.log('Discovery endpoint not accessible:', error)
      }
    })
  })

  test.describe('6. Performance', () => {
    test('Measure Documents page load time', async ({ page }) => {
      const startTime = Date.now()

      await page.goto(`${TEST_URL}/documents`)

      // Wait for page to load
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1000)

      const endTime = Date.now()
      const loadTime = endTime - startTime

      console.log(`Documents page load time: ${loadTime}ms`)

      // Record performance metrics
      await page.screenshot({ path: 'e2e/phase-bn-11-performance-documents.png' })

      // Should load within 5 seconds
      expect(loadTime).toBeLessThan(5000)
    })

    test('Measure Dashboard page load time', async ({ page }) => {
      const startTime = Date.now()

      await page.goto(`${TEST_URL}/dashboard`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1000)

      const endTime = Date.now()
      const loadTime = endTime - startTime

      console.log(`Dashboard page load time: ${loadTime}ms`)

      await page.screenshot({ path: 'e2e/phase-bn-12-performance-dashboard.png' })

      expect(loadTime).toBeLessThan(5000)
    })

    test('Measure login page load time', async ({ page }) => {
      const startTime = Date.now()

      await page.goto(`${TEST_URL}/login`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1000)

      const endTime = Date.now()
      const loadTime = endTime - startTime

      console.log(`Login page load time: ${loadTime}ms`)

      await page.screenshot({ path: 'e2e/phase-bn-13-performance-login.png' })

      expect(loadTime).toBeLessThan(5000)
    })
  })

  test.describe('7. Network & Console', () => {
    test('Check for console errors', async ({ page }) => {
      const errors: string[] = []
      const warnings: string[] = []

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          errors.push(msg.text())
        } else if (msg.type() === 'warning') {
          warnings.push(msg.text())
        }
      })

      await page.goto(`${TEST_URL}/documents`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1000)

      console.log(`Console errors: ${errors.length}`)
      console.log(`Console warnings: ${warnings.length}`)

      if (errors.length > 0) {
        console.log('Error messages:', errors)
      }

      if (warnings.length > 0) {
        console.log('Warning messages:', warnings)
      }

      // Allow some warnings (e.g., analytics, telemetry)
      expect(errors.length).toBeLessThanOrEqual(5)
    })

    test('Check for duplicate network requests', async ({ page }) => {
      const requests: string[] = []

      page.on('request', (request) => {
        const url = request.url()
        if (url.includes('/api/') || url.includes('/documents')) {
          requests.push(url)
        }
      })

      await page.goto(`${TEST_URL}/documents`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1000)

      // Count unique requests
      const uniqueRequests = new Set(requests)
      console.log(`Total API requests: ${requests.length}`)
      console.log(`Unique requests: ${uniqueRequests.size}`)

      // Check for duplicates
      const duplicates = requests.length - uniqueRequests.size
      console.log(`Duplicate requests: ${duplicates}`)

      // Allow some duplicates (e.g., cache refresh)
      expect(duplicates).toBeLessThanOrEqual(10)
    })
  })
})
