import { sql, type SQL } from 'drizzle-orm'

/**
 * PD-02 P-1 audit role preflight (deployment gate).
 *
 * The audit role model is exactly two database roles, created by
 * `scripts/cluster/provision.sql` (the only path to CREATE ROLE — no
 * application role holds CREATEROLE):
 *
 *   audit_reader   NOLOGIN / BYPASSRLS — the ONLY cross-tenant audit identity;
 *                  SELECT on audit_log and nothing else.
 *   audit_service  LOGIN / NOBYPASSRLS — AUDIT_DATABASE_URL connection identity;
 *                  the sole member of audit_reader (assumed via SET LOCAL ROLE).
 *
 * These assertions run inside the migration flow on every execution and abort
 * deployment when the cluster does not match. Re-run the provision script to
 * converge a cluster that predates PD-02.
 */

export const AUDIT_READER_ROLE = 'audit_reader'
export const AUDIT_SERVICE_ROLE = 'audit_service'

/** Login roles that must NEVER be members of audit_reader. */
const FORBIDDEN_AUDIT_READER_MEMBERS = [
  'beaconhs_owner',
  'beaconhs_migrator',
  'beaconhs_app',
  'beaconhs_super',
  'beaconhs_backup',
] as const

const REMEDIATION =
  'Re-run scripts/cluster/provision.sql (as superuser, with -v audit_service_password=…) to converge the audit roles.'

type MinimalDatabase = {
  execute: (query: SQL) => Promise<unknown>
}

type AuditRoleRow = {
  role: string
  present: boolean
  can_login: boolean
  is_super: boolean
  bypass_rls: boolean
  owner_member: boolean
}

function allRows<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[])
}

/**
 * Attribute + membership gate. Runs before migrations (audit_log may not exist
 * yet on a fresh cluster); the privilege matrix is checked separately after
 * migrations by {@link assertAuditTablePrivileges}.
 */
export async function assertAuditRoleAttributes(db: MinimalDatabase, ownerRole: string) {
  const rows = allRows<AuditRoleRow>(
    await db.execute(sql`
      select
        rolname as role,
        true as present,
        rolcanlogin as can_login,
        rolsuper as is_super,
        rolbypassrls as bypass_rls,
        pg_has_role(rolname, ${ownerRole}, 'MEMBER') as owner_member
      from pg_roles
      where rolname in (${AUDIT_READER_ROLE}, ${AUDIT_SERVICE_ROLE})
    `),
  )
  const reader = rows.find((r) => r.role === AUDIT_READER_ROLE)
  const service = rows.find((r) => r.role === AUDIT_SERVICE_ROLE)
  if (!reader?.present || !service?.present) {
    throw new Error(
      `Audit role preflight failed: audit_reader/audit_service missing. ${REMEDIATION}`,
    )
  }
  if (reader.can_login || reader.is_super || !reader.bypass_rls || reader.owner_member) {
    throw new Error(
      `Audit role preflight failed: ${AUDIT_READER_ROLE} must be NOLOGIN, NOSUPERUSER, BYPASSRLS, and not an ${ownerRole} member. ${REMEDIATION}`,
    )
  }
  if (!service.can_login || service.is_super || service.bypass_rls || service.owner_member) {
    throw new Error(
      `Audit role preflight failed: ${AUDIT_SERVICE_ROLE} must be LOGIN, NOSUPERUSER, NOBYPASSRLS, and not an ${ownerRole} member. ${REMEDIATION}`,
    )
  }

  const readerMembers = allRows<{ member: string }>(
    await db.execute(sql`
      select member.rolname as member
      from pg_auth_members membership
      join pg_roles parent on parent.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
      where parent.rolname = ${AUDIT_READER_ROLE}
    `),
  ).map((r) => r.member)
  const unexpected = readerMembers.filter((m) => m !== AUDIT_SERVICE_ROLE)
  if (!readerMembers.includes(AUDIT_SERVICE_ROLE) || unexpected.length > 0) {
    throw new Error(
      `Audit role preflight failed: ${AUDIT_READER_ROLE} must be granted to ${AUDIT_SERVICE_ROLE} only` +
        (unexpected.length > 0 ? ` (unexpected members: ${unexpected.join(', ')})` : '') +
        `. ${REMEDIATION}`,
    )
  }

  // audit_service must never hold membership in the owner role (it would gain
  // DDL and grant rights through SET ROLE).
  const serviceOwnerMember = allRows<{ member: boolean }>(
    await db.execute(sql`
      select pg_has_role(${AUDIT_SERVICE_ROLE}, ${ownerRole}, 'MEMBER') as member
    `),
  )[0]?.member
  if (serviceOwnerMember) {
    throw new Error(
      `Audit role preflight failed: ${AUDIT_SERVICE_ROLE} must not be a member of ${ownerRole}. ${REMEDIATION}`,
    )
  }
  return `audit roles verified (${AUDIT_READER_ROLE} NOLOGIN/BYPASSRLS; sole member ${AUDIT_SERVICE_ROLE})`
}

/**
 * Converge the audit privilege set as part of the migration flow. Idempotent:
 * strips any stray table privilege from either audit role, then grants the
 * minimal surface:
 *
 *   audit_reader  — SELECT audit_log (assumed via SET LOCAL ROLE only).
 *   audit_service — SELECT/INSERT/UPDATE on audit_access_grants (request,
 *                   approve, revoke) and SELECT/INSERT on
 *                   platform_audit_access_log (append-only trail); everything
 *                   else stays with beaconhs_owner only.
 *
 * Both roles also get USAGE on schema public: grant resolution, budget checks
 * and trail writes run as audit_service BEFORE the SET LOCAL ROLE switch, so
 * the base login must resolve unqualified names in public. USAGE grants no
 * object privileges — table grants below stay minimal.
 *
 * Runs as the database owner.
 */
export async function convergeAuditPrivileges(db: MinimalDatabase) {
  await db.execute(
    sql`grant usage on schema public to ${sql.raw(`"${AUDIT_READER_ROLE}"`)}, ${sql.raw(`"${AUDIT_SERVICE_ROLE}"`)}`,
  )
  await db.execute(
    sql`revoke all privileges on all tables in schema public from ${sql.raw(`"${AUDIT_READER_ROLE}"`)}, ${sql.raw(`"${AUDIT_SERVICE_ROLE}"`)}`,
  )
  await db.execute(sql`grant select on public.audit_log to ${sql.raw(`"${AUDIT_READER_ROLE}"`)}`)
  await db.execute(
    sql`grant select, insert, update on public.audit_access_grants to ${sql.raw(`"${AUDIT_SERVICE_ROLE}"`)}`,
  )
  await db.execute(
    sql`grant select, insert on public.platform_audit_access_log to ${sql.raw(`"${AUDIT_SERVICE_ROLE}"`)}`,
  )
}

/**
 * Privilege matrix gate. Runs after migrations so audit_log exists. Fails when
 * audit_reader can read any business table or write audit_log, or when
 * audit_service holds direct table privileges (it must gain everything through
 * SET LOCAL ROLE only).
 */
export async function assertAuditTablePrivileges(db: MinimalDatabase) {
  const auditLogExists = allRows<{ present: boolean }>(
    await db.execute(sql`select to_regclass('public.audit_log') is not null as present`),
  )[0]?.present
  if (!auditLogExists) {
    throw new Error('Audit privilege preflight failed: public.audit_log does not exist')
  }

  const schemaUsage = allRows<{ reader: boolean; service: boolean }>(
    await db.execute(sql`
      select
        has_schema_privilege(${AUDIT_READER_ROLE}, 'public', 'USAGE') as reader,
        has_schema_privilege(${AUDIT_SERVICE_ROLE}, 'public', 'USAGE') as service
    `),
  )[0]
  if (!schemaUsage?.reader || !schemaUsage?.service) {
    const who = !schemaUsage?.reader ? AUDIT_READER_ROLE : AUDIT_SERVICE_ROLE
    throw new Error(
      `Audit privilege preflight failed: ${who} lacks USAGE on schema public. ${REMEDIATION}`,
    )
  }

  const auditLogPrivs = allRows<{
    can_select: boolean
    can_insert: boolean
    can_update: boolean
    can_delete: boolean
  }>(
    await db.execute(sql`
      select
        has_table_privilege(${AUDIT_READER_ROLE}, 'public.audit_log', 'SELECT') as can_select,
        has_table_privilege(${AUDIT_READER_ROLE}, 'public.audit_log', 'INSERT') as can_insert,
        has_table_privilege(${AUDIT_READER_ROLE}, 'public.audit_log', 'UPDATE') as can_update,
        has_table_privilege(${AUDIT_READER_ROLE}, 'public.audit_log', 'DELETE') as can_delete
    `),
  )[0]
  if (
    !auditLogPrivs?.can_select ||
    auditLogPrivs.can_insert ||
    auditLogPrivs.can_update ||
    auditLogPrivs.can_delete
  ) {
    throw new Error(
      `Audit privilege preflight failed: ${AUDIT_READER_ROLE} must hold SELECT — and nothing else — on public.audit_log. ${REMEDIATION}`,
    )
  }

  // Exact privilege set on the two platform tables for audit_service — the
  // allowlist below skips them, so assert the intended shape here (in
  // particular: no DELETE anywhere, no UPDATE on the append-only log).
  const servicePrivs = allRows<{
    grants_select: boolean
    grants_insert: boolean
    grants_update: boolean
    grants_delete: boolean
    log_select: boolean
    log_insert: boolean
    log_update: boolean
    log_delete: boolean
  }>(
    await db.execute(sql`
      select
        has_table_privilege(${AUDIT_SERVICE_ROLE}, 'public.audit_access_grants', 'SELECT') as grants_select,
        has_table_privilege(${AUDIT_SERVICE_ROLE}, 'public.audit_access_grants', 'INSERT') as grants_insert,
        has_table_privilege(${AUDIT_SERVICE_ROLE}, 'public.audit_access_grants', 'UPDATE') as grants_update,
        has_table_privilege(${AUDIT_SERVICE_ROLE}, 'public.audit_access_grants', 'DELETE') as grants_delete,
        has_table_privilege(${AUDIT_SERVICE_ROLE}, 'public.platform_audit_access_log', 'SELECT') as log_select,
        has_table_privilege(${AUDIT_SERVICE_ROLE}, 'public.platform_audit_access_log', 'INSERT') as log_insert,
        has_table_privilege(${AUDIT_SERVICE_ROLE}, 'public.platform_audit_access_log', 'UPDATE') as log_update,
        has_table_privilege(${AUDIT_SERVICE_ROLE}, 'public.platform_audit_access_log', 'DELETE') as log_delete
    `),
  )[0]
  if (
    !servicePrivs ||
    !servicePrivs.grants_select ||
    !servicePrivs.grants_insert ||
    !servicePrivs.grants_update ||
    servicePrivs.grants_delete ||
    !servicePrivs.log_select ||
    !servicePrivs.log_insert ||
    servicePrivs.log_update ||
    servicePrivs.log_delete
  ) {
    throw new Error(
      `Audit privilege preflight failed: ${AUDIT_SERVICE_ROLE} must hold SELECT/INSERT/UPDATE on audit_access_grants and SELECT/INSERT on platform_audit_access_log — nothing else. ${REMEDIATION}`,
    )
  }

  // No privilege outside the V3 allowlist:
  //   audit_reader  × audit_log × SELECT
  //   audit_service × audit_access_grants × SELECT/INSERT/UPDATE
  //   audit_service × platform_audit_access_log × SELECT/INSERT
  const offenders = allRows<{ role: string; table_name: string }>(
    await db.execute(sql`
      select role, table_name
      from (
        select r.rolname as role, t.table_name,
          has_table_privilege(r.rolname, t.table_schema || '.' || t.table_name, 'SELECT')
          or has_table_privilege(r.rolname, t.table_schema || '.' || t.table_name, 'INSERT')
          or has_table_privilege(r.rolname, t.table_schema || '.' || t.table_name, 'UPDATE')
          or has_table_privilege(r.rolname, t.table_schema || '.' || t.table_name, 'DELETE') as granted
        from (values (${AUDIT_READER_ROLE}), (${AUDIT_SERVICE_ROLE})) as r(rolname)
        cross join information_schema.tables t
        where t.table_schema = 'public'
          and t.table_type = 'BASE TABLE'
          and (r.rolname, t.table_name) not in (
            (${AUDIT_READER_ROLE}, 'audit_log'),
            (${AUDIT_SERVICE_ROLE}, 'audit_access_grants'),
            (${AUDIT_SERVICE_ROLE}, 'platform_audit_access_log')
          )
      ) violations
      where granted
      order by table_name
      limit 5
    `),
  )
  if (offenders.length > 0) {
    const detail = offenders.map((o) => `${o.role}:${o.table_name}`).join(', ')
    throw new Error(
      `Audit privilege preflight failed: audit roles hold privileges outside the PD-02 allowlist (${detail}). ${REMEDIATION}`,
    )
  }
  return `audit privilege matrix verified (${AUDIT_READER_ROLE}: SELECT audit_log only)`
}
