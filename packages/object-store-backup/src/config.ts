// Configuration for the object-store backup tool.
//
// WHY THIS EXISTS
//
// A backup tool that silently accepts an empty credential or an endpoint it cannot
// parse is worse than one that refuses: it either fails with an opaque SDK error
// halfway through a multi-gigabyte copy, or — far worse — it authenticates
// anonymously and "succeeds" against a store that anyone can read. Both failure
// modes have been observed in practice, which is why every value is validated here
// before a single request is issued.
//
// NAMING
//
// `OBJECT_STORE_*` is the tool's own namespace. `R2_*` is accepted as a fallback
// because that is what BeaconHS deployments already export for the same store, so
// an operator does not have to translate a working `.env` into a second set of
// names. The fallback is deliberate and documented — it is not a hidden alias.

export type StoreConfig = {
  /** Absolute http(s) endpoint, e.g. `http://127.0.0.1:9000`. Never logged raw. */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Signature scope region. `auto` matches what `packages/storage` uses. */
  region: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Endpoint as it may appear in a log or manifest: scheme, host and port only.
 *
 * Userinfo and query parameters are stripped because an endpoint string can carry
 * either (some tooling builds `https://key:secret@host/...`, and a presigned URL
 * carries a signature in its query). Neither may reach a log or a manifest.
 */
export function redactEndpoint(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return '<unparseable endpoint>'
  }
  const port = parsed.port ? `:${parsed.port}` : ''
  return `${parsed.protocol}//${parsed.hostname}${port}`
}

/**
 * Reject values that are absent, empty, or whitespace-only.
 *
 * A whitespace-only access key is the realistic accident: a `.env` line left as
 * `R2_ACCESS_KEY_ID=` after an edit, or an env var forwarded by `docker run -e VAR`
 * with no value. The AWS SDK turns the latter into an anonymous request, which is
 * exactly the silent-privacy-failure this guards.
 */
function requireValue(name: string, value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') {
    throw new ConfigError(
      `${name} is required and must not be empty. Set it explicitly (or pass the matching ` +
        `command-line flag). Refusing to guess, and refusing to fall back to an ` +
        `anonymous request.`,
    )
  }
  return trimmed
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const value of values) if (value !== undefined) return value
  return undefined
}

export type StoreConfigInput = {
  endpoint?: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
  region?: string
}

/** Resolve the store identity from flags first, then the environment. */
export function resolveStoreConfig(input: StoreConfigInput): StoreConfig {
  const endpoint = requireValue(
    'endpoint (OBJECT_STORE_ENDPOINT or R2_ENDPOINT)',
    firstDefined(input.endpoint, process.env.OBJECT_STORE_ENDPOINT, process.env.R2_ENDPOINT),
  )
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new ConfigError(
      `endpoint must be an absolute http(s) URL; received a value that does not start with ` +
        `http:// or https://.`,
    )
  }
  // Reject embedded credentials outright rather than stripping them: an endpoint
  // that carries a password is a credential in a log line waiting to happen.
  const parsed = new URL(endpoint)
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigError(
      'endpoint must not contain embedded credentials (user:password@host). Pass the ' +
        'access key and secret through their own settings.',
    )
  }

  const bucket = requireValue(
    'bucket (OBJECT_STORE_BUCKET or R2_BUCKET)',
    firstDefined(input.bucket, process.env.OBJECT_STORE_BUCKET, process.env.R2_BUCKET),
  )
  const accessKeyId = requireValue(
    'access key id (OBJECT_STORE_ACCESS_KEY_ID or R2_ACCESS_KEY_ID)',
    firstDefined(
      input.accessKeyId,
      process.env.OBJECT_STORE_ACCESS_KEY_ID,
      process.env.R2_ACCESS_KEY_ID,
    ),
  )
  const secretAccessKey = requireValue(
    'secret access key (OBJECT_STORE_SECRET_ACCESS_KEY or R2_SECRET_ACCESS_KEY)',
    firstDefined(
      input.secretAccessKey,
      process.env.OBJECT_STORE_SECRET_ACCESS_KEY,
      process.env.R2_SECRET_ACCESS_KEY,
    ),
  )
  const region = firstDefined(input.region, process.env.OBJECT_STORE_REGION)?.trim() || 'auto'

  return { endpoint, bucket, accessKeyId, secretAccessKey, region }
}
