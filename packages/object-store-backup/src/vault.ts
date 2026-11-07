// Opening a backup, in either format.
//
// TWO FORMATS, NEVER CONFUSED
//
//   v1 — the original, plaintext: `manifest.json`, `manifest.json.sha256`,
//         `objects/<sha256>`, `bucket.json`, `checkpoint.json`.
//   v2 — encrypted: `manifest.json.enc`, `backup.hmac`, `objects/<sha256>.age`,
//         `checkpoint.json.enc`.
//
// A v1 backup is read exactly as it always was. Nothing about its interpretation
// changes, and a v1 backup never silently becomes "encrypted enough": restoring
// from one is allowed but the report says which format it came from.
//
// VERIFICATION ORDER (both formats)
//
//   1. detect the format;
//   2. for v2, load the age identity and the HMAC key, refusing either if absent;
//   3. read and structurally validate the manifest;
//   4. for v2, decrypt it and then verify the HMAC over the canonical encoding;
//   5. only then look at object bytes.
//
// The HMAC is checked before any write in restore, which is the whole point: a
// substituted backup must not be able to reach a live store.

import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalManifestEncoding,
  decryptFile,
  encryptFile,
  HMAC_ALGORITHM,
  HMAC_ALGORITHM_LEGACY,
  loadAgeIdentity,
  loadAgeRecipient,
  loadHmacKey,
  matchesLegacySignature,
  tempPathFor,
  verifyHmac,
} from './crypto'
import { validateManifest, type Manifest } from './manifest'
import { MANIFEST_NAME } from './hash'

export const MANIFEST_ENC_NAME = 'manifest.json.enc'
const HMAC_FILE_NAME = 'backup.hmac'
export const FORMAT_V2 = 2

export type OpenedBackup = {
  backupDir: string
  format: 1 | 2
  manifest: Manifest
  manifestDigest: string
  /**
   * Whether the manifest still hashes to the digest recorded beside it.
   *
   * `true` for a v2 backup because its HMAC is verified (and a mismatch throws)
   * before this object is ever returned. For a plaintext v1 backup it is the
   * real comparison against `manifest.json.sha256`, or `null` when that sidecar
   * is absent and no comparison was possible.
   *
   * Callers must branch on the *value*, never on the format: a plaintext backup
   * is the case that can actually fail this check.
   */
  manifestChecksumOk: boolean | null
}

/** Where an object's bytes live, given the manifest's recorded relative path. */
function objectPath(backupDir: string, relative: string): string {
  const normalized = relative.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`manifest object file must be a relative path inside the backup: ${relative}`)
  }
  return join(backupDir, normalized)
}

/** The manifest is v2-encrypted when its encrypted companion exists. */
function detectFormat(backupDir: string): 1 | 2 {
  return existsSync(join(backupDir, MANIFEST_ENC_NAME)) ? FORMAT_V2 : 1
}

/**
 * Open and fully validate a backup directory.
 *
 * For a v2 backup this also decrypts the manifest and verifies its HMAC, so a
 * caller that gets a manifest back can trust that it is the one the key signs.
 */
export async function openBackup(backupDir: string): Promise<OpenedBackup> {
  const format = detectFormat(backupDir)

  if (format === 1) {
    let raw: string
    try {
      raw = await readFile(join(backupDir, MANIFEST_NAME), 'utf8')
    } catch {
      throw new Error(`manifest not found or unreadable: ${join(backupDir, MANIFEST_NAME)}`)
    }
    const { sha256Hex } = await import('./hash')
    const digest = sha256Hex(raw)
    // A plaintext backup has no HMAC, so this sidecar comparison is the only
    // thing standing between a tampered manifest and a restore that reports
    // success. It is performed here, once, so verify and restore cannot drift
    // apart on whether a backup is intact.
    let checksumOk: boolean | null = null
    try {
      const { readFile } = await import('node:fs/promises')
      const sidecar = (await readFile(join(backupDir, `${MANIFEST_NAME}.sha256`), 'utf8'))
        .trim()
        .split(/\s+/)[0]
      checksumOk = sidecar === digest
    } catch {
      checksumOk = null
    }
    return {
      backupDir,
      format: 1,
      manifest: validateManifest(JSON.parse(raw)),
      manifestDigest: digest,
      manifestChecksumOk: checksumOk,
    }
  }

  // --- v2: decrypt, then authenticate ---------------------------------------
  const identity = await loadAgeIdentity()
  const key = await loadHmacKey()

  const encrypted = join(backupDir, MANIFEST_ENC_NAME)
  const plaintext = tempPathFor(encrypted)
  try {
    await decryptFile(encrypted, plaintext, identity)
    const raw = await readFile(plaintext, 'utf8')
    const manifest = validateManifest(JSON.parse(raw))
    if (manifest.format_version !== FORMAT_V2) {
      throw new Error(
        `encrypted manifest declares format_version ${String(manifest.format_version)}, ` +
          `expected ${FORMAT_V2}; refusing to interpret an unknown format`,
      )
    }
    const expected = await readFile(join(backupDir, HMAC_FILE_NAME), 'utf8').catch(() => {
      throw new Error(`integrity tag not found: ${join(backupDir, HMAC_FILE_NAME)}`)
    })
    verifyManifestSignature(manifest, key, expected)
    const { sha256Hex } = await import('./hash')
    return {
      backupDir,
      format: FORMAT_V2,
      manifest,
      manifestDigest: sha256Hex(raw),
      // verifyManifestSignature threw unless the tag is genuine, so a v2 backup
      // that reaches this line is authenticated by construction.
      manifestChecksumOk: true,
    }
  } finally {
    await rm(plaintext, { force: true }).catch(() => undefined)
  }
}

/**
 * Authenticate a decrypted format-2 manifest, or explain precisely why it cannot be.
 *
 * ALGORITHM SELECTION IS NOT A TRUST DECISION. The `hmac_algorithm` field chooses
 * which construction to run; it does not lower the bar. In every branch below the
 * backup is accepted only if a known algorithm's HMAC actually verifies, and the
 * field is itself inside the signed bytes — so rewriting it to select a weaker
 * algorithm changes the signature input and fails the check.
 *
 * BRANCHES
 *
 *   known current algorithm -> verify with it; failure is a genuine integrity failure.
 *   absent                   -> the manifest predates the field. The legacy
 *                               construction is computed ONLY to tell "older tool"
 *                               apart from "tampered with"; the legacy tag is NEVER
 *                               accepted, because that construction left object
 *                               metadata, tags and blob mapping unauthenticated.
 *   anything else            -> refused as unknown.
 *
 * There is deliberately no "try every algorithm until one matches" path: that is a
 * signature oracle, and it would silently re-admit the exact coverage gap the
 * current algorithm exists to close.
 */
function verifyManifestSignature(manifest: Manifest, key: Buffer, expectedHex: string): void {
  const algorithm = manifest.hmac_algorithm

  if (algorithm === undefined) {
    // Diagnostic only. A match proves provenance, never soundness.
    if (matchesLegacySignature(key, manifest, expectedHex)) {
      throw new Error(
        'this backup was signed by an older tool version (' +
          `${HMAC_ALGORITHM_LEGACY}) and cannot be verified safely: that signature does not ` +
          'cover object metadata, tags, content type or content disposition, so a rewritten ' +
          'backup could carry the original tag. This is NOT evidence of tampering. Take a new ' +
          'encrypted backup with the current tool; do not re-sign this one by hand, because ' +
          'whoever holds the HMAC key could equally have forged it.',
      )
    }
    throw new Error(
      'this encrypted backup carries no hmac_algorithm field and its tag does not match the ' +
        `legacy (${HMAC_ALGORITHM_LEGACY}) construction either, so its origin cannot be ` +
        'established. It was either written by a tool this version cannot verify, or the tag or ' +
        'the HMAC key is wrong. Nothing will be restored from it; take a new encrypted backup.',
    )
  }

  if (algorithm !== HMAC_ALGORITHM) {
    throw new Error(
      `unknown hmac_algorithm ${JSON.stringify(algorithm)}; this tool writes and verifies ` +
        `${JSON.stringify(HMAC_ALGORITHM)}. Refusing to guess at the signature construction.`,
    )
  }

  if (!verifyHmac(key, canonicalManifestEncoding(manifest), expectedHex)) {
    throw new Error(
      'integrity check failed: this backup does not match the HMAC key provided. Treat it as ' +
        'tampered or the key as wrong; nothing will be restored from it.',
    )
  }
}

/** Atomically publish the encrypted manifest and its integrity tag. */
export async function commitEncryptedManifest(
  backupDir: string,
  manifest: Manifest,
  hmacHex: string,
): Promise<void> {
  const body = `${JSON.stringify(manifest, null, 2)}\n`
  const plaintextTmp = join(backupDir, `${MANIFEST_ENC_NAME}.plaintext-${process.pid}`)
  const cipherTmp = join(backupDir, `${MANIFEST_ENC_NAME}.tmp`)
  await writeFile(plaintextTmp, body, { mode: 0o600 })
  try {
    const recipient = await loadAgeRecipient()
    // Encrypt to a temporary name first: age writes its output directly, and a
    // failed encryption must not leave a half-written file where a reader expects
    // a complete manifest.
    await encryptFile(plaintextTmp, cipherTmp, recipient)
  } finally {
    await rm(plaintextTmp, { force: true }).catch(() => undefined)
  }
  try {
    await rename(cipherTmp, join(backupDir, MANIFEST_ENC_NAME))
  } catch (error) {
    await rm(cipherTmp, { force: true }).catch(() => undefined)
    throw error
  }
  // The integrity tag is published only after the encrypted manifest is in place,
  // so a reader that sees backup.hmac always sees a manifest to check against.
  const tmpHmac = join(backupDir, `${HMAC_FILE_NAME}.tmp`)
  await writeFile(tmpHmac, `${hmacHex}\n`, { mode: 0o600 })
  await rename(tmpHmac, join(backupDir, HMAC_FILE_NAME))
}

/**
 * Decrypt one object to a private temporary file and hash it.
 *
 * The caller deletes the file. A plaintext object is never left behind on success
 * or failure, and the temporary name is private so a concurrent reader cannot pick
 * up an unencrypted copy.
 */
export async function decryptAndHash(
  backupDir: string,
  relative: string,
  identity: string,
): Promise<{ sha256: string; size: number; plaintextPath: string }> {
  const source = objectPath(backupDir, relative)
  const target = tempPathFor(source)
  await decryptFile(source, target, identity)
  const { hashFile } = await import('./hash')
  const sha256 = await hashFile(target)
  const size = (await stat(target)).size
  return { sha256, size, plaintextPath: target }
}

export async function removeTempFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}
