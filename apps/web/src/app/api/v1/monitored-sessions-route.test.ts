import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestContext } from '@beaconhs/tenant'

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  readEntityRows: vi.fn(),
  listBuilderApps: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/api/auth', () => ({ authenticateApiKey: mocks.authenticateApiKey }))
vi.mock('@/lib/api/query', () => ({ readEntityRows: mocks.readEntityRows }))
vi.mock('@/lib/api/builder-apps', () => ({
  BUILDER_APP_READ_PERMISSION: 'forms.response.read.all',
  BUILDER_APP_CREATE_PERMISSION: 'forms.response.create',
  BUILDER_APP_UPDATE_PERMISSION: 'forms.response.update.own',
  BUILDER_APP_DELETE_PERMISSION: 'forms.response.delete',
  listBuilderApps: mocks.listBuilderApps,
}))
vi.mock('@/lib/api/write', () => ({
  deletePermissionForEntity: () => null,
  isDeletable: () => false,
  isPatchable: () => false,
  isWritable: () => false,
  patchPermissionForEntity: () => null,
  writePermissionForEntity: () => null,
}))
vi.mock('@/lib/api/body', () => ({ readApiJsonBody: vi.fn() }))
vi.mock('@/lib/api/idempotency', () => ({ runIdempotentMutation: vi.fn() }))

import { GET as getEntity } from './[entity]/route'
import { GET as discover } from './route'

const TENANT_A = '1a000000-0000-4000-8000-0000000000aa'
const TENANT_B = '1a000000-0000-4000-8000-0000000000bb'

function context(tenantId: string): RequestContext {
  return {
    tenantId,
    permissions: new Set(['forms.response.read.all']),
    scopes: [{ type: 'tenant' }],
    db: vi.fn(),
  } as unknown as RequestContext
}

function auth(permissions: string[], tenantId = TENANT_A) {
  return {
    ctx: context(tenantId),
    key: {
      id: 'key-1',
      name: 'Test key',
      tenantId,
      permissions,
      builderTemplateIds: [],
      rateLimitHeaders: {},
    },
  }
}

const params = (entity: string) => ({ params: Promise.resolve({ entity }) })
const request = (query = '') =>
  new Request(`http://localhost/api/v1/monitored_sessions${query}`, {
    headers: { Authorization: 'Bearer bhs_live_test', 'x-tenant-id': TENANT_B },
  })

describe('GET /api/v1/monitored_sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows a key holding the Builder response read permission', async () => {
    mocks.authenticateApiKey.mockResolvedValue(auth(['forms.response.read.all']))
    mocks.readEntityRows.mockResolvedValue({
      data: [{ id: 'session-1' }],
      pagination: { limit: 50, offset: 0, total: 1, hasMore: false },
    })

    const response = await getEntity(request(), params('monitored_sessions'))
    const body = (await response.json()) as {
      entity: string
      data: unknown[]
      pagination: { total: number }
    }

    expect(response.status).toBe(200)
    expect(body.entity).toBe('monitored_sessions')
    expect(body.pagination.total).toBe(1)
    // The tenant comes from the authenticated key context. The route never reads
    // an `x-tenant-id` header or a tenant query parameter.
    expect(mocks.readEntityRows).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A }),
      expect.objectContaining({ key: 'monitored_sessions' }),
      expect.any(URLSearchParams),
    )
  })

  it('refuses a key without the Builder response read permission before touching data', async () => {
    mocks.authenticateApiKey.mockResolvedValue(auth(['incidents.read.all']))

    const response = await getEntity(request(), params('monitored_sessions'))
    const body = (await response.json()) as { error: { code: string; message: string } }

    expect(response.status).toBe(403)
    expect(body.error.code).toBe('forbidden')
    expect(body.error.message).toContain('forms.response.read.all')
    expect(mocks.readEntityRows).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1 discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('publishes monitored_sessions with a real read permission instead of throwing', async () => {
    const response = await discover(new Request('http://localhost/api/v1'))
    const body = (await response.json()) as {
      entities: Array<{ key: string; readPermission: string }>
    }

    expect(response.status).toBe(200)
    expect(body.entities).toContainEqual(
      expect.objectContaining({
        key: 'monitored_sessions',
        readPermission: 'forms.response.read.all',
      }),
    )
  })
})
