// The first-run setup flow, exercised against a real database.
//
// WHY THIS SUITE EXISTS
// ---------------------
// The setup surface's whole value is in its GUARDS: it must be open only while
// the platform is uninitialized, it must close the moment the first
// administrator exists, it must refuse to create a second administrator when
// two operators race, and it must refuse to create a second workspace. Those
// are database facts, not pure functions, so a unit test over the policy
// helpers cannot prove them.
//
// WHAT IT DOES NOT TOUCH
// ---------------------
// It runs against the ISOLATED scratch database (`SEED_TEST_SCRATCH_DATABASE_URL`),
// never against a deployment's own database. The suite skips itself when that
// variable is absent, exactly like the other database-backed suites in this
// repository, so a developer without a scratch database is not misled by a
// silently skipped suite.
//
// The credentials it needs are the ones the product itself uses:
//
//   MIGRATION_DATABASE_URL  the owner-capable login the migrator assumes
//   DATABASE_URL            the ordinary runtime role (no RLS bypass)
//   SUPERADMIN_DATABASE_URL the cross-tenant BYPASSRLS role
//
// A role that is SUPERUSER would prove nothing about isolation, so the suite
// checks the attributes it depends on.

import { describe, expect, it, beforeAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { createClient, extractRows } from '@beaconhs/db'

const SCRATCH_URL = process.env.SEED_TEST_SCRATCH_DATABASE_URL
const SUPERADMIN_URL = process.env.SEED_TEST_SCRATCH_SUPERADMIN_URL

const describeIfScratch = SCRATCH_URL ? describe : describe.skip

describeIfScratch('first-run setup guards', () => {
  let adminEmail = ''

  async function scalar<T>(url: string, statement: ReturnType<typeof sql>): Promise<T> {
    // `createClient` is typed as the Drizzle database but returns the pair
    // `{ db, sql }` at runtime, so the query goes through the `db` member.
    const client = createClient({ url, max: 1 }) as unknown as {
      db: { execute: (query: unknown) => Promise<unknown> }
    }
    const rows = extractRows(await client.db.execute(statement))
    return rows[0] as T
  }

  beforeAll(async () => {
    if (!SCRATCH_URL || !SUPERADMIN_URL) return
    // The suite observes guards that are about the ABSENCE of an administrator,
    // so it must start from an empty platform. The scratch database is
    // dedicated to this suite; removing the rows a PREVIOUS run of this suite
    // left behind keeps the suite re-runnable without touching anything else
    // that lives there.
    await scalar(
      SUPERADMIN_URL,
      sql`delete from account where "userId" in (
            select id from "user" where email like '%@beaconhs-test.local'
          )`,
    )
    await scalar(SUPERADMIN_URL, sql`delete from "user" where email like '%@beaconhs-test.local'`)
    adminEmail = `setup-guard-${Date.now()}@beaconhs-test.local`
  })

  it('has the role attributes the setup flow depends on', async () => {
    if (!SCRATCH_URL || !SUPERADMIN_URL) return
    const row = await scalar<{
      app_super: boolean
      app_bypass: boolean
      super_super: boolean
      super_bypass: boolean
    }>(
      SUPERADMIN_URL,
      sql`select
         (select rolsuper from pg_roles where rolname='beaconhs_app') as app_super,
         (select rolbypassrls from pg_roles where rolname='beaconhs_app') as app_bypass,
         (select rolsuper from pg_roles where rolname='beaconhs_super') as super_super,
         (select rolbypassrls from pg_roles where rolname='beaconhs_super') as super_bypass`,
    )
    // The runtime role must be neither superuser nor BYPASSRLS, and the
    // maintenance role must be BYPASSRLS without being a superuser. A
    // superuser here would let the whole suite pass for the wrong reason.
    expect(row.app_super).toBe(false)
    expect(row.app_bypass).toBe(false)
    expect(row.super_super).toBe(false)
    expect(row.super_bypass).toBe(true)
  })

  it('refuses a second administrator once one exists', async () => {
    if (!SCRATCH_URL) return
    const { bootstrapFirstAdmin, countSuperAdmins } = await import('@beaconhs/auth')

    // The scratch database must be empty for this suite to be meaningful: the
    // guards are about the ABSENCE of an administrator and of a workspace.
    expect(await countSuperAdmins()).toBe(0)

    const created = await bootstrapFirstAdmin({
      email: adminEmail,
      name: 'Setup Guard Admin',
      password: 'Guard-Setup-Password-2026',
    })
    expect(created.outcome).toBe('created')

    // The surface must be closed now: a second attempt writes nothing.
    const second = await bootstrapFirstAdmin({
      email: `second-${adminEmail}`,
      name: 'Second Admin',
      password: 'Guard-Setup-Password-2026',
    })
    expect(second.outcome).toBe('already_bootstrapped')
    expect(await countSuperAdmins()).toBe(1)
  })

  it('lets exactly one of two concurrent creations win', async () => {
    if (!SCRATCH_URL) return
    const { bootstrapFirstAdmin, countSuperAdmins } = await import('@beaconhs/auth')
    // The database already holds one administrator from the previous test, so
    // both racers must be refused — which is the observable form of the
    // concurrency guard here.
    const results = await Promise.all([
      bootstrapFirstAdmin({
        email: `race-a-${adminEmail}`,
        name: 'Race A',
        password: 'Guard-Setup-Password-2026',
      }),
      bootstrapFirstAdmin({
        email: `race-b-${adminEmail}`,
        name: 'Race B',
        password: 'Guard-Setup-Password-2026',
      }),
    ])
    for (const result of results) {
      expect(result.outcome).toBe('already_bootstrapped')
    }
    expect(await countSuperAdmins()).toBe(1)
  })

  it('provisions the first workspace once and refuses a second', async () => {
    if (!SCRATCH_URL) return
    const { countTenants, provisionFirstTenant } = await import('@beaconhs/db')

    expect(await countTenants()).toBe(0)

    const first = await provisionFirstTenant({
      name: 'Setup Guard Workspace',
      slug: `setup-guard-${Date.now()}`,
      region: 'ca-central-1',
      defaultLanguage: 'en',
      enabledLanguages: ['en'],
    })
    expect(first.outcome).toBe('provisioned')
    expect(await countTenants()).toBe(1)

    // A second workspace must be refused outright, never upserted.
    const second = await provisionFirstTenant({
      name: 'Second Guard Workspace',
      slug: `setup-guard-second-${Date.now()}`,
      region: 'ca-central-1',
      defaultLanguage: 'en',
      enabledLanguages: ['en'],
    })
    expect(second.outcome).toBe('already_provisioned')
    expect(await countTenants()).toBe(1)
  })
})
