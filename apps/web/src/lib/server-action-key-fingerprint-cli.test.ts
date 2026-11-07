import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { serverActionKeyFingerprint } from './server-action-key'

// The build pipeline needs the key fingerprint before any `pnpm install` (the
// Dockerfile binds it into the build cache key, and the deploy workflow computes
// it in a dependency-free step). That makes `scripts/ci/server-action-key-fingerprint.mjs`
// the only second implementation of the fingerprint, so it is pinned here to the
// canonical `serverActionKeyFingerprint`. A change to the label, the truncation
// or the key validation in either place fails this test.

const script = fileURLToPath(
  new URL('../../../../scripts/ci/server-action-key-fingerprint.mjs', import.meta.url),
)

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

/**
 * Write one key into a throwaway directory and always remove that directory,
 * whether the assertion inside `run` succeeds or throws. The CLI itself is a
 * child process and cannot clean the host filesystem, so the test owns this.
 */
async function withKey<T>(contents: string, run: (path: string) => T | Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'server-action-key-'))
  const path = join(directory, 'key')
  try {
    writeFileSync(path, contents, { mode: 0o600 })
    return await run(path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('server-action-key-fingerprint CLI', () => {
  it.each([16, 24, 32])('matches the canonical fingerprint for a %i-byte key', async (bytes) => {
    const raw = Buffer.from(
      Array.from({ length: bytes }, (_, index) => (index * 37 + 11) % 256),
    ).toString('base64')

    await withKey(`${raw}\n`, async (path) => {
      const result = run([path])
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(await serverActionKeyFingerprint(raw))
      expect(result.stdout.trim()).toMatch(/^[0-9a-f]{32}$/)
    })
  })

  it('never prints the key', async () => {
    const raw = Buffer.alloc(32, 7).toString('base64')
    await withKey(raw, (path) => {
      const result = run([path])

      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain(raw)
      expect(result.stderr).not.toContain(raw)
    })
  })

  it('rejects an invalid key with exit 2', async () => {
    await withKey('not-a-valid-key', (path) => {
      const result = run([path])

      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('not a valid base64-encoded AES key')
    })
  })

  it('rejects a key of the wrong length with exit 2', async () => {
    // 20 raw bytes is base64 but is not an AES key length Next.js accepts.
    await withKey(Buffer.alloc(20, 3).toString('base64'), (path) => {
      const result = run([path])

      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
    })
  })

  it('rejects an empty key with exit 2', async () => {
    await withKey('   \n', (path) => {
      const result = run([path])

      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
    })
  })

  it('removes the temporary key directory after success and rejection', async () => {
    const paths: string[] = []

    await withKey(Buffer.alloc(32, 7).toString('base64'), (path) => {
      paths.push(path)
      expect(run([path]).status).toBe(0)
    })
    await withKey('not-a-valid-key', (path) => {
      paths.push(path)
      expect(run([path]).status).toBe(2)
    })

    expect(paths).toHaveLength(2)
    for (const path of paths) {
      expect(existsSync(dirname(path)), `temporary directory was left behind: ${path}`).toBe(false)
    }
  })

  it('rejects a missing file with exit 2', () => {
    const result = run([join(tmpdir(), 'server-action-key-does-not-exist')])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('missing or unreadable')
  })

  it('requires a key file argument', () => {
    const result = run([])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage:')
  })
})
