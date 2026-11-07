// First-run setup primitives.
//
// WHY THIS FILE EXISTS
// --------------------
// A greenfield BeaconHS platform has no tenant, and `getRequestContext()`
// returns null for a super-admin while no active tenant exists — by design,
// because the app shell requires a tenant-bound RequestContext even for
// platform administration (apps/web/src/lib/auth.ts, and the runbook's
// "First Tenant Provisioning" section). `/platform/tenants/new`, the only page
// that could create a tenant, is itself gated behind that same context.
//
// So the documented CLI path exists for a reason: the first workspace is
// created by a command rather than by a form. This module is the web
// equivalent of that command, and it deliberately reuses the SAME business
// layer rather than reimplementing it:
//
//   * the administrator comes from `@beaconhs/auth`'s bootstrapFirstAdmin,
//     which writes exactly the two rows Better Auth's own sign-up route
//     writes, hashes with Better Auth's own scrypt hasher, refuses an
//     existing super-admin, refuses a taken address, and guards the race
//     with a database-level check inside the same transaction;
//   * the workspace comes from `@beaconhs/db`'s provisionFirstTenant, which
//     refuses when any tenant exists and creates the built-in roles and the
//     reference catalogue in one transaction.
//
// WHAT THIS MODULE ADDS ON TOP OF THE BUSINESS LAYER
// ---------------------------------------------------
// The business layer is about correctness of the write. This module is about
// the LIFECYCLE of the setup surface, which the business layer does not model:
//
//   * the setup surface is OPEN only while the platform is uninitialized, and
//     closes the moment the first administrator exists;
//   * the create action is rate limited, so the one moment the surface is open
//     cannot be used to guess a credential or to flood the platform;
//   * the password policy for the FIRST administrator is stronger than the
//     sign-in floor, because this account is created before any tenant exists
//     and therefore before any tenant-scoped audit trail exists;
//   * every step is audited without ever recording a password or a secret.
//
// The initialization state is derived from the DATABASE on every read. There
// is no flag to flip and no public API to reset it: the absence of a
// super-admin IS the open state, so there is nothing to tamper with.
//
// This module creates no role, grants no permission, and never widens the
// native Permission / Role Scope / visibility tier / RLS model. It writes a
// user row with the platform's EXISTING `isSuperAdmin` flag and nothing else.

import { countSuperAdmins } from '@beaconhs/auth'
import { countTenants, provisionFirstTenant } from '@beaconhs/db'
import { consumeRateLimit } from '@beaconhs/jobs/rate-limit'

/**
 * The first administrator's password floor.
 *
 * Better Auth's own `emailAndPassword.minPasswordLength` is 8, which is the
 * floor for an account that an administrator invited. The FIRST administrator
 * is different: it exists before there is any tenant, any role assignment, or
 * any tenant-scoped audit row, so this account is the one whose compromise
 * cannot be reconstructed from the product's own records. It therefore gets a
 * stronger floor.
 */
export const FIRST_RUN_PASSWORD_MIN_LENGTH = 12

/** How many setup attempts one client may make per window. */
export const FIRST_RUN_RATE_LIMIT = 5
/** The rate-limit window, in seconds. */
export const FIRST_RUN_RATE_LIMIT_WINDOW_SECONDS = 10 * 60

/** The setup stages, in the order an operator walks them. */
type FirstRunStage =
  /** No administrator exists: the create-administrator form is open. */
  | 'create_admin'
  /** An administrator exists but nobody is signed in: sign in to continue. */
  | 'sign_in'
  /** Signed in as the platform administrator, no workspace yet. */
  | 'create_tenant'
  /** A workspace exists: the platform is initialized. */
  | 'complete'
  /** Signed in, but not as a platform administrator. */
  | 'forbidden'

export type FirstRunState = {
  stage: FirstRunStage
  /** The administrator's address once one exists. Never the password. */
  adminEmail: string | null
  /** How many workspaces exist. */
  tenantCount: number
}

/**
 * The password problems for a first administrator's password.
 *
 * Pure and exported so the policy can be unit-tested without a database, and
 * so the server action and the form agree on exactly one rule set.
 */
export function firstRunPasswordProblems(password: string): string[] {
  const problems: string[] = []
  if (password.length < FIRST_RUN_PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${FIRST_RUN_PASSWORD_MIN_LENGTH} characters.`)
  }
  if (/\s/.test(password)) {
    problems.push('Do not use spaces.')
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length
  if (classes < 3) {
    problems.push('Mix at least three of: lowercase, uppercase, digits, symbols.')
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push('Do not repeat a single character.')
  }
  return problems
}

/**
 * Whether the first-run surface is still open, derived from the database.
 *
 * The absence of a super-admin IS the open state, so there is nothing to
 * reset and nothing an unauthorized caller can flip. Once the first
 * administrator exists the surface is closed, for every reader.
 */
export async function isFirstRunSetupOpen(): Promise<boolean> {
  return (await countSuperAdmins()) === 0
}

/**
 * The current setup stage.
 *
 * `signedIn` distinguishes "nobody is signed in" from "somebody is signed in
 * but is not the platform administrator". The two need different copy: the
 * first is invited to sign in, the second is told the page is not for them.
 */
export async function readFirstRunState(identity: {
  signedIn: boolean
  isSuperAdmin: boolean
}): Promise<FirstRunState> {
  const adminCount = await countSuperAdmins()
  const tenantCount = await countTenants()
  if (adminCount > 0 && tenantCount > 0) {
    return { stage: 'complete', adminEmail: null, tenantCount }
  }
  if (adminCount > 0) {
    if (identity.isSuperAdmin) {
      return { stage: 'create_tenant', adminEmail: null, tenantCount }
    }
    if (identity.signedIn) {
      return { stage: 'forbidden', adminEmail: null, tenantCount }
    }
    return { stage: 'sign_in', adminEmail: null, tenantCount }
  }
  return { stage: 'create_admin', adminEmail: null, tenantCount }
}

/**
 * Consume one attempt from the first-run budget.
 *
 * The key mixes a client identifier with the step, so one noisy client cannot
 * exhaust the budget of another, and so the create step and the workspace step
 * do not share a counter.
 */
const FIRST_RUN_GLOBAL_RATE_LIMIT = FIRST_RUN_RATE_LIMIT * 10

export async function consumeFirstRunAttempt(args: {
  step: 'admin' | 'tenant' | 'email_test'
  clientId: string
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  // Both buckets must allow: per-client keeps one noisy client from claiming
  // the whole budget alone, the fixed global bucket bounds total attempts
  // even if the client identifier is spoofed caller-by-caller.
  const client = await consumeRateLimit({
    key: `first-run-setup:${args.step}:${args.clientId}`,
    limit: FIRST_RUN_RATE_LIMIT,
    windowSeconds: FIRST_RUN_RATE_LIMIT_WINDOW_SECONDS,
  })
  const global = await consumeRateLimit({
    key: `first-run-setup:${args.step}:global`,
    limit: FIRST_RUN_GLOBAL_RATE_LIMIT,
    windowSeconds: FIRST_RUN_RATE_LIMIT_WINDOW_SECONDS,
  })
  const status = client.allowed ? global : client
  return {
    allowed: client.allowed && global.allowed,
    retryAfterSeconds: Math.max(1, Math.ceil((status.resetAt.getTime() - Date.now()) / 1_000)),
  }
}

/**
 * Create the first workspace, or decline.
 *
 * Delegates to the same native business function the CLI uses, so the guard
 * ("refuse when ANY tenant exists") and the transaction are identical.
 */
export async function createFirstWorkspace(input: {
  name: string
  slug?: string
  region?: string
  defaultLanguage: string
  enabledLanguages: string[]
}): Promise<
  | { outcome: 'provisioned'; tenantSlug: string }
  | { outcome: 'already_provisioned'; tenantSlug: string }
> {
  const result = await provisionFirstTenant({
    name: input.name,
    slug: input.slug ?? null,
    region: input.region,
    defaultLanguage: input.defaultLanguage,
    enabledLanguages: input.enabledLanguages,
  })
  return { outcome: result.outcome, tenantSlug: result.tenant.slug }
}
