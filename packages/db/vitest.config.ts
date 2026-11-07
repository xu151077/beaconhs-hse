// Vitest configuration for @beaconhs/db.
//
// WHY THIS FILE EXISTS
//
// Five suites here talk to a real Postgres, and they are NOT interchangeable. Each needs
// a specific credential, and two of them additionally destroy each other's fixtures.
// Running them all against one database "works" only because they silently SKIP — which
// hides real connection misconfiguration. This file assigns each suite the identity it
// needs and serialises the ones that share a database.
//
// THE CREDENTIAL each suite actually requires
//
//   seed-bootstrap-contract  Drives the real `migrate.ts` and issues TRUNCATE. Both need
//                            an OWNER-capable role, because the runtime role deliberately
//                            owns nothing. Pointed at beaconhs_app it fails with
//                            "permission denied for table verification" — a connection
//                            misconfiguration, not a product failure.
//   phase11e-seed-integrity  Only needs a migrated, SEEDED database (it asserts on the
//                            demo rows the seed creates).
//   tenant-provisioning     Runs the provisioner as a subprocess and asserts on RLS
//   tenant-reference-data   behaviour, so it needs the runtime + BYPASSRLS credentials.
//                            As a superuser it would prove nothing about isolation.
//   storage-freeze-         Writes across tenants through the shared `db` client, so its
//   operations              DATABASE_URL needs a BYPASSRLS identity on the same isolated
//                            database as its scratch gate.
//
// WHY phase11e gets ITS OWN DATABASE
//
// `seed-bootstrap-contract` truncates all tenant data in several of its scenarios and its
// last scenario leaves the database with NO tenant. `phase11e` then resolves
// `firstTenantId()` and gets null, failing on "expected null to be truthy". Measured
// directly: 0 tenants -> 1 failing test; re-seed -> 40/40 passing. They are mutually
// destructive even when serialised, so sharing a database cannot work. That is why DB-A is
// split into DB-A (seed bootstrap) and DB-A2 (phase11e).
//
// SETUP — each database needs a different starting state
//
//   DB-A  (seed-bootstrap-contract)  migrate only. The suite seeds and truncates itself.
//   DB-A2 (phase11e)                migrate AND `pnpm db:seed` — it asserts on seeded rows.
//   DB-B  (tenant-* suites)          migrate only; provisioning creates the tenant itself.
//
// Give every database the same grants the main one has (owner beaconhs_owner, public schema
// USAGE+CREATE to the owner, USAGE to app/super/backup, CONNECT+CREATE+TEMPORARY to the
// migrator). A fresh database created with default grants will fail at CREATE SCHEMA.
//
// The full recipe lives in docs/PRODUCTION_RUNBOOK.md. `pnpm test` does not set these
// variables, so the suites skip in the aggregate run; CI sets them and runs each project
// explicitly against its own isolated database.

import { defineConfig } from 'vitest/config'

/** Owner-capable identity: can migrate and TRUNCATE. */
const OWNER_SUITES = ['src/seed-bootstrap-contract.test.ts']

/** Needs a migrated + seeded database, and destroys nothing itself. */
const SEEDED_SUITES = ['src/phase11e-seed-integrity.test.ts']

/** Runtime + BYPASSRLS identity: provisions tenants and asserts RLS isolation. */
const RUNTIME_SUITES = ['src/tenant-provisioning.test.ts', 'src/tenant-reference-data.test.ts']

/**
 * Persistence suite for the storage write freeze. It uses the shared `db`
 * client (DATABASE_URL), so it is its own project: CI must give it a BYPASSRLS
 * identity on the runtime scratch database and prove DATABASE_URL names the
 * same database as the scratch gate.
 */
const FREEZE_SUITES = ['src/storage-freeze-operations.test.ts']

const ALL_LIVE = [...OWNER_SUITES, ...SEEDED_SUITES, ...RUNTIME_SUITES, ...FREEZE_SUITES]

export default defineConfig({
  test: {
    projects: [
      {
        // Pure unit tests. No database, so these stay fully parallel.
        test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: ALL_LIVE },
      },
      {
        // Credential class 1: owner-capable. Serialised because each scenario truncates.
        test: { name: 'db-owner', include: OWNER_SUITES, fileParallelism: false },
      },
      {
        // Credential class 2: runtime + BYPASSRLS. Serialised because each suite provisions
        // tenants and then deletes them all, so overlapping them means one file's teardown
        // removes another file's fixture mid-assertion.
        test: { name: 'db-runtime', include: RUNTIME_SUITES, fileParallelism: false },
      },
      {
        // Credential class 3: reads a pre-seeded database. Read-only against its fixtures.
        test: { name: 'db-seeded', include: SEEDED_SUITES },
      },
      {
        // Credential class 4: persistence against the runtime database, with a
        // BYPASSRLS identity because the suite writes across tenants directly.
        test: { name: 'db-freeze', include: FREEZE_SUITES, fileParallelism: false },
      },
    ],
  },
})
