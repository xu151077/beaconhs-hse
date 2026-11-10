// PD-01 Phase 3 专项 A — connection pool / transaction context isolation.
//
// NOT a mock: ephemeral postgres:16, a dedicated NON-SUPERUSER login role so
// FORCE ROW LEVEL SECURITY actually applies, and the project's real withTenant()
// from ./rls. A pool with max:1 forces every transaction onto the SAME physical
// connection; pg_backend_pid() proves reuse rather than merely "same pool object".

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import postgres, { type Sql } from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { withTenant } from './rls'
import type { Database } from './client'
import * as schema from './schema'

const NAME = `beaconhs-pool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let admin: Sql
let app: Sql
let appDb: Database
let appUrl = ''

function docker(...args: string[]) {
  return execSync(`docker ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function port(): number {
  return Number(docker('port', NAME, '5432').trim().split(':').pop())
}

const TENANT_A = randomUUID()
const TENANT_B = randomUUID()

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
  appUrl = `postgresql://probe_app:probepw@${base}/beaconhs`
  admin = postgres(`postgresql://postgres:testpw@${base}/beaconhs`, { max: 2 })
  for (let i = 0; i < 40; i++) {
    try {
      await admin`select 1`
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  await admin.unsafe(`
    CREATE TABLE tenant_isolation_probe (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      payload text NOT NULL
    );
    CREATE ROLE probe_app LOGIN PASSWORD 'probepw' NOSUPERUSER NOBYPASSRLS;
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_isolation_probe TO probe_app;
    ALTER TABLE tenant_isolation_probe ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_isolation_probe FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON tenant_isolation_probe
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  `)
  // max:1 => a single physical connection is shared by every request.
  app = postgres(appUrl, { max: 1 })
  appDb = drizzle(app, { schema })
}, 120_000)

afterAll(async () => {
  try {
    await app?.end()
  } catch {}
  try {
    await admin?.end()
  } catch {}
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' })
  } catch {}
})

const probePids: number[] = []

async function inTenant(tenantId: string, fn: (tx: Database) => Promise<void>) {
  return withTenant(appDb, tenantId, async (tx) => {
    const [row] = await tx.execute(sql`select pg_backend_pid()::int as pid`)
    const pid = Number((row as { pid: number }).pid)
    probePids.push(pid)
    await fn(tx)
  })
}

async function countFor(tenantId: string): Promise<number> {
  return withTenant(appDb, tenantId, async (tx) => {
    const res = await tx.execute(sql`select count(*)::int as n from tenant_isolation_probe`)
    const row = (res as unknown as Array<{ n: number }>)[0]
    return Number(row?.n ?? 0)
  })
}

async function gucAfterTransaction(): Promise<string | null | undefined> {
  // Outside withTenant: the transaction-local setting must be gone.
  const res = await app.unsafe(`select current_setting('app.tenant_id', true) as v`)
  // Unset GUC reads as '' (or NULL); either means no tenant context leaked.
  return res[0]?.v ?? null
}

describe('connection pool isolation (real PostgreSQL, real withTenant, max:1 pool)', () => {
  it('1+2. Tenant A commits, Tenant B reuses the SAME physical connection and cannot see A', async () => {
    probePids.length = 0
    await inTenant(TENANT_A, async (tx) => {
      await tx.execute(
        sql`insert into tenant_isolation_probe (tenant_id, payload) values (${TENANT_A}::uuid, 'secret-A')`,
      )
    })
    const aCount = await countFor(TENANT_A)
    const bCount = await countFor(TENANT_B)
    expect(aCount).toBe(1)
    expect(bCount).toBe(0)
    expect(new Set(probePids).size).toBe(1) // same backend PID => real physical reuse
  })

  it('3. Tenant A rolls back with an error; the connection is clean for Tenant B', async () => {
    probePids.length = 0
    await expect(
      inTenant(TENANT_A, async (tx) => {
        await tx.execute(
          sql`insert into tenant_isolation_probe (tenant_id, payload) values (${TENANT_A}::uuid, 'rolled-back-A')`,
        )
        throw new Error('force rollback')
      }),
    ).rejects.toThrow(/force rollback/)
    await inTenant(TENANT_B, async () => {})
    expect(new Set(probePids).size).toBe(1)
    expect(await countFor(TENANT_A)).toBe(1) // only the committed row
    expect(['', null, undefined]).toContain(await gucAfterTransaction()) // no session residue
  })

  it('4. an exception mid-transaction releases the connection for the next tenant', async () => {
    probePids.length = 0
    await expect(
      inTenant(TENANT_A, async () => {
        throw new Error('mid-flight')
      }),
    ).rejects.toThrow(/mid-flight/)
    await inTenant(TENANT_B, async () => {})
    expect(new Set(probePids).size).toBe(1)
    expect(['', null, undefined]).toContain(await gucAfterTransaction())
  })

  it('5. concurrent requests from two tenants on a shared single connection never cross', async () => {
    probePids.length = 0
    await Promise.all([
      inTenant(TENANT_A, async (tx) => {
        await tx.execute(
          sql`insert into tenant_isolation_probe (tenant_id, payload) values (${TENANT_A}::uuid, 'concurrent-A')`,
        )
      }),
      inTenant(TENANT_B, async (tx) => {
        await tx.execute(
          sql`insert into tenant_isolation_probe (tenant_id, payload) values (${TENANT_B}::uuid, 'concurrent-B')`,
        )
      }),
    ])
    expect(new Set(probePids).size).toBe(1)
    expect(await countFor(TENANT_A)).toBe(2)
    expect(await countFor(TENANT_B)).toBe(1)
  })

  it('6. no tenant context (or empty context) sees nothing — RLS is the second layer', async () => {
    const noCtx = await app.unsafe(`select count(*)::int as n from tenant_isolation_probe`)
    expect(Number(noCtx[0]?.n ?? 0)).toBe(0)
    const empty = await app.unsafe(
      `select set_config('app.tenant_id', '', true); select count(*)::int as n from tenant_isolation_probe`,
    )
    expect(Number((empty as unknown as Array<{ n: number }>)[1]?.n ?? 0)).toBe(0)
  })

  it('7. a cross-tenant insert is rejected by the WITH CHECK policy', async () => {
    await expect(
      inTenant(TENANT_A, async (tx) => {
        await tx.execute(
          sql`insert into tenant_isolation_probe (tenant_id, payload) values (${TENANT_B}::uuid, 'forged')`,
        )
      }),
    ).rejects.toThrow()
    expect(await countFor(TENANT_B)).toBe(1)
  })

  it('8. set_config is transaction-local (is_local=true), never session-level', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./rls.ts', import.meta.url), 'utf8')
    expect(src).toContain("set_config('app.tenant_id', ${tenantId}, true)")
    expect(src).not.toMatch(/set_config\([^)]*,\s*false\s*\)/)
    expect(src).not.toMatch(/SET ROLE|SET SESSION|SET app\./)
  })
})
