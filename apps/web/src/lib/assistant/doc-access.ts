// The single source of truth for "which controlled documents may this user read".
//
// Every document read surface composes this rule: the /documents list, the
// detail page, the reader, the assistant's read tools and the in-chat reader,
// global search, and the public REST API. Managers (documents.manage, or a
// super-admin) are unconstrained; everyone else sees PUBLISHED documents only.
// A manager's exemption is deliberately narrow — it waives the publication rule
// only, never the deleted-row rule.
//
// Callers remain responsible for their own `deleted_at IS NULL`. This helper
// answers exactly one question — may an unpublished document be seen — and
// folding soft-delete in here would silently change the meaning for every
// caller that already applies it separately.
//
// When adding a document read surface, compose this rather than restating the
// rule: a second copy is how the search results and the thing the reader opens
// drift apart.

import { eq, type SQL } from 'drizzle-orm'
import { documents } from '@beaconhs/db/schema'
import { can, type RequestContext } from '@beaconhs/tenant'

function canManageDocuments(ctx: RequestContext): boolean {
  return ctx.isSuperAdmin || can(ctx, 'documents.manage')
}

/** Extra WHERE restricting non-managers to published documents; undefined for managers. */
export function documentReadFilter(ctx: RequestContext): SQL | undefined {
  return canManageDocuments(ctx) ? undefined : eq(documents.status, 'published')
}
