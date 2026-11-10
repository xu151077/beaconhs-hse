// PD-01 phase 2 — pure authorization decision for an API credential.
//
// The DB layer resolves three rows and hands them here; this module owns the
// decision so it can be exhaustively tested without a database, and so there is
// exactly one place that answers "what may this credential do".
//
// Rules (from the product decision):
//   - An unbound credential (principal_tenant_user_id IS NULL) keeps the legacy
//     tenant-level behaviour byte-for-byte: its `permissions` ARE the grant and
//     its scope is the whole tenant.
//   - A bound credential inherits the principal's permissions and RoleScope, and
//     may only NARROW them. Widening is a configuration error and fails closed.
//   - A missing, cross-tenant, or inactive principal fails closed.
//   - `personId` comes from the principal so `self`/`people` scopes work; an
//     unbound credential has no employee record and therefore no personId.

import type { RoleScope } from '@beaconhs/db/schema'
import { narrowRoleScopes } from '@beaconhs/tenant'

export type ApiCredentialRow = {
  id: string
  tenantId: string
  principalTenantUserId: string | null
  permissions: string[]
  scopes: RoleScope[] | null
}

export type ApiPrincipalRow = {
  id: string
  tenantId: string
  userId: string
  status: string
  displayName: string | null
}

export type ApiPrincipalAccess = {
  permissions: Set<string>
  scopes: RoleScope[]
}

type ApiAuthorizationFailure =
  | 'principal_missing'
  | 'principal_tenant_mismatch'
  | 'principal_inactive'
  | 'scope_exceeds_principal'

export type ApiAuthorization =
  | {
      ok: true
      bound: false
      userId: string
      permissions: Set<string>
      scopes: RoleScope[]
      personId: null
      membership: null
    }
  | {
      ok: true
      bound: true
      userId: string
      permissions: Set<string>
      scopes: RoleScope[]
      personId: string | null
      membership: { id: string; displayName: string }
    }
  | { ok: false; reason: ApiAuthorizationFailure }

/** Intersection: a credential may only hold permissions its principal also holds. */
function narrowPermissions(credential: string[], principal: Set<string>): Set<string> {
  const effective = new Set<string>()
  for (const permission of credential) {
    if (principal.has(permission)) effective.add(permission)
    else if (permission.endsWith('.*')) {
      // A wildcard credential grant survives only when the principal holds the
      // same wildcard; expanding it against individual keys would widen it.
      if (principal.has(permission)) effective.add(permission)
    }
  }
  return effective
}

export function authorizeApiCredential(args: {
  credential: ApiCredentialRow
  /** Null when the credential is unbound, or when the principal row is missing. */
  principal: ApiPrincipalRow | null
  /** Role-derived access for the principal; ignored when unbound. */
  access: ApiPrincipalAccess | null
  /** The principal's employee record in this tenant, when one exists. */
  personId: string | null
  /** Identity used for audit when the credential is unbound. */
  fallbackUserId: string
}): ApiAuthorization {
  const { credential, principal, access, personId, fallbackUserId } = args

  if (credential.principalTenantUserId === null) {
    // Legacy path: unchanged behaviour, explicitly not "bound".
    return {
      ok: true,
      bound: false,
      userId: fallbackUserId,
      permissions: new Set(credential.permissions),
      scopes: [{ type: 'tenant' }],
      personId: null,
      membership: null,
    }
  }

  if (!principal || principal.id !== credential.principalTenantUserId) {
    return { ok: false, reason: 'principal_missing' }
  }
  if (principal.tenantId !== credential.tenantId) {
    return { ok: false, reason: 'principal_tenant_mismatch' }
  }
  if (principal.status !== 'active') {
    return { ok: false, reason: 'principal_inactive' }
  }
  if (!access) return { ok: false, reason: 'principal_missing' }

  const narrowing = narrowRoleScopes(access.scopes, credential.scopes)
  if (!narrowing.ok) return { ok: false, reason: 'scope_exceeds_principal' }

  return {
    ok: true,
    bound: true,
    userId: principal.userId,
    permissions: narrowPermissions(credential.permissions, access.permissions),
    scopes: narrowing.scopes,
    personId,
    membership: { id: principal.id, displayName: principal.displayName ?? principal.id },
  }
}
