// The first-administrator bootstrap: what it must refuse, and what it must never
// write.
//
// WHY THIS FILE EXISTS
//
// `db:migrate` creates no user and no tenant, and `server.ts` disables sign-up,
// so a greenfield production database has no path to a first login — while every
// existing signal (migrate exit 0, containers up, `/api/health/ready` 200) says
// the deployment is healthy. `bootstrap-admin.ts` closes that gap and nothing
// else. The properties worth pinning down are its REFUSALS, because a bootstrap
// command that can promote an arbitrary account or overwrite a password is worse
// than the lockout it fixes.
//
// WHAT IS ASSERTED — and the honest limit
//
// The argument parsing, email/password validation and password generation are
// pure functions and are asserted directly.
//
// The database scenarios run the REAL command as a subprocess against a
// throwaway database, because the properties that matter — a second run adds no
// user, changes no password, creates no tenant, and an `email_taken` address is
// not promoted — are only meaningful against a real `user`/`account` pair with
// Better Auth's scrypt hash in it. They are skipped, loudly, when this machine
// has no reachable Postgres; a skipped scenario is reported as skipped, never as
// passed.

import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { verifyPassword } from 'better-auth/crypto'
import {
  BOOTSTRAP_MIN_PASSWORD_LENGTH,
  assertBootstrapEmail,
  assertBootstrapName,
  assertBootstrapPassword,
  generateBootstrapPassword,
} from './bootstrap-admin'
import { parseArgs, normaliseArgs } from './bootstrap-admin.cli'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = resolve(PKG_DIR, 'src/bootstrap-admin.cli.ts')
const REPO_ROOT = resolve(PKG_DIR, '../..')

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe('bootstrap email validation', () => {
  it('normalises to the form Better Auth stores and looks up', () => {
    expect(assertBootstrapEmail('  Admin@BeaconHS.Local ')).toBe('admin@beaconhs.local')
  })

  it('accepts an ordinary address', () => {
    expect(assertBootstrapEmail('ops@example.co')).toBe('ops@example.co')
  })

  it.each([
    ['empty', ''],
    ['only whitespace', '   '],
    ['no @', 'admin.example.com'],
    ['no local part', '@example.com'],
    ['no domain', 'admin@'],
    ['two @', 'a@b@example.com'],
    ['embedded whitespace', 'ad min@example.com'],
  ])('rejects %s', (_label, value) => {
    expect(() => assertBootstrapEmail(value)).toThrow()
  })

  it('rejects an address beyond the forward-path length ceiling', () => {
    const long = `${'a'.repeat(250)}@example.com`
    expect(() => assertBootstrapEmail(long)).toThrow(/at most 254/)
  })
})

describe('bootstrap name validation', () => {
  it('defaults to the address local part', () => {
    expect(assertBootstrapName(undefined, 'ada@example.com')).toBe('ada')
  })

  it('keeps an explicit name', () => {
    expect(assertBootstrapName('  Ada Lovelace ', 'ada@example.com')).toBe('Ada Lovelace')
  })

  it('falls back to the local part when an explicit name is blank', () => {
    expect(assertBootstrapName('   ', 'ada@example.com')).toBe('ada')
  })
})

describe('bootstrap password validation', () => {
  it('accepts a password at the sign-in route own floor', () => {
    expect(assertBootstrapPassword('a'.repeat(BOOTSTRAP_MIN_PASSWORD_LENGTH))).toHaveLength(
      BOOTSTRAP_MIN_PASSWORD_LENGTH,
    )
  })

  it('refuses anything the sign-in route would reject', () => {
    // The floor must stay tied to Better Auth's `minPasswordLength`; a bootstrap
    // account that cannot sign in is the same lockout this command exists to end.
    expect(() => assertBootstrapPassword('short')).toThrow(/at least 8 characters/)
  })
})

describe('generated passwords', () => {
  it('uses only unambiguous characters', () => {
    // `I l1 O 0` are excluded so the value survives transcription from a terminal.
    expect(generateBootstrapPassword()).not.toMatch(/[Il1O0]/)
  })

  it('is long enough to satisfy the password policy unaided', () => {
    const password = generateBootstrapPassword()
    expect(password.length).toBeGreaterThanOrEqual(32)
    expect(() => assertBootstrapPassword(password)).not.toThrow()
  })

  it('does not repeat itself', () => {
    const values = new Set(Array.from({ length: 20 }, () => generateBootstrapPassword()))
    expect(values.size).toBe(20)
  })
})

describe('CLI argument handling', () => {
  it('drops the pnpm argument separator', () => {
    // `pnpm run script -- <args>` forwards a literal `--`, which is truthy and
    // would otherwise be opened as a file path.
    expect(normaliseArgs(['--', '--email', 'a@b.co'])).toEqual(['--email', 'a@b.co'])
  })

  it('reads the flag set', () => {
    expect(parseArgs(['--email', 'a@b.co', '--name', 'A', '--password-stdin', '--apply'])).toEqual({
      email: 'a@b.co',
      name: 'A',
      passwordStdin: true,
      resendMagicLink: false,
      apply: true,
    })
  })

  it('defaults to a dry run', () => {
    expect(parseArgs(['--email', 'a@b.co'])).toEqual({
      email: 'a@b.co',
      passwordStdin: false,
      resendMagicLink: false,
      apply: false,
    })
  })

  it('refuses an unrecognised flag instead of ignoring it', () => {
    expect(() => parseArgs(['--email', 'a@b.co', '--yes'])).toThrow(/unrecognised argument/)
  })

  it('requires an email', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/--email is required/)
  })
})

// ---------------------------------------------------------------------------
// Database scenarios — real command, real Better Auth scrypt hash
// ---------------------------------------------------------------------------

const SCRATCH_URL = process.env.SEED_TEST_SCRATCH_DATABASE_URL

type CliResult = { status: number; stdout: string; stderr: string }

/**
 * Resolve the `tsx` CLI through `@beaconhs/db`, where `tsx` is a real dependency
 * and where the repository's other operator commands run from. Resolving the
 * module (rather than `node_modules/.bin/tsx`) keeps this working under pnpm's
 * isolated layout, where the root `.bin` has no `tsx` symlink at all.
 */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli', {
  paths: [resolve(REPO_ROOT, 'packages/db')],
})

function runCli(
  args: string[],
  url: string,
  stdin?: string,
  extraEnv?: NodeJS.ProcessEnv,
): CliResult {
  // No `--env-file`: the command reads exactly one variable, and passing the whole
  // repository `.env` here would let a real DATABASE_URL win over the scratch one.
  const child = execFileSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    input: stdin ?? '',
    // Bounded so a wedged child (e.g. an unreachable Redis that never fails
    // fast) fails the test instead of hanging the suite.
    timeout: 120_000,
    env: {
      ...process.env,
      ...extraEnv,
      DATABASE_URL: url,
      // The runtime role is sufficient and is the least-privilege path the
      // command is designed for: `user` and `account` carry no RLS.
      SUPERADMIN_DATABASE_URL: url,
      MIGRATION_DATABASE_URL: url,
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'test-only-secret-that-is-long-enough-for-production',
    },
  })
  return { status: 0, stdout: child, stderr: '' }
}

/** Pull the one-time password back out of the command's stdout. */
function extractPrintedPassword(stdout: string): string {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.includes(' ') && l !== 'password' && !l.startsWith('-'))
  if (!line) throw new Error(`no password line found in output:\n${stdout}`)
  return line
}

function tryRunCli(
  args: string[],
  url: string,
  stdin?: string,
  extraEnv?: NodeJS.ProcessEnv,
): CliResult {
  try {
    return runCli(args, url, stdin, extraEnv)
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** Query a throwaway database through a short-lived pool. */
async function query<T>(url: string, text: string, values: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    const result = await pool.query(text, values)
    return result.rows as T[]
  } finally {
    await pool.end()
  }
}

/**
 * Remove every user and credential, leaving the migrated schema intact.
 *
 * `TRUNCATE` requires table ownership. The migrator login owns nothing itself; it
 * reaches the NOLOGIN owner by `SET ROLE`, which is exactly how `migrate.ts` does
 * it. The role name comes from the project's own `DATABASE_OWNER_ROLE` variable so
 * this introduces no new convention.
 *
 * The command under test still runs on the runtime URL — the least-privilege path
 * it is designed for.
 */
async function wipeIdentities(_runtimeUrl: string): Promise<void> {
  const ownerUrl = process.env.SEED_TEST_SCRATCH_OWNER_URL ?? _runtimeUrl
  const ownerRole = process.env.DATABASE_OWNER_ROLE ?? 'beaconhs_owner'
  await query(
    ownerUrl,
    `SET ROLE ${ownerRole}; TRUNCATE TABLE account, session, verification, "user" CASCADE;`,
  )
}

type Counts = {
  users: number
  super_admins: number
  credential_accounts: number
  tenants: number
}

async function counts(url: string): Promise<Counts> {
  const rows = await query<Counts>(
    url,
    `select
       (select count(*) from "user")::int as users,
       (select count(*) from "user" where "isSuperAdmin")::int as super_admins,
       (select count(*) from account where "providerId" = 'credential')::int as credential_accounts,
       (select count(*) from tenants)::int as tenants`,
  )
  const row = rows[0]
  if (!row) throw new Error('counts query returned no row')
  return row
}

type AdminRow = {
  id: string
  email: string
  name: string
  isSuperAdmin: boolean
  emailVerified: boolean
  accountId: string
  password: string
}

async function readAdmin(url: string, email: string): Promise<AdminRow | undefined> {
  const rows = await query<AdminRow>(
    url,
    `select u.id, u.email, u.name, u."isSuperAdmin", u."emailVerified", a."accountId", a."password"
       from "user" u join account a on a."userId" = u.id
      where u.email = $1`,
    [email],
  )
  return rows[0]
}

const describeDb = SCRATCH_URL ? describe : describe.skip

if (!SCRATCH_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[bootstrap-admin] SEED_TEST_SCRATCH_DATABASE_URL is not set — database scenarios are SKIPPED, not passed.',
  )
}

describeDb('the first-administrator bootstrap (live database)', () => {
  const url = SCRATCH_URL as string

  afterAll(async () => {
    await wipeIdentities(url)
  })

  let printedPassword = ''

  it('creates exactly one super-admin and no tenant', async () => {
    await wipeIdentities(url)

    // The identities are what this scenario controls, so those are asserted
    // absolutely. Tenants are NOT: the scratch database may already carry tenants
    // from other work, and a fixed `tenants: 0` precondition would make this fail
    // for a reason that has nothing to do with the bootstrap. The property that
    // matters — the bootstrap creates no tenant — is asserted relatively below.
    const before = await counts(url)
    expect(before.users).toBe(0)
    expect(before.super_admins).toBe(0)

    const result = runCli(['--email', 'bootstrap@example.com', '--apply'], url)
    expect(result.status).toBe(0)

    const after = await counts(url)
    expect(after.users).toBe(1)
    expect(after.super_admins).toBe(1)
    expect(after.credential_accounts).toBe(1)
    // The whole point: no tenant, no demo records.
    expect(after.tenants).toBe(before.tenants)

    expect(result.stdout).toContain('created super-admin bootstrap@example.com')
    printedPassword = extractPrintedPassword(result.stdout)
  }, 120_000)

  it('dispatches a magic-link verification token via Better Auth after creation', async () => {
    // Better Auth's `sendMagicLink` stores the verification with:
    // - identifier = base64url(sha256(plaintext_token))
    // - value = JSON.stringify({ email, name })
    // - expiresAt = now + expiresIn (default 300s for magic-link; overridden via
    //   plugin config; bootstrap-admin uses the default 5-minute window, but
    //   the test just confirms the row exists with a reasonable TTL).
    // The token id is also base64url(sha256(plaintext_token)) — the same as
    // identifier, because Better Auth's `storeToken` returns the hash which
    // becomes the row id.
    const tokenRows = await query<{
      id: string
      identifier: string
      value: string
      expiresAt: Date
    }>(
      url,
      `select id, identifier, value, "expiresAt" from verification
         where identifier != 'magic-link'
         and value like '%bootstrap@example.com%'
         order by "createdAt" desc limit 1`,
    )
    expect(tokenRows.length).toBe(1)
    const token = tokenRows[0]
    if (!token) throw new Error('verification token not found')
    // Identifier is a base64url hash (not the literal string 'magic-link').
    expect(token.identifier.length).toBeGreaterThan(20)
    expect(token.identifier).toMatch(/^[A-Za-z0-9_-]+$/)
    // Value must contain the admin's email (Better Auth stores JSON).
    expect(token.value).toContain('bootstrap@example.com')
    // Expiry must be within 15 minutes of when the admin was created.
    const now = new Date()
    const ttlMs = token.expiresAt.getTime() - now.getTime()
    expect(ttlMs).toBeLessThan(15 * 60 * 1000 + 5_000) // allow 5s clock drift
    expect(ttlMs).toBeGreaterThan(-5_000) // token already expired
  }, 120_000)

  it('produces a credential account Better Auth can actually verify', async () => {
    // The strongest available assertion: the password printed once on the
    // command's stdout is the password that authenticates, verified with the
    // same `better-auth/crypto` verifier `server.ts` installs. A format
    // regression, or a mismatch with `verifyLegacyOrCurrentPassword`'s dispatch,
    // fails here rather than at the operator's first sign-in.
    const row = await readAdmin(url, 'bootstrap@example.com')
    if (!row) throw new Error('the bootstrapped administrator was not found')
    expect(row.isSuperAdmin).toBe(true)
    expect(row.emailVerified).toBe(false)
    // Better Auth sets `accountId` to the user id for credential accounts.
    expect(row.accountId).toBe(row.id)
    // scrypt output carries no `$`, so the legacy verifier never mistakes it for bcrypt.
    expect(row.password.startsWith('$')).toBe(false)

    expect(await verifyPassword({ hash: row.password, password: printedPassword })).toBe(true)
    expect(await verifyPassword({ hash: row.password, password: `${printedPassword}x` })).toBe(
      false,
    )
  }, 60_000)

  it('is idempotent: a second run adds no user, overwrites no password, creates no tenant', async () => {
    const before = await readAdmin(url, 'bootstrap@example.com')
    if (!before) throw new Error('the bootstrapped administrator was not found')
    const beforeCounts = await counts(url)

    const result = runCli(['--email', 'someone-else@example.com', '--apply'], url)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already bootstrapped')

    const after = await readAdmin(url, 'bootstrap@example.com')
    if (!after) throw new Error('the bootstrapped administrator disappeared')
    expect(after.password).toBe(before.password)
    expect(after.id).toBe(before.id)
    expect(await counts(url)).toEqual(beforeCounts)
    // The refused address must not have become a user.
    expect(await readAdmin(url, 'someone-else@example.com')).toBeUndefined()
  }, 120_000)

  it('refuses an address that is already a user instead of promoting it', async () => {
    // Wipe first, and deliberately: with no super-admin present the
    // `already_bootstrapped` guard cannot fire, so this exercises the
    // `email_taken` guard on its own. Leaving the administrator from the previous
    // scenario in place would mask it, and the scenario would pass without ever
    // testing the refusal it exists to pin down.
    await wipeIdentities(url)

    // Seed a non-admin user, then ask for a bootstrap with its address. If this
    // ever "succeeded" it would be a privilege escalation of an arbitrary account.
    const existingId = randomUUID()
    await query(
      url,
      `insert into "user" (id, email, "emailVerified", name, "isSuperAdmin")
         values ($1, $2, true, 'Existing Person', false)`,
      [existingId, 'existing@example.com'],
    )

    const result = tryRunCli(['--email', 'existing@example.com', '--apply'], url)
    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain('already a user account')

    // No credential account was added for it.
    expect(await readAdmin(url, 'existing@example.com')).toBeUndefined()
    const check = await query<{ isSuperAdmin: boolean }>(
      url,
      `select "isSuperAdmin" from "user" where id = $1`,
      [existingId],
    )
    expect(check[0]?.isSuperAdmin).toBe(false)
  }, 120_000)

  it('writes nothing without --apply', async () => {
    await wipeIdentities(url)
    const before = await counts(url)

    const result = runCli(['--email', 'dry@example.com'], url)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DRY RUN')

    expect(await counts(url)).toEqual(before)
    expect(await readAdmin(url, 'dry@example.com')).toBeUndefined()

    // Leave a usable admin behind for any later scenario.
    runCli(['--email', 'bootstrap@example.com', '--apply'], url)
  }, 120_000)

  it('accepts an operator-chosen password from stdin', async () => {
    await wipeIdentities(url)
    const chosen = 'Chosen-By-The-Operator-42'
    const result = runCli(
      ['--email', 'chosen@example.com', '--password-stdin', '--apply'],
      url,
      `${chosen}\n`,
    )
    expect(result.status).toBe(0)
    // A supplied password is never echoed.
    expect(result.stdout).not.toContain(chosen)

    const row = await readAdmin(url, 'chosen@example.com')
    if (!row) throw new Error('the chosen-password administrator was not found')
    expect(await verifyPassword({ hash: row.password, password: chosen })).toBe(true)
  }, 120_000)

  it('exits non-zero when the admin is created but verification mail cannot go out', async () => {
    await wipeIdentities(url)
    // Point the mail queue at a closed port: enqueue fails fast (bounded
    // producer retries), while the administrator row must still be written.
    const result = tryRunCli(['--email', 'maildown@example.com', '--apply'], url, undefined, {
      REDIS_URL: 'redis://127.0.0.1:9',
    })
    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain('could not be queued')
    expect(`${result.stdout}${result.stderr}`).toContain('--resend-magic-link')

    // The account exists and is still unverified: recoverable via resend, and
    // the failure did not roll back the creation.
    const row = await readAdmin(url, 'maildown@example.com')
    if (!row) throw new Error('the administrator was rolled back on email failure')
    expect(row.isSuperAdmin).toBe(true)
    expect(row.emailVerified).toBe(false)
  }, 120_000)
})
