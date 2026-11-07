import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Structural contract for the E2E evidence policy. The Phase CT WOPI failure
// could not be analysed after the fact because no trace survived: the config
// used `on-first-retry`, local runs never retry, and the artifacts were later
// cleaned. These assertions keep the retention default from silently regressing.

const config = readFileSync(new URL('../../playwright.config.ts', import.meta.url), 'utf8')
const gitignore = readFileSync(new URL('../../../../.gitignore', import.meta.url), 'utf8')

describe('E2E trace retention contract', () => {
  it('records a trace for every run and keeps it when the run fails', () => {
    expect(config).toContain("trace: 'retain-on-failure'")
    expect(config).not.toContain("trace: 'off'")
    expect(config).not.toContain("trace: 'on-first-retry'")
  })

  it('keeps traces out of version control', () => {
    expect(gitignore.split('\n')).toContain('test-results/')
  })

  it('targets an already-running deployment, so a failure is never masked by a local server', () => {
    expect(config).not.toContain('webServer')
  })
})
