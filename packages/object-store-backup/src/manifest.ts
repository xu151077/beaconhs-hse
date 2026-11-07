// The backup manifest: what was captured, and proof that it was captured whole.
//
// WHY A STRICT SCHEMA
//
// A restore consumes the manifest as its only instruction set. A manifest that
// parsed but lost a field — a truncated write, a hand-edit, a version from an older
// tool — would restore objects with silently missing metadata or tags, which is a
// data-integrity failure that no downstream check can see because there is nothing
// left to compare against. So the manifest is validated structurally on load, and
// an unrecognised or incomplete manifest is refused rather than interpreted.
//
// WHAT THE CHECKSUM FILE DOES AND DOES NOT PROVE
//
// `manifest.json.sha256` is a plain SHA-256 of the manifest bytes. It detects
// accidental corruption — a truncated copy, a bad disk, a partial rsync. It does
// NOT prove the manifest was not maliciously altered: an attacker who can rewrite
// the manifest can rewrite the sidecar too. Establishing tamper-evidence requires a
// keyed MAC or a signature and a separately protected key, which is deliberately
// out of scope for this tool. That limitation is stated in the file itself so it is
// not mistaken for a guarantee.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactEndpoint } from './config'
import { sha256Hex } from './hash'

export const MANIFEST_SCHEMA_VERSION = 1

export type ManifestObject = {
  /** Original S3 object key, exactly as the store returned it. */
  key: string
  /** Content length reported by HeadObject. */
  size: number
  /** SHA-256 of the object bytes, computed while streaming the download. */
  sha256: string
  contentType: string | null
  contentDisposition: string | null
  /** User metadata (`x-amz-meta-*`), keys stored without the prefix. */
  metadata: Record<string, string>
  /** Object tags (`GET ?tagging`). */
  tags: Record<string, string>
  /** Path of the content blob relative to the backup directory. */
  file: string
}

export type Manifest = {
  schema_version: number
  /**
   * 2 for an encrypted backup, absent for the original plaintext format.
   *
   * The field exists so a reader can tell the two apart without guessing, and so a
   * future format cannot be silently reinterpreted: an unknown value is refused.
   */
  format_version?: number
  /**
   * Identifies which HMAC construction signed this manifest.
   *
   * `format_version` answers "is this encrypted?"; this answers "how is it signed?".
   * Conflating the two made a tool upgrade indistinguishable from tampering: an old
   * backup could not be verified by the new code, and the only truthful-sounding
   * message was "integrity check failed", which tells an operator to hunt for an
   * attacker that does not exist.
   *
   * ABSENT on a format-2 manifest means it predates this field. Absence is never
   * treated as "use the current algorithm" — see `vault.ts` for how it is handled.
   */
  hmac_algorithm?: string
  created_at: string
  /** Redacted origin: scheme/host/port only. Never carries credentials. */
  source: {
    endpoint: string
    bucket: string
    region: string
  }
  object_count: number
  total_bytes: number
  /**
   * The bucket's lifecycle configuration as returned by GetBucketLifecycleConfiguration,
   * or `null` when the bucket has none. `unsupported` records that the endpoint
   * rejected the call — that is a compatibility finding, not an empty bucket.
   */
  lifecycle: {
    status: 'captured' | 'none' | 'unsupported'
    /** Reason the store gave when status is `unsupported`. */
    reason?: string
    /** Raw XML of the configuration, when captured. */
    xml?: string
    sha256?: string
  }
  objects: ManifestObject[]
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringMap(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'string')
}

/**
 * Structural validation of a parsed manifest.
 *
 * Deliberately conservative: anything this does not positively recognise is
 * rejected. A future schema version is refused with a clear message rather than
 * being partially understood.
 */
export function validateManifest(value: unknown): Manifest {
  if (!isRecord(value)) throw new ManifestError('manifest is not a JSON object')
  if (value.schema_version !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestError(
      `unsupported manifest schema_version ${JSON.stringify(value.schema_version)}; this tool ` +
        `writes and reads version ${MANIFEST_SCHEMA_VERSION}`,
    )
  }
  if (typeof value.created_at !== 'string' || value.created_at === '') {
    throw new ManifestError('manifest.created_at must be a non-empty string')
  }
  if (
    value.format_version !== undefined &&
    value.format_version !== 1 &&
    value.format_version !== 2
  ) {
    throw new ManifestError(
      `unsupported manifest format_version ${JSON.stringify(value.format_version)}; this tool ` +
        `writes and reads 1 (plaintext) and 2 (encrypted)`,
    )
  }
  // The algorithm selector must be a plain string when present. Validating the TYPE
  // here matters: it is the one manifest field that decides which verification routine
  // runs, so a non-string value must never reach the dispatcher as anything exotic.
  if (value.hmac_algorithm !== undefined && typeof value.hmac_algorithm !== 'string') {
    throw new ManifestError('manifest.hmac_algorithm must be a string when present')
  }
  if (value.hmac_algorithm === '') {
    throw new ManifestError('manifest.hmac_algorithm must not be empty when present')
  }
  if (!isRecord(value.source)) throw new ManifestError('manifest.source must be an object')
  const { endpoint, bucket, region } = value.source
  if (typeof endpoint !== 'string' || typeof bucket !== 'string' || typeof region !== 'string') {
    throw new ManifestError('manifest.source must contain string endpoint, bucket and region')
  }
  if (typeof value.object_count !== 'number' || !Number.isInteger(value.object_count)) {
    throw new ManifestError('manifest.object_count must be an integer')
  }
  if (typeof value.total_bytes !== 'number' || value.total_bytes < 0) {
    throw new ManifestError('manifest.total_bytes must be a non-negative number')
  }
  if (!isRecord(value.lifecycle)) throw new ManifestError('manifest.lifecycle must be an object')
  const lifecycleStatus = value.lifecycle.status
  if (
    lifecycleStatus !== 'captured' &&
    lifecycleStatus !== 'none' &&
    lifecycleStatus !== 'unsupported'
  ) {
    throw new ManifestError('manifest.lifecycle.status must be one of captured, none, unsupported')
  }
  if (!Array.isArray(value.objects)) throw new ManifestError('manifest.objects must be an array')

  const objects: ManifestObject[] = value.objects.map((entry, index) => {
    if (!isRecord(entry)) throw new ManifestError(`manifest.objects[${index}] is not an object`)
    const { key, size, sha256, contentType, contentDisposition, metadata, tags, file } = entry
    if (typeof key !== 'string' || key === '') {
      throw new ManifestError(`manifest.objects[${index}].key must be a non-empty string`)
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      throw new ManifestError(`manifest.objects[${index}].size must be a non-negative integer`)
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ManifestError(`manifest.objects[${index}].sha256 must be a 64-character hex digest`)
    }
    if (contentType !== null && typeof contentType !== 'string') {
      throw new ManifestError(`manifest.objects[${index}].contentType must be a string or null`)
    }
    if (contentDisposition !== null && typeof contentDisposition !== 'string') {
      throw new ManifestError(
        `manifest.objects[${index}].contentDisposition must be a string or null`,
      )
    }
    if (!isStringMap(metadata)) {
      throw new ManifestError(`manifest.objects[${index}].metadata must be a string map`)
    }
    if (!isStringMap(tags)) {
      throw new ManifestError(`manifest.objects[${index}].tags must be a string map`)
    }
    if (typeof file !== 'string' || file === '') {
      throw new ManifestError(`manifest.objects[${index}].file must be a non-empty string`)
    }
    // The backup directory is the only permitted root. A relative path that
    // escapes it means the manifest was produced by something else, or was edited.
    const normalized = file.replaceAll('\\', '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new ManifestError(
        `manifest.objects[${index}].file must be a relative path inside the backup directory`,
      )
    }
    return {
      key,
      size,
      sha256,
      contentType,
      contentDisposition,
      metadata: metadata as Record<string, string>,
      tags: tags as Record<string, string>,
      file: normalized,
    }
  })

  const seen = new Set<string>()
  for (const object of objects) {
    if (seen.has(object.key)) {
      throw new ManifestError(`duplicate object key in manifest: ${object.key}`)
    }
    seen.add(object.key)
  }

  const computedBytes = objects.reduce((total, object) => total + object.size, 0)
  if (objects.length !== value.object_count) {
    throw new ManifestError(
      `manifest.object_count says ${value.object_count} but objects lists ${objects.length}`,
    )
  }
  if (computedBytes !== value.total_bytes) {
    throw new ManifestError(
      `manifest.total_bytes says ${value.total_bytes} but objects sum to ${computedBytes}`,
    )
  }

  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    ...(value.format_version !== undefined
      ? { format_version: value.format_version as number }
      : {}),
    ...(value.hmac_algorithm !== undefined
      ? { hmac_algorithm: value.hmac_algorithm as string }
      : {}),
    created_at: value.created_at as string,
    source: {
      endpoint: redactEndpoint(endpoint as string),
      bucket: bucket as string,
      region: region as string,
    },
    object_count: value.object_count as number,
    total_bytes: value.total_bytes as number,
    lifecycle: {
      status: lifecycleStatus,
      ...(typeof value.lifecycle.reason === 'string'
        ? { reason: value.lifecycle.reason as string }
        : {}),
      ...(typeof value.lifecycle.xml === 'string' ? { xml: value.lifecycle.xml as string } : {}),
      ...(typeof value.lifecycle.sha256 === 'string'
        ? { sha256: value.lifecycle.sha256 as string }
        : {}),
    },
    objects,
  }
}

/** Serialise, write, and checksum a manifest in one atomic-ish step. */
export async function writeManifest(backupDir: string, manifest: Manifest): Promise<string> {
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestPath = join(backupDir, 'manifest.json')
  await writeFile(manifestPath, json, { mode: 0o600 })
  const digest = sha256Hex(json)
  await writeFile(join(backupDir, 'manifest.json.sha256'), `${digest}  manifest.json\n`, {
    mode: 0o600,
  })
  return digest
}

export type LoadedManifest = {
  manifest: Manifest
  manifestPath: string
  /** SHA-256 of the manifest bytes exactly as they were read from disk. */
  manifestDigest: string
  /** Digest written in `manifest.json.sha256`, when that file exists. */
  checksumFileDigest: string | null
}

/**
 * Load and validate a manifest, reporting whether the sidecar checksum matched.
 *
 * A checksum mismatch is reported rather than thrown so that `verify` can name the
 * manifest as corrupted and still continue checking the object files — the operator
 * needs the full list of what is wrong, not just the first problem.
 */
export async function loadManifest(backupDir: string): Promise<LoadedManifest> {
  const manifestPath = join(backupDir, 'manifest.json')
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    throw new ManifestError(`manifest not found or unreadable: ${manifestPath}`)
  }
  const actual = sha256Hex(raw)
  let checksumFileDigest: string | null = null
  try {
    const sidecar = await readFile(join(backupDir, 'manifest.json.sha256'), 'utf8')
    const first = sidecar.trim().split(/\s+/)[0]
    checksumFileDigest = first ?? null
  } catch {
    checksumFileDigest = null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ManifestError(`manifest is not valid JSON: ${(error as Error).message}`)
  }
  return {
    manifest: validateManifest(parsed),
    manifestPath,
    manifestDigest: actual,
    checksumFileDigest,
  }
}

export async function writeJsonReport(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}
