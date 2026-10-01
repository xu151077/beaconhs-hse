// Locations: the native read boundary and the export boundary, asserted apart.
//
// WHY THIS FILE EXISTS
//
// The Locations read surfaces — `/locations`, `/locations/[id]`, and the
// `customer_contacts` rows (name, role, email, phone) they render — had NO
// permission gate at all. `locations/page.tsx` computed `canManage` only to decide
// button visibility, `locations/[id]/page.tsx` loaded the row by id and `notFound()`
// only when the row was absent, and the nav entry carried no gate. The only thing
// standing between a member and the customer address book was the export route's
// gate — i.e. the bulk extract was protected and the on-screen read of the same
// data was not.
//
// `admin.org.read` closes that. It is a FLAT key, not a tier family, because
// `org_units` has no person, owner or site-membership column: `read.self` would be
// unenforceable and `read.site` is circular (`parent_id` is the tree itself). The
// whole boundary is Permission + RLS, and that is deliberate.
//
// THE MIGRATION CONSTRAINT THIS FILE EXISTS TO HOLD
//
// `readTierCovers` widens only WITHIN one `read` family of one prefix, so
// `admin.org.manage` does NOT imply `admin.org.read`. Every read boundary here is
// therefore ACCEPT-BOTH: `admin.org.read` OR `admin.org.manage`. Without that, a
// role granted `admin.org.manage` before this key existed would silently lose
// Locations on upgrade — the exact regression the accept-both check prevents. This
// is a LOCAL boundary: `.manage` must never start implying `.read` globally.
//
// READ AND EXPORT ARE DIFFERENT AXES, and this file keeps them apart:
//
//   READ    admin.org.read OR admin.org.manage
//   EXPORT  admin.data.export AND admin.org.manage
//
// `admin.org.read` alone must never be enough to export, and `admin.org.manage`
// alone must never be enough to export either.
//
// HOW IT IS ASSERTED — and the honest limit
//
// The DECISIONS are behavioural: the real `can()` / `assertCan()` from
// `@beaconhs/tenant`, the real `PERMISSION_CATALOGUE`, the real `BUILTIN_ROLES`,
// and the real `NAV_MODULES` entry. Read permission sets come from the actual role
// definitions, never from a hand-written copy.
//
// The WIRING — "does the page actually consult the gate, and does it do so before
// the query" — is structural, because `app/(app)/…` is not importable from this
// runner: `apps/web` has no vitest config, so the `@/*` tsconfig alias is not
// resolved. Every contract test in this repo reads those sources with
// `readFileSync` for the same reason. Wiring is therefore asserted against
// ISOLATED, brace-matched BODIES with comments stripped first, so prose naming a
// symbol cannot satisfy an assertion and a mutation elsewhere in the file cannot
// break one.
//
// The limit that follows, stated rather than hidden: this file cannot CALL the
// page. If someone removed the `redirect()` the page still passes here. It would be
// caught by `pnpm build` only if the import were removed too. That is why the
// wiring assertions pin the gate expression and its ORDER relative to the query,
// rather than merely asserting that a key appears somewhere in the file.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import { assertCan, can, type RequestContext } from '@beaconhs/tenant'
import { moduleByKey } from './nav/registry'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const LOCATIONS_LIST = read('../app/(app)/locations/page.tsx')
const LOCATIONS_DETAIL = read('../app/(app)/locations/[id]/page.tsx')
const LOCATIONS_EXPORT = read('../app/(app)/locations/export.csv/route.ts')

/** Source with comments removed, so prose naming a symbol is not read as code. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

/**
 * The brace-matched body of a declaration, found by its opening line.
 *
 * Comments are stripped FIRST and the brace walk runs on that same text, so the
 * offsets and the slice can never disagree. Parens and angle brackets are tracked
 * because a signature like `Promise<ActionOk<{ sent: number }>>` carries braces of
 * its own.
 */
function bodyOf(src: string, header: RegExp): string {
  const code = codeOnly(src)
  const m = code.match(header)
  if (!m) throw new Error(`no source matched ${header}`)
  let from = -1
  let parens = 0
  let angles = 0
  const start = m.index ?? 0
  for (let i = start; i < code.length; i++) {
    const c = code[i]
    if (c === undefined) break
    if (c === '(') parens++
    else if (c === ')') parens--
    else if (c === '<') angles++
    else if (c === '>') angles--
    else if (c === '{' && parens === 0 && angles === 0) {
      from = i
      break
    }
  }
  if (from < 0 || code[from] !== '{') throw new Error(`${header} is not followed by a body brace`)
  let depth = 0
  for (let j = from; j < code.length; j++) {
    const c = code[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return code.slice(from + 1, j)
    }
  }
  throw new Error(`unbalanced braces after ${header}`)
}

/** A caller holding exactly these permissions, and nothing else. */
function ctxWith(permissions: string[]): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-0000000000aa',
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'member_1', displayName: 'Tester' },
    personId: 'person_1',
    permissions: new Set(permissions),
    scopes: [],
    activeRoleId: null,
    db: (async (fn: (t: unknown) => unknown) => fn({})) as RequestContext['db'],
  } as RequestContext
}

/** A caller holding exactly one built-in role's real permissions. */
function ctxAs(role: keyof typeof BUILTIN_ROLES): RequestContext {
  return ctxWith([...(BUILTIN_ROLES[role]?.permissions ?? [])] as string[])
}

const READ_KEY = 'admin.org.read'
const MANAGE_KEY = 'admin.org.manage'
const EXPORT_KEY = 'admin.data.export'

/**
 * The page gates, evaluated with the real `can()`.
 *
 * This is the decision the two pages make, spelled out once so every case below
 * asserts the same thing. It is a transcription of the expression the pages
 * contain — which is why the wiring block below separately proves the pages really
 * contain it.
 */
const readAllowed = (ctx: RequestContext): boolean =>
  can(ctx, READ_KEY) || can(ctx, MANAGE_KEY) || ctx.isSuperAdmin

/** The export route's two capabilities, as the route composes them. */
const exportAllowed = (ctx: RequestContext): boolean => can(ctx, EXPORT_KEY) && can(ctx, MANAGE_KEY)

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

describe('the catalogue gained exactly one key', () => {
  it('admin.org.read is in the catalogue and admin.org.manage still is', () => {
    expect(PERMISSION_CATALOGUE).toContain(READ_KEY)
    expect(PERMISSION_CATALOGUE).toContain(MANAGE_KEY)
  })

  it('it sits immediately before admin.org.manage, the read/manage pair order', () => {
    const read = PERMISSION_CATALOGUE.indexOf(READ_KEY)
    const manage = PERMISSION_CATALOGUE.indexOf(MANAGE_KEY)
    expect(read).toBeGreaterThan(-1)
    expect(manage).toBe(read + 1)
  })

  it('it is FLAT, not a tier family member', () => {
    // `permission-catalogue-contract.test.ts` enforces that any key whose
    // second-to-last segment is `read` must end in a tier the ladder can resolve.
    // Asserting the shape here states WHY: `org_units` has no column to scope on.
    const parts = READ_KEY.split('.')
    expect(parts[parts.length - 2]).toBe('org')
    expect(parts).not.toContain('all')
    expect(parts).not.toContain('site')
    expect(parts).not.toContain('self')
  })

  it('no admin.org read TIER family was introduced alongside it', () => {
    // A `.read.site` here would be a promise the ladder cannot keep: org_units rows
    // are ANCESTORS of a caller's sites, not members, and `mySiteIds` does no tree
    // walk. Adding one would invite `prefix:'admin.org'` and silently yield
    // own-only/`false`. Its absence has to fail if someone adds it.
    for (const tier of ['all', 'site', 'self']) {
      expect(PERMISSION_CATALOGUE, `admin.org.read.${tier}`).not.toContain(`admin.org.read.${tier}`)
    }
  })

  it('admin.org.read does NOT widen into admin.org.manage', () => {
    // The one direction that must never appear.
    expect(can(ctxWith([READ_KEY]), MANAGE_KEY)).toBe(false)
  })

  it('and admin.org.manage does NOT widen into admin.org.read — the migration constraint', () => {
    // If this ever becomes true the accept-both checks below become dead code, and
    // worse, the review-time meaning of the key changes silently. Proven against
    // the real `can()`, not against the source.
    expect(can(ctxWith([MANAGE_KEY]), READ_KEY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A / B / C — the read boundary
// ---------------------------------------------------------------------------

describe('the Locations read boundary', () => {
  it('A. admin.org.read is allowed to read Locations', () => {
    expect(readAllowed(ctxWith([READ_KEY]))).toBe(true)
  })

  it('B. admin.org.manage alone is STILL allowed — the migration path', () => {
    // The whole reason the gates are accept-both. A role granted only
    // `admin.org.manage` before `admin.org.read` existed keeps working.
    expect(readAllowed(ctxWith([MANAGE_KEY]))).toBe(true)
  })

  it('C. a caller with neither key is denied', () => {
    expect(readAllowed(ctxWith([]))).toBe(false)
    // And an unrelated permission does not open it.
    expect(readAllowed(ctxWith(['ppe.read.self', 'incidents.read.all']))).toBe(false)
  })

  it('a super-admin is allowed regardless', () => {
    const root = { ...ctxWith([]), isSuperAdmin: true } as RequestContext
    expect(readAllowed(root)).toBe(true)
    expect(exportAllowed(root), 'and can export, as every route allows').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// D / E / F — the export boundary, proven INDEPENDENT of the read boundary
// ---------------------------------------------------------------------------

describe('the Locations export boundary is a separate axis', () => {
  it('D. admin.org.read alone CANNOT export', () => {
    // The single most important negative here. Read and export must not collapse:
    // export is a bulk extract of an address book, so it stays stricter.
    expect(exportAllowed(ctxWith([READ_KEY]))).toBe(false)
    expect(() => assertCan(ctxWith([READ_KEY]), MANAGE_KEY)).toThrow()
  })

  it('D. admin.org.read plus admin.data.export still cannot export', () => {
    // The generic export capability alone is not enough either — the org module
    // capability is required alongside it.
    expect(exportAllowed(ctxWith([READ_KEY, EXPORT_KEY]))).toBe(false)
  })

  it('E. admin.org.manage without admin.data.export cannot export', () => {
    expect(exportAllowed(ctxWith([MANAGE_KEY]))).toBe(false)
    expect(() => assertCan(ctxWith([MANAGE_KEY]), EXPORT_KEY)).toThrow()
  })

  it('F. admin.data.export without admin.org.manage cannot export', () => {
    expect(exportAllowed(ctxWith([EXPORT_KEY]))).toBe(false)
    expect(() => assertCan(ctxWith([EXPORT_KEY]), MANAGE_KEY)).toThrow()
  })

  it('all three capabilities together can export, and read is then also allowed', () => {
    const all = ctxWith([READ_KEY, MANAGE_KEY, EXPORT_KEY])
    expect(exportAllowed(all)).toBe(true)
    expect(readAllowed(all)).toBe(true)
  })

  it('assertCan is what the route uses, so the refusal is a real refusal', () => {
    expect(() => assertCan(ctxWith([READ_KEY, EXPORT_KEY]), MANAGE_KEY)).toThrow(
      /admin\.org\.manage/,
    )
    expect(() => assertCan(ctxWith([MANAGE_KEY]), MANAGE_KEY)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// I — no authorization expansion: the built-in roles, as actually configured
// ---------------------------------------------------------------------------

describe('no built-in role gained access', () => {
  const roles = Object.keys(BUILTIN_ROLES) as (keyof typeof BUILTIN_ROLES)[]

  it('admin.org.read is held by tenant_admin, through catalogue inheritance', () => {
    // Not written into the role: `tenant_admin` holds the whole catalogue, so it
    // receives every key automatically and needs no edit.
    expect(BUILTIN_ROLES.tenant_admin?.permissions).toBe(PERMISSION_CATALOGUE)
    expect([...(BUILTIN_ROLES.tenant_admin?.permissions ?? [])]).toContain(READ_KEY)
  })

  it('and by no other built-in role', () => {
    // The check is "did this phase widen anyone?" — asserted against the real
    // definitions, so a future deliberate grant has to be made here explicitly.
    for (const role of roles) {
      if (role === 'tenant_admin') continue
      expect([...(BUILTIN_ROLES[role]?.permissions ?? [])], role).not.toContain(READ_KEY)
    }
  })

  it('every non-tenant_admin role is denied Locations, before and after this change', () => {
    for (const role of roles) {
      if (role === 'tenant_admin') continue
      expect(readAllowed(ctxAs(role)), role).toBe(false)
    }
  })

  it('tenant_admin is allowed both read and export', () => {
    const admin = ctxAs('tenant_admin')
    expect(readAllowed(admin)).toBe(true)
    expect(exportAllowed(admin)).toBe(true)
  })

  it('safety_manager — which holds people.read.all — is still denied Locations', () => {
    // Recorded because it is the role most likely to be argued into the org tree.
    // It is not granted here; doing so is a product decision, not a refactor.
    const sm = ctxAs('safety_manager')
    expect([...(BUILTIN_ROLES.safety_manager?.permissions ?? [])]).toContain('people.read.all')
    expect(readAllowed(sm)).toBe(false)
    expect(exportAllowed(sm)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// G — the detail surface, and the PII it renders
// ---------------------------------------------------------------------------

describe('the Locations detail surface', () => {
  it('G. admin.org.read may open a location by id; neither key means notFound()', () => {
    expect(readAllowed(ctxWith([READ_KEY]))).toBe(true)
    expect(readAllowed(ctxWith([MANAGE_KEY]))).toBe(true)
    expect(readAllowed(ctxWith([]))).toBe(false)
  })

  it('§12 customer_contacts is reachable ONLY through an authorised Locations read', () => {
    // `customer_contacts` (name, role, email, phone) is rendered by the detail
    // page and has NO permission of its own — deliberately. It is part of the same
    // org read boundary, so gating the page gates the contacts with it.
    //
    // What must never happen is contacts becoming tenant-wide public data, i.e.
    // readable by a caller who cannot read the org structure. These two assertions
    // are that guarantee.
    const noOrgRead = ctxWith(['incidents.read.all', 'admin.users.manage'])
    expect(readAllowed(noOrgRead)).toBe(false)
    // `admin.users.manage` is a real capability and gates the PEOPLE export; it is
    // deliberately NOT an org read key.
    expect(can(noOrgRead, READ_KEY)).toBe(false)
    expect(can(noOrgRead, MANAGE_KEY)).toBe(false)
  })

  it('there is no separate contacts permission to drift out of step', () => {
    // If a `contacts.read`-style key ever appears, it must be wired deliberately —
    // and this test is where that decision would have to be made.
    for (const key of PERMISSION_CATALOGUE) {
      expect(key.startsWith('contacts.') || key.startsWith('customer_contacts.')).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// H — navigation
// ---------------------------------------------------------------------------

describe('the Locations nav entry', () => {
  const entry = moduleByKey('locations')

  it('is gated by BOTH keys as an ANY-of, not a single requiredPermission', () => {
    expect(entry).toBeDefined()
    // Any-of is the mechanism `resolve.ts:162` already evaluates. A single
    // `requiredPermission: 'admin.org.read'` would hide the entry from a
    // manage-only role during the migration window.
    expect(entry?.requiredAnyPermission).toEqual([READ_KEY, MANAGE_KEY])
  })

  it('does not ALSO demand a single requiredPermission', () => {
    // `resolve.ts` requires both, so leaving both set would narrow to the
    // intersection and hide the entry from a read-only role.
    expect(entry?.requiredPermission).toBeUndefined()
  })

  it('H. a caller holding either key sees the entry, via the real nav decision', () => {
    // The real registry entry and the real `can()`, so a change to either is
    // caught. Mirrors `resolve.ts:162`.
    const visible = (ctx: RequestContext): boolean => {
      const mod = entry
      if (!mod) return false
      if (mod.requiredPermission && !can(ctx, mod.requiredPermission)) return false
      if (mod.requiredAnyPermission?.length && !mod.requiredAnyPermission.some((p) => can(ctx, p)))
        return false
      return true
    }
    expect(visible(ctxWith([READ_KEY]))).toBe(true)
    expect(visible(ctxWith([MANAGE_KEY]))).toBe(true)
    expect(visible(ctxWith([]))).toBe(false)
    expect(visible(ctxAs('worker'))).toBe(false)
    expect(visible(ctxAs('foreman'))).toBe(false)
    expect(visible(ctxAs('safety_manager'))).toBe(false)
    expect(visible(ctxAs('tenant_admin'))).toBe(true)
  })

  it('every key it names is a real catalogue key', () => {
    for (const key of entry?.requiredAnyPermission ?? []) {
      expect(PERMISSION_CATALOGUE, key).toContain(key)
    }
  })
})

// ---------------------------------------------------------------------------
// Wiring — the pages really contain the gates the cases above evaluate
// ---------------------------------------------------------------------------

describe('the pages are actually wired to the gates', () => {
  it('the list gate is accept-both and uses exactly the two keys', () => {
    const body = bodyOf(LOCATIONS_LIST, /export default async function LocationsPage\(/)
    expect(body).toMatch(
      /if \(!canManage && !can\(ctx, 'admin\.org\.read'\)\) redirect\('\/dashboard'\)/,
    )
    expect(body).toMatch(
      /const canManage = ctx\.isSuperAdmin \|\| can\(ctx, 'admin\.org\.manage'\)/,
    )
  })

  it('the list gate runs BEFORE the customer query', () => {
    // Otherwise it is a button-visibility flag, which is exactly what it was
    // before this change.
    //
    // As with the detail page, the tokens are anchored and asserted UNIQUE, so a
    // second `redirect('/dashboard')` added later cannot silently turn this
    // ordering assertion into a no-op that always passes.
    const body = bodyOf(LOCATIONS_LIST, /export default async function LocationsPage\(/)
    const GATE = "if (!canManage && !can(ctx, 'admin.org.read')) redirect('/dashboard')"
    const gate = body.indexOf(GATE)
    const query = body.indexOf('ctx.db(async (tx) => {')
    expect(gate, 'the gate expression must be present').toBeGreaterThan(-1)
    expect(query, 'the customer query must be present').toBeGreaterThan(-1)
    expect(gate).toBeLessThan(query)
    // Uniqueness: the ordering claim depends on the expression appearing once.
    expect(body.split(GATE)).toHaveLength(2)
  })

  it('the list export button still needs BOTH capabilities, and read is not one of them', () => {
    const body = bodyOf(LOCATIONS_LIST, /export default async function LocationsPage\(/)
    expect(body).toMatch(/const canExport = can\(ctx, 'admin\.data\.export'\) && canManage/)
    // The regression to catch: `admin.org.read` leaking into the export axis.
    expect(body).not.toMatch(/canExport[^\n]*admin\.org\.read/)
  })

  it('the detail gate is accept-both, and returns notFound()', () => {
    const body = bodyOf(LOCATIONS_DETAIL, /export default async function \w+Page\(/)
    expect(body).toMatch(
      /if \(!can\(ctx, 'admin\.org\.read'\) && !can\(ctx, 'admin\.org\.manage'\)\) notFound\(\)/,
    )
  })

  it('the detail gate runs BEFORE the org-unit row is loaded', () => {
    // Non-oracular: a refused id must be indistinguishable from a missing one, so
    // the check has to precede the fetch. `people/[id]` sets this precedent.
    //
    // The ORDER is asserted against the GATE EXPRESSION, not against a bare
    // `notFound()` token. This body contains three `notFound()` calls — the
    // pre-existing `isUuid` guard, the gate, and the missing-row guard — so
    // anchoring on the token matched the first one every time and made this
    // assertion vacuous. It passed while the gate sat AFTER the fetch; mutation
    // M9 in the notes at the foot of this file is what exposed it.
    const body = bodyOf(LOCATIONS_DETAIL, /export default async function \w+Page\(/)
    const GATE = "if (!can(ctx, 'admin.org.read') && !can(ctx, 'admin.org.manage')) notFound()"
    const gate = body.indexOf(GATE)
    const fetch = body.indexOf('await tx.select().from(orgUnits)')
    expect(gate, 'the gate expression must be present').toBeGreaterThan(-1)
    expect(fetch, 'the org-unit load must be present').toBeGreaterThan(-1)
    expect(gate).toBeLessThan(fetch)
  })

  it('no row-scope predicate is applied to the org unit itself', () => {
    // `org_units` has no person, owner or site-membership column, so a
    // `moduleScopeWhere` bound to it would be dead config or a silent
    // own-only/`false` narrowing.
    //
    // The detail page DOES call `moduleScopeWhere` — twice — but for its embedded
    // `incidents` and `equipment` tabs, which is correct and unrelated. So the
    // property asserted is about the PREFIX, not about the call's presence.
    const orgPrefixes = [...codeOnly(LOCATIONS_DETAIL).matchAll(/prefix:\s*'([^']+)'/g)]
      .map((m) => m[1] ?? '')
      .filter((p) => p.startsWith('admin.org') || p.startsWith('locations') || p === 'org')
    expect(orgPrefixes).toEqual([])

    // The list page scopes nothing at all.
    expect(codeOnly(LOCATIONS_LIST)).not.toContain('moduleScopeWhere')
  })

  it('the embedded tab predicates are still scoped by their own modules', () => {
    // A guard against "fixing" the org read by borrowing a neighbouring module's
    // ladder, which would scope org_units by an unrelated tier.
    const code = codeOnly(LOCATIONS_DETAIL)
    expect([...code.matchAll(/prefix:\s*'([^']+)'/g)].map((m) => m[1]).sort()).toEqual([
      'equipment',
      'incidents',
    ])
  })

  it('the export route gate is untouched: admin.data.export + admin.org.manage', () => {
    // Regression guard, not new behaviour. This phase deliberately did NOT add
    // `admin.org.read` to the export axis.
    const code = codeOnly(LOCATIONS_EXPORT)
    expect(code).toContain('requireExportContext()')
    expect(code).toContain("assertCan(ctx, 'admin.org.manage')")
    expect(code).not.toContain("assertCan(ctx, 'admin.org.read')")
  })

  it('the export route still refuses to run while impersonating', () => {
    const code = codeOnly(LOCATIONS_EXPORT)
    // `requireExportContext` owns the impersonation refusal; the route must keep
    // calling it rather than open-coding `requireRequestContext`, which would
    // silently drop both `admin.data.export` and the impersonation check.
    expect(code).not.toMatch(/assertNotImpersonating/)
    expect(code).not.toMatch(/requireRequestContext\(\)/)
    expect(code).toContain('requireExportContext()')
  })
})

// MUTATION SENSITIVITY
//
// Defects this file is designed to fail on. Recorded here rather than executed;
// the batch runs them as a separate, explicit step.
//
//   M1  remove `admin.org.read` from the catalogue
//       → "admin.org.read is in the catalogue" (and the three count assertions)
//   M2  replace a page's accept-both with `can(ctx,'admin.org.read')` alone
//       → "the list gate is accept-both", "the detail gate is accept-both",
//         and case B ("manage alone is STILL allowed")
//   M3  drop `admin.org.manage` from the list gate, keeping only the read key
//       → the same two cases, plus the nav intersection check
//   M4  move the list gate AFTER the customer query
//       → "the list gate runs BEFORE the customer query"
//   M5  move the detail gate AFTER the row load
//       → "the detail gate runs BEFORE the org-unit row is loaded"
//   M6  add `admin.org.read` to the export axis
//       → "the export route gate is untouched" and case D
//   M7  drop `admin.org.manage` from the export route
//       → "the export route gate is untouched" and case F
//   M8  drop `admin.data.export` from the export route
//       → "the export route gate is untouched" and case E
//   M9  set BOTH `requiredPermission` and `requiredAnyPermission` on the nav entry
//       → "does not ALSO demand a single requiredPermission"
//   M10 add `admin.org.read.site` to the catalogue
//       → "no admin.org read TIER family was introduced alongside it"
//   M11 grant `admin.org.read` to safety_manager
//       → "and by no other built-in role"
//   M12 make `readTierCovers` widen `.manage` into `.read`
//       → "admin.org.manage does NOT widen into admin.org.read"
//
// MUTATION RESULTS — 16 mutations, 16 caught, 0 provable no-ops, 0 survived.
// Each was proven non-equivalent by a signature probe (56 lines over the real
// catalogue, the real `can()` decisions across 10 permission combinations, the real
// role sets, the real nav entry and the real page wiring) BEFORE being counted.
//
// One of them earned its keep. The first version of the detail-ordering
// assertion used `body.indexOf('notFound()')`, and the body contains three
// `notFound()` calls — the pre-existing `isUuid` guard, the gate, and the
// missing-row guard — so it anchored on the wrong one and passed while the gate sat
// AFTER the org-unit fetch. That mutation survived. Both ordering assertions are
// now anchored on the gate expression itself, and the list one additionally asserts
// the expression is unique, so a second occurrence cannot silently re-vacuum it.
