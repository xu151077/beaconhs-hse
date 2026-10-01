// Server-only helpers for the Journals module. Not a 'use server' file — these
// are plain functions consumed by the page (server component), the query layer
// and the action layer.

import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { journalEntries, people } from '@beaconhs/db/schema'
import { can, type RequestContext } from '@beaconhs/tenant'
import type { Database } from '@beaconhs/db'
export { htmlToText } from '@beaconhs/forms-core'
import { nextReference } from '@/lib/reference'

/** Can this context read every journal in the tenant (vs site/self scope)? */
export function journalCanReadAll(ctx: RequestContext): boolean {
  return ctx.isSuperAdmin || can(ctx, 'journals.read.all')
}

/** Managers/safety who may browse beyond their own entries (records page gate). */
export function journalCanBrowseAll(ctx: RequestContext): boolean {
  return journalCanReadAll(ctx) || can(ctx, 'journals.read.site')
}

/**
 * Visibility predicate for journal_entries based on the caller's read tier:
 *   read.all  → the whole tenant; no row filter, because RLS already bounds it
 *   read.site → entries at the caller's scoped sites, UNION their own
 *   read.self → only entries authored by, or created by, the caller (default)
 *
 * The caller's OWN entries are visible at every tier — a site-scoped reviewer
 * still sees a journal they wrote at another site or with no site set. This
 * mirrors the generalised `moduleScopeWhere` (see record-visibility model) so
 * journals behave like every other record module.
 *
 * `_tx` is retained for signature stability and is not read: the predicate
 * resolves entirely from `ctx` and `authorPersonId`. See `moduleScopeWhere` for
 * the same convention.
 */
export async function journalScopeWhere(
  ctx: RequestContext,
  _tx: Database,
  authorPersonId: string | null,
): Promise<SQL | undefined> {
  if (journalCanReadAll(ctx)) {
    // `journals.read.all` means the whole tenant, and that is the native
    // meaning — the same one `moduleScopeWhere` gives tier `all` (no row filter;
    // RLS already bounds the query). Returning `undefined` here is correct.
    //
    // SCOPE NOTE — deliberately narrow. Only this branch is the `all` tier. The
    // `.site` and `.self` branches below keep journals' own semantics, which
    // `moduleScopeWhere` does NOT share:
    //   • own entries visible at every tier, including outside the caller's sites
    //   • the `'super-admin'` sentinel guard in `authorTenantUserId`
    //   • `getAuthorPersonId`'s exclusion of soft-deleted employee rows
    // A wholesale migration to `moduleScopeWhere` would also close the `.site` /
    // `.self` under-exposure, but it would bind the own leg to the tier and break
    // all three of those. That is a product decision, tracked separately.
    return undefined
  }

  const own: SQL[] = []
  if (authorPersonId) own.push(eq(journalEntries.personId, authorPersonId))
  const tenantUserId = authorTenantUserId(ctx)
  if (tenantUserId) own.push(eq(journalEntries.createdByTenantUserId, tenantUserId))
  const ownWhere = own.length === 0 ? null : own.length === 1 ? own[0]! : or(...own)!

  if (can(ctx, 'journals.read.site')) {
    const siteIds = ctx.scopes.flatMap((s) => (s.type === 'sites' ? s.siteIds : []))
    if (siteIds.length > 0) {
      const siteWhere = inArray(journalEntries.siteOrgUnitId, siteIds)
      return ownWhere ? or(siteWhere, ownWhere)! : siteWhere
    }
  }

  return ownWhere ?? sql`false`
}

/** A specific author's entries (by subject person and/or the tenant_user who
 *  created them). `false` when neither is known. */
function journalByAuthorWhere(personId: string | null, tenantUserId: string | null): SQL {
  const conds: SQL[] = []
  if (personId) conds.push(eq(journalEntries.personId, personId))
  if (tenantUserId) conds.push(eq(journalEntries.createdByTenantUserId, tenantUserId))
  if (conds.length === 0) return sql`false`
  return conds.length === 1 ? conds[0]! : or(...conds)!
}

/**
 * Visibility for browsing a SPECIFIC author's journals (the records "Open full
 * entry" workspace): the target author's entries, AND-bounded by the viewer's
 * own read tier so an admin never sees beyond their scope (read.all → all of the
 * author's; read.site → the author's at the viewer's sites).
 */
export async function journalAuthorScopeWhere(
  ctx: RequestContext,
  tx: Database,
  viewerPersonId: string | null,
  target: { personId: string | null; tenantUserId: string | null },
): Promise<SQL> {
  const byAuthor = journalByAuthorWhere(target.personId, target.tenantUserId)
  // `journalScopeWhere` is awaited because it is async by signature, not because
  // it reads a transaction — `_tx` is unused. `journalByAuthorWhere` is
  // unchanged, so the author filter and its `false` fallback behave as before.
  const viewer = await journalScopeWhere(ctx, tx, viewerPersonId)
  return viewer ? and(byAuthor, viewer)! : byAuthor
}

/**
 * Self-ONLY visibility — the caller's own entries (authored as, or created by,
 * them), regardless of read.all / read.site. The compose workspace (/journals)
 * is always personal; cross-user browsing lives in /journals/records (gated by
 * journalCanBrowseAll). Uses authorTenantUserId so the super-admin sentinel is
 * never compared as a uuid; a context with no person and no membership resolves
 * to `false` (an empty personal workspace), never the whole tenant.
 */
export function journalSelfScopeWhere(ctx: RequestContext, authorPersonId: string | null): SQL {
  const conds: SQL[] = []
  if (authorPersonId) conds.push(eq(journalEntries.personId, authorPersonId))
  const tenantUserId = authorTenantUserId(ctx)
  if (tenantUserId) conds.push(eq(journalEntries.createdByTenantUserId, tenantUserId))
  if (conds.length === 0) return sql`false`
  return conds.length === 1 ? conds[0]! : or(...conds)!
}

/** The tenant_users id to attribute authorship to (null for super-admin view). */
export function authorTenantUserId(ctx: RequestContext): string | null {
  const id = ctx.membership?.id
  if (!id || id === 'super-admin') return null
  return id
}

/** Resolve the `people` row for the current user (the journal's subject). */
export async function getAuthorPersonId(ctx: RequestContext): Promise<string | null> {
  return ctx.db(async (tx) => {
    const [p] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.userId, ctx.userId), isNull(people.deletedAt)))
      .limit(1)
    return p?.id ?? null
  })
}

/** Next per-tenant reference like JRN-2026-0001 (RLS scopes the counter). */
export async function nextJournalReference(
  tx: Database,
  tenantId: string,
  year: number,
): Promise<string> {
  return nextReference(tx, tenantId, 'journal', year)
}

/**
 * Today as an ISO date (YYYY-MM-DD) in the given IANA timezone (ctx.timezone).
 * Never uses the server clock's date directly — in prod the container runs UTC,
 * so an evening entry would otherwise land on tomorrow's date for the author.
 */
export function todayISO(timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** Short single-line preview for list cards. */
export function snippetOf(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
