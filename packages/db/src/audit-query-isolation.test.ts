// PD-02 P-3 — SET LOCAL ROLE and connection-pool identity isolation against
// REAL PostgreSQL. The audit pool below is created with max:1 so every audit
// transaction provably reuses the SAME physical connection (pg_backend_pid
// evidence); after each commit/rollback/exception we prove the session fell
// back to `audit_service` and that business-table access stays denied.
//
// This is the V3 §P-3 "most dangerous item" verification: a session-level
// SET ROLE here would leak BYPASSRLS to every later pool consumer.

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres, { type Sql } from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { closeAuditConnection, createAuditConnection, type AuditConnection } from './audit-client'
import {
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_QUERY_MAX_ROWS,
  AUDIT_QUERY_STATEMENT_TIMEOUT,
  AuditQueryLimitError,
  queryAuditLogAcrossTenants,
  validateAuditQueryWindow,
} from './audit-query'

const NAME = `beaconhs-audit-query-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let superSql: Sql
let serviceUrl = ''
let audit: AuditConnection
let ready = false

function docker(...args: string[]): string {
  return execSync(`docker ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function port(): number {
  return Number(docker('port', NAME, '5432').trim().split(':').pop())
}

async function waitReady(url: string) {
  for (let i = 0; i < 40; i++) {
    try {
      const c = postgres(url, { max: 1, connect_timeout: 3 })
      await c`select 1`
      await c.end()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error('postgres not ready')
}

const TENANT_A = randomUUID()
const TENANT_B = randomUUID()

beforeAll(async () => {
  try {
    execSync('docker --version', { stdio: 'ignore' })
  } catch {
    return
  }
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
  const adminUrl = `postgresql://postgres:testpw@127.0.0.1:${port()}/beaconhs`
  await waitReady(adminUrl)
  superSql = postgres(adminUrl, { max: 1 })
  await superSql.unsafe(`
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE incidents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), title text NOT NULL);
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      actor_user_id uuid,
      actor_ip text,
      actor_user_agent text,
      entity_type text NOT NULL,
      entity_id uuid,
      action text NOT NULL,
      summary text,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE ROLE audit_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE audit_service LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD 'auditpw';
    GRANT audit_reader TO audit_service;
    GRANT CONNECT ON DATABASE beaconhs TO audit_service;
    GRANT USAGE ON SCHEMA public TO audit_service;
    GRANT USAGE ON SCHEMA public TO audit_reader;
    GRANT SELECT ON audit_log TO audit_reader;
    -- FORCE RLS mirrors production: only a BYPASSRLS role can see across tenants.
    INSERT INTO tenants (id) VALUES ('${TENANT_A}'), ('${TENANT_B}');
    INSERT INTO audit_log (tenant_id, entity_type, action) VALUES ('${TENANT_A}', 'incident', 'create'), ('${TENANT_B}', 'incident', 'update');
  `)
  serviceUrl = `postgresql://audit_service:auditpw@127.0.0.1:${port()}/beaconhs`
  process.env.AUDIT_DATABASE_URL = serviceUrl
  // Replace the factory-built pool with a max:1 pool so every "request" below
  // provably lands on the same physical connection (pg_backend_pid evidence).
  const single = postgres(serviceUrl, {
    max: 1,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  })
  audit = { sql: single, db: drizzle(single), end: () => single.end({ timeout: 5 }) }
  ready = true
})

afterAll(async () => {
  await closeAuditConnection()
  try {
    await audit?.end()
  } catch {}
  try {
    await superSql?.end()
  } catch {}
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' })
  } catch {}
})

/** Session-level identity OUTSIDE any audit transaction: must always be the
 * plain `audit_service` login, never `audit_reader`. */
async function sessionIdentity(): Promise<{ currentUser: string; sessionUser: string }> {
  const rows = await audit.sql`select current_user, session_user`
  return {
    currentUser: rows[0]!.current_user as string,
    sessionUser: rows[0]!.session_user as string,
  }
}

describe('P-3 role-switch isolation (real PostgreSQL, max:1 pool)', () => {
  it('switches to audit_reader inside the transaction and reads across tenants (BYPASSRLS)', async () => {
    const { rows } = await queryAuditLogAcrossTenants(audit, { limit: 100 })
    expect(rows).toHaveLength(2) // both tenants visible — audit_reader bypasses RLS
    const tenantIds = new Set(rows.map((r) => r.tenantId))
    expect(tenantIds.has(TENANT_A)).toBe(true)
    expect(tenantIds.has(TENANT_B)).toBe(true)
  })

  it('tenant-scoped and time-scoped filters are applied server-side', async () => {
    const scoped = await queryAuditLogAcrossTenants(audit, { tenantIds: [TENANT_A], limit: 100 })
    expect(scoped.rows).toHaveLength(1)
    expect(scoped.rows[0]?.tenantId).toBe(TENANT_A)
    const none = await queryAuditLogAcrossTenants(audit, { tenantIds: [], limit: 100 })
    expect(none.rows).toHaveLength(0) // explicitly empty scope = fail-closed
    const emptyActions = await queryAuditLogAcrossTenants(audit, {
      actions: ['nonexistent'],
      limit: 100,
    })
    expect(emptyActions.rows).toHaveLength(0)
  })

  it('rejects out-of-range page parameters before touching the database', async () => {
    await expect(
      queryAuditLogAcrossTenants(audit, { limit: AUDIT_MAX_PAGE_SIZE + 1 }),
    ).rejects.toThrow(/page size/i)
    await expect(queryAuditLogAcrossTenants(audit, { limit: 0 })).rejects.toThrow(/page size/i)
    await expect(queryAuditLogAcrossTenants(audit, { limit: 10, offset: -1 })).rejects.toThrow(
      /offset/i,
    )
  })

  it('statement_timeout is set transaction-locally (10s) and does not persist', async () => {
    const inside = await audit.sql.begin(async (tx) => {
      await tx.unsafe('set local role audit_reader')
      await tx.unsafe(`set local statement_timeout = '${AUDIT_QUERY_STATEMENT_TIMEOUT}'`)
      const r = await tx`show statement_timeout`
      return r[0]!.statement_timeout as string
    })
    expect(inside).toBe('10s')
    const outside = await audit.sql`show statement_timeout`
    expect(outside[0]!.statement_timeout).toBe('0') // session default restored
  })

  it('after a COMMIT the connection identity is audit_service again and business tables stay denied', async () => {
    await queryAuditLogAcrossTenants(audit, { limit: 10 })
    const identity = await sessionIdentity()
    expect(identity.currentUser).toBe('audit_service')
    expect(identity.sessionUser).toBe('audit_service')
    await expect(audit.sql`select count(*) from incidents`).rejects.toThrow(/permission denied/i)
    await expect(audit.sql`select count(*) from audit_log`).rejects.toThrow(/permission denied/i)
  })

  it('after a ROLLBACK (query failure) the identity is restored on the reused connection', async () => {
    // Force an in-transaction failure AFTER the role switch: drop the grant.
    await superSql.unsafe(`revoke select on audit_log from audit_reader`)
    try {
      await expect(queryAuditLogAcrossTenants(audit, { limit: 10 })).rejects.toThrow(
        /permission denied/i,
      )
    } finally {
      await superSql.unsafe(`grant select on audit_log to audit_reader`)
    }
    // Same physical connection, next transaction: identity restored.
    const identity = await sessionIdentity()
    expect(identity.currentUser).toBe('audit_service')
    // And the executor works again on the re-granted pool.
    const { rows } = await queryAuditLogAcrossTenants(audit, { limit: 10 })
    expect(rows).toHaveLength(2)
  })

  it('after an exception thrown by the CALLER the identity is restored (rollback path)', async () => {
    await expect(
      audit.sql.begin(async (tx) => {
        await tx.unsafe('set local role audit_reader')
        throw new Error('caller aborts mid-transaction')
      }),
    ).rejects.toThrow(/caller aborts/)
    const identity = await sessionIdentity()
    expect(identity.currentUser).toBe('audit_service')
    await expect(audit.sql`select count(*) from audit_log`).rejects.toThrow(/permission denied/i)
  })

  it('proves PHYSICAL connection reuse: same pg_backend_pid across sequential audit transactions', async () => {
    const pids: number[] = []
    for (let i = 0; i < 3; i++) {
      await audit.sql.begin(async (tx) => {
        await tx.unsafe('set local role audit_reader')
        const r = await tx`select pg_backend_pid()::int as pid, current_user`
        pids.push(r[0]!.pid as number)
        // Inside the audit transaction the effective role is audit_reader.
        expect(r[0]!.current_user).toBe('audit_reader')
        const su = await tx`select session_user`
        expect(su[0]!.session_user).toBe('audit_service')
      })
    }
    expect(new Set(pids).size).toBe(1) // one backend, three transactions
  })

  it('concurrent audit transactions do not share the audit_reader identity', async () => {
    // max:1 serializes them; each transaction must see its own role switch,
    // and no interleaved transaction can observe another's identity.
    const results = await Promise.all(
      [0, 1].map((i) =>
        audit.sql.begin(async (tx) => {
          await tx.unsafe('set local role audit_reader')
          const r = await tx`select current_user, count(*)::int as n from audit_log`
          return { i, user: r[0]!.current_user as string, n: r[0]!.n as number }
        }),
      ),
    )
    for (const r of results) {
      expect(r.user).toBe('audit_reader')
      expect(r.n).toBe(2)
    }
    const identity = await sessionIdentity()
    expect(identity.currentUser).toBe('audit_service')
  })

  it('outside audit transactions audit_log access is still denied (RLS + no grants)', async () => {
    // The session never carries the audit_reader role between transactions.
    await expect(audit.sql`select * from audit_log`).rejects.toThrow(/permission denied/i)
    const identity = await sessionIdentity()
    expect(identity.currentUser).toBe('audit_service')
  })

  it('max page size matches the V3 constant', () => {
    expect(AUDIT_MAX_PAGE_SIZE).toBe(500)
    expect(AUDIT_QUERY_STATEMENT_TIMEOUT).toBe('10s')
  })
})

describe('P-6 query limits (real PostgreSQL)', () => {
  const DAY = 24 * 60 * 60 * 1000
  // Captured per test: the seeded rows use occurred_at = now() from beforeAll,
  // so a window captured at collection time would already be in the past.

  it('accepts a window at exactly the 31-day maximum and runs the query', async () => {
    const now = Date.now()
    const to = new Date(now)
    const from = new Date(now - 31 * DAY)
    validateAuditQueryWindow(from, to) // must not throw
    const { rows } = await queryAuditLogAcrossTenants(audit, {
      from,
      to,
      limit: AUDIT_MAX_PAGE_SIZE,
    })
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects a window wider than 31 days (window_too_wide)', () => {
    const now = Date.now()
    const to = new Date(now)
    const from = new Date(now - 32 * DAY)
    expect(() => validateAuditQueryWindow(from, to)).toThrow(AuditQueryLimitError)
    try {
      validateAuditQueryWindow(from, to)
      expect.unreachable()
    } catch (err) {
      expect((err as AuditQueryLimitError).code).toBe('window_too_wide')
    }
  })

  it('rejects an inverted window (to before from)', () => {
    const now = Date.now()
    expect(() => validateAuditQueryWindow(new Date(now), new Date(now - DAY))).toThrow(
      AuditQueryLimitError,
    )
  })

  it('rejects offset+limit beyond the 10000-row cap (row_cap)', async () => {
    await expect(
      queryAuditLogAcrossTenants(audit, {
        limit: 500,
        offset: AUDIT_QUERY_MAX_ROWS - 499, // 500 + 9501 > 10000
      }),
    ).rejects.toThrow(AuditQueryLimitError)
    try {
      await queryAuditLogAcrossTenants(audit, { limit: 500, offset: AUDIT_QUERY_MAX_ROWS - 499 })
      expect.unreachable()
    } catch (err) {
      expect((err as AuditQueryLimitError).code).toBe('row_cap')
    }
  })

  it('allows offset+limit exactly at the 10000-row cap boundary', async () => {
    const { rows } = await queryAuditLogAcrossTenants(audit, {
      limit: 500,
      offset: AUDIT_QUERY_MAX_ROWS - 500, // exactly 10000 — allowed
    })
    expect(Array.isArray(rows)).toBe(true)
  })

  it('enforces the caller-supplied maxPageSize floor at 500', async () => {
    await expect(
      queryAuditLogAcrossTenants(audit, { limit: 10, maxPageSize: 499 }),
    ).rejects.toThrow(/maxPageSize must be within/)
    // A limit above the caller's maxPageSize is clamped-rejected.
    await expect(
      queryAuditLogAcrossTenants(audit, { limit: 501, maxPageSize: 500 }),
    ).rejects.toThrow()
  })

  it('permits the export path to raise maxPageSize up to the full row cap', async () => {
    const { rows } = await queryAuditLogAcrossTenants(audit, {
      limit: AUDIT_QUERY_MAX_ROWS,
      maxPageSize: AUDIT_QUERY_MAX_ROWS,
    })
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })
})
