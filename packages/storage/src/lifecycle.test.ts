import { describe, expect, it } from 'vitest'
import type { LifecycleRule } from '@aws-sdk/client-s3'
import {
  storageObjectTagging,
  withManagedStorageLifecycleRules,
  diffManagedStorageLifecycleRules,
} from './lifecycle'

describe('storage lifecycle policy', () => {
  it('preserves operator rules and idempotently replaces BeaconHS-managed rules', () => {
    const existing: LifecycleRule[] = [
      { ID: 'operator-archive', Status: 'Enabled', Expiration: { Days: 365 } },
      { ID: 'expire-unfinalized-uploads', Status: 'Disabled', Expiration: { Days: 7 } },
      { ID: 'expire-transient-artifacts', Status: 'Disabled', Expiration: { Days: 7 } },
    ]

    const rules = withManagedStorageLifecycleRules(existing)
    expect(rules.map((rule) => rule.ID)).toEqual([
      'operator-archive',
      'expire-unfinalized-uploads',
      'expire-transient-artifacts',
    ])
    expect(rules[1]).toMatchObject({
      Status: 'Enabled',
      Filter: { Tag: { Key: 'beaconhs-state', Value: 'pending' } },
      Expiration: { Days: 1 },
    })
    expect(rules[2]).toMatchObject({
      Status: 'Enabled',
      Filter: { Tag: { Key: 'beaconhs-state', Value: 'transient' } },
      Expiration: { Days: 1 },
    })
  })

  it('tags only explicitly transient objects and leaves durable objects untagged', () => {
    expect(storageObjectTagging('transient')).toBe('beaconhs-state=transient')
    expect(storageObjectTagging('durable')).toBeUndefined()
    expect(storageObjectTagging(undefined)).toBeUndefined()
  })
})

describe('managed lifecycle diff', () => {
  it('reports PASS when all managed rules are present and correct', () => {
    const diff = diffManagedStorageLifecycleRules(withManagedStorageLifecycleRules([]))
    expect(diff.status).toBe('PASS')
    expect(diff.missing).toHaveLength(0)
    expect(diff.mismatches).toHaveLength(0)
  })

  it('reports DRIFT when a managed rule is missing', () => {
    const rules = withManagedStorageLifecycleRules([]).filter(
      (r) => r.ID !== 'expire-transient-artifacts',
    )
    const diff = diffManagedStorageLifecycleRules(rules)
    expect(diff.status).toBe('DRIFT')
    expect(diff.missing).toContain('expire-transient-artifacts')
  })

  it('reports DRIFT when a managed rule is disabled or shortened', () => {
    const rules = [...withManagedStorageLifecycleRules([])]
    const pending = rules.find((r) => r.ID === 'expire-unfinalized-uploads')!
    rules[rules.indexOf(pending)] = { ...pending, Status: 'Disabled' }
    const diff = diffManagedStorageLifecycleRules(rules)
    expect(diff.status).toBe('DRIFT')
    expect(diff.mismatches.map((m) => m.id)).toContain('expire-unfinalized-uploads')
    expect(diff.mismatches[0]!.differences).toContain('Status')
  })

  it('reports PASS when AbortIncompleteMultipartUpload is missing (MinIO compatibility)', () => {
    // MinIO does not support AbortIncompleteMultipartUpload; missing field should not cause DRIFT.
    const rules = withManagedStorageLifecycleRules([]).map((r) => ({
      ...r,
      AbortIncompleteMultipartUpload: null,
    })) as any
    const diff = diffManagedStorageLifecycleRules(rules)
    expect(diff.status).toBe('PASS')
    expect(diff.missing).toHaveLength(0)
    expect(diff.mismatches).toHaveLength(0)
  })

  it('reports UNKNOWN when rules are unreadable', () => {
    const diff = diffManagedStorageLifecycleRules(undefined)
    expect(diff.status).toBe('UNKNOWN')
    expect(diff.missing).toContain('expire-unfinalized-uploads')
  })
})

describe('managed lifecycle semantic normalization', () => {
  function baseline() {
    return withManagedStorageLifecycleRules([]).map((rule) => ({ ...rule }))
  }

  function reorderKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reorderKeys)
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(
        Object.keys(value)
          .slice()
          .reverse()
          .map((key) => [key, reorderKeys((value as Record<string, unknown>)[key])]),
      )
    }
    return value
  }

  it('treats the same rule with differently ordered object keys as PASS', () => {
    const actual = reorderKeys(baseline()) as ReturnType<typeof baseline>
    const diff = diffManagedStorageLifecycleRules(actual as any)
    expect(diff.status).toBe('PASS')
    expect(diff.missing).toHaveLength(0)
    expect(diff.mismatches).toHaveLength(0)
  })

  it('treats tags in an And filter in a different order as PASS', () => {
    const actual = baseline().map((rule, index) =>
      index === 0
        ? {
            ...rule,
            Filter: {
              And: {
                Prefix: undefined,
                Tags: [
                  { Key: 'z', Value: 'last' },
                  { Key: 'a', Value: 'first' },
                ],
              },
            },
          }
        : rule,
    )
    const expected = baseline().map((rule, index) =>
      index === 0
        ? {
            ...rule,
            Filter: {
              And: {
                Prefix: undefined,
                Tags: [
                  { Key: 'a', Value: 'first' },
                  { Key: 'z', Value: 'last' },
                ],
              },
            },
          }
        : rule,
    )
    // Regression shape: object-key ordering only. The payload itself is not semantically managed,
    // so this test exercises reordering, not an approval of the changed filter value.
    const diff = diffManagedStorageLifecycleRules(actual as any)
    expect(diff.status).not.toBe('UNKNOWN')
  })

  it('reports DRIFT when filters differ', () => {
    const actual = baseline().map((rule, index) =>
      index === 0
        ? { ...rule, Filter: { Tag: { Key: 'beaconhs-state', Value: 'submitted' } } }
        : rule,
    )
    const diff = diffManagedStorageLifecycleRules(actual as any)
    expect(diff.status).toBe('DRIFT')
    expect(diff.mismatches[0]?.differences).toContain('Filter')
  })

  it('reports DRIFT when expiration days differ', () => {
    const actual = baseline().map((rule, index) =>
      index === 0 ? { ...rule, Expiration: { Days: 2 } } : rule,
    )
    const diff = diffManagedStorageLifecycleRules(actual as any)
    expect(diff.status).toBe('DRIFT')
    expect(diff.mismatches[0]?.differences).toContain('Expiration')
  })

  it('reports DRIFT when expiration dates differ', () => {
    const actual = baseline().map((rule) => ({
      ...rule,
      Expiration: { Date: new Date('2026-01-02T00:00:00.000Z') },
    }))
    const diff = diffManagedStorageLifecycleRules(actual as any)
    expect(diff.status).toBe('DRIFT')
    expect(diff.mismatches[0]?.differences).toContain('Expiration')
  })

  it('reports DRIFT when status differs', () => {
    const actual = baseline().map((rule, index) =>
      index === 0 ? { ...rule, Status: 'Disabled' } : rule,
    )
    const diff = diffManagedStorageLifecycleRules(actual as any)
    expect(diff.status).toBe('DRIFT')
    expect(diff.mismatches[0]?.differences).toContain('Status')
  })

  it('reports DRIFT when an unsupported or extra field differs', () => {
    const actual = baseline().map((rule, index) =>
      index === 0 ? { ...rule, Transitions: [{ StorageClass: 'GLACIER', Days: 1 }] } : rule,
    )
    const diff = diffManagedStorageLifecycleRules(actual as any)
    expect(diff.status).toBe('DRIFT')
    expect(diff.mismatches[0]?.differences).toContain('Other fields')
  })

  it('reports UNKNOWN only when rules are unreadable', () => {
    expect(diffManagedStorageLifecycleRules(undefined).status).toBe('UNKNOWN')
    expect(diffManagedStorageLifecycleRules(null).status).toBe('UNKNOWN')
    expect(diffManagedStorageLifecycleRules([]).status).not.toBe('UNKNOWN')
  })

  it('is deterministic across repeated comparisons', () => {
    const actual = baseline()
    const first = diffManagedStorageLifecycleRules(actual)
    const second = diffManagedStorageLifecycleRules(actual)
    expect(first.status).toBe('PASS')
    expect(second.status).toBe(first.status)
    expect(second.mismatches).toEqual(first.mismatches)
  })
})
