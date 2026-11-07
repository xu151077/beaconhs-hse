import { createAuthClient } from 'better-auth/react'
import { magicLinkClient } from 'better-auth/client/plugins'

// In the browser, default to the current page origin so auth requests are
// always same-origin — correct on any host and https-safe. NEXT_PUBLIC_APP_URL
// is only a build-time fallback for non-browser/SSR evaluation; it must never
// override the live browser origin after a runtime domain change.
// Use globalThis (not `window`) so this typechecks without the DOM lib — this
// package is consumed by server code too. In the browser globalThis.location is
// the page origin; on the server it's undefined and we fall back to localhost.
const originFromGlobal = (globalThis as { location?: { origin?: string } }).location?.origin
const baseURL = originFromGlobal ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

const authClient = createAuthClient({
  baseURL,
  plugins: [magicLinkClient()],
})

export const { signIn, signOut } = authClient
