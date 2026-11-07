import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  consumeRateLimit: vi.fn(),
  getPlatformRaw: vi.fn(),
  getTenantRaw: vi.fn(),
  resolveEffective: vi.fn(),
  resolveTransport: vi.fn(),
  resolvePublicHost: vi.fn(),
  clearTenant: vi.fn(),
  savePlatform: vi.fn(),
  saveTenant: vi.fn(),
  sendVia: vi.fn(),
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
vi.mock('@beaconhs/jobs/rate-limit', () => ({ consumeRateLimit: mocks.consumeRateLimit }))
vi.mock('@beaconhs/sync/egress', () => ({ resolvePublicHost: mocks.resolvePublicHost }))
vi.mock('@beaconhs/emails', () => ({
  isEmailProvider: (value: unknown) => value === 'sendgrid' || value === 'smtp',
  isEmailPolicyMode: (value: unknown) =>
    value === 'tenant_optional' || value === 'global_only' || value === 'disabled',
  isValidEmailAddress: (value: string) =>
    /^[A-Za-z0-9.+_-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}$/.test(value),
  resolveEffectiveTransport: mocks.resolveEffective,
  resolveEmailTransport: mocks.resolveTransport,
  sendVia: mocks.sendVia,
}))
vi.mock('@/lib/email-config', () => ({
  clearTenantEmailKey: mocks.clearTenant,
  getPlatformEmailRaw: mocks.getPlatformRaw,
  getTenantEmailRaw: mocks.getTenantRaw,
  savePlatformEmailSettings: mocks.savePlatform,
  saveTenantEmailSettings: mocks.saveTenant,
}))

import { savePlatformEmail, saveTenantEmail, testEmailConnection } from './email-settings-actions'

const context = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  isSuperAdmin: true,
}

const transport = {
  provider: 'sendgrid' as const,
  apiKey: 'SG.must-never-be-audited',
  from: 'BeaconHS <beacon@example.com>',
}

const unchanged = {
  previousProvider: 'sendgrid',
  providerChanged: false,
  credentialChange: 'unchanged',
  enabledChanged: false,
}

function settingsForm(extra: Record<string, string> = {}) {
  const form = new FormData()
  const values = {
    enabled: 'on',
    provider: 'sendgrid',
    fromName: 'BeaconHS',
    fromEmail: 'beacon@example.com',
    replyTo: '',
    mailgunDomain: '',
    mailgunRegion: 'us',
    smtpHost: '',
    smtpPort: '',
    smtpUsername: '',
    ...extra,
  }
  for (const [key, value] of Object.entries(values)) form.set(key, value)
  return form
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue(context)
  mocks.audit.mockResolvedValue(undefined)
  mocks.consumeRateLimit.mockResolvedValue({
    allowed: true,
    count: 1,
    remaining: 4,
    resetAt: new Date(Date.now() + 10 * 60_000),
  })
  mocks.getPlatformRaw.mockResolvedValue({ provider: 'sendgrid' })
  mocks.getTenantRaw.mockResolvedValue({ provider: 'sendgrid' })
  mocks.resolveEffective.mockImplementation((platform: { mode?: unknown }) =>
    platform.mode === 'disabled'
      ? { kind: 'suppressed' }
      : platform.mode !== undefined &&
          platform.mode !== 'tenant_optional' &&
          platform.mode !== 'global_only'
        ? { kind: 'unconfigured' }
        : { kind: 'transport', transport, source: 'platform' },
  )
  mocks.resolveTransport.mockReturnValue(transport)
  mocks.resolvePublicHost.mockResolvedValue({
    hostname: 'smtp.example.com',
    address: '8.8.8.8',
    family: 4,
    ipLiteral: false,
  })
  mocks.clearTenant.mockResolvedValue(unchanged)
  mocks.savePlatform.mockResolvedValue(unchanged)
  mocks.saveTenant.mockResolvedValue(unchanged)
  mocks.sendVia.mockResolvedValue({ id: 'message-1' })
})

describe('email settings audit metadata', () => {
  it('uses the locked save result instead of guessing whether a credential changed', async () => {
    mocks.saveTenant.mockResolvedValue({
      previousProvider: 'resend',
      providerChanged: true,
      credentialChange: 'removed',
      enabledChanged: true,
    })
    await saveTenantEmail(null, settingsForm({ enabled: '', provider: 'sendgrid' }))

    expect(mocks.audit).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        summary: 'Updated tenant email provider override',
        metadata: expect.objectContaining({
          previousProvider: 'resend',
          providerChanged: true,
          credentialChange: 'removed',
        }),
      }),
    )
  })

  it('records platform changes against the platform email singleton', async () => {
    await savePlatformEmail(null, settingsForm({ mode: 'tenant_optional' }))

    expect(mocks.audit).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        entityType: 'platform_email_settings',
        entityId: '00000000-0000-0000-0000-000000000001',
      }),
    )
  })

  it('returns a non-public active SMTP host in-form instead of throwing to the error boundary', async () => {
    mocks.resolvePublicHost.mockRejectedValue(new Error('private address'))

    const result = await saveTenantEmail(
      null,
      settingsForm({ provider: 'smtp', smtpHost: 'mail.internal', smtpPort: '587' }),
    )

    // The public-host requirement is unchanged; only its delivery moves from the
    // error boundary into the form, so the operator can read why.
    expect(result).toEqual({
      error:
        'Active SMTP requires a public, externally resolvable DNS hostname. Private, local, reserved, IP-literal, and unresolvable hosts are blocked.',
    })
    expect(mocks.saveTenant).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('keeps the platform kill switch independent from SMTP DNS', async () => {
    await savePlatformEmail(
      null,
      settingsForm({
        mode: 'disabled',
        provider: 'smtp',
        smtpHost: 'mail.internal',
        smtpPort: '587',
      }),
    )

    expect(mocks.resolvePublicHost).not.toHaveBeenCalled()
    expect(mocks.savePlatform).toHaveBeenCalledOnce()
  })

  it('returns a public IP literal in-form because SMTP requires a TLS DNS identity', async () => {
    mocks.resolvePublicHost.mockResolvedValue({
      hostname: '8.8.8.8',
      address: '8.8.8.8',
      family: 4,
      ipLiteral: true,
    })

    const result = await saveTenantEmail(
      null,
      settingsForm({ provider: 'smtp', smtpHost: '8.8.8.8', smtpPort: '587' }),
    )

    expect(result.error).toContain('Active SMTP requires a public')
    expect(mocks.saveTenant).not.toHaveBeenCalled()
  })

  it('returns an invalid provider in-form and never reaches the locked save', async () => {
    const result = await saveTenantEmail(null, settingsForm({ provider: 'not-a-provider' }))

    expect(result).toEqual({ error: 'Select a valid email provider.' })
    expect(mocks.saveTenant).not.toHaveBeenCalled()
  })

  it('returns an invalid platform policy in-form', async () => {
    const result = await savePlatformEmail(null, settingsForm({ mode: 'nonsense-policy' }))

    expect(result).toEqual({ error: 'Select a valid platform email policy.' })
    expect(mocks.savePlatform).not.toHaveBeenCalled()
  })

  it('returns an over-long hostname in-form rather than throwing', async () => {
    const result = await saveTenantEmail(
      null,
      settingsForm({
        provider: 'sendgrid',
        smtpHost: 'a'.repeat(254),
      }),
    )

    expect(result).toEqual({ error: 'smtpHost must be 253 characters or fewer.' })
    expect(mocks.saveTenant).not.toHaveBeenCalled()
  })

  it('returns ok on a valid save so the form can clear a previous error', async () => {
    const result = await saveTenantEmail(null, settingsForm())

    expect(result).toEqual({ ok: true })
    expect(mocks.saveTenant).toHaveBeenCalledOnce()
  })

  it('propagates a database failure instead of reporting a successful save', async () => {
    mocks.saveTenant.mockRejectedValue(new Error('deadlock detected'))

    await expect(saveTenantEmail(null, settingsForm())).rejects.toThrow('deadlock detected')
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('keeps the tenant permission gate a hard failure, not a form error', async () => {
    mocks.auth.mockResolvedValue({
      ...context,
      isSuperAdmin: false,
      permissions: new Set<string>(),
    })

    await expect(saveTenantEmail(null, settingsForm())).rejects.toThrow(
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

    await expect(
      savePlatformEmail(null, settingsForm({ mode: 'tenant_optional' })),
    ).rejects.toThrow('Only platform super-admins')
    expect(mocks.savePlatform).not.toHaveBeenCalled()
  })

  it('never returns or audits a credential, on success or on rejection', async () => {
    const secret = 'SG.must-never-be-audited'

    await saveTenantEmail(null, settingsForm({ provider: 'sendgrid', secret }))
    const rejected = await saveTenantEmail(
      null,
      settingsForm({ provider: 'sendgrid', secret, smtpHost: 'a'.repeat(254) }),
    )

    const auditJson = JSON.stringify(mocks.audit.mock.calls)
    expect(auditJson).not.toContain(secret)
    expect(JSON.stringify(rejected)).not.toContain(secret)
  })
})

describe('testEmailConnection', () => {
  it('rejects and audits an invalid destination before consuming rate-limit capacity', async () => {
    const result = await testEmailConnection({ scope: 'platform', to: 'not-an-email' })

    expect(result).toEqual({
      ok: false,
      message: 'Enter a destination email address to send a test.',
    })
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled()
    expect(mocks.sendVia).not.toHaveBeenCalled()
    expect(mocks.audit).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: 'invalid_destination', scope: 'platform' }),
      }),
    )
  })

  it('rate-limits and audits a successful test without persisting recipient or secrets', async () => {
    const result = await testEmailConnection({ scope: 'platform', to: 'operator@example.com' })

    expect(result).toEqual({
      ok: true,
      message: 'Test email sent to operator@example.com via sendgrid.',
    })
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith({
      key: 'email-provider-test:platform:user-1',
      limit: 5,
      windowSeconds: 600,
    })
    expect(mocks.sendVia).toHaveBeenCalledOnce()
    const auditJson = JSON.stringify(mocks.audit.mock.calls[0])
    expect(auditJson).toContain('succeeded')
    expect(auditJson).toContain('sendgrid')
    expect(auditJson).not.toContain('operator@example.com')
    expect(auditJson).not.toContain('SG.must-never-be-audited')
  })

  it('audits and rejects a request after the Redis limit is exhausted', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      count: 6,
      remaining: 0,
      resetAt: new Date(Date.now() + 120_000),
    })
    const result = await testEmailConnection({ scope: 'tenant', to: 'operator@example.com' })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Too many test emails')
    expect(mocks.getTenantRaw).not.toHaveBeenCalled()
    expect(mocks.sendVia).not.toHaveBeenCalled()
    expect(mocks.audit).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: 'rate_limited', scope: 'tenant' }),
      }),
    )
  })

  it('does not bypass the platform kill switch with a direct test send', async () => {
    mocks.getPlatformRaw.mockResolvedValue({
      mode: 'disabled',
      enabled: true,
      provider: 'sendgrid',
    })
    const result = await testEmailConnection({ scope: 'platform', to: 'operator@example.com' })

    expect(result).toEqual({ ok: false, message: 'Email is disabled by the platform kill switch.' })
    expect(mocks.resolveTransport).not.toHaveBeenCalled()
    expect(mocks.sendVia).not.toHaveBeenCalled()
    expect(mocks.audit).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: 'policy_blocked', scope: 'platform' }),
      }),
    )
  })

  it('does not bypass a forced platform policy with a direct tenant test send', async () => {
    mocks.getPlatformRaw.mockResolvedValue({ mode: 'global_only', provider: 'sendgrid' })
    const result = await testEmailConnection({ scope: 'tenant', to: 'operator@example.com' })

    expect(result).toEqual({
      ok: false,
      message: 'Tenant email is unavailable while the platform provider is enforced.',
    })
    expect(mocks.getTenantRaw).not.toHaveBeenCalled()
    expect(mocks.sendVia).not.toHaveBeenCalled()
  })

  it('fails closed when the stored platform policy is unknown', async () => {
    mocks.getPlatformRaw.mockResolvedValue({
      mode: 'corrupt-policy',
      enabled: true,
      provider: 'sendgrid',
    })
    const result = await testEmailConnection({ scope: 'platform', to: 'operator@example.com' })

    expect(result).toEqual({
      ok: false,
      message: 'Email is blocked because the platform policy is invalid. Contact an administrator.',
    })
    expect(mocks.resolveTransport).not.toHaveBeenCalled()
    expect(mocks.sendVia).not.toHaveBeenCalled()
    expect(mocks.audit).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: 'policy_blocked', scope: 'platform' }),
      }),
    )
  })

  it('fails closed and audits when the Redis limiter is unavailable', async () => {
    mocks.consumeRateLimit.mockRejectedValue(new Error('redis password must not leak'))
    const result = await testEmailConnection({ scope: 'tenant', to: 'operator@example.com' })

    expect(result).toEqual({
      ok: false,
      message: 'Test email is temporarily unavailable. Try again in a minute.',
    })
    expect(mocks.sendVia).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('redis password')
    expect(mocks.audit).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: 'rate_limit_unavailable' }),
      }),
    )
  })

  it('returns a generic provider failure and audits no provider error details', async () => {
    mocks.sendVia.mockRejectedValue(
      new Error('Authorization Bearer SG.must-never-be-audited; recipient operator@example.com'),
    )
    const result = await testEmailConnection({ scope: 'tenant', to: 'operator@example.com' })

    expect(result.ok).toBe(false)
    expect(result.message).toBe(
      'Could not send the test email via sendgrid. Check the saved credential and verified sender, then try again.',
    )
    const auditJson = JSON.stringify(mocks.audit.mock.calls)
    expect(auditJson).toContain('failed')
    expect(auditJson).not.toContain('operator@example.com')
    expect(auditJson).not.toContain('SG.must-never-be-audited')
  })
})
