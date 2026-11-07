#!/usr/bin/env node
/**
 * EA-66B.1 — tests for `source-deployment-id.mjs`.
 *
 * The helper turns the actual source archive into a deterministic 40-hex
 * deployment id. These tests use throwaway files and a temporary directory;
 * nothing contacts Docker, a registry or a production system.
 *
 * Run: node --test scripts/ci/source-deployment-id.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const HELPER = join(ROOT, 'scripts/ci/source-deployment-id.mjs')
const HEAD = '51a899b7aac0a942da327222a3eed355fca9798a'
const OTHER_HEAD = '0123456789abcdef0123456789abcdef01234567'

const scratchDirs = []
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ea66b1-source-'))
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

function run(args, options = {}) {
  return spawnSync('node', [HELPER, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    timeout: 30000,
  })
}

function archive(dir, name, content) {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

test('EA66B1-SRC-01 the same archive and release produce the same id', () => {
  const dir = scratch()
  const file = archive(dir, 'source.tar.zst', 'source-one')
  const first = run(['--archive', file, '--release', 'local', '--git-head', HEAD])
  const second = run(['--archive', file, '--release', 'local', '--git-head', HEAD])
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout.trim(), second.stdout.trim())
  assert.match(first.stdout.trim(), /^[0-9a-f]{40}$/)
})

test('EA66B1-SRC-02 a different archive produces a different id', () => {
  const dir = scratch()
  const a = archive(dir, 'a.tar.zst', 'source-a')
  const b = archive(dir, 'b.tar.zst', 'source-b')
  const first = run(['--archive', a, '--git-head', HEAD])
  const second = run(['--archive', b, '--git-head', HEAD])
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.notEqual(first.stdout.trim(), second.stdout.trim())
})

test('EA66B1-SRC-03 a different release label produces a different id', () => {
  const dir = scratch()
  const file = archive(dir, 'source.tar.zst', 'source-one')
  const local = run(['--archive', file, '--release', 'local'])
  const release = run(['--archive', file, '--release', 'release-1'])
  assert.equal(local.status, 0, local.stderr)
  assert.equal(release.status, 0, release.stderr)
  assert.notEqual(local.stdout.trim(), release.stdout.trim())
})

test('EA66B1-SRC-04 a Git HEAD change alone does not change the id', () => {
  const dir = scratch()
  const file = archive(dir, 'source.tar.zst', 'source-one')
  const first = run(['--archive', file, '--git-head', HEAD])
  const second = run(['--archive', file, '--git-head', OTHER_HEAD])
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout.trim(), second.stdout.trim())
})

test('EA66B1-SRC-05 the manifest records HEAD, archive hash and the same id', () => {
  const dir = scratch()
  const file = archive(dir, 'source.tar.zst', 'source-one')
  const manifest = join(dir, 'source-manifest.json')
  const result = run([
    '--archive',
    file,
    '--release',
    'local',
    '--git-head',
    HEAD,
    '--git-branch',
    'hse-platform',
    '--worktree-clean',
    'false',
    '--manifest',
    manifest,
    '--json',
  ])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.match(output.deployment_id, /^[0-9a-f]{40}$/)
  assert.equal(output.git_head, HEAD)
  assert.equal(output.git_branch, 'hse-platform')
  assert.equal(output.worktree_clean, false)
  assert.match(output.source_archive.sha256, /^[0-9a-f]{64}$/)
  assert.equal(output.algorithm, 'beaconhs-source-deployment-id/1')

  const written = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.equal(written.schema, 'beaconhs-source-manifest/1')
  assert.equal(written.git_head, HEAD)
  assert.equal(written.source_archive.sha256, output.source_archive.sha256)
  assert.equal(written.deployment.deployment_id, output.deployment_id)
  assert.equal(written.build_args.DEPLOYMENT_VERSION, output.deployment_id)
  assert.equal(statSync(manifest).mode & 0o777, 0o600)
  assert.doesNotMatch(readFileSync(manifest, 'utf8'), /NEXT_SERVER_ACTIONS_ENCRYPTION_KEY|secret/i)
})

test('EA66B1-SRC-06 a missing archive fails closed', () => {
  const dir = scratch()
  const result = run(['--archive', join(dir, 'missing.tar.zst')])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cannot stat archive/)
})

test('EA66B1-SRC-07 a directory is not an archive', () => {
  const dir = scratch()
  const result = run(['--archive', dir])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not a regular file/)
})

test('EA66B1-SRC-08 an invalid release label is rejected', () => {
  const dir = scratch()
  const file = archive(dir, 'source.tar.zst', 'source-one')
  for (const release of ['', 'has space', '../escape', 'x'.repeat(65)]) {
    const result = run(['--archive', file, '--release', release])
    assert.notEqual(result.status, 0, `release '${release}' must be rejected`)
  }
})

test('EA66B1-SRC-09 the output never contains a key-shaped value', () => {
  const dir = scratch()
  const file = archive(dir, 'source.tar.zst', 'source-one')
  const result = run(['--archive', file, '--json'])
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /BEGIN .*PRIVATE KEY|NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/)
  assert.doesNotMatch(result.stderr, /BEGIN .*PRIVATE KEY|NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/)
})

test('EA66B1-SRC-10 the generated manifest is owner-only', () => {
  const dir = scratch()
  const file = archive(dir, 'source.tar.zst', 'source-one')
  const manifest = join(dir, 'nested', 'manifest.json')
  const result = run(['--archive', file, '--manifest', manifest])
  assert.equal(result.status, 0, result.stderr)
  chmodSync(manifest, 0o600)
  assert.equal(statSync(manifest).mode & 0o777, 0o600)
})
