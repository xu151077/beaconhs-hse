import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  isSuperAdmin: true,
  saved: [] as Array<{ url: string }>,
  audits: [] as Array<Record<string, unknown>>,
  revalidated: [] as string[],
}))

vi.mock('@/lib/auth', () => ({
  requireRequestContext: async () => ({ isSuperAdmin: state.isSuperAdmin, tenantId: 'tenant-1' }),
}))
vi.mock('@/lib/audit', () => ({
  recordAudit: async (_ctx: unknown, entry: Record<string, unknown>) => {
    state.audits.push(entry)
  },
}))
vi.mock('@/lib/open-source-config', () => ({
  savePlatformOpenSourceSettings: async (input: { url: string }) => {
    state.saved.push(input)
  },
}))
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    state.revalidated.push(path)
  },
}))

import { savePlatformOpenSource } from './open-source-actions'

function formDataWith(url: unknown): FormData {
  const form = new FormData()
  if (url instanceof File) {
    form.append('url', url)
  } else if (typeof url === 'string') {
    form.append('url', url)
  }
  return form
}

describe('savePlatformOpenSource', () => {
  beforeEach(() => {
    state.isSuperAdmin = true
    state.saved = []
    state.audits = []
    state.revalidated = []
  })

  it('saves a valid URL, audits without the URL value, and revalidates the dashboard', async () => {
    await savePlatformOpenSource(formDataWith('https://github.com/example/app'))
    expect(state.saved).toEqual([{ url: 'https://github.com/example/app' }])
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({ entityType: 'platform_settings', action: 'update' })
    expect(JSON.stringify(state.audits[0])).not.toContain('github.com')
    expect(state.revalidated).toContain('/dashboard')
  })

  it('refuses non-super-admins before any write', async () => {
    state.isSuperAdmin = false
    await expect(
      savePlatformOpenSource(formDataWith('https://github.com/example/app')),
    ).rejects.toThrow(/super-admins/)
    expect(state.saved).toEqual([])
    expect(state.audits).toEqual([])
  })

  it('rejects a missing field instead of silently clearing the link', async () => {
    await expect(savePlatformOpenSource(new FormData())).rejects.toThrow(/Missing repository URL/)
    expect(state.saved).toEqual([])
    expect(state.audits).toEqual([])
  })

  it('rejects a file part instead of silently clearing the link', async () => {
    await expect(savePlatformOpenSource(formDataWith(new File(['x'], 'url.txt')))).rejects.toThrow(
      /Missing repository URL/,
    )
    expect(state.saved).toEqual([])
  })
})
