// Project Scope — compatibility re-export.
//
// The resolver moved to `packages/analytics/src/server/project-scope.ts` in
// 15B-3B, because `apps/worker` cannot import from `apps/web` and a scheduled
// report run-as a member must resolve the SAME scope the web app gives that
// member by hand. Placing it in `@beaconhs/analytics` added no new package
// dependency — that package already depends on `@beaconhs/db` for the schema.
//
// This file keeps every existing `from '@/lib/project-scope'` import working
// unchanged, so the 28 resolver contract tests, the 43 authorization-bridge
// tests and the live-database verification script all continue to run against
// the same implementation. There is exactly ONE resolver; this is a re-export of
// it, not a second copy.
//
// The `resolveProjectScopeIn` parameter order is now `(ctx, tx, options)` rather
// than 15B-2's `(tx, ctx, options)`. The single-argument-context shape is what
// makes the resolver usable from both apps, and both call sites have been
// updated. There is deliberately no compatibility overload for the old order:
// two argument orders for one function is how a silent mis-wiring happens.

export {
  MAX_ORG_UNIT_DEPTH,
  ancestorOrgUnitIds,
  buildOrgTreeIndex,
  descendantOrgUnitIds,
  resolveProjectScope,
  resolveProjectScopeIn,
  type OrgNode,
  type ProjectScope,
  type ProjectScopeEmptyReason,
} from '@beaconhs/analytics/server'

// The effective-date helpers (`todayIso`, `isAssignmentEffectiveOn`,
// `effectiveOn`, `IsoDate`) are deliberately NOT re-exported here. The web app
// imports them from `./assignment-validity`, which owns them for its own UI and
// server actions; re-exporting them from two modules would leave two import
// paths for one rule, which is how a reader ends up unsure which is canonical.
