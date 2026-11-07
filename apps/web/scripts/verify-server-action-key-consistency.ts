#!/usr/bin/env tsx

/**
 * Deployment-level invariant: every BeaconHS web instance must hold the SAME
 * Server Action encryption key.
 *
 * Next.js 16.3.5 requires this ("all instances must use the same encryption
 * key") but offers no way to detect a mismatch: an instance cannot see the
 * other instances' configuration, and a mismatch only surfaces later as
 * "Failed to find Server Action" for the requests that cross instances.
 *
 * This script turns that requirement into a checkable, blocking step. It
 * compares the instance's key against an expected fingerprint instead of
 * against the key itself:
 *
 *   fingerprint = HMAC-SHA256(key, "beaconhs:server-action-key:fingerprint:v1")
 *
 * The fingerprint is stable for one key, unrelated for another, and cannot be
 * inverted into the key — it is not a plain hash, so an observer cannot mount an
 * offline dictionary attack against it. Only the key's identity is observable.
 *
 * Usage:
 *   tsx scripts/verify-server-action-key-consistency.ts --print
 *   tsx scripts/verify-server-action-key-consistency.ts --expect <fingerprint>
 *
 * The key comes from `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, or from `--key-file`
 * (the same file the build uses as the BuildKit secret) when the deployment
 * runs on the embedded build-time key.
 *
 * Exit codes: 0 match, 1 mismatch, 2 configuration/usage error.
 */

import { readFileSync } from 'node:fs'
import { serverActionKeyFingerprint } from '../src/lib/server-action-key'

const USAGE = `usage: verify-server-action-key-consistency.ts [--print | --expect <fingerprint>] [--key-file <path>]`

type Options = {
  mode: 'print' | 'expect'
  expected: string | null
  keyFile: string | null
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { mode: 'print', expected: null, keyFile: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--print') {
      options.mode = 'print'
    } else if (arg === '--expect') {
      options.mode = 'expect'
      options.expected = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--key-file') {
      options.keyFile = argv[index + 1] ?? null
      index += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (options.mode === 'expect' && !options.expected) {
    throw new Error('--expect needs a fingerprint')
  }
  return options
}

async function main(): Promise<number> {
  let options: Options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    console.error(USAGE)
    return 2
  }

  const raw = options.keyFile
    ? readFileSync(options.keyFile, 'utf8').trim()
    : (process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY ?? '').trim()

  if (raw === '') {
    console.error(
      'No Server Action key is configured for this instance. ' +
        'Pass --key-file <path> to verify the build-time key, or set ' +
        'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY for a runtime override.',
    )
    return 2
  }

  const fingerprint = await serverActionKeyFingerprint(raw)
  if (!fingerprint) {
    console.error('The configured Server Action key is not a valid key; the instance is not ready.')
    return 2
  }

  if (options.mode === 'print') {
    console.log(`fingerprint=${fingerprint}`)
    return 0
  }

  if (fingerprint !== options.expected) {
    console.error(
      'Server Action key fingerprint mismatch: this instance does not hold the expected key.',
    )
    return 1
  }
  console.log('Server Action key fingerprint matches the expected value.')
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error((error as Error)?.message ?? String(error))
    process.exitCode = 2
  })
