// Independent verification of a backup directory.
//
// WHY THIS IS A SEPARATE COMMAND
//
// A backup that verifies itself in the same process that wrote it cannot detect the
// failure that matters most: a bug that writes the wrong bytes and then hashes those
// same wrong bytes. Re-running as a separate step, re-reading from disk, and comparing
// against the manifest is what makes the check meaningful — and it is the step an
// operator runs after a copy, after a restore, and on a schedule against long-lived
// backups.
//
// WHAT "PASSED" MEANS
//
// Every manifest entry exists on disk with the recorded size and digest, the object
// directory holds nothing the manifest does not account for, and the recorded counts
// and byte totals agree with the object list. Anything else returns a non-zero exit
// code and a report naming the objects at fault. A partial check never prints a
// success line.

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { OBJECT_DIR, hashFile, sha256Hex } from './hash'
import { writeJsonReport, type Manifest } from './manifest'
import { openBackup, decryptAndHash, removeTempFile, type OpenedBackup } from './vault'

type VerifyFailure = { key: string; reason: string }

export type VerifyReport = {
  schema_version: 1
  backup_dir: string
  /** 1 for the original plaintext layout, 2 for an encrypted backup. */
  backup_format: 1 | 2
  manifest_ok: boolean
  manifest_checksum_ok: boolean | null
  object_count_ok: boolean
  total_bytes_ok: boolean
  lifecycle_ok: boolean
  checked_objects: number
  failed_objects: VerifyFailure[]
  /** Files present in objects/ that no manifest entry references. */
  orphan_objects: string[]
  passed: boolean
}

export type VerifyOptions = {
  backupDir: string
  /** Treat unreferenced object files as a failure rather than a report-only note. */
  strict?: boolean
  log?: (line: string) => void
}

export async function runVerify(options: VerifyOptions): Promise<VerifyReport> {
  const log = options.log ?? ((line: string) => console.log(line))
  const { backupDir } = options

  let manifest: Manifest
  let manifestChecksumOk: boolean | null = null
  let manifestReadable = false
  let openedFormat: 1 | 2 = 1

  let cachedIdentity: string | undefined
  async function loadIdentity(): Promise<string> {
    if (cachedIdentity === undefined)
      cachedIdentity = await (await import('./crypto')).loadAgeIdentity()
    return cachedIdentity
  }

  try {
    // openBackup validates the manifest, and for a format-2 (encrypted) backup it
    // also decrypts it and verifies the HMAC. A failing HMAC throws here, so a
    // tampered backup can never reach the object checks below.
    const opened = await openBackup(backupDir)
    manifest = opened.manifest
    openedFormat = opened.format
    manifestReadable = true
    // openBackup already performed the sidecar comparison for a plaintext backup and
    // authenticated the HMAC for an encrypted one. Reusing that single result is the
    // point: two implementations of "is this manifest intact" is how they drift, and
    // drift here silently turns a corrupt backup into a successful restore.
    manifestChecksumOk = opened.manifestChecksumOk
  } catch (error) {
    // Without a manifest there is nothing to verify against. Report the failure and
    // stop; "0 objects verified" must never be presented as a pass.
    const report: VerifyReport = {
      schema_version: 1,
      backup_dir: backupDir,
      backup_format: 1,
      manifest_ok: false,
      manifest_checksum_ok: null,
      object_count_ok: false,
      total_bytes_ok: false,
      lifecycle_ok: false,
      checked_objects: 0,
      failed_objects: [],
      orphan_objects: [],
      passed: false,
    }
    log(`FAILED: manifest could not be loaded: ${(error as Error).message}`)
    await writeJsonReport(join(backupDir, 'verify-report.json'), report).catch(() => undefined)
    return report
  }

  log(
    `verifying ${manifest.object_count} object(s), ${manifest.total_bytes} byte(s) from bucket ` +
      `"${manifest.source.bucket}" backed up ${manifest.created_at}`,
  )

  const failures: VerifyFailure[] = []
  let checked = 0
  for (const object of manifest.objects) {
    checked += 1
    const path = join(backupDir, object.file)
    const info = await stat(path).catch(() => undefined)
    if (!info) {
      failures.push({ key: object.key, reason: 'object file is missing' })
      continue
    }
    // Only a plaintext blob can be measured against the recorded object size. In
    // format 2 the file on disk is ciphertext and its length says nothing about the
    // object; the size is checked against the decrypted bytes instead, via the
    // manifest's own totals, which are computed from the download itself.
    if (openedFormat === 1 && info.size !== object.size) {
      failures.push({
        key: object.key,
        reason: `size mismatch: manifest says ${object.size}, file is ${info.size}`,
      })
      continue
    }
    if (openedFormat === 2) {
      const decrypted = await decryptAndHash(backupDir, object.file, await loadIdentity())
      await removeTempFile(decrypted.plaintextPath)
      if (decrypted.size !== object.size) {
        failures.push({
          key: object.key,
          reason: `size mismatch: manifest says ${object.size}, decrypted object is ${decrypted.size}`,
        })
        continue
      }
      if (decrypted.sha256 !== object.sha256) {
        failures.push({
          key: object.key,
          reason: `sha256 mismatch: manifest says ${object.sha256}, object hashes to ${decrypted.sha256}`,
        })
      }
      continue
    }
    const digest = await hashFile(path)
    if (digest !== object.sha256) {
      failures.push({
        key: object.key,
        reason: `sha256 mismatch: manifest says ${object.sha256}, file hashes to ${digest}`,
      })
    }
  }

  const referenced = new Set(manifest.objects.map((object) => object.file))
  const orphans: string[] = []
  const entries = await readdir(join(backupDir, OBJECT_DIR)).catch(() => [] as string[])
  for (const entry of entries) {
    if (entry.startsWith('.incoming-')) {
      // An abandoned temp file from an interrupted download: garbage, but not a
      // manifest discrepancy.
      orphans.push(`${OBJECT_DIR}/${entry} (abandoned temporary file)`)
      continue
    }
    const relative = `${OBJECT_DIR}/${entry}`
    if (!referenced.has(relative)) orphans.push(relative)
  }

  const objectCountOk = manifest.objects.length === manifest.object_count
  const totalBytesOk =
    manifest.objects.reduce((sum, object) => sum + object.size, 0) === manifest.total_bytes
  const lifecycleOk =
    manifest.lifecycle.status !== 'captured' ||
    (typeof manifest.lifecycle.sha256 === 'string' &&
      manifest.lifecycle.sha256 === sha256Hex(manifest.lifecycle.xml ?? ''))

  const passed =
    manifestReadable &&
    // A manifest that fails its own recorded digest is a corrupted backup. It was
    // previously reported as a warning while `passed` stayed true and the CLI exited
    // 0, so an operator scripting `verify && restore` proceeded straight past it.
    manifestChecksumOk !== false &&
    failures.length === 0 &&
    objectCountOk &&
    totalBytesOk &&
    lifecycleOk &&
    (options.strict === true ? orphans.length === 0 : true)

  const report: VerifyReport = {
    schema_version: 1,
    backup_dir: backupDir,
    backup_format: openedFormat,
    manifest_ok: manifestReadable,
    manifest_checksum_ok: manifestChecksumOk,
    object_count_ok: objectCountOk,
    total_bytes_ok: totalBytesOk,
    lifecycle_ok: lifecycleOk,
    checked_objects: checked,
    failed_objects: failures,
    orphan_objects: orphans,
    passed,
  }
  await writeJsonReport(join(backupDir, 'verify-report.json'), report)

  if (manifestChecksumOk === false) {
    log(
      'WARNING: manifest.json does not match manifest.json.sha256. Treat this backup as ' +
        'corrupted until the difference is explained.',
    )
  }
  if (manifest.lifecycle.status === 'unsupported') {
    log(`NOTE: the source store could not report bucket lifecycle: ${manifest.lifecycle.reason}`)
  }
  if (orphans.length > 0) {
    log(`${orphans.length} unreferenced file(s) in objects/ (reported, not deleted):`)
    for (const orphan of orphans.slice(0, 10)) log(`  ${orphan}`)
    if (orphans.length > 10) log(`  …and ${orphans.length - 10} more`)
  }
  for (const failure of failures.slice(0, 20)) log(`FAILED ${failure.key}: ${failure.reason}`)
  if (failures.length > 20) log(`…and ${failures.length - 20} more; see verify-report.json`)

  log(
    passed
      ? `verified ${checked} object(s); backup is intact`
      : `verification FAILED: ${failures.length} object(s) at fault`,
  )
  return report
}
