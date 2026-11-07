// Canonical web-app base URL for worker-generated links. PUBLIC_APP_URL is the
// authoritative runtime value; APP_URL is the deployment alias and
// NEXT_PUBLIC_APP_URL is retained only as a build-time compatibility fallback.
export function appBaseUrl(): string {
  const raw = [
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ].find((value) => value?.trim())
  if (!raw) return 'http://localhost:3000'
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('PUBLIC_APP_URL/APP_URL must be an absolute HTTP(S) URL')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error('PUBLIC_APP_URL/APP_URL must be an origin-only HTTP(S) URL')
  }
  return url.origin
}
