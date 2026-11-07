// S3-layer tests for the parts that do not need a server: multipart sizing and the
// lifecycle XML round-trip.
//
// The lifecycle round-trip matters more than it looks. The configuration is carried as
// XML so a backup taken on one store restores the same request on another;
// round-tripping through the SDK's typed model would drop fields the SDK does not
// expose, which is exactly the silent configuration loss this tool exists to prevent.

import { describe, expect, it } from 'vitest'
import {
  MULTIPART_PART_SIZE_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  parseLifecycleXml,
  partCount,
  renderLifecycleXml,
  shouldUseMultipart,
} from './s3'

describe('multipart sizing', () => {
  it('mirrors packages/storage thresholds', () => {
    expect(MULTIPART_THRESHOLD_BYTES).toBe(256 * 1024 * 1024)
    expect(MULTIPART_PART_SIZE_BYTES).toBe(64 * 1024 * 1024)
  })

  it('uses a single PUT below the threshold', () => {
    expect(shouldUseMultipart(0)).toBe(false)
    expect(shouldUseMultipart(MULTIPART_THRESHOLD_BYTES - 1)).toBe(false)
  })

  it('switches to multipart at the threshold', () => {
    expect(shouldUseMultipart(MULTIPART_THRESHOLD_BYTES)).toBe(true)
  })

  it('switches to multipart above the single-PUT ceiling regardless of threshold', () => {
    // S3 rejects a single PUT above 5 GiB, so a large object must be multipart even
    // if the threshold were raised.
    expect(shouldUseMultipart(6 * 1024 * 1024 * 1024)).toBe(true)
  })

  it('computes the part count the way BeaconHS does', () => {
    expect(partCount(300 * 1024 * 1024)).toBe(5)
    expect(partCount(256 * 1024 * 1024)).toBe(4)
    expect(partCount(MULTIPART_PART_SIZE_BYTES * 2)).toBe(2)
    expect(partCount(0)).toBe(0)
  })
})

describe('lifecycle XML round-trip', () => {
  // The two rules BeaconHS installs, verbatim from packages/storage/src/lifecycle.ts.
  const rules = [
    {
      ID: 'expire-unfinalized-uploads',
      Status: 'Enabled' as const,
      Filter: { Tag: { Key: 'beaconhs-state', Value: 'pending' } },
      Expiration: { Days: 1 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
    {
      ID: 'expire-transient-artifacts',
      Status: 'Enabled' as const,
      Filter: { Tag: { Key: 'beaconhs-state', Value: 'transient' } },
      Expiration: { Days: 1 },
    },
  ]

  it('preserves every field through render and parse', () => {
    const parsed = parseLifecycleXml(renderLifecycleXml(rules))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({
      ID: 'expire-unfinalized-uploads',
      Status: 'Enabled',
      Filter: { Tag: { Key: 'beaconhs-state', Value: 'pending' } },
      Expiration: { Days: 1 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    })
    expect(parsed[1]).toMatchObject({
      ID: 'expire-transient-artifacts',
      Expiration: { Days: 1 },
    })
  })

  it('keeps the tag filter, which is what makes the rule selective', () => {
    const xml = renderLifecycleXml(rules)
    expect(xml).toContain('<Tag><Key>beaconhs-state</Key><Value>pending</Value></Tag>')
    expect(parseLifecycleXml(xml)[0]!.Filter!.Tag).toEqual({
      Key: 'beaconhs-state',
      Value: 'pending',
    })
  })

  it('keeps AbortIncompleteMultipartUpload, which cleans up unfinished uploads', () => {
    const xml = renderLifecycleXml(rules)
    expect(xml).toContain(
      '<AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation>',
    )
    expect(parseLifecycleXml(xml)[0]!.AbortIncompleteMultipartUpload).toEqual({
      DaysAfterInitiation: 1,
    })
  })

  it('escapes XML-significant characters in identifiers and values', () => {
    const hostile = [
      {
        ID: 'rule<&">',
        Status: 'Enabled' as const,
        Filter: { Tag: { Key: 'a&b', Value: '<c>' } },
        Expiration: { Days: 1 },
      },
    ]
    const parsed = parseLifecycleXml(renderLifecycleXml(hostile))
    expect(parsed[0]!.ID).toBe('rule<&">')
    expect(parsed[0]!.Filter!.Tag).toEqual({ Key: 'a&b', Value: '<c>' })
  })

  it('parses an empty configuration', () => {
    expect(parseLifecycleXml('<LifecycleConfiguration></LifecycleConfiguration>')).toEqual([])
  })

  it('ignores surrounding whitespace and declarations', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<LifecycleConfiguration><Rule><ID>x</ID><Status>Enabled</Status></Rule></LifecycleConfiguration>`
    expect(parseLifecycleXml(xml)).toHaveLength(1)
  })
})
