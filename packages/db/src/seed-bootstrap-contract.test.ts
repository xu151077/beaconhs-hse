// The seed bootstrap guard: the super-admin login and the demo tenant are
// SEPARATE facts, and neither may gate the other.
//
// WHY THIS FILE EXISTS
//
// `seed.ts` opened its first transaction by inserting the super-admin and then
// doing `if (inserted.length === 0) return`. That `return` exits the whole
// transaction callback, so every tenant-scoped stage from the demo tenant down to
// the people/groups/titles helper was skipped — while the post-transaction
// stages (report definitions, canonical templates, doc lookups, PDF templates)
// still ran and still wrote rows.
//
// The result was the worst kind of failure: `pnpm db:seed` exited 0 and printed
// "Seed complete" against a database with no tenant, no built-in roles, no org
// units, no people and no job titles. Reproduced in an isolated database in all
// of these states: super-admin only, and tenant + membership only.
//
// The fix splits the two identities. The super-admin is provisioned
// unconditionally and never gates anything; the tenant bootstrap is guarded on
// the demo tenant's own existence, because the unguarded first-run-only inserts
// below that guard are safe exactly while the tenant is absent.
//
// HOW IT IS ASSERTED — and the honest limit
//
// The DB scenarios run the real `seed.ts` as a subprocess against a throwaway
// database. They are skipped, loudly, when this machine has no reachable
// Postgres or the connected role may not create a database — a skipped scenario
// is reported as skipped, never as passed.
//
// The wiring assertions are structural, for the same reason every contract test
// in this repo reads source with `readFileSync`: `seed.ts` calls `main()` at
// module scope, so importing it would run the seed. They are anchored on real
// identifiers and on the absence of the old shape, and the role set they check
// against is the real `BUILTIN_ROLES` — never a hand-written copy.

import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { BUILTIN_ROLES } from './schema/iam'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// CJS resolution is used deliberately: `import.meta.resolve` is not reliable for
// an `exports`-mapped package under this runner.
const require_ = createRequire(import.meta.url)
const SEED = resolve(PKG_DIR, 'src/seed.ts')
const seedSrc = readFileSync(SEED, 'utf8')

/** Source with comments stripped, so prose naming a symbol is not read as code. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

const code = codeOnly(seedSrc)

// ---------------------------------------------------------------------------
// Wiring — the two identities are separated
// ---------------------------------------------------------------------------

describe('the super-admin never gates the tenant bootstrap', () => {
  it('the old early return on the super-admin insert is gone', () => {
    // The exact defect. Asserted as absence, anchored on the identifier that
    // made it up, so a re-introduction under any spelling of the variable still
    // trips the `inserted`-shaped branch.
    expect(code).not.toMatch(/inserted\.length\s*===\s*0/)
    expect(code).not.toMatch(/super-admin already exists, skipping/)
  })

  it('the super-admin insert is unconditional and conflict-tolerant', () => {
    expect(code).toMatch(/\.insert\(user\)/)
    expect(code).toMatch(/\.onConflictDoNothing\(\)/)
    // It is re-read on conflict so the summary line can always name the login,
    // rather than being absent when it already existed.
    expect(code).toMatch(/insertedAdmin\s*\?\?/)
  })

  it('the tenant bootstrap is guarded on the TENANT, not on the login', () => {
    expect(code).toMatch(/const \[existingDemo\] = await tx/)
    expect(code).toMatch(/from\(tenants\)/)
    expect(code).toMatch(/eq\(tenants\.slug, DEMO_TENANT_SLUG\)/)
    // The guard must come BEFORE the demo-tenant insert it protects.
    const guard = code.indexOf('const [existingDemo]')
    const insert = code.indexOf('.insert(tenants)')
    expect(guard, 'the tenant-existence guard must be present').toBeGreaterThan(-1)
    expect(insert, 'the demo-tenant insert must be present').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(insert)
  })

  it('the two identities are declared once, as named constants', () => {
    expect(code).toMatch(/const ADMIN_EMAIL = 'admin@beaconhs\.local'/)
    expect(code).toMatch(/const DEMO_TENANT_SLUG = 'demo'/)
    // No stray literal left behind to drift from the constants.
    expect(code).not.toMatch(/email:\s*'admin@beaconhs\.local'/)
    expect(code).not.toMatch(/slug:\s*'demo',/)
  })

  it('built-in roles are still derived from the real BUILTIN_ROLES', () => {
    // No fabricated role or permission list may creep in. The bootstrap reads the
    // same definition the runtime does.
    expect(code).toMatch(/Object\.entries\(BUILTIN_ROLES\)/)
    const keysInSeed = Object.keys(BUILTIN_ROLES)
    expect(keysInSeed.length).toBeGreaterThan(0)
    // The completeness check must ask for exactly those keys, not a hardcoded set.
    expect(code).toMatch(/inArray\(roles\.key, Object\.keys\(BUILTIN_ROLES\)\)/)
  })
})

describe('"Seed complete" can never be untruthful', () => {
  it('the demo tenant is asserted before success is reported', () => {
    expect(code).toMatch(/refusing to report success/)
    expect(code).toMatch(/Seed finished without the .* tenant/)
    const assert_ = code.indexOf('refusing to report success')
    const done = code.indexOf("console.log('✔ Seed complete')")
    expect(assert_, 'the completeness assertion must be present').toBeGreaterThan(-1)
    expect(done, 'the success message must be present').toBeGreaterThan(-1)
    expect(assert_, 'the assertion must precede the success message').toBeLessThan(done)
  })

  it('a tenant missing its built-in roles is reported, not called complete', () => {
    // A tenant with no roles cannot grant a permission, so nobody can sign in
    // with one. The bootstrap cannot repair this state, so the seed must say so
    // and name the remedy rather than print success over it.
    expect(code).toMatch(/missing built-in roles/)
    expect(code).toMatch(/pnpm db:migrate && pnpm db:seed/)
  })

  it('the post-transaction tenant-independent stages are preserved', () => {
    // These run for EVERY tenant on every run and must not be folded into the
    // first-run-only guard.
    expect(code).toMatch(/BEACON_REPORT_SEEDS\.map/)
    expect(code).toMatch(/await seedCanonicalTemplates\(db\)/)
    expect(code).toMatch(/await seedDocumentTypesAndCategories\(tx as any, first\.id\)/)
    expect(code).toMatch(/await seedPdfTemplates\(tx as any, t\.id\)/)
  })
})

// ---------------------------------------------------------------------------
// Behaviour — the four scenarios against an isolated database
// ---------------------------------------------------------------------------

/**
 * A migrated scratch database for the scenario matrix.
 *
 * These scenarios drive the REAL `seed.ts` as a subprocess, so they need a
 * migrated database they own and may truncate. `beaconhs_super` deliberately
 * lacks CREATEDB (least privilege), so this database is supplied by the
 * environment rather than created here.
 *
 *   SEED_TEST_SCRATCH_DATABASE_URL=postgresql://…/scratch pnpm --filter @beaconhs/db test
 *
 * Without it the scenarios are reported as SKIPPED, with the reason printed —
 * never as passed. The structural assertions above always run and carry the
 * regression on their own.
 */
const SCRATCH_URL = process.env.SEED_TEST_SCRATCH_DATABASE_URL

function scratchUrl(): string {
  if (!SCRATCH_URL) throw new Error('SEED_TEST_SCRATCH_DATABASE_URL is not set')
  return SCRATCH_URL
}

/**
 * The URL used to TRUNCATE the scratch tables.
 *
 * `TRUNCATE` requires table ownership, and the migration role owns them while
 * the runtime role deliberately does not. Falls back to the scratch URL when the
 * harness supplies a single identity that happens to own them.
 */
const OWNER_URL = process.env.SEED_TEST_SCRATCH_OWNER_URL

/** Strip every row while keeping the schema and the auth `user` table. */
async function wipeTenantData(): Promise<void> {
  const sql = postgres(OWNER_URL ?? scratchUrl(), { max: 1 })
  try {
    await sql.unsafe(`
      DO $do$ DECLARE r record; BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
          IF r.tablename <> 'user' THEN
            EXECUTE format('TRUNCATE TABLE public.%I CASCADE', r.tablename);
          END IF;
        END LOOP;
      END $do$;`)
  } finally {
    await sql.end({ timeout: 0 }).catch(() => {})
  }
}

/** Every connection URL, pointed at the scratch database. */
function scratchEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: scratchUrl(),
    SUPERADMIN_DATABASE_URL: scratchUrl(),
    MIGRATION_DATABASE_URL: scratchUrl(),
  }
}

/**
 * Run a script in this package against the scratch database.
 *
 * `tsx` is invoked through `process.execPath` with the URLs supplied in `env`
 * rather than via `--env-file`, so nothing depends on shell quoting of a path.
 */
function runInScratch(script: string): { code: number; out: string } {
  const tsx = require_.resolve('tsx/cli')
  try {
    const out = execFileSync(process.execPath, [tsx, script], {
      env: scratchEnv(),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 900_000,
      // `migrate.ts` and `seed.ts` are chatty; execFileSync defaults to 1 MB and
      // overflows mid-stream, which surfaces as an opaque stream error.
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const runSeed = (): { code: number; out: string } => runInScratch(SEED)

/** Run one read-only statement against the scratch database. */
async function q<T = unknown>(text: string): Promise<T[]> {
  const sql = postgres(scratchUrl(), { max: 1, connect_timeout: 10 })
  try {
    return (await sql.unsafe(text)) as T[]
  } finally {
    await sql.end({ timeout: 0 }).catch(() => {})
  }
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of [
    'tenants',
    'roles',
    'org_units',
    'people',
    'person_titles',
    'job_title_tasks',
    'person_title_assignments',
  ]) {
    const rows = await q<{ n: string }>(`select count(*)::text as n from ${t};`)
    out[t] = Number(rows[0]?.n ?? -1)
  }
  return out
}

// Probed once at module load; a skipped scenario reports itself as skipped.
const cap = SCRATCH_URL
  ? ({ ok: true } as const)
  : ({ ok: false, reason: 'SEED_TEST_SCRATCH_DATABASE_URL is not set' } as const)
const describeDb = cap.ok ? describe : describe.skip
if (!cap.ok) {
  console.warn(`[seed-bootstrap-contract] DB scenarios SKIPPED — ${cap.reason}`)
}

/** A real `pnpm db:seed` subprocess takes several seconds; vitest's 5 s default is not enough. */
const DB_TIMEOUT_MS = 300_000

describeDb('seed bootstrap — scenario matrix', () => {
  it(
    'A. a fresh database converges and a second run changes nothing',
    { timeout: DB_TIMEOUT_MS },
    async () => {
      await wipeTenantData()

      const first = runSeed()
      expect(first.code, first.out.slice(-400)).toBe(0)
      const after1 = await counts()
      // Every tenant-scoped stage ran.
      expect(after1.tenants).toBe(1)
      expect(after1.roles).toBe(Object.keys(BUILTIN_ROLES).length)
      expect(after1.org_units).toBeGreaterThan(0)
      expect(after1.people).toBeGreaterThan(0)
      expect(after1.person_titles).toBeGreaterThan(0)

      const second = runSeed()
      expect(second.code, second.out.slice(-400)).toBe(0)
      expect(second.out).toContain('skipping tenant bootstrap')
      expect(second.out).toContain('Seed complete')
      expect(await counts()).toEqual(after1)
    },
  )

  it(
    'B. a super-admin-only database converges — the regression this file pins',
    { timeout: DB_TIMEOUT_MS },
    async () => {
      // Strip everything but the login row. Under the old guard this exited 0 and
      // reported success while creating nothing.
      await wipeTenantData()
      expect(
        Number(
          (
            await q<{ n: string }>(
              `select count(*)::text as n from "user" where email='admin@beaconhs.local';`,
            )
          )[0]?.n,
        ),
      ).toBe(1)
      expect((await counts()).tenants).toBe(0)

      const r = runSeed()
      expect(r.code, r.out.slice(-400)).toBe(0)
      const after = await counts()
      expect(after.tenants, 'the demo tenant must be created').toBe(1)
      expect(after.roles, 'built-in roles must be created').toBe(Object.keys(BUILTIN_ROLES).length)
      expect(after.org_units, 'the org hierarchy must be created').toBeGreaterThan(0)
      expect(after.people, 'people must be created').toBeGreaterThan(0)
      expect(after.person_titles, 'job titles must be created').toBeGreaterThan(0)

      const again = runSeed()
      expect(again.code, again.out.slice(-400)).toBe(0)
      expect(await counts()).toEqual(after)
    },
  )

  it(
    'C. a tenant missing its roles is reported loudly, not silently accepted',
    { timeout: DB_TIMEOUT_MS },
    async () => {
      await wipeTenantData()
      await q(
        `insert into tenants (slug,name,default_language,enabled_languages)
         values ('demo','Acme Industrial','en','["en"]');`,
      )
      expect((await counts()).tenants).toBe(1)
      expect((await counts()).roles).toBe(0)

      const r = runSeed()
      // No duplicate-key failure, and nothing existing is overwritten.
      expect(r.out).not.toMatch(/duplicate key|unique_violation/)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('missing built-in roles')
      expect(r.out).toContain('pnpm db:migrate && pnpm db:seed')
      expect(r.out).not.toContain('Seed complete')
    },
  )

  it(
    'D. a fully seeded database re-runs without duplicates or unique violations',
    { timeout: DB_TIMEOUT_MS },
    async () => {
      // Rebuild a complete database, then converge it twice.
      await wipeTenantData()
      expect(runSeed().code).toBe(0)
      const before = await counts()

      const r = runSeed()
      expect(r.code, r.out.slice(-400)).toBe(0)
      expect(r.out).not.toMatch(/duplicate key|unique_violation/)
      expect(await counts()).toEqual(before)
      // No duplicated roles, people or titles.
      expect(
        Number(
          (
            await q<{ n: string }>(
              `select count(*)::text as n from (select tenant_id,key from roles group by tenant_id,key having count(*)>1) x;`,
            )
          )[0]?.n,
        ),
      ).toBe(0)
      expect(
        Number(
          (
            await q<{ n: string }>(
              `select count(*)::text as n from (select tenant_id,employee_no from people group by tenant_id,employee_no having count(*)>1) x;`,
            )
          )[0]?.n,
        ),
      ).toBe(0)
    },
  )
})

// Leave the scratch database as we found it: no tenant data. The hook gets its
// own timeout because truncating ~200 tables takes longer than vitest's 10 s default.
// NB: the hook signature takes a bare timeout in milliseconds, not an options
// object — passing an object silently stringifies to "[object Object]".
afterAll(() => {
  if (SCRATCH_URL) return wipeTenantData()
}, DB_TIMEOUT_MS)
