import { describe, expect, it } from 'vitest'
import { assertSameScratchDatabase, assertScratchDatabaseUrl } from './scratch-database'

// A live DB suite TRUNCATEs and deletes tenants. The guard must refuse a URL
// that names a real database, not merely a URL that happens to connect.

describe('assertScratchDatabaseUrl', () => {
  it('accepts isolated test, scratch, and CI database names', () => {
    for (const name of [
      'beaconhs_test',
      'beaconhs_ci_owner',
      'beaconhs_dt_scratch_runtime_123',
      'scratch',
      'test-db',
    ]) {
      expect(assertScratchDatabaseUrl(`postgresql://user:pass@localhost:5432/${name}`)).toContain(
        `/${name}`,
      )
    }
  })

  it('refuses a real-sounding database even when it is reachable', () => {
    for (const name of ['beaconhs', 'production', 'app', 'postgres', 'template1']) {
      expect(() =>
        assertScratchDatabaseUrl(`postgresql://user:pass@localhost:5432/${name}`),
      ).toThrow(/isolated test database|reserved database/)
    }
  })

  it('refuses a non-postgres URL', () => {
    expect(() => assertScratchDatabaseUrl('mysql://localhost/beaconhs_test')).toThrow(/postgres/)
  })
})

describe('assertSameScratchDatabase', () => {
  it('accepts different roles on the same host, port, and database', () => {
    expect(() =>
      assertSameScratchDatabase(
        'postgresql://owner:one@localhost:5432/beaconhs_test',
        'postgresql://app:two@localhost:5432/beaconhs_test',
      ),
    ).not.toThrow()
  })

  it('refuses a runtime client pointed at a different database', () => {
    expect(() =>
      assertSameScratchDatabase(
        'postgresql://owner:one@localhost:5432/beaconhs_test',
        'postgresql://app:two@localhost:5432/beaconhs',
      ),
    ).toThrow(/different databases/)
  })
})
