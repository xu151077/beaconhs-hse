// WOPI document save regression tests (live database + mocked object store).
//
// Covers the defect where every attachment row carrying a sub-millisecond
// `updatedAt` (i.e. every row written with a database-side default, which is
// what `finalizeUpload` produces) could never be saved through WOPI: the
// publish transaction compared the stored microsecond timestamp against a
// millisecond-truncated JS Date, matched zero rows, and returned 409
// "Editor source changed" on every save. The fix truncates both sides to
// milliseconds before comparing.
//
// Database scenarios run against a throwaway database using the same
// scratch-DB convention as the bootstrap suites: they are SKIPPED (not
// passed) unless SEED_TEST_SCRATCH_DATABASE_URL is set. Object storage is an
// in-memory mock — the regression lives in the SQL comparison, and the mock
// keeps the suite runnable without MinIO.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'

// Route modules under test pull server-only code (wopi-access). Outside a
// React Server Component that import throws by design; tests stub it out.
vi.mock('server-only', () => ({}))

const SCRATCH_URL = process.env.SEED_TEST_SCRATCH_DATABASE_URL

if (SCRATCH_URL) {
  process.env.DATABASE_URL ??= SCRATCH_URL
  process.env.SUPERADMIN_DATABASE_URL ??=
    process.env.SEED_TEST_SCRATCH_SUPERADMIN_URL ?? SCRATCH_URL
  process.env.MIGRATION_DATABASE_URL ??= SCRATCH_URL
}

const objects = vi.hoisted(() => ({ store: new Map<string, Buffer>() }))

vi.mock('@beaconhs/storage', () => ({
  isStorageWriteBlockedError: vi.fn(
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'StorageWriteBlockedError' &&
      typeof (error as { code?: unknown }).code === 'string',
  ),
  putObject: vi.fn(async ({ key, body }: { key: string; body: Buffer }) => {
    objects.store.set(key, Buffer.from(body))
  }),
  getObjectStream: vi.fn(
    async ({
      key,
    }: {
      key: string
    }): Promise<{ stream: ReadableStream; contentType?: string; contentLength?: number }> => {
      const body = objects.store.get(key)
      if (!body) throw new Error(`mock object missing: ${key}`)
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(body))
            controller.close()
          },
        }),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentLength: body.length,
      }
    },
  ),
  deleteObject: vi.fn(async ({ key }: { key: string }) => {
    objects.store.delete(key)
  }),
  newAttachmentKey: vi.fn(
    ({ tenantId, filename }: { tenantId: string; filename: string }) =>
      `t/${tenantId}/staged-${randomUUID()}-${filename}`,
  ),
}))

import {
  STORAGE_FREEZE_PERMISSIONS,
  applyTransition,
  db,
  ensureFreezeRow,
  readFreezeState,
  withSuperAdmin,
} from '@beaconhs/db'
import { attachments, documents, storageFreeze, tenants, users } from '@beaconhs/db/schema'
import { putObject } from '@beaconhs/storage'
import { eq } from 'drizzle-orm'
import { mintWopiToken } from '@/lib/wopi'
import { GET as checkFileInfo } from '../route'
import { GET as getFile, POST as putFile } from './route'

const describeDb = SCRATCH_URL ? describe : describe.skip

if (!SCRATCH_URL) {
  console.warn(
    '[wopi-contents] SEED_TEST_SCRATCH_DATABASE_URL is not set — database scenarios are SKIPPED, not passed.',
  )
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describeDb('WOPI document save (live database, mocked object store)', () => {
  const tenantId = randomUUID()
  const userId = randomUUID()
  const documentId = randomUUID()
  const attachmentId = randomUUID()
  const email = `wopi-${randomUUID()}@example.com`
  const r2Key = `t/${tenantId}/wopi-fixture.docx`
  const originalBytes = Buffer.from('wopi-original-bytes')
  const editedBytes = Buffer.from('wopi-edited-bytes-longer')
  let token = ''

  beforeAll(async () => {
    await withSuperAdmin(db, async (tx) => {
      await tx
        .insert(tenants)
        .values({ id: tenantId, slug: `wopi-${tenantId.slice(0, 8)}`, name: 'WOPI Fixture' })
      await tx.insert(users).values({
        id: userId,
        email,
        name: 'WOPI Fixture',
        isSuperAdmin: true,
      })
      await tx.insert(documents).values({
        id: documentId,
        tenantId,
        key: `wopi-${documentId.slice(0, 8)}`,
        title: 'WOPI Fixture',
      })
      // Intentionally rely on database-side timestamp defaults: the row
      // carries microsecond precision, which is exactly the shape that used
      // to make every WOPI save fail with a phantom 409.
      await tx.insert(attachments).values({
        id: attachmentId,
        tenantId,
        kind: 'document',
        r2Key,
        contentType: DOCX_MIME,
        sizeBytes: originalBytes.length,
        filename: 'wopi-fixture.docx',
      })
      await tx
        .update(documents)
        .set({ sourceAttachmentId: attachmentId })
        .where(eq(documents.id, documentId))
    })
    objects.store.set(r2Key, originalBytes)
    token = mintWopiToken({
      attachmentId,
      tenantId,
      userId,
      userName: 'WOPI Fixture',
      target: 'document',
      targetId: documentId,
      audience: 'document',
      courseId: null,
      enrollmentId: null,
      lessonId: null,
      canWrite: true,
      activeRoleId: null,
    }).token
  }, 60_000)

  afterAll(async () => {
    objects.store.clear()
    await withSuperAdmin(db, async (tx) => {
      await tx.delete(storageFreeze).where(eq(storageFreeze.tenantId, tenantId))
      await tx.delete(attachments).where(eq(attachments.id, attachmentId))
      await tx.delete(documents).where(eq(documents.id, documentId))
      await tx.delete(users).where(eq(users.id, userId))
      await tx.delete(tenants).where(eq(tenants.id, tenantId))
    }).catch(() => {})
  })

  const ctxFor = (fileId: string) => ({ params: Promise.resolve({ fileId }) })

  it('serves CheckFileInfo for a valid grant', async () => {
    const res = await checkFileInfo(
      new NextRequest(`http://test/wopi/files/${attachmentId}?access_token=${token}`),
      ctxFor(attachmentId),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      BaseFileName: 'wopi-fixture.docx',
      UserCanWrite: true,
    })
  })

  it('rejects missing, tampered, and misbound tokens', async () => {
    const noToken = await checkFileInfo(
      new NextRequest(`http://test/wopi/files/${attachmentId}`),
      ctxFor(attachmentId),
    )
    expect(noToken.status).toBe(401)

    const tampered = await checkFileInfo(
      new NextRequest(
        `http://test/wopi/files/${attachmentId}?access_token=${token.slice(0, -4)}xxxx`,
      ),
      ctxFor(attachmentId),
    )
    expect(tampered.status).toBe(401)

    const otherId = randomUUID()
    const misbound = await checkFileInfo(
      new NextRequest(`http://test/wopi/files/${otherId}?access_token=${token}`),
      ctxFor(otherId),
    )
    expect(misbound.status).toBe(401)
  })

  it('saves over a microsecond-timestamp attachment without a phantom conflict', async () => {
    const saved = await putFile(
      new NextRequest(`http://test/wopi/files/${attachmentId}?access_token=${token}`, {
        method: 'POST',
        headers: { 'X-WOPI-Override': 'PUT', 'Content-Type': 'application/octet-stream' },
        body: editedBytes,
      }),
      ctxFor(attachmentId),
    )
    expect(saved.status).toBe(200)

    const refetched = await getFile(
      new NextRequest(`http://test/wopi/files/${attachmentId}?access_token=${token}`),
      ctxFor(attachmentId),
    )
    expect(refetched.status).toBe(200)
    await expect(refetched.arrayBuffer()).resolves.toEqual(
      editedBytes.buffer.slice(
        editedBytes.byteOffset,
        editedBytes.byteOffset + editedBytes.byteLength,
      ) as ArrayBuffer,
    )
  })

  it('refuses a frozen PutFile with 423 without changing the attachment or object', async () => {
    const beforeAttachment = await withSuperAdmin(db, (tx) =>
      tx
        .select({ r2Key: attachments.r2Key, updatedAt: attachments.updatedAt })
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
        .limit(1),
    )
    const beforeKeys = [...objects.store.keys()].sort()
    await ensureFreezeRow(db, tenantId)
    let freeze = await readFreezeState(db, tenantId)
    freeze = await applyTransition(db, {
      tenantId,
      actorId: 'wopi-freeze-test',
      permission: STORAGE_FREEZE_PERMISSIONS.request,
      to: 'FREEZE_REQUESTED',
      reason: 'WOPI freeze regression fixture',
      expectedVersion: freeze!.version,
    })
    await applyTransition(db, {
      tenantId,
      actorId: 'wopi-freeze-test',
      permission: STORAGE_FREEZE_PERMISSIONS.drain,
      to: 'DRAINING',
      reason: 'WOPI freeze regression fixture',
      expectedVersion: freeze.version,
    })

    vi.mocked(putObject).mockRejectedValueOnce({
      name: 'StorageWriteBlockedError',
      code: 'STORAGE_FROZEN',
      operation: 'putObject',
      freezeState: 'DRAINING',
    } as never)

    const refused = await putFile(
      new NextRequest(`http://test/wopi/files/${attachmentId}?access_token=${token}`, {
        method: 'POST',
        headers: { 'X-WOPI-Override': 'PUT', 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('must-not-be-staged-while-frozen'),
      }),
      ctxFor(attachmentId),
    )
    expect(refused.status).toBe(423)
    await expect(refused.text()).resolves.toBe('Workspace unavailable')

    const afterAttachment = await withSuperAdmin(db, (tx) =>
      tx
        .select({ r2Key: attachments.r2Key, updatedAt: attachments.updatedAt })
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
        .limit(1),
    )
    expect(afterAttachment[0]).toEqual(beforeAttachment[0])
    expect([...objects.store.keys()].sort()).toEqual(beforeKeys)
  })

  it('refuses a read-only grant on PutFile', async () => {
    const readOnly = mintWopiToken({
      attachmentId,
      tenantId,
      userId,
      userName: 'WOPI Fixture',
      target: 'document',
      targetId: documentId,
      audience: 'document',
      courseId: null,
      enrollmentId: null,
      lessonId: null,
      canWrite: false,
      activeRoleId: null,
    }).token
    const res = await putFile(
      new NextRequest(`http://test/wopi/files/${attachmentId}?access_token=${readOnly}`, {
        method: 'POST',
        headers: { 'X-WOPI-Override': 'PUT', 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('must-not-save'),
      }),
      ctxFor(attachmentId),
    )
    expect(res.status).toBe(403)
  })
})
