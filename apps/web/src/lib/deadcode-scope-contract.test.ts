import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import knipConfig from '../../../../knip'

const rootWorkspace = (
  knipConfig as unknown as {
    workspaces: Record<string, { ignore?: string[]; ignoreDependencies?: string[] }>
  }
).workspaces['.']
const rootPackage = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> }
const webPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { devDependencies?: Record<string, string> }
const playwrightConfig = readFileSync(
  new URL('../../playwright.config.ts', import.meta.url),
  'utf8',
)

describe('dead-code scan scope', () => {
  it('only ignores repo-root operator scratch directories', () => {
    expect((rootWorkspace?.ignore ?? []).every((pattern) => pattern.startsWith('.tmp-*/'))).toBe(
      true,
    )
  })

  it('keeps the Playwright dependency genuinely used instead of ignoring it', () => {
    expect(rootWorkspace?.ignoreDependencies ?? []).not.toContain('@playwright/test')
    expect(rootPackage.scripts?.['test:e2e']).toContain('playwright')
    expect(webPackage.devDependencies?.['@playwright/test']).toBeTruthy()
    expect(playwrightConfig).toContain("from '@playwright/test'")
  })
})
