import { NextRequest, NextResponse } from 'next/server'
import { contentSecurityPolicy } from '@/lib/security-headers'

function browserReachableStorageOrigin(value: string | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (!trimmed) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    return false
  }
  if (parsed.protocol === 'https:') return true
  const loopback =
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1') &&
    parsed.protocol === 'http:'
  return process.env.NODE_ENV === 'development' && loopback
}

function storageCspOrigin(): string | undefined {
  const configured = process.env.R2_ENDPOINT?.trim()
  if (browserReachableStorageOrigin(configured)) return configured
  for (const name of ['PUBLIC_APP_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL']) {
    const candidate = process.env[name]?.trim()
    if (candidate && browserReachableStorageOrigin(candidate)) return candidate
  }
  return configured
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const policy = contentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV === 'development',
    collaboraUrl: process.env.COLLABORA_URL,
    storageEndpoint: storageCspOrigin(),
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN,
  })
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', policy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', policy)
  return response
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
