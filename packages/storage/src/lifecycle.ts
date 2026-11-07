import type { LifecycleRule } from '@aws-sdk/client-s3'

const PENDING_RULE_ID = 'expire-unfinalized-uploads'
const TRANSIENT_RULE_ID = 'expire-transient-artifacts'
const STATE_TAG_KEY = 'beaconhs-state'

export type StorageObjectLifecycle = 'durable' | 'transient'

export type StorageLifecycleDiff = {
  status: 'PASS' | 'DRIFT' | 'UNKNOWN'
  checkedManagedRuleIds: string[]
  missing: string[]
  unexpected: string[]
  mismatches: Array<{
    id: string
    expected: LifecycleRule
    actual: LifecycleRule | null
    differences: string[]
  }>
}

type CanonicalTag = { key: string; value: string } | undefined | null

function canonicalNumber(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (typeof value === 'number') return value
  return undefined
}

function canonicalTag(
  tag: { Key?: string | undefined; Value?: string | undefined } | undefined,
): unknown {
  if (tag === undefined || tag === null) return tag
  return { key: tag.Key ?? '', value: tag.Value ?? '' }
}

function canonicalDate(value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? { invalid: true } : { date: time }
  }
  if (typeof value === 'string') {
    const time = Date.parse(value)
    return Number.isNaN(time) ? { invalid: true } : { date: time }
  }
  return value
}

function canonicalAndOperator(
  andOperator:
    | {
        Prefix?: string | undefined
        Tags?: Array<{ Key?: string; Value?: string }> | undefined
        ObjectSizeGreaterThan?: number | undefined
        ObjectSizeLessThan?: number | undefined
      }
    | undefined,
): unknown {
  if (andOperator === undefined || andOperator === null) return andOperator
  const tags = (andOperator.Tags ?? [])
    .map(canonicalTag)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return {
    prefix: andOperator.Prefix,
    tags,
    objectSizeGreaterThan: andOperator.ObjectSizeGreaterThan,
    objectSizeLessThan: andOperator.ObjectSizeLessThan,
  }
}

function canonicalFilter(filter: unknown): unknown {
  if (filter === undefined || filter === null) return filter
  const candidate = filter as {
    Prefix?: string | undefined
    Tag?: { Key?: string; Value?: string } | undefined
    ObjectSizeGreaterThan?: number | undefined
    ObjectSizeLessThan?: number | undefined
    And?:
      | {
          Prefix?: string | undefined
          Tags?: Array<{ Key?: string; Value?: string }> | undefined
          ObjectSizeGreaterThan?: number | undefined
          ObjectSizeLessThan?: number | undefined
        }
      | undefined
  }

  // Normalize supported filter representations without changing their meaning.
  // Array-valued predicates (such as And.Tags) are sorted so that different
  // object serializations compare as the same rule.

  // The deprecated top-level rule prefix is semantically the same matcher as a filter prefix.
  // managed rules always have a filter, so this is conservative but deterministic.
  const andFilter = candidate.And
    ? {
        prefix: candidate.And.Prefix,
        tags: (candidate.And.Tags ?? [])
          .map(canonicalTag)
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        objectSizeGreaterThan: candidate.And.ObjectSizeGreaterThan,
        objectSizeLessThan: candidate.And.ObjectSizeLessThan,
      }
    : undefined

  return {
    prefix: candidate.Prefix,
    tag: candidate.Tag === undefined ? undefined : canonicalTag(candidate.Tag),
    objectSizeGreaterThan: candidate.ObjectSizeGreaterThan,
    objectSizeLessThan: candidate.ObjectSizeLessThan,
    and: andFilter,
  }
}

function canonicalExpiration(value: unknown): unknown {
  if (value === undefined || value === null) return value
  const expiration = value as {
    Date?: Date | string | undefined
    Days?: number | undefined
    ExpiredObjectDeleteMarker?: boolean | undefined
  }
  return {
    date: canonicalDate(expiration.Date),
    days: expiration.Days,
    expiredObjectDeleteMarker: expiration.ExpiredObjectDeleteMarker,
  }
}

function canonicalRules(rule: LifecycleRule | null | undefined): [unknown, unknown] {
  if (rule === null || rule === undefined) return [undefined, undefined]
  const remainder: Record<string, unknown> = {}
  Object.keys(rule).forEach((key) => {
    if (key === 'ID' || key === 'Status' || key === 'Filter' || key === 'Expiration') return
    const value = (rule as unknown as Record<string, unknown>)[key]
    // MinIO cannot support AbortIncompleteMultipartUpload. It is allowed to be
    // absent from compatibility environments and does not represent lifecycle drift.
    if (key !== 'AbortIncompleteMultipartUpload') remainder[key] = value
  })
  return [remainder, undefined]
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function normaliseStatus(value: unknown): string {
  return canonicalJson(value)
}

function normaliseFilter(value: unknown): string {
  return canonicalJson(canonicalFilter(value))
}

function normaliseExpiration(value: unknown): string {
  return canonicalJson(canonicalExpiration(value))
}

function normaliseOther(value: LifecycleRule | null | undefined): string {
  const [remainder] = canonicalRules(value)
  return canonicalJson(remainder)
}

export function diffManagedStorageLifecycleRules(
  actualRules: readonly LifecycleRule[] | null | undefined,
): StorageLifecycleDiff {
  const checkedManagedRuleIds = [PENDING_RULE_ID, TRANSIENT_RULE_ID]
  if (actualRules === null || actualRules === undefined) {
    return {
      status: 'UNKNOWN',
      checkedManagedRuleIds,
      missing: [...checkedManagedRuleIds],
      unexpected: [],
      mismatches: [
        {
          id: PENDING_RULE_ID,
          expected: withManagedStorageLifecycleRules([]).find((r) => r.ID === PENDING_RULE_ID)!,
          actual: null,
          differences: ['lifecycle rules unreadable or unavailable'],
        },
      ],
    }
  }
  const expectedRules = withManagedStorageLifecycleRules([])
  const expectedById = new Map(expectedRules.map((rule) => [rule.ID!, rule]))
  const actualById = new Map(
    (actualRules ?? [])
      .filter((rule): rule is LifecycleRule & { ID: string } => Boolean(rule?.ID))
      .map((rule) => [rule.ID, rule]),
  )
  const missing = checkedManagedRuleIds.filter((id) => !actualById.has(id))
  const unexpected: string[] = []
  const actualManagedIds = [...actualById.keys()].filter((id) => checkedManagedRuleIds.includes(id))
  const unexpectedManaged = actualManagedIds.filter((id) => !expectedById.has(id))
  const mismatches: StorageLifecycleDiff['mismatches'] = []
  for (const id of checkedManagedRuleIds) {
    const expected = expectedById.get(id)
    const actual = actualById.get(id) ?? null
    if (!expected) continue
    if (!actual) continue // counted as missing, not mismatched
    const differences: string[] = []
    if (normaliseStatus(expected.Status) !== normaliseStatus(actual.Status)) {
      differences.push('Status')
    }
    if (normaliseFilter(expected.Filter) !== normaliseFilter(actual.Filter)) {
      differences.push('Filter')
    }
    if (normaliseExpiration(expected.Expiration) !== normaliseExpiration(actual.Expiration)) {
      differences.push('Expiration')
    }
    if (normaliseOther(expected) !== normaliseOther(actual)) {
      if (differences.length === 0) differences.push('Other fields')
    }
    if (differences.length > 0) mismatches.push({ id, expected, actual, differences })
  }
  const drift = missing.length > 0 || unexpectedManaged.length > 0 || mismatches.length > 0
  return {
    status: drift ? 'DRIFT' : 'PASS',
    checkedManagedRuleIds,
    missing,
    unexpected: unexpectedManaged,
    mismatches,
  }
}

export function storageObjectTagging(
  lifecycle: StorageObjectLifecycle | undefined,
): string | undefined {
  return lifecycle === 'transient' ? `${STATE_TAG_KEY}=transient` : undefined
}

export function withManagedStorageLifecycleRules(
  existingRules: readonly LifecycleRule[],
): LifecycleRule[] {
  return [
    ...existingRules.filter((rule) => rule.ID !== PENDING_RULE_ID && rule.ID !== TRANSIENT_RULE_ID),
    {
      ID: PENDING_RULE_ID,
      Status: 'Enabled',
      Filter: { Tag: { Key: STATE_TAG_KEY, Value: 'pending' } },
      Expiration: { Days: 1 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
    {
      ID: TRANSIENT_RULE_ID,
      Status: 'Enabled',
      Filter: { Tag: { Key: STATE_TAG_KEY, Value: 'transient' } },
      Expiration: { Days: 1 },
    },
  ]
}
