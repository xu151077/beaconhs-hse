import { can, type RequestContext } from '@beaconhs/tenant'

export type JournalMutation = 'edit' | 'submit'
type JournalMutationScope = 'read_scope' | 'self' | 'none'

/**
 * A read tier never widens a write tier. Only journals.assign authorizes
 * writes to another person's visible entry; update.own and submit stay
 * self-scoped even when a custom role also has read.site/read.all.
 */
export function journalMutationScope(
  ctx: RequestContext,
  mutation: JournalMutation,
): JournalMutationScope {
  if (ctx.isSuperAdmin || can(ctx, 'journals.assign')) return 'read_scope'
  if (mutation === 'edit' && can(ctx, 'journals.update.own')) return 'self'
  if (mutation === 'submit' && can(ctx, 'journals.submit')) return 'self'
  return 'none'
}

export function canCreateJournal(ctx: RequestContext): boolean {
  return ctx.isSuperAdmin || can(ctx, 'journals.create')
}

export function canEmailJournal(ctx: RequestContext): boolean {
  return ctx.isSuperAdmin || can(ctx, 'journals.submit') || can(ctx, 'journals.assign')
}

/**
 * The flags a client view needs to decide which buttons to render, resolved from
 * the SAME `journalMutationScope` the server actions enforce. These are a UX
 * affordance only: every action re-checks its own scope, so a stale or forged
 * flag cannot widen a write. Exported so a view never re-derives the policy from
 * raw `can()` calls and risks drifting from it.
 */
export function journalMutationFlags(ctx: RequestContext): {
  canCreate: boolean
  canEdit: boolean
  canSubmit: boolean
} {
  return {
    canCreate: canCreateJournal(ctx),
    canEdit: journalMutationScope(ctx, 'edit') !== 'none',
    canSubmit: journalMutationScope(ctx, 'submit') !== 'none',
  }
}
