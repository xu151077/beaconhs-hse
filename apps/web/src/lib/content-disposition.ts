// Shared Content-Disposition header builder.
//
// Browsers use three sources for a downloaded filename, in order:
//   1. the `filename*=UTF-8''…` parameter (RFC 5987 — full Unicode),
//   2. the plain `filename="…"` parameter (ASCII-only fallback),
//   3. the last path segment of the URL (what happens when NO header is set —
//      the bug where presigned S3 keys like `<uuid>-____.pdf` leak as the
//      saved filename).
//
// Every download/preview route funnels through here so the DB-stored original
// filename always wins over the storage key, quotes/newlines are neutralized,
// and Unicode names survive via the extended parameter.
//
// RFC 6266 requires the plain `filename` parameter to be a quoted ASCII string,
// so a Chinese name gets a safe ASCII fallback (`_.docx`) in `filename` while
// the exact original rides in `filename*`. Emitting raw UTF-8 in the plain
// parameter (the earlier behaviour) is not conformant even though most browsers
// tolerate it.

const MAX_FALLBACK_LENGTH = 200

/**
 * Percent-encode a value for RFC 5987 `ext-value`.
 *
 * `encodeURIComponent` leaves `!'()*` untouched, but RFC 5987 excludes them
 * from `attr-char` — and `'` is the very delimiter that separates the charset,
 * language and value. They must be percent-encoded so a filename containing an
 * apostrophe cannot smuggle structure into the header.
 */
function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/**
 * Reduce a filename to the printable-ASCII subset valid inside a quoted
 * `filename="…"` parameter: strip control characters and anything outside
 * printable ASCII, collapse each such run to `_`, and neutralise the quote and
 * backslash that would terminate or escape the quoted string.
 *
 * Falls back to the caller-supplied default when nothing meaningful survives
 * (e.g. a name that is entirely non-ASCII and has no ASCII extension).
 */
function asciiFallback(filename: string, fallback: string): string {
  const sanitized = filename
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/["\\]/g, '_')
    .trim()
    .slice(0, MAX_FALLBACK_LENGTH)
  return /[A-Za-z0-9]/.test(sanitized) ? sanitized : fallback
}

/** Build a Content-Disposition value that preserves the original filename. */
export function contentDisposition(
  mode: 'inline' | 'attachment',
  filename: string,
  fallback: string,
): string {
  const original = filename.trim().substring(0, MAX_FALLBACK_LENGTH) || fallback
  return `${mode}; filename="${asciiFallback(filename, fallback)}"; filename*=UTF-8''${rfc5987Encode(original)}`
}
