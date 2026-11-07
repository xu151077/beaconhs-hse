// The inventory command: read-only accounting of what a store actually holds.
//
// WHY IT IS READ-ONLY AND ALWAYS FIRST
//
// Every migration and every backup starts by answering "what is there?". Doing that
// as a separate, side-effect-free step means the number can be taken before anything
// is copied, taken again afterwards, and compared. A tool that folds inventory into
// the copy cannot give you that pair of numbers, and a migration without before and
// after counts has no way to prove it did not lose an object.

import { writeFile } from 'node:fs/promises'
import type { S3Client } from '@aws-sdk/client-s3'
import type { StoreConfig } from './config'
import { redactEndpoint } from './config'
import { MULTIPART_THRESHOLD_BYTES, bucketExists, listAllObjects, readBucketLifecycle } from './s3'

export type InventoryOptions = {
  config: StoreConfig
  client: S3Client
  /** Write the JSON report here. Omitted: print only. */
  outputPath?: string
  log?: (line: string) => void
}

export type InventoryReport = {
  schema_version: 1
  source: { endpoint: string; bucket: string; region: string }
  bucket_exists: boolean
  object_count: number
  total_bytes: number
  smallest_object_bytes: number | null
  largest_object_bytes: number | null
  /** Objects at or above the size where this tool switches to multipart. */
  multipart_candidates: number
  lifecycle: {
    status: 'captured' | 'none' | 'unsupported'
    reason?: string
    sha256?: string
  }
}

export async function runInventory(options: InventoryOptions): Promise<InventoryReport> {
  const log = options.log ?? ((line: string) => console.log(line))
  const { config, client } = options

  const exists = await bucketExists(client, config.bucket)
  if (!exists) {
    log(
      `bucket "${config.bucket}" does not exist on ${redactEndpoint(config.endpoint)}; ` +
        `nothing to inventory`,
    )
    const report: InventoryReport = {
      schema_version: 1,
      source: {
        endpoint: redactEndpoint(config.endpoint),
        bucket: config.bucket,
        region: config.region,
      },
      bucket_exists: false,
      object_count: 0,
      total_bytes: 0,
      smallest_object_bytes: null,
      largest_object_bytes: null,
      multipart_candidates: 0,
      lifecycle: { status: 'none' },
    }
    if (options.outputPath)
      await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    return report
  }

  const objects = await listAllObjects(client, config.bucket)
  const sizes = objects.map((object) => object.size)
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0)
  const lifecycle = await readBucketLifecycle(client, config.bucket)

  const report: InventoryReport = {
    schema_version: 1,
    source: {
      endpoint: redactEndpoint(config.endpoint),
      bucket: config.bucket,
      region: config.region,
    },
    bucket_exists: true,
    object_count: objects.length,
    total_bytes: totalBytes,
    smallest_object_bytes: sizes.length > 0 ? Math.min(...sizes) : null,
    largest_object_bytes: sizes.length > 0 ? Math.max(...sizes) : null,
    multipart_candidates: objects.filter((object) => object.size >= MULTIPART_THRESHOLD_BYTES)
      .length,
    lifecycle:
      lifecycle.status === 'captured'
        ? { status: 'captured', sha256: lifecycle.sha256 }
        : lifecycle.status === 'none'
          ? { status: 'none' }
          : { status: 'unsupported', reason: lifecycle.reason },
  }

  log(`endpoint:        ${report.source.endpoint}`)
  log(`bucket:          ${config.bucket}`)
  log(`objects:         ${report.object_count}`)
  log(`total bytes:     ${report.total_bytes}`)
  if (report.smallest_object_bytes !== null) {
    log(
      `smallest / largest object: ${report.smallest_object_bytes} / ${report.largest_object_bytes} bytes`,
    )
  }
  log(`multipart-sized (>= ${MULTIPART_THRESHOLD_BYTES} bytes): ${report.multipart_candidates}`)
  if (lifecycle.status === 'captured') {
    log(`lifecycle:       captured (sha256 ${lifecycle.sha256.slice(0, 16)}…)`)
  } else if (lifecycle.status === 'none') {
    log('lifecycle:       none configured')
  } else {
    log(`lifecycle:       COULD NOT BE READ — ${lifecycle.reason}`)
    log('                 this is a store capability gap; a restore will not reproduce it')
  }
  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    log(`report:          ${options.outputPath}`)
  }
  return report
}
