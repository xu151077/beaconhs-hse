// CLI wrapper: emit the cutover verification SQL from the schema.
//
//   pnpm --filter @beaconhs/db emit:cutover-verification <snapshotFile> [outDir]
//
// Do NOT put a `--` separator before <snapshotFile>: pnpm forwards it to the
// script as a literal argument, and it would then be read as the snapshot path
// and fail with an ENOENT stack trace instead of a usage message. main() strips
// a leading `--` anyway so the documented form cannot break the tool.
//
// Read-only with respect to the database: the rollback array is read from the
// snapshot file, and every permission key in the generated SQL comes from
// PERMISSION_CATALOGUE. Nothing here connects to Postgres.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  renderPostMigrateSql,
  renderRollbackSql,
  type RoleSnapshot,
} from './emit-cutover-verification'

const SNAPSHOT_COLUMNS = ['id', 'tenant_id', 'key', 'is_built_in', 'permissions'] as const

/**
 * Parse the pipe-delimited `roles` snapshot used by the cutover artefacts.
 *
 * A malformed line throws rather than yielding a half-filled row: a snapshot that
 * silently lost a column would produce a rollback restoring the wrong permissions.
 */
export function parseRolesSnapshot(text: string): RoleSnapshot[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const columns = line.split('|')
      if (columns.length !== SNAPSHOT_COLUMNS.length) {
        throw new Error(
          `snapshot line must have ${SNAPSHOT_COLUMNS.length} '|'-separated columns, got ${columns.length}: ${line.slice(0, 80)}`,
        )
      }
      const [id = '', tenantId = '', key = '', isBuiltIn = '', permissions = ''] = columns
      if (!id || !tenantId || !key) {
        throw new Error(`snapshot line is missing a required column: ${line.slice(0, 80)}`)
      }
      const parsed: unknown = JSON.parse(permissions)
      if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string')) {
        throw new Error(`snapshot permissions for "${key}" is not a string array`)
      }
      return { id, tenantId, key, isBuiltIn: isBuiltIn === 't', permissions: parsed }
    })
}

/**
 * Drop argument separators before interpreting argv.
 *
 * `pnpm run script -- <args>` forwards a literal `--` to the script, and every
 * task runner documents that form. Without this, argv[0] is `--`, which is
 * truthy, so the usage guard is skipped and `--` is opened as a file — a raw
 * ENOENT stack trace instead of the usage line.
 */
export function normaliseArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== '--')
}

export function main(argv: string[]): number {
  const [snapshotPath, outDir = '.'] = normaliseArgs(argv)
  if (!snapshotPath) {
    console.error('usage: emit:cutover-verification <snapshotFile> [outDir]')
    return 2
  }
  const rows = parseRolesSnapshot(readFileSync(snapshotPath, 'utf8'))
  mkdirSync(outDir, { recursive: true })
  mkdirSync(dirname(`${outDir}/04-post-migrate.sql`), { recursive: true })

  const tenantId = rows[0]?.tenantId
  const target = rows.find((row) => row.key === 'foreman')
  if (!tenantId || !target) {
    console.error('snapshot must contain a tenant row and a "foreman" row')
    return 1
  }

  writeFileSync(
    `${outDir}/04-post-migrate.sql`,
    renderPostMigrateSql({ tenantId, targetRoleId: target.id }),
  )
  writeFileSync(`${outDir}/05-rollback.sql`, renderRollbackSql(target))
  console.log(
    `emitted 04-post-migrate.sql and 05-rollback.sql to ${outDir} (rollback from snapshot: ${target.permissions.length} keys)`,
  )
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
