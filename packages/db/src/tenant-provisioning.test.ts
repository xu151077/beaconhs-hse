// The first-tenant provisioner and the shared tenant-creation primitive it sits on.
//
// WHY THIS FILE EXISTS
//
// Two things were true before this module existed, and both are defects if they come
// back:
//
//   1. `db:migrate` + `bootstrap:admin` left a platform with no tenant, and
//      `getRequestContext()` returns `null` for a super-admin while no active tenant
//      exists — so `/platform/tenants/new`, the only code that could create one, was
//      itself unreachable. The platform could not create its own first workspace.
//   2. The database logic for "create a tenant" lived inline in that page. Any second
//      caller would have had to copy it, and two copies of tenant creation drift.
//
// So the properties worth pinning down are the CONTRACT — one tenant, one audit row,
// one day-one template, no demo data, no membership — and the REFUSALS, because a
// provisioner that quietly created a second workspace or overwrote the first would be
// worse than the lockout it fixes.
//
// WHAT IS ASSERTED — and the honest limit
//
// The slug rules, the argument parsing and the locale policy are pure functions and are
// asserted directly.
//
// The database scenarios run the REAL CLI as a subprocess against a throwaway
// database, because the properties that matter are only meaningful against real
// `tenants` / `audit_log` / `form_templates` rows and the real transaction that writes
// them. They are skipped, loudly, when this machine has no reachable Postgres; a
// skipped scenario is reported as skipped, never as passed.

import { describe, expect, it, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { db, type Database } from './client'
import { withSuperAdmin } from './rls'
import {
  resolveOptionalScratchDatabaseUrl,
  resolveScratchDatabaseUrl,
} from './testing/scratch-database'
import { tenants } from './schema'
import { ensureBuiltinRoles, provisionTenant, slugifyTenantSlug } from './tenant-provisioning'
import {
  ensureFreezeRow,
  readStorageFreezeStateForTenant,
  requireFreezeState,
} from './storage-freeze-operations'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from './schema/iam'
import {
  HAZID_ARC_FLASH_APP_KEY,
  HAZID_CONFINED_SPACE_APP_KEY,
  HAZID_FALL_PROTECTION_APP_KEY,
} from './seed/hazard-assessment-app-templates'
import {
  ENVIRONMENT_MONITORING_APP_KEY,
  STATUTORY_REGISTER_APP_KEY,
} from './seed/phase11e-register-apps'
import { WORK_PERMIT_APP_KEY } from './work-permit'
import {
  normaliseArgs,
  parseArgs,
  resolveLanguagePolicy,
} from './scripts/provision-first-tenant.cli'

/** The day-one builder templates a provisioned tenant receives. */
const HAZID_APP_TEMPLATE_KEYS = [
  HAZID_CONFINED_SPACE_APP_KEY,
  HAZID_ARC_FLASH_APP_KEY,
  HAZID_FALL_PROTECTION_APP_KEY,
] as const

/**
 * The full day-one template set, derived from the modules that own each key
 * (not a restated literal list). It grew beyond the original lift-plan +
 * HAZID set: the phase-11E/register/template seeders that `provisionTenant`
 * now runs also create the environmental monitoring log, statutory register,
 * toolbox-talk and work-permit apps. The null/undefined row counts in earlier
 * revisions of these tests failed CI with exactly this gap (expected 4 got 8).
 */
const DAY_ONE_TEMPLATE_KEYS = [
  'lift-plan',
  ...HAZID_APP_TEMPLATE_KEYS,
  ENVIRONMENT_MONITORING_APP_KEY,
  STATUTORY_REGISTER_APP_KEY,
  'toolbox-talk',
  WORK_PERMIT_APP_KEY,
] as const

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PKG_DIR, '../..')
const CLI = resolve(PKG_DIR, 'src/scripts/provision-first-tenant.cli.ts')

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe('tenant slug rules', () => {
  // These exact outputs are load-bearing, not cosmetic: the slug appears in the tenant
  // URL, in the kiosk sign-in link `/kiosk?t=<slug>`, and on printed documents.
  it.each([
    ['Northwind Construction', 'northwind-construction'],
    ['  Northwind  Construction  ', 'northwind-construction'],
    ['Northwind - Construction', 'northwind-construction'],
    ['ÜBER Crew', 'ber-crew'],
    ['A_B Corp', 'a_b-corp'],
    ['---trimmed---', 'trimmed'],
  ])('slugifies %j to %j', (input, expected) => {
    expect(slugifyTenantSlug(input)).toBe(expected)
  })

  it('caps at 60 characters, as the tenant path always has', () => {
    expect(slugifyTenantSlug('x'.repeat(200))).toHaveLength(60)
  })

  it('returns empty for input with no usable characters', () => {
    // The CLI turns this into a readable error rather than a confusing unique-violation.
    expect(slugifyTenantSlug('!!!')).toBe('')
  })
})

describe('provision:first-tenant argument handling', () => {
  it('drops the pnpm argument separator', () => {
    expect(normaliseArgs(['--', '--name', 'Acme'])).toEqual(['--name', 'Acme'])
  })

  it('reads the flag set', () => {
    expect(
      parseArgs(['--name', 'Northwind', '--slug', 'nw', '--region', 'eu-west-1', '--apply']),
    ).toEqual({ name: 'Northwind', slug: 'nw', region: 'eu-west-1', languages: [], apply: true })
  })

  it('collects repeatable languages', () => {
    expect(parseArgs(['--name', 'A', '--language', 'en', '--language', 'fr']).languages).toEqual([
      'en',
      'fr',
    ])
  })

  it('defaults to a dry run', () => {
    expect(parseArgs(['--name', 'A']).apply).toBe(false)
  })

  it('refuses an unrecognised flag instead of ignoring it', () => {
    expect(() => parseArgs(['--name', 'A', '--yes'])).toThrow(/unrecognised argument/)
  })

  it('requires a name — there is no default company', () => {
    // A demo default here is exactly how a production workspace ends up named "Acme".
    expect(() => parseArgs(['--apply'])).toThrow(/--name is required/)
  })
})

describe('locale policy', () => {
  it('defaults to English only', () => {
    expect(resolveLanguagePolicy([])).toEqual({ defaultLocale: 'en', enabledLocales: ['en'] })
  })

  it('always includes the default locale', () => {
    const policy = resolveLanguagePolicy(['fr', 'en'])
    expect(policy.defaultLocale).toBe('fr')
    expect(policy.enabledLocales).toContain('fr')
  })

  it('tells the operator about a typo rather than silently dropping it', () => {
    expect(() => resolveLanguagePolicy(['de'])).toThrow(/Unsupported language "de"/)
  })
})

// ---------------------------------------------------------------------------
// Database scenarios — the real CLI against a throwaway database
// ---------------------------------------------------------------------------

const SCRATCH_URL = resolveScratchDatabaseUrl()
const SUPERADMIN_URL = resolveOptionalScratchDatabaseUrl('SEED_TEST_SCRATCH_SUPERADMIN_URL')

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli', {
  paths: [resolve(REPO_ROOT, 'packages/db')],
})

type CliResult = { status: number; stdout: string; stderr: string }

/** Everything the operator would see, across both streams. */
function outputOf(result: CliResult): string {
  return `${result.stdout}${result.stderr}`
}

/**
 * `spawnSync`, not `execFileSync`: the CLI writes operator warnings with
 * `console.warn`, which Node sends to stderr, and `execFileSync` returns stdout only.
 * A warning the operator must not miss must not read as "not printed" in a test.
 */
function runCli(args: string[], url: string, stdin?: string): CliResult {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    input: stdin ?? '',
    env: {
      ...process.env,
      DATABASE_URL: url,
      // The provisioner writes the day-one audit row as superadmin, exactly as the UI
      // path does, so the CLI under test gets the same credential a real operator uses.
      SUPERADMIN_DATABASE_URL: process.env.SEED_TEST_SCRATCH_SUPERADMIN_URL ?? url,
      NODE_ENV: 'production',
    },
  })
  if (result.error) throw result.error
  const status = result.status ?? 1
  if (status !== 0) {
    const err = new Error('cli failed') as Error & {
      status?: number
      stdout?: string
      stderr?: string
    }
    err.status = status
    err.stdout = result.stdout
    err.stderr = result.stderr
    throw err
  }
  return { status: 0, stdout: result.stdout, stderr: result.stderr }
}

function tryRunCli(args: string[], url: string): CliResult {
  try {
    return runCli(args, url)
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/**
 * Read a throwaway database through a short-lived connection, as SUPERADMIN.
 *
 * The provisioning contract spans RLS-protected tables (`form_templates`, `audit_log`,
 * `roles`, `org_units`, `people`), and the runtime role sees zero rows in all of them
 * unless `app.tenant_id` is set for the tenant under test. These scenarios assert on
 * what was WRITTEN, not on what one tenant can read, so they read with RLS bypassed.
 * Reading them tenant-scoped would report an empty database as if nothing had been
 * created — which is exactly the false negative this replaced.
 */
async function query<T = Record<string, unknown>>(
  _url: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const adminUrl = process.env.SEED_TEST_SCRATCH_SUPERADMIN_URL
  if (!adminUrl) {
    throw new Error('SEED_TEST_SCRATCH_SUPERADMIN_URL is not set — cannot read the fixture.')
  }
  const sql = postgres(adminUrl, { max: 1 })
  try {
    const result = (await sql.unsafe(text, values as never[])) as unknown as T[]
    return Array.isArray(result) ? result : []
  } finally {
    await sql.end({ timeout: 0 }).catch(() => {})
  }
}

/**
 * Empty the tenant-scoped world while keeping identities.
 *
 * `TRUNCATE` needs table ownership, and the migrator login owns nothing itself — it
 * reaches the NOLOGIN owner by `SET ROLE`, exactly as `migrate.ts` does. The role name
 * comes from the project's own `DATABASE_OWNER_ROLE`.
 *
 * Deletes through the SUPERADMIN credential rather than truncating as the table
 * owner. `TRUNCATE` would need `SET ROLE beaconhs_owner`, which means a second
 * connection identity purely for test setup; `beaconhs_super` already holds DELETE on
 * `tenants` and on everything the cascade reaches, so one credential does the job. The
 * cascade clears the new tenant's form templates, versions and audit rows with it.
 *
 * Deliberately loud if the credential is missing: silently falling back to the runtime
 * role would fail with "permission denied" far from the real cause, and a skipped
 * teardown would leave every later scenario measuring stale rows.
 */
async function wipeTenants(_runtimeUrl: string): Promise<void> {
  const adminUrl = process.env.SEED_TEST_SCRATCH_SUPERADMIN_URL
  if (!adminUrl) {
    throw new Error(
      'SEED_TEST_SCRATCH_SUPERADMIN_URL is not set — the teardown needs the superadmin credential.',
    )
  }
  const sql = postgres(adminUrl, { max: 1 })
  try {
    // `storage_freeze` references `tenants` with NO ACTION, deliberately: a hard
    // tenant delete must not silently erase the record that the tenant was frozen
    // (migration 0046). A teardown that genuinely means "the tenant is gone" therefore
    // removes the freeze records FIRST, explicitly — the same order an operator would
    // use. Without this, the DELETE below fails on the FK for every tenant provisioned
    // since the provisioner began creating freeze rows.
    await sql.unsafe('DELETE FROM storage_object_deletion_outbox')
    await sql.unsafe('DELETE FROM storage_write_arms')
    await sql.unsafe('DELETE FROM in_flight_writes')
    await sql.unsafe('DELETE FROM storage_freeze')
    await sql.unsafe('DELETE FROM tenants')
  } finally {
    await sql.end({ timeout: 0 }).catch(() => {})
  }
}

type Counts = {
  tenants: number
  users: number
  roles: number
  built_in_roles: number
  org_units: number
  people: number
  form_templates: number
  audit_rows: number
}

async function counts(url: string): Promise<Counts> {
  const rows = await query<Counts>(
    url,
    `select
       (select count(*) from tenants)::int as tenants,
       (select count(*) from "user")::int as users,
       (select count(*) from roles)::int as roles,
       (select count(*) from roles where is_built_in)::int as built_in_roles,
       (select count(*) from org_units)::int as org_units,
       (select count(*) from people)::int as people,
       (select count(*) from form_templates)::int as form_templates,
       (select count(*) from audit_log where entity_type = 'tenant')::int as audit_rows`,
  )
  const row = rows[0]
  if (!row) throw new Error('counts query returned no row')
  return row
}

type RoleRow = {
  key: string
  name: string
  description: string | null
  is_built_in: boolean
  permissions: string[]
  id: string
}

/** Every role for a tenant, ordered so comparisons are stable. */
async function rolesFor(slug: string): Promise<RoleRow[]> {
  return query<RoleRow>(
    '',
    `select r.key, r.name, r.description, r.is_built_in as is_built_in,
            r.permissions as permissions, r.id::text as id
       from roles r join tenants t on t.id = r.tenant_id
      where t.slug = $1
      order by r.key`,
    [slug],
  )
}

/** Remove every platform administrator and its credentials from the fixture. */
async function clearSuperAdmins(): Promise<void> {
  await query('', `DELETE FROM "user" WHERE "isSuperAdmin"`)
}

/** How many platform administrators the fixture currently has. */
async function superAdminCount(): Promise<number> {
  const rows = await query<{ n: number }>(
    '',
    `SELECT count(*)::int AS n FROM "user" WHERE "isSuperAdmin"`,
  )
  return rows[0]?.n ?? 0
}

/**
 * Re-provision an administrator through the real `bootstrap:admin` command, so the
 * fixture is restored by the same code path an operator would use rather than by a
 * hand-written INSERT that could drift from it.
 *
 * That command lives in `@beaconhs/auth`, so it needs its own entrypoint — `runCli`
 * above is wired to THIS package's provisioner and would otherwise silently run the
 * wrong program.
 */
async function recreateSuperAdmin(): Promise<void> {
  const authCli = resolve(REPO_ROOT, 'packages/auth/src/bootstrap-admin.cli.ts')
  const child = execFileSync(
    process.execPath,
    [TSX_CLI, authCli, '--email', 'restored-admin@example.com', '--password-stdin', '--apply'],
    {
      cwd: PKG_DIR,
      encoding: 'utf8',
      input: 'Restored-Admin-Password-1\n',
      env: {
        ...process.env,
        DATABASE_URL: SCRATCH_URL as string,
        NODE_ENV: 'production',
      },
    },
  )
  expect(child).toContain('created super-admin restored-admin@example.com')
}

/**
 * Guarantee the fixture has a platform administrator, creating one if the previous
 * scenario (or a previous run that failed part-way) left none.
 *
 * Without this the suite is order-dependent: the last scenario deliberately removes
 * every administrator, so a run that fails before restoring one would make the next
 * run's day-one-audit assertions fail for a reason that has nothing to do with the code
 * under test.
 */
async function ensureSuperAdmin(): Promise<void> {
  if ((await superAdminCount()) === 0) await recreateSuperAdmin()
}

/**
 * Guard for the one scenario that calls `ensureBuiltinRoles` in-process instead of
 * shelling out to the CLI.
 *
 * `withSuperAdmin(db, fn)` deliberately ignores its first argument and always opens its
 * transaction on `superDb`, which reads `SUPERADMIN_DATABASE_URL` on first use. So that
 * variable — not `DATABASE_URL` — is the one that decides which database this probe
 * mutates. Unset or pointing elsewhere, the scenario would re-converge built-in role
 * permissions in whatever Postgres the developer machine happens to run, and could then
 * "pass" against the wrong data.
 *
 * Asserted rather than assumed, so the failure names the cause instead of surfacing as a
 * confusing permission error or a false green.
 */
function assertInProcessUrls(): void {
  const actual = process.env.SUPERADMIN_DATABASE_URL
  if (actual !== SUPERADMIN_URL) {
    throw new Error(
      'SUPERADMIN_DATABASE_URL must equal SEED_TEST_SCRATCH_SUPERADMIN_URL for the ' +
        `in-process role scenario (it is ${actual ?? 'unset'}, expected ${SUPERADMIN_URL ?? 'unset'}). ` +
        'Without it the probe would mutate the wrong database.',
    )
  }
}

const describeDb = SCRATCH_URL ? describe : describe.skip

if (!SCRATCH_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[tenant-provisioning] SEED_TEST_SCRATCH_DATABASE_URL is not set — database scenarios are SKIPPED, not passed.',
  )
}
if (SCRATCH_URL && !SUPERADMIN_URL) {
  console.warn(
    '[tenant-provisioning] SEED_TEST_SCRATCH_SUPERADMIN_URL is not set — the live scenarios will FAIL on teardown rather than skip.',
  )
}

describeDb('the first-tenant provisioner (live database)', () => {
  const url = SCRATCH_URL as string

  afterAll(async () => {
    await wipeTenants(url)
  })

  it('creates exactly one tenant, its day-one templates and one audit row — no demo data', async () => {
    await wipeTenants(url)
    await ensureSuperAdmin()
    const before = await counts(url)
    expect(before.tenants).toBe(0)

    const result = runCli(['--name', 'Northwind Construction', '--apply'], url)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('provisioned first tenant: Northwind Construction')
    // The derived slug must match what the UI would have produced for the same name.
    expect(result.stdout).toContain('northwind-construction')

    const after = await counts(url)
    expect(after.tenants).toBe(1)
    expect(after.audit_rows).toBe(1)

    // Day-one templates: the Lift Plan plus the HAZID embedded apps and the
    // register/template apps seeded from their owning constants — never a
    // literal that silently goes stale when a new day-one app is added.
    // HAZID ones are not decoration: `hazid_assessment_type_apps.template_id`
    // is a foreign key, so provisioning the HAZID library without them would
    // leave the library unlinked.
    expect(after.form_templates).toBe(DAY_ONE_TEMPLATE_KEYS.length)

    // The built-in roles, and ONLY them. Four is the count that matters, but it is
    // compared against the real BUILTIN_ROLES rather than a literal, so adding a role
    // to the catalogue does not silently pass.
    const expectedKeys = Object.keys(BUILTIN_ROLES)
    expect(after.roles).toBe(expectedKeys.length)
    expect(after.built_in_roles).toBe(expectedKeys.length)

    // Everything that is a seeded DEMO stays empty. These are the point of the whole
    // exercise: provisioning a tenant must not smuggle in business data.
    expect(after.org_units).toBe(0)
    expect(after.people).toBe(0)
    // No membership is invented for the platform administrator.
    const memberships = await query<{ n: number }>(
      url,
      `select count(*)::int as n from tenant_users`,
    )
    expect(memberships[0]?.n).toBe(0)
  }, 120_000)

  it('provisions exactly the real BUILTIN_ROLES, with parity on every field', async () => {
    await wipeTenants(url)
    await ensureSuperAdmin()
    runCli(['--name', 'Role Parity Ltd', '--apply'], url)

    const rows = await rolesFor('role-parity-ltd')
    const expectedKeys = Object.keys(BUILTIN_ROLES).sort()
    expect(rows.map((r) => r.key)).toEqual(expectedKeys)

    for (const row of rows) {
      const def = BUILTIN_ROLES[row.key]
      if (!def) throw new Error(`unexpected role ${row.key}`)
      expect(row.is_built_in, `${row.key} must be built-in`).toBe(true)
      expect(row.name).toBe(def.name)
      expect(row.description).toBe(def.description)
      // Exact parity, compared order-insensitively: Postgres returns the array as
      // stored, and a drift here is a real authorization difference.
      expect([...row.permissions].sort()).toEqual([...def.permissions].sort())
    }

    // And the sensitive one: tenant_admin must carry the whole catalogue.
    const catalogue = [...PERMISSION_CATALOGUE].sort()
    const admin = rows.find((r) => r.key === 'tenant_admin')
    expect([...(admin?.permissions ?? [])].sort()).toEqual(catalogue)
  }, 180_000)

  it('a custom role in the tenant survives, and built-in roles are not overwritten', async () => {
    await wipeTenants(url)
    await ensureSuperAdmin()
    runCli(['--name', 'Custom Role Ltd', '--apply'], url)

    // Provision, then a tenant administrator curates a built-in role and adds one of
    // their own — the two things a re-run must never destroy.
    await query(
      '',
      `UPDATE roles SET permissions = '["incidents.read.self"]'::jsonb
                       WHERE key = 'foreman'`,
    )
    const custom = await query<{ id: string }>(
      '',
      `INSERT INTO roles (id, tenant_id, key, name, is_built_in, permissions)
       SELECT gen_random_uuid(), t.id, 'shift-lead', 'Shift Lead', false, '["incidents.read.site"]'::jsonb
         FROM tenants t WHERE t.slug = 'custom-role-ltd'
       RETURNING id::text as id`,
    )
    const customId = custom[0]?.id
    expect(customId).toBeTruthy()

    const before = await rolesFor('custom-role-ltd')
    const beforeForeman = before.find((r) => r.key === 'foreman')

    // Re-run the seeder against the existing tenant, exactly as the seed would. The
    // module-level `db`/`superDb` clients are lazy and read DATABASE_URL on first use,
    // which is why this suite passes the scratch URLs through the environment.
    //
    // This is the ONE scenario that does not shell out to the CLI, so it is also the
    // one place the environment can silently point at the wrong database: without the
    // assertion below, a machine whose DATABASE_URL is a developer's real Postgres
    // would have built-in roles re-converged in it. Fail loudly instead.
    assertInProcessUrls()
    await withSuperAdmin(db, async (tx) => {
      const [row] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, 'custom-role-ltd'))
        .limit(1)
      if (!row) throw new Error('the tenant under test disappeared')
      await ensureBuiltinRoles(tx as unknown as Database, row.id)
    })

    const after = await rolesFor('custom-role-ltd')
    // Same role ids, same count: nothing duplicated, nothing removed.
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort())
    expect(after.length).toBe(before.length)
    // The curated permission survived — the seeder does not re-assert permissions.
    expect(after.find((r) => r.key === 'foreman')?.permissions).toEqual(beforeForeman?.permissions)
    // The custom role is untouched and still not built-in.
    const shiftLead = after.find((r) => r.key === 'shift-lead')
    expect(shiftLead?.is_built_in).toBe(false)
    expect(shiftLead?.permissions).toEqual(['incidents.read.site'])
  }, 180_000)

  it('the day-one audit row belongs to the new tenant and names the super-admin', async () => {
    await wipeTenants(url)
    await ensureSuperAdmin()
    runCli(['--name', 'Audit Trail Ltd', '--apply'], url)
    const rows = await query<{
      tenant_id: string
      tenant_slug: string
      audit_tenant: string
      action: string
      actor: string | null
    }>(
      url,
      `select t.id::text as tenant_id,
              t.slug as tenant_slug,
              a.tenant_id::text as audit_tenant,
              a.action,
              u.email as actor
         from tenants t
         join audit_log a on a.entity_id = t.id and a.entity_type = 'tenant'
         left join "user" u on u.id = a.actor_user_id`,
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (!row) throw new Error('no audit row')
    // The audit row must live in the NEW tenant's own log, or the day-one timeline is
    // empty on arrival. Compared id-to-id: the audit row's tenant_id must be the tenant
    // that was just created.
    expect(row.audit_tenant).toBe(row.tenant_id)
    expect(row.tenant_slug).toBe('audit-trail-ltd')
    expect(row.action).toBe('create')
    expect(row.actor).toBeTruthy()
  }, 60_000)

  it('the seeded templates are exactly the day-one set, and the Lift Plan is fillable', async () => {
    const rows = await query<{ key: string; status: string; category: string | null }>(
      url,
      `select key, status, category from form_templates order by key`,
    )
    // Derived from the source constants, not a literal list: the previous
    // four-template list went stale when the register/template seeders joined
    // provisioning (CI: expected 4, got 8).
    expect(rows.map((r) => r.key).sort()).toEqual([...DAY_ONE_TEMPLATE_KEYS].sort())

    const liftPlan = rows.find((r) => r.key === 'lift-plan')
    expect(liftPlan).toBeDefined()
    // Published, so people can fill it immediately.
    expect(liftPlan?.status).toBe('published')
    expect(liftPlan?.category).toBe('lift_plan')
  }, 60_000)

  it('refuses on a second run: no new tenant, nothing overwritten', async () => {
    const before = await counts(url)
    const slugBefore = await query<{ slug: string; name: string }>(
      url,
      `select slug, name from tenants order by created_at limit 1`,
    )

    const result = runCli(['--name', 'A Completely Different Company', '--apply'], url)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Already provisioned')

    const after = await counts(url)
    expect(after.tenants).toBe(before.tenants)
    expect(after.audit_rows).toBe(before.audit_rows)
    expect(after.form_templates).toBe(before.form_templates)

    const slugAfter = await query<{ slug: string; name: string }>(
      url,
      `select slug, name from tenants order by created_at limit 1`,
    )
    expect(slugAfter).toEqual(slugBefore)
  }, 120_000)

  it('writes nothing without --apply', async () => {
    await wipeTenants(url)
    const before = await counts(url)

    const result = runCli(['--name', 'Dry Run Ltd'], url)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DRY RUN')

    expect(await counts(url)).toEqual(before)
  }, 120_000)

  it('applies an explicit slug and region', async () => {
    await wipeTenants(url)
    const result = runCli(
      ['--name', 'ÜBER Crew', '--slug', 'uber-crew', '--region', 'eu-west-1', '--apply'],
      url,
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('uber-crew')
    expect(result.stdout).toContain('eu-west-1')

    const rows = await query<{ slug: string; region: string; default_language: string }>(
      url,
      `select slug, region, default_language from tenants`,
    )
    expect(rows[0]?.slug).toBe('uber-crew')
    expect(rows[0]?.region).toBe('eu-west-1')
    expect(rows[0]?.default_language).toBe('en')
  }, 120_000)

  it('rejects an unsupported language instead of silently provisioning en-only', async () => {
    await wipeTenants(url)
    const result = tryRunCli(['--name', 'Bad Locale Ltd', '--language', 'de', '--apply'], url)
    expect(result.status).toBe(2)
    expect(`${result.stdout}${result.stderr}`).toContain('Unsupported language "de"')
    expect((await counts(url)).tenants).toBe(0)
  }, 120_000)

  it('warns, but still provisions, when no super-admin exists', async () => {
    // This scenario needs a fixture with NO platform administrator, so it builds
    // one itself rather than assuming it. Relying on run order would make the suite
    // pass or fail depending on whether an earlier scenario created one — and the
    // administrator is then restored below, so the fixture is left as it was found.
    await wipeTenants(url)
    await clearSuperAdmins()

    // The tenant row is valid on its own; the operator is told the consequence.
    const result = runCli(['--name', 'Orphan First Ltd', '--apply'], url)
    expect(result.status).toBe(0)
    // The warning is emitted on stderr, the report on stdout; assert across both.
    const output = outputOf(result)
    expect(output).toContain('MISSING')
    expect(output).toContain('bootstrap:admin')
    expect(output).toContain('nobody can sign in')
    expect((await counts(url)).tenants).toBe(1)

    // Nothing to attribute the day-one audit row to, so `actor_user_id` is null
    // rather than pointing at a fabricated identity.
    const actor = await query<{ actor: string | null }>(
      url,
      `select actor_user_id::text as actor from audit_log where entity_type = 'tenant'`,
    )
    expect(actor[0]?.actor).toBeNull()

    // Restore a super-admin so the fixture matches its starting shape.
    await recreateSuperAdmin()
    expect(await superAdminCount()).toBe(1)
  }, 180_000)
})

// ---------------------------------------------------------------------------
// Storage-freeze initialization — a new tenant must be storage-writable
// ---------------------------------------------------------------------------
//
// WHY THIS BLOCK EXISTS
//
// `insertProvisionedTenant` created the tenant, its roles, its catalogue, its day-one
// template and its audit row — but no `storage_freeze` row. The storage write gate
// fails closed when it cannot read one, so every tenant created through the UI or the
// CLI was permanently refused EVERY controlled storage write
// (`STORAGE_FREEZE_STATE_UNKNOWN`) until an operator inserted the row by hand. The
// fix creates the row in the SAME transaction as the tenant.
//
// The properties pinned here are the ones the fix must keep:
//
//   1. a provisioned tenant has exactly one freeze row — ACTIVE, version 0, no
//      migration, no lease — and the production reader the storage gate consumes
//      resolves it;
//   2. a missing row still fails closed (the fix did not relax the gate), and
//      re-initialization is idempotent and race-safe;
//   3. a failed provisioning transaction leaves neither the tenant nor its freeze
//      row, and two concurrent provisions of one name produce exactly one of each;
//   4. freeze rows stay tenant-isolated under the real runtime RLS role.

describeDb('storage-freeze initialization (live database)', () => {
  const url = SCRATCH_URL as string

  afterAll(async () => {
    await wipeTenants(url)
  })

  it('creates exactly one ACTIVE freeze row with the tenant, readable by the gate', async () => {
    await wipeTenants(url)
    await ensureSuperAdmin()
    runCli(['--name', 'Freeze Init Ltd', '--apply'], url)

    const rows = await query<{
      tenant_id: string
      state: string
      version: number
      migration_id: string | null
      lease_holder_id: string | null
      lease_expires_at: string | null
      freeze_requested_at: string | null
      reconciliation_manifest_sha256: string | null
    }>(
      url,
      `select s.tenant_id::text as tenant_id,
              s.state,
              s.version,
              s.migration_id::text as migration_id,
              s.lease_holder_id,
              s.lease_expires_at::text as lease_expires_at,
              s.freeze_requested_at::text as freeze_requested_at,
              s.reconciliation_manifest_sha256
         from storage_freeze s
         join tenants t on t.id = s.tenant_id
        where t.slug = 'freeze-init-ltd'`,
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (!row) throw new Error('no freeze row for the provisioned tenant')
    expect(row.state).toBe('ACTIVE')
    expect(row.version).toBe(0)
    // A brand-new tenant has never been frozen, never held a lease and never been
    // reconciled; anything else would mean a transition ran before it existed.
    expect(row.migration_id).toBeNull()
    expect(row.lease_holder_id).toBeNull()
    expect(row.lease_expires_at).toBeNull()
    expect(row.freeze_requested_at).toBeNull()
    expect(row.reconciliation_manifest_sha256).toBeNull()

    // The production reader the storage gate consumes — not a query written by this
    // test — resolves the row. `bootstrapStorageFreezeGate` hands exactly this value
    // to `packages/storage`, so a row that exists but cannot be read through this path
    // would still refuse every write.
    assertInProcessUrls()
    const read = await readStorageFreezeStateForTenant(row.tenant_id)
    expect(read).toEqual({ state: 'ACTIVE', version: 0 })
  }, 120_000)

  it('still fails closed without the row, and re-initialization is idempotent and race-safe', async () => {
    await wipeTenants(url)
    await ensureSuperAdmin()
    runCli(['--name', 'Freeze Missing Ltd', '--apply'], url)

    const found = await query<{ id: string }>(
      url,
      `select id::text as id from tenants where slug = 'freeze-missing-ltd'`,
    )
    const tenantId = found[0]?.id
    if (!tenantId) throw new Error('the tenant under test disappeared')
    assertInProcessUrls()

    // Recreate the pre-fix world deliberately: the tenant exists, its freeze row does
    // not. Both the gate reader and the DB-layer requirement must refuse rather than
    // assume ACTIVE — this is the half the fix must NOT have relaxed.
    await query(url, `delete from storage_freeze where tenant_id = $1`, [tenantId])
    expect(await readStorageFreezeStateForTenant(tenantId)).toBeNull()
    await expect(withSuperAdmin(db, (tx) => requireFreezeState(tx, tenantId))).rejects.toThrow(
      /refusing to assume ACTIVE/,
    )

    // Re-initialization twice: same row, still exactly one.
    const first = await withSuperAdmin(db, (tx) => ensureFreezeRow(tx, tenantId))
    const second = await withSuperAdmin(db, (tx) => ensureFreezeRow(tx, tenantId))
    expect(second.id).toBe(first.id)
    expect(second.state).toBe('ACTIVE')
    expect(second.version).toBe(0)

    // Racing initializers: both must resolve, to the same single row.
    await query(url, `delete from storage_freeze where tenant_id = $1`, [tenantId])
    const raced = await Promise.all([
      withSuperAdmin(db, (tx) => ensureFreezeRow(tx, tenantId)),
      withSuperAdmin(db, (tx) => ensureFreezeRow(tx, tenantId)),
    ])
    expect(raced[0]?.id).toBe(raced[1]?.id)

    const count = await query<{ n: number }>(
      url,
      `select count(*)::int as n from storage_freeze where tenant_id = $1`,
      [tenantId],
    )
    expect(count[0]?.n).toBe(1)

    // The database is the last line of defence: a second row cannot exist even if a
    // future initializer forgets its guard.
    await expect(
      query(url, `insert into storage_freeze (tenant_id, state) values ($1, 'ACTIVE')`, [tenantId]),
    ).rejects.toThrow(/storage_freeze_tenant_ux|duplicate key/i)
  }, 120_000)

  it('a failed provisioning transaction leaves neither the tenant nor a freeze row', async () => {
    await wipeTenants(url)
    assertInProcessUrls()

    // The real shape of `insertProvisionedTenant` — tenant row, then freeze row, then
    // a later-stage failure — built from the same primitives it uses. Fault-injection
    // hooks in production code would cost more than they prove; the property under
    // test is the transaction boundary, and the boundary is the transaction itself.
    await expect(
      withSuperAdmin(db, async (tx) => {
        const [created] = await tx
          .insert(tenants)
          .values({
            name: 'Rolled Back Ltd',
            slug: 'rolled-back-ltd',
            status: 'active',
            region: 'ca-central-1',
            defaultLanguage: 'en',
            enabledLanguages: ['en'],
          })
          .returning({ id: tenants.id })
        if (!created) throw new Error('the tenant row was not created')
        await ensureFreezeRow(tx, created.id)
        throw new Error('injected failure after the freeze row')
      }),
    ).rejects.toThrow(/injected failure after the freeze row/)

    const state = await query<{ tenants: number; freeze_rows: number }>(
      url,
      `select
         (select count(*) from tenants where slug = 'rolled-back-ltd')::int as tenants,
         (select count(*) from storage_freeze s
            join tenants t on t.id = s.tenant_id
           where t.slug = 'rolled-back-ltd')::int as freeze_rows`,
    )
    expect(state[0]).toEqual({ tenants: 0, freeze_rows: 0 })
  }, 120_000)

  it('two concurrent provisions of one name produce one tenant and one freeze row', async () => {
    await wipeTenants(url)
    assertInProcessUrls()

    const results = await Promise.allSettled([
      provisionTenant({
        name: 'Race Ltd',
        defaultLanguage: 'en',
        enabledLanguages: ['en'],
        actorUserId: null,
      }),
      provisionTenant({
        name: 'Race Ltd',
        defaultLanguage: 'en',
        enabledLanguages: ['en'],
        actorUserId: null,
      }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // The loser lost on the unique index, not on something else that would leave the
    // fixture in an unexplained state. Drizzle wraps driver errors, so walk the cause
    // chain rather than trusting one message shape.
    const reasonText = (() => {
      const parts: string[] = []
      let current: unknown = (rejected[0] as PromiseRejectedResult | undefined)?.reason
      for (let depth = 0; depth < 5 && current; depth += 1) {
        if (current instanceof Error) {
          parts.push(current.message)
          current = (current as { cause?: unknown }).cause
        } else {
          parts.push(String(current))
          break
        }
      }
      return parts.join(' | ')
    })()
    expect(reasonText).toMatch(/duplicate key|tenants_slug_ux|unique/i)

    const state = await query<{
      tenants: number
      freeze_rows: number
      roles: number
      audit_rows: number
    }>(
      url,
      `select
         (select count(*) from tenants)::int as tenants,
         (select count(*) from storage_freeze)::int as freeze_rows,
         (select count(*) from roles)::int as roles,
         (select count(*) from audit_log where entity_type = 'tenant')::int as audit_rows`,
    )
    expect(state[0]?.tenants).toBe(1)
    expect(state[0]?.freeze_rows).toBe(1)
    // One set of built-in roles and one day-one audit row: the losing transaction
    // left NOTHING behind, not even a second freeze row.
    expect(state[0]?.roles).toBe(Object.keys(BUILTIN_ROLES).length)
    expect(state[0]?.audit_rows).toBe(1)
  }, 180_000)

  it('keeps each freeze row visible only to its own tenant under the runtime RLS role', async () => {
    await wipeTenants(url)
    assertInProcessUrls()

    const alpha = await provisionTenant({
      name: 'Freeze RLS Alpha',
      defaultLanguage: 'en',
      enabledLanguages: ['en'],
      actorUserId: null,
    })
    const beta = await provisionTenant({
      name: 'Freeze RLS Beta',
      defaultLanguage: 'en',
      enabledLanguages: ['en'],
      actorUserId: null,
    })

    // The runtime credential, not the BYPASSRLS one: the identity tenant traffic runs
    // as. `url` is the scratch runtime URL, so this cannot reach another database.
    const sql = postgres(url, { max: 1 })
    try {
      const scoped = await sql.begin(async (tx) => {
        await tx.unsafe(`select set_config('app.tenant_id', $1, true)`, [alpha.id])
        const scalar = async (text: string, values: unknown[] = []): Promise<number> => {
          const rows = (await tx.unsafe(text, values as never[])) as { n: number }[]
          return rows[0]?.n ?? 0
        }
        return {
          own: await scalar(`select count(*)::int as n from storage_freeze where tenant_id = $1`, [
            alpha.id,
          ]),
          other: await scalar(
            `select count(*)::int as n from storage_freeze where tenant_id = $1`,
            [beta.id],
          ),
          all: await scalar(`select count(*)::int as n from storage_freeze`),
        }
      })
      // Scoped to A: A sees exactly its own row and nothing of B's.
      expect(scoped.own).toBe(1)
      expect(scoped.other).toBe(0)
      expect(scoped.all).toBe(1)

      // Unscoped runtime access reads nothing at all, so the zeros above are the
      // policy working rather than an empty table.
      const unscoped = (await sql.unsafe(`select count(*)::int as n from storage_freeze`)) as {
        n: number
      }[]
      expect(unscoped[0]?.n).toBe(0)

      // A row for another tenant cannot be created from inside one tenant's scope. The
      // id is freshly minted, so the refusal is the RLS WITH CHECK and not the unique
      // index.
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`select set_config('app.tenant_id', $1, true)`, [alpha.id])
          await tx.unsafe(`insert into storage_freeze (tenant_id, state) values ($1, 'ACTIVE')`, [
            randomUUID(),
          ])
        }),
      ).rejects.toThrow(/row-level security/i)

      // Sanity through the BYPASSRLS credential: both tenants really do have their one
      // ACTIVE row.
      const viaSuper = await query<{ tenant_id: string; state: string }>(
        url,
        `select tenant_id::text as tenant_id, state from storage_freeze`,
      )
      expect(viaSuper).toHaveLength(2)
      expect(new Set(viaSuper.map((r) => r.tenant_id))).toEqual(new Set([alpha.id, beta.id]))
      expect(viaSuper.every((r) => r.state === 'ACTIVE')).toBe(true)
    } finally {
      await sql.end({ timeout: 0 }).catch(() => {})
    }
  }, 300_000)
})
