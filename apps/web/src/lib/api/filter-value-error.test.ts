import { describe, expect, it } from 'vitest'
import { REPORT_ENTITY_MAP } from '@beaconhs/reports'
import type { RequestContext } from '@beaconhs/tenant'
import { ApiError } from './errors'
import { readEntityRows } from './query'

/**
 * A filter value is user input. Postgres rejects a non-UUID `?site_org_unit_id=`
 * or an unknown enum member with SQLSTATE 22P02; that is a bad request, not a
 * server fault. The list endpoint must answer 400 rather than leaking a 500.
 */
function context(execute: () => Promise<unknown>): RequestContext {
  return {
    userId: 'api_key_probe',
    tenantId: '10000000-0000-4000-8000-0000000000aa',
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: null,
    personId: null,
    permissions: new Set(['documents.read']),
    scopes: [{ type: 'tenant' }],
    activeRoleId: null,
    db: (fn: (tx: unknown) => unknown) => fn({ execute }),
  } as unknown as RequestContext
}

describe('invalid filter values', () => {
  it('maps a Postgres 22P02 cast failure to a 400 ApiError', async () => {
    const error = Object.assign(new Error('invalid input syntax for type uuid'), {
      code: '22P02',
    })
    const ctx = context(async () => {
      throw error
    })

    await expect(
      readEntityRows(ctx, REPORT_ENTITY_MAP['documents']!, new URLSearchParams('id=not-a-uuid')),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  })

  it.each(['22P02', '22007', '22008'])('maps SQLSTATE %s to a 400', async (code) => {
    const error = Object.assign(new Error('invalid input'), { code })
    const ctx = context(async () => {
      throw error
    })

    await expect(
      readEntityRows(ctx, REPORT_ENTITY_MAP['documents']!, new URLSearchParams()),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  })

  it('does not disguise an unrelated database failure as a client error', async () => {
    const error = Object.assign(new Error('connection terminated'), { code: '08006' })
    const ctx = context(async () => {
      throw error
    })

    await expect(
      readEntityRows(ctx, REPORT_ENTITY_MAP['documents']!, new URLSearchParams()),
    ).rejects.toBe(error)
  })

  it('keeps the ApiError class usable for callers that catch it by type', () => {
    expect(ApiError.invalid('x')).toBeInstanceOf(ApiError)
  })
})
