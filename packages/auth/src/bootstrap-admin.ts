// Operator-attended first-administrator bootstrap.
//
// WHY THIS FILE EXISTS
//
// `pnpm db:migrate` creates no user and no tenant — it applies schema, RLS,
// grants, statistics and reporting views, and converges permissions on roles that
// already exist. `packages/auth/src/server.ts` sets
// `emailAndPassword.disableSignUp = true` and `magicLink({ disableSignUp: true })`,
// and there is no public registration route. Accounts are only ever created by an
// already-authenticated tenant or platform admin.
//
// So on a greenfield production database the sequence terminates: 0 users, 0
// tenants, 0 logins. And the failure is silent at every level an operator would
// naturally check — migrate exits 0, every container starts, and
// `/api/health/ready` returns 200 because readiness validates the signing secret,
// the database and Redis, none of which depend on a user existing. The first
// symptom is a human being unable to log in, with no in-product recovery path.
//
// `pnpm db:seed` does create a super-admin, but it also creates a demo tenant
// ("Acme Industrial") with demo people, incidents, corrective actions,
// inspections, equipment, PPE, documents, courses and form templates. Running the
// demo seed on a production database is the wrong remedy for a production
// problem, so this command exists instead: it writes the first administrator and
// nothing else.
//
// WHAT IT WRITES
//
// Exactly the two rows Better Auth's own `sign-up-email` route writes for one
// account — see `better-auth/dist/api/routes/sign-up.mjs`, which calls
// `internalAdapter.linkAccount({ userId, providerId: "credential",
// accountId: createdUser.id, password: hash })`. `accountId` mirrors `userId`
// for credential accounts, and the hash comes from Better Auth's own scrypt
// hasher via `better-auth/crypto`, which is the same hash
// `legacy-password.ts` → `verifyLegacyOrCurrentPassword` already verifies (it
// dispatches on the stored hash's own format, and scrypt output carries no `$`
// prefix, so it is never mistaken for legacy bcrypt).
//
// Nothing here changes Better Auth's configuration. `disableSignUp` stays true,
// no route is added, no permission key is added, no role or scope is created, and
// no table, column or migration is touched. The account is an ordinary user row
// carrying the `isSuperAdmin` flag that `seed.ts` and `/platform/users` already
// use.
//
// WHAT IT DOES NOT DO
//
// It creates no tenant, no role, no org unit, no PPE or inspection type, no form
// template and no demo record. After it succeeds the database still has zero
// tenants, which is correct: the operator signs in and creates the real tenant
// through `/platform/tenants/new`.
//
// IDEMPOTENCY — BY REFUSAL
//
// The command is idempotent because it declines to act rather than because it
// upserts. If any super-admin already exists it writes nothing and reports that
// the database is already bootstrapped. It can therefore never create a second
// administrator, never overwrite an existing password, never promote an existing
// non-admin account, never modify a tenant and never delete a row.
//
// The email-taken case is deliberately NOT treated as "promote this account".
// Promoting whatever account happens to own the requested address would turn an
// operator typo into a privilege escalation of an arbitrary user, so an existing
// address is reported and refused.
//
// Least privilege: `user` and `account` are Better Auth's global tables and carry
// no RLS, so this runs on the ordinary runtime `DATABASE_URL` role. The migration
// and cross-tenant credentials are not required and are not used.

import { randomBytes, randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { db } from '@beaconhs/db'
import { account, users } from '@beaconhs/db/schema'
import { enqueueEmail } from '@beaconhs/jobs'
import { getAuth } from './server'

/**
 * Better Auth's own floor (`emailAndPassword.minPasswordLength` in `server.ts`).
 * A generated password is far longer; this only bounds the `--password-stdin`
 * path so the command can never create an account the sign-in route would reject.
 */
export const BOOTSTRAP_MIN_PASSWORD_LENGTH = 8

/** RFC 5321's practical maximum length for a forward path. */
const MAX_EMAIL_LENGTH = 254

const MAX_NAME_LENGTH = 120

/**
 * Alphabet for a generated password: digits plus unambiguous upper/lowercase
 * letters, excluding `I l1 O 0` so the value can be transcribed from a terminal
 * without ambiguity. 58 characters per draw.
 */
const GENERATED_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

const GENERATED_PASSWORD_LENGTH = 32

export type BootstrapAdminInput = {
  email: string
  /** Display name. Defaults to the email's local part. */
  name?: string
  /**
   * A plaintext password to hash. When omitted a random one is generated and
   * returned once for the operator to record. Never persisted anywhere except
   * the scrypt hash in `account.password`.
   */
  password?: string
}

export type BootstrapAdminResult =
  | {
      outcome: 'created'
      userId: string
      email: string
      name: string
      /** Present only when this call generated the password. Shown once. */
      generatedPassword?: string
      /** Present when a platform email provider is configured. */
      magicLink?: { sent: true } | { sent: false; reason: string }
    }
  | { outcome: 'already_bootstrapped'; existing: Array<{ email: string }> }
  | { outcome: 'email_taken'; email: string }

/** Normalise an address the way Better Auth stores and looks one up. */
function normaliseBootstrapEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Validate an address before any database work.
 *
 * Deliberately a shape check, not an attempt to out-law the RFC: the single `@`,
 * a non-empty local part and domain, no whitespace, and the length ceiling are
 * what `user_email_ux` and Better Auth's own normalisation actually depend on.
 */
export function assertBootstrapEmail(raw: string): string {
  const email = normaliseBootstrapEmail(raw)
  if (!email) throw new Error('An administrator email address is required.')
  if (email.length > MAX_EMAIL_LENGTH) {
    throw new Error(`Email address must be at most ${MAX_EMAIL_LENGTH} characters.`)
  }
  if (/\s/.test(email)) {
    throw new Error('Email address must not contain whitespace.')
  }
  const at = email.indexOf('@')
  if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1) {
    throw new Error('Email address must contain exactly one "@" with text on both sides.')
  }
  return email
}

/** Validate a display name, defaulting to the address's local part. */
export function assertBootstrapName(raw: string | undefined, email: string): string {
  const name = (raw ?? '').trim() || email.slice(0, email.indexOf('@'))
  if (!name) throw new Error('A display name is required.')
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Display name must be at most ${MAX_NAME_LENGTH} characters.`)
  }
  return name
}

/** Reject a password the sign-in route's own policy would refuse. */
export function assertBootstrapPassword(password: string): string {
  if (typeof password !== 'string' || password.length < BOOTSTRAP_MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${BOOTSTRAP_MIN_PASSWORD_LENGTH} characters.`)
  }
  return password
}

/**
 * A cryptographically random password, drawn with rejection sampling so every
 * character of the alphabet is equally likely.
 */
export function generateBootstrapPassword(): string {
  let out = ''
  while (out.length < GENERATED_PASSWORD_LENGTH) {
    const bytes = randomBytes(GENERATED_PASSWORD_LENGTH * 2)
    for (const byte of bytes) {
      // 256 % 58 leaves 8 surplus values; reject them rather than bias the draw.
      if (byte >= 256 - (256 % GENERATED_PASSWORD_ALPHABET.length)) continue
      out += GENERATED_PASSWORD_ALPHABET[byte % GENERATED_PASSWORD_ALPHABET.length]
      if (out.length === GENERATED_PASSWORD_LENGTH) break
    }
  }
  return out
}

/**
 * Create the first platform administrator, or decline.
 *
 * The writes happen in ONE transaction behind a transaction-scoped advisory
 * lock, so two concurrent invocations serialize: the loser observes the
 * winner's committed super-admin and is declined. (There is deliberately no
 * unique index on `isSuperAdmin`; the lock is what makes the check atomic.)
 */
export async function bootstrapFirstAdmin(
  input: BootstrapAdminInput,
): Promise<BootstrapAdminResult> {
  const email = assertBootstrapEmail(input.email)
  const name = assertBootstrapName(input.name, email)
  const generated = input.password ? undefined : generateBootstrapPassword()
  const password = assertBootstrapPassword(input.password ?? (generated as string))

  // Hash before opening the transaction: scrypt is deliberately slow and must not
  // hold a transaction open.
  const passwordHash = await hashPassword(password)

  const userId = randomUUID()

  const result = await db.transaction(async (tx) => {
    // Serialize first-admin creation across processes. Without this, two
    // concurrent transactions in READ COMMITTED can both observe zero
    // super-admins and both insert. The lock is released with the transaction.
    await tx.execute(sql`select pg_advisory_xact_lock(727272727)`)
    const existingAdmins = (await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.isSuperAdmin, true))
      .orderBy(users.createdAt)) as unknown as Array<{ email: string }>

    if (existingAdmins.length > 0) {
      return {
        outcome: 'already_bootstrapped' as const,
        existing: existingAdmins.map((row) => ({ email: row.email })),
      }
    }

    const clash = (await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)) as unknown as Array<{ id: string }>

    if (clash.length > 0) {
      return { outcome: 'email_taken' as const, email }
    }

    // A second, database-level guard. If a concurrent transaction committed a
    // super-admin between this statement's snapshot and our insert, this raises
    // rather than creating a second administrator.
    await tx.execute(sql`
      do $$
      begin
        if exists (select 1 from "user" where "isSuperAdmin") then
          raise exception 'a super-admin already exists';
        end if;
      end $$;
    `)

    await tx.insert(users).values({
      id: userId,
      email,
      name,
      // Operator-attended creation, so the address is reachable by whoever ran
      // the command. The operator still verifies the address by clicking the
      // magic-link sent immediately after this block; verification flips
      // emailVerified to true and creates the session.
      emailVerified: false,
      isSuperAdmin: true,
    })

    await tx.insert(account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: 'credential',
      password: passwordHash,
    })

    return {
      outcome: 'created' as const,
      userId,
      email,
      name,
      ...(generated ? { generatedPassword: generated } : {}),
    }
  })

  // After a successful creation, dispatch the magic-link verification email.
  // This is outside the transaction so the admin persists even if dispatch fails.
  if (result.outcome === 'created') {
    const dispatch = await dispatchMagicLink({ email, userId })
    if (dispatch.sent) {
      return { ...result, magicLink: { sent: true } }
    }
    return { ...result, magicLink: { sent: false, reason: dispatch.reason } }
  }

  return result
}

/**
 * A count that is safe to render next to a bootstrap report: how many
 * administrators now exist. The dry run uses it to tell the operator, before
 * anything is written, whether a real run would even do anything.
 */
export async function countSuperAdmins(): Promise<number> {
  const rows = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.isSuperAdmin, true))) as unknown as Array<{ count: number }>
  return rows[0]?.count ?? 0
}

// ---------------------------------------------------------------------------
// Magic-link dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a magic-link verification email for a given user.
 *
 * Delegates to Better Auth's native `sendMagicLink` mechanism (token generation,
 * hashing, verification storage, and email dispatch via the `sendMagicLink`
 * callback configured in server.ts). This guarantees full compatibility with the
 * Better Auth verify endpoint — no custom token protocol.
 *
 * Returns success even when no provider is available, because the admin was
 * still created and the operator can retry after configuring email.
 */
export async function dispatchMagicLink({
  email,
  userId,
}: {
  email: string
  userId: string
  _baseUrl?: string // kept for backward compat; not used
}): Promise<{ sent: true } | { sent: false; reason: string }> {
  try {
    await getAuth().api.signInMagicLink({
      body: {
        email,
        name: '', // name already set on user creation; Better Auth passes it through
        callbackURL: '/',
        metadata: { userId },
      },
      headers: {},
    })
    return { sent: true }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'magic-link dispatch failed'
    return { sent: false, reason }
  }
}
