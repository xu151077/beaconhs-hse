// The command-line surface for the two new capabilities: `inventory --diff` and
// encrypted `backup`, plus the key generator they depend on.
//
// What is worth pinning at this layer is the WIRING, not the classification (that
// is `diff.test.ts`) or the cryptography (that is `crypto.test.ts`): the flags reach
// the right function, the report lands where it was told to, and a secret-generating
// flag neither touches a store nor leaves a file behind.

import { chmod, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main, parseArgs, UsageError } from './cli'
import { MANIFEST_SCHEMA_VERSION, type Manifest } from './manifest'
import { MANIFEST_NAME } from './hash'

const STORE_ENV = {
  OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:1',
  OBJECT_STORE_BUCKET: 'b',
  OBJECT_STORE_ACCESS_KEY_ID: 'test-access-key-0001',
  OBJECT_STORE_SECRET_ACCESS_KEY: 'test-secret-value-abcdef0123456789',
} as const

function manifestOf(objects: Manifest['objects']): Manifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    created_at: '2026-10-12T00:00:00.000Z',
    source: { endpoint: 'http://127.0.0.1:1', bucket: 'b', region: 'auto' },
    object_count: objects.length,
    total_bytes: objects.reduce((sum, o) => sum + o.size, 0),
    lifecycle: { status: 'none' },
    objects,
  }
}

describe('argument parsing', () => {
  it('accepts the diff flags', () => {
    const p = parseArgs([
      'inventory',
      '--diff',
      '/backups/a',
      '--current',
      '/backups/b',
      '--output',
      '/tmp/r.json',
    ])
    expect(p.diffBaseline).toBe('/backups/a')
    expect(p.diffCurrent).toBe('/backups/b')
    expect(p.outputPath).toBe('/tmp/r.json')
  })

  it('accepts --encrypt on backup', () => {
    expect(parseArgs(['backup', '--destination', '/tmp/b', '--encrypt']).encrypt).toBe(true)
  })

  it('still requires --destination for a real backup', () => {
    expect(() => parseArgs(['backup'])).toThrow(UsageError)
  })

  it('does not require --destination when only generating a key', () => {
    expect(parseArgs(['backup', '--generate-key']).generateKey).toBe(true)
  })

  it('names the new flags in the usage text', () => {
    let usage = ''
    try {
      parseArgs(['--help'])
    } catch (error) {
      usage = (error as Error).message
    }
    expect(usage).toContain('--diff')
    expect(usage).toContain('--encrypt')
    expect(usage).toContain('--generate-key')
    // The honest reason a live inventory cannot say UNCHANGED belongs in the help.
    expect(usage).toContain('UNKNOWN')
  })
})

describe('main', () => {
  const dirs: string[] = []
  const savedEnv = { ...process.env }

  afterEach(async () => {
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key]
    }
  })

  async function tmp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-cli-'))
    dirs.push(dir)
    return dir
  }

  it('prints a fresh HMAC key and writes nothing to disk', async () => {
    const dir = await tmp()
    const before = await readdir(dir)
    const written: string[] = []
    const realWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stdout.write
    try {
      expect(await main(['backup', '--generate-key'])).toBe(0)
    } finally {
      process.stdout.write = realWrite
    }
    const key = written.join('').trim()
    // 32 random bytes, base64url — the shape `loadHmacKey` expects.
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await readdir(dir)).toEqual(before)
  })

  it('generates a different key each time', async () => {
    const read = async (): Promise<string> => {
      const written: string[] = []
      const realWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        return true
      }) as typeof process.stdout.write
      try {
        await main(['backup', '--generate-key'])
      } finally {
        process.stdout.write = realWrite
      }
      return written.join('').trim()
    }
    expect(await read()).not.toBe(await read())
  })

  it('writes a diff report where --output says, atomically', async () => {
    const dir = await tmp()
    const baseline = join(dir, 'baseline')
    await mkdir(baseline, { recursive: true })
    const kept = {
      key: 'keep.txt',
      size: 5,
      sha256: 'a'.repeat(64),
      contentType: 'text/plain',
      contentDisposition: null,
      metadata: {},
      tags: {},
      file: `objects/${'a'.repeat(64)}`,
    }
    await writeFile(
      join(baseline, MANIFEST_NAME),
      `${JSON.stringify(manifestOf([kept]), null, 2)}\n`,
    )

    const out = join(dir, 'report.json')
    Object.assign(process.env, STORE_ENV)
    // Both sides are manifests, so no network access is needed and the comparison is
    // authoritative. --endpoint/--bucket are still passed because the CLI resolves
    // the store before dispatch.
    expect(
      await main([
        'inventory',
        '--endpoint',
        STORE_ENV.OBJECT_STORE_ENDPOINT,
        '--bucket',
        'b',
        '--diff',
        baseline,
        '--current',
        baseline,
        '--output',
        out,
      ]),
    ).toBe(0)

    const report = JSON.parse(await readFile(out, 'utf8')) as {
      counts: { unchanged: number }
      content_comparison_authoritative: boolean
    }
    expect(report.counts.unchanged).toBe(1)
    expect(report.content_comparison_authoritative).toBe(true)
    // The temp name used for the publish is not left behind on success.
    expect(await readdir(dir)).not.toContain('report.json.tmp')
  })

  it('refuses an encrypted backup when the keys are absent', async () => {
    const dir = await tmp()
    for (const key of [
      'BACKUP_AGE_RECIPIENT',
      'BACKUP_AGE_RECIPIENT_FILE',
      'BACKUP_HMAC_KEY',
      'BACKUP_HMAC_KEY_FILE',
    ]) {
      delete process.env[key]
    }
    // Unreachable endpoint, but the key check must fire before any network use:
    // silently producing a plaintext backup here would be the worst possible outcome.
    await expect(
      main([
        'backup',
        '--endpoint',
        'http://127.0.0.1:1',
        '--bucket',
        'b',
        '--destination',
        dir,
        '--encrypt',
      ]),
    ).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })

  it('writes a key file the tool will accept later', async () => {
    const dir = await tmp()
    const keyFile = join(dir, 'hmac.key')
    const written: string[] = []
    const realWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stdout.write
    try {
      await main(['backup', '--generate-key'])
    } finally {
      process.stdout.write = realWrite
    }
    // The operator stores the printed key; the tool must then accept that file.
    await writeFile(keyFile, `${written.join('').trim()}\n`, { mode: 0o600 })
    await chmod(keyFile, 0o600)
    const { loadHmacKey } = await import('./crypto')
    process.env.BACKUP_HMAC_KEY_FILE = keyFile
    expect((await loadHmacKey()).toString('utf8')).toBe(written.join('').trim())
  })
})
