/**
 * Better Auth's base URL is a security boundary, not a link-generation hint.
 * It intentionally uses BETTER_AUTH_URL only; PUBLIC_APP_URL and APP_URL must
 * not silently widen the CSRF trusted-origin boundary.
 */
export function resolveAuthBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.BETTER_AUTH_URL?.trim() || 'http://localhost:3000'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('BETTER_AUTH_URL must be an absolute HTTP(S) URL')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(
      'BETTER_AUTH_URL must be an origin-only HTTP(S) URL without credentials, query, or path',
    )
  }
  return url.origin
}
