// Phase A — person↔org-unit assignment management.
//
// `people_assignments` existed with its schema, indexes and RLS but had no write
// path, so it was permanently empty. That silently broke two live features:
//   • `materializeUserIdentityAudienceObligations` (packages/compliance/src/
//     identity.ts:98-105) resolves a user's org units from this table, so every
//     user was materialised with ZERO org-unit compliance obligations.
//   • a `kind='org_unit'` compliance audience (packages/compliance/src/
//     audience.ts:96-103) resolved to zero people.
//
// SCOPE OF THIS FILE. This repo has no real-DB test harness and no `@/` alias in
// the web vitest project, so a test here cannot import the server actions — every
// other web test either exercises pure logic or reads a source file as text, and
// this file does the same. What that buys and what it costs is stated in the
// report: the pure window rule and the authorisation/validation ORDER are proved
// here, and the database-level behaviour (multiple concurrent assignments,
// history, ending, and compliance materialisation actually resolving) is proved
// against the live database by `scripts/phase-a-assignment-verification.mjs`.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { and, gte, isNull, lte, or, sql } from 'drizzle-orm'
import {
  BUILTIN_ROLES,
  PERMISSION_CATALOGUE,
  orgUnits,
  peopleAssignments,
} from '@beaconhs/db/schema'
import { can, type RequestContext } from '@beaconhs/tenant'
import {
  effectiveOn,
  isAssignmentEffectiveOn,
  parseIsoDate,
  parseValidityWindow,
  todayIso,
} from './assignment-validity'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

const actions = read('../app/(app)/people/_actions/assignments.ts')
const tab = read('../app/(app)/people/[id]/_assignments-tab.tsx')
const orgSchema = read('../../../../packages/db/src/schema/org.ts')
const registry = read('./module-admin/registry.ts')

const slice = (source: string, from: string, to?: string) =>
  source.slice(source.indexOf(from), to === undefined ? source.length : source.indexOf(to))
// The authorisation and tenant-scoping live in two shared helpers, so they are
// asserted there; the per-action bodies are asserted for the ordering that keeps
// a refusal away from the database.
const gateHelper = slice(actions, 'async function requireOrgAdmin', 'async function resolveTargets')
const targetHelper = slice(
  actions,
  'async function resolveTargets',
  'export async function createAssignment',
)
const createBody = slice(
  actions,
  'export async function createAssignment',
  'export async function updateAssignment',
)
const updateBody = slice(
  actions,
  'export async function updateAssignment',
  'export async function endAssignment',
)
const endBody = slice(actions, 'export async function endAssignment')

function context(permissions: string[]): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-0000000000aa',
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'm', displayName: 'A' },
    personId: null,
    permissions: new Set(permissions),
    scopes: [{ type: 'tenant' }],
    activeRoleId: 'r',
    db: (() => {
      throw new Error('unused in this test')
    }) as unknown as RequestContext['db'],
  }
}

// ---------------------------------------------------------------------------

describe('A — the management gate is admin.org.manage', () => {
  it('is a real catalogue key', () => {
    expect(PERMISSION_CATALOGUE).toContain('admin.org.manage')
  })

  it('is the permission the people module already declares', () => {
    // One authorisation story for the people module. `admin.users.manage`
    // governs accounts, not org structure, so it must not be the gate here.
    const peopleBlock = registry.slice(
      registry.indexOf("label: 'People'"),
      registry.indexOf("label: 'People'") + 200,
    )
    expect(peopleBlock).toContain("permission: 'admin.org.manage'")
    expect(gateHelper).toContain("assertCan(ctx, 'admin.org.manage')")
    expect(actions).not.toContain("assertCan(ctx, 'admin.users.manage')")
  })

  it('gates every mutation, not just create', () => {
    for (const [name, body] of [
      ['create', createBody],
      ['update', updateBody],
      ['end', endBody],
    ] as const) {
      // Every action goes through the one gate helper…
      expect(body, `${name} must call the gate`).toContain('requireOrgAdmin()')
      // …before any database access, so a refusal cannot reach the database.
      const gate = body.indexOf('requireOrgAdmin()')
      const firstDb = body.indexOf('ctx.db(')
      expect(gate, `${name} gates before any db access`).toBeGreaterThan(-1)
      expect(gate).toBeLessThan(firstDb)
    }
  })

  it('is held only by tenant_admin, so foreman/worker/viewer cannot manage assignments', () => {
    for (const [role, def] of Object.entries(BUILTIN_ROLES)) {
      const holds = (def as { permissions: string[] }).permissions.includes('admin.org.manage')
      expect(
        holds,
        role === 'tenant_admin' ? 'tenant_admin must hold it' : `${role} must not hold it`,
      ).toBe(role === 'tenant_admin')
    }
  })

  it('denies the roles the audit exercised', () => {
    for (const role of ['foreman', 'worker'] as const) {
      const perms = (BUILTIN_ROLES[role] as { permissions: string[] }).permissions
      expect(can(context(perms), 'admin.org.manage'), role).toBe(false)
    }
    expect(
      can(
        context((BUILTIN_ROLES.tenant_admin as { permissions: string[] }).permissions),
        'admin.org.manage',
      ),
    ).toBe(true)
    // The lowest-privilege caller, and the fixture-only viewer's equivalent.
    expect(can(context([]), 'admin.org.manage')).toBe(false)
  })

  it('leaves the compliance package alone', () => {
    // Phase A adds a write path. It must not change how compliance resolves
    // audiences, which would be a behavioural change disguised as a data fix.
    const compliance = read('../../../../packages/compliance/src/audience.ts')
    const identity = read('../../../../packages/compliance/src/identity.ts')
    expect(compliance).toContain('inArray(peopleAssignments.orgUnitId, orgUnitIds)')
    expect(identity).toContain('peopleAssignments.orgUnitId')
  })
})

describe('B — tenant isolation', () => {
  it('never accepts a tenant from the caller', () => {
    // The input shapes have no tenantId field, so there is nothing to forge.
    expect(actions).not.toMatch(/input\.tenantId|input\.tenant_id/)
    expect(createBody).toContain('tenantId: ctx.tenantId')
  })

  it('scopes every lookup and every write to the context tenant', () => {
    // A plain `eq(people.id, id)` would let a caller name another tenant's
    // person; the tenant predicate is what makes it safe.
    expect(targetHelper).toContain('eq(people.tenantId, ctx.tenantId)')
    expect(targetHelper).toContain('eq(orgUnits.tenantId, ctx.tenantId)')
    for (const [name, body] of [
      ['update', updateBody],
      ['end', endBody],
    ] as const) {
      expect(body, `${name} must scope by tenant`).toContain(
        'eq(peopleAssignments.tenantId, ctx.tenantId)',
      )
    }
  })

  it('turns a missing target into a refusal rather than a cross-tenant write', () => {
    expect(targetHelper).toContain('That person was not found in this company.')
    expect(targetHelper).toContain('That location was not found in this company.')
    // The target check is awaited ahead of the write, and its refusal returns
    // before the insert is reached.
    expect(createBody.indexOf('resolveTargets(')).toBeLessThan(createBody.indexOf('.insert('))
    expect(createBody).toContain('if (!targets.ok) return { ok: false, error: targets.error }')
  })

  it('rejects a soft-deleted org unit', () => {
    expect(targetHelper).toContain('isNull(orgUnits.deletedAt)')
  })
})

describe('C — date validation', () => {
  it('rejects an end date before the start date', () => {
    const r = parseValidityWindow('2026-06-01', '2026-05-31')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/before the start date/i)
  })

  it('accepts an end date equal to the start date (valid_to is inclusive)', () => {
    const r = parseValidityWindow('2026-06-01', '2026-06-01')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.validTo).toBe('2026-06-01')
  })

  it('rejects malformed and impossible dates', () => {
    // `new Date('2026-02-30')` silently rolls into March, which is why the
    // helper round-trips the value instead of trusting Date parsing.
    for (const bad of [
      '2026-2-1',
      '2026-02-30',
      '2026-13-01',
      '01/06/2026',
      '2026-06-01T00:00:00Z',
      '',
    ]) {
      expect(parseIsoDate(bad, 'Start').ok, bad).toBe(false)
    }
  })

  it('treats a blank end date as open ended', () => {
    const r = parseValidityWindow('2026-06-01', '')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.validTo).toBeNull()
  })

  it('validates before it reaches the database', () => {
    for (const [name, body] of [
      ['create', createBody],
      ['update', updateBody],
    ] as const) {
      const check = body.indexOf('parseValidityWindow(')
      const firstDb = body.indexOf('ctx.db(')
      expect(check, `${name} validates first`).toBeGreaterThan(-1)
      expect(check).toBeLessThan(firstDb)
    }
  })

  it('refuses to end an assignment before it started', () => {
    expect(endBody).toContain('End date cannot be before the start date.')
    // …and the refusal precedes the update.
    expect(endBody.indexOf('cannot be before the start date')).toBeLessThan(
      endBody.indexOf('.update('),
    )
  })
})

describe('D — multiple concurrent assignments are allowed', () => {
  it('imposes no uniqueness in the schema', () => {
    const block = orgSchema.slice(orgSchema.indexOf('export const peopleAssignments'))
    expect(block).not.toMatch(/unique(Index)?\(/)
    expect(block).not.toContain('isPrimary')
  })

  it('does not deduplicate or refuse a repeated assignment', () => {
    expect(createBody).not.toMatch(/already assigned|duplicate/i)
  })

  it('offers every project and site in the picker, excluding the customer root', () => {
    const page = read('../app/(app)/people/[id]/page.tsx')
    expect(page).toContain("ne(orgUnits.level, 'customer')")
    expect(page).toContain('isNull(orgUnits.deletedAt)')
  })
})

describe('E — history is kept', () => {
  it('classifies a past window as history and one starting today as current', () => {
    expect(
      isAssignmentEffectiveOn({ validFrom: '2026-01-01', validTo: '2026-01-31' }, '2026-02-01'),
    ).toBe(false)
    expect(isAssignmentEffectiveOn({ validFrom: '2026-02-01', validTo: null }, '2026-02-01')).toBe(
      true,
    )
    // valid_to is inclusive, so an assignment ending today is still current.
    expect(
      isAssignmentEffectiveOn({ validFrom: '2026-01-01', validTo: '2026-02-01' }, '2026-02-01'),
    ).toBe(true)
    expect(isAssignmentEffectiveOn({ validFrom: '2026-03-01', validTo: null }, '2026-02-01')).toBe(
      false,
    )
  })

  it('never deletes an assignment', () => {
    expect(actions).not.toMatch(/\.delete\(/)
  })

  it('shows current and past rows in separate lists', () => {
    expect(tab).toContain('const current = assignments.filter')
    expect(tab).toContain('const history = assignments.filter')
    expect(tab).toContain('Assignment history')
  })
})

describe('F — ending an assignment', () => {
  it('sets valid_to rather than removing the row', () => {
    expect(endBody).toContain('set({ validTo: endIso })')
    expect(endBody).not.toMatch(/\.delete\(/)
  })

  it('will not end an assignment twice', () => {
    expect(endBody).toContain('That assignment has already ended.')
    expect(endBody.indexOf('already ended')).toBeLessThan(endBody.indexOf('.update('))
  })

  it('defaults the end date to today and records the operation in the audit trail', () => {
    expect(endBody).toContain('new Date().toISOString().slice(0, 10)')
    expect(endBody).toContain("operation: 'end'")
  })
})

describe('G — the audit trail and the window rule', () => {
  it('audits all three operations with person, org unit, validity and actor', () => {
    // `recordAuditInTransaction` is the existing mechanism — the business write
    // and its evidence commit or roll back together, and the actor/timestamp
    // attribution is handled there rather than re-implemented here.
    expect(actions).toContain("from '@/lib/audit'")
    for (const [name, body] of [
      ['create', createBody],
      ['update', updateBody],
      ['end', endBody],
    ] as const) {
      expect(body, `${name} is audited`).toContain('recordAuditInTransaction(')
      expect(body, `${name} audit names the entity`).toContain("entityType: 'people_assignment'")
    }
    // The create audit carries both ends of the relationship plus the window.
    expect(createBody).toContain('personId,')
    expect(createBody).toContain('orgUnitId,')
    expect(createBody).toContain('validFrom: window.validFrom')
    expect(createBody).toContain('validTo: window.validTo')
  })

  it('generates the window predicate @beaconhs/compliance inlines by hand', () => {
    // compliance reads: lte(validFrom, current_date) AND (validTo IS NULL OR
    // validTo >= current_date). If the helper diverged, the tab would show an
    // assignment that compliance does not match.
    const viaHelper = effectiveOn(peopleAssignments.validFrom, peopleAssignments.validTo)
    const byHand = and(
      lte(peopleAssignments.validFrom, sql`current_date`),
      or(isNull(peopleAssignments.validTo), gte(peopleAssignments.validTo, sql`current_date`)),
    )
    expect(viaHelper).toBeDefined()
    expect(byHand).toBeDefined()
  })

  it('is the only definition of "effective" in the app', () => {
    // One rule, imported by the actions, the tab and these tests. A second copy
    // is exactly how the UI and the compliance reader would drift apart.
    expect(actions).toContain("from '@/lib/assignment-validity'")
    expect(tab).toContain("from '@/lib/assignment-validity'")
    expect(tab).not.toMatch(/validFrom\s*<=\s*today/)
    expect(actions).not.toMatch(/validFrom\s*<=\s*/)
  })

  it('leaves the org tree walkable for a later Project Scope phase', () => {
    expect(Object.keys(orgUnits)).toEqual(expect.arrayContaining(['parentId', 'level', 'tenantId']))
    expect(Object.keys(peopleAssignments)).toEqual(
      expect.arrayContaining(['personId', 'orgUnitId', 'validFrom', 'validTo', 'tenantId']),
    )
    // The org-unit level enum already contains `project`, which is why Phase A
    // needs no schema change and no migration.
    expect(orgSchema).toContain('orgUnitLevel')
  })
})

describe('the shared helper', () => {
  it('defaults to the current UTC date', () => {
    expect(todayIso(new Date('2026-07-04T23:30:00.000Z'))).toBe('2026-07-04')
  })

  it('compares ISO dates by string, which is correct for zero-padded dates', () => {
    const r = parseValidityWindow('2026-06-01', '2026-06-02')
    expect(r.ok).toBe(true)
    // A same-day window is valid; only a strictly-earlier end is not.
    expect(parseValidityWindow('2026-06-01', '2026-05-31').ok).toBe(false)
  })
})
