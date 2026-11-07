#!/usr/bin/env node
/**
 * EA-66A.1 — Server Action key handling tests.
 *
 * These are static/isolated tests. No image is built, no deployment runs, and no
 * formal key is created. A throwaway test key is generated in a private temp
 * directory, used to compare the canonical fingerprint CLI with the application
 * consistency CLI, then removed.
 *
 * Run: node --test scripts/ci/server-action-key-handling.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const read = (path) => readFileSync(join(ROOT, path), 'utf8')

test('EA661-KEY-01 the Dockerfile consumes the key as a required BuildKit secret', () => {
  const dockerfile = read('Dockerfile')
  assert.match(dockerfile, /--mount=type=secret,id=next_server_actions_key,required=true/)
  assert.match(
    dockerfile,
    /NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="\$\(cat \/run\/secrets\/next_server_actions_key\)"/,
  )
  assert.doesNotMatch(dockerfile, /ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/)
  assert.doesNotMatch(dockerfile, /--build-arg NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/)
})

test('EA661-KEY-02 both build entry points pass the key as a secret, never a build-arg', () => {
  for (const path of [
    'scripts/build-local-image-with-key-gate.sh',
    'scripts/build-drill-image.sh',
  ]) {
    const script = read(path)
    assert.match(script, /--secret id=next_server_actions_key/, path)
    assert.match(script, /--build-arg NEXT_SERVER_ACTIONS_KEY_FINGERPRINT/, path)
    assert.doesNotMatch(script, /--build-arg NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/, path)
    assert.doesNotMatch(script, /echo .*NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/, path)
  }
})

test('EA661-KEY-03 the runtime override is mandatory and must match the build-time key', () => {
  const compose = read('deploy/local-production.compose.yaml')
  assert.match(
    compose,
    /NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: \$\{NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:\?required — must match the build-time key\}/,
  )
})

test('EA661-KEY-04 the legacy Dokploy stack does not invent a per-instance key', () => {
  const compose = read('deploy/dokploy-dev.compose.yaml')
  assert.doesNotMatch(compose, /NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/)
})

test('EA661-KEY-05 the documented key path is outside the repository', () => {
  const docs = read('docs/evidence/ea661/server-action-key-design.md')
  assert.match(docs, /outside (the )?repository/i)
  assert.match(docs, /mode 600/i)
  assert.match(docs, /openssl rand -base64 32/)
  assert.match(docs, /not in the release package/i)
})

test('EA661-KEY-06 temp-key fingerprint and application consistency agree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea661-key-'))
  const keyFile = join(dir, 'server-action-key')
  const key = randomBytes(32).toString('base64')
  writeFileSync(keyFile, key, { mode: 0o600 })
  chmodSync(keyFile, 0o600)

  try {
    const cli = spawnSync('node', ['scripts/ci/server-action-key-fingerprint.mjs', keyFile], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
    })
    assert.equal(cli.status, 0, cli.stderr)
    const fingerprint = cli.stdout.trim()
    assert.match(fingerprint, /^[0-9a-f]{32}$/)
    assert.ok(!cli.stdout.includes(key), 'fingerprint CLI must not print the key')
    assert.ok(!cli.stderr.includes(key), 'fingerprint CLI stderr must not contain the key')

    const app = spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'scripts/verify-server-action-key-consistency.ts',
        '--print',
        '--key-file',
        keyFile,
      ],
      { cwd: join(ROOT, 'apps/web'), encoding: 'utf8', timeout: 60000 },
    )
    assert.equal(app.status, 0, app.stderr)
    assert.equal(app.stdout.trim(), `fingerprint=${fingerprint}`)
    assert.ok(!app.stdout.includes(key), 'application CLI must not print the key')

    const correct = spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'scripts/verify-server-action-key-consistency.ts',
        '--expect',
        fingerprint,
        '--key-file',
        keyFile,
      ],
      { cwd: join(ROOT, 'apps/web'), encoding: 'utf8', timeout: 60000 },
    )
    assert.equal(correct.status, 0, correct.stderr)

    const wrong = spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'scripts/verify-server-action-key-consistency.ts',
        '--expect',
        '0'.repeat(32),
        '--key-file',
        keyFile,
      ],
      { cwd: join(ROOT, 'apps/web'), encoding: 'utf8', timeout: 60000 },
    )
    assert.equal(wrong.status, 1)
    assert.match(wrong.stderr, /fingerprint mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    assert.equal(existsSync(keyFile), false)
  }
})
