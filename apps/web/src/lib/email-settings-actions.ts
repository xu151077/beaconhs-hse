'use server'

import { revalidatePath } from 'next/cache'
import { getTranslations } from 'next-intl/server'
import { assertCan, type RequestContext } from '@beaconhs/tenant'
import type { ProviderSettingsResult } from '@beaconhs/i18n/messages'
import { consumeRateLimit } from '@beaconhs/jobs/rate-limit'
import { PLATFORM_SETTINGS_ID } from '@beaconhs/db/schema'
import { resolvePublicHost } from '@beaconhs/sync/egress'
import { requireRequestContext } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import {
  clearTenantEmailKey,
  getPlatformEmailRaw,
  getTenantEmailRaw,
  savePlatformEmailSettings,
  saveTenantEmailSettings,
} from '@/lib/email-config'
import {
  assertEmailTestDestination,
  deliverEmailTestEmail,
  parseEmailPolicyMode,
  parseEmailSettingsInput,
  resolveEmailTestTransport,
  validateEmailSmtpHost,
  ValidationFailure,
  type ProviderSettingsTranslator,
} from '@/lib/email-settings-core'

function gateTenant(ctx: RequestContext) {
  if (!ctx.isSuperAdmin) assertCan(ctx, 'admin.settings.manage')
}

function gatePlatform(ctx: RequestContext) {
  if (!ctx.isSuperAdmin)
    throw new Error('Only platform super-admins can change global email settings.')
}

export async function saveTenantEmail(
  _prev: ProviderSettingsResult | null,
  formData: FormData,
): Promise<ProviderSettingsResult> {
  const ctx = await requireRequestContext()
  gateTenant(ctx)
  const t: ProviderSettingsTranslator = await getTranslations('ProviderSettings')
  let input
  try {
    input = parseEmailSettingsInput(formData, t)
    // DNS must never run while the configuration transaction holds row locks.
    // The locked save re-checks platform policy after this network validation.
    await validateEmailSmtpHost(input, input.enabled, t, resolvePublicHost)
  } catch (error) {
    if (error instanceof ValidationFailure) return { error: error.message }
    throw error
  }
  const change = await saveTenantEmailSettings(ctx, input)
  await recordAudit(ctx, {
    entityType: 'tenant',
    entityId: ctx.tenantId,
    action: 'update',
    summary: 'Updated tenant email provider override',
    metadata: {
      provider: input.provider,
      enabled: input.enabled,
      ...change,
    },
  })
  revalidatePath('/admin/email')
  return { ok: true }
}

export async function clearTenantEmail() {
  const ctx = await requireRequestContext()
  gateTenant(ctx)
  const change = await clearTenantEmailKey(ctx)
  await recordAudit(ctx, {
    entityType: 'tenant',
    entityId: ctx.tenantId,
    action: 'update',
    summary: 'Removed tenant email credential and disabled the provider override',
    metadata: change,
  })
  revalidatePath('/admin/email')
}

type EmailTestScope = 'tenant' | 'platform'
type EmailTestOutcome =
  | 'succeeded'
  | 'failed'
  | 'invalid_destination'
  | 'rate_limited'
  | 'rate_limit_unavailable'
  | 'policy_blocked'
  | 'not_configured'

const TEST_EMAIL_LIMIT = 5
const TEST_EMAIL_WINDOW_SECONDS = 10 * 60

async function auditEmailTest(
  ctx: RequestContext,
  scope: EmailTestScope,
  outcome: EmailTestOutcome,
  provider?: string,
  retryAfterSeconds?: number,
) {
  await recordAudit(ctx, {
    entityType: scope === 'platform' ? 'platform_email_settings' : 'tenant_email_settings',
    entityId: scope === 'platform' ? PLATFORM_SETTINGS_ID : ctx.tenantId,
    action: 'update',
    summary: `Email provider test ${outcome.replaceAll('_', ' ')}`,
    metadata: {
      scope,
      outcome,
      ...(provider ? { provider } : {}),
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
  })
}

export async function savePlatformEmail(
  _prev: ProviderSettingsResult | null,
  formData: FormData,
): Promise<ProviderSettingsResult> {
  const ctx = await requireRequestContext()
  gatePlatform(ctx)
  const t: ProviderSettingsTranslator = await getTranslations('ProviderSettings')
  const mode = parseEmailPolicyMode(formData, t)
  if (!mode.ok) return { error: mode.error }
  let input
  try {
    input = parseEmailSettingsInput(formData, t)
    // The kill switch remains immediate and network-independent. Live SMTP is
    // validated before the locked configuration transaction begins.
    await validateEmailSmtpHost(
      input,
      mode.mode !== 'disabled' && input.enabled,
      t,
      resolvePublicHost,
    )
  } catch (error) {
    if (error instanceof ValidationFailure) return { error: error.message }
    throw error
  }
  const change = await savePlatformEmailSettings({ ...input, mode: mode.mode })
  await recordAudit(ctx, {
    entityType: 'platform_email_settings',
    entityId: PLATFORM_SETTINGS_ID,
    action: 'update',
    summary: `Updated platform email settings (policy: ${mode.mode})`,
    metadata: { provider: input.provider, mode: mode.mode, enabled: input.enabled, ...change },
  })
  revalidatePath('/platform/email')
  return { ok: true }
}

/**
 * Send a real test email through the SAVED config for the given scope. Save
 * first, then test — mirrors the AI "Test connection" action.
 */
export async function testEmailConnection(input: {
  scope: EmailTestScope
  to: string
}): Promise<{ ok: boolean; message: string }> {
  if (input.scope !== 'tenant' && input.scope !== 'platform') {
    throw new Error('Select a valid email settings scope.')
  }
  const ctx = await requireRequestContext()
  if (input.scope === 'platform') gatePlatform(ctx)
  else gateTenant(ctx)

  const to = input.to.trim()
  const invalidDestination = assertEmailTestDestination(to)
  if (invalidDestination) {
    await auditEmailTest(ctx, input.scope, 'invalid_destination')
    return { ok: false, message: invalidDestination }
  }

  let rate
  try {
    const rateKey =
      input.scope === 'platform'
        ? `email-provider-test:platform:${ctx.userId}`
        : `email-provider-test:tenant:${ctx.tenantId}:${ctx.userId}`
    rate = await consumeRateLimit({
      key: rateKey,
      limit: TEST_EMAIL_LIMIT,
      windowSeconds: TEST_EMAIL_WINDOW_SECONDS,
    })
  } catch (error) {
    console.error('[email-settings] test-send rate limiter unavailable', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    await auditEmailTest(ctx, input.scope, 'rate_limit_unavailable')
    return {
      ok: false,
      message: 'Test email is temporarily unavailable. Try again in a minute.',
    }
  }

  if (!rate.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1_000))
    const retryMinutes = Math.ceil(retryAfterSeconds / 60)
    await auditEmailTest(ctx, input.scope, 'rate_limited', undefined, retryAfterSeconds)
    return {
      ok: false,
      message: `Too many test emails. Try again in ${retryMinutes} ${retryMinutes === 1 ? 'minute' : 'minutes'}.`,
    }
  }

  let resolved
  try {
    resolved = await resolveEmailTestTransport({
      scope: input.scope,
      readPlatformRaw: getPlatformEmailRaw,
      readTenantRaw: () => getTenantEmailRaw(ctx),
    })
  } catch (error) {
    console.error('[email-settings] saved provider could not be resolved', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    await auditEmailTest(ctx, input.scope, 'failed')
    return {
      ok: false,
      message:
        'The saved email provider could not be loaded. Check the configuration and try again.',
    }
  }

  if (resolved.kind === 'blocked') {
    await auditEmailTest(ctx, input.scope, 'policy_blocked')
    return { ok: false, message: resolved.reason }
  }

  const result = await deliverEmailTestEmail(resolved.transport, to)
  await auditEmailTest(
    ctx,
    input.scope,
    result.ok ? 'succeeded' : 'failed',
    resolved.transport.provider,
  )
  return result
}
