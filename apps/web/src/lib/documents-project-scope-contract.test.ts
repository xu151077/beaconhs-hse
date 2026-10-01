// 15B-3C — `documents` is a TENANT-LEVEL CONTROLLED DOCUMENT LIBRARY.
//
// This file was first written as a baseline of the pre-decision state, where the
// web half applied no Project Scope at all and the analytics half withheld
// `documents` outright. The product decision has since been made, and both halves
// now express the SAME rule. This is the contract for that rule.
//
// THE RULE
//
//   unrestricted -> no Project Scope constraint
//   restricted   -> no Project Scope constraint   (a scoped reader still sees the
//                                                  tenant's published library)
//   empty        -> DENY / withheld
//   unknown      -> DENY / withheld
//
// A tenant publishes ONE version of an SDS / SOP / policy and every field worker
// on every site must be able to read it, so a Project Scope must not narrow the
// library. No Document Applicability Scope is introduced and the table gains no
// scope column. An unusable scope still denies: an absent scope is not evidence of
// a wide one.
//
//   WEB        `documentAuthorizationFilter` — `documentReadFilter` AND-ed with
//              `documentScopeUsable`, in `lib/assistant/document-project-scope.ts`.
//              `documentReadFilter` itself is UNCHANGED and still answers only
//              "may an unpublished document be seen".
//
//   ANALYTICS  the `tenant-level-document-library` exemption on the `documents`
//              spec. A row-predicate exemption only: the read tier is still
//              resolved first, and `empty`/`unknown` are denied ABOVE it in
//              `scopeContribution`.
//
// These are two independent implementations of one product rule — the web ladder
// has no exemption concept and the analytics ladder has no publication rule — so
// their agreement is asserted here rather than assumed.
//
// WHAT IS NOT ASSERTED
//
//   • that `documents` should ever become project-, site- or person-bound. The
//     decision explicitly declines an applicability binding, and the shape
//     assertions below exist to keep a future one from appearing silently.
//   • that `ownerTenantUserId` is or could become a scope. It is nullable
//     authorship; the spec binds on no owner column, and that is pinned.
//   • that the two halves share code. They cannot — the rules live in different
//     packages — so the shared contract is the four-state table, tested twice.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { getTableColumns } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { documents, type RoleScope } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { type AnalyticsEntity } from '@beaconhs/analytics'
import { analyticsScopeSubject, scopeAnalyticsEntities } from '@beaconhs/analytics/server'
import type { ProjectScope } from './project-scope'
import { projectScopeTx } from './testing/project-scope-fixture'
import { documentReadFilter } from './assistant/doc-access'
import {
  documentAuthorizationFilter,
  documentScopeFilter,
  documentScopeUsable,
} from './assistant/document-project-scope'

const dialect = new PgDialect()
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

/** Source with comments removed, so a name mentioned in prose is not read as a call. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

type ScopeState = 'unrestricted' | 'restricted' | 'empty' | 'unknown'
const SCOPE_STATES: readonly ScopeState[] = ['unrestricted', 'restricted', 'empty', 'unknown']

const SITE_A = '00000000-0000-4000-8000-00000000a001'
const ORG_UNIT = '0a000000-0000-4000-8000-000000000001'

/** The `ProjectScope` for a state; `undefined` is the unresolved case. */
const projectScopeFor = (state: ScopeState): ProjectScope | undefined => {
  switch (state) {
    case 'unrestricted':
      return { kind: 'unrestricted' }
    case 'restricted':
      return { kind: 'orgUnits', orgUnitIds: [ORG_UNIT], personIds: [] }
    case 'empty':
      return { kind: 'empty', reason: 'no_scope' }
    case 'unknown':
      return undefined
  }
}

/**
 * `role_assignments.scope` is the ACCESS boundary and is independent of Project
 * Scope, so a restricted caller here holds both a role scope and the permission.
 */
const roleScopesFor = (state: ScopeState): RoleScope[] =>
  state === 'unrestricted' ? [{ type: 'tenant' }] : [{ type: 'sites', siteIds: [SITE_A] }]

const webCtx = (state: ScopeState, permissions = ['documents.read']): RequestContext =>
  ({
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-000000000001',
    isSuperAdmin: false,
    membership: { id: 'member_1', displayName: 'Worker' },
    personId: 'person_1',
    permissions: new Set(permissions),
    scopes: roleScopesFor(state),
    db: async () => {
      throw new Error('these predicates must not touch the database')
    },
  }) as unknown as RequestContext

const analyticsSubject = (state: ScopeState) =>
  analyticsScopeSubject(
    {
      isSuperAdmin: false,
      permissions: (key) => key === 'documents.read',
      siteIds: [SITE_A],
      personId: 'person_1',
      tenantUserId: 'member_1',
    },
    projectScopeFor(state),
  )

const documentsEntity = (): AnalyticsEntity =>
  ({
    table: 'documents',
    key: 'documents',
    label: 'Documents',
    category: 'Test',
    columns: [
      { key: 'id', label: 'id', kind: 'uuid' },
      { key: 'title', label: 'title', kind: 'uuid' },
    ],
  }) as unknown as AnalyticsEntity

const compile = (p: unknown) => {
  const c = dialect.sqlToQuery(p as never)
  return { sql: c.sql, params: c.params.map(String) }
}

const analyticsOutcome = (state: ScopeState): string => {
  const out = scopeAnalyticsEntities(analyticsSubject(state), [documentsEntity()])
  if (out.length === 0) return 'WITHHELD'
  return out[0]!.baseFilter ? `VISIBLE filtered=${JSON.stringify(out[0]!.baseFilter)}` : 'VISIBLE'
}

// ===========================================================================
// 1. The pure scope decision
// ===========================================================================

describe('15B-3C documents — the Project Scope usability decision', () => {
  it('admits a usable scope, whatever kind it is', () => {
    // A restricted scope is NOT a reason to deny: the library is tenant-level.
    expect(documentScopeUsable({ kind: 'unrestricted' })).toBe(true)
    expect(documentScopeUsable({ kind: 'orgUnits', orgUnitIds: [ORG_UNIT], personIds: [] })).toBe(
      true,
    )
    expect(documentScopeUsable({ kind: 'persons', personIds: ['person_1'] })).toBe(true)
    expect(
      documentScopeUsable({ kind: 'peopleAndOrgUnits', orgUnitIds: [ORG_UNIT], personIds: [] }),
    ).toBe(true)
  })

  it('refuses an empty scope, and an unresolved one', () => {
    expect(documentScopeUsable({ kind: 'empty', reason: 'no_scope' })).toBe(false)
    // `undefined` is the web counterpart of the analytics `unknown` state: a scope
    // that was never resolved. It must not be read as "no restriction".
    expect(documentScopeUsable(undefined)).toBe(false)
  })

  it('resolves a real transaction into the same decision', async () => {
    // The fixture answers the resolver's queries for a caller placed at SITE_A, so
    // this is a genuine restricted scope rather than a hand-made one.
    const tx = projectScopeTx()
    const scopeOnly = await documentScopeFilter(webCtx('restricted'), tx)
    expect(scopeOnly).toBeUndefined()
  })

  it('emits a denying predicate, not an absent one, when unusable', async () => {
    const tx = projectScopeTx()
    // A caller with no assignment resolves to `empty` in the fixture world.
    const noRecord = projectScopeTx({ employeeRecord: 'none', assignments: [] })
    const denied = await documentScopeFilter(webCtx('restricted'), noRecord)
    expect(denied).toBeDefined()
    expect(compile(denied).sql).toBe('false')
    // A usable scope adds nothing at all.
    expect(await documentScopeFilter(webCtx('restricted'), tx)).toBeUndefined()
  })
})

// ===========================================================================
// 2. Web — the composed rule
// ===========================================================================

describe('15B-3C documents — web composes scope AND publication', () => {
  const tx = projectScopeTx()

  it('restricted -> published documents are reachable', async () => {
    // The product decision: a scoped worker still reads the tenant's library.
    const filter = await documentAuthorizationFilter(webCtx('restricted'), tx)
    expect(filter).toBeDefined()
    expect(compile(filter).params).toEqual(['published'])
  })

  it('unrestricted -> the same published rule applies', async () => {
    const filter = await documentAuthorizationFilter(webCtx('unrestricted'), tx)
    expect(compile(filter).params).toEqual(['published'])
  })

  it('empty -> denied', async () => {
    // The web side resolves the scope for real, and it derives that from
    // `people_assignments` — not from `role_assignments.scope`. So an `empty`
    // scope comes from a caller with no employee record, which is what the second
    // fixture models. `ctx.scopes` alone cannot produce it.
    const noRecord = projectScopeTx({ employeeRecord: 'none', assignments: [] })
    const filter = await documentAuthorizationFilter(webCtx('empty'), noRecord)
    expect(filter).toBeDefined()
    // Both layers are present and conjoined: the publication rule AND the denial.
    // The conjunction is what makes the two rules independent — neither replaces
    // the other — and it matches no row, which is the point.
    const { sql } = compile(filter)
    expect(sql).toContain('"documents"."status" = $1')
    expect(sql).toContain('false')
  })

  it('a manager inside a usable scope gets no extra constraint at all', async () => {
    // `documentReadFilter` waives publication and the scope is usable, so there is
    // nothing to add — not `false`, which would hide documents from a manager.
    const filter = await documentAuthorizationFilter(
      webCtx('restricted', ['documents.read', 'documents.manage']),
      tx,
    )
    expect(filter).toBeUndefined()
  })

  it('a manager with an unusable scope is still denied', async () => {
    // The publication waiver must not become a scope bypass. This is the
    // conjunction that makes both layers independent rather than one replacing
    // the other.
    const noRecord = projectScopeTx({ employeeRecord: 'none', assignments: [] })
    const filter = await documentAuthorizationFilter(
      webCtx('empty', ['documents.read', 'documents.manage']),
      noRecord,
    )
    expect(filter).toBeDefined()
    expect(compile(filter).sql).toBe('false')
  })

  it('the publication half is still documentReadFilter, unchanged', () => {
    // The composed rule must not have absorbed or altered the publication rule.
    expect(compile(documentReadFilter(webCtx('restricted'))!).sql).toBe('"documents"."status" = $1')
    expect(documentReadFilter(webCtx('restricted', ['documents.manage']))).toBeUndefined()
  })
})

// ===========================================================================
// 3. Analytics — the exemption
// ===========================================================================

describe('15B-3C documents — analytics exempts the library but still fails closed', () => {
  it('unrestricted -> visible', () => {
    expect(analyticsOutcome('unrestricted')).toBe('VISIBLE')
  })

  it('restricted -> visible, with no row predicate', () => {
    // THE decision, on this side.
    expect(analyticsOutcome('restricted')).toBe('VISIBLE')
  })

  it('empty -> withheld', () => {
    expect(analyticsOutcome('empty')).toBe('WITHHELD')
  })

  it('unknown -> withheld', () => {
    expect(analyticsOutcome('unknown')).toBe('WITHHELD')
  })

  it('losing documents.read withholds it regardless of scope', () => {
    const subject = analyticsScopeSubject(
      {
        isSuperAdmin: false,
        permissions: () => false,
        siteIds: [],
        personId: 'person_1',
        tenantUserId: 'member_1',
      },
      { kind: 'unrestricted' },
    )
    expect(scopeAnalyticsEntities(subject, [documentsEntity()])).toEqual([])
  })

  it('the exemption is named for what it is, and is not the definition one', () => {
    const spec = codeOnly(read('../../../../packages/analytics/src/server/scope.ts'))
    const start = spec.indexOf('\n  documents: {')
    expect(start, 'the TABLE_SCOPE entry for documents').toBeGreaterThan(-1)
    const entry = spec.slice(start + 1, spec.indexOf('\n', start + 1))
    expect(entry).toContain("read: { key: 'documents.read' }")
    expect(entry).toContain("projectScopeExempt: 'tenant-level-document-library'")
    // The org-structure exemption is a different fact and stays separate.
    expect(entry).not.toContain('tenant-level-definition')
  })

  it('documents declares no scope column, so the exemption stays honest', () => {
    const spec = codeOnly(read('../../../../packages/analytics/src/server/scope.ts'))
    const start = spec.indexOf('\n  documents: {')
    const entry = spec.slice(start + 1, spec.indexOf('\n', start + 1))
    expect(entry).not.toContain('siteCols')
    expect(entry).not.toContain('orgUnitCols')
    expect(entry).not.toContain('personCols')
    expect(entry).not.toContain('userCols')
  })
})

// ===========================================================================
// 4. The two halves agree
// ===========================================================================

describe('15B-3C documents — web and analytics express the same rule', () => {
  const ALLOWED: readonly ScopeState[] = ['unrestricted', 'restricted']
  const DENIED: readonly ScopeState[] = ['empty', 'unknown']

  it('the same four states, side by side', () => {
    const table = SCOPE_STATES.map((state) => {
      const web = documentScopeUsable(projectScopeFor(state))
      const analytics = analyticsOutcome(state) === 'VISIBLE'
      return { state, webAllowed: web, analyticsVisible: analytics }
    })
    expect(table).toEqual([
      { state: 'unrestricted', webAllowed: true, analyticsVisible: true },
      { state: 'restricted', webAllowed: true, analyticsVisible: true },
      { state: 'empty', webAllowed: false, analyticsVisible: false },
      { state: 'unknown', webAllowed: false, analyticsVisible: false },
    ])
  })

  it('the allowed and denied sets are the same on both sides', () => {
    for (const state of ALLOWED) {
      expect(documentScopeUsable(projectScopeFor(state)), `web ${state}`).toBe(true)
      expect(analyticsOutcome(state), `analytics ${state}`).toBe('VISIBLE')
    }
    for (const state of DENIED) {
      expect(documentScopeUsable(projectScopeFor(state)), `web ${state}`).toBe(false)
      expect(analyticsOutcome(state), `analytics ${state}`).toBe('WITHHELD')
    }
  })

  it('the disagreement is confined to Project Scope, not to the tenant', () => {
    // Both halves read the same table under the same key, and neither escapes the
    // tenant. So this was always a scope question, never a tenancy or permission
    // one — which is why the fix is a scope rule and nothing else.
    const rls = codeOnly(read('../../../../packages/db/src/rls.ts'))
    expect(rls).toMatch(/^\s*'documents',/m)
  })
})

// ===========================================================================
// 5. Every read surface composes the ONE rule
// ===========================================================================

describe('15B-3C documents — there is a single documents rule, and no second', () => {
  const SURFACES: readonly [string, string][] = [
    ['list', '../app/(app)/documents/page.tsx'],
    ['detail', '../app/(app)/documents/[id]/page.tsx'],
    ['reader', '../app/(app)/documents/[id]/read/page.tsx'],
    ['version download', '../app/(app)/documents/[id]/versions/[versionId]/download/route.ts'],
    ['print/read action', '../app/(app)/documents/[id]/_actions.ts'],
    ['search', '../app/api/search/route.ts'],
    ['assistant tools', '../lib/assistant/tools.ts'],
    ['assistant content', '../lib/assistant/document-content.ts'],
    ['public REST query', '../lib/api/query.ts'],
    ['AI action', '../app/(app)/documents/[id]/_ai-actions.ts'],
    ['in-chat reader action', '../app/(app)/assistant/_document-reader-actions.ts'],
    // The one OUTBOUND surface: it pushes document content to recipients outside
    // the tenant, so it composes the shared rule too. Added by the 15B-3C
    // follow-up that closed the last documents surface left without a gate.
    ['outbound email', '../app/(app)/documents/[id]/_send-email.ts'],
  ]

  it('each of them composes the shared rule', () => {
    for (const [name, rel] of SURFACES) {
      expect(codeOnly(read(rel)), `${name} must compose the shared rule`).toContain(
        'documentAuthorizationFilter(ctx, tx)',
      )
    }
  })

  it('no surface reaches for the publication helper or a scope helper directly', () => {
    // A second ladder is how these drift apart in the first place: a surface that
    // called `documentReadFilter` on its own would silently skip the scope gate.
    for (const [name, rel] of SURFACES) {
      const code = codeOnly(read(rel))
      expect(code, `${name} must not call documentReadFilter directly`).not.toContain(
        'documentReadFilter(ctx)',
      )
      expect(code, `${name} must not call documentScopeUsable directly`).not.toContain(
        'documentScopeUsable(',
      )
    }
  })

  it('only the shared rule itself calls the publication helper', () => {
    const rule = codeOnly(read('./assistant/document-project-scope.ts'))
    expect(rule).toContain('documentReadFilter(ctx)')
  })

  it('the four-state decision exists in exactly one place', () => {
    // The decision is `documentScopeUsable`. If a surface ever re-derived it, the
    // two halves could agree today and drift tomorrow.
    const rule = codeOnly(read('./assistant/document-project-scope.ts'))
    expect(rule).toContain('function documentScopeUsable(')
    for (const [name, rel] of SURFACES) {
      expect(codeOnly(read(rel)), `${name}`).not.toContain('kind !== ')
    }
  })

  it('the surfaces gated on documents.manage need no publication predicate', () => {
    // These are narrower than a reader can reach, so they add nothing of their own.
    for (const rel of [
      '../app/(app)/documents/[id]/pdf/route.ts',
      '../app/(app)/documents/[id]/master/route.ts',
      '../app/(app)/documents/export.csv/route.ts',
    ]) {
      expect(codeOnly(read(rel)), rel).toContain("assertCan(ctx, 'documents.manage')")
    }
  })
})

// ===========================================================================
// 6. The schema admits no binding — and must not grow one silently
// ===========================================================================

describe('15B-3C documents — the table still exposes no scope binding', () => {
  it('has no person, site, org-unit, project, parent or metadata column', () => {
    // Read from the real Drizzle table via its own column accessor, so adding one
    // of these fails the test. `Object.keys` is not used: a table object also
    // carries non-column members such as `enableRLS`.
    const cols = Object.keys(getTableColumns(documents))
    for (const absent of [
      'personId',
      'siteOrgUnitId',
      'orgUnitId',
      'projectId',
      'parentId',
      'metadata',
    ]) {
      expect(cols, `documents must not grow a ${absent} binding`).not.toContain(absent)
    }
  })

  it('its real columns are unchanged by the decision', () => {
    expect(Object.keys(getTableColumns(documents)).sort()).toEqual(
      [
        'categoryId',
        'createdAt',
        'deletedAt',
        'description',
        'id',
        'key',
        'nextReviewOn',
        'ownerTenantUserId',
        'reviewFrequencyMonths',
        'sourceAttachmentId',
        'status',
        'tenantId',
        'title',
        'typeId',
        'updatedAt',
      ].sort(),
    )
  })

  it('ownerTenantUserId exists, is optional, and is NOT a scope', () => {
    // The one column that superficially looks like a binding. It is nullable
    // authorship. The decision did not promote it, and the spec binds on no owner
    // column — pinned above and here.
    const owner = documents.ownerTenantUserId
    expect(owner).toBeDefined()
    expect(owner.notNull).toBe(false)

    const spec = codeOnly(read('../../../../packages/analytics/src/server/scope.ts'))
    const start = spec.indexOf('\n  documents: {')
    const entry = spec.slice(start + 1, spec.indexOf('\n', start + 1))
    expect(entry).not.toContain('userCols')
  })

  it('the person and site columns that DO exist belong to interaction records', () => {
    // Not to the document itself. `document_acknowledgments.person_id` records
    // that someone acknowledged a version, and
    // `document_acknowledgment_sessions.site_org_unit_id` records where a sign-off
    // session was held. Neither is the document's classification, which is why the
    // decision introduced a binding rather than borrowing one of these.
    const schema = read('../../../../packages/db/src/schema/documents.ts')
    const acks = schema.slice(
      schema.indexOf('export const documentAcknowledgments ='),
      schema.indexOf('export const documentReviewOutcome'),
    )
    expect(acks).toContain("personId: uuid('person_id').notNull()")

    const sessions = schema.slice(
      schema.indexOf('export const documentAcknowledgmentSessions ='),
      schema.indexOf('export const documentAcknowledgments ='),
    )
    expect(sessions).toContain("siteOrgUnitId: uuid('site_org_unit_id')")

    const table = schema.slice(
      schema.indexOf('export const documents ='),
      schema.indexOf('export const documentVersions ='),
    )
    expect(table).not.toContain('person_id')
    expect(table).not.toContain('site_org_unit_id')
  })
})
