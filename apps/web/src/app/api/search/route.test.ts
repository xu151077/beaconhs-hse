import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const state = vi.hoisted(() => ({
  canReadPeople: true,
  encounteredPeopleQuery: false,
}))

// Only the people gate is under test; tier visibility + document filter are
// stubs so the route's control flow reaches the per-module queries.
vi.mock('../../../lib/visibility', () => ({
  moduleScopeWhere: async () => undefined,
}))
vi.mock('../../../lib/assistant/doc-access', () => ({
  documentReadFilter: () => undefined,
}))
vi.mock('@beaconhs/tenant', () => ({
  can: (_ctx: unknown, permission: string) =>
    permission === 'people.read.all' ? state.canReadPeople : true,
}))
vi.mock('@beaconhs/db', () => ({
  primaryPersonTitleName: () => 'subquery',
}))
vi.mock('@beaconhs/forms-core', () => ({
  htmlToSnippet: (value: unknown) => String(value ?? ''),
}))

// ctx.db hands the route a fake tx whose select-builder resolves by table:
// count queries answer 2 for people, 0 elsewhere; row queries answer one
// people row and empty arrays elsewhere. The route's `where(...)` predicates
// are real drizzle SQL expressions (never executed here), so the only
// behaviour under test is whether the people group survives the gate.
vi.mock('../../../lib/auth', () => ({
  getRequestContext: async () => ({
    tenantId: '11111111-1111-4111-8111-111111111111',
    db: async (callback: (tx: unknown) => unknown) =>
      callback({
        select: (shape: Record<string, unknown>) => {
          let tableName = ''
          let gated = false
          let limit: number | undefined
          const resolve = () => {
            // Faithfully emulate the DB for the gate: the route expresses
            // "no access" as `where(sql\`false\`)`, so such a query resolves
            // to zero rows / zero count instead of data.
            if (gated) return Promise.resolve('c' in shape ? [{ c: 0 }] : [])
            if ('c' in shape) return Promise.resolve([{ c: tableName === 'people' ? 2 : 0 }])
            if (tableName === 'people') {
              state.encounteredPeopleQuery = true
              const peopleRows = [
                {
                  id: 'p-1',
                  firstName: 'Ada',
                  lastName: 'Byron',
                  employeeNo: 'E1',
                  jobTitle: 'Dev',
                },
              ]
              return Promise.resolve(limit === undefined ? peopleRows : peopleRows.slice(0, limit))
            }
            return Promise.resolve([])
          }
          const chain: Record<string, unknown> = {}
          chain.from = (table: object) => {
            tableName = getTableName(table as never)
            return chain
          }
          chain.where = (...args: unknown[]) => {
            const isFalse = args.some((arg) => {
              const chunks = (arg as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks
              return chunks?.some(
                (chunk) => Array.isArray(chunk.value) && chunk.value.includes('false'),
              )
            })
            if (isFalse) gated = true
            return chain
          }
          chain.leftJoin = () => chain
          chain.orderBy = () => chain
          chain.limit = (n: number) => {
            limit = n
            return chain
          }
          chain.then = (resolveFn: (value: unknown) => unknown) => resolve().then(resolveFn)
          return chain
        },
      }),
  }),
}))

import { getTableName } from 'drizzle-orm'
import {
  correctiveActions,
  documents,
  equipmentItems,
  hazidAssessments,
  incidents,
  people,
} from '@beaconhs/db/schema'
import { GET } from './route'

describe('global search people gate', () => {
  beforeEach(() => {
    state.encounteredPeopleQuery = false
    state.canReadPeople = true
  })

  it('shows the people group when the caller can read all people', async () => {
    state.canReadPeople = true
    const response = await GET(new Request('http://localhost/api/search?q=ad'))
    const body = (await response.json()) as { groups: Array<{ type: string }> }
    expect(state.encounteredPeopleQuery).toBe(true)
    expect(body.groups.some((g) => g.type === 'people')).toBe(true)
  })

  it('hides the people group entirely without people.read.all', async () => {
    // Regression for the roster-enumeration leak: /people requires
    // people.read.all, so the search API must not surface the roster either
    // — names, employee numbers, emails, job titles and person UUIDs.
    state.canReadPeople = false
    const response = await GET(new Request('http://localhost/api/search?q=ad'))
    const body = (await response.json()) as { groups: Array<{ type: string }> }
    expect(body.groups.some((g) => g.type === 'people')).toBe(false)
  })

  it('table objects expose a readable name for the stub', () => {
    expect(getTableName(people)).toBe('people')
    expect(getTableName(incidents)).toBe('incidents')
    expect(getTableName(correctiveActions)).toBeTruthy()
    expect(getTableName(equipmentItems)).toBeTruthy()
    expect(getTableName(hazidAssessments)).toBeTruthy()
    expect(getTableName(documents)).toBeTruthy()
  })
})
