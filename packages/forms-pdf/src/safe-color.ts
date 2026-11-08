// Tenant branding colours reach stylesheets and PDF HTML (reports document
// CSS, book compose, credential themes). Admin-entered values must never be
// interpolated raw: a quote/semicolon could break out of a style attribute in
// a rendered artifact. One canonical guard for every consumer.

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** The platform's default brand colour, used when a value fails the hex check. */
export const DEFAULT_PRIMARY_COLOR = '#0f766e'

/** Pass well-formed hex through; anything else becomes the fallback. */
export function safeColor(hex: string | null | undefined, fallback: string): string {
  if (hex && HEX_RE.test(hex.trim())) return hex.trim()
  return fallback
}
