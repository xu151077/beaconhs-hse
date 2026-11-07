// Test-only ownership guard for files and documents.
//
// WHY THIS EXISTS
//
// Phase EA-2's WOPI write test reused the only own-tenant DOCX it could see,
// because the test had no file of its own. The save therefore overwrote a
// pre-existing draft fixture in the local dev database, and the original bytes
// were not recoverable (no version snapshot existed).
//
// The rule this module enforces: a write test may only target a file it created
// itself, in this run, under a name it owns. Anything else — a seeded fixture, a
// browser-uploaded "untitled-*" draft, a document created by another phase — is
// refused before a single byte is written.
//
// The guard is deliberately narrow and test-only: it is imported by test code,
// never by product code, and it has no effect on production behaviour.

/** Prefix every EA-phase test artefact carries, so ownership is unambiguous. */
export const TEST_ASSET_PREFIX = 'ea3'

/** Characters that are safe in an object key and in a database slug. */
const SAFE = /^[a-z0-9][a-z0-9-]*$/

export type TestAsset = {
  /** Unique per run; used in the object key, slug, and document key. */
  runId: string
  /** Human-readable label, e.g. 'wopi-write'. */
  label: string
}

/**
 * A unique identity for one test asset. `runId` is a timestamp plus random
 * suffix, so two runs never collide and a run can be replayed safely.
 */
export function testAsset(label: string): TestAsset {
  const safeLabel = label.trim().toLowerCase()
  if (!SAFE.test(safeLabel)) {
    throw new Error(`test asset label must match ${SAFE}: got "${label}"`)
  }
  const runId = `${TEST_ASSET_PREFIX}-${safeLabel}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  return { runId, label: safeLabel }
}

/** The document key a test must use. Refuses anything not carrying the run id. */
export function testDocumentKey(asset: TestAsset): string {
  return asset.runId
}

/** The object key a test must use: tenant-scoped, as the schema requires. */
export function testObjectKey(asset: TestAsset, tenantId: string, filename: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
    throw new Error(`tenantId must be a UUID: got "${tenantId}"`)
  }
  const safeName = filename.replace(/[^\w.-]+/g, '_')
  return `t/${tenantId}/document/${asset.runId}-${safeName}`
}

/**
 * True when a value was created by this test run.
 *
 * The check is a substring test on the run id, not a database lookup: the point
 * is that a caller must *know* the asset it is about to write to, and a
 * pre-existing fixture can never satisfy that.
 */
export function isOwnedByTest(asset: TestAsset, value: string | null | undefined): boolean {
  return typeof value === 'string' && value.includes(asset.runId)
}

/**
 * Refuse to write to a target the test does not own.
 *
 * Throws with the offending value redacted to its first 24 characters, so a
 * failure names the target without dumping a whole object key or slug into the
 * log.
 */
export function assertOwnedByTest(
  asset: TestAsset,
  value: string | null | undefined,
  what: string,
): void {
  if (!isOwnedByTest(asset, value)) {
    const shown = typeof value === 'string' ? `${value.slice(0, 24)}…` : String(value)
    throw new Error(
      `[test-ownership] refusing to write to ${what} "${shown}": it was not created by this ` +
        `test run (${asset.runId}). Create a dedicated test asset instead of reusing an ` +
        'existing document, attachment, or object.',
    )
  }
}

/** Refuse to delete or mutate a database row the test does not own. */
export function assertOwnedRow(
  asset: TestAsset,
  row: { id: string; key?: string | null; r2Key?: string | null } | null | undefined,
): void {
  if (!row) throw new Error('[test-ownership] no row was found for the requested target')
  assertOwnedByTest(asset, row.id, 'row')
  if (row.key !== undefined) assertOwnedByTest(asset, row.key, 'document key')
  if (row.r2Key !== undefined) assertOwnedByTest(asset, row.r2Key, 'object key')
}
