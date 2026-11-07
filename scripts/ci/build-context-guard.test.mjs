#!/usr/bin/env node
/**
 * EA-66B.1 — negative tests for the source-context guard in
 * `scripts/build-local-image-with-key-gate.sh`.
 *
 * The script must refuse an archive that contains a runtime secret or is
 * missing required build inputs, before it reaches `docker build`.
 *
 * Run: node --test scripts/ci/build-context-guard.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/build-local-image-with-key-gate.sh')

const scratchDirs = []
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ea66b1-guard-'))
  scratchDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

function makeKey(dir) {
  const keyFile = join(dir, 'key')
  writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  return keyFile
}

function makeArchive(dir, context, name = 'context.tar.zst') {
  const archivePath = join(dir, name)
  const tar = spawnSync('tar', ['--zstd', '-cf', archivePath, '-C', context, '.'], {
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.equal(tar.status, 0, tar.stderr)
  return archivePath
}

function context(dir, files) {
  const root = join(dir, 'context')
  mkdirSync(root, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content)
  }
  return root
}

function runBuild(archivePath, keyFile) {
  return spawnSync('bash', [SCRIPT, `ea66b1-guard:${process.pid}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      NEXT_SERVER_ACTIONS_KEY_FILE: keyFile,
      PREPARE_ONLY: '1',
      RELEASE_ID: 'guard-test',
      SOURCE_CONTEXT_ARCHIVE: archivePath,
    },
  })
}

test('EA66B1-GUARD-01 an archive containing .env is refused', () => {
  const dir = scratch()
  const keyFile = makeKey(dir)
  const root = context(dir, {
    Dockerfile: 'FROM scratch\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    '.dockerignore': '.env\n',
    '.env': 'SECRET=must-not-be-in-the-image\n',
  })
  const archivePath = makeArchive(dir, root)
  const result = runBuild(archivePath, keyFile)
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /contains a secret, VCS or dependency directory/)
})

test('EA66B1-GUARD-02 an archive missing Dockerfile is refused', () => {
  const dir = scratch()
  const keyFile = makeKey(dir)
  const root = context(dir, {
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    '.dockerignore': '',
  })
  const archivePath = makeArchive(dir, root)
  const result = runBuild(archivePath, keyFile)
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /missing 'Dockerfile'/)
})
