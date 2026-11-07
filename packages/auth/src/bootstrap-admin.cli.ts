// CLI wrapper: create the first platform administrator on a database that has
// none.
//
//   pnpm --filter @beaconhs/auth bootstrap:admin -- --email admin@company.com --apply
//   pnpm --filter @beaconhs/auth bootstrap:admin -- --email admin@company.com \
//     --name "Ada Lovelace" --password-stdin --apply < secret.txt
//
// This is the operator-attended step a greenfield production deployment needs
// after `pnpm db:migrate`. See `bootstrap-admin.ts` for why it exists and for
// what it deliberately does not create.
//
// DRY RUN BY DEFAULT. Without `--apply` nothing is written, which is the same
// convention `db/src/scripts/import-legacy-passwords.ts` uses: the command reports
// exactly what it would do, so the address can be checked before an administrator
// exists. The generated password is printed in both modes, because it is the
// operator's only chance to record it — a scrypt hash cannot be reversed.
//
// IDEMPOTENT BY REFUSAL. A database that already has a super-admin is reported
// as already bootstrapped and nothing is written, so a re-run after a deploy can
// never create a second administrator or overwrite a password.
//
// No migration and no Better Auth change is involved: the rows written are the
// ones Better Auth's own sign-up route writes, hashed with Better Auth's own
// scrypt hasher, and `disableSignUp` remains true.

import { createInterface } from 'node:readline'
import { bootstrapFirstAdmin, countSuperAdmins, dispatchMagicLink } from './bootstrap-admin'
import { eq } from 'drizzle-orm'
import { closeDatabaseConnections, db, withSuperAdmin } from '@beaconhs/db'
import { closeJobConnections } from '@beaconhs/jobs'
import { users } from '@beaconhs/db/schema'

const USAGE = `usage: bootstrap:admin --email <address> [--name <name>] [--password-stdin] [--resend-magic-link] [--apply]

  --email <address>       administrator login (required)
  --name <name>           display name; defaults to the address's local part
  --password-stdin        read the password from stdin instead of generating one,
                          so it never reaches argv or a shell history
  --resend-magic-link     skip admin creation; re-enqueue the magic-link email
                          for an already-bootstrapped administrator
  --apply                 write; without it this is a dry run`

/**
 * Drop argument separators before interpreting argv.
 *
 * `pnpm run script -- <args>` forwards a literal `--`, and every task runner
 * documents that form. Without this, argv[0] is `--`, which is truthy, so the
 * usage guard is skipped and `--` is opened as a file — a raw ENOENT stack trace
 * instead of the usage line.
 */
export function normaliseArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== '--')
}

/** Parse the flag set. Throws with a usage-shaped message on anything unknown. */
export function parseArgs(argv: readonly string[]): {
  email?: string
  name?: string
  passwordStdin: boolean
  resendMagicLink: boolean
  apply: boolean
} {
  const args = normaliseArgs(argv)
  const out: {
    email?: string
    name?: string
    passwordStdin: boolean
    resendMagicLink: boolean
    apply: boolean
  } = {
    passwordStdin: false,
    resendMagicLink: false,
    apply: false,
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    switch (arg) {
      case '--email':
        out.email = args[i + 1]
        i += 1
        break
      case '--name':
        out.name = args[i + 1]
        i += 1
        break
      case '--password-stdin':
        out.passwordStdin = true
        break
      case '--resend-magic-link':
        out.resendMagicLink = true
        break
      case '--apply':
        out.apply = true
        break
      default:
        throw new Error(`unrecognised argument: ${arg}\n${USAGE}`)
    }
  }
  if (out.email === undefined) throw new Error(`--email is required\n${USAGE}`)
  return out
}

/** Read a single line from stdin, so a piped secret never lands in argv. */
async function readPasswordFromStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false })
  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (trimmed) return trimmed
    }
  } finally {
    rl.close()
  }
  throw new Error('--password-stdin was given but stdin supplied no password.')
}

export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  const email = args.email as string

  // ---------------------------------------------------------------------------
  // Resend magic-link path
  // ---------------------------------------------------------------------------

  if (args.resendMagicLink) {
    if (!args.apply) {
      console.error('--resend-magic-link requires --apply')
      return 2
    }

    const admin = await withSuperAdmin(db, async (tx) => {
      const [row] = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          isSuperAdmin: users.isSuperAdmin,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      return row as { id: string; email: string; name: string; isSuperAdmin: boolean } | null
    })

    if (!admin) {
      console.error(`${email} is not a registered administrator. Nothing was sent.`)
      return 1
    }

    if (!admin.isSuperAdmin) {
      console.error(`${email} is not a super-administrator. Nothing was sent.`)
      return 1
    }

    const dispatch = await dispatchMagicLink({ email: admin.email, userId: admin.id })

    if (dispatch.sent) {
      console.log(`magic-link re-enqueued for ${admin.email}`)
      return 0
    }

    console.error(`magic-link enqueue failed: ${dispatch.reason}`)
    return 1
  }

  // ---------------------------------------------------------------------------
  // Normal create path
  // ---------------------------------------------------------------------------

  console.log(`administrator email: ${email}`)
  if (!args.apply) {
    const admins = await countSuperAdmins()
    console.log(`existing super-admins: ${admins}`)
    console.log(
      admins > 0
        ? '\nDRY RUN — this database already has a super-admin, so a real run would write nothing.'
        : '\nDRY RUN — pass --apply to create this administrator.',
    )
    return 0
  }

  const password = args.passwordStdin ? await readPasswordFromStdin() : undefined
  const result = await bootstrapFirstAdmin({
    email,
    ...(args.name ? { name: args.name } : {}),
    ...(password ? { password } : {}),
  })

  if (result.outcome === 'already_bootstrapped') {
    console.log(
      `\nalready bootstrapped — ${result.existing.length} super-admin(s) exist, nothing written:`,
    )
    for (const row of result.existing) console.log(`    ${row.email}`)
    return 0
  }

  if (result.outcome === 'email_taken') {
    console.error(
      `\n${result.email} is already a user account. Nothing was written and no privileges were ` +
        'changed. Use a different address, or sign in as that account and grant it from /platform/users.',
    )
    return 1
  }

  console.log(`\ncreated super-admin ${result.email} (${result.userId})`)
  if (result.generatedPassword) {
    console.log('\n  password (shown once, store it now):')
    console.log(`    ${result.generatedPassword}`)
    console.log('\n  This is the only time it is displayed. Change it after the first sign-in.')
  }
  let emailFailed = false
  if (result.magicLink) {
    if (result.magicLink.sent) {
      console.log(
        '\n  magic-link email sent — check the inbox and click the link to verify your address.',
      )
    } else {
      emailFailed = true
      console.error(
        `\n  magic-link email could not be queued: ${result.magicLink.reason}\n` +
          '  The administrator account was created but cannot verify until email is fixed.\n' +
          '  Fix the provider, restart the worker, then run:\n' +
          `    bootstrap:admin --email ${result.email} --resend-magic-link --apply`,
      )
    }
  }
  console.log(
    '\nNo tenant was created. Sign in, create the real tenant under /platform/tenants, ' +
      'then invite its administrator.',
  )
  // The account exists, but automation must be able to tell that verification
  // mail did not go out: exit non-zero so a half-verified bootstrap is loud.
  return emailFailed ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    async (code) => {
      // Release pool and queue handles so the process exits promptly instead
      // of lingering on idle connections after the work is done.
      await closeDatabaseConnections()
      await closeJobConnections().catch(() => {})
      process.exitCode = code
    },
    async (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      await closeDatabaseConnections()
      await closeJobConnections().catch(() => {})
      process.exitCode = 1
    },
  )
}
