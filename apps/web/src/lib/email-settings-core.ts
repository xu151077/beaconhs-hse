// Shared, request-context-free email-settings logic.
//
// WHY THIS FILE EXISTS
// --------------------
// Two call sites need the same email-provider behaviour:
//
//   * apps/web/src/lib/email-settings-actions.ts — the native pages, authorized
//     by a tenant-bound RequestContext (super-admin for the platform scope).
//   * apps/web/src/app/setup/actions.ts — the first-run setup flow, authorized
//     by a session plus the native `isSuperAdmin` flag, because a greenfield
//     platform has no tenant yet and therefore no RequestContext.
//
// The parsing, validation, transport resolution and test-send behaviour must
// NOT be written twice: a second copy would drift, and the drift would be
// invisible until a credential failed to save or a test send reported a
// different outcome than the platform page.
//
// So the logic lives here, with no knowledge of how the caller is authorized.
// Each caller keeps its own authorization and its own audit trail.
//
// NOTHING IN THIS FILE READS OR LOGS A SECRET. The stored credential is a
// sealed blob; only the transport layer ever decrypts it, and the test-send
// failure path reports the provider and the error NAME, never the message.

import {
  isEmailProvider,
  isEmailPolicyMode,
  isValidEmailAddress,
  resolveEffectiveTransport,
  resolveEmailTransport,
  sendVia,
  type EmailPolicyMode,
  type EmailProvider,
  type EmailTransport,
} from '@beaconhs/emails'
import type { EmailSettingsInput } from '@/lib/email-config'

/**
 * Localised copy for the provider-settings validation surface.
 *
 * Kept structurally identical to the translator the native actions use so the
 * same message keys render in the setup flow.
 */
export type ProviderSettingsTranslator = (
  key: 'invalidEmailProvider' | 'invalidEmailPolicy' | 'fieldTooLong' | 'smtpHostNotPublic',
  values?: { field?: string; max?: number },
) => string

/**
 * Marks a rejected user configuration — an unknown provider, an over-long
 * field, or a blocked SMTP host. These are expected outcomes of editing the
 * form, so the actions return them for in-form display. Anything else
 * (permissions, database, unknown faults) keeps propagating to the route error
 * boundary rather than being flattened into a message that would hide the real
 * failure.
 */
export class ValidationFailure extends Error {}

/**
 * Aborts parsing at the first bad field. A control-flow signal, never shown;
 * the action catches it and returns the `ValidationFailure` message instead.
 */
class FieldTooLongError extends Error {}

function readTrimmedField(
  fd: FormData,
  name: string,
  maxLength: number,
  t: ProviderSettingsTranslator,
): string {
  const value = String(fd.get(name) ?? '').trim()
  if (value.length > maxLength) {
    throw new FieldTooLongError(t('fieldTooLong', { field: name, max: maxLength }))
  }
  return value
}

/** Parse the provider form into the save input, or throw a ValidationFailure. */
export function parseEmailSettingsInput(
  fd: FormData,
  t: ProviderSettingsTranslator,
): EmailSettingsInput {
  const providerRaw = String(fd.get('provider') ?? '')
  if (!isEmailProvider(providerRaw)) {
    throw new ValidationFailure(t('invalidEmailProvider'))
  }
  const provider: EmailProvider = providerRaw
  try {
    const smtpPortRaw = readTrimmedField(fd, 'smtpPort', 5, t)
    return {
      enabled: fd.get('enabled') === 'on',
      provider,
      fromName: readTrimmedField(fd, 'fromName', 128, t),
      fromEmail: readTrimmedField(fd, 'fromEmail', 254, t),
      replyTo: readTrimmedField(fd, 'replyTo', 254, t),
      mailgunDomain: readTrimmedField(fd, 'mailgunDomain', 253, t),
      mailgunRegion: fd.get('mailgunRegion') === 'eu' ? 'eu' : 'us',
      smtpHost: readTrimmedField(fd, 'smtpHost', 253, t),
      smtpPort: smtpPortRaw ? Number(smtpPortRaw) : 0,
      smtpSecure: fd.get('smtpSecure') === 'on',
      smtpUsername: readTrimmedField(fd, 'smtpUsername', 320, t),
      secret: readTrimmedField(fd, 'secret', 4_096, t) || undefined,
    }
  } catch (error) {
    if (error instanceof FieldTooLongError) {
      throw new ValidationFailure(error.message)
    }
    throw error
  }
}

/** Read the policy mode from the platform form. */
export function parseEmailPolicyMode(
  fd: FormData,
  t: ProviderSettingsTranslator,
): { ok: true; mode: EmailPolicyMode } | { ok: false; error: string } {
  const modeRaw = String(fd.get('mode') ?? 'tenant_optional')
  if (modeRaw !== 'tenant_optional' && modeRaw !== 'global_only' && modeRaw !== 'disabled') {
    return { ok: false, error: t('invalidEmailPolicy') }
  }
  return { ok: true, mode: modeRaw }
}

/**
 * Reject an SMTP host that cannot provide the TLS identity the transport
 * needs, BEFORE a configuration transaction holds any row lock. DNS must never
 * run inside the locked save.
 *
 * A blocked host is a rejected user configuration, not a broken system: the
 * caller returns it so the operator reads why in the form rather than losing it
 * to the route error boundary.
 */
export async function validateEmailSmtpHost(
  input: EmailSettingsInput,
  active: boolean,
  t: ProviderSettingsTranslator,
  resolvePublicHost: (
    host: string,
    options: { timeoutMs: number },
  ) => Promise<{ ipLiteral: boolean }>,
): Promise<void> {
  if (!active || input.provider !== 'smtp') return
  try {
    const resolved = await resolvePublicHost(input.smtpHost, { timeoutMs: 10_000 })
    if (resolved.ipLiteral) {
      throw new Error('IP literals cannot provide the required SMTP TLS hostname identity.')
    }
  } catch {
    throw new ValidationFailure(t('smtpHostNotPublic'))
  }
}

/** Why a test send could not be attempted. */
export type EmailTestBlock =
  { kind: 'blocked'; reason: string } | { kind: 'transport'; transport: EmailTransport }

/**
 * Resolve the SAVED transport for a test send.
 *
 * The platform policy is checked FIRST for both scopes, in this order:
 *
 *   1. an unknown policy mode is a corrupt configuration and blocks sending;
 *   2. the platform kill switch blocks sending;
 *   3. while the platform enforces its own provider, a TENANT test send is
 *      refused BEFORE the tenant credential is read — a tenant must not be able
 *      to route around the platform's provider, and the tenant's credential
 *      must not even be loaded when the policy forbids it.
 *
 * Only then is the scope's own transport resolved.
 */
export async function resolveEmailTestTransport(args: {
  scope: 'tenant' | 'platform'
  readPlatformRaw: () => Promise<Record<string, unknown>>
  readTenantRaw: () => Promise<Parameters<typeof resolveEmailTransport>[0]>
}): Promise<EmailTestBlock> {
  const platform = await args.readPlatformRaw()
  const rawMode = (platform as { mode?: unknown }).mode
  const knownMode = rawMode === undefined || isEmailPolicyMode(rawMode)
  const platformDelivery = resolveEffectiveTransport(platform, null, { tenantScoped: false })
  if (!knownMode) {
    return {
      kind: 'blocked',
      reason: 'Email is blocked because the platform policy is invalid. Contact an administrator.',
    }
  }
  if (platformDelivery.kind === 'suppressed') {
    return { kind: 'blocked', reason: 'Email is disabled by the platform kill switch.' }
  }
  if (args.scope === 'tenant' && rawMode === 'global_only') {
    return {
      kind: 'blocked',
      reason: 'Tenant email is unavailable while the platform provider is enforced.',
    }
  }
  if (args.scope === 'platform') {
    if (platformDelivery.kind !== 'transport') {
      return {
        kind: 'blocked',
        reason: 'Save a provider, sender address and credential first, then send a test.',
      }
    }
    return { kind: 'transport', transport: platformDelivery.transport }
  }
  const tenantTransport = resolveEmailTransport(await args.readTenantRaw())
  if (!tenantTransport) {
    return {
      kind: 'blocked',
      reason: 'Save a provider, sender address and credential first, then send a test.',
    }
  }
  return { kind: 'transport', transport: tenantTransport }
}

/**
 * Send one test email through an already-resolved transport.
 *
 * The failure path reports the provider and the error NAME only. The provider
 * message can contain the rejected address, the negotiated TLS version or the
 * server's own banner — none of which belongs in a UI message, and all of
 * which can carry credentials in an SMTP AUTH exchange.
 */
export async function deliverEmailTestEmail(
  transport: EmailTransport,
  to: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await sendVia(transport, {
      to,
      subject: 'BeaconHS test email',
      text: `This is a test email from BeaconHS, sent via ${transport.provider}. If you received it, your email provider is configured correctly.`,
      html: `<p>This is a test email from <strong>BeaconHS</strong>, sent via <strong>${transport.provider}</strong>.</p><p>If you received it, your email provider is configured correctly.</p>`,
    })
    return { ok: true, message: `Test email sent to ${to} via ${transport.provider}.` }
  } catch (error) {
    console.error('[email-settings] provider rejected a test send', {
      provider: transport.provider,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    return {
      ok: false,
      message: `Could not send the test email via ${transport.provider}. Check the saved credential and verified sender, then try again.`,
    }
  }
}

/** Validate a test-email destination. */
export function assertEmailTestDestination(to: string): string | null {
  if (!isValidEmailAddress(to)) return 'Enter a destination email address to send a test.'
  return null
}
