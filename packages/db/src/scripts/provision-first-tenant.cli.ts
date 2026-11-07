// CLI wrapper: provision the FIRST tenant of a greenfield BeaconHS platform.
//
//   pnpm --filter @beaconhs/db provision:first-tenant -- --name "Northwind Construction"
//   pnpm --filter @beaconhs/db provision:first-tenant -- \
//     --name "Northwind Construction" --slug northwind --region ca-central-1 --apply
//
// WHY THIS EXISTS
//
// `pnpm db:migrate` creates no tenant. `bootstrap:admin` creates no tenant. And the
// page that would create one — `/platform/tenants/new` — is gated behind
// `requireRequestContext()`, which returns `null` for a super-admin while the platform
// has no active tenant (`apps/web/src/lib/auth.ts`: "We must NOT return null while
// tenants exist: the app shell requires a tenant-bound RequestContext even for platform
// administration"). So on a freshly migrated database the platform could not create
// its own first workspace, and every authenticated route redirected to
// `/auth/continue`.
//
// This command writes that first tenant directly. It calls the SAME
// `provisionFirstTenant` primitive the UI path is built on — see
// `../tenant-provisioning.ts` — so there is one implementation of "create a tenant",
// not two that can drift.
//
// WHAT IT CREATES — and what it does not
//
// One `tenants` row, one day-one `audit_log` entry in that new tenant's own log, and
// the one form template the product designates as required on day one. That is
// exactly what `/platform/tenants/new` creates. It does NOT seed demo data, and it
// does NOT provision roles, org units, people, PPE types, inspection types or reports.
// A tenant created here has `roles = 0` and `org_units = 0`, precisely like one
// created through the UI. Populating a new tenant's business configuration is
// deliberate operator work, not part of creating the workspace.
//
// NO DEMO TENANT
//
// It never invents a name. `--name` is required. There is no default company, no
// "Acme", no sample records.
//
// IDEMPOTENT BY REFUSAL
//
// If the platform already has ANY tenant — active or not — this writes nothing and
// exits 0. It will not create a second tenant, will not overwrite the first, and will
// not touch any credential. Tenants 2..N are created through
// `/platform/tenants/new` once a workspace exists and the super-admin can reach it.
//
// DRY RUN BY DEFAULT
//
// Without `--apply` nothing is written, matching `bootstrap:admin` and
// `db/src/scripts/import-legacy-passwords.ts`.
//
// CREDENTIALS
//
// `SUPERADMIN_DATABASE_URL` is required, and this is inherited from the existing
// provisioning primitive rather than chosen here: `audit_log` is a FORCE-RLS
// tenant-scoped table, and the tenant the day-one audit row must reference has just
// been created, so the runtime role has no possible RLS scope for it. The migration
// credential is NOT required.

import { LOCALE_OPTIONS, normalizeLocalePolicy, type AppLocale } from '@beaconhs/i18n'
import { countTenants, hasSuperAdmin, provisionFirstTenant } from '../tenant-provisioning'

const USAGE = `usage: provision:first-tenant --name <company> [--slug <slug>] [--region <region>]
                          [--language <locale>]... [--apply]

  --name <company>     tenant display name (required)
  --slug <slug>        explicit slug; derived from --name when omitted
  --region <region>    defaults to ca-central-1, as the UI does
  --language <locale>  repeatable; defaults to en. One of: ${LOCALE_OPTIONS.map(
    (o) => o.value,
  ).join(', ')}
  --apply              write; without it this is a dry run`

/**
 * Drop argument separators before interpreting argv.
 *
 * `pnpm run script -- <args>` forwards a literal `--`, and every task runner
 * documents that form. Without this, argv[0] is `--`, which is truthy, so the usage
 * guard is skipped and `--` is opened as a file — a raw ENOENT stack trace instead of
 * the usage line.
 */
export function normaliseArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== '--')
}

export type FirstTenantArgs = {
  name?: string
  slug?: string
  region: string
  languages: string[]
  apply: boolean
}

export function parseArgs(argv: readonly string[]): FirstTenantArgs {
  const args = normaliseArgs(argv)
  const out: FirstTenantArgs = { region: '', languages: [], apply: false }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    switch (arg) {
      case '--name':
        out.name = args[i + 1]
        i += 1
        break
      case '--slug':
        out.slug = args[i + 1]
        i += 1
        break
      case '--region':
        out.region = args[i + 1] ?? ''
        i += 1
        break
      case '--language':
        out.languages.push(args[i + 1] ?? '')
        i += 1
        break
      case '--apply':
        out.apply = true
        break
      default:
        throw new Error(`unrecognised argument: ${arg}\n${USAGE}`)
    }
  }

  if (!out.name) throw new Error(`--name is required\n${USAGE}`)
  return out
}

/**
 * Resolve the locale policy through the SAME `@beaconhs/i18n` normaliser the UI form
 * uses, so a CLI-created tenant and a UI-created tenant cannot end up with different
 * `enabled_languages` for the same input — a difference that would stay invisible
 * until someone hit a translation fallback.
 *
 * The supported-locale check is kept explicit here (rather than leaning on the
 * normaliser silently dropping unknown values) so an operator who typos `--language`
 * is told, instead of quietly getting a tenant with only `en` enabled.
 */
export function resolveLanguagePolicy(languages: string[]): {
  defaultLocale: AppLocale
  enabledLocales: AppLocale[]
} {
  const requested = languages.length > 0 ? languages : ['en']
  const valid = new Set<string>(LOCALE_OPTIONS.map((o) => o.value))
  for (const value of requested) {
    if (!valid.has(value)) {
      throw new Error(`Unsupported language "${value}". Choose from: ${[...valid].join(', ')}`)
    }
  }
  return normalizeLocalePolicy({
    defaultLocale: requested[0],
    enabledLocales: requested,
  })
}

export async function main(argv: string[]): Promise<number> {
  let args: FirstTenantArgs
  let policy: { defaultLocale: string; enabledLocales: string[] }
  try {
    args = parseArgs(argv)
    policy = resolveLanguagePolicy(args.languages)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  const existing = await countTenants()
  const adminPresent = await hasSuperAdmin()

  console.log(`tenant name:        ${args.name}`)
  console.log(`existing tenants:   ${existing}`)
  console.log(`super-admin:        ${adminPresent ? 'present' : 'MISSING'}`)

  if (!adminPresent) {
    // Not fatal — the tenant row is valid on its own — but the operator should know
    // the day-one audit row will have no actor, and that nobody can sign in yet.
    console.warn(
      '\nWARNING: no super-admin exists. Run `pnpm --filter @beaconhs/auth bootstrap:admin` first,',
    )
    console.warn('otherwise nobody can sign in and the day-one audit row has no actor.')
  }

  if (existing > 0) {
    console.log(
      '\nAlready provisioned — this platform has a tenant, so a real run would write nothing.',
    )
    console.log('Create further tenants at /platform/tenants/new.')
    return 0
  }

  if (!args.apply) {
    console.log('\nDRY RUN — pass --apply to create this first tenant.')
    return 0
  }

  const result = await provisionFirstTenant({
    name: args.name as string,
    slug: args.slug ?? null,
    region: args.region,
    defaultLanguage: policy.defaultLocale,
    enabledLanguages: policy.enabledLocales,
  })

  if (result.outcome === 'already_provisioned') {
    console.log(`\nalready provisioned — tenant "${result.tenant.slug}" exists, nothing written.`)
    return 0
  }

  const { tenant } = result
  console.log(`\nprovisioned first tenant: ${tenant.name} (${tenant.slug})`)
  console.log(`  id:                ${tenant.id}`)
  console.log(`  region:            ${tenant.region}`)
  console.log(`  default language:  ${tenant.defaultLanguage}`)
  console.log(`  enabled languages: ${tenant.enabledLanguages.join(', ')}`)
  if (result.actorEmail) console.log(`  audit actor:       ${result.actorEmail}`)
  console.log(
    '\nNo roles, org units or people were created — that is deliberate and matches the UI.\n' +
      'Sign in, then configure the workspace, then create further tenants at /platform/tenants/new.',
  )
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
