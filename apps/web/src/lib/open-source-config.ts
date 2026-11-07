// Open-source disclosure: the public URL of this system's source repository.
// Super-admin managed, deployment-wide (not per-tenant): the license line at
// the bottom of the Dashboard must point at THE system source, so it lives on
// the platform_settings row with the other deployment-wide config (feedback,
// email, sms, ai). Nothing source-related lives in the environment.

import { eq } from 'drizzle-orm'
import { db, withSuperAdmin } from '@beaconhs/db'
import { platformSettings, PLATFORM_SETTINGS_ID } from '@beaconhs/db/schema'

const MAX_URL_LENGTH = 600

type RawOpenSource = {
  url?: unknown
}

export type OpenSourceSettings = {
  /** Empty string means "do not show the source link anywhere". */
  url: string
}

export type OpenSourceSettingsInput = {
  url: string
}

/**
 * Validate and normalize an admin-entered repository URL.
 *
 * Only plain http(s) page addresses are storable: the value is rendered as a
 * link on every Dashboard, so schemes like `javascript:`, protocol-relative
 * addresses, embedded credentials and control characters are rejected rather
 * than shown to every signed-in user. Returns '' when the field is blank
 * (link hidden) and throws on anything else invalid.
 */
export function normalizeOpenSourceUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  // Whitespace and control characters survive URL parsing silently; the
  // address is shown back to every user, so reject them outright.
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) {
      throw new Error('Enter a valid http(s) URL, or leave the field empty.')
    }
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new Error('The URL is too long. Maximum 600 characters.')
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Enter a valid http(s) URL, or leave the field empty.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Enter a valid http(s) URL, or leave the field empty.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('The URL must not contain credentials.')
  }
  return parsed.href
}

export function sanitizeOpenSourceInput(input: OpenSourceSettingsInput): OpenSourceSettings {
  return { url: normalizeOpenSourceUrl(input.url) }
}

async function readPlatformOpenSource(): Promise<RawOpenSource> {
  return withSuperAdmin(db, async (tx) => {
    const [row] = await tx
      .select({ openSource: platformSettings.openSource })
      .from(platformSettings)
      .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
      .limit(1)
    const raw = row?.openSource
    return raw && typeof raw === 'object' ? (raw as RawOpenSource) : {}
  })
}

/**
 * Sanitize a stored value the same way the write path does. The read path
 * must never render a raw row: any value that bypassed `normalizeOpenSourceUrl`
 * (direct SQL, a seed, a future writer) becomes "hidden" rather than a
 * `javascript:` href shown to every signed-in user.
 */
export function sanitizeOpenSourceUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    return normalizeOpenSourceUrl(value)
  } catch {
    return ''
  }
}

/** UI and runtime view (blank url = hidden). */
export async function getPlatformOpenSourceSettings(): Promise<OpenSourceSettings> {
  const raw = await readPlatformOpenSource()
  return { url: sanitizeOpenSourceUrl(raw.url) }
}

export async function savePlatformOpenSourceSettings(
  input: OpenSourceSettingsInput,
): Promise<void> {
  const validated = sanitizeOpenSourceInput(input)
  await withSuperAdmin(db, async (tx) => {
    await tx
      .insert(platformSettings)
      .values({ id: PLATFORM_SETTINGS_ID, openSource: validated })
      .onConflictDoUpdate({ target: platformSettings.id, set: { openSource: validated } })
  })
}
