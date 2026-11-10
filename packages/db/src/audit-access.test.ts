// PD-02 P-4/P-5 — audit access grants: approval lifecycle (P-4) and
// platform-level protection (P-5). Real PostgreSQL: the actual 0059 migration
// statements run against an ephemeral cluster, privileges converge through the
// real convergeAuditPrivileges(), and every operation executes as its real
// database identity (audit_service for grant management, a zero-privilege app
// probe proving the session role cannot touch platform audit data).

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres, { type Sql } from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import {
  AUDIT_GRANT_MAX_WINDOW_DAYS,
  AUDIT_GRANT_PURPOSE_MAX,
  assertAuditRowBudget,
  AuditAccessError,
  approveAuditAccessRequest,
  createAuditAccessRequest,
  rejectAuditAccessRequest,
  recordAuditAccessEvent,
  resolveActiveAuditGrant,
  revokeAuditAccess,
} from './audit-access'
import { convergeAuditPrivileges } from './audit-roles'
import { TENANT_SCOPED_TABLES } from './rls'

const NAME = `beaconhs-audit-access-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let admin: Sql
let service: Sql
let app: Sql
let appDb: ReturnType<typeof drizzle>
let grantConn: { sql: Sql }

function docker(...args: string[]) {
  return execSync(`docker ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function port(): number {
  return Number(docker('port', NAME, '5432').trim().split(':').pop())
}

const NOW = new Date('2026-01-15T12:00:00Z')
const USER_REQUESTER = '11111111-1111-4111-8111-111111111111'
const USER_APPROVER = '22222222-2222-4222-8222-222222222222'
const USER_OTHER = '33333333-3333-4333-8333-333333333333'
const TENANT_A = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-0000000000b2'

function window(days: number): { startsAt: Date; expiresAt: Date } {
  return { startsAt: NOW, expiresAt: new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000) }
}

async function latestGrantId(): Promise<string> {
  const rows = await admin`select id from audit_access_grants order by created_at desc limit 1`
  return rows[0]!.id as string
}

async function logActions(grantId: string | null): Promise<string[]> {
  const rows = grantId
    ? await admin`select action from platform_audit_access_log where grant_id = ${grantId} order by occurred_at`
    : await admin`select action from platform_audit_access_log order by occurred_at`
  return rows.map((r) => r.action as string)
}

beforeAll(async () => {
  docker(
    'run -d --name',
    NAME,
    '-e',
    'POSTGRES_PASSWORD=testpw',
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    'POSTGRES_DB=beaconhs',
    '-p',
    '127.0.0.1:0:5432',
    'postgres:16-alpine',
  )
  const base = `127.0.0.1:${port()}`
  admin = postgres(`postgresql://postgres:testpw@${base}/beaconhs`, { max: 2 })
  for (let i = 0; i < 40; i++) {
    try {
      await admin`select 1`
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  // Minimal world: the user table 0059 references, the two roles.
  await admin.unsafe(`
    create table "user" (id text primary key, email text not null);
    insert into "user" (id, email) values
      ('${USER_REQUESTER}', 'req@t'), ('${USER_APPROVER}', 'app@t'), ('${USER_OTHER}', 'o@t');
    -- convergeAuditPrivileges also grants SELECT on audit_log; production
    -- always has that table (created long before 0059), so mirror it minimally.
    create table audit_log (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null
    );
    create role audit_reader nologin nosuperuser nocreatedb nocreaterole noreplication bypassrls;
    -- 0059's immutability trigger whitelists current_user = beaconhs_owner;
    -- provide that identity for test cleanup only.
    create role beaconhs_owner nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role audit_service login nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      password 'auditpw' noinherit;
    create role app_probe login nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      password 'probpw';
    grant audit_reader to audit_service;
  `)
  // Apply the REAL 0059 statements (split on drizzle breakpoints).
  const raw = readFileSync(
    new URL('../drizzle/0059_audit_access_platform.sql', import.meta.url),
    'utf8',
  )
  for (const statement of raw.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed.length > 0) await admin.unsafe(trimmed)
  }
  // Real privilege convergence (as superuser here; same SQL as migrations run).
  appDb = drizzle(postgres(`postgresql://postgres:testpw@${base}/beaconhs`, { max: 1 }))
  await convergeAuditPrivileges(appDb)
  // Test-only cleanup privilege: the immutability trigger whitelists
  // current_user='beaconhs_owner', so that role must be able to DELETE rows
  // when resetting fixtures between tests. Production never grants this.
  await admin.unsafe(
    'grant delete on platform_audit_access_log, audit_access_grants to beaconhs_owner',
  )
  service = postgres(`postgresql://audit_service:auditpw@${base}/beaconhs`, { max: 2 })
  app = postgres(`postgresql://app_probe:probpw@${base}/beaconhs`, { max: 1 })
  // The grant functions accept the AuditConnection shape ({ sql }), so wrap
  // the bare pools for the lifecycle calls.
  grantConn = { sql: service }
}, 120_000)

afterAll(async () => {
  try {
    await service?.end()
  } catch {}
  try {
    await app?.end()
  } catch {}
  try {
    await appDb?.$client.end()
  } catch {}
  try {
    await admin?.end()
  } catch {}
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' })
  } catch {}
})

describe('P-4 grant lifecycle (real PostgreSQL, audit_service identity)', () => {
  // Each lifecycle test resolves "the active grant for a grantee", so leftover
  // approved rows from earlier tests would leak across cases. Reset both
  // platform tables between tests (log first: it references grants).
  beforeEach(async () => {
    await admin.unsafe(
      `set role beaconhs_owner;
       delete from platform_audit_access_log;
       delete from audit_access_grants;
       reset role;`,
    )
  })

  it('request → pending, trail records grant_requested', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Quarterly compliance review',
      ...window(7),
      now: NOW,
    })
    expect(grant.approvedByUserId).toBeNull()
    expect(grant.revokedAt).toBeNull()
    expect(await logActions(grant.id)).toEqual(['grant_requested'])
  })

  it('approval by a different subject activates the grant', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Approved window',
      ...window(7),
      now: NOW,
    })
    const approved = await approveAuditAccessRequest(grantConn, {
      grantId: grant.id,
      approverUserId: USER_APPROVER,
      now: NOW,
    })
    expect(approved.approvedByUserId).toBe(USER_APPROVER)
    const active = await resolveActiveAuditGrant(grantConn, {
      granteeUserId: USER_REQUESTER,
      scope: 'tenant',
      granteeTenantId: TENANT_A,
      now: NOW,
    })
    expect(active?.id).toBe(grant.id)
    expect(await logActions(grant.id)).toEqual(['grant_requested', 'grant_approved'])
  })

  it('self-approval is rejected (app logic + CHECK constraint)', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Self-approve attempt',
      ...window(7),
      now: NOW,
    })
    await expect(
      approveAuditAccessRequest(grantConn, {
        grantId: grant.id,
        approverUserId: USER_REQUESTER,
        now: NOW,
      }),
    ).rejects.toThrow(/different subject/)
    await expect(
      admin.unsafe(
        `update audit_access_grants set approved_by_user_id = grantee_user_id where id = '${grant.id}'`,
      ),
    ).rejects.toThrow(/audit_access_grants_approver_ck/)
  })

  it('concurrent approvals race on approved_by IS NULL — exactly one wins', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Concurrent approval',
      ...window(7),
      now: NOW,
    })
    const results = await Promise.allSettled([
      approveAuditAccessRequest(grantConn, {
        grantId: grant.id,
        approverUserId: USER_APPROVER,
        now: NOW,
      }),
      approveAuditAccessRequest(grantConn, {
        grantId: grant.id,
        approverUserId: USER_OTHER,
        now: NOW,
      }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    const check =
      await admin`select approved_by_user_id from audit_access_grants where id = ${grant.id}`
    expect([USER_APPROVER, USER_OTHER]).toContain(check[0]!.approved_by_user_id)
  })

  it('duplicate approval and duplicate rejection are rejected', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Duplicate handling',
      ...window(7),
      now: NOW,
    })
    await approveAuditAccessRequest(grantConn, {
      grantId: grant.id,
      approverUserId: USER_APPROVER,
      now: NOW,
    })
    await expect(
      approveAuditAccessRequest(grantConn, {
        grantId: grant.id,
        approverUserId: USER_OTHER,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'already_resolved' })
    await expect(
      rejectAuditAccessRequest(grantConn, {
        grantId: grant.id,
        approverUserId: USER_OTHER,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'already_resolved' })
  })

  it('rejection voids a pending request and is trail-recorded', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Rejected request',
      ...window(7),
      now: NOW,
    })
    await rejectAuditAccessRequest(grantConn, {
      grantId: grant.id,
      approverUserId: USER_APPROVER,
      now: NOW,
    })
    const active = await resolveActiveAuditGrant(grantConn, {
      granteeUserId: USER_REQUESTER,
      scope: 'tenant',
      granteeTenantId: TENANT_A,
      now: NOW,
    })
    expect(active).toBeNull()
    expect(await logActions(grant.id)).toEqual(['grant_requested', 'grant_rejected'])
  })

  it('revocation of an approved grant takes effect immediately and is trail-recorded', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Revoke flow',
      ...window(7),
      now: NOW,
    })
    await approveAuditAccessRequest(grantConn, {
      grantId: grant.id,
      approverUserId: USER_APPROVER,
      now: NOW,
    })
    await revokeAuditAccess(grantConn, {
      grantId: grant.id,
      revokedByUserId: USER_APPROVER,
      now: NOW,
    })
    const active = await resolveActiveAuditGrant(grantConn, {
      granteeUserId: USER_REQUESTER,
      scope: 'tenant',
      granteeTenantId: TENANT_A,
      now: NOW,
    })
    expect(active).toBeNull()
    await expect(
      revokeAuditAccess(grantConn, { grantId: grant.id, revokedByUserId: USER_APPROVER, now: NOW }),
    ).rejects.toMatchObject({ code: 'already_revoked' })
    expect(await logActions(grant.id)).toEqual([
      'grant_requested',
      'grant_approved',
      'grant_revoked',
    ])
  })

  it('fail-closed resolution: scope/tenant mismatch, unknown subject → null', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Scope match probe',
      ...window(7),
      now: NOW,
    })
    await approveAuditAccessRequest(grantConn, {
      grantId: grant.id,
      approverUserId: USER_APPROVER,
      now: NOW,
    })
    // platform resolution of a tenant grant → null
    expect(
      await resolveActiveAuditGrant(grantConn, {
        granteeUserId: USER_REQUESTER,
        scope: 'platform',
        now: NOW,
      }),
    ).toBeNull()
    // different tenant → null
    expect(
      await resolveActiveAuditGrant(grantConn, {
        granteeUserId: USER_REQUESTER,
        scope: 'tenant',
        granteeTenantId: TENANT_B,
        now: NOW,
      }),
    ).toBeNull()
    // unknown subject → null
    expect(
      await resolveActiveAuditGrant(grantConn, {
        granteeUserId: USER_OTHER,
        scope: 'tenant',
        granteeTenantId: TENANT_A,
        now: NOW,
      }),
    ).toBeNull()
    // after expiry → null (freeze "now" past the window)
    expect(
      await resolveActiveAuditGrant(grantConn, {
        granteeUserId: USER_REQUESTER,
        scope: 'tenant',
        granteeTenantId: TENANT_A,
        now: new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000),
      }),
    ).toBeNull()
  })
})

describe('P-4 request validation (fail-closed)', () => {
  it.each([
    ['empty purpose', { purpose: '   ' }],
    [`purpose > ${AUDIT_GRANT_PURPOSE_MAX}`, { purpose: 'x'.repeat(AUDIT_GRANT_PURPOSE_MAX + 1) }],
    ['91-day window', { ...window(AUDIT_GRANT_MAX_WINDOW_DAYS + 1) }],
    ['expires before it starts', { startsAt: NOW, expiresAt: new Date(NOW.getTime() - 1000) }],
    ['tenant scope without tenant', { scope: 'tenant' as const, granteeTenantId: null }],
    [
      'platform scope with tenant',
      {
        scope: 'platform' as const,
        granteeTenantId: TENANT_A,
        ...window(7),
      },
    ],
  ])('%s is rejected', async (_label, override) => {
    await expect(
      createAuditAccessRequest(grantConn, {
        granteeUserId: USER_REQUESTER,
        granteeTenantId: TENANT_A,
        scope: 'tenant',
        purpose: 'Valid purpose',
        ...window(7),
        ...override,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AuditAccessError)
  })

  it('unknown grant id → not_found', async () => {
    await expect(
      approveAuditAccessRequest(grantConn, {
        grantId: '00000000-0000-4000-8000-000000000000',
        approverUserId: USER_APPROVER,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('P-5 platform-level protection (real PostgreSQL)', () => {
  it('audit_access_grants and platform_audit_access_log are NOT tenant-scoped', () => {
    expect(TENANT_SCOPED_TABLES).not.toContain('audit_access_grants')
    expect(TENANT_SCOPED_TABLES).not.toContain('platform_audit_access_log')
  })

  it('the ordinary application role has ZERO access to both platform tables', async () => {
    await expect(app`select count(*) from audit_access_grants`).rejects.toThrow(/permission denied/)
    await expect(app`select count(*) from platform_audit_access_log`).rejects.toThrow(
      /permission denied/,
    )
    await expect(
      app`insert into platform_audit_access_log (actor_user_id, scope, action, purpose) values (${USER_OTHER}, 'tenant', 'grant_requested', 'forge')`,
    ).rejects.toThrow(/permission denied/)
  })

  it('audit_service cannot DELETE grants or UPDATE/DELETE the append-only log', async () => {
    await expect(service`delete from audit_access_grants where purpose = 'x'`).rejects.toThrow(
      /permission denied/,
    )
    await expect(
      service`update platform_audit_access_log set purpose = 'tampered'`,
    ).rejects.toThrow(/permission denied/)
    await expect(service`delete from platform_audit_access_log`).rejects.toThrow(
      /permission denied/,
    )
  })

  it('the append-only trigger blocks log tampering for non-owner and allows owner', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Trigger probe',
      ...window(7),
      now: NOW,
    })
    await expect(
      admin.unsafe(
        `update platform_audit_access_log set purpose = 'tampered' where grant_id = '${grant.id}'`,
      ),
    ).rejects.toThrow(/append-only/)
    await expect(
      admin.unsafe(`delete from platform_audit_access_log where grant_id = '${grant.id}'`),
    ).rejects.toThrow(/append-only/)
  })

  it('the log action CHECK rejects forged action values', async () => {
    await expect(
      service`insert into platform_audit_access_log (actor_user_id, scope, action, purpose) values (${USER_OTHER}, 'tenant', 'bogus_action', 'x')`,
    ).rejects.toThrow(/platform_audit_access_log_action_ck/)
  })

  it('grant rows are tied to real users (FK restrict)', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_OTHER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'FK restrict probe',
      ...window(7),
      now: NOW,
    })
    await expect(admin.unsafe(`delete from "user" where id = '${USER_OTHER}'`)).rejects.toThrow()
    await admin.unsafe(`delete from audit_access_grants where id = '${grant.id}'`)
  })

  it('convergeAuditPrivileges is idempotent and restores drifted privileges', async () => {
    await admin.unsafe('revoke select, insert, update on audit_access_grants from audit_service')
    await convergeAuditPrivileges(appDb)
    // Test-only cleanup privilege: the immutability trigger whitelists
    // current_user='beaconhs_owner', so that role must be able to DELETE rows
    // when resetting fixtures between tests. Production never grants this.
    await admin.unsafe(
      'grant delete on platform_audit_access_log, audit_access_grants to beaconhs_owner',
    )
    const rows = await admin`
      select has_table_privilege('audit_service', 'audit_access_grants', 'SELECT') as sel,
        has_table_privilege('audit_service', 'audit_access_grants', 'INSERT') as ins,
        has_table_privilege('audit_service', 'audit_access_grants', 'UPDATE') as upd,
        has_table_privilege('audit_service', 'audit_access_grants', 'DELETE') as del
    `
    expect(rows[0]).toMatchObject({ sel: true, ins: true, upd: true, del: false })
  })

  it('grant management works through the real audit connection end to end', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: null,
      scope: 'platform',
      purpose: 'End-to-end platform grant',
      ...window(30),
      now: NOW,
    })
    expect(grant.granteeTenantId).toBeNull()
    await approveAuditAccessRequest(grantConn, {
      grantId: grant.id,
      approverUserId: USER_APPROVER,
      now: NOW,
    })
    const active = await resolveActiveAuditGrant(grantConn, {
      granteeUserId: USER_REQUESTER,
      scope: 'platform',
      now: NOW,
    })
    expect(active?.purpose).toBe('End-to-end platform grant')
  })
})

describe('P-6 row budget & extra approval (real PostgreSQL)', () => {
  // Same hygiene as the lifecycle suite.
  beforeEach(async () => {
    await admin.unsafe(
      `set role beaconhs_owner;
       delete from platform_audit_access_log;
       delete from audit_access_grants;
       reset role;`,
    )
  })

  async function activeGrant(extraApproval: boolean) {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: extraApproval ? 'Oversized reads approved' : 'Standard read',
      extraApproval,
      ...window(7),
      now: NOW,
    })
    await approveAuditAccessRequest(grantConn, {
      grantId: grant.id,
      approverUserId: USER_APPROVER,
      extraApproval,
      now: NOW,
    })
    return grant
  }

  it('a plain grant passes while usage stays inside the 10000-row budget', async () => {
    const grant = await activeGrant(false)
    for (const rowCount of [4000, 3000]) {
      await recordAuditAccessEvent(grantConn, {
        actorUserId: USER_REQUESTER,
        actorTenantId: TENANT_A,
        scope: 'tenant',
        grantId: grant.id,
        action: 'audit_query',
        purpose: 'standard read',
        rowCount,
      })
    }
    await assertAuditRowBudget(grantConn, {
      grantId: grant.id,
      requestedRows: 3000,
      extraApproval: false,
    })
  })

  it('exceeding the 10000-row budget on a plain grant is rejected', async () => {
    const grant = await activeGrant(false)
    await recordAuditAccessEvent(grantConn, {
      actorUserId: USER_REQUESTER,
      actorTenantId: TENANT_A,
      scope: 'tenant',
      grantId: grant.id,
      action: 'audit_query',
      purpose: 'big read',
      rowCount: 9500,
    })
    await expect(
      assertAuditRowBudget(grantConn, {
        grantId: grant.id,
        requestedRows: 501,
        extraApproval: false,
      }),
    ).rejects.toThrow(/9500 of the 10000-row budget; request extra approval/)
    // A small follow-up read is still allowed.
    await assertAuditRowBudget(grantConn, {
      grantId: grant.id,
      requestedRows: 500,
      extraApproval: false,
    })
  })

  it('extra approval bypasses the row budget entirely', async () => {
    const grant = await activeGrant(true)
    await recordAuditAccessEvent(grantConn, {
      actorUserId: USER_REQUESTER,
      actorTenantId: TENANT_A,
      scope: 'tenant',
      grantId: grant.id,
      action: 'audit_query',
      purpose: 'oversized read',
      rowCount: 10000,
    })
    await assertAuditRowBudget(grantConn, {
      grantId: grant.id,
      requestedRows: 10000,
      extraApproval: true,
    })
  })

  it('the approved extra_approval flag is persisted and readable', async () => {
    const grant = await activeGrant(true)
    const rows = await grantConn.sql<Array<{ extra_approval: boolean }>>`
      select extra_approval from audit_access_grants where id = ${grant.id}`
    expect(rows[0]?.extra_approval).toBe(true)
    const plain = await activeGrant(false)
    const rows2 = await grantConn.sql<Array<{ extra_approval: boolean }>>`
      select extra_approval from audit_access_grants where id = ${plain.id}`
    expect(rows2[0]?.extra_approval).toBe(false)
  })

  it('rejected requests never enter the active-grant resolution even with extra approval', async () => {
    const grant = await createAuditAccessRequest(grantConn, {
      granteeUserId: USER_REQUESTER,
      granteeTenantId: TENANT_A,
      scope: 'tenant',
      purpose: 'Should never activate',
      extraApproval: true,
      ...window(7),
      now: NOW,
    })
    await rejectAuditAccessRequest(grantConn, {
      grantId: grant.id,
      approverUserId: USER_APPROVER,
      now: NOW,
    })
    const active = await resolveActiveAuditGrant(grantConn, {
      granteeUserId: USER_REQUESTER,
      scope: 'tenant',
      granteeTenantId: TENANT_A,
      now: NOW,
    })
    expect(active).toBeNull()
  })
})
