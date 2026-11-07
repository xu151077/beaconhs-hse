// Canonical browser-reachable base URL for links the web app generates —
// certificate/wallet verify QR codes, emails, equipment labels, kiosk URLs.
//
// Runtime configuration contract:
//   PUBLIC_APP_URL is authoritative when present. APP_URL is the documented
//   deployment alias; NEXT_PUBLIC_APP_URL is retained only as a build-time
//   compatibility fallback for browser bundles. All values are read at call
//   time, so changing the deployment domain only requires restarting services.
export function appBaseUrl(): string {
  const configured = [
    ['PUBLIC_APP_URL', process.env.PUBLIC_APP_URL],
    ['APP_URL', process.env.APP_URL],
    ['NEXT_PUBLIC_APP_URL', process.env.NEXT_PUBLIC_APP_URL],
  ] as const

  const present = configured
    .filter(([, value]) => value?.trim())
    .map(([name, value]) => ({ name, raw: value!.trim() }))

  const origins = new Map<string, string>()
  for (const { name, raw } of present) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error(`${name} must be an absolute HTTP(S) URL`)
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
        `${name} must be an origin-only HTTP(S) URL without credentials, query, or path`,
      )
    }
    origins.set(url.origin, name)
  }

  const resolved = [...origins.keys()]
  if (resolved.length > 1) {
    throw new Error(
      `Conflicting public origin configuration: ${resolved.join(' and ')}; set PUBLIC_APP_URL, APP_URL, and NEXT_PUBLIC_APP_URL to one origin`,
    )
  }

  return resolved[0] ?? 'http://localhost:3000'
}
