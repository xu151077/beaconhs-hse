import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { serverActionKeyFingerprint } from '../src/lib/server-action-key'

const SCRIPT = fileURLToPath(new URL('./verify-server-action-key-consistency.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))

const KEY_A = Buffer.alloc(32, 11).toString('base64')
const KEY_B = Buffer.alloc(32, 13).toString('base64')

type Run = { status: number; stdout: string; stderr: string }

async function fingerprintOf(key: string): Promise<string> {
  const fingerprint = await serverActionKeyFingerprint(key)
  if (!fingerprint) throw new Error('expected a fingerprint for a valid key')
  return fingerprint
}

function run(args: readonly string[], env: Record<string, string | undefined>): Run {
  try {
    const stdout = execFileSync(TSX, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

describe('verify-server-action-key-consistency', () => {
  it('prints a fingerprint for the configured key without printing the key', async () => {
    const result = run(['--print'], { NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: KEY_A })

    expect(result.status).toBe(0)
    const expected = await fingerprintOf(KEY_A)
    expect(result.stdout).toContain(`fingerprint=${expected}`)
    expect(result.stdout).not.toContain(KEY_A)
    expect(result.stdout).not.toContain(atob(KEY_A))
  })

  it('exits 0 when the instance fingerprint matches the expected value', async () => {
    const expected = await fingerprintOf(KEY_A)
    const result = run(['--expect', expected], { NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: KEY_A })

    expect(result.status).toBe(0)
  })

  it('exits 1 when the instance holds a different key', async () => {
    const expected = await fingerprintOf(KEY_A)
    const result = run(['--expect', expected], { NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: KEY_B })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fingerprint mismatch')
    expect(result.stderr).not.toContain(KEY_B)
  })

  it('exits 2 when no key is configured at all', () => {
    const result = run(['--print'], {})

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('No Server Action key is configured')
  })
})
