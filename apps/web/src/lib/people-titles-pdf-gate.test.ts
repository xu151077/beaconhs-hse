// Job Titles: the printable Job Description, and the module's single manage gate.
//
// WHY THIS FILE EXISTS
//
// `people/titles/[id]/pdf/page.tsx` renders the Job Description for one title and
// was gated by `requireRequestContext()` — i.e. by "is there a session at all".
// That route joins `personTitleAssignments -> people`, filters to active, non-deleted
// holders, and prints each holder's last name, first name and employee number.
//
// The three sibling Job Titles pages — list, detail and tasks — have always been
// gated by `requireModuleManage('people')`, and the detail page is what links to the
// PDF. So the PDF was the single hole in a module that was otherwise protected: the
// UI link was manager-only, but the URL was not. A `worker` could type the path and
// enumerate the whole active employee roster with employee numbers.
//
// This is NOT a Project Scope regression. The route was never gated at any commit
// (`0b0aeb5a`, `14ae1a47`, `51995178` all read `requireRequestContext`). It is the
// same shape of defect as the ungated Locations read surfaces, and it is closed the
// same way: by adopting the gate the module already had.
//
// WHY NOT `people.read.all`
//
// Measured against the real role definitions, `requireModuleManage('people')`
// resolves to `admin.org.manage`, which no built-in role holds except `tenant_admin`.
// `people.read.all` is held by `safety_manager`. Moving the Job Titles surfaces onto
// `people.read.all` would therefore GRANT `safety_manager` access to four surfaces it
// is currently denied — a widening smuggled in as a security fix. The minimal fix is
// the one that changes nothing but the hole: the PDF adopts its siblings' gate.
//
// HOW IT IS ASSERTED — and the honest limit
//
// The DECISIONS are behavioural: the real `PERMISSION_CATALOGUE`, the real
// `BUILTIN_ROLES`, the real `MODULE_ADMIN` registry entry for `people`, and the real
// `can()` from `@beaconhs/tenant`. Permission sets come from the actual role
// definitions, never a hand-written copy.
//
// The chain reproduced below is `canManageModule`'s, verbatim:
//
//   permissionModule(k) = moduleAdminByKey(FLOW_SUBJECT_MODULE[k] ?? k)
//   canManageModule(ctx, k) = !m ? false : ctx.isSuperAdmin || can(ctx, m.permission)
//
// `FLOW_SUBJECT_MODULE` holds one entry, `'document-signoffs' -> 'documents'`, so
// `permissionModule('people') === moduleAdminByKey('people')`; the suite asserts that
// rather than assuming it.
//
// THE LIMIT, stated rather than hidden: this file cannot CALL `requireModuleManage`,
// because `guard.ts` imports `@/lib/auth` and `apps/web` has no vitest config, so the
// `@/*` alias does not resolve. Every contract test in this repo reads `app/(app)/…`
// with `readFileSync` for the same reason. So the `redirect()` side effect is NOT
// executed here: what IS executed is the permission decision the guard delegates to,
// and the wiring block separately proves each surface really calls the guard, before
// its query. Removing the `redirect()` would pass this file; that is caught by
// `pnpm build` only if the import were removed too. The ordering assertions are
// anchored on the guard EXPRESSION rather than a bare token for the same reason
// recorded in `locations-native-read-permission.test.ts`: a bare `notFound()` anchor
// matched a different `notFound()` in the body and went vacuous there (mutation M9).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import { can, type RequestContext } from '@beaconhs/tenant'
import { moduleAdminByKey } from './module-admin/registry'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const TITLES_LIST = read('../app/(app)/people/titles/page.tsx')
const TITLES_DETAIL = read('../app/(app)/people/titles/[id]/page.tsx')
const TITLES_TASKS = read('../app/(app)/people/titles/[id]/tasks/page.tsx')
const TITLES_PDF = read('../app/(app)/people/titles/[id]/pdf/page.tsx')

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
 * offsets and the slice can never disagree.
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

const MODULE_KEY = 'people'

/**
 * `canManageModule`'s decision, driven by the real registry and the real `can()`.
 *
 * This is what `requireModuleManage` — the guard every Job Titles surface now calls —
 * delegates to. The permission is read from `MODULE_ADMIN`, never hardcoded here, so
 * a change to the module's configured permission is caught rather than shadowed.
 */
const manageAllowed = (ctx: RequestContext): boolean => {
  const m = moduleAdminByKey(MODULE_KEY)
  if (!m) return false
  return ctx.isSuperAdmin || can(ctx, m.permission)
}

/** The permission the Job Titles module is actually gated on. */
const MODULE_PERMISSION = moduleAdminByKey(MODULE_KEY)?.permission ?? ''

const GUARD = "requireModuleManage('people')"

// ---------------------------------------------------------------------------
// The chain this fix relies on
// ---------------------------------------------------------------------------

describe('the Job Titles gate resolves through the real module registry', () => {
  it("the 'people' module is configured, and its permission is read from the registry", () => {
    const m = moduleAdminByKey(MODULE_KEY)
    expect(m, 'moduleAdminByKey("people") must resolve').toBeDefined()
    expect(m?.moduleKey).toBe(MODULE_KEY)
    expect(MODULE_PERMISSION, 'the gate must resolve to a real permission string').not.toBe('')
  })

  it("the 'people' module key is NOT remapped by FLOW_SUBJECT_MODULE", () => {
    // `permissionModule(k)` is `moduleAdminByKey(FLOW_SUBJECT_MODULE[k] ?? k)`. The
    // guard's remap table has a single entry, `'document-signoffs' -> 'documents'`.
    // If a remap for `'people'` were ever added, `manageAllowed` above would silently
    // stop being the guard's decision — so it is asserted rather than assumed.
    expect(
      FLOW_SUBJECT_REMAP_KEYS,
      'FLOW_SUBJECT_MODULE must not remap the people module',
    ).not.toContain(MODULE_KEY)
  })

  it('the module permission is a real catalogue key', () => {
    expect(PERMISSION_CATALOGUE).toContain(MODULE_PERMISSION)
  })

  it('the gate is an org-manage capability, not the roster read key', () => {
    // Stated explicitly because it is the whole reason this fix does not use
    // `people.read.all`: these are different keys with different holders.
    expect(MODULE_PERMISSION).not.toBe('people.read.all')
  })
})

/**
 * The guard's `FLOW_SUBJECT_MODULE` keys, read from its source.
 *
 * `guard.ts` does not export the table and cannot be imported here (it reaches
 * `@/lib/auth`, and `apps/web` resolves no `@/*` alias under vitest). It is read
 * structurally, comment-stripped, from a narrow pattern — the sole corroboration for
 * the single-entry fact stated above. This is a wiring check, never the primary
 * authorization assertion.
 */
const FLOW_SUBJECT_REMAP_KEYS: string[] = [
  ...codeOnly(readFileSync(new URL('./module-admin/guard.ts', import.meta.url), 'utf8')).matchAll(
    /'([a-z-]+)':\s*'[a-z]+'/g,
  ),
]
  .map((m) => m[1] ?? '')
  .filter((k) => k !== 'documents')

// ---------------------------------------------------------------------------
// 1-4 — the four-role matrix for the PDF
// ---------------------------------------------------------------------------

describe('the Job Titles PDF, by real built-in role', () => {
  it('1. worker is DENIED', () => {
    expect(manageAllowed(ctxAs('worker'))).toBe(false)
  })

  it('2. foreman is DENIED', () => {
    expect(manageAllowed(ctxAs('foreman'))).toBe(false)
  })

  it('3. safety_manager is DENIED — and holds people.read.all', () => {
    // The load-bearing negative. `safety_manager` CAN read the roster at `/people`,
    // so it is the role most likely to be argued into the Job Titles catalogue.
    // It holds `people.read.all` and is still denied here. If this fix had used
    // `people.read.all`, this assertion fails — which is the point.
    const sm = ctxAs('safety_manager')
    expect([...(BUILTIN_ROLES.safety_manager?.permissions ?? [])]).toContain('people.read.all')
    expect(can(sm, 'people.read.all')).toBe(true)
    expect(manageAllowed(sm), 'must be denied: the gate is not the roster read key').toBe(false)
  })

  it('4. tenant_admin is ALLOWED, through catalogue inheritance', () => {
    expect(BUILTIN_ROLES.tenant_admin?.permissions).toBe(PERMISSION_CATALOGUE)
    expect(manageAllowed(ctxAs('tenant_admin'))).toBe(true)
  })

  it('a caller holding the module permission directly is allowed', () => {
    expect(manageAllowed(ctxWith([MODULE_PERMISSION]))).toBe(true)
  })

  it('a caller holding neither the module permission nor super-admin is denied', () => {
    expect(manageAllowed(ctxWith([]))).toBe(false)
    expect(manageAllowed(ctxWith(['ppe.read.self', 'incidents.read.all']))).toBe(false)
  })

  it('a super-admin is allowed regardless of permissions', () => {
    const root = { ...ctxWith([]), isSuperAdmin: true } as RequestContext
    expect(manageAllowed(root)).toBe(true)
  })

  it('no built-in role other than tenant_admin can open the PDF', () => {
    // The "did this phase widen anyone?" check, asserted against the real
    // definitions so a future deliberate grant has to be made here explicitly.
    for (const role of Object.keys(BUILTIN_ROLES) as (keyof typeof BUILTIN_ROLES)[]) {
      if (role === 'tenant_admin') continue
      expect(manageAllowed(ctxAs(role)), role).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// The PII the gate protects
// ---------------------------------------------------------------------------

describe('what the PDF renders, and therefore what the gate protects', () => {
  it('the PDF reads active holders out of the people table', () => {
    const code = codeOnly(TITLES_PDF)
    expect(code, 'the holders join must still be present').toContain('from(personTitleAssignments)')
    expect(code).toContain('innerJoin(people, eq(people.id, personTitleAssignments.personId))')
    // Only active, non-deleted holders — the exposure is a real roster, not a legend.
    expect(code).toContain("eq(people.status, 'active')")
    expect(code).toContain('isNull(people.deletedAt)')
  })

  it('the PDF prints last name, first name and employee number', () => {
    // This is the concrete reason the missing gate was a security defect rather than
    // a style inconsistency.
    const code = codeOnly(TITLES_PDF)
    expect(code).toContain('person.lastName')
    expect(code).toContain('person.firstName')
    expect(code).toContain('person.employeeNo')
  })

  it('the holders are rendered from the DB result, not hardcoded', () => {
    const body = bodyOf(TITLES_PDF, /export default async function TitlePdfPage\(/)
    expect(body).toContain('const { row, tasks, assigned } = data')
    expect(body).toContain('assigned.map')
  })
})

// ---------------------------------------------------------------------------
// 5 — the three already-gated surfaces are unchanged
// ---------------------------------------------------------------------------

describe('the already-gated Job Titles surfaces are untouched', () => {
  const surfaces: [string, string][] = [
    ['list', TITLES_LIST],
    ['detail', TITLES_DETAIL],
    ['tasks', TITLES_TASKS],
    ['pdf', TITLES_PDF],
  ]

  it.each(surfaces)("the %s surface calls requireModuleManage('people')", (_name, src) => {
    expect(codeOnly(src)).toContain(GUARD)
  })

  it.each(surfaces)('the %s surface no longer calls requireRequestContext()', (_name, src) => {
    // The regression this phase exists to prevent, on every surface: an ungated page
    // in a gated module.
    expect(codeOnly(src)).not.toContain('requireRequestContext')
  })

  it.each(surfaces)('the %s surface does not use people.read.all', (_name, src) => {
    // The widening guard. If anyone migrates these surfaces onto the roster read key,
    // this fails — and the reason to do so has to be a deliberate product decision.
    expect(codeOnly(src)).not.toContain('people.read.all')
  })

  it('no surface resolves its own permission string instead of using the module guard', () => {
    // Guards against a hand-rolled `can(ctx, 'admin.org.manage')` creeping into one
    // page and drifting from the registry the other three follow.
    for (const [name, src] of surfaces) {
      expect(codeOnly(src), name).not.toMatch(/can\(\s*ctx\s*,\s*'admin\.org\.manage'/)
    }
  })

  it('the list, detail and tasks pages still gate before their queries', () => {
    // Regression pin for the three surfaces this phase must NOT change.
    for (const [name, src, header] of [
      ['list', TITLES_LIST, /export default async function \w+Page\(/],
      ['detail', TITLES_DETAIL, /export default async function \w+Page\(/],
      ['tasks', TITLES_TASKS, /export default async function \w+Page\(/],
    ] as [string, string, RegExp][]) {
      const body = bodyOf(src, header)
      const gate = body.indexOf(GUARD)
      const query = body.indexOf('ctx.db(async (tx) => {')
      expect(gate, `${name}: guard must be present`).toBeGreaterThan(-1)
      expect(query, `${name}: query must be present`).toBeGreaterThan(-1)
      expect(gate, `${name}: guard must precede the query`).toBeLessThan(query)
      expect(body.split(GUARD), `${name}: the guard must appear once`).toHaveLength(2)
    }
  })
})

// ---------------------------------------------------------------------------
// 6 — the fix is wired where it matters
// ---------------------------------------------------------------------------

describe('the PDF page is actually wired to the gate', () => {
  it("6. the PDF calls requireModuleManage('people')", () => {
    expect(codeOnly(TITLES_PDF)).toContain(GUARD)
    expect(codeOnly(TITLES_PDF)).not.toContain('requireRequestContext')
  })

  it('the PDF guard runs BEFORE the ctx.db query that loads the holders', () => {
    // Anchored on the GUARD EXPRESSION, not on a bare token. The body contains three
    // `notFound()` calls — the `isUuid` guard, the missing-row guard, and the one the
    // redirect throws internally — so a bare `notFound()` anchor would have matched
    // the first and gone vacuous, exactly as it did in the Locations suite (M9).
    const body = bodyOf(TITLES_PDF, /export default async function TitlePdfPage\(/)
    const guard = body.indexOf(GUARD)
    const query = body.indexOf('ctx.db(async (tx) => {')
    expect(guard, 'the guard expression must be present').toBeGreaterThan(-1)
    expect(query, 'the holders query must be present').toBeGreaterThan(-1)
    expect(guard, 'the guard must precede the query').toBeLessThan(query)
    // Uniqueness: the ordering claim depends on the expression appearing once.
    expect(body.split(GUARD)).toHaveLength(2)
  })

  it('the PDF body holds exactly one ctx.db call, and it is the holders query', () => {
    // Belt-and-braces on the same property. If a read were ever added before the
    // guard, the ordering assertion above would still pass while data had already
    // been touched — so the count of `ctx.db` calls is pinned at one.
    const body = bodyOf(TITLES_PDF, /export default async function TitlePdfPage\(/)
    expect(body.split('ctx.db(')).toHaveLength(2)
  })

  it('the PDF imports the guard from the module-admin guard module', () => {
    expect(codeOnly(TITLES_PDF)).toContain(
      "import { requireModuleManage } from '@/lib/module-admin/guard'",
    )
  })

  it('the PDF keeps the same dynamic rendering configuration as its siblings', () => {
    // Requirement 3 of the brief. All four Job Titles surfaces declare
    // `force-dynamic`; the PDF already did, and must keep doing so — a static or
    // cached render of a per-tenant roster would be a separate defect.
    for (const [name, src] of [
      ['list', TITLES_LIST],
      ['detail', TITLES_DETAIL],
      ['tasks', TITLES_TASKS],
      ['pdf', TITLES_PDF],
    ] as [string, string][]) {
      expect(src, name).toContain("export const dynamic = 'force-dynamic'")
    }
  })
})

// ---------------------------------------------------------------------------
// 7 — no new permission vocabulary
// ---------------------------------------------------------------------------

describe('no Job Titles permission vocabulary was introduced', () => {
  it('7. no people.titles.* key exists in the catalogue', () => {
    for (const key of PERMISSION_CATALOGUE) {
      expect(key.startsWith('people.titles'), `${key} must not exist`).toBe(false)
    }
  })

  it('no people.* read tier family exists at all', () => {
    // `people` carries no location or owner column, so a site/self tier would be
    // unenforceable from the table. `people.read.all` is the only people read key and
    // this fix must not grow a sibling beside it.
    const peopleReadKeys = PERMISSION_CATALOGUE.filter((k) => /^people\..*\.read\./.test(k))
    expect(peopleReadKeys).toEqual([])
  })

  it('the catalogue holds exactly one people read key', () => {
    const peopleKeys = PERMISSION_CATALOGUE.filter((k) => k.startsWith('people.'))
    expect(peopleKeys).toEqual(['people.read.all'])
  })

  it('no built-in role references a people.titles.* key', () => {
    for (const [role, def] of Object.entries(BUILTIN_ROLES)) {
      for (const key of def.permissions) {
        expect(String(key).startsWith('people.titles'), `${role}: ${key}`).toBe(false)
      }
    }
  })

  it('no built-in role other than tenant_admin gained the module permission', () => {
    // "Did this fix widen anyone?", asserted against the real definitions so a future
    // deliberate grant has to be made here explicitly. This is the drift-proof form:
    // pinning role sizes as literals would duplicate truth that legitimately changes
    // when an unrelated feature lands a new key.
    for (const [role, def] of Object.entries(BUILTIN_ROLES)) {
      if (role === 'tenant_admin') continue
      expect([...def.permissions], role).not.toContain(MODULE_PERMISSION)
    }
  })

  it('tenant_admin receives the module permission only through catalogue inheritance', () => {
    // Not written into the role: `tenant_admin` holds the whole catalogue, so it gains
    // every key automatically. That is why it needs no edit here — and why a role
    // count is the wrong thing to pin.
    expect(BUILTIN_ROLES.tenant_admin?.permissions).toBe(PERMISSION_CATALOGUE)
    expect([...(BUILTIN_ROLES.tenant_admin?.permissions ?? [])]).toContain(MODULE_PERMISSION)
  })
})

// ---------------------------------------------------------------------------
// 8 — the catalogue did not move
// ---------------------------------------------------------------------------

describe('the catalogue is unchanged by this fix', () => {
  it('8. the catalogue holds exactly 100 permissions', () => {
    expect(PERMISSION_CATALOGUE).toHaveLength(100)
  })

  it('every catalogue key is still unique', () => {
    expect(new Set(PERMISSION_CATALOGUE).size).toBe(PERMISSION_CATALOGUE.length)
  })

  it('the admin.org read/manage pair is still adjacent and un-widened', () => {
    // Adjacency is the convention `locations-native-read-permission.test.ts` pins.
    const read = PERMISSION_CATALOGUE.indexOf('admin.org.read')
    const manage = PERMISSION_CATALOGUE.indexOf('admin.org.manage')
    expect(read).toBeGreaterThan(-1)
    expect(manage).toBe(read + 1)
    expect(can(ctxWith(['admin.org.manage']), 'admin.org.read')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9 — the tiered resolver was not touched, and is not borrowed
// ---------------------------------------------------------------------------

describe('the Role Scope resolver was not touched or borrowed', () => {
  it('9. no Job Titles surface calls moduleScopeWhere or resolveVisibilityTier', () => {
    // `person_titles` has no site, owner or subject column. A row-scope predicate
    // bound to it would be dead config or a silent own-only/`false` narrowing — so the
    // correct property is that none is present, not that one is.
    for (const [name, src] of [
      ['list', TITLES_LIST],
      ['detail', TITLES_DETAIL],
      ['tasks', TITLES_TASKS],
      ['pdf', TITLES_PDF],
    ] as [string, string][]) {
      const code = codeOnly(src)
      expect(code, name).not.toContain('moduleScopeWhere')
      expect(code, name).not.toContain('resolveVisibilityTier')
      expect(code, name).not.toContain('canSeeRecord')
      expect(code, name).not.toContain('safeDistanceScopeWhere')
    }
  })

  it('no Job Titles surface declares a tier prefix', () => {
    for (const [name, src] of [
      ['list', TITLES_LIST],
      ['detail', TITLES_DETAIL],
      ['tasks', TITLES_TASKS],
      ['pdf', TITLES_PDF],
    ] as [string, string][]) {
      const prefixes = [...codeOnly(src).matchAll(/prefix:\s*'([^']+)'/g)].map((m) => m[1] ?? '')
      expect(prefixes, name).toEqual([])
    }
  })

  it('visibility.ts itself declares no people.titles prefix', () => {
    const visibility = read('./visibility.ts')
    expect(codeOnly(visibility)).not.toContain('people.titles')
  })
})

// ---------------------------------------------------------------------------
// MUTATION SENSITIVITY
// ---------------------------------------------------------------------------

// Defects this file is designed to fail on. Each was proven non-equivalent by a
// signature probe BEFORE being counted as caught; the results are recorded at the
// foot of this file.
//
//   M1  revert the PDF to requireRequestContext()  [the original defect]
//       -> 5 failures: the surface's guard / requireRequestContext / people.read.all
//          negatives, the wiring block, and the guard-before-query ordering
//   M2  replace the PDF guard with `can(ctx, 'people.read.all')`  [the widening]
//       -> 6 failures: M1's set plus "the pdf surface does not use people.read.all"
//   M3  move the PDF guard AFTER the ctx.db holders query
//       -> 3 failures, including "the PDF guard runs BEFORE the ctx.db query"
//   M4  point the people module's registry permission at a key nobody holds
//       -> 3 failures: the catalogue-key check and both tenant_admin ALLOWED cases
//   M5  grant `admin.org.manage` to safety_manager  [role widening]
//       -> 3 failures: case 3, and both "no other role" negatives
//   M6  add `people.titles.read.all` to the catalogue  [new vocabulary]
//       -> 5 failures: the no-`people.titles.*`, no-tier-family, exactly-one-people-key,
//          no-role-references and 100-count cases
//   M7  duplicate a catalogue key
//       -> 3 failures: uniqueness, the people-key list, and the count
//   M8  drop `people.read.all` from the catalogue
//       -> 2 failures: the people-key list and the count
//   M9  borrow `moduleScopeWhere` (tiered ladder) on the PDF
//       -> 2 failures: no-tiered-ladder and no-tier-prefix
//   M10 remove `export const dynamic` from the PDF
//       -> 1 failure: the dynamic-rendering parity case
//   M11 add a `'people'` entry to the guard's FLOW_SUBJECT_MODULE remap
//       -> 1 failure: the not-remapped case
//   M12 hand-roll `can(ctx, 'admin.org.manage')` instead of the module guard
//       -> 6 failures: M1's set plus "no surface resolves its own permission string"
//
// MUTATION RESULTS — 12 mutations, 12 caught, 0 provable no-ops, 0 survived.
//
// Every mutation was proven NON-EQUIVALENT first by a signature probe over real
// runtime values (the module permission from `MODULE_ADMIN`, the catalogue count and
// uniqueness, the people key family, the four-role `manageAllowed` matrix, the
// super-admin and empty-context cases, the PDF's wiring tokens, the holders join, and
// the FLOW_SUBJECT_MODULE key set) BEFORE being counted. A mutation whose signature
// matched the baseline was reported as a provable no-op and NOT counted — which is
// how M11 was caught being a no-op on its first attempt, because the mutation wrote
// an unquoted `people:` key that the probe's quoted-key pattern did not match. It was
// re-run with the quoted form and then caught.
//
// Two harness defects were found and fixed while running this batch, both of which
// had produced clean-looking but meaningless output:
//
//   1. The mutation id was not forwarded to `apply`, so every id after the first
//      silently re-ran M1 and reported M1's identical five failures. A per-mutation
//      sentinel file now proves each mutation actually landed.
//   2. Several anchors were written at the wrong indentation depth, so M4, M5 and M8
//      failed to apply at all. The harness now exits 6 on "applied nothing" rather
//      than reporting a catch.
//
// A third finding is about the ORDER assertion specifically: M3 moved the guard below
// the query and was caught by 3 failures including the ordering case, which confirms
// the anchor-on-the-expression approach works here. In the Locations suite the
// equivalent bare-token anchor went vacuous and M9 survived — that is the reason this
// file anchors on `requireModuleManage('people')` and asserts it appears exactly once.
