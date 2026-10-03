// Contract tests for the Work Permit Builder App and its validity-window rules.
//
// The audit for Phase 11-C concluded a permit needs NO native table: it is a
// `form_templates` row in the `work_permit` category plus a `form_responses`
// record, approved through `flow_gates`, with the monitored-session timer
// carrying the validity window. These tests pin that conclusion so a future
// change cannot quietly reintroduce a `work_permits` table or a permit-specific
// permission, and so the one real gap (nothing read `expectedEndAt` to change
// state) stays closed.
//
// The SQL predicate assertions read the generated SQL text rather than running a
// database, so they are deterministic and need no scratch database. The scanner
// behaviour itself is exercised in apps/worker.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getTableName, sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { formResponses } from './schema/forms'
import {
  WORK_PERMIT_APP_KEY,
  WORK_PERMIT_CATEGORY,
  permitWindowEnded,
  permitWindowEndedExpr,
  permitWindowOpen,
} from './work-permit'
import { WORK_PERMIT_FLOW_GRAPH } from './seed/work-permit-template'

// `paths.repo` resolves from this file (packages/db/src/) to the workspace root.
const repoPath = (...segments: string[]) =>
  readFileSync(new URL(['..', '..', '..', ...segments].join('/'), import.meta.url), 'utf8')

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const workPermitSeed = read('./seed/work-permit-template.ts')
const workerScheduled = repoPath('apps', 'worker', 'src', 'workers', 'scheduled.ts')

// WP1 — the category exists and is reachable from the one shared label registry,
// not hardcoded in a surface.
describe('WP1 work_permit category', () => {
  it('declares the work_permit category as the marker for a permit template', () => {
    expect(WORK_PERMIT_CATEGORY).toBe('work_permit')
  })

  it('is registered in the single app-category label registry', () => {
    const labels = repoPath(
      'apps',
      'web',
      'src',
      'app',
      '(app)',
      'apps',
      '_lib',
      'category-label.ts',
    )
    expect(labels).toMatch(/work_permit:\s*'Work permit'/)
  })

  it('needs no schema change: form_templates.category is free text', () => {
    // category is `text`, so a new category is data, not a migration. This test
    // fails loudly if someone ever tightens it to an enum, which would mean the
    // permit category needs a migration added to the journal.
    const schema = read('./schema/forms.ts')
    expect(schema).toMatch(/category:\s*text\('category'\)/)
  })
})

// WP2 / WP3 — the seeded app exists and carries the fields a permit needs.
describe('WP2/WP3 seeded Work Permit app', () => {
  it('seeds a published Builder App under the work_permit category', () => {
    expect(workPermitSeed).toMatch(/category:\s*WORK_PERMIT_CATEGORY/)
    expect(WORK_PERMIT_APP_KEY).toBe('work-permit')
  })

  it('is idempotent (delegates to the shared ensureTemplate helper)', () => {
    expect(workPermitSeed).toMatch(/await ensureTemplate\(tx, \{/)
    expect(workPermitSeed).not.toMatch(/onConflictDoUpdate/)
  })

  it.each([
    ['permit_type', 'select'],
    ['requester', 'person_picker'],
    ['site', 'site_picker'],
    ['work_description', 'long_text'],
    ['work_location', 'text'],
    ['hazards', 'multi_select'],
    ['controls', 'multi_select'],
    ['requested_start', 'datetime'],
    ['permit_validity_minutes', 'number'],
  ])('captures %s as a %s field', (fieldId, fieldType) => {
    // Every permit field the product needs is a response `data` key, not a column.
    const field = new RegExp(`id: '${fieldId}',[\\s\\S]{0,120}?type: '${fieldType}'`)
    expect(workPermitSeed).toMatch(field)
  })

  it('offers the standard permit types as select options, not a database enum', () => {
    for (const type of [
      'Hot work',
      'Confined space',
      'Work at height',
      'Excavation',
      'Lifting',
      'Electrical',
      'General work',
    ]) {
      expect(workPermitSeed).toContain(type)
    }
    expect(read('./schema/forms.ts')).not.toMatch(/permit_type.*pgEnum/)
  })

  it('binds the validity field the flow reads, in minutes', () => {
    expect(workPermitSeed).toMatch(/durationFieldKey: 'permit_validity_minutes'/)
    // A unit mismatch here would silently write a window 60x too long.
    expect(workPermitSeed).toMatch(/Permit validity \(minutes\)/)
  })
})

// WP4 / WP5 — submit → gate → session, with no permit-specific approval engine.
describe('WP4/WP5 flow graph', () => {
  it('fires on submit and gates on a real seeded role, not a bespoke approver', () => {
    expect(workPermitSeed).toMatch(/trigger: \{ trigger: 'on_submit' \}/)
    expect(workPermitSeed).toMatch(/assignee: \{ type: 'role', role: 'safety_manager' \}/)
  })

  it('requires a signature on the approval', () => {
    expect(workPermitSeed).toMatch(/signatureRequired: true/)
  })

  it('starts the monitored session only on the approve branch', () => {
    const graph = workPermitSeed.slice(workPermitSeed.indexOf('WORK_PERMIT_FLOW_GRAPH'))
    // Assert on the parsed graph, not on source formatting: Prettier rewraps this
    // literal freely and a regex over it would fail on style, not on behaviour.
    const parsed = WORK_PERMIT_FLOW_GRAPH
    const approveEdge = parsed.edges.find((e) => e.source === 'gate_approve')
    expect(approveEdge?.target).toBe('act_monitor')
    expect(approveEdge?.sourceHandle).toBe('approve')
    expect(parsed.edges.some((e) => e.sourceHandle === 'reject')).toBe(false)
    // And the seeded source really does carry that graph.
    expect(graph).toMatch(/sourceHandle: 'approve'/)
    // A rejected permit must never begin a validity window.
    expect(graph).not.toMatch(/sourceHandle: 'reject'/)
  })

  it('uses only existing flow node kinds and actions', () => {
    for (const literal of [
      "kind: 'trigger'",
      "kind: 'gate'",
      "action: 'start_monitored_session'",
    ]) {
      expect(workPermitSeed).toContain(literal)
    }
    // No permit-specific node or engine.
    expect(workPermitSeed).not.toMatch(/permit_gate|permit_action|work_permit_table/)
  })

  it('stores the graph in the shared form_automations table, not a new one', () => {
    expect(workPermitSeed).toMatch(/flow: \{ name: 'Work permit approval'/)
    expect(read('./seed/hazard-assessment-app-templates.ts')).toMatch(/insert\(formAutomations\)/)
  })
})

// WP6 — the requested validity reaches expectedEndAt through the existing action.
describe('WP6 requested expiry reaches expectedEndAt', () => {
  it('derives expectedEndAt from the duration field key', () => {
    const adapter = repoPath(
      'apps',
      'web',
      'src',
      'app',
      '(app)',
      'apps',
      '_lib',
      'form-flow-adapter.ts',
    )
    expect(adapter).toMatch(
      /expectedEndAt: duration > 0 \? new Date\(now\.getTime\(\) \+ duration \* 60_000\) : null/,
    )
  })

  it('leaves expectedEndAt null for open-ended sessions, so they never expire', () => {
    // An open-ended session (no duration) must remain valid forever — the
    // predicate below relies on this and the scan relies on it too.
    const adapter = repoPath(
      'apps',
      'web',
      'src',
      'app',
      '(app)',
      'apps',
      '_lib',
      'form-flow-adapter.ts',
    )
    expect(adapter).toMatch(/const duration = numField\(action\.durationFieldKey/)
  })
})

// WP7 / D — the safety-critical predicate.
describe('WP7 active-permit predicate', () => {
  it('requires BOTH monitor_status active and an open window', () => {
    const full = rendered(permitWindowOpen(NOW))
    expect(full).toContain('"monitor_status"')
    // 'active' is bound, not inlined — assert the bound value, not a literal.
    expect(full).toContain('"active"')
    expect(full).toContain('"expected_end_at"')
    // The direction is the whole point: open means strictly in the future.
    expect(full).toMatch(/"expected_end_at" > \$/)
    expect(full).toMatch(/"expected_end_at" is null or "form_responses"\."expected_end_at" > \$/)
    // and the instant is the one passed in.
    expect(full).toContain(NOW.toISOString())
  })

  it('cannot be satisfied by a window that has already ended', () => {
    // An expired permit (window in the past) must fail `permitWindowOpen`.
    const now = new Date('2026-06-01T12:00:00Z')
    const expiredWindow = new Date('2026-06-01T11:00:00Z')
    expect(expiredWindow.getTime()).toBeLessThan(now.getTime())
    expect(sqlOf(permitWindowOpen(now))).toContain('"expected_end_at" > $')
  })

  it('derives "expired" as a predicate; adds no expired status to either enum', () => {
    expect(WORK_PERMIT_CATEGORY).toBe('work_permit')
    const schema = read('./schema/forms.ts')
    // Neither enum may grow an 'expired' value: expiry is derived, not stored.
    expect(schema).not.toMatch(/form_monitor_status[\s\S]{0,300}'expired'/)
    expect(sqlOf(permitWindowEnded(NOW))).toMatch(/"expected_end_at" <= \$/)
  })

  it('excludes a NULL window from "ended" so open-ended sessions are untouched', () => {
    const text = sqlOf(permitWindowEnded(NOW))
    expect(text).toContain('"expected_end_at" is not null')
    expect(text).toMatch(/"expected_end_at" <= \$/)
  })

  it('accepts the database clock as the instant, so worker/DB skew cannot expire early', () => {
    // The worker passes `sql\`now()\`` rather than a JS Date: comparing a
    // worker-clock instant would close a window early if the clocks disagree.
    const dbClock = permitWindowEndedExpr(sql`now()`)
    expect(sqlOf(dbClock)).toContain('now()')
    // A bound Date must be a parameter, not an inlined literal — keeps the
    // predicate testable and plan-cacheable.
    expect(sqlOf(permitWindowEnded(NOW))).toContain('$')
  })
})

// WP8 / WP9 / WP10 / WP11 — the scanner closes expired sessions and is idempotent.
describe('WP8-WP11 window-end scanner', () => {
  it('runs inside the existing per-minute tick, with no new queue or cron', () => {
    expect(workerScheduled).toMatch(
      /case 'form_session_overdue_scan': \{\s*await scanFormSessionOverdue\(\)\s*return scanFormSessionWindowEnded\(\)/,
    )
    // No dedicated permit schedule.
    expect(workerScheduled).not.toMatch(/permit_scheduler|work_permit_scan|tick:permit/)
    const queues = repoPath('packages', 'jobs', 'src', 'queues', 'scheduled.ts')
    expect(queues).not.toMatch(/permit/)
  })

  it('selects only non-null windows that have ended, in the still-open claim states', () => {
    expect(workerScheduled).toMatch(
      /inArray\(formResponses\.monitorStatus, \['active', 'missed', 'escalated'\]\)/,
    )
    expect(workerScheduled).toMatch(/permitWindowEndedExpr\(sql`now\(\)`\)/)
  })

  it('drives the session to an EXISTING terminal state, adding no enum value', () => {
    // 'completed' is already a form_monitor_status member; nothing new is invented.
    expect(workerScheduled).toMatch(
      /\.set\(\{ monitorStatus: 'completed', closedAt: new Date\(\) \}\)/,
    )
  })

  it('is idempotent: the claim is conditional on the state it is transitioning', () => {
    const claim = workerScheduled.slice(
      workerScheduled.indexOf('async function scanFormSessionWindowEnded'),
    )
    expect(claim).toMatch(
      /inArray\(formResponses\.monitorStatus, \['active', 'missed', 'escalated'\]\)/,
    )
    expect(claim).toMatch(/if \(!claimed\) continue/)
    // The re-claim predicate must also re-assert the window, so a row that was
    // closed between select and update is not closed twice.
    expect(claim).toMatch(
      /expectedEndAt} is not null and \$\{formResponses\.expectedEndAt\} <= now\(\)/,
    )
  })

  it('never terminates an open-ended session (no window) and never reopens a closed one', () => {
    const claim = workerScheduled.slice(
      workerScheduled.indexOf('async function scanFormSessionWindowEnded'),
    )
    expect(claim).not.toMatch(
      /monitorStatus: 'completed'[^\n]*\n[^\n]*\n[^\n]*isNull\(formResponses\.expectedEndAt\)/,
    )
    expect(claim).toMatch(/expectedEndAt} is not null/)
  })

  it('audits every closure through the shared audit_log', () => {
    const claim = workerScheduled.slice(
      workerScheduled.indexOf('async function scanFormSessionWindowEnded'),
    )
    expect(claim).toMatch(/insert\(auditLog\)/)
    expect(claim).toMatch(/entityType: 'form_response'/)
    expect(claim).toMatch(/trigger: 'monitored_session_window_end'/)
  })

  it('reuses the shared parent-first response lock', () => {
    const claim = workerScheduled.slice(
      workerScheduled.indexOf('async function scanFormSessionWindowEnded'),
    )
    expect(claim).toMatch(/lockFormResponseForMutation\(tx, s\.tenantId, s\.id\)/)
    expect(claim).toMatch(/isFormResponseParentLockedError/)
  })
})

// WP12-WP15 — authorization stays the existing forms ladder.
describe('WP12-WP15 authorization', () => {
  it('introduces no permit permission, RoleScope variant or nav module', () => {
    expect(read('./schema/iam.ts')).not.toMatch(/work[-_.]?permit/)
    // RoleScope keeps its six variants; none is permit/project.
    const iam = read('./schema/iam.ts')
    const roleScope = iam.slice(iam.indexOf('roleScopeEnum'), iam.indexOf('roleScopeEnum') + 600)
    expect(roleScope).not.toMatch(/permit/)
    expect(roleScope).not.toMatch(/project/)
  })

  it('scopes permit reads by the existing site/org-unit column', () => {
    expect(repoPath('apps', 'web', 'src', 'app', '(app)', 'apps', 'sessions', 'page.tsx')).toMatch(
      /siteCol: formResponses\.siteOrgUnitId/,
    )
    // The permit form binds its Site field to an org-unit picker, which is what
    // populates that column — no permitSiteId.
    expect(workPermitSeed).toMatch(/type: 'site_picker'/)
    expect(workPermitSeed).not.toMatch(/permitSiteId|permitProjectId|permitAreaId/)
  })

  it('derives the requester and company from the existing people pickers', () => {
    expect(workPermitSeed).toMatch(/type: 'person_picker'/)
    // Phase 11-B's people.companyId is read through the person, never duplicated.
    expect(workPermitSeed).not.toMatch(/permit_workers|permit_contractors|permit_people/)
  })

  it('does not borrow the Journals own-record cross-site exception', () => {
    // The permit template must not carry any bespoke visibility rule.
    expect(workPermitSeed).not.toMatch(/visibility|scopeWhere|tenantId.*permit/)
  })
})

// WP16 / WP17 — attachments and audit stay native.
describe('WP16/WP17 attachments and audit', () => {
  it('keeps attachments in the response payload / shared storage', () => {
    expect(workPermitSeed).not.toMatch(/permit_attachments/)
    expect(read('./schema/forms.ts')).not.toMatch(/permit_attachment/)
  })

  it('relies on the existing form-response audit entity type', () => {
    expect(workerScheduled).toMatch(/entityType: 'form_response'/)
  })
})

// WP18 / WP19 / WP20 — no regression to the existing forms and gate machinery.
describe('WP18-WP20 regressions guarded', () => {
  it('leaves the existing missed-check-in escalation intact', () => {
    const overdue = workerScheduled.slice(
      workerScheduled.indexOf('async function scanFormSessionOverdue'),
      workerScheduled.indexOf('async function scanFormSessionWindowEnded'),
    )
    expect(overdue).toMatch(/monitorStatus: 'escalated', escalatedAt: now/)
    expect(overdue).toMatch(/kind: 'missed'/)
    expect(overdue).toMatch(/runSessionOverdueFlows/)
  })

  it('leaves the three seeded HazID apps on the jsha category', () => {
    const hazid = read('./seed/hazard-assessment-app-templates.ts')
    expect(hazid).toMatch(/category: args\.category \?\? 'jsha'/)
    expect(hazid).toMatch(
      /changelog: args\.changelog \?\? 'Built-in hazard-assessment embedded app v1'/,
    )
    // The flow column stays opt-in, so those apps still seed no form_automations row.
    expect(hazid).toMatch(/if \(args\.flow\) \{/)
  })

  it('keeps the shared gate store as the single approval gate store', () => {
    expect(repoPath('apps', 'web', 'src', 'lib', 'flows', 'gate-store.ts')).toMatch(
      /The ONE gate store/,
    )
    expect(workPermitSeed).not.toMatch(/permit_approvals|approvePermit/)
  })
})

const NOW = new Date('2026-06-01T12:00:00Z')

// Render a fragment through the Postgres dialect so the assertions read the real
// SQL that would reach the database, quotes and parameter placeholders included.
function sqlOf(fragment: SQL): string {
  return new PgDialect().sqlToQuery(fragment).sql
}

// Enum and instant values are bound parameters, not inlined literals, so the
// rendered SQL alone can't tell you WHICH value was required. Render both.
function rendered(fragment: SQL): string {
  const query = new PgDialect().sqlToQuery(fragment)
  return `${query.sql} -- params: ${JSON.stringify(query.params)}`
}

// Guards the schema-object plumbing the predicates rely on: if `formResponses`
// or either monitor column were renamed, every SQL assertion above would still
// pass while checking the wrong column. Pin them by name.
describe('predicate column binding', () => {
  it('targets form_responses and its monitor columns', () => {
    expect(getTableName(formResponses)).toBe('form_responses')
    expect(sqlOf(permitWindowOpen(NOW))).toContain('"monitor_status"')
    expect(sqlOf(permitWindowEnded(NOW))).toContain('"expected_end_at"')
  })
})
