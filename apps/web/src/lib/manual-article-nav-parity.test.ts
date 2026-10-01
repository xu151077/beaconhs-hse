// Help-article visibility must MIRROR nav visibility.
//
// AGENTS.md, "In-app User Guide & Walkthroughs":
//
//   "Visibility gates mirror the nav registry's permissions so people only see
//    help for features they can open."
//
// Two articles had drifted from that rule, both exposed by the removal of the
// second authorization dimension:
//
//   people      nav required `people.read.all`; the article had NO gate, so a
//                worker could read the directory's help — including its "Who you
//                can see" section, which explains the very thing they cannot do.
//   locations    nav was UNGATED (so the list was open to every member); Phase 3
//                gave it an ANY-of gate, and the article was left ungated, which
//                would have re-created the same divergence one layer over.
//
// The fix is a gate on each article and nothing else: no permission added, no
// scope introduced, no route or schema touched.
//
// WHY THE LOCATIONS GATE IS ANY-OF AND NOT `admin.org.read` ALONE
//
// `admin.org.manage` does not widen into `admin.org.read` — `readTierCovers` only
// widens WITHIN one `read` family of one prefix. So a manage-only custom role has
// a visible Locations nav entry, and must have a visible Locations article too.
// Writing `requiredPermission: 'admin.org.read'` would pass a naive
// "article is gated" check while reintroducing the nav/article split.
//
// HOW IT IS ASSERTED — and the honest limit
//
// The ARTICLE side is fully behavioural: `manualArticleForUser` and
// `searchManualArticles` are exported from `manual/registry.ts`, that module has no
// database dependency, and the REAL functions are called. A returned `null` is the
// real refusal. `searchManualArticles` matters as much as the page, because the AI
// assistant reads this same registry — a stale or over-broad article makes the
// assistant give instructions the user cannot follow.
//
// The NAV side is evaluated against the real `NAV_MODULES` entry with the real
// `can()`, reproducing `resolve.ts:162`. `resolveNavGroups` itself is not called
// because it needs a tenant transaction to load the saved nav config and the
// caller's role keys; that is stated rather than hidden.
//
// The MIRROR property is then asserted as DRIFT on real registry OBJECTS — the
// article's declared gate compared field-by-field with the nav entry's. That is a
// data comparison, not a source grep: it fails if either registry is edited, and
// it does not care how either file is formatted or commented.

import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import { can, type RequestContext } from '@beaconhs/tenant'
import { moduleByKey, NAV_MODULES } from './nav/registry'
import { manualArticleForUser, searchManualArticles } from './manual/registry'
import { OVERSIGHT_ADMIN_ARTICLES } from './manual/content/oversight-admin'
import { GETTING_STARTED_ARTICLES } from './manual/content/getting-started'
import { FRONTLINE_ARTICLES } from './manual/content/frontline'
import { KNOWLEDGE_ASSETS_ARTICLES } from './manual/content/knowledge-assets'

const PEOPLE_KEY = 'people.read.all'
const ORG_READ = 'admin.org.read'
const ORG_MANAGE = 'admin.org.manage'

/** The two articles this phase gates, taken from their own content module. */
const OVERSIGHT = OVERSIGHT_ADMIN_ARTICLES

/** Every article in the manual, for the §6 survey. */
const ALL_ARTICLES = [
  ...GETTING_STARTED_ARTICLES,
  ...FRONTLINE_ARTICLES,
  ...KNOWLEDGE_ASSETS_ARTICLES,
  ...OVERSIGHT_ADMIN_ARTICLES,
]

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

// ---------------------------------------------------------------------------
// The two decisions, each over the REAL registry entry and the REAL `can()`.
// `resolveNavGroups` is not called (it needs a tenant transaction); this mirrors
// `resolve.ts:158-171`, whose shape is asserted below.
// ---------------------------------------------------------------------------

const navVisible = (moduleKey: string, ctx: RequestContext): boolean => {
  const mod = moduleByKey(moduleKey)
  if (!mod) return false
  if (mod.requiredPermission && !can(ctx, mod.requiredPermission)) return false
  if (mod.requiredAnyPermission?.length && !mod.requiredAnyPermission.some((p) => can(ctx, p)))
    return false
  return true
}

/** What `manual/registry.ts` `canSeeArticle` decides, over the real article. */
const articleVisible = (slug: string, ctx: RequestContext): boolean =>
  manualArticleForUser(ctx, slug) !== null

/** A slug that is ungated, used as the control that proves the gate is what bites. */
const UNGATED_SLUG = 'notifications'

describe('the People help article mirrors the People nav entry', () => {
  it('people.read.all → nav visible AND article visible', () => {
    const ctx = ctxWith([PEOPLE_KEY])
    expect(navVisible('people', ctx)).toBe(true)
    expect(articleVisible('people', ctx)).toBe(true)
  })

  it('without people.read.all → nav hidden AND article hidden', () => {
    for (const perms of [[], ['incidents.read.all'], ['ppe.read.self'], ['admin.users.manage']]) {
      const ctx = ctxWith(perms)
      const label = perms.length ? perms.join('+') : '(none)'
      expect(navVisible('people', ctx), `nav ${label}`).toBe(false)
      expect(articleVisible('people', ctx), `article ${label}`).toBe(false)
    }
  })

  it('an ungated article stays visible for the same caller — the gate is what bites', () => {
    // Without this control, a reader that returned `null` for everything would pass
    // every negative case above.
    expect(articleVisible(UNGATED_SLUG, ctxWith([]))).toBe(true)
  })

  it('the article declares exactly the nav key', () => {
    const article = OVERSIGHT.find((a) => a.slug === 'people')
    const nav = moduleByKey('people')
    expect(article?.requiredPermission).toBe(nav?.requiredPermission)
    expect(article?.requiredPermission).toBe(PEOPLE_KEY)
    // The ANY-of field must stay unset: nav uses a single key, so adding one here
    // would make the two disagree rather than mirror.
    expect(article?.requiredAnyPermission).toBeUndefined()
  })

  it('every key it names is a real catalogue key', () => {
    const article = OVERSIGHT.find((a) => a.slug === 'people')
    expect(PERMISSION_CATALOGUE).toContain(article?.requiredPermission as string)
  })
})

describe('the Locations help article mirrors the Locations nav entry', () => {
  it('admin.org.read → nav visible AND article visible', () => {
    const ctx = ctxWith([ORG_READ])
    expect(navVisible('locations', ctx)).toBe(true)
    expect(articleVisible('locations', ctx)).toBe(true)
  })

  it('admin.org.manage WITHOUT admin.org.read → nav visible AND article visible', () => {
    // The migration case. `readTierCovers` does not widen `.manage` into `.read`, so
    // this caller holds neither the implied permission nor a `sites` scope — yet
    // both surfaces must still be open, or the nav and the help split again.
    const ctx = ctxWith([ORG_MANAGE])
    expect(can(ctx, ORG_READ), 'precondition: manage does NOT imply read').toBe(false)
    expect(navVisible('locations', ctx)).toBe(true)
    expect(articleVisible('locations', ctx)).toBe(true)
  })

  it('neither key → nav hidden AND article hidden', () => {
    for (const perms of [[], ['incidents.read.all'], ['people.read.all'], ['admin.users.manage']]) {
      const ctx = ctxWith(perms)
      const label = perms.length ? perms.join('+') : '(none)'
      expect(navVisible('locations', ctx), `nav ${label}`).toBe(false)
      expect(articleVisible('locations', ctx), `article ${label}`).toBe(false)
    }
  })

  it('both keys → both visible', () => {
    const ctx = ctxWith([ORG_READ, ORG_MANAGE])
    expect(navVisible('locations', ctx)).toBe(true)
    expect(articleVisible('locations', ctx)).toBe(true)
  })

  it('the article declares the SAME ANY-of pair as the nav entry, not the read key alone', () => {
    const article = OVERSIGHT.find((a) => a.slug === 'locations')
    const nav = moduleByKey('locations')
    expect(article?.requiredAnyPermission).toEqual(nav?.requiredAnyPermission)
    expect(article?.requiredAnyPermission).toEqual([ORG_READ, ORG_MANAGE])
    // The precise regression this guards: a single `requiredPermission` would hide
    // the article from a manage-only caller whose nav entry is visible.
    expect(article?.requiredPermission).toBeUndefined()
  })

  it('every key it names is a real catalogue key', () => {
    const article = OVERSIGHT.find((a) => a.slug === 'locations')
    for (const key of article?.requiredAnyPermission ?? []) {
      expect(PERMISSION_CATALOGUE, key).toContain(key)
    }
  })
})

describe('nav visibility and article visibility never disagree', () => {
  const combinations: string[][] = [
    [],
    [PEOPLE_KEY],
    [ORG_READ],
    [ORG_MANAGE],
    [ORG_READ, ORG_MANAGE],
    [PEOPLE_KEY, ORG_READ],
    [PEOPLE_KEY, ORG_MANAGE],
    ['incidents.read.all'],
    ['ppe.read.self'],
    ['admin.users.manage'],
    ['documents.read'],
    [PEOPLE_KEY, ORG_READ, ORG_MANAGE, 'admin.users.manage'],
  ]

  for (const perms of combinations) {
    const label = perms.length ? perms.join('+') : '(none)'
    it(`[${label}] people and locations agree, and both follow their own nav`, () => {
      const ctx = ctxWith(perms)
      for (const slug of ['people', 'locations'] as const) {
        expect(articleVisible(slug, ctx), `article ${slug} [${label}]`).toBe(navVisible(slug, ctx))
      }
    })
  }

  it('and the built-in roles agree', () => {
    for (const role of Object.keys(BUILTIN_ROLES) as (keyof typeof BUILTIN_ROLES)[]) {
      const ctx = ctxAs(role)
      for (const slug of ['people', 'locations'] as const) {
        expect(articleVisible(slug, ctx), `${role} / ${slug}`).toBe(navVisible(slug, ctx))
      }
    }
  })
})

describe('the AI assistant reads the same gated registry', () => {
  // AGENTS.md: the assistant reads this registry via `search_user_guide` /
  // `read_user_guide`, so an over-broad article makes it give instructions the user
  // cannot follow. Gating the page alone would not fix that.
  const hits = (perms: string[], query: string): string[] =>
    searchManualArticles(ctxWith(perms), query).map((h) => h.article.slug)

  it('a worker searching for the people directory is offered nothing', () => {
    for (const query of ['people', 'people directory', 'directory of employees', 'org chart']) {
      expect(hits(['ppe.read.self'], query), query).not.toContain('people')
    }
  })

  it('a worker searching for locations is offered nothing', () => {
    for (const query of ['locations', 'customers', 'sites', 'org units']) {
      expect(hits(['ppe.read.self'], query), query).not.toContain('locations')
    }
  })

  it('a caller holding the key is offered both', () => {
    expect(hits([PEOPLE_KEY], 'people directory')).toContain('people')
    expect(hits([ORG_READ], 'customers and sites')).toContain('locations')
  })

  it('a manage-only Locations caller is still offered the Locations article', () => {
    expect(hits([ORG_MANAGE], 'customers and sites')).toContain('locations')
    expect(hits([ORG_MANAGE], 'people directory')).not.toContain('people')
  })
})

// ---------------------------------------------------------------------------
// §6 — READ-ONLY consistency check. Recorded, NOT fixed here.
// ---------------------------------------------------------------------------

describe('§6 read-only survey — nav-gated modules whose article is still ungated', () => {
  // Deliberately NOT fixed here. This phase is scoped to the two articles the
  // Project Scope removal exposed. The survey is asserted as DATA rather than
  // written as prose, so it cannot quietly go stale: if someone adds or removes a
  // gate elsewhere, this fails and the follow-up list is revisited.
  const navGated = (): string[] => {
    const out: string[] = []
    for (const mod of NAV_MODULES) {
      if (mod.requiredPermission || mod.requiredAnyPermission?.length) out.push(mod.key)
    }
    return out.sort()
  }

  const articleIsUngated = (slug: string): boolean => {
    const article = ALL_ARTICLES.find((a) => a.slug === slug)
    return !article?.requiredPermission && !article?.requiredAnyPermission?.length
  }

  it('records the exact current divergence set', () => {
    const diverging = navGated().filter((key) => {
      // Nav keys and article slugs are the same identifier for module articles; the
      // handful of nav-only keys (my/notifications/help/dashboard…) simply have no
      // article or are covered by the getting-started set.
      const hasArticle = ALL_ARTICLES.some((a) => a.slug === key)
      return hasArticle && articleIsUngated(key)
    })
    // The survey as it stands, MEASURED over real object fields rather than read
    // off the source text. (An earlier text-window scan of this reported eight extra
    // slugs; a 1400-character lookahead spilled one article's gate into its
    // neighbour. This assertion reads `requiredPermission` / `requiredAnyPermission`
    // off the objects, which is why it is the version kept.)
    //
    // `documents` is deliberately absent: its NAV entry is ungated as well, so the
    // two agree — for better or worse, that is a separate question recorded in the
    // follow-ups, not a nav/article divergence.
    expect(diverging).toEqual(['equipment', 'forms', 'insights', 'ppe', 'reports'])
  })

  it('people and locations are NOT in the divergence set', () => {
    for (const slug of ['people', 'locations'] as const) {
      expect(navGated(), slug).toContain(slug)
      expect(articleIsUngated(slug), `${slug} must be gated now`).toBe(false)
    }
  })

  it('the two modules this phase was asked to check: safe-distance was already consistent', () => {
    // `safe-distance` is nav-gated via its hub's ANY-of and its article already
    // carries the same capability, so it needed nothing.
    expect(navGated()).toContain('tools')
    const sd = ALL_ARTICLES.find((a) => a.slug === 'safe-distance')
    expect(sd?.requiredPermission).toBe('tools.safe-distance.use')
    const tools = ALL_ARTICLES.find((a) => a.slug === 'tools')
    expect(tools?.requiredAnyPermission).toEqual([
      'tools.safe-distance.use',
      'forms.response.create',
    ])
  })

  it('only the two intended gates were added to the oversight content module', () => {
    const gated = OVERSIGHT.filter((a) => a.requiredPermission || a.requiredAnyPermission?.length)
      .map((a) => a.slug)
      .sort()
    expect(gated).toEqual([
      'admin',
      'builder',
      'compliance-management',
      'locations',
      'people',
      'user-access',
      'walkthroughs-admin',
    ])
  })
})

// MUTATION SENSITIVITY
//
// Recorded rather than executed; the batch runs them as a separate step.
//
//   M1  remove `requiredPermission` from the people article
//       → the People describe block, and the drift assertion
//   M2  remove `requiredAnyPermission` from the locations article
//       → the Locations describe block
//   M3  change the locations article to `requiredPermission: 'admin.org.read'`
//       → "the article declares the SAME ANY-of pair", "a manage-only caller is
//         still offered the Locations article", and the MIRROR table
//   M4  remove `requiredAnyPermission` from the locations NAV entry
//       → the drift assertion and the whole Locations block
//   M5  add `requiredAnyPermission` to the people ARTICLE (leaving nav single-key)
//       → "the article declares exactly the nav key"
//   M6  gate the article on a permission the role does not hold
//       → the role-agreement case in the MIRROR table
//   M7  make `canSeeArticle` ignore `requiredAnyPermission`
//       → every manage-only Locations case
//   M8  make `canSeeArticle` ignore `requiredPermission`
//       → every negative People case
//
// NOTE ON M7/M8: those two live in `manual/registry.ts` and are exercised HERE,
// because this suite is the only place the real `canSeeArticle` is called. That is
// the reason the article side is behavioural rather than a data assertion.
