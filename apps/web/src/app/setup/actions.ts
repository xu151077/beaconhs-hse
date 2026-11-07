'use server'

// Server actions for the first-run setup flow.
//
// AUTHORIZATION MODEL
// -------------------
// Three different authorizations, each the narrowest that works:
//
//   1. Creating the first administrator needs NO session — nobody can sign in
//      yet. The gate is the DATABASE: the action refuses unless no super-admin
//      exists. That is the same refusal the native bootstrap business layer
//      makes, and it means the surface is closed the moment the first
//      administrator exists, with no flag to flip and no way to reopen it.
//
//   2. Configuring the platform email provider needs a SIGNED-IN platform
//      administrator. It cannot use `requireRequestContext()` because a
//      greenfield platform has no tenant, and the context deliberately
//      resolves to null in that case. It uses the session plus the native
//      `isSuperAdmin` flag instead — the same flag `can()` and
//      `makeSuperAdminContext` honour everywhere else.
//
//   3. Creating the first workspace needs a SIGNED-IN platform administrator
//      too, and additionally refuses when any workspace already exists.
//
// NO PERMISSION IS WIDENED. No role, scope, permission key or RLS policy is
// created, relaxed or bypassed. The setup flow only ever writes the platform's
// existing `isSuperAdmin` flag, the platform settings row and the first
// workspace — through the same business functions the native pages use.
//
// SECRETS
// -------
// The administrator's password is read from the form and handed straight to
// Better Auth's own scrypt hasher. It is never logged, never echoed, never
// written to the database in plaintext, and never included in an audit
// record. The SMTP password is sealed by `sealSecret` inside the shared
// email-config layer and is never returned by a read.

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { assertBootstrapEmail, bootstrapFirstAdmin } from '@beaconhs/auth'
import { getPlatformEmailRaw, savePlatformEmailSettings } from '@/lib/email-config'
import { getSignedInSuperAdminId } from '@/lib/auth'
import { resolvePublicHost } from '@beaconhs/sync/egress'
import {
  consumeFirstRunAttempt,
  createFirstWorkspace,
  firstRunPasswordProblems,
  isFirstRunSetupOpen,
} from '@/lib/first-run-setup'
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

export type FirstRunActionResult = {
  ok?: boolean
  error?: string
  message?: string
  /**
   * Several independent problems, each of them a translatable sentence.
   *
   * They are returned as a list rather than one joined string so the page can
   * translate each one: a joined string has no catalogue key.
   */
  details?: string[]
}

/**
 * A stable, non-secret identifier for the calling client, used to rate limit
 * the setup attempts.
 *
 * Two buckets are combined in the caller: this per-client bucket AND a fixed
 * global bucket. The per-client bucket alone is weak — a caller who rotates
 * X-Forwarded-For mints unlimited budget — but the per-client header is the
 * only signal available through the tunnel, so the global ceiling is the
 * backstop that keeps total attempts bounded regardless of header games.
 * The identifier is never an identity and never logged on its own.
 */
async function clientIdentifier(): Promise<string> {
  const headerList = await headers()
  // The proxy overwrites x-real-ip; x-forwarded-for's first entry is the
  // client's own claim and must not be trusted for bucketing.
  const realIp = headerList.get('x-real-ip')?.trim()
  if (realIp) return realIp.slice(0, 64)
  const forwarded = headerList.get('x-forwarded-for')
  const last = forwarded?.split(',').pop()?.trim()
  if (last) return last.slice(0, 64)
  return 'unknown-client'
}

const GLOBAL_RATE_LIMIT_BUCKET = 'global'

/**
 * Record a setup event.
 *
 * The audit trail for a greenfield setup has two halves. The DURABLE half is
 * the database itself: the `user` row with its creation timestamp, the
 * `platform_settings` row, and the day-one `audit_log` row that
 * `provisionFirstTenant` writes inside the new workspace's own log. The
 * EVENT half is this line.
 *
 * It carries no password, no credential and no secret — only the fact that a
 * step was attempted, who it was for, and whether it succeeded. `audit_log`
 * cannot hold the pre-tenant steps because its `tenant_id` is NOT NULL and
 * references `tenants`; adding a global audit table would need a migration,
 * which this change does not introduce.
 */
function recordSetupEvent(event: string, detail: Record<string, unknown>): void {
  console.info(
    JSON.stringify({
      event: `first_run_setup.${event}`,
      at: new Date().toISOString(),
      ...detail,
    }),
  )
}

/**
 * Step 1 — create the first platform administrator.
 *
 * The password policy is deliberately stricter than the sign-in floor: this
 * account exists before there is any tenant, any role assignment or any
 * tenant-scoped audit row, so a compromise here cannot be reconstructed from
 * the product's own records.
 */
export async function createFirstRunAdmin(
  _prev: FirstRunActionResult | null,
  formData: FormData,
): Promise<FirstRunActionResult> {
  const email = String(formData.get('email') ?? '').trim()
  const name = String(formData.get('name') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!(await isFirstRunSetupOpen())) {
    recordSetupEvent('admin_refused', { reason: 'already_initialized' })
    return { error: 'This platform is already initialized. Sign in instead.' }
  }

  const attempt = await consumeFirstRunAttempt({
    step: 'admin',
    clientId: await clientIdentifier(),
  })
  if (!attempt.allowed) {
    recordSetupEvent('admin_rate_limited', { retryAfterSeconds: attempt.retryAfterSeconds })
    return { error: 'Too many attempts. Try again later.' }
  }

  let normalizedEmail: string
  try {
    normalizedEmail = assertBootstrapEmail(email)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Enter a valid email address.' }
  }

  const problems = firstRunPasswordProblems(password)
  if (problems.length > 0) {
    recordSetupEvent('admin_rejected', { reason: 'password_policy' })
    return { details: problems }
  }

  const result = await bootstrapFirstAdmin({
    email: normalizedEmail,
    ...(name ? { name } : {}),
    password,
  })

  if (result.outcome === 'already_bootstrapped') {
    recordSetupEvent('admin_refused', { reason: 'already_initialized' })
    return { error: 'This platform is already initialized. Sign in instead.' }
  }
  if (result.outcome === 'email_taken') {
    recordSetupEvent('admin_rejected', { reason: 'email_taken' })
    return { error: 'That address is already registered. Sign in instead.' }
  }

  // No email in the log: the address is PII and already lives on the user row.
  recordSetupEvent('admin_created', { created: true })
  return { ok: true, message: 'Administrator created. Sign in to continue the setup.' }
}

/**
 * Step 2 — save the platform email provider.
 *
 * Only a signed-in platform administrator may do this, and the credential is
 * sealed by the shared email-config layer before it reaches the database.
 */
export async function saveFirstRunPlatformEmail(
  _prev: FirstRunActionResult | null,
  formData: FormData,
): Promise<FirstRunActionResult> {
  const adminId = await getSignedInSuperAdminId()
  if (!adminId) {
    recordSetupEvent('email_save_refused', { reason: 'not_super_admin' })
    return { error: 'Sign in as the platform administrator to continue.' }
  }

  const t: ProviderSettingsTranslator = await getTranslations('ProviderSettings')
  const mode = parseEmailPolicyMode(formData, t)
  if (!mode.ok) return { error: mode.error }

  let input
  try {
    input = parseEmailSettingsInput(formData, t)
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
  recordSetupEvent('email_saved', {
    provider: input.provider,
    mode: mode.mode,
    enabled: input.enabled,
    ...change,
  })
  revalidatePath('/setup')
  return { ok: true }
}

/**
 * Step 2 — send a test email through the SAVED platform provider.
 *
 * The destination is required and validated; the outcome is one of the same
 * explicit results the native platform page reports. A provider rejection is
 * reported as the provider plus the error NAME, never the raw message, which
 * can carry the server banner or the negotiated credentials.
 */
export async function sendFirstRunTestEmail(input: {
  to: string
}): Promise<{ ok: boolean; message: string }> {
  const adminId = await getSignedInSuperAdminId()
  if (!adminId) {
    return { ok: false, message: 'Sign in as the platform administrator to continue.' }
  }

  const to = input.to.trim()
  const invalidDestination = assertEmailTestDestination(to)
  if (invalidDestination) return { ok: false, message: invalidDestination }

  const attempt = await consumeFirstRunAttempt({
    step: 'email_test',
    clientId: await clientIdentifier(),
  })
  if (!attempt.allowed) {
    return { ok: false, message: 'Too many test emails. Try again later.' }
  }

  let resolved
  try {
    resolved = await resolveEmailTestTransport({
      scope: 'platform',
      readPlatformRaw: getPlatformEmailRaw,
      readTenantRaw: async () => {
        throw new Error('not used in the platform scope')
      },
    })
  } catch (error) {
    console.error('[first-run-setup] saved provider could not be resolved', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    return {
      ok: false,
      message:
        'The saved email provider could not be loaded. Check the configuration and try again.',
    }
  }
  if (resolved.kind === 'blocked') return { ok: false, message: resolved.reason }

  const result = await deliverEmailTestEmail(resolved.transport, to)
  recordSetupEvent('email_test', { ok: result.ok, provider: resolved.transport.provider })
  return result
}

/**
 * Step 3 — create the first workspace.
 *
 * Refuses when a workspace already exists (the native business layer's own
 * guard) and is rate limited per client. The workspace, its built-in roles
 * and its day-one audit row are written by the same `provisionFirstTenant`
 * primitive the documented CLI uses.
 */
export async function createFirstRunTenant(
  _prev: FirstRunActionResult | null,
  formData: FormData,
): Promise<FirstRunActionResult> {
  const adminId = await getSignedInSuperAdminId()
  if (!adminId) {
    recordSetupEvent('tenant_refused', { reason: 'not_super_admin' })
    return { error: 'Sign in as the platform administrator to continue.' }
  }

  const name = String(formData.get('name') ?? '').trim()
  const slug = String(formData.get('slug') ?? '').trim()
  const region = String(formData.get('region') ?? '').trim()
  const defaultLanguage = String(formData.get('defaultLanguage') ?? 'en').trim() || 'en'

  if (!name) {
    recordSetupEvent('tenant_rejected', { reason: 'missing_name' })
    return { error: 'Enter a workspace name.' }
  }

  const attempt = await consumeFirstRunAttempt({
    step: 'tenant',
    clientId: await clientIdentifier(),
  })
  if (!attempt.allowed) {
    recordSetupEvent('tenant_rate_limited', { retryAfterSeconds: attempt.retryAfterSeconds })
    return { error: 'Too many attempts. Try again later.' }
  }

  const result = await createFirstWorkspace({
    name,
    ...(slug ? { slug } : {}),
    ...(region ? { region } : {}),
    defaultLanguage,
    enabledLanguages: [defaultLanguage],
  })

  if (result.outcome === 'already_provisioned') {
    recordSetupEvent('tenant_refused', { reason: 'already_provisioned' })
    return { error: 'This platform already has a workspace.' }
  }

  recordSetupEvent('tenant_created', { slug: result.tenantSlug })
  revalidatePath('/setup')
  return { ok: true, message: 'Workspace created.' }
}
