import { describe, expect, it } from 'vitest'
import { appDeleteRefusal, responseDeleteRefusal } from './delete-policy'

describe('builder delete policy', () => {
  it('allows deleting an app with no responses and no automations', () => {
    expect(appDeleteRefusal({ hasResponses: false, hasAutomations: false })).toBeNull()
  })

  it('refuses an app that still has responses', () => {
    expect(appDeleteRefusal({ hasResponses: true, hasAutomations: false })).toMatch(/responses/)
  })

  it('refuses an app that still has automations', () => {
    expect(appDeleteRefusal({ hasResponses: false, hasAutomations: true })).toMatch(/automations/)
  })

  it('explains responses before automations when both exist', () => {
    expect(appDeleteRefusal({ hasResponses: true, hasAutomations: true })).toMatch(/responses/)
  })

  it('allows deleting an ordinary response', () => {
    expect(responseDeleteRefusal({ complianceObligationId: null })).toBeNull()
  })

  it('refuses a response that is compliance evidence', () => {
    expect(
      responseDeleteRefusal({ complianceObligationId: '0b0f0f0f-0000-4000-8000-000000000001' }),
    ).toMatch(/compliance evidence/)
  })
})
