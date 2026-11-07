// Manifest schema tests.
//
// The properties worth pinning are the REFUSALS. A manifest that parsed but lost a
// field would restore objects with silently missing metadata or tags, and nothing
// downstream could detect it because there would be nothing left to compare against.

import { describe, expect, it } from 'vitest'
import { MANIFEST_SCHEMA_VERSION, ManifestError, validateManifest, type Manifest } from './manifest'

function object(overrides: Partial<Manifest['objects'][number]> = {}): Manifest['objects'][number] {
  return {
    key: 't/tenant/documents/file.pdf',
    size: 10,
    sha256: 'a'.repeat(64),
    contentType: 'application/pdf',
    contentDisposition: 'attachment',
    metadata: { 'upload-token': 'tok' },
    tags: { 'beaconhs-state': 'pending' },
    file: `objects/${'a'.repeat(64)}`,
    ...overrides,
  }
}

function manifest(objects: Manifest['objects']): Manifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    created_at: '2026-10-12T00:00:00.000Z',
    source: { endpoint: 'http://127.0.0.1:9000', bucket: 'beaconhs', region: 'auto' },
    object_count: objects.length,
    total_bytes: objects.reduce((sum, entry) => sum + entry.size, 0),
    lifecycle: { status: 'none' },
    objects,
  }
}

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    const parsed = validateManifest(manifest([object()]))
    expect(parsed.object_count).toBe(1)
    expect(parsed.objects[0]!.tags).toEqual({ 'beaconhs-state': 'pending' })
  })

  it('redacts the endpoint, which may otherwise carry userinfo or a query', () => {
    const parsed = validateManifest(manifest([object()]))
    expect(parsed.source.endpoint).toBe('http://127.0.0.1:9000')
  })

  it.each([
    ['an unknown schema version', { schema_version: 999 }],
    ['a missing created_at', { created_at: '' }],
    ['a missing source', { source: undefined }],
    ['a negative total_bytes', { total_bytes: -1 }],
    ['a non-integer object_count', { object_count: 1.5 }],
    ['an unknown lifecycle status', { lifecycle: { status: 'encrypted' } }],
    ['objects that is not an array', { objects: {} }],
    ['a count that disagrees with the object list', { object_count: 2 }],
  ])('refuses a manifest with %s', (_label, patch) => {
    const base = manifest([object()]) as unknown as Record<string, unknown>
    expect(() => validateManifest({ ...base, ...patch })).toThrow(ManifestError)
  })

  it('refuses a byte total that disagrees with the object list', () => {
    const base = manifest([object()]) as unknown as Record<string, unknown>
    expect(() => validateManifest({ ...base, total_bytes: 999 })).toThrow(ManifestError)
    expect(() => validateManifest({ ...base, total_bytes: 999 })).toThrow(/total_bytes/)
  })

  it('refuses a duplicate object key', () => {
    const base = manifest([object(), object()]) as unknown as Record<string, unknown>
    base.object_count = 2
    base.total_bytes = 20
    expect(() => validateManifest(base)).toThrow(ManifestError)
    expect(() => validateManifest(base)).toThrow(/duplicate object key/)
  })

  it('refuses a non-object manifest', () => {
    expect(() => validateManifest('not an object')).toThrow(ManifestError)
  })

  it.each([
    ['a missing key', { key: '' }],
    ['a negative size', { size: -1 }],
    ['a short digest', { sha256: 'abc' }],
    ['a digest with uppercase hex', { sha256: 'A'.repeat(64) }],
    ['metadata that is not a string map', { metadata: { a: 1 } }],
    ['tags that are not a string map', { tags: [] }],
    ['a missing file path', { file: '' }],
  ])('refuses an object entry with %s', (_label, patch) => {
    expect(() => validateManifest(manifest([object(patch as never)]))).toThrow(ManifestError)
  })

  it.each([
    ['an absolute file path', { file: '/etc/passwd' }],
    ['a parent traversal', { file: 'objects/../../../etc/passwd' }],
  ])('refuses a %s, which would escape the backup directory on restore', (_label, patch) => {
    expect(() => validateManifest(manifest([object(patch as never)]))).toThrow(ManifestError)
    expect(() => validateManifest(manifest([object(patch as never)]))).toThrow(
      /relative path inside the backup directory/,
    )
  })

  it('accepts a lifecycle configuration that was captured', () => {
    const parsed = validateManifest({
      ...manifest([object()]),
      lifecycle: { status: 'captured', xml: '<LifecycleConfiguration/>', sha256: 'b'.repeat(64) },
    })
    expect(parsed.lifecycle.status).toBe('captured')
    expect(parsed.lifecycle.xml).toBe('<LifecycleConfiguration/>')
  })

  it('records that a store could not report lifecycle, rather than saying none', () => {
    const parsed = validateManifest({
      ...manifest([object()]),
      lifecycle: { status: 'unsupported', reason: 'NotImplemented' },
    })
    expect(parsed.lifecycle.status).toBe('unsupported')
    expect(parsed.lifecycle.reason).toBe('NotImplemented')
  })

  it('preserves tags exactly, including keys the SDK would not model', () => {
    const parsed = validateManifest(
      manifest([object({ tags: { 'beaconhs-state': 'transient', 'a b': 'c d' } })]),
    )
    expect(parsed.objects[0]!.tags).toEqual({ 'beaconhs-state': 'transient', 'a b': 'c d' })
  })
})
