// PD-02 P-2 — dedicated audit connection against REAL PostgreSQL.
//
// Proves the fail-closed configuration contract and the pool's independence
// from the business pools. No mocks: a disposable postgres:16-alpine cluster
// carries the real audit_service identity from the P-1 role model.

import { execSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres, { type Sql } from 'postgres'
import {
  AUDIT_DATABASE_POOL_MAX,
  AuditConnectionUnavailableError,
  closeAuditConnection,
  createAuditConnection,
  getAuditConnection,
  readAuditDatabaseUrl,
} from './audit-client'

const NAME = `beaconhs-audit-client-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let superSql: Sql
let serviceUrl = ''
let ready = false

function docker(...args: string[]): string {
  return execSync(`docker ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function port(): number {
  return Number(docker('port', NAME, '5432').trim().split(':').pop())
}

async function waitReady(url: string) {
  for (let i = 0; i < 40; i++) {
    try {
      const c = postgres(url, { max: 1, connect_timeout: 3 })
      await c`select 1`
      await c.end()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error('postgres not ready')
}

beforeAll(async () => {
  try {
    execSync('docker --version', { stdio: 'ignore' })
  } catch {
    return
  }
  docker(
    'run -d --name',
    NAME,
    '-e',
    'POSTGRES_PASSWORD=testpw',
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    'POSTGRES_DB=beaconhs',
    '-p',
    '127.0.0.1:0:5432',
    'postgres:16-alpine',
  )
  const adminUrl = `postgresql://postgres:testpw@127.0.0.1:${port()}/beaconhs`
  await waitReady(adminUrl)
  superSql = postgres(adminUrl, { max: 1 })
  // Same restricted identity model as provision.sql: audit_service is a plain
  // LOGIN role with no table privileges — the connection itself is the boundary.
  await superSql.unsafe(`
    CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL);
    CREATE TABLE incidents (id uuid PRIMARY KEY, title text NOT NULL);
    CREATE ROLE audit_service LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'auditpw';
    GRANT CONNECT ON DATABASE beaconhs TO audit_service;
    GRANT USAGE ON SCHEMA public TO audit_service;
  `)
  serviceUrl = `postgresql://audit_service:auditpw@127.0.0.1:${port()}/beaconhs`
  ready = true
})

afterAll(async () => {
  await closeAuditConnection()
  try {
    await superSql?.end()
  } catch {}
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' })
  } catch {}
})

describe('audit connection configuration (fail-closed contract)', () => {
  it('returns null and refuses to build a pool when AUDIT_DATABASE_URL is missing', () => {
    delete process.env.AUDIT_DATABASE_URL
    expect(readAuditDatabaseUrl()).toBeNull()
    expect(() => createAuditConnection()).toThrow(AuditConnectionUnavailableError)
  })

  it('treats empty and whitespace-only values exactly like missing (no fallback)', () => {
    process.env.AUDIT_DATABASE_URL = ''
    expect(readAuditDatabaseUrl()).toBeNull()
    process.env.AUDIT_DATABASE_URL = '   '
    expect(readAuditDatabaseUrl()).toBeNull()
    expect(() => createAuditConnection()).toThrow(AuditConnectionUnavailableError)
  })

  it('never falls back to DATABASE_URL / SUPERADMIN_DATABASE_URL', () => {
    delete process.env.AUDIT_DATABASE_URL
    process.env.DATABASE_URL = 'postgresql://beaconhs_app:apppw@127.0.0.1:1/beaconhs'
    process.env.SUPERADMIN_DATABASE_URL = 'postgresql://beaconhs_super:superpw@127.0.0.1:1/beaconhs'
    try {
      expect(readAuditDatabaseUrl()).toBeNull()
      expect(() => createAuditConnection()).toThrow(AuditConnectionUnavailableError)
    } finally {
      delete process.env.DATABASE_URL
      delete process.env.SUPERADMIN_DATABASE_URL
    }
  })

  it('the pool size is the V3 fixed cap, not a tuning knob', () => {
    expect(AUDIT_DATABASE_POOL_MAX).toBe(2)
  })
})

describe('audit connection (real PostgreSQL, audit_service identity)', () => {
  it('connects as audit_service and the connection itself carries no privileges', async () => {
    process.env.AUDIT_DATABASE_URL = serviceUrl
    const audit = getAuditConnection()
    const rows = await audit.sql`select current_user, session_user`
    expect(rows[0]?.current_user).toBe('audit_service')
    expect(rows[0]?.session_user).toBe('audit_service')
    // No table grants were issued to audit_service: direct reads fail even
    // though the login succeeds — the boundary is the role, not the network.
    await expect(audit.sql`select * from incidents`).rejects.toThrow(/permission denied/i)
    await expect(audit.sql`select * from audit_log`).rejects.toThrow(/permission denied/i)
  })

  it('the audit pool never shares sockets with the business (superuser) pool', async () => {
    const audit = getAuditConnection()
    const auditPids = await audit.sql`select pg_backend_pid()::int as pid`
    const businessPids = await superSql`select pg_backend_pid()::int as pid`
    expect(businessPids[0]?.pid).toBeDefined()
    expect(businessPids[0]?.pid).not.toBe(auditPids[0]?.pid)
  })

  it('an unreachable audit database fails loudly and does not disturb business connections', async () => {
    // A closed port: every audit query must reject with a connection error,
    // while an independently-created business pool keeps working.
    process.env.AUDIT_DATABASE_URL = `postgresql://audit_service:auditpw@127.0.0.1:1/beaconhs`
    await closeAuditConnection()
    const dead = getAuditConnection()
    await expect(dead.sql`select 1`).rejects.toThrow()
    const stillFine = await superSql`select 1 as ok`
    expect(stillFine[0]?.ok).toBe(1)
  })

  it('the singleton re-reads configuration after closeAuditConnection()', async () => {
    process.env.AUDIT_DATABASE_URL = serviceUrl
    await closeAuditConnection()
    const audit = getAuditConnection()
    const rows = await audit.sql`select 1 as ok`
    expect(rows[0]?.ok).toBe(1)
  })
})
