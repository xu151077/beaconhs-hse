import { inArray, sql } from 'drizzle-orm'
import type { Database } from '@beaconhs/db'
import { roleAssignments, roles, type RoleScope } from '@beaconhs/db/schema'

type RoleAssignmentUpsert = {
  tenantId: string
  tenantUserId: string
  roleId: string
  /**
   * The scope to store. Omit it to take the ROLE's default (see
   * {@link defaultRoleScope}) — that is the right choice when the caller has no
   * scope to apply because the form did not supply one. Pass a value, including
   * `{type:'self'}`, whenever an administrator chose it: a deliberate choice is
   * never overwritten here.
   */
  scope?: RoleScope
}

/**
 * The scope a role gets when an administrator assigns it without choosing one.
 *
 * `tenant_admin` is the tenant's own administrator: it administers the org
 * structure, users and roles, so its default breadth is the whole company. Every
 * other role defaults to `{type:'self'}`.
 *
 * This is deliberately a DEFAULT AT ASSIGNMENT TIME, stored in
 * `role_assignments.scope`, rather than a rule in the authorisation path. The
 * resolver never reads a role name, so:
 *   • the decision is visible as data and can be narrowed per user;
 *   • granting `tenant_admin` with `{type:'sites'}` genuinely narrows it, and
 *     nothing silently re-widens it on the next save.
 */
function defaultRoleScope(roleKey: string): RoleScope {
  return roleKey === 'tenant_admin' ? { type: 'tenant' } : { type: 'self' }
}

/**
 * Set one or more member/role assignments atomically.
 *
 * Re-selecting an existing role means "replace its scope" throughout the
 * administration UI. The database enforces one row per
 * (tenant, member, role), so every writer must use the same conflict target
 * instead of a check-then-insert branch that can race with another request.
 */
export async function upsertRoleAssignments(
  tx: Database,
  assignments: readonly RoleAssignmentUpsert[],
): Promise<string[]> {
  if (assignments.length === 0) return []

  // Resolve the role defaults in ONE query for every unset assignment, so the
  // rule lives here rather than being restated at each of the six call sites.
  const unset = assignments.filter((a) => a.scope === undefined)
  let defaults = new Map<string, RoleScope>()
  if (unset.length > 0) {
    const keys = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(inArray(roles.id, [...new Set(unset.map((a) => a.roleId))]))
    defaults = new Map(keys.map((r) => [r.id, defaultRoleScope(r.key)]))
  }

  const rows = await tx
    .insert(roleAssignments)
    .values(
      assignments.map((a) => ({
        ...a,
        scope: a.scope ?? defaults.get(a.roleId) ?? { type: 'self' },
      })),
    )
    .onConflictDoUpdate({
      target: [roleAssignments.tenantId, roleAssignments.tenantUserId, roleAssignments.roleId],
      set: {
        scope: sql`excluded.scope`,
        updatedAt: sql`now()`,
      },
      // A repeated save of the same scope is a real no-op. PostgreSQL omits it
      // from RETURNING, which lets callers avoid false "changed" notices and
      // audit entries while remaining race-safe.
      setWhere: sql`${roleAssignments.scope} IS DISTINCT FROM excluded.scope`,
    })
    .returning({ membershipId: roleAssignments.tenantUserId })

  return rows.map((row) => row.membershipId)
}
