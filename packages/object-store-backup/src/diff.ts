// Difference inventory: what changed between a baseline manifest and a store.
//
// WHY THIS IS SEPARATE FROM `backup`
//
// A backup answers "what is there". Migration and rollback need the other
// question: "what changed". Answering it honestly is harder than it looks, because
// the two sides rarely have the same evidence available:
//
//   * a manifest produced by `backup` carries a content SHA-256 for every object,
//     so a content comparison is authoritative;
//   * a live inventory carries only keys and sizes, so a same-size object is
//     UNPROVABLE — the tool must say `UNKNOWN` rather than `UNCHANGED`.
//
// ETag is deliberately never used here. It is not interchangeable with SHA-256
// (a multipart ETag is `<md5>-<partcount>`, and not every store returns an MD5 at
// all), so treating it as one would turn a guess into a reported fact. The tool
// would rather report "cannot determine" than report "unchanged" wrongly.
//
// THIS COMMAND NEVER WRITES. It produces evidence. It deletes nothing, uploads
// nothing, and cannot be used to change a store.

import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MANIFEST_NAME } from './hash'
import type { Manifest } from './manifest'
import { openBackup, MANIFEST_ENC_NAME } from './vault'
import { listAllObjects } from './s3'
import type { S3Client } from '@aws-sdk/client-s3'

type DiffClass = 'ADDED' | 'MODIFIED' | 'DELETED' | 'UNCHANGED' | 'UNKNOWN'

type DiffEntry = {
  key: string
  class: DiffClass
  /** Why it landed in that class — the reason an operator acts on. */
  reason: string
  baseSize?: number
  currentSize?: number
  baseSha256?: string
  currentSha256?: string
  /** Which tracked attributes changed, when the class is MODIFIED. */
  changedAttributes?: string[]
}

type DiffCounts = {
  added: number
  modified: number
  deleted: number
  unchanged: number
  unknown: number
}

export type DiffReport = {
  schema_version: 1
  baseline: {
    manifest_sha256: string
    created_at: string
    endpoint: string
    bucket: string
    object_count: number
    total_bytes: number
  }
  current: {
    mode: 'manifest' | 'live-inventory'
    manifest_sha256?: string
    endpoint: string
    bucket: string
    object_count: number
    total_bytes: number
  }
  counts: DiffCounts
  /**
   * True only when both sides come from manifests. A live inventory cannot prove
   * anything about content, so it can never be an atomic snapshot of the source.
   */
  content_comparison_authoritative: boolean
  objects: DiffEntry[]
  notes: string[]
}

/** One side of the comparison, in the shape the diff needs. */
export type Side = {
  endpoint: string
  bucket: string
  created_at: string
  entries: Map<string, DiffableObject>
}

type DiffableObject = {
  size: number
  sha256?: string
  contentType?: string | null
  contentDisposition?: string | null
  metadata?: Record<string, string>
  tags?: Record<string, string>
}

function toSide(manifest: Manifest, manifestDigest: string): { side: Side; digest: string } {
  const entries = new Map<string, DiffableObject>()
  for (const object of manifest.objects) {
    entries.set(object.key, {
      size: object.size,
      sha256: object.sha256,
      contentType: object.contentType,
      contentDisposition: object.contentDisposition,
      metadata: object.metadata,
      tags: object.tags,
    })
  }
  return {
    digest: manifestDigest,
    side: {
      endpoint: manifest.source.endpoint,
      bucket: manifest.source.bucket,
      created_at: manifest.created_at,
      entries,
    },
  }
}

/** A live inventory: keys and sizes only, never a content hash. */
async function toLiveSide(client: S3Client, endpoint: string, bucket: string): Promise<Side> {
  const entries = new Map<string, DiffableObject>()
  const objects = await listAllObjects(client, bucket)
  for (const object of objects) entries.set(object.key, { size: object.size })
  return {
    endpoint,
    bucket,
    created_at: new Date().toISOString(),
    entries,
  }
}

/** The attributes a change to which makes an object "modified" even at equal hash. */
function changedAttributes(base: DiffableObject, current: DiffableObject): string[] {
  const changed: string[] = []
  const eq = (
    a: Record<string, string> | undefined,
    b: Record<string, string> | undefined,
  ): boolean => {
    const norm = (r?: Record<string, string>): [string, string][] =>
      Object.entries(r ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
  }
  if ((base.contentType ?? null) !== (current.contentType ?? null)) changed.push('contentType')
  if ((base.contentDisposition ?? null) !== (current.contentDisposition ?? null))
    changed.push('contentDisposition')
  if (!eq(base.metadata, current.metadata)) changed.push('metadata')
  if (!eq(base.tags, current.tags)) changed.push('tags')
  return changed
}

export type ComputeDiffInput = {
  baseSide: Side
  currentSide: Side
  /**
   * True when the current side carries trusted content hashes (i.e. it came from a
   * manifest). False for a live inventory, which forces same-size objects into
   * UNKNOWN rather than UNCHANGED.
   */
  currentHasContent: boolean
  baseManifestDigest: string
  currentManifestDigest?: string
}

export function computeDiff(input: ComputeDiffInput): DiffReport {
  const { baseSide, currentSide, currentHasContent, baseManifestDigest, currentManifestDigest } =
    input
  const notes: string[] = []

  if (baseSide.bucket !== currentSide.bucket) {
    throw new Error(
      `refusing to diff different buckets: baseline is "${baseSide.bucket}", current is ` +
        `"${currentSide.bucket}". A cross-bucket diff has no meaning and would delete ` +
        `the wrong objects if it were ever acted on.`,
    )
  }
  if (baseSide.endpoint !== currentSide.endpoint) {
    notes.push(
      `baseline and current endpoints differ (${baseSide.endpoint} vs ${currentSide.endpoint}); ` +
        'this is expected when rolling back from one store to another.',
    )
  }
  if (!currentHasContent) {
    notes.push(
      'The current side is a live inventory and carries only keys and sizes. Objects present ' +
        'on both sides are reported as UNKNOWN unless their size differs: the tool does not ' +
        'read object bodies during an inventory, so it cannot prove content is unchanged. Run a ' +
        'full backup to obtain content hashes and a trustworthy UNCHANGED classification.',
    )
  }
  notes.push(
    'This report is not an atomic snapshot. If the source keeps taking writes while the ' +
      'inventory runs, objects created afterwards are absent and objects modified in between ' +
      'may be recorded at their older version.',
  )

  const objects: DiffEntry[] = []
  const counts: DiffCounts = { added: 0, modified: 0, deleted: 0, unchanged: 0, unknown: 0 }

  for (const [key, base] of baseSide.entries) {
    const current = currentSide.entries.get(key)
    if (current === undefined) {
      counts.deleted += 1
      objects.push({
        key,
        class: 'DELETED',
        reason: 'present in the baseline, absent from the source now',
        baseSize: base.size,
        ...(base.sha256 ? { baseSha256: base.sha256 } : {}),
      })
      continue
    }
    if (base.size !== current.size) {
      counts.modified += 1
      objects.push({
        key,
        class: 'MODIFIED',
        reason: 'size differs',
        baseSize: base.size,
        currentSize: current.size,
        ...(base.sha256 ? { baseSha256: base.sha256 } : {}),
      })
      continue
    }
    if (!currentHasContent || current.sha256 === undefined) {
      counts.unknown += 1
      objects.push({
        key,
        class: 'UNKNOWN',
        reason:
          'present on both sides with the same size, but the current content hash is not available',
        baseSize: base.size,
        currentSize: current.size,
        ...(base.sha256 ? { baseSha256: base.sha256 } : {}),
      })
      continue
    }
    const attrs = changedAttributes(base, current)
    if (attrs.length > 0) {
      counts.modified += 1
      objects.push({
        key,
        class: 'MODIFIED',
        reason: `content identical but tracked attributes changed: ${attrs.join(', ')}`,
        baseSize: base.size,
        currentSize: current.size,
        ...(base.sha256 ? { baseSha256: base.sha256 } : {}),
        ...(current.sha256 ? { currentSha256: current.sha256 } : {}),
        changedAttributes: attrs,
      })
      continue
    }
    if (base.sha256 === current.sha256) {
      counts.unchanged += 1
      objects.push({
        key,
        class: 'UNCHANGED',
        reason: 'content hash and tracked attributes match',
        baseSize: base.size,
        currentSize: current.size,
      })
    } else {
      counts.modified += 1
      objects.push({
        key,
        class: 'MODIFIED',
        reason: 'content sha256 differs',
        baseSize: base.size,
        currentSize: current.size,
        ...(base.sha256 ? { baseSha256: base.sha256 } : {}),
        ...(current.sha256 ? { currentSha256: current.sha256 } : {}),
      })
    }
  }

  for (const [key, current] of currentSide.entries) {
    if (baseSide.entries.has(key)) continue
    counts.added += 1
    objects.push({
      key,
      class: 'ADDED',
      reason: 'present in the source, absent from the baseline',
      currentSize: current.size,
      ...(current.sha256 ? { currentSha256: current.sha256 } : {}),
    })
  }

  objects.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))

  return {
    schema_version: 1,
    baseline: {
      manifest_sha256: baseManifestDigest,
      created_at: baseSide.created_at,
      endpoint: baseSide.endpoint,
      bucket: baseSide.bucket,
      object_count: baseSide.entries.size,
      total_bytes: [...baseSide.entries.values()].reduce((sum, entry) => sum + entry.size, 0),
    },
    current: {
      mode: currentHasContent ? 'manifest' : 'live-inventory',
      ...(currentManifestDigest !== undefined ? { manifest_sha256: currentManifestDigest } : {}),
      endpoint: currentSide.endpoint,
      bucket: currentSide.bucket,
      object_count: currentSide.entries.size,
      total_bytes: [...currentSide.entries.values()].reduce((sum, entry) => sum + entry.size, 0),
    },
    counts,
    content_comparison_authoritative: currentHasContent,
    objects,
    notes,
  }
}

export type RunDiffOptions = {
  /** Path to a baseline manifest, or to a directory containing one. */
  baselinePath: string
  /** Optional second manifest. When absent, the configured store is inventoried live. */
  currentManifestPath?: string
  client?: S3Client
  endpoint?: string
  bucket?: string
  outputPath?: string
  log?: (line: string) => void
}

/**
 * Build a diff report and, when asked, write it atomically.
 *
 * The report is written to a temporary name and renamed, so an interrupted run can
 * never leave a half-written file that a later step would read as complete.
 */
export async function runDiff(options: RunDiffOptions): Promise<DiffReport> {
  const log = options.log ?? ((line: string) => console.log(line))

  let baselineManifest: Manifest
  let baselineDigest: string
  try {
    // `openBackup` reads either format: a plaintext manifest, or a format-2 one
    // which it decrypts and whose HMAC it verifies. Diffing two encrypted backups is
    // the normal case once `--encrypt` is in use, and it must not silently fall back
    // to looking for a `manifest.json` that does not exist.
    const opened = await openBackup(resolveManifestDir(options.baselinePath))
    baselineManifest = opened.manifest
    baselineDigest = opened.manifestDigest
  } catch (error) {
    throw new Error(`baseline manifest is unusable: ${(error as Error).message}`)
  }

  let currentSide: Side
  let currentHasContent: boolean
  let currentManifestDigest: string | undefined

  if (options.currentManifestPath !== undefined) {
    let loaded: Awaited<ReturnType<typeof openBackup>>
    try {
      loaded = await openBackup(resolveManifestDir(options.currentManifestPath))
    } catch (error) {
      throw new Error(`current manifest is unusable: ${(error as Error).message}`)
    }
    currentSide = toSide(loaded.manifest, loaded.manifestDigest).side
    currentManifestDigest = loaded.manifestDigest
    currentHasContent = true
  } else {
    if (!options.client || !options.endpoint || !options.bucket) {
      throw new Error(
        'a live inventory diff needs a target store; pass --endpoint/--bucket and credentials, ' +
          'or pass --current with a second manifest',
      )
    }
    currentSide = await toLiveSide(options.client, options.endpoint, options.bucket)
    currentHasContent = false
  }

  const report = computeDiff({
    baseSide: toSide(baselineManifest, baselineDigest).side,
    currentSide,
    currentHasContent,
    baseManifestDigest: baselineDigest,
    ...(currentManifestDigest !== undefined ? { currentManifestDigest } : {}),
  })

  if (options.outputPath !== undefined) {
    const temp = `${options.outputPath}.tmp`
    await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, options.outputPath)
    log(`diff report: ${options.outputPath}`)
  }

  log(
    `diff: ${report.counts.added} added, ${report.counts.modified} modified, ` +
      `${report.counts.deleted} deleted, ${report.counts.unchanged} unchanged, ` +
      `${report.counts.unknown} unknown`,
  )
  for (const note of report.notes) log(`note: ${note}`)
  return report
}

/**
 * Accept either a manifest file or the backup directory that holds it, and return
 * the DIRECTORY. `openBackup` resolves the manifest itself and detects the format,
 * so all this has to do is strip a trailing manifest filename — including the
 * encrypted one, since `--encrypt` backups have no `manifest.json` at all.
 */
function resolveManifestDir(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  for (const name of [MANIFEST_ENC_NAME, MANIFEST_NAME]) {
    if (trimmed.endsWith(`/${name}`) || trimmed === name) {
      return trimmed.slice(0, -(name.length + 1)) || '/'
    }
  }
  return trimmed
}
