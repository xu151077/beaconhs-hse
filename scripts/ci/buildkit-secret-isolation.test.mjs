#!/usr/bin/env node
/**
 * EA-66B.1 — isolated BuildKit secret-mount test.
 *
 * Builds a throwaway `FROM alpine:3.23` fixture (already present locally), mounts
 * a temporary key as the same BuildKit secret id the application Dockerfile uses,
 * and proves the key:
 *
 *   - is readable during the build;
 *   - is absent from the later layer and at runtime;
 *   - is absent from the build log, image config and image history.
 *
 * No registry, no BeaconHS application image, no `docker save`, no deployment.
 * The fixture image is removed on every exit path.
 *
 * Run: node --test scripts/ci/buildkit-secret-isolation.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BASE = 'alpine:3.23'
const IMAGE = `ea66b1-secret-test:${process.pid}`
const DEPLOYMENT_ID = 'a'.repeat(40)

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    input: options.input,
  })
}

function skipReason() {
  if (run('docker', ['info']).status !== 0) return 'Docker daemon is not available'
  if (run('docker', ['image', 'inspect', BASE]).status !== 0) {
    return `local test base ${BASE} is not present`
  }
  return ''
}

const SKIP = skipReason()
const TEST_OPTS = SKIP ? { skip: SKIP } : {}
if (SKIP) console.error(`buildkit-secret-isolation: ${SKIP}`)

test('EA66B1-SECRET-01 the key is mounted, then absent from layer/runtime/log', TEST_OPTS, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea66b1-secret-'))
  const keyFile = join(dir, 'key')
  const key = randomBytes(32).toString('base64')
  writeFileSync(keyFile, key, { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  writeFileSync(
    join(dir, 'Dockerfile'),
    `FROM ${BASE}
RUN --mount=type=secret,id=next_server_actions_key \\
    test -s /run/secrets/next_server_actions_key
RUN test ! -e /run/secrets/next_server_actions_key
LABEL com.beaconhs.deployment-id="${DEPLOYMENT_ID}"
CMD ["sh", "-c", "test ! -e /run/secrets/next_server_actions_key"]
`,
  )

  let build
  try {
    build = run(
      'docker',
      [
        'build',
        '--secret',
        `id=next_server_actions_key,src=${keyFile}`,
        '--label',
        `com.beaconhs.deployment-id=${DEPLOYMENT_ID}`,
        '--tag',
        IMAGE,
        '--file',
        join(dir, 'Dockerfile'),
        dir,
      ],
      { timeout: 180000 },
    )
    assert.equal(build.status, 0, `docker build failed: ${build.stderr}`)

    // The secret value must not be in the build output.
    assert.equal(build.stdout.includes(key), false, 'key appeared in build stdout')
    assert.equal(build.stderr.includes(key), false, 'key appeared in build stderr')

    // The key must not be in image config or layer history.
    const inspect = run('docker', ['image', 'inspect', IMAGE])
    assert.equal(inspect.status, 0, inspect.stderr)
    assert.equal(inspect.stdout.includes(key), false, 'key appeared in image inspect')

    const history = run('docker', ['history', '--no-trunc', IMAGE])
    assert.equal(history.status, 0, history.stderr)
    assert.equal(history.stdout.includes(key), false, 'key appeared in image history')

    // The runtime filesystem must not contain the secret.
    const runtime = run('docker', ['run', '--rm', IMAGE])
    assert.equal(runtime.status, 0, `runtime secret check failed: ${runtime.stderr}`)

    // The label is present and exact.
    const label = run('docker', [
      'image',
      'inspect',
      IMAGE,
      '--format',
      '{{index .Config.Labels "com.beaconhs.deployment-id"}}',
    ])
    assert.equal(label.status, 0, label.stderr)
    assert.equal(label.stdout.trim(), DEPLOYMENT_ID)
  } finally {
    run('docker', ['image', 'rm', '-f', IMAGE])
    rmSync(dir, { recursive: true, force: true })
    assert.equal(run('test', ['-e', keyFile]).status, 1, 'temporary key directory was not removed')
  }
})
