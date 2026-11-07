// Optional encryption for backups: `age` for confidentiality, HMAC-SHA256 for
// integrity.
//
// WHY BOTH
//
// Encryption alone does not stop an attacker who can rewrite the backup directory:
// they replace `manifest.json.enc` and the blobs together, and the restore has no
// way to notice. The `.sha256` sidecar the tool already writes sits next to the
// manifest and is therefore worthless against that. A keyed HMAC over a canonical
// encoding of the manifest is what makes a substituted backup detectable.
//
// WHY `age`
//
// It is already the repository's choice for the PostgreSQL backup
// (`scripts/cluster/backup.sh`) and the runbook documents both variables. Reusing
// it means no new cryptographic primitive is introduced, and the operator already
// has the key custody story.
//
// WHAT THE HMAC DOES NOT DO
//
// HMAC proves "someone holding this key produced this tag". It says nothing when
// the key itself leaks. It is an integrity control, not an authorization control.

import { spawn } from 'node:child_process'
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import { chmod, open, readFile, rm, stat, writeFile } from 'node:fs/promises'

export class CryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoError'
  }
}

/**
 * The HMAC construction this tool writes.
 *
 * The name is recorded IN the manifest and is itself covered by the signature, so an
 * attacker cannot rewrite the field to steer a verifier onto a weaker construction:
 * the field is authenticated by the very HMAC whose algorithm it selects.
 */
export const HMAC_ALGORITHM = 'beaconhs-manifest-hmac-v2'

/**
 * The construction written before the algorithm field existed.
 *
 * It signed only the bucket, the object count, the byte total, the lifecycle digest
 * and each object's key+content-hash. Object metadata, tags, content type, content
 * disposition and blob mapping were OUTSIDE its coverage, so a party able to rewrite
 * the backup directory could alter those fields and re-encrypt (the age recipient is
 * public) while the tag still verified.
 *
 * It is retained for DIAGNOSIS ONLY and can never grant validity. See
 * `classifyIntegrityFailure`.
 */
export const HMAC_ALGORITHM_LEGACY = 'beaconhs-manifest-hmac-v1'

/**
 * Locate the `age` binary, the same way the operator's PATH provides it. A missing
 * binary is a hard error, never a silent fall back to plaintext.
 */
async function findAge(): Promise<string> {
  const found = await new Promise<string | undefined>((resolve) => {
    const child = spawn('age', ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(undefined))
    child.on('spawn', () => resolve('age'))
    child.on('exit', (code) => resolve(code === 0 ? 'age' : 'age'))
  })
  if (found === undefined) {
    throw new CryptoError(
      'the age command is not available on PATH. Encrypted backups require it, just as ' +
        'scripts/cluster/backup.sh does. Refusing to write an unencrypted backup.',
    )
  }
  return found
}

function runAge(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('age', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', () => reject(new CryptoError('failed to start the age command')))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      // stderr from age can name a key file path; keep the message generic.
      else reject(new CryptoError(`age command failed with exit code ${code}`))
    })
    void stderr
  })
}

/**
 * Read a secret from a file, refusing anything world- or group-readable.
 *
 * A key file that others can read is a key that is not secret, and the tool fails
 * rather than proceed on the assumption that file permissions were a suggestion.
 */
async function readKeyFile(path: string, label: string): Promise<string> {
  const info = await stat(path).catch(() => undefined)
  if (!info) throw new CryptoError(`${label} file not found: ${path}`)
  const mode = info.mode & 0o777
  if (mode & 0o077) {
    throw new CryptoError(
      `${label} file ${path} has permissions ${mode.toString(8)}; it must not be readable by ` +
        `group or others. Fix with chmod 600.`,
    )
  }
  return (await readFile(path, 'utf8')).trim()
}

/** The age recipient (public key) used to encrypt. */
export async function loadAgeRecipient(): Promise<string> {
  const inline = process.env.BACKUP_AGE_RECIPIENT?.trim()
  if (inline) {
    if (!inline.startsWith('age1'))
      throw new CryptoError('BACKUP_AGE_RECIPIENT is not an age public key')
    return inline
  }
  const fromFile = process.env.BACKUP_AGE_RECIPIENT_FILE?.trim()
  if (fromFile) {
    const value = (await readKeyFile(fromFile, 'BACKUP_AGE_RECIPIENT_FILE')).trim()
    if (!value.startsWith('age1'))
      throw new CryptoError('BACKUP_AGE_RECIPIENT_FILE does not contain an age public key')
    return value
  }
  throw new CryptoError(
    'BACKUP_AGE_RECIPIENT (or BACKUP_AGE_RECIPIENT_FILE) is required to write an encrypted backup',
  )
}

/** The age identity (private key) used to decrypt. */
export async function loadAgeIdentity(): Promise<string> {
  const path = process.env.BACKUP_AGE_IDENTITY?.trim()
  if (!path) {
    throw new CryptoError(
      'BACKUP_AGE_IDENTITY must point to the age identity file needed to decrypt this backup',
    )
  }
  await readKeyFile(path, 'BACKUP_AGE_IDENTITY')
  return path
}

/**
 * The HMAC key: a separate random secret, never the age identity or recipient.
 *
 * Reusing the age identity would tie integrity to a key whose compromise already
 * breaks confidentiality, and would mean one leaked file undoes both controls.
 *
 * A SHORT KEY IS REJECTED. An operator who sets `BACKUP_HMAC_KEY=x` gets a tag that is
 * trivially brute-forced, which is worse than no tag because the tool would report the
 * backup as authentic. 32 bytes is the floor `generateHmacKey` produces, so anything
 * shorter is a misconfiguration rather than a deliberate choice.
 */
const MIN_HMAC_KEY_BYTES = 32

export async function loadHmacKey(): Promise<Buffer> {
  const file = process.env.BACKUP_HMAC_KEY_FILE?.trim()
  if (file) {
    const value = await readKeyFile(file, 'BACKUP_HMAC_KEY_FILE')
    if (value === '') throw new CryptoError('BACKUP_HMAC_KEY_FILE is empty')
    return requireHmacStrength(Buffer.from(value, 'utf8'))
  }
  const inline = process.env.BACKUP_HMAC_KEY?.trim()
  if (inline) return requireHmacStrength(Buffer.from(inline, 'utf8'))
  throw new CryptoError(
    'BACKUP_HMAC_KEY_FILE (preferred) or BACKUP_HMAC_KEY is required to write or verify a ' +
      'keyed integrity tag',
  )
}

/** Generate a fresh HMAC key for operators creating a new backup key. */
export function generateHmacKey(): string {
  return randomBytes(32).toString('base64url')
}

/** Refuse a key too short to resist an offline guess. */
function requireHmacStrength(key: Buffer): Buffer {
  if (key.length < MIN_HMAC_KEY_BYTES) {
    throw new CryptoError(
      `the HMAC key is ${key.length} byte(s); at least ${MIN_HMAC_KEY_BYTES} are required. A short ` +
        'key makes the integrity tag guessable, which is worse than having none because the ' +
        'backup would then verify as authentic. Generate one with "backup --generate-key".',
    )
  }
  return key
}

/** Write a key file with the permissions this module will later demand. */
export async function writeHmacKeyFile(path: string, key: string): Promise<void> {
  await writeFile(path, `${key}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

/**
 * Make `path` a fresh, owner-only file BEFORE anything writes plaintext into it.
 *
 * `age --output` creates the file itself with mode 0644 (verified against age v1.3.2),
 * so chmod-ing after the fact leaves a window in which decrypted plaintext is readable
 * by group and others. Creating the inode 0600 first means age writes into a file that
 * was already private, so no such window exists.
 *
 * The previous file is unlinked first rather than reused: `open(..., 'w')` would keep
 * an existing file's permissive mode, and that mode may have been set by a previous
 * `age` run. Unlinking means there is never a moment at which a world-readable file
 * exists at this path, and `wx` then refuses to follow a symlink planted in the gap.
 */
async function precreatePrivate(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
  const handle = await open(path, 'wx', 0o600)
  await handle.close()
}

export async function encryptFile(input: string, output: string, recipient: string): Promise<void> {
  await findAge()
  await precreatePrivate(output)
  try {
    await runAge(['--encrypt', '--recipient', recipient, '--output', output, input])
  } catch (error) {
    await rm(output, { force: true }).catch(() => undefined)
    throw error
  }
  await chmod(output, 0o600)
}

export async function decryptFile(input: string, output: string, identity: string): Promise<void> {
  await findAge()
  await precreatePrivate(output)
  try {
    await runAge(['--decrypt', '--identity', identity, '--output', output, input])
  } catch (error) {
    // A failed decryption can still leave a partial or empty plaintext file behind.
    // It must never survive to be read by a later run as if it were real content.
    await rm(output, { force: true }).catch(() => undefined)
    throw error
  }
  await chmod(output, 0o600)
}

/**
 * A scratch path for a decrypted blob, on the same filesystem as the destination.
 *
 * The pid and a timestamp keep concurrent runs apart, and the leading dot keeps the
 * file out of the way of the `objects/` listing that verify walks.
 */
export function tempPathFor(output: string): string {
  return `${output}.decrypting-${process.pid}-${Date.now()}`
}

/**
 * The canonical encoding the HMAC covers.
 *
 * IT COVERS EVERY FIELD THAT AFFECTS WHAT A RESTORE PRODUCES. An earlier version
 * signed only the bucket, the count, the byte total, the lifecycle digest and each
 * object's key+content-hash, leaving `metadata`, `tags`, `contentType` and
 * `contentDisposition` unauthenticated. That was exploitable: `age` encryption can be
 * *re-applied* by anyone holding the (public) recipient, so an attacker with write
 * access to the backup directory could rewrite those four fields, re-encrypt, and the
 * original HMAC still verified. Restore then wrote the attacker's values to the target
 * store. Proven end-to-end in crypto.test.ts ("refuses a manifest whose metadata was
 * rewritten and re-encrypted").
 *
 * LENGTH-PREFIXING IS MANDATORY, NOT COSMETIC. Every variable-length field is written
 * as `<byteLength>:<value>`. Without it a key containing a newline or a separator
 * could be shifted between fields to yield a second, different manifest with an
 * identical signed string — the encoding must be injective or it is not a signature.
 *
 * Fields are emitted in a fixed order and objects sorted by key, so a verifier can
 * recompute the string from the decrypted manifest alone. `schema_version` and
 * `format_version` are included so a manifest cannot be reinterpreted under another
 * format's rules.
 */
function field(value: string): string {
  // Byte length, not character length: a multi-byte key would otherwise be able to
  // alias a different value under a string-length prefix.
  return `${Buffer.byteLength(value, 'utf8')}:${value}`
}

/** A canonical rendering of a string map: sorted, so JSON key order is irrelevant. */
function canonicalMap(record: Record<string, string> | undefined): string {
  return Object.entries(record ?? {})
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${field(k)}=${field(v)}`)
    .join(',')
}

export function canonicalManifestEncoding(manifest: {
  schema_version?: number
  format_version?: number
  hmac_algorithm?: string
  created_at?: string
  source: { endpoint?: string; bucket: string; region?: string }
  object_count: number
  total_bytes: number
  lifecycle: { sha256?: string }
  objects: Array<{
    key: string
    size?: number
    sha256: string
    contentType?: string | null
    contentDisposition?: string | null
    metadata?: Record<string, string>
    tags?: Record<string, string>
    file?: string
  }>
}): string {
  const sorted = [...manifest.objects].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  )

  const header = [
    'beaconhs-manifest-hmac-v2',
    field(String(manifest.schema_version ?? '')),
    field(String(manifest.format_version ?? '')),
    // The algorithm name is inside the bytes it selects. Rewriting the field to point
    // at a weaker construction therefore changes the signature input and fails, rather
    // than steering the verifier onto it.
    field(manifest.hmac_algorithm ?? ''),
    field(manifest.created_at ?? ''),
    field(manifest.source.endpoint ?? ''),
    field(manifest.source.bucket),
    field(manifest.source.region ?? ''),
    field(String(manifest.object_count)),
    field(String(manifest.total_bytes)),
    field(manifest.lifecycle.sha256 ?? ''),
  ].join('\n')

  const rows = sorted.map((object) =>
    [
      field(object.key),
      field(object.sha256),
      field(String(object.size ?? '')),
      field(object.contentType ?? ''),
      field(object.contentDisposition ?? ''),
      canonicalMap(object.metadata),
      canonicalMap(object.tags),
      field(object.file ?? ''),
    ].join('\n'),
  )

  return `${header}\n--\n${rows.join('\n--\n')}`
}

/**
 * The pre-`hmac_algorithm` construction, reconstructed for DIAGNOSIS.
 *
 * It exists so a verifier can tell "this backup is from an older tool" apart from
 * "this backup was tampered with" — two very different operator responses that the
 * old error message conflated.
 *
 * IT IS NEVER USED TO ACCEPT A BACKUP. `verifyHmac` below is called with it only to
 * decide which message to print. See `vault.ts`.
 */
function legacyCanonicalEncoding(manifest: {
  source: { bucket: string }
  object_count: number
  total_bytes: number
  lifecycle: { sha256?: string }
  objects: Array<{ key: string; sha256: string }>
}): string {
  const header = [
    'v2',
    manifest.source.bucket,
    String(manifest.object_count),
    String(manifest.total_bytes),
    manifest.lifecycle.sha256 ?? '-',
  ].join('|')
  const lines = [...manifest.objects]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((object) => `${object.sha256} ${object.key}`)
  return `${header}\n${lines.join('\n')}`
}

export function computeHmac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex')
}

/** Compare in constant time, so a wrong tag cannot be learned byte by byte. */
export function verifyHmac(key: Buffer, data: string, expectedHex: string): boolean {
  const actual = Buffer.from(computeHmac(key, data), 'utf8')
  const expected = Buffer.from(expectedHex.trim(), 'utf8')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/**
 * Does `expected` match the LEGACY construction?
 *
 * Diagnostic only — see `legacyCanonicalEncoding`. The result must not be used as
 * evidence that a backup is sound, because the legacy construction left object
 * metadata and tags unauthenticated.
 */
export function matchesLegacySignature(
  key: Buffer,
  manifest: Parameters<typeof legacyCanonicalEncoding>[0],
  expectedHex: string,
): boolean {
  return verifyHmac(key, legacyCanonicalEncoding(manifest), expectedHex)
}
