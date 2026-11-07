import { describe, expect, it } from 'vitest'
import {
  TEST_ASSET_PREFIX,
  assertOwnedByTest,
  assertOwnedRow,
  isOwnedByTest,
  testAsset,
  testDocumentKey,
  testObjectKey,
} from './test-asset-ownership'

// Phase EA-3: the guard that prevents a write test from overwriting a document
// it does not own.
//
// Phase EA-2 reused the only own-tenant DOCX visible to its test identity, which
// was a pre-existing draft fixture, and the save destroyed the original bytes.
// These assertions pin the rule that made that possible: every test asset is
// uniquely named, and a write target must carry that name.

describe('test asset ownership guard', () => {
  it('gives every asset a unique, prefixed identity', () => {
    const a = testAsset('wopi-write')
    const b = testAsset('wopi-write')
    expect(a.runId).not.toBe(b.runId)
    expect(a.runId.startsWith(`${TEST_ASSET_PREFIX}-wopi-write-`)).toBe(true)
  })

  it('rejects a label that is not a safe slug', () => {
    expect(() => testAsset('Not Safe')).toThrow(/must match/)
    expect(() => testAsset('../escape')).toThrow(/must match/)
  })

  it('builds a tenant-scoped object key', () => {
    const asset = testAsset('upload')
    const key = testObjectKey(asset, '8b62c4c2-8ac9-40f5-8918-224036c4fbfd', 'My File.docx')
    expect(key).toContain(asset.runId)
    expect(key).toContain('My_File.docx')
    expect(key.startsWith('t/8b62c4c2-8ac9-40f5-8918-224036c4fbfd/document/')).toBe(true)
  })

  it('refuses a non-UUID tenant id', () => {
    const asset = testAsset('upload')
    expect(() => testObjectKey(asset, 'demo', 'f.docx')).toThrow(/UUID/)
  })

  it('recognises only what this run created', () => {
    const asset = testAsset('delete')
    expect(isOwnedByTest(asset, testDocumentKey(asset))).toBe(true)
    // The exact values Phase EA-2 accidentally overwrote.
    expect(isOwnedByTest(asset, 'untitled-2e08e827-3099-4672-a600-72bbae0ac671')).toBe(false)
    expect(isOwnedByTest(asset, 'untitled-f148d906-e504-4d30-8e6d-51bdb2a86cfb')).toBe(false)
    expect(isOwnedByTest(asset, 'corporate-hs-policy')).toBe(false)
    expect(isOwnedByTest(asset, null)).toBe(false)
    expect(isOwnedByTest(asset, undefined)).toBe(false)
  })

  it('blocks a write to a pre-existing fixture without echoing the whole key', () => {
    const asset = testAsset('replace')
    expect(() =>
      assertOwnedByTest(asset, 'untitled-2e08e827-3099-4672-a600-72bbae0ac671', 'document'),
    ).toThrow(/refusing to write/)
    try {
      assertOwnedByTest(
        asset,
        't/8b62c4c2-8ac9-40f5-8918-224036c4fbfd/document/16ecf567-7e45-496b-bef5-4a1c9cd58948-untitled-2e08e827-3099-4672-a600-72bbae0ac671.docx',
        'object key',
      )
      throw new Error('should have thrown')
    } catch (error) {
      const message = (error as Error).message
      // The target is truncated, so the message names it without dumping the
      // whole key.
      expect(message).toContain('t/8b62c4c2-8ac9-40f5-891…')
      // The full key must not be echoed.
      expect(message).not.toContain('untitled-2e08e827-3099-4672-a600-72bbae0ac671.docx')
      expect(message).not.toContain('16ecf567-7e45-496b-bef5-4a1c9cd58948')
    }
  })

  it('blocks a delete of a row the test does not own', () => {
    const asset = testAsset('delete')
    expect(() =>
      assertOwnedRow(asset, {
        id: '5beae69a-39f1-426f-9eff-693c640ec874',
        key: 'corporate-hs-policy',
      }),
    ).toThrow(/refusing to write/)
  })

  it('allows a row the test created', () => {
    const asset = testAsset('delete')
    expect(() =>
      assertOwnedRow(asset, {
        id: asset.runId,
        key: asset.runId,
        r2Key: `t/x/${asset.runId}.docx`,
      }),
    ).not.toThrow()
  })

  it('refuses a missing row', () => {
    const asset = testAsset('delete')
    expect(() => assertOwnedRow(asset, null)).toThrow(/no row was found/)
  })

  // Phase EA-4: the guard must cover the paths that actually destroy data —
  // object replacement, version publication, and document deletion. Each test
  // below performs the same ownership check the real code path must perform
  // before it writes.
  it('refuses to replace an object the test does not own', () => {
    const asset = testAsset('replace')
    // The EA-2 incident: a pre-existing draft's object key.
    const existingKey =
      't/8b62c4c2-8ac9-40f5-8918-224036c4fbfd/document/16ecf567-7e45-496b-bef5-4a1c9cd58948-untitled-2e08e827-3099-4672-a600-72bbae0ac671.docx'
    expect(() => assertOwnedByTest(asset, existingKey, 'object key')).toThrow(/refusing to write/)
    // A key the test minted passes.
    const ownKey = testObjectKey(asset, '8b62c4c2-8ac9-40f5-8918-224036c4fbfd', 'mine.docx')
    expect(() => assertOwnedByTest(asset, ownKey, 'object key')).not.toThrow()
  })

  it('refuses to publish a version onto a document the test does not own', () => {
    const asset = testAsset('publish')
    // publishDocumentVersion snapshots documents.sourceAttachmentId.
    expect(() =>
      assertOwnedByTest(asset, '06eb60ca-30cb-4ceb-8d97-f4817a5ccfa2', 'source attachment'),
    ).toThrow(/refusing to write/)
  })

  it('refuses to delete a version row the test does not own', () => {
    const asset = testAsset('version-delete')
    expect(() =>
      assertOwnedRow(asset, {
        id: '90fa9fda-a2b3-473f-8ba0-b7cb5c23d4d6',
        key: 'untitled-2e08e827-3099-4672-a600-72bbae0ac671',
        r2Key:
          't/x/document/016ecf567-7e45-496b-bef5-4a1c9cd58948-untitled-2e08e827-3099-4672-a600-72bbae0ac671.docx',
      }),
    ).toThrow(/refusing to write/)
  })

  it('refuses to mutate a storage object under a tenant it does not own', () => {
    const asset = testAsset('storage')
    const tenantKey =
      't/daaf52e6-7b65-4dc3-892b-1a1b1995d654/document/ea3-mvgvvtpk-agme9v-c-master.docx'
    expect(() => assertOwnedByTest(asset, tenantKey, 'object key')).toThrow(/refusing to write/)
  })
})
