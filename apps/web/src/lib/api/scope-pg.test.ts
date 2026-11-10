// PD-01 phase 3 — real-PostgreSQL proof of the API record-scope predicate.
//
// Spawns an ephemeral postgres:16-alpine container and asserts the predicate
// `entityScopeWhere` produces against real rows. This is the multi-tenant
// authorization test the phase-3 brief requires for the implemented entity
// (corrective_actions); it is not a mock.

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import postgres, { type Sql } from 'postgres'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { RequestContext } from '@beaconhs/tenant'
import { assertCreateInScope, entityScopeWhere } from './scope'

const NAME = `beaconhs-scope-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let client: Sql | null = null
let db: ReturnType<typeof drizzle> | null = null
let baseUrl = ''

function docker(...args: string[]) {
  return execSync(`docker ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function port(): number {
  return Number(docker('port', NAME, '5432').trim().split(':').pop())
}

beforeAll(async () => {
  execSync('docker --version', { stdio: 'ignore' })
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
  baseUrl = `postgresql://postgres:testpw@127.0.0.1:${port()}/beaconhs`
  for (let i = 0; i < 40; i++) {
    try {
      const c = postgres(baseUrl, { max: 1, connect_timeout: 3 })
      await c`select 1`
      await c.end()
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  client = postgres(baseUrl, { max: 4 })
  db = drizzle(client)
  await client.unsafe(`
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE org_units (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
    CREATE TABLE tenant_users (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
    CREATE TABLE people (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      crew_id uuid,
      department_id uuid,
      group_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE corrective_actions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      site_org_unit_id uuid,
      owner_tenant_user_id uuid,
      deleted_at timestamptz
    );
    CREATE TABLE documents (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      owner_tenant_user_id uuid,
      status text NOT NULL DEFAULT 'published',
      deleted_at timestamptz
    );
    CREATE TABLE training_records (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      person_id uuid,
      deleted_at timestamptz
    );
  `)
}, 120_000)

afterAll(async () => {
  try {
    await client?.end()
  } catch {}
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' })
  } catch {}
})

type Fixture = {
  tenantA: string
  tenantB: string
  siteA: string
  siteB: string
  owner1: string
  owner2: string
  rowSiteA: string
  rowSiteB: string
  rowOwner1: string
  rowOwner2: string
  rowTenantB: string
}

async function seed(): Promise<Fixture> {
  const s = client!
  const f: Fixture = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    siteA: randomUUID(),
    siteB: randomUUID(),
    owner1: randomUUID(),
    owner2: randomUUID(),
    rowSiteA: randomUUID(),
    rowSiteB: randomUUID(),
    rowOwner1: randomUUID(),
    rowOwner2: randomUUID(),
    rowTenantB: randomUUID(),
  }
  await s`insert into tenants (id) values (${f.tenantA}::uuid), (${f.tenantB}::uuid)`
  await s`insert into tenant_users (id, tenant_id) values (${f.owner1}::uuid, ${f.tenantA}::uuid), (${f.owner2}::uuid, ${f.tenantA}::uuid)`
  await s`insert into corrective_actions (id, tenant_id, site_org_unit_id, owner_tenant_user_id) values
    (${f.rowSiteA}::uuid, ${f.tenantA}::uuid, ${f.siteA}::uuid, ${f.owner1}::uuid),
    (${f.rowSiteB}::uuid, ${f.tenantA}::uuid, ${f.siteB}::uuid, ${f.owner2}::uuid),
    (${f.rowOwner1}::uuid, ${f.tenantA}::uuid, ${f.siteA}::uuid, ${f.owner1}::uuid),
    (${f.rowOwner2}::uuid, ${f.tenantA}::uuid, ${f.siteB}::uuid, ${f.owner2}::uuid),
    (${f.rowTenantB}::uuid, ${f.tenantB}::uuid, ${f.siteA}::uuid, ${f.owner1}::uuid)`
  return f
}

function ctxFor(
  tenantId: string,
  scopes: RequestContext['scopes'],
  membershipId: string | null,
): RequestContext {
  return {
    userId: 'user-1',
    tenantId,
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: membershipId ? { id: membershipId, displayName: 'x' } : null,
    personId: null,
    permissions: new Set<string>(),
    scopes,
    db: <T>(fn: (tx: never) => Promise<T>) => fn(db as never),
  } as unknown as RequestContext
}

async function visibleIdsIn(
  table: string,
  ctx: RequestContext,
  entityKey: string,
): Promise<string[]> {
  const rows = await db!.transaction(async (tx) => {
    const predicate = await entityScopeWhere(ctx, tx as never, entityKey)
    const base = sql.raw(`select id from ${table} where tenant_id = '${ctx.tenantId}'::uuid`)
    const q = predicate ? sql`${base} and ${predicate}` : base
    const res = (await tx.execute(q)) as unknown as Array<{ id: string }>
    return Array.isArray(res) ? res : ((res as { rows?: Array<{ id: string }> }).rows ?? [])
  })
  return rows.map((r) => r.id).sort()
}

async function visibleIds(
  ctx: RequestContext,
  entityKey = 'corrective_actions',
): Promise<string[]> {
  const rows = await db!.transaction(async (tx) => {
    const predicate = await entityScopeWhere(ctx, tx as never, entityKey)
    const base = sql`select id from corrective_actions where tenant_id = ${ctx.tenantId}::uuid`
    const q = predicate ? sql`${base} and ${predicate}` : base
    const res = (await tx.execute(q)) as unknown as Array<{ id: string }>
    return Array.isArray(res) ? res : ((res as { rows?: Array<{ id: string }> }).rows ?? [])
  })
  return rows.map((r) => r.id).sort()
}

describe('API record scope (real PostgreSQL)', () => {
  it('site scope sees only its site inside the tenant', async () => {
    const f = await seed()
    const ctx = ctxFor(f.tenantA, [{ type: 'sites', siteIds: [f.siteA] }], null)
    const ids = await visibleIds(ctx)
    expect(ids).toEqual([f.rowSiteA, f.rowOwner1].sort())
    expect(ids).not.toContain(f.rowSiteB)
  })

  it('self scope is the frozen owner field, not assignedBy/createdBy', async () => {
    const f = await seed()
    const ctx = ctxFor(f.tenantA, [{ type: 'self' }], f.owner1)
    const ids = await visibleIds(ctx)
    expect(ids).toEqual([f.rowSiteA, f.rowOwner1].sort())
    expect(ids).not.toContain(f.rowOwner2)
  })

  it('a tenant-scoped caller is not narrowed (legacy unbound key)', async () => {
    const f = await seed()
    const ctx = ctxFor(f.tenantA, [{ type: 'tenant' }], null)
    const ids = await visibleIds(ctx)
    expect(ids).toEqual([f.rowSiteA, f.rowSiteB, f.rowOwner1, f.rowOwner2].sort())
  })

  it('never leaks another tenant even when the scope matches', async () => {
    const f = await seed()
    const ctx = ctxFor(f.tenantA, [{ type: 'sites', siteIds: [f.siteA] }], null)
    const ids = await visibleIds(ctx)
    expect(ids).not.toContain(f.rowTenantB)
  })

  it('an unmapped entity fails closed for a scoped caller', async () => {
    const f = await seed()
    const ctx = ctxFor(f.tenantA, [{ type: 'sites', siteIds: [f.siteA] }], null)
    // entityScopeWhere returns `false` for unknown keys; prove it yields no rows.
    const rows = await db!.transaction(async (tx) => {
      const predicate = await entityScopeWhere(ctx, tx as never, 'not_mapped')
      const res = (await tx.execute(
        sql`select id from corrective_actions where tenant_id = ${f.tenantA}::uuid and ${predicate}`,
      )) as unknown as Array<{ id: string }>
      return Array.isArray(res) ? res : []
    })
    expect(rows).toEqual([])
  })

  it('documents: self scope is the document owner; site scope fails closed', async () => {
    const f = await seed()
    const s = client!
    const docMine = randomUUID()
    const docOther = randomUUID()
    const docNoOwner = randomUUID()
    await s`insert into documents (id, tenant_id, owner_tenant_user_id, status) values
      (${docMine}::uuid, ${f.tenantA}::uuid, ${f.owner1}::uuid, 'published'),
      (${docOther}::uuid, ${f.tenantA}::uuid, ${f.owner2}::uuid, 'published'),
      (${docNoOwner}::uuid, ${f.tenantA}::uuid, null, 'published')`

    const selfCtx = ctxFor(f.tenantA, [{ type: 'self' }], f.owner1)
    expect(await visibleIdsIn('documents', selfCtx, 'documents')).toEqual([docMine])

    // No site column exists on documents, so a sites scope must yield nothing
    // rather than silently degrading to "own documents".
    const siteCtx = ctxFor(f.tenantA, [{ type: 'sites', siteIds: [f.siteA] }], null)
    expect(await visibleIdsIn('documents', siteCtx, 'documents')).toEqual([])

    const tenantCtx = ctxFor(f.tenantA, [{ type: 'tenant' }], null)
    expect(await visibleIdsIn('documents', tenantCtx, 'documents')).toEqual(
      [docMine, docOther, docNoOwner].sort(),
    )
  })

  it('training_records: self scope is the trainee; site scope fails closed', async () => {
    const f = await seed()
    const s = client!
    const mine = randomUUID()
    const other = randomUUID()
    const orphan = randomUUID()
    await s`insert into training_records (id, tenant_id, person_id) values
      (${mine}::uuid, ${f.tenantA}::uuid, ${f.owner1}::uuid),
      (${other}::uuid, ${f.tenantA}::uuid, ${f.owner2}::uuid),
      (${orphan}::uuid, ${f.tenantA}::uuid, null)`

    // personId on the context is the trainee identity for a bound credential.
    const selfCtx = {
      ...ctxFor(f.tenantA, [{ type: 'self' }], f.owner1),
      personId: f.owner1,
    } as RequestContext
    expect(await visibleIdsIn('training_records', selfCtx, 'training_records')).toEqual([mine])

    const siteCtx = ctxFor(f.tenantA, [{ type: 'sites', siteIds: [f.siteA] }], null)
    expect(await visibleIdsIn('training_records', siteCtx, 'training_records')).toEqual([])

    const tenantCtx = ctxFor(f.tenantA, [{ type: 'tenant' }], null)
    expect(await visibleIdsIn('training_records', tenantCtx, 'training_records')).toEqual(
      [mine, other, orphan].sort(),
    )
  })

  it('list and count share one predicate (documents)', async () => {
    const f = await seed()
    const s = client!
    await s`insert into documents (id, tenant_id, owner_tenant_user_id, status) values
      (${randomUUID()}::uuid, ${f.tenantA}::uuid, ${f.owner1}::uuid, 'published'),
      (${randomUUID()}::uuid, ${f.tenantA}::uuid, ${f.owner2}::uuid, 'published')`
    const selfCtx = ctxFor(f.tenantA, [{ type: 'self' }], f.owner1)
    const counted = await db!.transaction(async (tx) => {
      const predicate = await entityScopeWhere(selfCtx, tx as never, 'documents')
      const q = sql`select count(*)::int as n from documents where tenant_id = ${f.tenantA}::uuid and ${predicate}`
      const res = (await tx.execute(q)) as unknown as Array<{ n: number }>
      const rows = Array.isArray(res) ? res : ((res as { rows?: Array<{ n: number }> }).rows ?? [])
      return Number(rows[0]?.n ?? 0)
    })
    const listed = await visibleIdsIn('documents', selfCtx, 'documents')
    expect(counted).toBe(listed.length)
  })

  it('B-1: Builder responses fail closed for any non-tenant scope', async () => {
    const f = await seed()
    const tenantCtx = ctxFor(f.tenantA, [{ type: 'tenant' }], null)
    // tenant scope is the compatibility path (no narrowing)
    expect(await entityScopeWhere(tenantCtx, db as never, 'form_responses')).toBeUndefined()
    for (const scopes of [
      [{ type: 'sites', siteIds: [f.siteA] }],
      [{ type: 'self' }],
    ] as RequestContext['scopes'][]) {
      const ctx = ctxFor(f.tenantA, scopes, f.owner1)
      const predicate = await entityScopeWhere(ctx, db as never, 'form_responses')
      expect(predicate).not.toBeUndefined()
      const rows = await db!.transaction(async (tx) => {
        const res = (await tx.execute(
          sql`select id from corrective_actions where tenant_id = ${f.tenantA}::uuid and ${predicate}`,
        )) as unknown as Array<{ id: string }>
        return Array.isArray(res) ? res : []
      })
      expect(rows).toEqual([])
    }
  })

  it('B-1: a scoped key cannot CREATE into an unmapped entity', async () => {
    const f = await seed()
    const ctx = ctxFor(f.tenantA, [{ type: 'sites', siteIds: [f.siteA] }], null)
    expect(() => assertCreateInScope(ctx, 'form_responses', { siteOrgUnitId: f.siteA })).toThrow(
      /cannot create/i,
    )
    // tenant scope stays compatible
    expect(() =>
      assertCreateInScope(ctxFor(f.tenantA, [{ type: 'tenant' }], null), 'form_responses', {}),
    ).not.toThrow()
  })
})
