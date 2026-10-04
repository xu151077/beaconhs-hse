// Contract: a record's Location must be READ BACK wherever it is rendered.
//
// `record-location-mirror-contract.test.ts` pins the write half — that choosing a
// location writes both `site_org_unit_id` and the payload's `site` field. This pins
// the read half, which is a separate surface and failed independently.
//
// The bug this pins: `FormRenderer` renders its Location control from the
// `initialLocation` prop alone (it seeds both the `siteId` state and the control's
// `initialOption`). The `fill` route passes that prop. The record detail route
// `/apps/responses/[id]` did NOT — it had already joined `orgUnits` into
// `baseData.site` and then never used it.
//
// The write was correct the whole time, so this failed silently and invisibly:
// Postgres held the right `site_org_unit_id`, and the control still rendered
// "No location" for every saved record. A user who set a location and reloaded saw
// it vanish, with no error and no failed request. That matters well beyond
// cosmetics: `site_org_unit_id` is the column every site-scoped read filters on, so
// the UI was telling a user their record had no site when the database disagreed.
//
// Structural assertions read the route/renderer sources: these are server
// components behind `requireRequestContext()`, so they cannot run in a unit test.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const responseDetail = source('../../app/(app)/apps/responses/[id]/page.tsx')
const fillPage = source('../../app/(app)/apps/templates/[id]/fill/page.tsx')
const renderer = source('../../app/(app)/apps/templates/[id]/fill/form-renderer.tsx')

// The FormRenderer invocation inside the response detail page, so these assertions
// cannot be satisfied by an unrelated `initialLocation` elsewhere in the file.
const detailRendererCall = (() => {
  const start = responseDetail.indexOf('<FormRenderer')
  expect(start).toBeGreaterThan(-1)
  return responseDetail.slice(start, responseDetail.indexOf('/>', start))
})()

describe('FormRenderer renders Location only from initialLocation', () => {
  it('seeds both the state and the control from the prop', () => {
    // Two independent reads of the same prop. Either one alone still displays a
    // saved location; losing both is what made the record look site-less.
    expect(renderer).toContain('const [siteId, setSiteId] = useState(initialLocation?.value')
    expect(renderer).toContain('initialOption={initialLocation}')
  })

  it('displays siteId, which only initialLocation can seed', () => {
    // The control's displayed value is `siteId`, and `siteId` is seeded from the
    // prop and from nothing else. The renderer's two `siteOrgUnitId` references are
    // both writes (the submit payload and the action call), never a read of stored
    // state -- which is exactly why a missing prop could not be masked.
    expect(renderer).toContain('value={siteId}')
    expect(renderer).toMatch(/useState\(initialLocation\?\.value \?\? ''\)[\s\S]*?value=\{siteId\}/)
  })
})

describe('the record detail route passes the location it already loaded', () => {
  it('passes initialLocation to FormRenderer', () => {
    expect(detailRendererCall).toContain('initialLocation=')
  })

  it('derives it from the org unit it already joined, rather than re-querying', () => {
    // The join predates this fix and its result was simply unused. Reading it keeps
    // the page at one query and cannot disagree with the row being rendered.
    expect(responseDetail).toContain('site: orgUnits')
    expect(detailRendererCall).toContain('baseData.site')
    expect(detailRendererCall).toContain('value: baseData.site.id')
    expect(detailRendererCall).toContain('label: baseData.site.name')
  })

  it('passes undefined for a record that genuinely has no location', () => {
    // `site` comes from a leftJoin, so it is null when no location is set. That is
    // the true empty state, so rendering "No location" there stays correct -- the
    // prop must not invent a default.
    expect(detailRendererCall).toMatch(/baseData\.site\s*\?\s*\{[\s\S]*?\}\s*:\s*undefined/)
  })

  it('keeps the detail route aligned with the fill route', () => {
    // Both routes render the same renderer for the same record. Whichever one a
    // user reaches, the location has to read back the same way.
    expect(fillPage).toContain('initialLocation={data.initialLocation}')
    expect(fillPage).toContain('label: selectedLocations[0].name')
  })
})
