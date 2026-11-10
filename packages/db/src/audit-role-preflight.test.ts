// PD-02 P-1 — audit role preflight against REAL PostgreSQL.
//
// Reproduces the provision.sql role model in a disposable cluster, then proves
// both the privilege matrix (what audit_reader can and cannot do) and the
// migrate.ts deployment gates (assertAuditRoleAttributes /
// assertAuditTablePrivileges / convergeAuditPrivileges), including their
// negative paths. No mocks.

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres, { type Sql, type TransactionSql } from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import {
  assertAuditRoleAttributes,
  assertAuditTablePrivileges,
  convergeAuditPrivileges,
} from './audit-roles'

const NAME = `beaconhs-audit-roles-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let superSql: Sql
let serviceSql: Sql
let appSql: Sql
let auditDb: ReturnType<typeof drizzle>
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
    CREATE ROLE beaconhs_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE beaconhs_migrator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD 'migpw';
    CREATE ROLE beaconhs_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD 'apppw';
    CREATE ROLE beaconhs_super LOGIN NOINHERIT NOSUPERUSER BYPASSRLS PASSWORD 'superpw';
    CREATE ROLE beaconhs_backup LOGIN NOINHERIT NOSUPERUSER BYPASSRLS PASSWORD 'backuppw';
    CREATE ROLE audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
    CREATE ROLE audit_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'auditpw';
    GRANT beaconhs_owner TO beaconhs_migrator;
    GRANT audit_reader TO audit_service;
    ALTER DATABASE beaconhs OWNER TO beaconhs_owner;
  `)
  // Minimal schema with the same isolation semantics as production:
  // tenant-scoped business table + audit_log, both FORCE RLS.
  await superSql.unsafe(`
    SET ROLE beaconhs_owner;
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE incidents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), title text NOT NULL);
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      action text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_incidents ON incidents
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_audit ON audit_log
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    GRANT USAGE ON SCHEMA public TO beaconhs_app, beaconhs_super;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO beaconhs_app, beaconhs_super;
    GRANT USAGE ON SCHEMA public TO audit_reader;
    GRANT SELECT ON audit_log TO audit_reader;
    INSERT INTO tenants (id) VALUES ('${TENANT_A}'::uuid), ('${TENANT_B}'::uuid);
  `)
  // Seed audit rows in TWO tenants: BYPASSRLS must see both, RLS roles see one.
  await superSql.unsafe(
    `SET ROLE beaconhs_app; SET app.tenant_id = '${TENANT_A}';
     INSERT INTO audit_log (tenant_id, action) VALUES ('${TENANT_A}'::uuid, 'tenant-a-event');
     INSERT INTO incidents (tenant_id, title) VALUES ('${TENANT_A}'::uuid, 'secret-A');`,
  )
  await superSql.unsafe(
    `SET ROLE beaconhs_app; SET app.tenant_id = '${TENANT_B}';
     INSERT INTO audit_log (tenant_id, action) VALUES ('${TENANT_B}'::uuid, 'tenant-b-event');`,
  )
  await superSql.unsafe('RESET ROLE')
  serviceSql = postgres(`postgresql://audit_service:auditpw@127.0.0.1:${port()}/beaconhs`, {
    max: 1,
  })
  appSql = postgres(`postgresql://beaconhs_app:apppw@127.0.0.1:${port()}/beaconhs`, { max: 1 })
  auditDb = drizzle(
    postgres(`postgresql://postgres:testpw@127.0.0.1:${port()}/beaconhs`, { max: 1 }),
  )
  ready = true
}, 120_000)

afterAll(async () => {
  try {
    await superSql?.end()
  } catch {}
  try {
    await serviceSql?.end()
  } catch {}
  try {
    await appSql?.end()
  } catch {}
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' })
  } catch {}
})

function need() {
  if (!ready) throw new Error('skipped: no disposable PG')
}

/** Assume audit_reader inside a transaction, as the AUDIT_DATABASE_URL login would. */
async function asAuditReader<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const conn = postgres(`postgresql://audit_service:auditpw@127.0.0.1:${port()}/beaconhs`, {
    max: 1,
  })
  try {
    const result = (await conn.begin(async (tx) => {
      await tx`set local role audit_reader`
      return await fn(tx)
    })) as T
    return result
  } finally {
    await conn.end()
  }
}

describe('audit role privilege matrix (real PG)', () => {
  it('audit_service → SET LOCAL ROLE audit_reader reads audit_log across ALL tenants (BYPASSRLS proof)', async () => {
    need()
    const rows = await asAuditReader(async (tx) => {
      const [who] = await tx`select current_user as u`
      expect(who?.u).toBe('audit_reader')
      return await tx`select action from audit_log order by action`
    })
    expect(rows.map((r) => r.action).sort()).toEqual(['tenant-a-event', 'tenant-b-event'])
  })

  it('audit_service WITHOUT the role switch has no direct audit_log access', async () => {
    need()
    await expect(serviceSql`select * from audit_log limit 1`).rejects.toThrowError(/permission/i)
    const [who] = await serviceSql`select current_user as u`
    expect(who?.u).toBe('audit_service')
  })

  it('audit_reader cannot INSERT, UPDATE, or DELETE audit_log', async () => {
    need()
    await expect(
      asAuditReader(async (tx) => {
        await tx`insert into audit_log (tenant_id, action) values (${TENANT_A}::uuid, 'forged')`
      }),
    ).rejects.toThrowError(/permission/i)
    await expect(
      asAuditReader(async (tx) => {
        await tx`update audit_log set action = 'tampered'`
      }),
    ).rejects.toThrowError(/permission|append-only/i)
    await expect(
      asAuditReader(async (tx) => {
        await tx`delete from audit_log`
      }),
    ).rejects.toThrowError(/permission|append-only/i)
  })

  it('audit_reader has no SELECT on business tables', async () => {
    need()
    await expect(
      asAuditReader(async (tx) => {
        await tx`select * from incidents limit 1`
      }),
    ).rejects.toThrowError(/permission/i)
    await expect(
      asAuditReader(async (tx) => {
        await tx`select * from tenants limit 1`
      }),
    ).rejects.toThrowError(/permission/i)
  })

  it('beaconhs_app cannot assume audit_reader and stays tenant-scoped (regression)', async () => {
    need()
    await expect(appSql`set role audit_reader`).rejects.toThrowError(/permission/i)
    // RLS still applies to the runtime role: without tenant context nothing is
    // visible, with Tenant A context only Tenant A rows.
    const [empty] = await appSql`select count(*)::int as n from audit_log`
    expect(Number(empty?.n)).toBe(0)
    await appSql.begin(async (tx) => {
      await tx.unsafe(`set local app.tenant_id = '${TENANT_A}'`)
      const [rows] = await tx`select count(*)::int as n from audit_log`
      expect(Number(rows?.n)).toBe(1)
    })
  })
})

describe('migration gates: assertAuditRoleAttributes (real PG)', () => {
  it('passes on a provisioned cluster', async () => {
    need()
    await assertAuditRoleAttributes(auditDb, 'beaconhs_owner')
  })

  it('fails closed when a role is missing', async () => {
    need()
    await superSql.unsafe('revoke audit_reader from audit_service')
    await superSql.unsafe('revoke all privileges on all tables in schema public from audit_reader')
    await superSql.unsafe('revoke usage on schema public from audit_reader')
    await superSql.unsafe('drop role audit_reader')
    await expect(assertAuditRoleAttributes(auditDb, 'beaconhs_owner')).rejects.toThrow(
      /provision\.sql/,
    )
    // restore
    await superSql.unsafe('create role audit_reader NOLOGIN NOSUPERUSER BYPASSRLS')
    await superSql.unsafe('grant audit_reader to audit_service')
    await assertAuditRoleAttributes(auditDb, 'beaconhs_owner')
  })

  it('fails when audit_reader becomes LOGIN or loses BYPASSRLS', async () => {
    need()
    await superSql.unsafe('alter role audit_reader login')
    await expect(assertAuditRoleAttributes(auditDb, 'beaconhs_owner')).rejects.toThrow(/NOLOGIN/)
    await superSql.unsafe('alter role audit_reader nologin')
    await superSql.unsafe('alter role audit_reader nobypassrls')
    await expect(assertAuditRoleAttributes(auditDb, 'beaconhs_owner')).rejects.toThrow(/BYPASSRLS/)
    await superSql.unsafe('alter role audit_reader bypassrls')
    await assertAuditRoleAttributes(auditDb, 'beaconhs_owner')
  })

  it('fails when any unexpected member holds audit_reader', async () => {
    need()
    await superSql.unsafe('grant audit_reader to beaconhs_app')
    await expect(assertAuditRoleAttributes(auditDb, 'beaconhs_owner')).rejects.toThrow(
      /beaconhs_app/,
    )
    await superSql.unsafe('revoke audit_reader from beaconhs_app')
    await assertAuditRoleAttributes(auditDb, 'beaconhs_owner')
  })

  it('fails when the sole membership is missing', async () => {
    need()
    await superSql.unsafe('revoke audit_reader from audit_service')
    await expect(assertAuditRoleAttributes(auditDb, 'beaconhs_owner')).rejects.toThrow(
      /audit_service/,
    )
    await superSql.unsafe('grant audit_reader to audit_service')
    await assertAuditRoleAttributes(auditDb, 'beaconhs_owner')
  })

  it('fails when audit_service gains owner membership', async () => {
    need()
    await superSql.unsafe('grant beaconhs_owner to audit_service')
    await expect(assertAuditRoleAttributes(auditDb, 'beaconhs_owner')).rejects.toThrow(
      /beaconhs_owner member/,
    )
    await superSql.unsafe('revoke beaconhs_owner from audit_service')
    await assertAuditRoleAttributes(auditDb, 'beaconhs_owner')
  })
})

describe('migration gates: privilege matrix + convergence (real PG)', () => {
  it('passes on a converged cluster', async () => {
    need()
    await convergeAuditPrivileges(auditDb)
    await assertAuditTablePrivileges(auditDb)
  })

  it('fails when audit_reader can read a business table', async () => {
    need()
    await superSql.unsafe('grant select on incidents to audit_reader')
    await expect(assertAuditTablePrivileges(auditDb)).rejects.toThrow(/incidents/)
    await superSql.unsafe('revoke select on incidents from audit_reader')
    await assertAuditTablePrivileges(auditDb)
  })

  it('fails when audit_reader can write audit_log', async () => {
    need()
    await superSql.unsafe('grant insert on audit_log to audit_reader')
    await expect(assertAuditTablePrivileges(auditDb)).rejects.toThrow(/SELECT — and nothing else/)
    await superSql.unsafe('revoke insert on audit_log from audit_reader')
    await assertAuditTablePrivileges(auditDb)
  })

  it('fails when audit_log SELECT is missing', async () => {
    need()
    await superSql.unsafe('revoke select on audit_log from audit_reader')
    await expect(assertAuditTablePrivileges(auditDb)).rejects.toThrow(/SELECT/)
    await superSql.unsafe('grant select on audit_log to audit_reader')
    await assertAuditTablePrivileges(auditDb)
  })

  it('fails when audit_service holds direct table privileges', async () => {
    need()
    await superSql.unsafe('grant select on audit_log to audit_service')
    await expect(assertAuditTablePrivileges(auditDb)).rejects.toThrow(/audit_service/)
    await superSql.unsafe('revoke select on audit_log from audit_service')
    await assertAuditTablePrivileges(auditDb)
  })

  it('convergeAuditPrivileges self-heals a drifted cluster', async () => {
    need()
    await superSql.unsafe('revoke select on audit_log from audit_reader')
    await superSql.unsafe('grant select on incidents to audit_service')
    await convergeAuditPrivileges(auditDb)
    await assertAuditTablePrivileges(auditDb)
    // and the functional path still works end to end
    const rows = await asAuditReader(async (tx) => {
      return await tx`select count(*)::int as n from audit_log`
    })
    expect(Number(rows[0]?.n)).toBe(2)
  })
})
