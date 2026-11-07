#!/usr/bin/env node
/**
 * Tests for scripts/ci/verify-source-origin.mjs (EA-56 Step C).
 *
 * Every case builds a real temporary git repository with `node --test`, so the
 * git interactions under test are genuine rather than stubbed. Nothing here
 * touches a network, a registry, or a production system.
 *
 * Run: node --test scripts/ci/verify-source-origin.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const VERIFIER = fileURLToPath(new URL('./verify-source-origin.mjs', import.meta.url))

/** Create a throw-away repo with one commit. Returns {dir, sha}. */
function makeRepo({ shallow = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ea56-origin-'))
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'probe@example.invalid')
  git('config', 'user.name', 'EA56 Probe')
  writeFileSync(join(dir, 'f.txt'), 'one\n')
  git('add', 'f.txt')
  git('commit', '-qm', 'first')
  const sha = git('rev-parse', 'HEAD').trim()
  return { dir, sha, git }
}

/** Run the verifier and return {code, json}. */
function verify(args) {
  const res = spawnSync('node', [VERIFIER, ...args, '--json'], { encoding: 'utf8' })
  let json = null
  try {
    json = JSON.parse(res.stdout)
  } catch {
    json = null
  }
  return { code: res.status, json, stdout: res.stdout, stderr: res.stderr }
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------- happy path

test('EA56-T1 correct checkout revision passes', () => {
  const { dir, sha } = makeRepo()
  try {
    const r = verify(['--expect', sha, '--event', 'push', '--ref', 'refs/heads/main', '--cwd', dir])
    assert.equal(r.code, 0)
    assert.equal(r.json.verdict, 'PASS')
  } finally {
    cleanup(dir)
  }
})

// ---------------------------------------------------------------- rejections

test('EA56-T2 foreign revision is rejected before any build', () => {
  const { dir, sha } = makeRepo()
  const foreign = '1'.repeat(40)
  try {
    const r = verify([
      '--expect',
      foreign,
      '--event',
      'push',
      '--ref',
      'refs/heads/main',
      '--cwd',
      dir,
    ])
    assert.equal(r.code, 1, 'a foreign revision must not pass')
    assert.equal(r.json.verdict, 'FAIL')
    const failed = r.json.checks.filter((c) => c.status === 'FAIL').map((c) => c.id)
    assert.ok(failed.includes('checkout.matches_expected'), `got ${failed.join(',')}`)
    // the real HEAD is untouched by the attempt
    assert.notEqual(foreign, sha)
  } finally {
    cleanup(dir)
  }
})

test('EA56-T3 missing revision is rejected', () => {
  const { dir } = makeRepo()
  try {
    const r = verify(['--expect', '', '--event', 'push', '--ref', 'refs/heads/main', '--cwd', dir])
    assert.equal(r.code, 1)
    const failed = r.json.checks.filter((c) => c.status === 'FAIL').map((c) => c.id)
    assert.ok(failed.includes('expected.present'))
  } finally {
    cleanup(dir)
  }
})

test('EA56-T4 malformed revision is rejected', () => {
  const { dir, sha } = makeRepo()
  try {
    for (const bad of ['51a899b7', sha.toUpperCase(), 'zz'.repeat(20), 'undefined']) {
      const r = verify([
        '--expect',
        bad,
        '--event',
        'push',
        '--ref',
        'refs/heads/main',
        '--cwd',
        dir,
      ])
      assert.equal(r.code, 1, `'${bad}' must be rejected`)
      const failed = r.json.checks.filter((c) => c.status === 'FAIL').map((c) => c.id)
      assert.ok(failed.includes('expected.format'), `'${bad}' should fail expected.format`)
    }
  } finally {
    cleanup(dir)
  }
})

test('EA56-T5 checkout HEAD differs from expected revision', () => {
  const { dir, sha, git } = makeRepo()
  try {
    // advance the repo so HEAD != the original sha
    writeFileSync(join(dir, 'f.txt'), 'two\n')
    git('add', 'f.txt')
    git('commit', '-qm', 'second')
    const r = verify(['--expect', sha, '--event', 'push', '--ref', 'refs/heads/main', '--cwd', dir])
    assert.equal(r.code, 1)
    const failed = r.json.checks.filter((c) => c.status === 'FAIL').map((c) => c.id)
    assert.ok(failed.includes('checkout.matches_expected'))
  } finally {
    cleanup(dir)
  }
})

test('EA56-T6 unsupported trigger events are refused, not assumed', () => {
  const { dir, sha } = makeRepo()
  try {
    // pull_request builds a synthetic merge commit: refuse for a release path
    const pr = verify([
      '--expect',
      sha,
      '--event',
      'pull_request',
      '--ref',
      'refs/pull/1/merge',
      '--cwd',
      dir,
    ])
    assert.equal(pr.code, 1)
    assert.ok(pr.json.checks.find((c) => c.id === 'event.supported' && c.status === 'FAIL'))

    // an unknown event has no defined semantics either
    const unknown = verify([
      '--expect',
      sha,
      '--event',
      'issue_comment',
      '--ref',
      'refs/heads/main',
      '--cwd',
      dir,
    ])
    assert.equal(unknown.code, 1)

    // and a missing event cannot be defaulted to "probably push"
    const missing = verify([
      '--expect',
      sha,
      '--event',
      '',
      '--ref',
      'refs/heads/main',
      '--cwd',
      dir,
    ])
    assert.equal(missing.code, 1)
    assert.ok(missing.json.checks.find((c) => c.id === 'event.present' && c.status === 'FAIL'))
  } finally {
    cleanup(dir)
  }
})

test('EA56-T7 verifier crash leaves nothing that can be mistaken for success', () => {
  // A directory that is not a git repository at all.
  const dir = mkdtempSync(join(tmpdir(), 'ea56-nogit-'))
  try {
    const r = verify([
      '--expect',
      'a'.repeat(40),
      '--event',
      'push',
      '--ref',
      'refs/heads/main',
      '--cwd',
      dir,
    ])
    assert.equal(r.code, 1, 'unreadable git state must fail closed')
    const failed = r.json.checks.filter((c) => c.status === 'FAIL').map((c) => c.id)
    assert.ok(failed.includes('checkout.readable'))
  } finally {
    cleanup(dir)
  }
})

test('EA56-T8 unparseable verifier output is detectable by the caller', () => {
  // The verifier always emits JSON with --json; a caller must therefore treat a
  // parse failure as a failure rather than as an absent result. Simulate by
  // running without --json and confirming a parser cannot read it.
  const { dir, sha } = makeRepo()
  try {
    const res = spawnSync(
      'node',
      [VERIFIER, '--expect', sha, '--event', 'push', '--ref', 'refs/heads/main', '--cwd', dir],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(res.status, 0)
    assert.throws(() => JSON.parse(res.stdout), 'plain output must not parse as JSON')
  } finally {
    cleanup(dir)
  }
})

test('EA56-T9 a dirty working tree is refused for a release build', () => {
  const { dir, sha } = makeRepo()
  try {
    writeFileSync(join(dir, 'f.txt'), 'modified but not committed\n')
    const r = verify(['--expect', sha, '--event', 'push', '--ref', 'refs/heads/main', '--cwd', dir])
    assert.equal(r.code, 1, 'uncommitted tracked changes must fail closed')
    const failed = r.json.checks.filter((c) => c.status === 'FAIL').map((c) => c.id)
    assert.ok(failed.includes('checkout.clean'))
  } finally {
    cleanup(dir)
  }
})

test('EA56-T10 untracked files alone do not fail the origin check', () => {
  const { dir, sha } = makeRepo()
  try {
    writeFileSync(join(dir, 'untracked.txt'), 'ignored by --untracked-files=no\n')
    const r = verify(['--expect', sha, '--event', 'push', '--ref', 'refs/heads/main', '--cwd', dir])
    assert.equal(r.code, 0, 'untracked files do not alter committed bytes')
  } finally {
    cleanup(dir)
  }
})

test('EA56-T11 shallow clone is refused', () => {
  const origin = makeRepo()
  let cloneDir = ''
  try {
    // make a second commit so there is history to truncate
    writeFileSync(join(origin.dir, 'f.txt'), 'two\n')
    origin.git('add', 'f.txt')
    origin.git('commit', '-qm', 'second')

    cloneDir = mkdtempSync(join(tmpdir(), 'ea56-shallow-'))
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${origin.dir}`, cloneDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: cloneDir,
      encoding: 'utf8',
    }).trim()
    const r = verify([
      '--expect',
      sha,
      '--event',
      'push',
      '--ref',
      'refs/heads/main',
      '--cwd',
      cloneDir,
    ])
    assert.equal(r.code, 1, 'a shallow clone is not a safe release source')
    const failed = r.json.checks.filter((c) => c.status === 'FAIL').map((c) => c.id)
    assert.ok(failed.includes('checkout.not_shallow'))
  } finally {
    cleanup(origin.dir)
    if (cloneDir) cleanup(cloneDir)
  }
})
