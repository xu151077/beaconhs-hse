import type { RoleScope } from '@beaconhs/db/schema'

/**
 * Serialize the scope picker's local state into the `RoleScope` the server
 * stores.
 *
 * Kept pure and exported so the tenant-wide branch is covered by a unit test:
 * when it was missing from the component's switch, choosing "Everyone in the
 * tenant" fell through to the default and SAVED `{ type: 'self' }`, so the
 * assignment list showed "Own records only" for both options.
 */
export type ScopeDraft = {
  type: RoleScope['type']
  siteIds?: string[]
  crewIds?: string[]
  personIds?: string[]
  departmentIds?: string[]
  groupIds?: string[]
}

export function toRoleScope(draft: ScopeDraft): RoleScope {
  switch (draft.type) {
    case 'tenant':
      return { type: 'tenant' }
    case 'sites':
      return { type: 'sites', siteIds: draft.siteIds ?? [] }
    case 'crews':
      return { type: 'crews', crewIds: draft.crewIds ?? [] }
    case 'people':
      return { type: 'people', personIds: draft.personIds ?? [] }
    case 'team':
      return {
        type: 'team',
        departmentIds: draft.departmentIds ?? [],
        groupIds: draft.groupIds ?? [],
      }
    case 'self':
      return { type: 'self' }
    default:
      // Unknown variants must surface, not silently become 'self' — that is
      // exactly the bug this module exists to prevent.
      throw new Error(`Unknown scope type: ${(draft as { type: string }).type}`)
  }
}
