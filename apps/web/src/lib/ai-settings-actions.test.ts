import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  savePlatform: vi.fn(),
  saveTenant: vi.fn(),
  listModels: vi.fn(),
  pingModel: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next-intl/server', () => ({
  // Returns the English catalogue copy so assertions read like what an operator sees.
  getTranslations: async (namespace: string) => {
    const catalogue = (await import('@beaconhs/i18n/messages')).getAppMessages('en')
    const section = catalogue[namespace as 'ProviderSettings'] as unknown as Record<string, string>
    return (key: string, values?: Record<string, unknown>) =>
      (section[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values?.[name] ?? `{${name}}`),
      )
  },
}))
vi.mock('@/lib/auth', () => ({ requireRequestContext: mocks.auth }))
vi.mock('@/lib/audit', () => ({ recordAudit: mocks.audit }))
vi.mock('@beaconhs/ai', () => ({
  isAiProvider: (value: unknown) => value === 'anthropic' || value === 'openai',
  listModels: mocks.listModels,
  pingModel: mocks.pingModel,
}))
vi.mock('@/lib/ai-config', () => ({
  clearPlatformAiKey: vi.fn(),
  clearTenantAiKey: vi.fn(),
  getPlatformAiConfig: vi.fn(),
  getTenantOwnAiConfig: vi.fn(),
  savePlatformAiSettings: mocks.savePlatform,
  saveTenantAiSettings: mocks.saveTenant,
}))

import { savePlatformAi, saveTenantAi } from './ai-settings-actions'

const context = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  isSuperAdmin: true,
}

function settingsForm(extra: Record<string, string> = {}) {
  const form = new FormData()
  const values = {
    enabled: 'on',
    provider: 'anthropic',
    modelFast: 'claude-fast',
    modelSmart: 'claude-smart',
    baseUrl: '',
    apiKey: '',
    ...extra,
  }
  for (const [key, value] of Object.entries(values)) form.set(key, value)
  return form
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue(context)
  mocks.audit.mockResolvedValue(undefined)
  mocks.savePlatform.mockResolvedValue(undefined)
  mocks.saveTenant.mockResolvedValue(undefined)
})

describe('AI settings validation', () => {
  it('returns an invalid provider in-form instead of silently coercing it to a default', async () => {
    const result = await saveTenantAi(null, settingsForm({ provider: 'not-a-provider' }))

    // Coercing to 'anthropic' would save the wrong provider while looking like a
    // successful save. An unrecognised provider is a rejected configuration.
    expect(result).toEqual({ error: 'Select a valid AI provider.' })
    expect(mocks.saveTenant).not.toHaveBeenCalled()
  })

  it('returns ok on a valid save so the form can clear a previous error', async () => {
    const result = await saveTenantAi(null, settingsForm())

    expect(result).toEqual({ ok: true })
    expect(mocks.saveTenant).toHaveBeenCalledOnce()
  })

  it('propagates a database failure instead of reporting a successful save', async () => {
    mocks.saveTenant.mockRejectedValue(new Error('deadlock detected'))

    await expect(saveTenantAi(null, settingsForm())).rejects.toThrow('deadlock detected')
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('keeps the tenant permission gate a hard failure, not a form error', async () => {
    mocks.auth.mockResolvedValue({
      ...context,
      isSuperAdmin: false,
      permissions: new Set<string>(),
    })

    await expect(saveTenantAi(null, settingsForm())).rejects.toThrow(
      'Missing permission: admin.settings.manage',
    )
    expect(mocks.saveTenant).not.toHaveBeenCalled()
  })

  it('keeps the platform gate super-admin only', async () => {
    mocks.auth.mockResolvedValue({
      ...context,
      isSuperAdmin: false,
      permissions: new Set(['admin.settings.manage']),
    })

    await expect(savePlatformAi(null, settingsForm({ mode: 'tenant_optional' }))).rejects.toThrow(
      'Only platform super-admins',
    )
    expect(mocks.savePlatform).not.toHaveBeenCalled()
  })

  it('never returns or audits an API key', async () => {
    const apiKey = 'sk-ant-must-never-be-audited'

    const result = await saveTenantAi(null, settingsForm({ apiKey }))

    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(apiKey)
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })
})
