// Contract: a record's Location must be written to BOTH places it lives in.
//
// A form response carries its site twice — as the `site_org_unit_id` column that
// every site-scoped query filters on, and as the `site` field of the response
// payload when the template's schema declares one. `validateResponse` reads only
// the payload and has no access to the column, and `responsePayload` spreads
// draft values over `data`, so each surface can shadow the other.
//
// The bug this pins: the header Location control wrote the column only. A template
// with a required Site field (Work Permit, Environmental Monitoring Log, Statutory
// Compliance Register) could then never be finalized — every Submit redirected to
// `?finalizeError=1` and the record stayed `in_progress` forever.
//
// Structural assertions read the action source: the SQL is not exercised here
// because these actions run inside a request context.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const fillActions = source('../../app/(app)/apps/templates/[id]/fill/actions.ts')
const finalize = source('../../app/(app)/apps/responses/[id]/_lifecycle-actions.ts')
const responsePayload = source('../../app/(app)/apps/_lib/response-payload.ts')
const entityAttrs = source('../../../../../packages/forms-core/src/entity-attrs.ts')

const locationBody = (() => {
  const start = fillActions.indexOf('export async function setResponseLocation')
  expect(start).toBeGreaterThan(-1)
  return fillActions.slice(start, fillActions.indexOf('\nexport ', start + 10))
})()

describe('record Location is mirrored into the response payload', () => {
  it('writes the column AND the payload in one guarded action', () => {
    expect(locationBody).toContain('siteOrgUnitId: parsed.data.siteOrgUnitId')
    // The payload mirror, not just the column.
    expect(locationBody).toContain("ARRAY['site']::text[]")
    expect(locationBody).toContain('patch.data')
  })

  it('mirrors only when the template schema actually declares a site field', () => {
    // A template with no `site` field must be left alone: there the column is the
    // single source of truth and inventing a payload key would be noise.
    expect(locationBody).toContain('schemaHasSiteField')
    expect(locationBody).toContain('formTemplateVersions.templateId, row.templateId')
    expect(locationBody).toMatch(/f\.id === 'site'/)
    expect(locationBody).toContain('isNotNull(formTemplateVersions.publishedAt)')
    expect(locationBody).toContain("eq(formTemplates.status, 'published')")
  })

  it('mirrors into the live draft as well, because drafts shadow data', () => {
    // `responsePayload` = { ...data, ...draftData.values, ...draftData.rows }.
    // Updating only `data` would let a stale draft value keep winning at submit.
    expect(responsePayload).toMatch(/\.\.\.\(data \?\? \{\}\)/)
    expect(responsePayload).toMatch(/\.\.\.\(draftData\.values \?\? \{\}\)/)
    expect(locationBody).toContain('row.draftData')
    expect(locationBody).toContain("ARRAY['values','site']::text[]")
  })

  it('clears the payload mirror when the location is cleared', () => {
    // A JSON `null` is what `isFieldValueEmpty` treats as empty, so removing the
    // location must leave the required Site field empty rather than stale.
    expect(locationBody).toContain("sql`'null'::jsonb`")
  })

  it('keeps the org-unit tenant scope check ahead of both writes', () => {
    // A location must never be able to point at another tenant's org unit.
    const scopeAt = locationBody.indexOf('eq(orgUnits.tenantId, ctx.tenantId)')
    const writeAt = locationBody.indexOf('.update(formResponses)')
    expect(scopeAt).toBeGreaterThan(-1)
    expect(scopeAt).toBeLessThan(writeAt)
  })

  it('uses the same field id the platform keys every org-unit picker off', () => {
    // `entityAttrPickerTypeForField` maps field id 'site' to the picker family, so
    // the header control and the in-form picker cannot drift apart.
    expect(entityAttrs).toMatch(/site_picker: 'site'/)
    expect(locationBody).toMatch(/f\.id === 'site'/)
  })

  it('records one audit row for the location change', () => {
    expect(locationBody).toContain("entityType: 'form_response'")
    expect(locationBody).toContain("summary: 'Updated record location'")
  })
})

describe('Finalize reads the same value the Location control wrote', () => {
  it('validates the merged payload, not the column alone', () => {
    expect(finalize).toContain('const rawData = responsePayload(')
    expect(finalize).toContain("validateResponse(rec.schema, rawData, 'submit')")
  })

  it('bounces with the error count, so a stuck submit is visible', () => {
    expect(finalize).toContain('finalizeError=${rawValidationErrors.length}')
    expect(finalize).toContain('finalizeError=${validationErrors.length}')
  })
})
