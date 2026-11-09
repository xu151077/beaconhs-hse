import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

const state = vi.hoisted(() => ({
  db: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRequestContext: async () => ({
    tenantId: '10000000-0000-4000-8000-000000000001',
    tenantUserId: '20000000-0000-4000-8000-000000000002',
    userId: '30000000-0000-4000-8000-000000000003',
    isSuperAdmin: false,
    permissions: new Set(['documents.manage', 'admin.settings.manage']),
    db: state.db,
  }),
}))
vi.mock('@/lib/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@beaconhs/tenant', () => ({ assertCan: vi.fn(), can: () => true }))

import { deleteDocument } from './_actions'
import { deleteDataSource } from '../admin/data-sources/_actions'

function fd(id: string): FormData {
  const formData = new FormData()
  formData.set('id', id)
  return formData
}

describe('single-delete id guards', () => {
  beforeEach(() => {
    state.db.mockReset()
  })

  it('deleteDocument rejects a non-UUID id without touching the database', async () => {
    await expect(deleteDocument(fd('not-a-uuid'))).rejects.toThrow('Document not found.')
    expect(state.db).not.toHaveBeenCalled()
  })

  it('deleteDataSource rejects a non-UUID id without touching the database', async () => {
    await deleteDataSource(fd('not-a-uuid'))
    expect(state.db).not.toHaveBeenCalled()
  })
})
