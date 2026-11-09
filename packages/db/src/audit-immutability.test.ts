import { execSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'

const NAME = `beaconhs-audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let superSql: ReturnType<typeof postgres>
let appSql: ReturnType<typeof postgres>
let migrated = false

function docker(...args: string[]): string {
  return execSync(`docker ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function port(): number {
  const out = docker('port', NAME, '5432')
  return Number(out.trim().split(':').pop())
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

beforeAll(async () => {
  // Skip if docker unavailable (CI without docker).
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
  const url = `postgresql://postgres:testpw@127.0.0.1:${port()}/beaconhs`
  await waitReady(url)
  superSql = postgres(url, { max: 1 })
  await superSql.unsafe(`
    CREATE ROLE beaconhs_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE beaconhs_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'apppw';
    CREATE ROLE beaconhs_super LOGIN NOSUPERUSER BYPASSRLS PASSWORD 'superpw';
    CREATE ROLE beaconhs_migrator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD 'migpw';
    CREATE ROLE beaconhs_backup LOGIN NOSUPERUSER BYPASSRLS PASSWORD 'backuppw';
    GRANT beaconhs_owner TO beaconhs_migrator;
    ALTER DATABASE beaconhs OWNER TO beaconhs_owner;
  `)
  await superSql.unsafe(`
    SET ROLE beaconhs_owner;
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE users (id text PRIMARY KEY);
    CREATE TABLE attachments (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, UNIQUE (tenant_id, id));
    CREATE TABLE ppe_inspection_attachments (tenant_id uuid NOT NULL, attachment_id uuid NOT NULL);
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
      entity_type text NOT NULL, entity_id uuid, action text NOT NULL,
      summary text, before jsonb, after jsonb, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, attachments, ppe_inspection_attachments, audit_log TO beaconhs_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, attachments, ppe_inspection_attachments, audit_log TO beaconhs_super;
    GRANT SELECT ON tenants, users, attachments, ppe_inspection_attachments, audit_log TO beaconhs_backup;
  `)
  // Apply only the 0056 statements (read file, strip breakpoint markers).
  const raw = readFileSync(
    new URL('../drizzle/0056_audit_log_and_fk_replay_safety.sql', import.meta.url),
    'utf8',
  )
  const stmts = raw
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/--[^\n]*\n/g, '').trim())
    .filter((s) => s && !s.startsWith('--'))
  // Apply as owner (mirrors migrate.ts SET ROLE) so trigger function is owned.
  // 0057 also replaces the trigger function (correct owner return values);
  // apply it when present so this harness tests the full final chain.
  const stmts0057 = readFileSync(
    new URL('../drizzle/0057_audit_immutable_trigger_owner_fix.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/--[^\n]*\n/g, '').trim())
    .filter((s) => s && !s.startsWith('--'))
  await superSql.unsafe('SET ROLE beaconhs_owner')
  for (const stmt of stmts) {
    if (stmt.includes('ppe_inspection') || stmt.includes('audit_log')) {
      await superSql.unsafe(stmt)
    }
  }
  for (const stmt of stmts0057) {
    if (stmt.includes('audit_log')) await superSql.unsafe(stmt)
  }
  await superSql.unsafe('RESET ROLE')
  migrated = true
  appSql = postgres(`postgresql://beaconhs_app:apppw@127.0.0.1:${port()}/beaconhs`, { max: 1 })
}, 120_000)

afterAll(async () => {
  try {
    await superSql?.end()
  } catch {}
  try {
    await appSql?.end()
  } catch {}
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' })
  } catch {}
})

function need() {
  if (!migrated || !superSql || !appSql) throw new Error('skipped: no disposable PG')
}

describe('audit_log immutable + FK replay safety (real PG)', () => {
  it('app INSERT ok, UPDATE/DELETE/TRUNCATE denied, cascade denied, trigger/function protected', async () => {
    need()
    const s = superSql!
    const app = appSql!
    const [t] = await s`insert into tenants (id) values (${crypto.randomUUID()}::uuid) returning id`
    const tenantId = t!.id
    // 1) INSERT ok
    await app`insert into audit_log (tenant_id, entity_type, action) values (${tenantId}::uuid, 'incident', 'create')`
    const [row] = await app`select id from audit_log where tenant_id = ${tenantId}::uuid limit 1`
    const auditId = row!.id
    // 2) UPDATE denied (REVOKE alone already denies; trigger denies when grant exists)
    await expect(
      app`update audit_log set summary='x' where id = ${auditId}::uuid`,
    ).rejects.toThrowError(/append-only|permission/i)
    // 3) DELETE denied
    await expect(app`delete from audit_log where id = ${auditId}::uuid`).rejects.toThrowError(
      /append-only|permission/i,
    )
    // 4) TRUNCATE denied
    await expect(app`truncate audit_log`).rejects.toThrowError(/permission/i)
    // 5) cascade denied (tenant delete must not delete audit rows)
    await expect(app`delete from tenants where id = ${tenantId}::uuid`).rejects.toThrowError(
      /append-only|audit_log|permission/i,
    )
    // 6) DISABLE TRIGGER denied
    await expect(
      app`alter table audit_log disable trigger audit_log_immutable_trigger`,
    ).rejects.toThrowError(/permission|owner/i)
    // 7) REPLACE FUNCTION denied
    await expect(
      app`create or replace function public.audit_log_immutable() returns trigger language plpgsql as $$ begin return NEW; end $$`,
    ).rejects.toThrowError(/permission|owner|exist/i)
    // 8) BYPASSRLS (super) still blocked
    const sup = postgres(`postgresql://beaconhs_super:superpw@127.0.0.1:${port()}/beaconhs`, {
      max: 1,
    })
    await expect(sup`delete from audit_log where id = ${auditId}::uuid`).rejects.toThrowError(
      /append-only|permission/i,
    )
    await expect(
      sup`alter table audit_log disable trigger audit_log_immutable_trigger`,
    ).rejects.toThrowError(/permission|owner/i)
    await sup.end()
    // 8b) trigger layer: a role WITH UPDATE/DELETE grant is still blocked
    await s.unsafe(`CREATE ROLE audit_writer LOGIN PASSWORD 'wpw'`)
    await s.unsafe(`GRANT CREATE ON SCHEMA public TO audit_writer`)
    await s.unsafe(`GRANT SELECT, UPDATE, DELETE ON audit_log TO audit_writer`)
    const writer = postgres(`postgresql://audit_writer:wpw@127.0.0.1:${port()}/beaconhs`, {
      max: 1,
    })
    await expect(
      writer`update audit_log set summary='x' where id = ${auditId}::uuid`,
    ).rejects.toThrowError(/append-only/i)
    await expect(writer`delete from audit_log where id = ${auditId}::uuid`).rejects.toThrowError(
      /append-only/i,
    )
    await writer.end()
    // 9) owner via SET ROLE (migrator path) allowed — and actually mutates.
    // Asserting the changed row matters: the original trigger returned NULL
    // from the BEFORE branch for the owner, which silently suppresses the
    // row instead of raising; "no error" alone would pass with zero effect.
    const mig = postgres(`postgresql://beaconhs_migrator:migpw@127.0.0.1:${port()}/beaconhs`, {
      max: 1,
    })
    await mig`set role beaconhs_owner`
    await mig`update audit_log set summary='owner-repair' where id = ${auditId}::uuid`
    const [repaired] = await mig`select summary from audit_log where id = ${auditId}::uuid`
    expect(repaired?.summary).toBe('owner-repair')
    await mig.end()
  })

  it('FK: absent installs, present replays, unvalidated validates, wrong def rejects', async () => {
    need()
    const s = superSql!
    const fk = 'att_tenant_ppe_inspection_attachments_attachment_id_3b75c366'
    const doBlock = readFileSync(
      new URL('../drizzle/0056_audit_log_and_fk_replay_safety.sql', import.meta.url),
      'utf8',
    ).split('--> statement-breakpoint')[0]!
    // 10) drop then install
    await s.unsafe(`ALTER TABLE ppe_inspection_attachments DROP CONSTRAINT IF EXISTS ${fk}`)
    const exists = await s`select 1 from pg_constraint where conname = ${fk}`
    expect(exists.length).toBe(0)
    await s.unsafe(doBlock)
    const afterCreate = await s`select 1 from pg_constraint where conname = ${fk}`
    expect(afterCreate.length).toBe(1)
    // 11) replay succeeds (idempotent)
    await s.unsafe(doBlock)
    await s.unsafe(`ALTER TABLE ppe_inspection_attachments VALIDATE CONSTRAINT ${fk}`)
    // 12) unvalidated path: drop validated, recreate NOT VALID, then VALIDATE succeeds
    await s.unsafe(`ALTER TABLE ppe_inspection_attachments DROP CONSTRAINT IF EXISTS ${fk}`)
    await s.unsafe(
      `ALTER TABLE ppe_inspection_attachments ADD CONSTRAINT ${fk} FOREIGN KEY (tenant_id, attachment_id) REFERENCES attachments (tenant_id, id) ON DELETE CASCADE NOT VALID`,
    )
    const unvalidated = await s`select convalidated from pg_constraint where conname = ${fk}`
    expect(unvalidated[0]!.convalidated).toBe(false)
    await s.unsafe(`ALTER TABLE ppe_inspection_attachments VALIDATE CONSTRAINT ${fk}`)
    const validated = await s`select convalidated from pg_constraint where conname = ${fk}`
    expect(validated[0]!.convalidated).toBe(true)
    // 13) wrong def rejected
    await s.unsafe(`ALTER TABLE ppe_inspection_attachments DROP CONSTRAINT IF EXISTS ${fk}`)
    await s.unsafe(
      `ALTER TABLE ppe_inspection_attachments ADD CONSTRAINT ${fk} FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE NOT VALID`,
    )
    await expect(s.unsafe(doBlock)).rejects.toThrowError(/wrong/i)
  })

  it('journal/snapshot chain includes 0057 (with 0056 and 0055 untouched)', () => {
    // 15/16 static parts: full migrate chain length + file presence (live full migrate left to CI)
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    )
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 57,
      tag: '0057_audit_immutable_trigger_owner_fix',
    })
    expect(journal.entries.at(-2)).toMatchObject({
      idx: 56,
      tag: '0056_audit_log_and_fk_replay_safety',
    })
    expect(journal.entries.at(-3)).toMatchObject({
      idx: 55,
      tag: '0055_drop_redundant_single_col_fks',
    })
  })
})
