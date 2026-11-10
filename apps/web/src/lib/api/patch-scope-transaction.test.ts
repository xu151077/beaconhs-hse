// PD-01 M1 — the patch scope re-check must share ONE transaction with the
// mutation. Real PostgreSQL (ephemeral container), the real patchEntity ->
// updateDocument handler and real FORCE RLS; next/cache is the only mock and it
// is a framework API, not data. Proves that a record which leaves the caller's
// scope during a patch rolls the whole mutation back.

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import postgres, { type Sql } from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type { RequestContext } from '@beaconhs/tenant'
import { withTenant, type Database } from '@beaconhs/db'
import * as schema from '@beaconhs/db/schema'
import { patchEntity } from './write'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const NAME = `beaconhs-m1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let admin: Sql
let app: Sql
let appDb: Database
let attacker: Sql
let url = ''

function docker(...args: string[]) {
  return execSync(`docker ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function port(): number {
  return Number(docker('port', NAME, '5432').trim().split(':').pop())
}

const TENANT = '11111111-1111-4111-8111-111111111111'
const TENANT_OTHER = '22222222-2222-4222-8222-222222222222'
const ME = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const OTHER = 'bbbbbbbb-0000-4000-8000-0000000000b2'
const CROSS = 'cccccccc-0000-4000-8000-0000000000c3'
const DOC = 'dddddddd-0000-4000-8000-0000000000d4'

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
  url = `postgresql://probe_app:probepw@127.0.0.1:${port()}/beaconhs`
  admin = postgres(`postgresql://postgres:testpw@127.0.0.1:${port()}/beaconhs`, { max: 2 })
  for (let i = 0; i < 40; i++) {
    try {
      await admin`select 1`
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  await admin.unsafe(`
    CREATE TYPE document_status AS ENUM ('draft','published','archived','under_review');
    CREATE TABLE tenant_users (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      user_id text,
      status text NOT NULL DEFAULT 'active',
      display_name text
    );
    CREATE TABLE documents (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      key text NOT NULL,
      title text NOT NULL,
      description text,
      type_id uuid,
      category_id uuid,
      status document_status NOT NULL DEFAULT 'draft',
      owner_tenant_user_id uuid,
      review_frequency_months integer,
      next_review_on date,
      source_attachment_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      actor_user_id text,
      actor_ip text,
      actor_user_agent text,
      entity_type text NOT NULL,
      entity_id uuid,
      action text NOT NULL,
      dedup_key text,
      summary text,
      before jsonb,
      after jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE ROLE probe_app LOGIN PASSWORD 'probepw' NOSUPERUSER NOBYPASSRLS;
    GRANT SELECT, INSERT, UPDATE, DELETE ON documents, tenant_users, audit_log TO probe_app;
    ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE documents FORCE ROW LEVEL SECURITY;
    CREATE POLICY documents_tenant ON documents
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_users FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_users_tenant ON tenant_users
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
    CREATE POLICY audit_log_tenant ON audit_log
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    INSERT INTO tenant_users (id, tenant_id, user_id, status, display_name) VALUES
      ('${ME}'::uuid, '${TENANT}'::uuid, 'u-self', 'active', 'Self'),
      ('${OTHER}'::uuid, '${TENANT}'::uuid, 'u-other', 'active', 'Other'),
      ('${CROSS}'::uuid, '${TENANT_OTHER}'::uuid, 'u-cross', 'active', 'Cross');
    INSERT INTO documents (id, tenant_id, key, title, status, owner_tenant_user_id) VALUES
      ('${DOC}'::uuid, '${TENANT}'::uuid, 'pd01-m1', 'before', 'published', '${ME}'::uuid);
  `)
  app = postgres(url, { max: 4 })
  appDb = drizzle(app, { schema })
  attacker = postgres(url, { max: 1 })
}, 120_000)

afterAll(async () => {
  try {
    await app?.end()
  } catch {}
  try {
    await attacker?.end()
  } catch {}
  try {
    await admin?.end()
  } catch {}
  try {
    if (!process.env.M1_KEEP) execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' })
  } catch {}
})

/** A production-shaped request context: ctx.db binds to the tenant via withTenant. */
function ctxFor(scopes: RequestContext['scopes'], membershipId: string | null): RequestContext {
  return {
    userId: 'api_key:m1-test',
    tenantId: TENANT,
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: membershipId ? { id: membershipId, displayName: 'me' } : null,
    personId: null,
    permissions: new Set<string>(['documents.read', 'documents.manage']),
    scopes,
    db: (fn: (tx: Database) => Promise<unknown>) => withTenant(appDb, TENANT, fn as never),
  } as unknown as RequestContext
}

const selfCtx = () => ctxFor([{ type: 'self' }], ME)
const tenantCtx = () => ctxFor([{ type: 'tenant' }], null)

async function row(): Promise<{ title: string; owner: string | null }> {
  const res = await admin`
    select title, owner_tenant_user_id as owner from documents where id = ${DOC}::uuid`
  const r = res[0] as { title: string; owner: string | null }
  return { title: r.title, owner: r.owner }
}

async function waitForBlockedLock(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await admin`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and state = 'active'`
    if (Number((res[0] as { n: number }).n) > 0) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('no lock waiter appeared — the TOCTOU window was not exercised')
}

describe('patchEntity scope re-check shares one transaction (real PostgreSQL)', () => {
  it('1. a self key may patch a non-ownership field; the owner is untouched', async () => {
    const result = await patchEntity(selfCtx(), 'documents', DOC, { title: 'self-patched' })
    expect(result.id).toBe(DOC)
    const after = await row()
    expect(after.title).toBe('self-patched')
    expect(after.owner).toBe(ME)
  })

  it('2. a self key cannot transfer its document to another owner; nothing is written', async () => {
    await expect(
      patchEntity(selfCtx(), 'documents', DOC, {
        title: 'should-never-land',
        ownerTenantUserId: OTHER,
      }),
    ).rejects.toThrow(/transfer documents to another owner/i)
    const after = await row()
    expect(after.owner).toBe(ME)
    expect(after.title).not.toBe('should-never-land')
  })

  it('3. a self key cannot unassign or cross-tenantly reassign the owner', async () => {
    await expect(
      patchEntity(selfCtx(), 'documents', DOC, { ownerTenantUserId: null }),
    ).rejects.toThrow(/transfer documents to another owner/i)
    await expect(
      patchEntity(selfCtx(), 'documents', DOC, { ownerTenantUserId: CROSS }),
    ).rejects.toThrow(/transfer documents to another owner/i)
    expect((await row()).owner).toBe(ME)
  })

  it('4. a tenant key keeps its existing legal ownership change (and it lands)', async () => {
    const result = await patchEntity(tenantCtx(), 'documents', DOC, {
      ownerTenantUserId: OTHER,
    })
    expect(result.id).toBe(DOC)
    expect((await row()).owner).toBe(OTHER)
    // restore for the later scenarios
    await patchEntity(tenantCtx(), 'documents', DOC, { ownerTenantUserId: ME })
    expect((await row()).owner).toBe(ME)
  })

  it('5. a cross-tenant ownership target is refused for a tenant key too', async () => {
    // tenant_users RLS hides the foreign principal, so ensureTenantUser refuses
    // before any row is written.
    await expect(
      patchEntity(tenantCtx(), 'documents', DOC, { ownerTenantUserId: CROSS }),
    ).rejects.toThrow(/No document owner with id/i)
    expect((await row()).owner).toBe(ME)
  })

  it(
    '6. TOCTOU: a concurrent reassignment makes the whole patch roll back',
    { timeout: 30_000 },
    async () => {
      // Attacker reassigns ownership on an uncommitted transaction and holds the
      // row lock; the self key's patch passes its pre-checks against committed
      // state, blocks on the lock, proceeds after the attacker commits, and is
      // then refused by the post-write re-check — rolling back its own write.
      await attacker.unsafe("select set_config('app.tenant_id', $1, false)", [TENANT])
      await attacker.unsafe('begin')
      await attacker.unsafe('update documents set owner_tenant_user_id = $1 where id = $2', [
        OTHER,
        DOC,
      ])

      const attempt = patchEntity(selfCtx(), 'documents', DOC, { title: 'toctou' }).then(
        () => 'resolved' as const,
        (error: unknown) => error,
      )
      await waitForBlockedLock(10_000)
      await attacker.unsafe('commit')
      const outcome = await attempt

      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toMatch(/cannot move documents outside its scope/i)
      // The patch's own write rolled back; the attacker's commit stands.
      const after = await row()
      expect(after.title).toBe('self-patched')
      expect(after.owner).toBe(OTHER)
      // restore the fixture for any later assertions
      await patchEntity(tenantCtx(), 'documents', DOC, { ownerTenantUserId: ME })
      expect((await row()).owner).toBe(ME)
    },
  )

  it('7. the pre-check rejects before the handler runs, so no idempotent retry writes', async () => {
    const before = await row()
    await expect(
      patchEntity(selfCtx(), 'documents', DOC, { title: 'x', ownerTenantUserId: OTHER }),
    ).rejects.toThrow(/transfer documents to another owner/i)
    const after = await row()
    expect(after).toEqual(before)
  })
})
