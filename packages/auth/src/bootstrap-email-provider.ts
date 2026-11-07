// Production email provider bootstrap.
//
// WHY THIS FILE EXISTS
//
// `db:migrate` creates no user, no tenant, and no email provider.
// `bootstrap-admin` creates the first administrator but does not configure the
// email provider. Without a configured provider, the magic-link email dispatched
// by the admin bootstrap has no transport — it enqueues on the job queue but
// the worker cannot send it, and the first administrator never verifies their
// address.
//
// `bootstrapEmailProvider` writes a platform email provider into
// `platform_settings.email`, sealing the credential with the existing
// `sealSecret` (AES-256-GCM, key derived from BETTER_AUTH_SECRET). The worker
// reads the same column; no new environment variable or secret path is needed.
//
// IDEMPOTENCY
//
// The command overwrites the existing config on every apply. This is intentional:
// the operator can re-run with a corrected secret or changed host, and the
// configuration becomes the single source of truth. A dry run reads the current
// value, merges over it, and validates without writing.
//
// REUSE
//
// No duplicate schema or validation logic. The command uses the same
// `RawEmailConfig` / `PlatformEmailConfig` types, the same `sealSecret` from
// `@beaconhs/crypto`, the same `validateStoredEmailConfig` from
// `@beaconhs/emails`, and the same `resolvePublicHost` check for SMTP hosts.
// The worker continues to read from `platform_settings.email` with no change.

import { eq } from 'drizzle-orm'
import { db, withSuperAdmin } from '@beaconhs/db'
import { platformSettings, PLATFORM_SETTINGS_ID } from '@beaconhs/db/schema'
import {
  isEmailProvider,
  isEmailPolicyMode,
  resolveEmailTransport,
  validateStoredEmailConfig,
  type EmailPolicyMode,
  type EmailProvider,
  type PlatformEmailConfig,
} from '@beaconhs/emails'
import { resolvePublicHost } from '@beaconhs/sync/egress'
import { sealSecret, unsealSecret } from '@beaconhs/crypto'

const MAX_SECRET_LENGTH = 4_096

const DEFAULT_PROVIDER: EmailProvider = 'resend'

function normProvider(p: string | undefined): EmailProvider {
  return isEmailProvider(p) ? p : DEFAULT_PROVIDER
}

function isEmailPolicyModeValue(value: unknown): value is EmailPolicyMode {
  return value === 'tenant_optional' || value === 'global_only' || value === 'disabled'
}

// ---------------------------------------------------------------------------
// Input shape (flat JSON from the operator)
// ---------------------------------------------------------------------------

/**
 * Fields the operator provides in the secret file. All values are plaintext —
 * the bootstrap function seals the password before writing to the database.
 */
export type BootstrapEmailProviderInput = {
  provider?: string
  enabled?: boolean
  fromName?: string
  fromEmail?: string
  replyTo?: string
  mailgunDomain?: string
  mailgunRegion?: 'us' | 'eu'
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  smtpUsername?: string
  /** Plaintext SMTP password; sealed during bootstrap. */
  smtpPassword?: string
  /** Policy mode; overrides the existing mode if provided. */
  mode?: string
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type BootstrapEmailProviderResult =
  | {
      outcome: 'configured'
      provider: string
      mode: EmailPolicyMode
      /** Present only when dry run would have succeeded. */
      dryRun?: true
    }
  | { outcome: 'already_configured'; provider: string; mode: EmailPolicyMode }
  | { outcome: 'dry_run_ok'; provider: string; mode: EmailPolicyMode }
  | {
      outcome: 'dry_run_failed'
      error: string
    }
  | { outcome: 'validation_failed'; error: string }
  | { outcome: 'connectivity_failed'; error: string }

/**
 * Options for {@link bootstrapEmailProvider}.
 *
 * `overwrite` is required to replace an existing working configuration. Without
 * it, an apply against a live provider is refused so a credential rotation or a
 * retried command can never silently clobber production email.
 */
export type BootstrapEmailProviderOptions = {
  apply: boolean
  overwrite?: boolean
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export type PreparedProviderConfig =
  | {
      ok: true
      merged: PlatformEmailConfig
      provider: EmailProvider
      mode: EmailPolicyMode
    }
  | { ok: false; outcome: 'validation_failed' | 'connectivity_failed'; error: string }

/**
 * Validate operator input, merge it over the existing platform config, and
 * prove the result is complete and decryptable — all before any database
 * write.
 *
 * Field-preservation rule: an omitted optional field keeps the existing value;
 * only an explicitly provided value overwrites. In particular a re-run that
 * rotates only the secret never flips `enabled`, `provider` or `mode`, and a
 * same-provider re-run without a new secret keeps the existing sealed pair.
 *
 * Pure with respect to the database (no reads or writes), so unit tests cover
 * every branch without a live database.
 */
export async function prepareProviderConfig(
  input: BootstrapEmailProviderInput,
  existing?: PlatformEmailConfig,
): Promise<PreparedProviderConfig> {
  const prev: PlatformEmailConfig = existing ?? {}
  const fail = (
    outcome: 'validation_failed' | 'connectivity_failed',
    error: string,
  ): PreparedProviderConfig => ({ ok: false, outcome, error })

  // --- Field validation ---

  const provider =
    input.provider !== undefined
      ? normProvider(input.provider)
      : isEmailProvider(prev.provider)
        ? prev.provider
        : DEFAULT_PROVIDER
  if (!isEmailProvider(provider)) {
    return fail('validation_failed', 'Select a valid email provider.')
  }

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return fail('validation_failed', 'Enabled must be a boolean.')
  }
  const enabled = input.enabled ?? prev.enabled ?? true

  const fromEmail = (input.fromEmail ?? '').trim() || prev.fromEmail || ''
  if (!fromEmail) {
    return fail('validation_failed', 'A From email address is required.')
  }
  if (fromEmail.length > 254 || /\s/.test(fromEmail)) {
    return fail(
      'validation_failed',
      'From email must be a valid address (≤254 chars, no whitespace).',
    )
  }

  const fromName = (input.fromName ?? '').trim() || prev.fromName || ''
  if (fromName.length > 128) {
    return fail('validation_failed', 'From name must be 128 characters or fewer.')
  }

  if (input.replyTo !== undefined) {
    const replyTo = (input.replyTo ?? '').trim()
    if (replyTo.length > 254 || /\s/.test(replyTo)) {
      return fail('validation_failed', 'Reply-to must be a valid email address.')
    }
  }

  if (input.mailgunDomain !== undefined) {
    const mailgunDomain = (input.mailgunDomain ?? '').trim()
    if (
      mailgunDomain &&
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(mailgunDomain)
    ) {
      return fail('validation_failed', 'Enter a valid Mailgun sending domain.')
    }
  }

  if (
    input.mailgunRegion !== undefined &&
    input.mailgunRegion !== 'us' &&
    input.mailgunRegion !== 'eu'
  ) {
    return fail('validation_failed', 'Select a valid Mailgun region.')
  }

  const smtpHost = (input.smtpHost ?? '').trim()
  if (input.smtpPort !== undefined) {
    const p = input.smtpPort
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return fail('validation_failed', 'SMTP port must be a whole number from 1 to 65535.')
    }
  }

  if (input.smtpSecure !== undefined && typeof input.smtpSecure !== 'boolean') {
    return fail('validation_failed', 'SMTP TLS mode must be a boolean.')
  }

  const smtpUsername = (input.smtpUsername ?? '').trim()
  if (smtpUsername.length > 320) {
    return fail('validation_failed', 'SMTP username must be 320 characters or fewer.')
  }

  const secret = (input.smtpPassword ?? '').trim()
  if (secret.length > MAX_SECRET_LENGTH) {
    return fail('validation_failed', 'Password is too long.')
  }

  const rawMode = input.mode
  if (rawMode !== undefined && !isEmailPolicyModeValue(rawMode)) {
    return fail('validation_failed', 'Select a valid email policy.')
  }
  const mode: EmailPolicyMode =
    (rawMode as EmailPolicyMode) ??
    (isEmailPolicyModeValue(prev.mode) ? prev.mode : undefined) ??
    'tenant_optional'

  // Seal exactly ONCE: ciphertext and nonce must share one IV. Two independent
  // `sealSecret` calls produce a pair that can never decrypt (AES-GCM binds the
  // auth tag to the IV), which is why the previous code wrote corrupt
  // credentials on every apply carrying a secret.
  const sealed = secret ? sealSecret(secret) : undefined
  const providerUnchanged = prev.provider === undefined || prev.provider === provider
  const keepPreviousCredential =
    !sealed && providerUnchanged && Boolean(prev.keyCiphertext) && Boolean(prev.keyNonce)

  const merged: PlatformEmailConfig = {
    enabled,
    provider,
    fromName: fromName || prev.fromName || undefined,
    fromEmail: fromEmail || prev.fromEmail || undefined,
    replyTo: input.replyTo?.trim() || prev.replyTo || undefined,
    mailgunDomain: input.mailgunDomain?.trim() || prev.mailgunDomain || undefined,
    mailgunRegion: input.mailgunRegion ?? prev.mailgunRegion,
    smtpHost: input.smtpHost?.trim() || prev.smtpHost || undefined,
    smtpPort: input.smtpPort === 0 ? undefined : (input.smtpPort ?? prev.smtpPort),
    smtpSecure: input.smtpSecure ?? prev.smtpSecure,
    smtpUsername: input.smtpUsername?.trim() || prev.smtpUsername || undefined,
    keyCiphertext: sealed?.ciphertext ?? (keepPreviousCredential ? prev.keyCiphertext : undefined),
    keyNonce: sealed?.nonce ?? (keepPreviousCredential ? prev.keyNonce : undefined),
    // `allowNonPublic` has no bootstrap input: never clear what this command
    // cannot set. An operator manages it through the admin UI.
    allowNonPublic: prev.allowNonPublic,
    mode,
  }

  try {
    validateStoredEmailConfig(merged, { requireComplete: true })
  } catch (err) {
    return fail(
      'validation_failed',
      err instanceof Error ? err.message : 'Configuration validation failed.',
    )
  }

  // --- SMTP host connectivity check (runs in both dry run and apply) ---

  if (provider === 'smtp' && merged.smtpHost) {
    try {
      const resolved = await resolvePublicHost(merged.smtpHost, { timeoutMs: 10_000 })
      if (resolved.ipLiteral) {
        return fail('connectivity_failed', 'SMTP host must be a DNS name, not an IP literal.')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'SMTP host could not be resolved.'
      return fail('connectivity_failed', msg)
    }
  }

  // --- Prove decryptability BEFORE any write ---

  if (sealed) {
    const roundTrip = unsealSecret({ ciphertext: sealed.ciphertext, nonce: sealed.nonce })
    if (roundTrip !== secret) {
      return fail(
        'connectivity_failed',
        'The credential could not be sealed with the current BETTER_AUTH_SECRET. ' +
          'Refusing to write an undecryptable credential.',
      )
    }
  } else if (merged.keyCiphertext && merged.keyNonce) {
    const carried = unsealSecret({ ciphertext: merged.keyCiphertext, nonce: merged.keyNonce })
    if (carried === null) {
      return fail(
        'connectivity_failed',
        'The preserved credential no longer decrypts with the current BETTER_AUTH_SECRET. ' +
          'Re-supply the password or API key explicitly.',
      )
    }
  }

  const transport = resolveEmailTransport(merged)
  if (!transport) {
    return fail(
      'connectivity_failed',
      'The merged configuration does not resolve into a usable transport.',
    )
  }

  return { ok: true, merged, provider: transport.provider, mode }
}

/**
 * Report the live provider when the stored config currently resolves to a
 * usable transport, or null when there is nothing working to protect. Used to
 * refuse an accidental overwrite: without an explicit `overwrite`, an apply
 * against a live provider writes nothing.
 */
export function resolveExistingProvider(
  existing?: PlatformEmailConfig | null,
): { provider: string; mode: EmailPolicyMode } | null {
  if (!existing || existing.enabled !== true) return null
  const transport = resolveEmailTransport(existing)
  if (!transport) return null
  return {
    provider: transport.provider,
    mode: isEmailPolicyModeValue(existing.mode) ? existing.mode : 'tenant_optional',
  }
}

export async function bootstrapEmailProvider(
  input: BootstrapEmailProviderInput,
  options: BootstrapEmailProviderOptions,
): Promise<BootstrapEmailProviderResult> {
  const existing = await readExistingPlatformEmail()

  const prepared = await prepareProviderConfig(input, existing)
  if (!prepared.ok) {
    return { outcome: prepared.outcome, error: prepared.error }
  }

  // --- Dry run: validate without writing ---

  if (!options.apply) {
    return { outcome: 'dry_run_ok', provider: prepared.provider, mode: prepared.mode }
  }

  // --- Apply: refuse to clobber a working config without explicit overwrite ---

  if (!options.overwrite) {
    const current = resolveExistingProvider(existing)
    if (current) {
      return {
        outcome: 'already_configured',
        provider: current.provider,
        mode: current.mode,
      }
    }
  }

  // All checks passed before this point, so the single transactional write
  // below cannot leave a half-written or corrupt config behind. There is no
  // wipe-on-failure path: on any error above, the existing config is untouched.
  await withSuperAdmin(db, async (tx) => {
    await tx
      .insert(platformSettings)
      .values({ id: PLATFORM_SETTINGS_ID })
      .onConflictDoNothing({ target: platformSettings.id })
    await tx
      .update(platformSettings)
      .set({ email: prepared.merged, updatedAt: new Date() })
      .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
  })

  return { outcome: 'configured', provider: prepared.provider, mode: prepared.mode }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readExistingPlatformEmail(): Promise<PlatformEmailConfig | undefined> {
  return withSuperAdmin(db, async (tx) => {
    const [row] = await tx
      .select({ email: platformSettings.email })
      .from(platformSettings)
      .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
      .limit(1)
    const raw = row?.email
    return raw && typeof raw === 'object' ? (raw as PlatformEmailConfig) : undefined
  })
}
